//// The decision rules' calls that Gleam's types can't hold (scripts/rules/recruitment/decisions.mjs and
//// decisionsPersistence.mjs), the views over complete rows, and the two rules that read the store.
////
//// The TypeScript rules judge values no request or stored row here can carry, so none reaches a rule:
////
//// - a null or absent outcome is none at the route's shape, before validateOutcome (validateContent does the same);
////   absent reasons are none, as validateDecisionReasons reads them;
//// - a reference with a field beyond kind and id is refused by the route's shape on both servers (strictObject);
////   validateEvidenceRefShapes, which drops the field, never sees it;
//// - a decision row's outcome, rev and creation time are typed columns of a STRICT table: decisionIntegrity's
////   "accept", "__proto__", rev 0 and 1.5 and createdAt "yesterday" can't be stored. Its reasons and references are
////   child rows, so neither can be other than a list, and its id is the primary key;
//// - every caller judges a row against its own case and organisation; a legacy recommendation isn't judged at all;
//// - the views print every stored column, so their fixtures (a lifecycle naming only `applied`, references without
////   their metadata, a draft with no times) are replaced by complete rows, with the TypeScript views' answers for
////   them;
//// - decisionRequirements is passed the route's counts, never another call's answer (U40).
////
//// resolveEvidenceRefs and summariseAssessments read the store here, so their calls run against seeded rows (the
//// suite's fixture, with the two values the schema can't hold made ones it can: Passport provenance "verified" is
//// "club_assessed", and the Box Cam providers are the real and test-only ones).

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/store
import scoutbox/recruitment/decisions
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules
import scoutbox/rows/case_decision_drafts as draft_row
import scoutbox/rows/id
import scoutbox/rows/room_decisions as decision_row
import scoutbox/support
import scoutbox/vocab/decision_evidence_kind
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/room_status
import sqlight

// ------------------------------------------------------------------------------------------ at the route's shape

pub fn a_null_or_absent_outcome_is_none_without_the_rule_test() {
  assert base.decision_outcome(Some("null")) == Ok(None)
  assert base.decision_outcome(None) == Ok(None)
}

pub fn absent_reasons_are_none_test() {
  assert base.decision_reasons(None, None) == Ok([])
}

pub fn a_reference_with_another_field_is_refused_by_the_shape_test() {
  assert base.decision_refs(Some(
      "[{\"kind\":\"assessment\",\"id\":\"a\",\"extra\":\"dropped\"},{\"kind\":\"assessment\",\"id\":\"a\"}]",
    ))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
  assert base.decision_refs(Some(
      "[{\"kind\":\"assessment\",\"id\":\"a\"},{\"kind\":\"assessment\",\"id\":\"a\"}]",
    ))
    == Ok([decisions.RefShape(decision_evidence_kind.Assessment, "a")])
}

// ------------------------------------------------------------------------------------------------- integrity

pub fn the_schema_refuses_what_no_stored_decision_can_be_test() {
  let s = seeded()
  let write = fn(id, outcome, rev, created_at) {
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO room_decisions (id, room_id, org_id, player_id, kind, state, outcome, recommendation, by_name, created_at, rev)
         VALUES (?, 'case-1', 'org-A', 'pl-1', 'formal', 'final', ?, 'offer', 'Lead', ?, ?)",
        [id, outcome, created_at, rev],
      )
    })
  }
  let text = sqlight.text
  let good = text("progress")
  // The same row with good values is written, so each refusal below is the bad value's.
  assert write(text("rdec-ok"), good, sqlight.int(1), sqlight.int(2)) == Ok(Nil)
  list.each(["accept", "__proto__"], fn(o) {
    assert write(text("rdec-x"), text(o), sqlight.int(1), sqlight.int(2))
      |> result.is_error
  })
  assert write(text("rdec-x"), good, sqlight.int(0), sqlight.int(2))
    |> result.is_error
  assert write(text("rdec-x"), good, sqlight.float(1.5), sqlight.int(2))
    |> result.is_error
  assert write(text("rdec-x"), good, sqlight.int(1), text("yesterday"))
    |> result.is_error
  assert write(sqlight.null(), good, sqlight.int(1), sqlight.int(2))
    |> result.is_error
}

pub fn a_legacy_recommendation_is_not_judged_test() {
  let legacy =
    decisions.Decision(
      ..base.decision(),
      base: room_records.Decision(
        ..base.decision().base,
        row: decision_row.Row(
          ..base.decision().base.row,
          id: id.room_decision("d-1"),
          room_id: id.recruitment_case("c"),
          org_id: id.org("o"),
          recommendation: decision_row.Shortlist,
          note: Some("n"),
          by_user_id: Some(id.org_user("u")),
          by_name: Some("U"),
          created_at: 1,
          superseded_by_id: Some(id.room_decision("d-2")),
        ),
        reason_codes: ["tactical_fit"],
      ),
    )
  assert decisions.integrity(legacy, id.org("o"), id.recruitment_case("c"))
    == []
  assert decisions.integrity(
      legacy,
      id.org("elsewhere"),
      id.recruitment_case("elsewhere"),
    )
    == []
}

// ------------------------------------------------------------------------------------------------------ views

fn formal() -> decisions.Decision {
  decisions.Decision(
    base: room_records.Decision(
      row: decision_row.Row(
        ..base.decision().base.row,
        id: id.room_decision("rdec-f1"),
        room_id: id.recruitment_case("case-1"),
        org_id: id.org("org-A"),
        player_id: id.player("pl-1"),
        kind: Some(decision_row.Formal),
        state: Some(decision_row.Final),
        outcome: Some(decision_outcome.Progress),
        recommendation: decision_row.Offer,
        note: Some("Private note."),
        by_user_id: Some(id.org_user("usr-1")),
        by_name: Some("Lead"),
        by_role: Some("Head of Recruitment"),
        created_at: 2,
        finalized_at: Some(3),
        trigger: Some("decision:finalize"),
        supersedes_id: Some(id.room_decision("rdec-l1")),
        supersession_of_id: Some(id.room_decision("rdec-l1")),
        supersession_reason: Some("Budget review."),
        rev: Some(2),
        assessments_submitted: Some(1),
        assessments_withheld: Some(0),
        assessment_verdicts_json: Some(
          "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
        ),
        lifecycle_action: Some("considerOffer"),
        lifecycle_from: Some(room_status.Shortlisted),
        lifecycle_to: Some(room_status.OfferConsideration),
        lifecycle_applied: Some(True),
        lifecycle_reason: None,
        lifecycle_at: Some(3),
        policy_version: Some(1),
      ),
      reason_codes: ["tactical_fit"],
      snapshot: None,
    ),
    refs: [
      decisions.Ref(
        decision_evidence_kind.Assessment,
        "a",
        json.object([
          #("scoutName", json.string("S")),
          #("submittedAt", json.int(1)),
          #("verdict", json.string("sign")),
          #("trialId", json.null()),
        ]),
      ),
    ],
    assessment_ids: ["a"],
  )
}

/// decisionView of the same formal row, as the TypeScript server stores and reads it (`note` is spliced in).
fn formal_view(note: String) -> String {
  "{\"id\":\"rdec-f1\",\"kind\":\"formal\",\"state\":\"final\",\"outcome\":\"progress\",\"outcomeLabel\":\"Progress to offer consideration\",\"recommendation\":\"offer\",\"reasonCodes\":[\"tactical_fit\"],"
  <> note
  <> "\"hasNote\":true,\"by\":{\"userId\":\"usr-1\",\"name\":\"Lead\",\"role\":\"Head of Recruitment\"},\"createdAt\":2,\"finalizedAt\":3,\"rev\":2,\"supersedes\":\"rdec-l1\",\"supersededById\":null,\"supersession\":{\"reason\":\"Budget review.\",\"of\":\"rdec-l1\"},\"evidenceRefs\":[{\"kind\":\"assessment\",\"id\":\"a\",\"meta\":{\"scoutName\":\"S\",\"submittedAt\":1,\"verdict\":\"sign\",\"trialId\":null}}],\"evidenceCount\":1,\"assessmentSummary\":{\"submitted\":1,\"withheld\":0,\"verdicts\":{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0},\"assessmentIds\":[\"a\"]},\"lifecycle\":{\"action\":\"considerOffer\",\"from\":\"shortlisted\",\"to\":\"offer_consideration\",\"applied\":true,\"reason\":null,\"at\":3},\"trigger\":\"decision:finalize\",\"snapshot\":null,\"policyVersion\":1}"
}

pub fn a_formal_row_reads_with_its_outcome_label_evidence_and_policy_test() {
  assert json.to_string(decisions.view(formal(), False))
    == formal_view("\"note\":\"Private note.\",")
}

pub fn the_note_can_be_omitted_and_has_note_stays_honest_test() {
  assert json.to_string(decisions.view(formal(), True)) == formal_view("")
}

pub fn a_draft_is_labelled_as_not_a_decision_test() {
  let row =
    draft_row.Row(
      ..draft_row.new(
        case_id: id.recruitment_case("case-1"),
        id: id.decision_draft("rdraft-1"),
        created_at: 5,
        updated_at: 7,
        rev: 3,
      ),
      outcome: Some(decision_outcome.Hold),
      note: Some("Draft note."),
      by_user_id: Some(id.org_user("usr-1")),
      by_name: Some("Lead"),
      updated_by_user_id: Some(id.org_user("usr-2")),
      updated_by_name: Some("Other"),
    )
  let draft =
    decisions.Draft(row, ["timing"], [
      decisions.Ref(
        decision_evidence_kind.Trial,
        "t",
        json.object([
          #("workflowState", json.string("completed")),
          #("completedAt", json.int(9)),
        ]),
      ),
    ])
  assert json.to_string(decisions.draft_view(Some(draft)))
    == "{\"id\":\"rdraft-1\",\"state\":\"draft\",\"outcome\":\"hold\",\"outcomeLabel\":\"Hold\",\"reasonCodes\":[\"timing\"],\"note\":\"Draft note.\",\"evidenceRefs\":[{\"kind\":\"trial\",\"id\":\"t\",\"meta\":{\"workflowState\":\"completed\",\"completedAt\":9}}],\"by\":{\"userId\":\"usr-1\",\"name\":\"Lead\"},\"createdAt\":5,\"updatedAt\":7,\"updatedBy\":{\"userId\":\"usr-2\",\"name\":\"Other\"},\"rev\":3,\"label\":\"Draft — not a formal decision\"}"
}

pub fn a_removed_subject_bars_drafting_for_everyone_test() {
  assert json.to_string(
      decisions.requirements_json(
        role: Some(room_rules.RoomLead),
        can_finalize: True,
        status: room_status.Shortlisted,
        submitted_assessments: 2,
        completed_trials: 1,
        blocked: False,
        subject_removed: True,
        has_draft: False,
        has_final: False,
        outcomes: [],
      ),
    )
    == "{\"canDraft\":false,\"canFinalize\":false,\"role\":\"room_lead\",\"blocked\":false,\"subjectRemoved\":true,\"hasDraft\":false,\"hasFinal\":false,\"inputs\":{\"submittedAssessments\":2,\"completedTrials\":1,\"note\":\"Inputs are counts of what exists. None of them is required by policy, and none of them decides anything.\"},\"outcomes\":[],\"status\":\"shortlisted\",\"note\":\"A formal decision is an explicit human act by a room lead or recruitment lead. ScoutBox never takes it.\"}"
}

// ---------------------------------------------------------------------------------------- resolving references

/// The suite's records, as rows: two clubs, a case of player pl-1 at club A with a completed trial citing two Box
/// Cam sessions (one link withdrawn), another case's trial, another player's trial, and the assessments, sessions
/// and Passport records the references name.
fn seeded() -> store.Store {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      list.try_each(seed_sql, fn(sql) { store.run(tx, sql, []) })
    })
  s
}

const seed_sql = [
  "INSERT INTO orgs (id, name, type, plan, created_at) VALUES ('org-A', 'Club A', 'club', 'Pro', 1), ('org-B', 'Club B', 'club', 'Pro', 1)",
  "INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('usr-a', 'org-A', 'Lead', 'lead', 'Scout', 1), ('usr-b', 'org-B', 'Other', 'other', 'Scout', 1), ('x', 'org-A', 'x', 'x', 'Scout', 1), ('y', 'org-A', 'y', 'y', 'Scout', 1)",
  "INSERT INTO recruitment_cases (id, org_id, player_id, owner_user_id, stage, priority, restricted, created_at) VALUES ('case-1', 'org-A', 'pl-1', 'usr-a', 'identified', 'medium', 0, 1), ('case-2', 'org-A', 'pl-1', 'usr-a', 'identified', 'medium', 0, 1), ('case-3', 'org-A', 'pl-2', 'usr-a', 'identified', 'medium', 0, 1)",
  "INSERT INTO recruitment_requests (id, player_id, org_id, org_name, org_verified, org_safeguarding_certified, user_id, type, trial_alt_days_json, status, created_at, routed_to) VALUES ('rq-1', 'pl-1', 'org-A', 'Club A', 0, 0, 'usr-a', 'trial', '[]', 'accepted', 1, 'player'), ('rq-2', 'pl-1', 'org-A', 'Club A', 0, 0, 'usr-a', 'trial', '[]', 'accepted', 1, 'player'), ('rq-3', 'pl-2', 'org-A', 'Club A', 0, 0, 'usr-a', 'trial', '[]', 'accepted', 1, 'player')",
  "INSERT INTO trials (id, request_id, case_id, player_id, org_id, org_name, accepted_at, status, reminder_sent, workflow_state, rev, completion_state, completion_at, schedule_timezone, schedule_revision) VALUES ('t-ok', 'rq-1', 'case-1', 'pl-1', 'org-A', 'Club A', 1, 'awaiting_report', 0, 'completed', 0, 'completed', 9, 'Europe/London', 1)",
  "INSERT INTO trials (id, request_id, case_id, player_id, org_id, org_name, accepted_at, status, reminder_sent, workflow_state, rev, schedule_timezone, schedule_revision) VALUES ('t-other-case', 'rq-2', 'case-2', 'pl-1', 'org-A', 'Club A', 1, 'awaiting_report', 0, 'accepted', 0, NULL, NULL), ('t-other-player', 'rq-3', 'case-3', 'pl-2', 'org-A', 'Club A', 1, 'awaiting_report', 0, 'scheduled', 0, 'Europe/London', 1)",
  "INSERT INTO trial_schedule_sessions (trial_id, position, id, kind, starts_at, ends_at) VALUES ('t-ok', 0, 's1', 'training', 100, 200), ('t-other-player', 0, 's9', 'training', 100, 200)",
  "INSERT INTO trial_session_evidence (trial_id, session_id, position, id, kind, box_session_id, linked_at, removed_at) VALUES ('t-ok', 's1', 0, 'tse-1', 'box_cam_session', 'bx-1', 1, NULL), ('t-ok', 's1', 1, 'tse-2', 'box_cam_session', 'bx-gone', 1, 3), ('t-other-player', 's9', 0, 'tse-3', 'box_cam_session', 'bx-9', 1, NULL)",
  "INSERT INTO box_sessions (id, player_id, drill_id, drill_version, target_type, target_value, nonce_hash, liveness_challenge, provider_id, provider_version, status, created_at, expires_at, last_seq, batches, verification_state) VALUES ('bx-1', 'pl-1', 'd', 1, 'repetitions', 10.0, printf('%064d', 1), 'show_ball', 'production_cv', 1, 'verified', 1, 2, 0, 0, 'verified'), ('bx-gone', 'pl-1', 'd', 1, 'repetitions', 10.0, printf('%064d', 2), 'show_ball', 'production_cv', 1, 'verified', 1, 2, 0, 0, 'verified'), ('bx-9', 'pl-2', 'd', 1, 'repetitions', 10.0, printf('%064d', 3), 'show_ball', 'production_cv', 1, 'recording', 1, 2, 0, 0, NULL), ('bx-sim', 'pl-1', 'd', 1, 'repetitions', 10.0, printf('%064d', 4), 'show_ball', 'local_test', 1, 'recording', 1, 2, 0, 0, NULL)",
  "INSERT INTO evidence (id, player_id, claim_type, label, source_kind, source_id, source_name, recorded_at, verification_status) VALUES ('ev-ok', 'pl-1', 'footage', 'Clip', 'player', 'pl-1', 'P', 1, 'club_assessed'), ('ev-other', 'pl-2', 'footage', 'Clip', 'player', 'pl-2', 'P', 1, 'self_reported')",
  "INSERT INTO evidence (id, player_id, claim_type, label, source_kind, source_id, source_name, recorded_at, verification_status, superseded_by_id) VALUES ('ev-old', 'pl-1', 'footage', 'Clip', 'player', 'pl-1', 'P', 1, 'self_reported', 'ev-ok')",
  "INSERT INTO assessments (id, org_id, player_id, scout_user_id, scout_name, template_id, template_version, state, created_at, submitted_at, recommendation_verdict, recommendation_reasons)
   SELECT v.column1, v.column2, v.column3, v.column4, v.column5, t.id, t.version, v.column6, 1, v.column7, v.column8, v.column9
   FROM (VALUES ('a-ok', 'org-A', 'pl-1', 'usr-a', 'S', 'submitted', 5, 'sign', 'PRIVATE'), ('a-draft', 'org-A', 'pl-1', 'usr-a', 'S', 'draft', NULL, NULL, NULL), ('a-other-org', 'org-B', 'pl-1', 'usr-b', 'S', 'submitted', 1, NULL, NULL), ('a-other-player', 'org-A', 'pl-2', 'usr-a', 'S', 'submitted', 1, NULL, NULL)) v,
   (SELECT id, version FROM assessment_templates ORDER BY id, version LIMIT 1) t",
  "INSERT INTO assessment_ratings (assessment_id, position, attr_id, rating, not_observed, confidence, note) VALUES ('a-ok', 0, 'x', 5, 0, 'high', 'PRIVATE_RATING_NOTE')",
]

fn resolve(s: store.Store, kind, ref_id: String) {
  let assert Ok(r) =
    store.read(s, fn(read) {
      decisions.resolve_refs(
        read,
        [decisions.RefShape(kind, ref_id)],
        id.org("org-A"),
        id.player("pl-1"),
        id.recruitment_case("case-1"),
        False,
      )
    })
  r
  |> result.map(fn(refs) { json.to_string(decisions.refs_json(refs)) })
  |> result.map_error(fn(r) {
    let assert base.ByRule(body) = base.decision_refusal(r)
    body
  })
}

pub fn this_cases_own_records_resolve_with_state_level_metadata_test() {
  let s = seeded()
  let assert Ok(r) =
    store.read(s, fn(read) {
      decisions.resolve_refs(
        read,
        [
          decisions.RefShape(decision_evidence_kind.Assessment, "a-ok"),
          decisions.RefShape(decision_evidence_kind.Trial, "t-ok"),
          decisions.RefShape(decision_evidence_kind.BoxCamSession, "bx-1"),
          decisions.RefShape(decision_evidence_kind.PassportEvidence, "ev-ok"),
        ],
        id.org("org-A"),
        id.player("pl-1"),
        id.recruitment_case("case-1"),
        False,
      )
    })
  let assert Ok(refs) = r
  // U24: ids and states only, never a rating, a note or a Box Cam result.
  assert json.to_string(decisions.refs_json(refs))
    == "[{\"kind\":\"assessment\",\"id\":\"a-ok\",\"meta\":{\"scoutName\":\"S\",\"submittedAt\":5,\"verdict\":\"sign\",\"trialId\":null}},{\"kind\":\"trial\",\"id\":\"t-ok\",\"meta\":{\"workflowState\":\"completed\",\"completedAt\":9}},{\"kind\":\"box_cam_session\",\"id\":\"bx-1\",\"meta\":{\"trialId\":\"t-ok\",\"trialSessionId\":\"s1\",\"verificationState\":\"verified\",\"simulated\":false}},{\"kind\":\"passport_evidence\",\"id\":\"ev-ok\",\"meta\":{\"claimType\":\"footage\",\"provenance\":\"club_assessed\"}}]"
}

pub fn records_outside_the_case_cannot_be_cited_test() {
  let s = seeded()
  let mismatch = fn(kind, ref_id, message) {
    "{\"error\":\"DECISION_CASE_MISMATCH\",\"message\":\""
    <> message
    <> "\",\"ref\":{\"kind\":\""
    <> decision_evidence_kind.to_string(kind)
    <> "\",\"id\":\""
    <> ref_id
    <> "\"}}"
  }
  let assessment = decision_evidence_kind.Assessment
  let trial = decision_evidence_kind.Trial
  let box = decision_evidence_kind.BoxCamSession
  let passport = decision_evidence_kind.PassportEvidence
  let not_the_cases = "That assessment is not one of this case's."
  // Another organisation's, another player's, and one that doesn't exist: the same body.
  list.each(["a-other-org", "a-other-player", "a-missing"], fn(a) {
    assert resolve(s, assessment, a)
      == Error(mismatch(assessment, a, not_the_cases))
  })
  assert resolve(s, assessment, "a-draft")
    == Error(
      "{\"error\":\"DECISION_EVIDENCE_INVALID\",\"message\":\"Only a submitted assessment can be cited by a decision.\",\"ref\":{\"kind\":\"assessment\",\"id\":\"a-draft\"}}",
    )
  list.each(["t-other-case", "t-other-player"], fn(t) {
    assert resolve(s, trial, t)
      == Error(mismatch(trial, t, "That trial is not one of this case's."))
  })
  // A withdrawn link, a session linked on another player's trial, a test-only session linked nowhere.
  list.each(["bx-gone", "bx-9", "bx-sim"], fn(b) {
    assert resolve(s, box, b)
      == Error(mismatch(
        box,
        b,
        "That Box Cam session is not cited on any trial of this case.",
      ))
  })
  list.each(["ev-old", "ev-other"], fn(e) {
    assert resolve(s, passport, e)
      == Error(mismatch(
        passport,
        e,
        "That evidence record is not one of this player's current records.",
      ))
  })
}

// --------------------------------------------------------------------------------------- summarising assessments

/// Scouts x and y's assessments of pl-1 at club A, each with the suite's four ratings (one not observed, one with
/// two evidence references), and z's draft when `draft`.
fn assess(s: store.Store, scouts: List(#(String, String)), draft: Bool) {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM assessments WHERE org_id = 'org-A' AND player_id = 'pl-s'",
          [],
        ),
      )
      use _ <- result.try(
        list.try_each(scouts, fn(sc) {
          let #(scout, verdict) = sc
          use _ <- result.try(
            store.run(
              tx,
              "INSERT INTO assessments (id, org_id, player_id, scout_user_id, scout_name, template_id, template_version, state, created_at, submitted_at, recommendation_verdict, recommendation_reasons)
             SELECT ?, 'org-A', 'pl-s', ?, ?, id, version, 'submitted', 1, 1, ?, 'PRIVATE_WHY' FROM assessment_templates ORDER BY id, version LIMIT 1",
              [
                sqlight.text(scout),
                sqlight.text(scout),
                sqlight.text(scout),
                sqlight.text(verdict),
              ],
            ),
          )
          use _ <- result.try(
            store.run(
              tx,
              "INSERT INTO assessment_ratings (assessment_id, position, attr_id, rating, not_observed, confidence) VALUES (?1, 0, 'a', 5, 0, 'high'), (?1, 1, 'b', 2, 0, 'low'), (?1, 2, 'c', NULL, 1, 'low'), (?1, 3, 'd', 4, 0, 'medium')",
              [sqlight.text(scout)],
            ),
          )
          store.run(
            tx,
            "INSERT INTO assessment_rating_refs (assessment_id, rating_position, position, label) VALUES (?1, 3, 0, 'e1'), (?1, 3, 1, 'e2')",
            [sqlight.text(scout)],
          )
        }),
      )
      case draft {
        False -> Ok(Nil)
        True ->
          store.run(
            tx,
            "INSERT INTO assessments (id, org_id, player_id, scout_user_id, scout_name, template_id, template_version, state, created_at)
             SELECT 'z', 'org-A', 'pl-s', 'usr-a', 'z', id, version, 'draft', 1 FROM assessment_templates ORDER BY id, version LIMIT 1",
            [],
          )
      }
    })
  let assert Ok(counted) =
    store.read(s, fn(read) {
      decisions.assessments_for(read, id.org("org-A"), id.player("pl-s"))
    })
  counted
}

fn summary(s: store.Store, scouts, draft: Bool, withheld: Int) -> String {
  decisions.summarise(assess(s, scouts, draft), withheld)
  |> decisions.summary_json
  |> json.to_string
}

const per_x =
  "{\"id\":\"x\",\"scoutName\":\"x\",\"scoutUserId\":\"x\",\"state\":\"submitted\",\"submittedAt\":1,\"verdict\":\"sign\",\"trialId\":null,\"trialSessionId\":null,\"rated\":3,\"notObserved\":1,\"confidence\":{\"low\":1,\"medium\":1,\"high\":1},\"evidenceRefs\":2,\"published\":false}"

const note =
  "\"note\":\"Independent assessments, summarised as counts. ScoutBox does not average them and does not decide.\"}"

pub fn assessments_summarise_as_counts_and_name_disagreement_test() {
  let s = seeded()
  assert summary(s, [#("x", "sign"), #("y", "pass")], True, 1)
    == "{\"submitted\":2,\"drafts\":1,\"withheld\":1,\"verdicts\":{\"sign\":1,\"monitor\":0,\"pass\":1,\"none\":0},\"disagreement\":{\"kind\":\"verdicts_differ\",\"verdicts\":[\"sign\",\"pass\"]},\"assessments\":["
    <> per_x
    <> ",{\"id\":\"y\",\"scoutName\":\"y\",\"scoutUserId\":\"y\",\"state\":\"submitted\",\"submittedAt\":1,\"verdict\":\"pass\",\"trialId\":null,\"trialSessionId\":null,\"rated\":3,\"notObserved\":1,\"confidence\":{\"low\":1,\"medium\":1,\"high\":1},\"evidenceRefs\":2,\"published\":false}],"
    <> note
}

pub fn unanimity_is_named_only_with_more_than_one_assessor_test() {
  let s = seeded()
  assert summary(s, [#("x", "sign"), #("y", "sign")], False, 0)
    == "{\"submitted\":2,\"drafts\":0,\"withheld\":0,\"verdicts\":{\"sign\":2,\"monitor\":0,\"pass\":0,\"none\":0},\"disagreement\":{\"kind\":\"unanimous\",\"verdicts\":[\"sign\"]},\"assessments\":["
    <> per_x
    <> ",{\"id\":\"y\",\"scoutName\":\"y\",\"scoutUserId\":\"y\",\"state\":\"submitted\",\"submittedAt\":1,\"verdict\":\"sign\",\"trialId\":null,\"trialSessionId\":null,\"rated\":3,\"notObserved\":1,\"confidence\":{\"low\":1,\"medium\":1,\"high\":1},\"evidenceRefs\":2,\"published\":false}],"
    <> note
  assert summary(s, [#("x", "sign")], False, 0)
    == "{\"submitted\":1,\"drafts\":0,\"withheld\":0,\"verdicts\":{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0},\"disagreement\":null,\"assessments\":["
    <> per_x
    <> "],"
    <> note
  assert summary(s, [], False, 0)
    == "{\"submitted\":0,\"drafts\":0,\"withheld\":0,\"verdicts\":{\"sign\":0,\"monitor\":0,\"pass\":0,\"none\":0},\"disagreement\":null,\"assessments\":[],"
    <> note
}
