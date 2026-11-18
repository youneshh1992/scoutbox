//// The agent transaction workspace's pure layer (domains/agents/transactions/transaction.mjs): the state machine,
//// the compliance state a snapshot records, staleness, what the Offer workflow reads, room roles and visibility.
////
//// A transaction is a permissioned multi-party workspace, not an offer or a signing.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/agents/conflict.{type ConsentOutstanding}
import scoutbox/platform/canonical.{type Value}
import scoutbox/platform/secrets
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/id
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/vocab/context_outcome.{
  type ContextOutcome, Clear, InsufficientData, ManualRegulatoryReviewRequired,
  PermittedDualRepresentationConsentRequired, ProhibitedConflict,
}
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/document_visibility.{
  type DocumentVisibility, AgentPrivate, AllTransactionParties,
  EngagingAgentShared, EngagingClubPrivate, PlayerAgentShared, PlayerPrivate,
  ReleasingAgentShared, ReleasingClubPrivate, TAndSOnly,
}
import scoutbox/vocab/party_role.{
  type PartyRole, EngagingEntity, Individual, ReleasingEntity,
}
import scoutbox/vocab/pending_reason.{type PendingReason}
import scoutbox/vocab/staleness.{type Staleness}
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status.{
  type TransactionStatus, Active, Archived, Cancelled, Closed, ComplianceBlocked,
  CompliancePending, Draft, OnHold, PartiesConfirmed, Ready,
}

pub const honest =
  "A ScoutBox transaction is a permissioned workspace. \"Ready\" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed."

pub const offer_honest =
  "Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed."

// ------------------------------------------------------------------------------------------------- statuses

pub fn is_live(s: TransactionStatus) -> Bool {
  case s {
    Cancelled | Closed | Archived -> False
    _ -> True
  }
}

/// What an actor may ask for. READY and the COMPLIANCE_* states are absent: they are the compliance layer's
/// answer, not anyone's request.
pub fn actor_transitions(from: TransactionStatus) -> List(TransactionStatus) {
  case from {
    Draft -> [PartiesConfirmed, Cancelled]
    PartiesConfirmed -> [Cancelled]
    // Requestable so that compliance refuses it with the real reason, not this map with a generic one.
    CompliancePending -> [Active, Cancelled]
    ComplianceBlocked -> [Active, Cancelled]
    Ready -> [Active, OnHold, Cancelled]
    Active -> [OnHold, Closed, Cancelled]
    OnHold -> [Active, Closed, Cancelled]
    Cancelled -> [Archived]
    Closed -> [Archived]
    Archived -> []
  }
}

const all_statuses = [
  Draft,
  PartiesConfirmed,
  CompliancePending,
  ComplianceBlocked,
  Ready,
  Active,
  OnHold,
  Cancelled,
  Closed,
  Archived,
]

pub fn actor_transition_allowed(
  from: TransactionStatus,
  to: TransactionStatus,
) -> Bool {
  list.contains(actor_transitions(from), to)
}

/// The statuses an actor's move to `to` may start from.
pub fn leading_to(to: TransactionStatus) -> List(TransactionStatus) {
  list.filter(all_statuses, fn(from) { actor_transition_allowed(from, to) })
}

pub fn compliance_transitions(
  from: TransactionStatus,
) -> List(TransactionStatus) {
  case from {
    PartiesConfirmed -> [Ready, CompliancePending, ComplianceBlocked]
    CompliancePending -> [Ready, ComplianceBlocked, PartiesConfirmed]
    ComplianceBlocked -> [Ready, CompliancePending, PartiesConfirmed]
    Ready -> [CompliancePending, ComplianceBlocked]
    Active -> [CompliancePending, ComplianceBlocked]
    _ -> []
  }
}

/// ALL_TRANSITIONS: each status with the moves an actor and the compliance layer may make from it.
pub fn all_transitions_json() -> Json {
  json.array(all_statuses, fn(from) {
    json.object([
      #("from", transaction_status.to_json(from)),
      #(
        "byActor",
        json.array(actor_transitions(from), transaction_status.to_json),
      ),
      #(
        "byCompliance",
        json.array(compliance_transitions(from), transaction_status.to_json),
      ),
    ])
  })
}

/// A draft makes no compliance claim, so an evaluation never moves it.
pub fn compliance_transition_allowed(
  from: TransactionStatus,
  to: TransactionStatus,
) -> Bool {
  list.contains(compliance_transitions(from), to)
}

// ------------------------------------------------------------------------------------------------- parties

/// A releasing entity exists only where the individual leaves someone.
pub fn has_releasing_party(t: ContextType) -> Bool {
  t == context_type.Transfer || t == context_type.Loan
}

pub fn required_party_roles(t: ContextType) -> List(PartyRole) {
  case has_releasing_party(t) {
    True -> [Individual, EngagingEntity, ReleasingEntity]
    False -> [Individual, EngagingEntity]
  }
}

fn live_party(
  parties: List(party_row.Row),
  role: PartyRole,
) -> Option(party_row.Row) {
  list.find(parties, fn(p) { !p.removed && p.party_role == role })
  |> option.from_result
}

pub fn awaiting_confirmation(
  t: ContextType,
  parties: List(party_row.Row),
) -> List(PartyRole) {
  list.filter(required_party_roles(t), fn(role) {
    case live_party(parties, role) {
      Some(p) -> p.confirmed_at == None
      None -> True
    }
  })
}

pub fn parties_confirmed(t: ContextType, parties: List(party_row.Row)) -> Bool {
  awaiting_confirmation(t, parties) == []
}

pub fn club_party_role(
  parties: List(party_row.Row),
  org_id: String,
) -> Option(PartyRole) {
  list.find(parties, fn(p) {
    !p.removed && p.subject_kind == subject_kind.Club && p.subject_id == org_id
  })
  |> option.from_result
  |> option.map(fn(p) { p.party_role })
}

// ------------------------------------------------------------------------------------------------- compliance

/// What a snapshot says: `pending_reason` none and outcome CLEAR is clear; PROHIBITED with none is blocked.
pub type State {
  State(
    outcome: Option(ContextOutcome),
    reason_codes: List(String),
    pending_reason: Option(PendingReason),
    blocked: Bool,
    clear: Bool,
  )
}

/// The pending reason a gate gives: a gate is one of two reasons that refuse before any evaluation.
pub fn gate_reason(gate: tx_row.ComplianceGate) -> PendingReason {
  case gate {
    tx_row.FacetNotVerified -> pending_reason.FacetNotVerified
    tx_row.JurisdictionUnsupported -> pending_reason.JurisdictionUnsupported
  }
}

/// `complianceStateFrom`: the state an evaluation (or a gate that refused before one) gives.
pub fn state_from(
  outcome: Option(ContextOutcome),
  gate: Option(PendingReason),
  reason_codes: List(String),
  representation_count: Int,
  parties_confirmed: Bool,
) -> State {
  let base = State(outcome, list.unique(reason_codes), None, False, False)
  let pending = fn(r) { State(..base, pending_reason: Some(r)) }
  case gate, parties_confirmed, outcome {
    Some(g), _, _ -> pending(g)
    None, False, _ -> pending(pending_reason.PartiesNotConfirmed)
    None, True, Some(ProhibitedConflict) -> State(..base, blocked: True)
    None, True, Some(PermittedDualRepresentationConsentRequired) ->
      pending(pending_reason.ConsentRequired)
    None, True, Some(ManualRegulatoryReviewRequired) ->
      pending(pending_reason.ManualReview)
    None, True, Some(InsufficientData) | None, True, None ->
      pending(pending_reason.InsufficientData)
    // With no representation recorded nobody has authority yet, so CLEAR is not a clearance.
    None, True, Some(Clear) if representation_count < 1 ->
      pending(pending_reason.RepresentationMissing)
    None, True, Some(Clear) -> State(..base, clear: True)
  }
}

pub fn status_for(state: State) -> TransactionStatus {
  case state.blocked, state.clear, state.pending_reason {
    True, _, _ -> ComplianceBlocked
    _, True, _ -> Ready
    // Not yet a compliance question: calling these COMPLIANCE_PENDING would tell a party compliance is outstanding
    // when nothing has been asked of it.
    _, _, Some(pending_reason.PartiesNotConfirmed)
    | _, _, Some(pending_reason.RepresentationMissing)
    -> PartiesConfirmed
    _, _, _ -> CompliancePending
  }
}

/// A transaction's stored snapshot: the evaluation it names (or the gate that refused first), its pending reason,
/// the party revision and the licence freshness.
pub type Stored {
  Stored(
    evaluation_id: Option(id.EvaluationId),
    gate: Option(tx_row.ComplianceGate),
    evaluated_at: Int,
    pending_reason: Option(PendingReason),
    party_revision: String,
  )
}

/// What a snapshot names, read back from its evaluation.
pub type Evaluated {
  Evaluated(
    outcome: ContextOutcome,
    reason_codes: List(String),
    consents_outstanding: List(ConsentOutstanding),
    policy_versions: List(id.PolicyId),
  )
}

pub type View {
  View(
    evaluation_id: Option(String),
    evaluated_at: Int,
    policy_versions: List(id.PolicyId),
    consent_requirements: List(ConsentOutstanding),
    party_revision: String,
    state: State,
  )
}

/// `snapshotView`: outcome, reasons and versions come from the evaluation the snapshot names; a gate snapshot has
/// none of them.
pub fn snapshot_view(
  tx_id: String,
  stored: Option(Stored),
  evaluation: Option(Evaluated),
) -> Option(View) {
  use stored <- option.map(stored)
  let #(outcome, codes, consents, versions, evaluation_id) = case stored.gate {
    Some(gate) -> #(
      None,
      case gate {
        tx_row.JurisdictionUnsupported -> ["POLICY_NOT_ENCODED"]
        tx_row.FacetNotVerified -> []
      },
      [],
      [],
      Some(tx_id <> "#gate"),
    )
    None ->
      case evaluation {
        Some(e) -> #(
          Some(e.outcome),
          list.unique(e.reason_codes),
          e.consents_outstanding,
          e.policy_versions,
          option.map(stored.evaluation_id, id.evaluation_to_string),
        )
        None -> #(
          None,
          [],
          [],
          [],
          option.map(stored.evaluation_id, id.evaluation_to_string),
        )
      }
  }
  let pending = stored.pending_reason
  View(
    evaluation_id:,
    evaluated_at: stored.evaluated_at,
    policy_versions: versions,
    consent_requirements: consents,
    party_revision: stored.party_revision,
    state: State(
      outcome:,
      reason_codes: codes,
      pending_reason: pending,
      blocked: pending == None && outcome == Some(ProhibitedConflict),
      clear: pending == None && outcome == Some(Clear),
    ),
  )
}

/// Why the snapshot is stale, or none. A missing snapshot is stale.
pub fn staleness(
  view: Option(View),
  current_party_revision: String,
  re_evaluation_pending: Bool,
) -> Option(Staleness) {
  case view {
    None -> Some(staleness.NoSnapshot)
    Some(v) if v.party_revision != current_party_revision ->
      Some(staleness.InputsChanged)
    Some(_) if re_evaluation_pending -> Some(staleness.PolicyChanged)
    Some(_) -> None
  }
}

pub type Readiness {
  Readiness(can_start: Bool, blockers: List(String))
}

/// What the Offer workflow reads: whether a workspace currently permits an Offer, and why not.
pub fn offer_readiness(
  status: TransactionStatus,
  parties: List(party_row.Row),
  state: Option(State),
  stale: Option(Staleness),
) -> Readiness {
  let confirmed = fn(role) {
    list.any(parties, fn(p) {
      !p.removed && p.party_role == role && p.confirmed_at != None
    })
  }
  let blockers =
    [
      #("TRANSACTION_NOT_READY", status != Ready && status != Active),
      #("COMPLIANCE_SNAPSHOT_STALE", stale != None),
      #(
        "COMPLIANCE_NOT_CLEAR",
        option.map(state, fn(s) { s.clear }) != Some(True),
      ),
      #("INDIVIDUAL_NOT_CONFIRMED", !confirmed(Individual)),
      #("ENGAGING_ENTITY_NOT_CONFIRMED", !confirmed(EngagingEntity)),
    ]
    |> list.filter_map(fn(b) {
      case b.1 {
        True -> Ok(b.0)
        False -> Error(Nil)
      }
    })
  Readiness(blockers == [], blockers)
}

pub fn readiness_json(r: Readiness) -> Json {
  json.object([
    #("canStartOfferWorkflow", json.bool(r.can_start)),
    #("blockers", json.array(r.blockers, json.string)),
    #("honest", json.string(offer_honest)),
  ])
}

/// What a snapshot's staleness is measured against: a hash of everything an evaluation depended on. Recomputed
/// from live records every time, never cached.
pub fn party_revision(
  parties: List(party_row.Row),
  agent_user_id: String,
  representations: List(#(String, PartyRole, String, Option(String))),
  consents: List(#(String, String)),
  facet_states: Value,
  policy_versions: List(id.PolicyId),
  blocked_subject_ids: List(String),
  minor_subject_ids: List(String),
) -> String {
  let sorted = fn(xs) { canonical.strings(list.sort(xs, string.compare)) }
  canonical.Object([
    #(
      "parties",
      parties
        |> list.filter(fn(p) { !p.removed })
        |> list.map(fn(p) {
          party_role.to_string(p.party_role)
          <> ":"
          <> subject_kind.to_string(p.subject_kind)
          <> ":"
          <> p.subject_id
          <> case p.confirmed_at {
            Some(_) -> ":c"
            None -> ":u"
          }
        })
        |> sorted,
    ),
    #("agentUserId", canonical.Str(agent_user_id)),
    #(
      "representations",
      representations
        |> list.filter(fn(r) { r.2 != "withdrawn" })
        |> list.map(fn(r) {
          r.0
          <> ":"
          <> party_role.to_string(r.1)
          <> ":"
          <> r.2
          <> ":"
          <> option.unwrap(r.3, "")
        })
        |> sorted,
    ),
    #("consents", consents |> list.map(fn(c) { c.0 <> ":" <> c.1 }) |> sorted),
    #("facetStates", facet_states),
    #("policyVersions", sorted(list.map(policy_versions, id.policy_to_string))),
    #("blockedSubjectIds", sorted(blocked_subject_ids)),
    #("minorSubjectIds", sorted(minor_subject_ids)),
  ])
  |> canonical.to_string
  |> secrets.sha256_hex
}

// ------------------------------------------------------------------------------------------------- room roles

/// Not the Recruitment Room roles. `party_guardian` is never granted: no minor transaction pathway is enabled.
pub type RoomRole {
  RepresentingAgent
  PartyIndividual
  PartyClubSignatory
  PartyClubMember
  AgencyAdminObserver
  TrustSafety
}

pub fn room_role_to_string(r: RoomRole) -> String {
  case r {
    RepresentingAgent -> "representing_agent"
    PartyIndividual -> "party_individual"
    PartyClubSignatory -> "party_club_signatory"
    PartyClubMember -> "party_club_member"
    AgencyAdminObserver -> "agency_admin_observer"
    TrustSafety -> "trust_safety"
  }
}

/// The viewer as the server derived it (whether a user is a recorded signatory, say), never a request's claim.
pub type Viewer {
  AgencyViewer(org_id: String, user_id: String, agency_admin: Bool)
  ClubViewer(org_id: String, user_id: String, signatory: Bool)
  PlayerViewer(player_id: String)
  ReviewerViewer
}

pub fn room_roles(
  agency_org_id: String,
  agent_user_id: String,
  parties: List(party_row.Row),
  viewer: Viewer,
) -> List(RoomRole) {
  let names = fn(kind, id) {
    list.any(parties, fn(p) {
      !p.removed && p.subject_kind == kind && p.subject_id == id
    })
  }
  case viewer {
    ReviewerViewer -> [TrustSafety]
    PlayerViewer(player) ->
      case names(subject_kind.Player, player) {
        True -> [PartyIndividual]
        False -> []
      }
    AgencyViewer(org, user, admin) ->
      case org == agency_org_id, user == agent_user_id, admin {
        False, _, _ -> []
        True, True, _ -> [RepresentingAgent]
        True, False, True -> [AgencyAdminObserver]
        True, False, False -> []
      }
    ClubViewer(org, _, signatory) ->
      case names(subject_kind.Club, org), signatory {
        False, _ -> []
        True, True -> [PartyClubSignatory]
        True, False -> [PartyClubMember]
      }
  }
}

// ------------------------------------------------------------------------------------------------- visibility

const all_visibilities = [
  AgentPrivate,
  PlayerPrivate,
  EngagingClubPrivate,
  ReleasingClubPrivate,
  PlayerAgentShared,
  EngagingAgentShared,
  ReleasingAgentShared,
  AllTransactionParties,
  TAndSOnly,
]

fn visibility_roles(v: DocumentVisibility) -> List(RoomRole) {
  case v {
    // A same-agency colleague is one agent for conflicts but a separate person for data.
    AgentPrivate -> [RepresentingAgent]
    PlayerPrivate -> [PartyIndividual]
    EngagingClubPrivate | ReleasingClubPrivate -> [
      PartyClubSignatory,
      PartyClubMember,
    ]
    PlayerAgentShared -> [RepresentingAgent, PartyIndividual]
    EngagingAgentShared | ReleasingAgentShared -> [
      RepresentingAgent,
      PartyClubSignatory,
      PartyClubMember,
    ]
    AllTransactionParties -> [
      RepresentingAgent,
      PartyIndividual,
      PartyClubSignatory,
      PartyClubMember,
    ]
    TAndSOnly -> [TrustSafety]
  }
}

/// Both clubs hold `party_club_signatory`, so the club-side classes are also checked against the viewer's side.
fn visibility_side(v: DocumentVisibility) -> Option(PartyRole) {
  case v {
    EngagingClubPrivate | EngagingAgentShared -> Some(EngagingEntity)
    ReleasingClubPrivate | ReleasingAgentShared -> Some(ReleasingEntity)
    _ -> None
  }
}

/// `party_role` is the viewer's side, for a club.
pub fn can_see(
  v: DocumentVisibility,
  roles: List(RoomRole),
  party_role: Option(PartyRole),
) -> Bool {
  let allowed = visibility_roles(v)
  case list.any(roles, list.contains(allowed, _)), visibility_side(v) {
    False, _ -> False
    True, None -> True
    True, Some(side) ->
      list.contains(roles, RepresentingAgent) || party_role == Some(side)
  }
}

/// The classes a viewer may file into: narrower than what it may read.
pub fn uploadable(
  roles: List(RoomRole),
  party_role: Option(PartyRole),
) -> List(DocumentVisibility) {
  list.filter(all_visibilities, fn(v) {
    let club_side = case v {
      EngagingClubPrivate
      | ReleasingClubPrivate
      | EngagingAgentShared
      | ReleasingAgentShared -> True
      _ -> False
    }
    v != TAndSOnly
    && can_see(v, roles, party_role)
    // The club-side classes belong to the club and agent lanes, not the player's.
    && !{
      list.contains(roles, PartyIndividual)
      && !list.contains(roles, RepresentingAgent)
      && club_side
    }
  })
}

/// A role, not an identity: no party learns which named person on another side acted. The kind and the label.
pub fn actor(kind: String, name: Option(String)) -> #(String, String) {
  case kind {
    "ts_reviewer" -> #("trust_safety", "Trust & Safety (attributed)")
    "org" | "agent" -> #("agent", "Representing agent")
    "club_user" -> #("club", "Club signatory")
    "player" -> #("player", "Player")
    "system" -> #("system", option.unwrap(name, "ScoutBox"))
    other -> #("other", other)
  }
}

pub fn actor_label(kind: String, name: Option(String)) -> Json {
  let #(k, label) = actor(kind, name)
  json.object([#("kind", json.string(k)), #("label", json.string(label))])
}

// ------------------------------------------------------------------------------------------------- timeline

/// Who a history entry reaches. `PerDocument` entries reach exactly the parties the document's own class admits.
pub type Audience {
  AllParties
  AgentOnly
  PlayerAndAgent
  ClubSide
  PerDocument
  AuditOnly
}

pub fn audience_to_string(a: Audience) -> String {
  case a {
    AllParties -> "all_parties"
    AgentOnly -> "agent_only"
    PlayerAndAgent -> "player_and_agent"
    ClubSide -> "club_side"
    PerDocument -> "per_document"
    AuditOnly -> "audit_only"
  }
}

pub fn audience_of(action: event_row.Action) -> Audience {
  case action {
    event_row.TransactionDocumentAdded
    | event_row.TransactionDocumentSuperseded -> PerDocument
    // A representation is the agent's own regulated act.
    event_row.TransactionRepresentationAttached
    | event_row.TransactionRepresentationWithdrawn -> AgentOnly
    event_row.TransactionNoteAdded | event_row.TransactionSubjectTombstoned ->
      AuditOnly
    _ -> AllParties
  }
}

/// A `PerDocument` entry with no class is withheld.
pub fn timeline_visible(
  audience: Audience,
  roles: List(RoomRole),
  party_role: Option(PartyRole),
  visibility: Option(DocumentVisibility),
) -> Bool {
  let has = list.contains(roles, _)
  case audience, roles {
    AuditOnly, _ -> False
    _, [] -> False
    _, _ ->
      case has(TrustSafety), audience {
        True, _ -> True
        _, PerDocument ->
          case visibility {
            Some(v) -> can_see(v, roles, party_role)
            None -> False
          }
        _, AllParties -> True
        _, AgentOnly -> has(RepresentingAgent)
        _, PlayerAndAgent -> has(RepresentingAgent) || has(PartyIndividual)
        _, ClubSide ->
          has(PartyClubSignatory)
          || has(PartyClubMember)
          || { has(RepresentingAgent) && party_role != None }
        _, AuditOnly -> False
      }
  }
}
