//// The integration seam's checks the recorder can't turn into generated cases, ported by hand from the TypeScript
//// rules suites of agents/crossApp, agents/adversarial and platform/dates (scripts/rules/). The rest of their calls
//// are generated against `integration`, `contact_rules` and `handoffs`.
////
//// Refused before the rule, so they have no counterpart here:
////
//// - An unknown surface (`nope`, `__proto__`; crossApp's SURFACE_UNKNOWN checks). `Surface` is a closed type, and
////   every route names its surface by constructor. `surfaces` below is the TypeScript seam's list.
//// - A regulatory minor's agreement (`isRegulatoryMinor: true`). The TypeScript request route refuses a minor before
////   an agreement exists, so the flag is always false, and here there is no column for it. A client who isn't an
////   adult is refused at MINOR_PATHWAY, which is generated.
//// - An agent id that is null, and a legacy mirror naming no agent (crossApp's pure C, adversarial C1). The agent is
////   the signed-in user's typed id, and `agent_user_id` is NOT NULL on every agreement.
//// - In contactRouting: no recipient (the route refuses the contact first, 422 CONTACT_RECIPIENT_UNAVAILABLE:
////   contacts X6g), `agent_only` (refused, 400 CONTACT_MODE_INVALID: contacts Y2, and checked below), and an allowed
////   decision naming no agent (`Allowed` holds the agreement, whose agent is NOT NULL).
//// - A snapshot of a failed routing (H-p13): a send happens only after a routing.
//// - A handoff's invitation time that isn't an instant (platform/dates' junk, NaN and ±Infinity, and none at all).
////   `invited_at` is an INTEGER NOT NULL column written from the clock. An unrecognised stored status (P-p18) can't
////   be decoded.
//// - handoffBlockers with no case status (`{}`): every handoff is a Room's, and a Room has a status. The rest of that
////   call is ported below.
////
//// duplicateTransactionOf's calls (Q-p1 to Q-p7) pass a closure, so none was recorded; they are ported below over
//// `transaction_store.duplicate_in`, the rule `duplicate_of` applies to the live transactions it reads.

import gleam/list
import gleam/option.{None, Some}
import scoutbox/agents/handoffs
import scoutbox/agents/integration
import scoutbox/agents/transaction_store.{type Transaction, Transaction}
import scoutbox/battery/base
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/case_transaction_handoffs as handoff_row
import scoutbox/rows/id
import scoutbox/rows/transaction_parties as party_row
import scoutbox/vocab/contact_mode
import scoutbox/vocab/context_type.{type ContextType, EmploymentContract, Loan}
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/room_status
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status.{type TransactionStatus}

pub fn surfaces_are_the_seams_test() {
  assert list.map(integration.surfaces, fn(p) { p.0 })
    == [
      "client_private", "passport_basic", "passport_shared", "evidence_shared",
      "contact_participation", "trial_projection", "trial_coordination",
      "opportunity_share", "transaction_initiation", "club_agent_presence",
    ]
}

/// crossApp's "no mode reaches an agent instead of the player": there is no such mode to ask for.
pub fn no_agent_only_mode_test() {
  assert list.key_find(contact_mode.pairs, "agent_only") == Error(Nil)
}

/// platform/dates: a handoff that isn't open is its stored status, whatever its invitation time.
pub fn an_accepted_handoff_ignores_its_invitation_time_test() {
  let h =
    handoff_row.Row(
      ..base.handoff(),
      status: handoff_row.Accepted,
      invited_at: -1,
    )
  assert handoffs.effective_status(h, 1_790_164_800_000) == "accepted"
}

/// crossApp's `handoffBlockers({})`, with a case status the Room could have: every blocker a missing fact raises.
pub fn every_missing_fact_blocks_a_handoff_test() {
  let facts =
    handoffs.Facts(
      can_write: False,
      has_final_progress_decision: False,
      case_status: room_status.Watching,
      subject_present: False,
      is_adult: False,
      blocked: False,
      existing_status: None,
      live_transaction: False,
      compliance_evaluable: False,
    )
  assert handoffs.blockers(facts)
    == [
      "HANDOFF_NOT_PERMITTED", "HANDOFF_DECISION_REQUIRED", "HANDOFF_CASE_STATE",
      "HANDOFF_SUBJECT_UNAVAILABLE", "HANDOFF_MINOR_PATHWAY_DISABLED",
      "HANDOFF_COMPLIANCE_UNAVAILABLE",
    ]
}

// ------------------------------------------------------------------------------------ duplicateTransactionOf

fn party(t: String, role: PartyRole, subject: String, removed: Bool) {
  party_row.new(
    id: id.transaction_party(t <> "-" <> subject),
    transaction_id: id.transaction(t),
    transaction_type: EmploymentContract,
    ord: 0,
    party_role: role,
    subject_kind: case role {
      party_role.Individual -> subject_kind.Player
      _ -> subject_kind.Club
    },
    subject_id: subject,
    added_at: 0,
    added_by_id: id.org_user("u"),
    removed:,
  )
}

fn parties(t: String, individual: String, engaging, releasing) {
  list.flatten([
    [party(t, party_role.Individual, individual, False)],
    case engaging {
      Some(e) -> [party(t, party_role.EngagingEntity, e, False)]
      None -> []
    },
    case releasing {
      Some(r) -> [party(t, party_role.ReleasingEntity, r, False)]
      None -> []
    },
  ])
}

fn tx(
  t: String,
  type_: ContextType,
  status: TransactionStatus,
  ps: List(party_row.Row),
) -> Transaction {
  Transaction(
    row: tx_row.new(
      id: id.transaction(t),
      agency_org_id: id.org("org-northstar"),
      agent_user_id: id.org_user("usr-ana"),
      type_:,
      status:,
      context_id: id.compliance_context("ctx-" <> t),
      re_evaluation_pending: False,
      created_at: 0,
      updated_at: 0,
      rev: 1,
    ),
    jurisdictions: [],
    parties: ps,
    notes: [],
    threads: [],
    terms: [],
    keys: [],
  )
}

fn live() -> List(Transaction) {
  [
    tx(
      "atx-1",
      EmploymentContract,
      transaction_status.Active,
      parties("atx-1", "pl-kola", Some("org-eastport"), None),
    ),
  ]
}

fn duplicate(
  txs: List(Transaction),
  individual: String,
  type_: ContextType,
  engaging,
  releasing,
) -> option.Option(String) {
  transaction_store.duplicate_in(txs, individual, type_, engaging, releasing)
  |> option.map(fn(t) { id.transaction_to_string(t.row.id) })
}

pub fn same_individual_type_and_clubs_is_a_duplicate_test() {
  // Q-p1
  assert duplicate(
      live(),
      "pl-kola",
      EmploymentContract,
      Some("org-eastport"),
      None,
    )
    == Some("atx-1")
}

pub fn a_loan_beside_an_employment_contract_is_separate_test() {
  // Q-p2
  assert duplicate(live(), "pl-kola", Loan, Some("org-eastport"), None) == None
}

pub fn another_engaging_club_is_separate_test() {
  // Q-p3
  assert duplicate(
      live(),
      "pl-kola",
      EmploymentContract,
      Some("org-harbour"),
      None,
    )
    == None
}

pub fn adding_a_releasing_side_is_separate_test() {
  // Q-p4
  assert duplicate(
      live(),
      "pl-kola",
      EmploymentContract,
      Some("org-eastport"),
      Some("org-harbour"),
    )
    == None
}

pub fn another_individual_is_separate_test() {
  // Q-p5
  assert duplicate(
      live(),
      "pl-other",
      EmploymentContract,
      Some("org-eastport"),
      None,
    )
    == None
}

pub fn a_cancelled_transaction_blocks_nothing_test() {
  // Q-p6
  let cancelled = [
    tx(
      "atx-2",
      EmploymentContract,
      transaction_status.Cancelled,
      parties("atx-2", "pl-kola", Some("org-eastport"), None),
    ),
  ]
  assert duplicate(
      cancelled,
      "pl-kola",
      EmploymentContract,
      Some("org-eastport"),
      None,
    )
    == None
}

pub fn a_removed_party_makes_no_context_test() {
  // Q-p7
  let tombstoned = [
    tx("atx-3", EmploymentContract, transaction_status.Active, [
      party("atx-3", party_role.Individual, "pl-kola", True),
      party("atx-3", party_role.EngagingEntity, "org-eastport", False),
    ]),
  ]
  assert duplicate(
      tombstoned,
      "pl-kola",
      EmploymentContract,
      Some("org-eastport"),
      None,
    )
    == None
}
