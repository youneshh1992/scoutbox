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
  /// A signing package on a Room changed (each change is its own registry entry). Private to the club.
  SigningChanged(
    change: SigningChange,
    org_id: String,
    room_id: String,
    package_id: String,
  )
  /// A recipient answered an Offer. Private to the club.
  OfferResponded(
    org_id: String,
    room_id: String,
    offer_id: String,
    status: Option(String),
  )
  /// A scout submitted an assessment. Private to the club.
  AssessmentSubmitted(org_id: String, assessment_id: String)
  /// A club published feedback to a player. The registry calls it private to a club but names none, so (as in
  /// the TypeScript server) no stream receives it.
  Feedback(player_id: String)
  /// An application to a club's opportunity was made or answered. Like `Feedback`, the registry calls it private to a
  /// club but names none, so no stream receives it.
  Applications(player_id: String)
  /// A Dynamic Watchlist changed (each change is its own registry entry). Ids only: the club re-reads it under its
  /// own authorisation. Private to the club.
  WatchlistChanged(
    change: WatchlistChange,
    org_id: String,
    watchlist_id: String,
  )
  /// A Room was opened from matching or a watchlist. Private to the club.
  MatchingRoomCreated(org_id: String, room_id: String)
  /// A Room's case moved between lifecycle states. Private to the club.
  RecruitmentCaseMoved(
    org_id: String,
    room_id: String,
    from: String,
    to: String,
  )
  /// A Room was filed away (archived, closed or withdrawn). Ids only: Second Look reconciles from the decision row.
  /// Private to the club.
  RecruitmentRoomArchived(org_id: String, room_id: String)
  /// A club reopened an archived Room from a Second Look item. Private to the club.
  RoomReopenedFromSecondLook(org_id: String, room_id: String, item_id: String)
  /// A formal decision was recorded on a Room, first or superseding. Private to the club.
  RoomDecisionChanged(
    change: DecisionChange,
    org_id: String,
    room_id: String,
    decision_id: String,
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
  /// A club withdrew its transaction handoff. Private to the club.
  TransactionHandoffWithdrawn(
    org_id: String,
    room_id: String,
    handoff_id: String,
  )
  /// An agent shared an opportunity with a client. Private to the agency.
  AgentOpportunityShared(
    org_id: String,
    agreement_id: String,
    agent_user_id: String,
  )
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
  /// A party was named, removed or confirmed itself. Private to the agency.
  AgentTransactionPartyChanged(
    org_id: String,
    tx_id: String,
    party_role: String,
  )
  /// A document was filed in a transaction. Private to the agency.
  AgentTransactionDocumentAdded(org_id: String, tx_id: String, doc_id: String)
  /// A club linked a conversation. Private to the agency.
  AgentTransactionMessageLinked(org_id: String, tx_id: String)
  /// The agent put a transaction on hold, cancelled or closed it. Private to the agency.
  AgentTransactionHeld(org_id: String, tx_id: String, status: String)
  AgentTransactionCancelled(org_id: String, tx_id: String, status: String)
  AgentTransactionClosed(org_id: String, tx_id: String, status: String)
  /// A named reviewer took a review item. Private to the agency.
  RegulatoryReviewStarted(org_id: String, review_id: String)
  /// A named reviewer decided a review item. Private to the agency.
  RegulatoryReviewResolved(org_id: String, review_id: String, outcome: String)
  /// An agent's authorisation changed by attributed review. Private to the agency.
  AgentAuthorisationStateChanged(org_id: String, user_id: String, state: String)
  /// A party was asked for, or answered, a regulatory consent. Private to the agency.
  RegulatoryConsentChanged(
    change: ConsentChange,
    org_id: String,
    consent_id: String,
    ctx_id: String,
  )
}

pub type ConsentChange {
  ConsentRequested
  ConsentGranted
  ConsentDeclined
  ConsentRevoked
}

pub type WatchlistChange {
  WatchlistCreated
  WatchlistUpdated
  WatchlistMembershipChanged
  WatchlistArchived
}

pub type OfferChange {
  OfferDraftCreated
  OfferDraftUpdated
  OfferIssued
  OfferSuperseded
  OfferWithdrawn
}

/// What a signing act did, with the ids the registry's payload adds after the package's.
pub type SigningChange {
  SigningCreated(offer_id: String)
  SigningReady(revision_id: String)
  SigningPartyCompleted(revision_id: String, party_type: String)
  SigningCompleted(signing_id: String)
  SigningCancelled
  SigningVoided
  SigningSuperseded(revision_id: String, supersedes: String)
}

pub type DecisionChange {
  DecisionFinalized
  DecisionSuperseded
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
    SigningChanged(change:, ..) ->
      case change {
        SigningCreated(..) -> "signing_created"
        SigningReady(..) -> "signing_ready"
        SigningPartyCompleted(..) -> "signing_party_completed"
        SigningCompleted(..) -> "signing_completed"
        SigningCancelled -> "signing_cancelled"
        SigningVoided -> "signing_voided"
        SigningSuperseded(..) -> "signing_superseded"
      }
    AssessmentSubmitted(..) -> "assessment_submitted"
    Feedback(..) -> "feedback"
    Applications(..) -> "applications"
    WatchlistChanged(change:, ..) ->
      case change {
        WatchlistCreated -> "watchlist_created"
        WatchlistUpdated -> "watchlist_updated"
        WatchlistMembershipChanged -> "watchlist_membership_changed"
        WatchlistArchived -> "watchlist_archived"
      }
    MatchingRoomCreated(..) -> "matching_room_created"
    RecruitmentCaseMoved(..) -> "recruitment_case_moved"
    RecruitmentRoomArchived(..) -> "recruitment_room_archived"
    RoomReopenedFromSecondLook(..) ->
      "recruitment_room_reopened_from_second_look"
    RoomDecisionChanged(change:, ..) ->
      case change {
        DecisionFinalized -> "room_decision_finalized"
        DecisionSuperseded -> "room_decision_superseded"
      }
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
    TransactionHandoffWithdrawn(..) -> "transaction_handoff_withdrawn"
    AgentOpportunityShared(..) -> "agent_opportunity_shared"
    ConflictEvaluated(..) -> "conflict_evaluated"
    AgentTransactionCreated(..) -> "agent_transaction_created"
    AgentTransactionComplianceUpdated(..) ->
      "agent_transaction_compliance_updated"
    AgentTransactionStatusChanged(..) -> "agent_transaction_status_changed"
    AgentTransactionPartyChanged(..) -> "agent_transaction_party_changed"
    AgentTransactionDocumentAdded(..) -> "agent_transaction_document_added"
    AgentTransactionMessageLinked(..) -> "agent_transaction_message_linked"
    AgentTransactionHeld(..) -> "agent_transaction_held"
    AgentTransactionCancelled(..) -> "agent_transaction_cancelled"
    AgentTransactionClosed(..) -> "agent_transaction_closed"
    RegulatoryReviewStarted(..) -> "regulatory_review_started"
    RegulatoryReviewResolved(..) -> "regulatory_review_resolved"
    AgentAuthorisationStateChanged(..) -> "agent_authorisation_state_changed"
    RegulatoryConsentChanged(change:, ..) ->
      case change {
        ConsentRequested -> "regulatory_consent_requested"
        ConsentGranted -> "regulatory_consent_granted"
        ConsentDeclined -> "regulatory_consent_declined"
        ConsentRevoked -> "regulatory_consent_revoked"
      }
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
    | SigningChanged(org_id:, ..)
    | AssessmentSubmitted(org_id:, ..)
    | WatchlistChanged(org_id:, ..)
    | MatchingRoomCreated(org_id:, ..)
    | RecruitmentCaseMoved(org_id:, ..)
    | RecruitmentRoomArchived(org_id:, ..)
    | RoomReopenedFromSecondLook(org_id:, ..)
    | RoomDecisionChanged(org_id:, ..)
    | TrialInvited(org_id:, ..)
    | TrialAccepted(org_id:, ..)
    | TrialDeclined(org_id:, ..)
    | TrialChanged(org_id:, ..)
    | TrialSessionChanged(org_id:, ..)
    | TransactionHandoffInvited(org_id:, ..)
    | TransactionHandoffWithdrawn(org_id:, ..)
    | AgentOpportunityShared(org_id:, ..)
    | ConflictEvaluated(org_id:, ..)
    | AgentTransactionCreated(org_id:, ..)
    | AgentTransactionComplianceUpdated(org_id:, ..)
    | AgentTransactionStatusChanged(org_id:, ..)
    | AgentTransactionPartyChanged(org_id:, ..)
    | AgentTransactionDocumentAdded(org_id:, ..)
    | AgentTransactionMessageLinked(org_id:, ..)
    | AgentTransactionHeld(org_id:, ..)
    | AgentTransactionCancelled(org_id:, ..)
    | AgentTransactionClosed(org_id:, ..)
    | RegulatoryReviewStarted(org_id:, ..)
    | RegulatoryReviewResolved(org_id:, ..)
    | AgentAuthorisationStateChanged(org_id:, ..)
    | RegulatoryConsentChanged(org_id:, ..) -> Ok(org_id)
    Messages(..) | Typing(..) | Notify(..) | Feedback(..) | Applications(..) ->
      Error(Nil)
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
    SigningChanged(change:, org_id:, room_id:, package_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("signingPackageId", json.string(package_id)),
      ..case change {
        SigningCreated(offer_id:) -> [#("offerId", json.string(offer_id))]
        SigningReady(revision_id:) -> [
          #("revisionId", json.string(revision_id)),
        ]
        SigningPartyCompleted(revision_id:, party_type:) -> [
          #("revisionId", json.string(revision_id)),
          #("partyType", json.string(party_type)),
        ]
        SigningCompleted(signing_id:) -> [
          #("signingId", json.string(signing_id)),
        ]
        SigningCancelled | SigningVoided -> []
        SigningSuperseded(revision_id:, supersedes:) -> [
          #("revisionId", json.string(revision_id)),
          #("supersedes", json.string(supersedes)),
        ]
      }
    ]
    OfferResponded(org_id:, room_id:, offer_id:, status:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("offerId", json.string(offer_id)),
      #("status", json.nullable(status, json.string)),
    ]
    AssessmentSubmitted(org_id:, assessment_id:) -> [
      #("orgId", json.string(org_id)),
      #("assessmentId", json.string(assessment_id)),
    ]
    Feedback(player_id:) -> [#("playerId", json.string(player_id))]
    Applications(player_id:) -> [#("playerId", json.string(player_id))]
    WatchlistChanged(org_id:, watchlist_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("watchlistId", json.string(watchlist_id)),
    ]
    MatchingRoomCreated(org_id:, room_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
    ]
    RecruitmentCaseMoved(org_id:, room_id:, from:, to:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("from", json.string(from)),
      #("to", json.string(to)),
    ]
    RecruitmentRoomArchived(org_id:, room_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
    ]
    RoomReopenedFromSecondLook(org_id:, room_id:, item_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("itemId", json.string(item_id)),
    ]
    RoomDecisionChanged(org_id:, room_id:, decision_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("decisionId", json.string(decision_id)),
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
    TransactionHandoffInvited(org_id:, room_id:, handoff_id:)
    | TransactionHandoffWithdrawn(org_id:, room_id:, handoff_id:) -> [
      #("orgId", json.string(org_id)),
      #("roomId", json.string(room_id)),
      #("handoffId", json.string(handoff_id)),
    ]
    AgentOpportunityShared(org_id:, agreement_id:, agent_user_id:) -> [
      #("orgId", json.string(org_id)),
      #("agreementId", json.string(agreement_id)),
      #("agentUserId", json.string(agent_user_id)),
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
    AgentTransactionStatusChanged(org_id:, tx_id:, status:)
    | AgentTransactionHeld(org_id:, tx_id:, status:)
    | AgentTransactionCancelled(org_id:, tx_id:, status:)
    | AgentTransactionClosed(org_id:, tx_id:, status:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
      #("status", json.string(status)),
    ]
    AgentTransactionPartyChanged(org_id:, tx_id:, party_role:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
      #("partyRole", json.string(party_role)),
    ]
    AgentTransactionDocumentAdded(org_id:, tx_id:, doc_id:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
      #("docId", json.string(doc_id)),
    ]
    AgentTransactionMessageLinked(org_id:, tx_id:) -> [
      #("orgId", json.string(org_id)),
      #("txId", json.string(tx_id)),
    ]
    RegulatoryReviewStarted(org_id:, review_id:) -> [
      #("orgId", json.string(org_id)),
      #("reviewId", json.string(review_id)),
    ]
    AgentAuthorisationStateChanged(org_id:, user_id:, state:) -> [
      #("orgId", json.string(org_id)),
      #("userId", json.string(user_id)),
      #("state", json.string(state)),
    ]
    RegulatoryReviewResolved(org_id:, review_id:, outcome:) -> [
      #("orgId", json.string(org_id)),
      #("reviewId", json.string(review_id)),
      #("outcome", json.string(outcome)),
    ]
    RegulatoryConsentChanged(org_id:, consent_id:, ctx_id:, ..) -> [
      #("orgId", json.string(org_id)),
      #("consentId", json.string(consent_id)),
      #("ctxId", json.string(ctx_id)),
    ]
  }
}

/// Whether a reconnect replays it (the registry's `replayPolicy`).
pub fn replays(event: Event) -> Bool {
  case event {
    Messages(..)
    | Notify(..)
    | OfferResponded(..)
    | AssessmentSubmitted(..)
    | Feedback(..)
    | Applications(..)
    | WatchlistChanged(..)
    | MatchingRoomCreated(..)
    | RecruitmentCaseMoved(..)
    | RecruitmentRoomArchived(..)
    | RoomReopenedFromSecondLook(..)
    | SigningChanged(..) -> True
    OfferChanged(change:, ..) -> change != OfferDraftUpdated
    _ -> False
  }
}
