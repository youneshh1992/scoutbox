//// The live events (domains/platform/eventRegistry.mjs), apart from the hub (`platform/live`) so that an effect
//// can carry one: `rows/id` imports the store, which imports the effects, so ids here are text. Build an event
//// from typed ids with `messaging/live_routes` (`live_routes.messages(channel_id)`), never from text.

import gleam/json.{type Json}
import gleam/option.{type Option}
import scoutbox/vocab/audience.{type Audience}

/// An event, by its name in the event registry (e2e/support/spec/platform/eventRegistry.json). Its fields are the
/// registry's payload keys and nothing else; `test/scoutbox/platform/live_test.gleam` proves they agree.
pub type Event {
  /// A thread changed: a message, or a read receipt.
  Messages(channel_id: String)
  /// Someone is typing in a thread. Never replayed.
  Typing(channel_id: String, side: TypingSide)
  /// A notice reached an audience's feed.
  Notify(audience_kind: Audience, audience_id: String)
  /// An agent profile was created. Private to the agency.
  AgentProfileCreated(org_id: String, user_id: String)
  /// An agent's verification facet changed state. Private to the agency.
  AgentVerificationStateChanged(
    org_id: String,
    user_id: String,
    facet: String,
    state: String,
  )
  /// A member joined the agency. Private to the agency.
  AgencyAffiliationCreated(org_id: String, user_id: String)
  /// A member's membership ended. Private to the agency.
  AgencyAffiliationEnded(org_id: String, user_id: String)
  /// A representation relationship changed (each change is its own registry entry). Private to the agency.
  Representation(
    change: RepresentationChange,
    org_id: String,
    agreement_id: String,
    agent_user_id: String,
  )
  /// A regulatory review item was opened. Private to the agency.
  RegulatoryReviewRequested(org_id: String, review_id: String, kind: String)
  /// An Offer on a Room changed (each change is its own registry entry). Private to the club.
  OfferChanged(
    change: OfferChange,
    org_id: String,
    room_id: String,
    offer_id: String,
  )
  /// A recipient answered an Offer. Private to the club.
  OfferResponded(
    org_id: String,
    room_id: String,
    offer_id: String,
    status: Option(String),
  )
  /// A club sent a trial invitation from a Room. Private to the club.
  TrialInvited(org_id: String, room_id: String, request_id: String)
  /// The recipient accepted a trial invitation. Private to the club.
  TrialAccepted(
    org_id: String,
    room_id: String,
    trial_id: String,
    request_id: String,
  )
  /// The recipient declined a trial invitation. Private to the club.
  TrialDeclined(org_id: String, room_id: String, request_id: String)
  /// A trial's schedule or end changed (each change is its own registry entry). Private to the club.
  TrialChanged(
    change: TrialChange,
    org_id: String,
    room_id: String,
    trial_id: String,
  )
  /// A trial session's record changed (attendance, evidence). Private to the club.
  TrialSessionChanged(
    change: TrialSessionChange,
    org_id: String,
    room_id: String,
    trial_id: String,
    session_id: String,
  )
  /// A club invited a transaction workspace on a Room. Private to the club.
  TransactionHandoffInvited(org_id: String, room_id: String, handoff_id: String)
  /// A compliance context was evaluated. Private to the agency.
  ConflictEvaluated(org_id: String, ctx_id: String, outcome: String)
  /// A transaction workspace was opened. Private to the agency.
  AgentTransactionCreated(org_id: String, tx_id: String)
  /// A transaction's compliance answer changed. Private to the agency.
  AgentTransactionComplianceUpdated(
    org_id: String,
    tx_id: String,
    outcome: String,
  )
  /// A transaction moved status. Private to the agency.
  AgentTransactionStatusChanged(org_id: String, tx_id: String, status: String)
}

pub type OfferChange {
  OfferDraftCreated
  OfferDraftUpdated
  OfferIssued
  OfferSuperseded
  OfferWithdrawn
}

pub type TrialChange {
  TrialScheduled
  TrialRescheduled
  TrialCancelled
  TrialCompleted
}

pub type TrialSessionChange {
  TrialAttendanceRecorded
  TrialEvidenceLinked
}

pub type RepresentationChange {
  RepresentationRequested
  RepresentationConfirmed
  RepresentationRejected
  RepresentationTerminated
  RepresentationDisputed
  RepresentationDisclosureChanged
}

pub type TypingSide {
  OrgTyping
  CounterpartyTyping
}

pub fn name(event: Event) -> String {
  case event {
    Messages(..) -> "messages"
    Typing(..) -> "typing"
    Notify(..) -> "notify"
    AgentProfileCreated(..) -> "agent_profile_created"
    AgentVerificationStateChanged(..) -> "agent_verification_state_changed"
    AgencyAffiliationCreated(..) -> "agency_affiliation_created"
    AgencyAffiliationEnded(..) -> "agency_affiliation_ended"
    Representation(change:, ..) ->
      case change {
        RepresentationRequested -> "representation_requested"
        RepresentationConfirmed -> "representation_confirmed"
        RepresentationRejected -> "representation_rejected"
        RepresentationTerminated -> "representation_terminated"
        RepresentationDisputed -> "representation_disputed"
        RepresentationDisclosureChanged -> "representation_disclosure_changed"
      }
    RegulatoryReviewRequested(..) -> "regulatory_review_requested"
    OfferChanged(change:, ..) ->
      case change {
        OfferDraftCreated -> "offer_draft_created"
        OfferDraftUpdated -> "offer_draft_updated"
        OfferIssued -> "offer_issued"
        OfferSuperseded -> "offer_superseded"
        OfferWithdrawn -> "offer_withdrawn"
      }
    OfferResponded(..) -> "offer_responded"
    TrialInvited(..) -> "trial_invited"
    TrialAccepted(..) -> "trial_accepted"
    TrialDeclined(..) -> "trial_declined"
    TrialChanged(change:, ..) ->
      case change {
        TrialScheduled -> "trial_scheduled"
        TrialRescheduled -> "trial_rescheduled"
        TrialCancelled -> "trial_cancelled"
        TrialCompleted -> "trial_completed"
      }
    TrialSessionChanged(change:, ..) ->
      case change {
        TrialAttendanceRecorded -> "trial_attendance_recorded"
        TrialEvidenceLinked -> "trial_evidence_linked"
      }
    TransactionHandoffInvited(..) -> "transaction_handoff_invited"
    ConflictEvaluated(..) -> "conflict_evaluated"
    AgentTransactionCreated(..) -> "agent_transaction_created"
    AgentTransactionComplianceUpdated(..) ->
      "agent_transaction_compliance_updated"
    AgentTransactionStatusChanged(..) -> "agent_transaction_status_changed"
  }
}

/// The registry's payload, in its key order.
/// The agency an event is private to, when the registry's payload names one (`orgId`).
pub fn org_of(event: Event) -> Result(String, Nil) {
  case event {
    AgentProfileCreated(org_id:, ..)
    | AgentVerificationStateChanged(org_id:, ..)
    | AgencyAffiliationCreated(org_id:, ..)
    | AgencyAffiliationEnded(org_id:, ..)
    | Representation(org_id:, ..)
    | RegulatoryReviewRequested(org_id:, ..)
    | OfferChanged(org_id:, ..)
    | OfferResponded(org_id:, ..)
    | TrialInvited(org_id:, ..)
    | TrialAccepted(org_id:, ..)
    | TrialDeclined(org_id:, ..)
    | TrialChanged(org_id:, ..)
    | TrialSessionChanged(org_id:, ..)
    | TransactionHandoffInvited(org_id:, ..)
    | ConflictEvaluated(org_id:, ..)
    | AgentTransactionCreated(org_id:, ..)
    | AgentTransactionComplianceUpdated(org_id:, ..)
    | AgentTransactionStatusChanged(org_id:, ..) -> Ok(org_id)
    Messages(..) | Typing(..) | Notify(..) -> Error(Nil)
  }
}

pub fn payload(event: Event) -> List(#(String, Json)) {
  case event {
    Messages(channel_id:) -> [#("channelId", json.string(channel_id))]
    Typing(channel_id:, side:) -> [
      #("channelId", json.string(channel_id)),
      #(
        "side",
        json.string(case side {
          OrgTyping -> "org"
          CounterpartyTyping -> "counterparty"
        }),
      ),
    ]
    Notify(audience_kind:, audience_id:) -> [
      #("audienceKind", audience.to_json(audience_kind)),
      #("audienceId", json.string(audience_id)),
    ]
    AgentProfileCreated(org_id:, user_id:)
    | AgencyAffiliationCreated(org_id:, user_id:)
    | AgencyAffiliationEnded(org_id:, user_id:) -> [
      #("orgId", json.string(org_id)),
      #("userId", json.string(user_id)),
    ]
    AgentVerificationStateChanged(org_id:, user_id:, facet:, state:) -> [
      #("orgId", json.string(org_id)),
      #("userId", json.string(user_id)),
      #("facet", json.string(facet)),
      #("state", json.string(state)),
    ]
    Representation(org_id:, agreement_id:, agent_user_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("agreementId", json.string(agreement_id)),
      #("agentUserId", json.string(agent_user_id)),
    ]
    RegulatoryReviewRequested(org_id:, review_id:, kind:) -> [
      #("orgId", json.string(org_id)),
      #("reviewId", json.string(review_id)),
      #("kind", json.string(kind)),
    ]
    OfferChanged(org_id:, room_id:, offer_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("offerId", json.string(offer_id)),
    ]
    OfferResponded(org_id:, room_id:, offer_id:, status:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("offerId", json.string(offer_id)),
      #("status", json.nullable(status, json.string)),
    ]
    TrialInvited(org_id:, room_id:, request_id:)
    | TrialDeclined(org_id:, room_id:, request_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("requestId", json.string(request_id)),
    ]
    TrialAccepted(org_id:, room_id:, trial_id:, request_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("trialId", json.string(trial_id)),
      #("requestId", json.string(request_id)),
    ]
    TrialChanged(org_id:, room_id:, trial_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("trialId", json.string(trial_id)),
    ]
    TrialSessionChanged(org_id:, room_id:, trial_id:, session_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("trialId", json.string(trial_id)),
      #("sessionId", json.string(session_id)),
    ]
    TransactionHandoffInvited(org_id:, room_id:, handoff_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("handoffId", json.string(handoff_id)),
    ]
    ConflictEvaluated(org_id:, ctx_id:, outcome:) -> [
      #("orgId", json.string(org_id)),
      #("ctxId", json.string(ctx_id)),
      #("outcome", json.string(outcome)),
    ]
    AgentTransactionCreated(org_id:, tx_id:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
    ]
    AgentTransactionComplianceUpdated(org_id:, tx_id:, outcome:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
      #("outcome", json.string(outcome)),
    ]
    AgentTransactionStatusChanged(org_id:, tx_id:, status:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
      #("status", json.string(status)),
    ]
  }
}

/// Whether a reconnect replays it (the registry's `replayPolicy`).
pub fn replays(event: Event) -> Bool {
  case event {
    Messages(..) | Notify(..) | OfferResponded(..) -> True
    OfferChanged(change:, ..) -> change != OfferDraftUpdated
    _ -> False
  }
}
