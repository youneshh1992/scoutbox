//// Which records count as evidence for a lifecycle status (`case_lifecycle.evidence`), hand-ported from the
//// createEvidenceProvider calls of the TypeScript rules suites, and the canTransitionRecruitmentCase calls that pass
//// that provider: contacts V, contactsPersistence, trials P10–P13d, decisions P15–P20, offers A82–A85,
//// offersAdversarial R-p11, lifecycle H1, H5, H6 and the inbound-to-signed sweep, journey A37–A38.
////
//// The TypeScript provider runs over plain records; here it is SQL over the store, so each call runs against rows
//// written for it. Where the suite changes one field of a record between calls, the test does the same with an
//// UPDATE, so each refusal is that field's.
////
//// Not ported, because nothing here can hold them:
////
//// - A missing store (P10b, H6e, contacts' "missing store"): the provider reads the one store, so there is no
////   query object to be absent.
//// - An unknown evidence kind: `room_rules.Evidence` is a closed type.
//// - A cancelled signing (H6c): a `signings` row has no cancellation. A signing that stops counting is a package
////   that never completed, which A38's rows cover.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/platform/store.{type Store}
import scoutbox/recruitment/case_lifecycle.{
  type Evidence, Allowed, Holds, Lacks, Refusal,
}
import scoutbox/recruitment/case_records.{
  type Cols, contact, delivered, exec, insert, n, q, room_at, store_with,
}
import scoutbox/recruitment/cases
import scoutbox/recruitment/room_rules.{RecruitmentAdmin, RoomLead}
import scoutbox/rows/id
import scoutbox/vocab/room_status

const hour = 3_600_000

const day = 86_400_000

/// offersAdversarial's T.
const t = 1_800_000_000_000

// -------------------------------------------------------------------------------------------------- fixtures

fn evidence(
  s: Store,
  case_id: String,
  kind: room_rules.Evidence,
  now: Int,
) -> Evidence {
  let assert Ok(found) =
    store.read(s, fn(r) {
      let assert Ok(Some(room)) = cases.room(r, id.recruitment_case(case_id))
      case_lifecycle.evidence(r, room, kind, now)
    })
  found
}

/// The validator's verdict on `action` for this case, asking the real provider unless given another.
fn verdict(
  s: Store,
  case_id: String,
  action: String,
  role: room_rules.RoomRole,
  now: Int,
  provider: Option(case_lifecycle.Provider(Nil)),
) {
  let assert Some(a) = case_lifecycle.action_named(action)
  let assert Ok(v) =
    store.read(s, fn(r) {
      let assert Ok(Some(room)) = cases.room(r, id.recruitment_case(case_id))
      case_lifecycle.check(
        room,
        a,
        Some(role),
        [],
        False,
        option.unwrap(provider, case_lifecycle.provider(r, room, now)),
      )
    })
  v
}

/// The evidence a refusal says is missing, or "" when the verdict isn't LIFECYCLE_EVIDENCE_REQUIRED.
fn missing(
  v: Result(case_lifecycle.Allowed, case_lifecycle.Refusal),
) -> String {
  case v {
    Error(Refusal("LIFECYCLE_EVIDENCE_REQUIRED", _, fields)) ->
      case list.key_find(fields, "evidenceReason") {
        Ok(why) -> json.to_string(why)
        Error(Nil) -> ""
      }
    _ -> ""
  }
}

// ------------------------------------------------------------------------------------------------- contacts

fn contacts_store(rows: List(String)) -> Store {
  store_with([room_at("k1", "contact_planned", 1), ..rows])
}

fn contact_evidence(rows: List(String)) -> Evidence {
  evidence(contacts_store(rows), "k1", room_rules.ContactDelivered, 100)
}

pub fn a_draft_failed_or_cancelled_contact_satisfies_nothing_test() {
  assert contact_evidence([contact("c1", [])]) == Lacks("no_contact_delivered")
  assert contact_evidence([
      contact("c1", [#("status", q("failed")), #("failed_at", "1")]),
    ])
    == Lacks("no_contact_delivered")
  assert contact_evidence([contact("c1", [#("status", q("cancelled"))])])
    == Lacks("no_contact_delivered")
}

pub fn a_delivered_contact_later_cancelled_satisfies_nothing_test() {
  let s = contacts_store([contact("c1", delivered)])
  assert evidence(s, "k1", room_rules.ContactDelivered, 100)
    == Holds("recruitment_contact", "c1")
  exec(s, ["UPDATE recruitment_contacts SET cancelled_at = 2"])
  assert evidence(s, "k1", room_rules.ContactDelivered, 100)
    == Lacks("no_contact_delivered")
}

pub fn another_clubs_or_another_players_contact_proves_nothing_test() {
  assert contact_evidence([contact("c1", [#("org_id", q("o2")), ..delivered])])
    == Lacks("no_contact_delivered")
  assert contact_evidence([
      contact("c1", [#("player_id", q("p2")), ..delivered]),
    ])
    == Lacks("no_contact_delivered")
}

pub fn a_delivered_contact_with_no_recipient_is_not_evidence_test() {
  let s = contacts_store([contact("c1", delivered)])
  exec(s, [
    "UPDATE recruitment_contacts SET recipient_type = NULL, recipient_player_id = NULL, recipient_minor = NULL",
  ])
  assert evidence(s, "k1", room_rules.ContactDelivered, 100)
    == Lacks("no_contact_delivered")
}

pub fn delivered_recorded_and_answered_contacts_are_evidence_test() {
  assert contact_evidence([contact("c1", delivered)])
    == Holds("recruitment_contact", "c1")
  assert contact_evidence([
      contact("c1", [
        #("status", q("recorded")),
        #("channel", q("phone")),
        #("recipient_type", q("player")),
        #("recipient_player_id", q("p1")),
        #("recipient_minor", "0"),
        #("occurred_at", "1"),
      ]),
    ])
    == Holds("recruitment_contact", "c1")
  assert contact_evidence([
      contact("c1", [#("status", q("responded")), ..delivered]),
    ])
    == Holds("recruitment_contact", "c1")
}

/// contactsPersistence: a delivered contact with no recipient and an answered one never delivered are corrupt;
/// the sound row beside them is the evidence.
pub fn the_sound_contact_beside_corrupt_ones_is_the_evidence_test() {
  let corrupt = [
    contact("rct-norecip", [
      #("status", q("delivered")),
      #("delivered_at", "2001"),
    ]),
    contact("rct-impossible", [
      #("status", q("responded")),
      #("recipient_type", q("player")),
      #("recipient_player_id", q("p1")),
      #("recipient_minor", "0"),
      #("responded_at", "5"),
    ]),
  ]
  assert contact_evidence(corrupt) == Lacks("no_contact_delivered")
  assert contact_evidence([contact("rct-1", delivered), ..corrupt])
    == Holds("recruitment_contact", "rct-1")
}

pub fn the_lifecycle_refuses_contacted_on_a_draft_and_permits_it_once_delivered_test() {
  let s = contacts_store([contact("c1", [])])
  assert missing(verdict(s, "k1", "recordContact", RoomLead, 100, None))
    == "\"no_contact_delivered\""
  exec(s, [contact("c2", delivered)])
  assert verdict(s, "k1", "recordContact", RoomLead, 100, None)
    == Ok(Allowed(
      room_status.ContactPlanned,
      room_status.Contacted,
      "contact_made",
    ))
}

// --------------------------------------------------------------------------------------------------- trials

const trial_request =
  "INSERT INTO recruitment_requests (id, player_id, org_id, org_name, org_verified, org_safeguarding_certified, user_id, type, trial_alt_days_json, status, created_at, routed_to, case_id) VALUES ('r1', 'p1', 'o1', 'Club One', 0, 0, 'u1', 'trial', '[]', 'pending', 1, 'player', 'k1')"

/// trials P12's trial: accepted, with one proposed session and no confirmation.
const proposed_trial = [
  "INSERT INTO trials (id, request_id, case_id, player_id, org_id, org_name, accepted_at, status, reminder_sent, workflow_state, rev, schedule_timezone, schedule_revision) VALUES ('t', 'r1', 'k1', 'p1', 'o1', 'Club One', 1, 'awaiting_report', 0, 'accepted', 1, 'UTC', 1)",
  "INSERT INTO trial_schedule_sessions (trial_id, position, id, kind, starts_at, ends_at) VALUES ('t', 0, 's', 'training', 10, 20)",
]

fn trial_kinds(s: Store) -> List(Evidence) {
  list.map(
    [
      room_rules.TrialInvited,
      room_rules.TrialConfirmed,
      room_rules.TrialCompletedEvidence,
    ],
    evidence(s, "k1", _, 100),
  )
}

pub fn with_nothing_recorded_no_trial_stage_has_evidence_test() {
  let s = store_with([room_at("k1", "shortlisted", 1)])
  assert trial_kinds(s)
    == [
      Lacks("no_invitation"),
      Lacks("no_confirmed_schedule"),
      Lacks("no_completed_trial"),
    ]
}

pub fn a_pending_invitation_is_evidence_and_a_declined_one_is_not_test() {
  let s = store_with([room_at("k1", "shortlisted", 1), trial_request])
  assert evidence(s, "k1", room_rules.TrialInvited, 100)
    == Holds("trial_request", "r1")
  exec(s, ["UPDATE recruitment_requests SET status = 'declined'"])
  assert evidence(s, "k1", room_rules.TrialInvited, 100)
    == Lacks("no_invitation")
  exec(s, ["UPDATE recruitment_requests SET status = 'accepted'"])
  assert evidence(s, "k1", room_rules.TrialInvited, 100)
    == Holds("trial_request", "r1")
}

pub fn only_a_confirmed_schedule_and_an_explicit_completion_count_test() {
  let s = store_with([room_at("k1", "trial_requested", 1), trial_request])
  exec(s, [
    "UPDATE recruitment_requests SET status = 'accepted'",
    ..proposed_trial
  ])
  let confirmed = fn() { evidence(s, "k1", room_rules.TrialConfirmed, 100) }
  let completed = fn() {
    evidence(s, "k1", room_rules.TrialCompletedEvidence, 100)
  }
  // P12: proposed, unconfirmed.
  assert confirmed() == Lacks("no_confirmed_schedule")
  // P12b, P13: confirmed is scheduled, not completed.
  exec(s, [
    "UPDATE trials SET schedule_confirmed_at = 5, workflow_state = 'scheduled'",
  ])
  assert confirmed() == Holds("trial", "t")
  assert completed() == Lacks("no_completed_trial")
  // P13b: cancelled is not completed either.
  exec(s, [
    "UPDATE trials SET completion_state = 'cancelled', completion_at = 30, workflow_state = 'cancelled'",
  ])
  assert completed() == Lacks("no_completed_trial")
  // P13c, P13d: an explicit completion is, tombstoned or not.
  exec(s, [
    "UPDATE trials SET completion_state = 'completed', workflow_state = 'completed'",
  ])
  assert completed() == Holds("trial", "t")
  exec(s, ["UPDATE trials SET subject_removed_at = 40"])
  assert completed() == Holds("trial", "t")
}

// ------------------------------------------------------------------------------------------------ decisions

/// decisions P15's decision: formal, final, progress, current.
fn decision(did: String, over: Cols) -> String {
  insert(
    "room_decisions",
    [
      #("id", q(did)),
      #("room_id", q("k1")),
      #("org_id", q("o1")),
      #("player_id", q("p1")),
      #("kind", q("formal")),
      #("state", q("final")),
      #("outcome", q("progress")),
      #("recommendation", q("offer")),
      #("by_user_id", q("u1")),
      #("by_name", q("U")),
      #("created_at", "1"),
      #("rev", "1"),
    ],
    over,
  )
}

fn consider_offer(rows: List(String)) {
  let s =
    store_with([
      room_at("k1", "shortlisted", 1),
      room_at("k2", "shortlisted", 1),
      ..rows
    ])
  verdict(s, "k1", "considerOffer", RoomLead, 100, None)
}

const no_decision = "\"no_finalized_progress_decision\""

pub fn a_finalized_progress_decision_satisfies_consider_offer_test() {
  assert consider_offer([decision("d", [])])
    == Ok(Allowed(
      room_status.Shortlisted,
      room_status.OfferConsideration,
      "club_decision",
    ))
  assert missing(consider_offer([])) == no_decision
}

pub fn an_advisory_recommendation_or_a_formal_hold_proves_nothing_test() {
  assert missing(
      consider_offer([
        decision("d", [
          #("kind", "NULL"),
          #("state", "NULL"),
          #("outcome", "NULL"),
        ]),
      ]),
    )
    == no_decision
  assert missing(
      consider_offer([
        decision("d", [#("kind", q("recommendation")), #("outcome", "NULL")]),
      ]),
    )
    == no_decision
  assert missing(
      consider_offer([
        decision("d", [
          #("outcome", q("hold")),
          #("recommendation", q("continue_watching")),
        ]),
      ]),
    )
    == no_decision
}

pub fn a_superseded_draft_or_foreign_decision_proves_nothing_test() {
  assert missing(
      consider_offer([
        decision("later", [#("outcome", q("hold"))]),
        decision("d", [#("superseded_by_id", q("later"))]),
      ]),
    )
    == no_decision
  assert missing(consider_offer([decision("d", [#("state", q("draft"))])]))
    == no_decision
  assert missing(consider_offer([decision("d", [#("room_id", q("k2"))])]))
    == no_decision
  assert missing(consider_offer([decision("d", [#("org_id", q("o2"))])]))
    == no_decision
}

// --------------------------------------------------------------------------------------------------- offers

/// offers A82's Offer on case k1: one revision, issued to the player at T and expiring a day later.
fn offer_rows(status: String) -> List(String) {
  [
    insert(
      "recruitment_offers",
      [
        #("id", q("of1")),
        #("org_id", q("o1")),
        #("case_id", q("k1")),
        #("player_id", q("p1")),
        #("type", q("direct_recruitment")),
        #("status", q(status)),
        #("current_revision_id", q("r1")),
        #("created_at", n(t - hour)),
        #("created_by_user_id", q("u1")),
        #("updated_at", n(t)),
        #("rev", "1"),
        #("policy_version", "1"),
      ],
      [],
    ),
    insert(
      "offer_revisions",
      [
        #("id", q("r1")),
        #("offer_id", q("of1")),
        #("position", "0"),
        #("revision_number", "1"),
        #("status", q(status)),
        #("term_offer_type", q("direct_recruitment")),
        #("expires_at", n(t + day)),
        #("created_at", n(t - hour)),
        #("updated_at", n(t)),
        #("issued_at", n(t)),
        #("recipient_type", q("player")),
        #("recipient_player_id", q("p1")),
        #("recipient_minor", "0"),
        #("recipient_at", n(t)),
        #("rev", "1"),
      ],
      [],
    ),
  ]
}

pub fn an_issued_offer_lets_send_offer_through_until_it_expires_test() {
  let s =
    store_with([room_at("k1", "offer_consideration", 1), ..offer_rows("ISSUED")])
  assert verdict(s, "k1", "sendOffer", RoomLead, t, None)
    == Ok(Allowed(
      room_status.OfferConsideration,
      room_status.OfferMade,
      "offer_progression",
    ))
  assert missing(verdict(s, "k1", "sendOffer", RoomLead, t + 2 * day, None))
    == "\"no_issued_offer\""
  // A83: a provider that can't check refuses too.
  let null = fn(_) { Ok(Lacks("not_implemented")) }
  assert missing(verdict(s, "k1", "sendOffer", RoomLead, t, Some(null)))
    == "\"not_implemented\""
}

pub fn an_issued_offer_with_no_response_is_neither_accepted_nor_a_signing_test() {
  let s = store_with([room_at("k1", "offer_made", 1), ..offer_rows("ISSUED")])
  assert missing(verdict(
      s,
      "k1",
      "recordOfferAccepted",
      RecruitmentAdmin,
      t,
      None,
    ))
    == "\"no_recipient_acceptance\""
  assert missing(verdict(
      s,
      "k1",
      "confirmSignedOutcome",
      RecruitmentAdmin,
      t,
      None,
    ))
    == "\"no_confirmed_join\""
}

/// offersAdversarial R-p11: an acceptance answered before its revision was issued is not acceptance evidence.
pub fn a_temporally_corrupt_acceptance_cannot_move_the_case_test() {
  let s =
    store_with([
      room_at("k1", "offer_made", 1),
      ..list.append(offer_rows("ACCEPTED"), [
        "INSERT INTO offer_responses (id, offer_id, position, revision_id, response_type, actor_type, actor_id, for_player_id, occurred_at) VALUES ('resp1', 'of1', 0, 'r1', 'accepted', 'player', 'p1', 'p1', "
          <> n(t + 1)
          <> ")",
        "UPDATE offer_revisions SET responded_at = "
          <> n(t + 1)
          <> ", response_id = 'resp1'",
      ])
    ])
  // The same acceptance, answered after it was issued, moves the case.
  assert verdict(s, "k1", "recordOfferAccepted", RecruitmentAdmin, t + 2, None)
    == Ok(Allowed(
      room_status.OfferMade,
      room_status.OfferAccepted,
      "offer_accepted_in_scoutbox",
    ))
  exec(s, [
    "UPDATE offer_revisions SET responded_at = " <> n(t - 1),
    "UPDATE offer_responses SET occurred_at = " <> n(t - 1),
  ])
  assert missing(verdict(
      s,
      "k1",
      "recordOfferAccepted",
      RecruitmentAdmin,
      t,
      None,
    ))
    == "\"no_recipient_acceptance\""
}

// ------------------------------------------------------------------------------------------------- signings

/// A signing recorded at `ts` with no package.
fn legacy_signing(sid: String, org: String, player: String, ts: Int) -> String {
  "INSERT INTO signings (id, player_id, org_id, ts) VALUES ("
  <> q(sid)
  <> ", "
  <> q(player)
  <> ", "
  <> q(org)
  <> ", "
  <> n(ts)
  <> ")"
}

fn join(rows: List(String)) -> Evidence {
  let s = store_with([room_at("k1", "offer_accepted", 1000), ..rows])
  evidence(s, "k1", room_rules.ConfirmedJoin, 2000)
}

pub fn only_this_clubs_signing_of_this_player_proves_the_joining_test() {
  assert join([legacy_signing("sign-foreign", "o2", "p1", 1500)])
    == Lacks("no_confirmed_join")
  assert join([legacy_signing("sign-other", "o1", "p2", 1500)])
    == Lacks("no_confirmed_join")
  assert join([legacy_signing("sign-ok", "o1", "p1", 1500)])
    == Holds("signing", "sign-ok")
}

pub fn a_signing_recorded_before_the_case_opened_does_not_prove_it_test() {
  assert join([legacy_signing("s", "o1", "p1", 500)])
    == Lacks("no_confirmed_join")
  assert join([legacy_signing("s", "o1", "p1", 1500)]) == Holds("signing", "s")
}

/// A completed package opened on `case_id`, with its canonical signing `s` recorded at 1500.
fn package_on(case_id: String) -> List(String) {
  list.append(offer_rows("ACCEPTED"), [
    "INSERT INTO signing_packages (id, org_id, case_id, player_id, offer_id, offer_revision_id, status, current_revision_id, completion_signing_id, created_at, created_by_user_id, updated_at) VALUES ('spk', 'o1', "
      <> q(case_id)
      <> ", 'p1', 'of1', 'r1', 'COMPLETED', 'srev', 's', 1, 'u1', 1)",
    "INSERT INTO signings (id, player_id, org_id, ts, method, signing_package_id) VALUES ('s', 'p1', 'o1', 1500, 'CANONICAL_COMPLETION', 'spk')",
  ])
}

pub fn a_package_proves_only_the_case_it_was_opened_on_test() {
  assert join([room_at("k2", "offer_accepted", 1000), ..package_on("k2")])
    == Lacks("no_confirmed_join")
  assert join(package_on("k1")) == Holds("signing", "s")
}

/// lifecycle H1, H5 and the sweep: every inbound edge to `signed` needs the same confirmed joining.
pub fn every_inbound_edge_to_signed_needs_a_confirmed_join_test() {
  let inbound =
    list.filter_map(room_status.pairs, fn(p) {
      case room_rules.can_transition(p.1, room_status.Signed) {
        True -> Ok(p.0)
        False -> Error(Nil)
      }
    })
  assert list.contains(inbound, "offer_accepted")
  assert list.contains(inbound, "offer_made")
  list.each(inbound, fn(from) {
    let s = store_with([room_at("k1", from, 1000)])
    assert missing(verdict(
        s,
        "k1",
        "confirmSignedOutcome",
        RecruitmentAdmin,
        2000,
        None,
      ))
      == "\"no_confirmed_join\""
  })
}
