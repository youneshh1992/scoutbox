//// The journey model's calls that the recorder can't turn into generated cases, ported by hand from the TypeScript
//// rules suites of recruitment/journey and journeyAdversarial (scripts/rules/). Each passes a value no stored row
//// can hold, and the TypeScript rule answers it itself:
////
//// - a status that isn't one ("nonsense", "SIGNED", "", "constructor"): a Room's status is a typed column, and text
////   that isn't a status doesn't decode as one. The stage, the next action (STATE_UNKNOWN) and the check
////   (LIFECYCLE_STATE_UNKNOWN) are never asked about one;
//// - a package status that isn't one ("BOGUS"): the column's vocabulary refuses it;
//// - a history instant that isn't a number ("yesterday"): the column is an INTEGER. What can be stored and is still
////   malformed, an instant at or before 0, is the same problem (TEMPORAL_ORDER);
//// - a package with no current revision: the column is NOT NULL. A completed package with one is the same case;
//// - an assessment's update time: the row has none, so a draft is as new as its creation.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/recruitment/journey_model.{JourneyFacts}
import scoutbox/recruitment/signing_rules
import scoutbox/rows/assessments
import scoutbox/rows/id
import scoutbox/rows/signing_packages
import scoutbox/vocab/room_status

const now = 1_794_744_000_000

fn facts(status, history) -> journey_model.JourneyFacts {
  JourneyFacts(
    status:,
    created_at: 10,
    history:,
    links_signing_id: None,
    contacts: [],
    trials: [],
    trial_requests: [],
    assessments: [],
    decisions: [],
    offers: [],
    packages: [],
    signing_row: None,
    signing_row_ids: [],
    corrupt: 0,
    foreign: [],
    domain_problems: [],
    now:,
  )
}

/// room_created at 10, then under review at 20 and contacted at 30.
fn contacted_history() {
  [
    base.history_entry(0, "room_created", 10, Some("{\"status\":\"watching\"}")),
    base.history_entry(
      1,
      "room_status_changed",
      20,
      Some("{\"from\":\"watching\",\"to\":\"under_review\"}"),
    ),
    base.history_entry(
      2,
      "room_status_changed",
      30,
      Some("{\"from\":\"under_review\",\"to\":\"contacted\"}"),
    ),
  ]
}

// canonicalStageFor("SIGNED" / "" / "constructor"), nextActionFor({status: "nonsense"}) and
// validateRecruitmentJourney({status: "SIGNED"}): no such status
pub fn text_that_is_not_a_status_is_no_status_test() {
  list.each(["SIGNED", "", "constructor", "nonsense"], fn(text) {
    assert room_status.from_string(text) == Error(Nil)
  })
  // The envelope the TypeScript rule answers for one; the finish matrix holds it for every role and block.
  assert journey_model.finish("STATE_UNKNOWN", [], None, False, False, False)
    |> json.to_string
    == "{\"code\":\"STATE_UNKNOWN\",\"stage\":null,\"kind\":\"none\",\"tab\":\"overview\",\"lifecycleAction\":null,\"permitted\":null,\"blockedBy\":[],\"resources\":{}}"
}

// validateRecruitmentJourney: a status change at "yesterday" is TEMPORAL_ORDER
pub fn an_instant_at_or_before_zero_is_malformed_test() {
  list.each([0, -1], fn(at) {
    let v =
      journey_model.validate(
        facts(room_status.Contacted, [
          base.history_entry(
            0,
            "room_status_changed",
            at,
            Some("{\"to\":\"contacted\"}"),
          ),
        ]),
      )
    assert journey_model.verdict_json(v) |> json.to_string
      == "{\"ok\":false,\"classification\":\"integrity_error\",\"problems\":[\"TEMPORAL_ORDER\"],\"backed\":0,\"unbacked\":1}"
  })
}

// validateRecruitmentJourney: a completed package behind a case still at offer_accepted
pub fn a_completed_package_ahead_of_the_case_is_named_test() {
  let package =
    signing_rules.Package(
      ..base.signing_package(),
      row: signing_packages.Row(
        ..base.signing_package().row,
        id: id.signing_package("spk"),
        status: signing_packages.Completed,
        created_at: 1,
        completion_signing_id: Some(id.signing("s")),
      ),
    )
  let v =
    journey_model.validate(
      JourneyFacts(
        ..facts(room_status.OfferAccepted, contacted_history()),
        packages: [package],
      ),
    )
  assert journey_model.verdict_json(v) |> json.to_string
    == "{\"ok\":false,\"classification\":\"integrity_error\",\"problems\":[\"LIFECYCLE_BEHIND_TERMINAL_EVIDENCE\"],\"backed\":0,\"unbacked\":2}"
}

// currentSigningForOffer: a package at "BOGUS" can't be stored; with only an expired one, that one is current
pub fn an_unknown_package_status_is_no_package_test() {
  assert list.key_find(signing_packages.status_pairs, "BOGUS") == Error(Nil)
  let expired =
    signing_rules.Package(
      ..base.signing_package(),
      row: signing_packages.Row(
        ..base.signing_package().row,
        id: id.signing_package("spk-y"),
        status: signing_packages.Ready,
        expires_at: Some(now - 1),
      ),
    )
  assert journey_model.current_signing([expired], now)
    |> option.map(fn(p) { p.row.id })
    == Some(id.signing_package("spk-y"))
}

// currentAssessmentForCase: a submitted assessment is current over a draft, however recent the draft
pub fn a_submitted_assessment_outranks_a_draft_test() {
  let draft =
    assessments.Row(..base.assessment(), id: id.assessment("a1"), created_at: 9)
  let submitted =
    assessments.Row(
      ..base.assessment(),
      id: id.assessment("a2"),
      state: assessments.Submitted,
      created_at: 1,
      submitted_at: Some(2),
    )
  assert journey_model.current_assessment([draft, submitted])
    |> option.map(fn(a) { a.id })
    == Some(id.assessment("a2"))
}
