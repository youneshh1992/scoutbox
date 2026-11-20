//// Per-process limits, as the TypeScript server keeps them:
////
//// - every `/auth` request, per client address: 40 a minute;
//// - wrong sign-in guesses, per identifier tried: 20 in 15 minutes. A success costs nothing, and the budget is
////   tested before the credential, so a correct guess after it is spent is refused;
//// - wrong second-factor codes, per staff member: five lock the account's code checks for five minutes;
//// - the acts RATE_LIMIT_POLICY bounds per owner (`Action`), each in its own window.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/table.{type Table}
import scoutbox/rows/id

type Window {
  Window(count: Int, started: Int)
}

type Codes {
  Codes(fails: Int, locked_until: Int)
}

pub opaque type Limits {
  Limits(
    auth: Table(Window),
    login: Table(Window),
    mfa: Table(Codes),
    acts: Table(Window),
  )
}

/// A budget: at most `max` in any `window_ms`.
pub type Policy {
  Policy(max: Int, window_ms: Int)
}

/// The `/auth` limiter. The TypeScript server sets it in identity/sessions.mjs, not in RATE_LIMIT_POLICY.
const auth_policy = Policy(max: 40, window_ms: 60_000)

/// The budgets that are entries of RATE_LIMIT_POLICY (domains/platform/rateLimit.mjs), by action.
/// `test/scoutbox/spec_test.gleam` proves each equals its entry in e2e/support/spec/platform/rateLimit.json.
pub const policy = [
  #("login_failure", login_policy),
  #("email_challenge_request", email_challenge_request_policy),
  #("email_challenge_confirm", email_challenge_confirm_policy),
  #("pairing_code_mint", pairing_code_mint_policy),
  #("pairing_attempt", pairing_attempt_policy),
  #("room_create", room_create_policy),
  #("room_comment", room_comment_policy),
  #("room_combine_request", room_combine_request_policy),
  #("decision_draft", decision_draft_policy),
  #("decision_finalize", decision_finalize_policy),
  #("offer_draft_write", offer_draft_write_policy),
  #("offer_issue", offer_issue_policy),
  #("offer_withdraw", offer_withdraw_policy),
  #("offer_response", offer_response_policy),
  #("signing_start", signing_start_policy),
  #("signing_document_write", signing_document_write_policy),
  #("signing_party_completion", signing_party_completion_policy),
  #("signing_closure", signing_closure_policy),
  #("signing_safety_closure", signing_safety_closure_policy),
  #("trial_invite", trial_invite_policy),
  #("trial_schedule", trial_schedule_policy),
  #("trial_response", trial_response_policy),
  #("trial_evidence_link", trial_evidence_link_policy),
  #("trial_attendance", trial_attendance_policy),
  #("agent_representation_request", agent_representation_request_policy),
  #("agent_player_lookup", agent_player_lookup_policy),
  #("agent_profile_write", agent_profile_write_policy),
  #("agent_affiliation_write", agent_affiliation_write_policy),
  #("agent_client_response", agent_client_response_policy),
  #("transaction_handoff", transaction_handoff_policy),
  #("opportunity_share", opportunity_share_policy),
  #("transaction_write", transaction_write_policy),
  #("transaction_note_write", transaction_note_write_policy),
  #("transaction_status_write", transaction_write_policy),
  #("transaction_document_write", transaction_note_write_policy),
  #("compliance_context_write", context_write_policy),
  #("compliance_consent_request", consent_request_policy),
  #("compliance_consent_response", consent_request_policy),
  #("ts_review_decision", review_decision_policy),
  #("ts_policy_publish", policy_publish_policy),
  #("analytics_read", analytics_read_policy),
  #("brief_write", brief_write_policy),
  #("matching_query", matching_query_policy),
  #("watchlist_write", watchlist_write_policy),
  #("second_look_action", second_look_action_policy),
  #("nobody_missed_action", nobody_missed_action_policy),
  #("passport_share_read", passport_share_read_policy),
  #("box_session_create", box_session_create_policy),
  #("box_cv_session_create", box_cv_session_create_policy),
  #("box_cv_frames", box_cv_frames_policy),
  #("box_cv_finalize", box_cv_finalize_policy),
  #("box_cv_ready_check", box_cv_ready_check_policy),
  #("combine_attempt", combine_attempt_policy),
  #("development_plan_write", development_plan_write_policy),
  #("development_item_write", development_item_write_policy),
  #("development_review_write", development_review_write_policy),
]

/// An act bounded per owner. Its budget is its entry in `policy`.
pub type Action {
  /// Club e-mail-domain verification codes requested, per organisation (each one sends a mail).
  EmailChallengeRequest
  /// Wrong club e-mail verification codes presented, per organisation. A correct code costs nothing.
  EmailChallengeConfirm
  /// Child pairing codes minted, per guardian.
  PairingCodeMint
  /// Wrong child pairing codes presented, per client address (the route is unauthenticated). A correct code costs
  /// nothing.
  PairingAttempt
  /// New Recruitment Rooms, per organisation.
  RoomCreate
  /// Room discussion messages, per room and staff member.
  RoomComment
  /// Combine requests raised from a Room, per organisation.
  RoomCombineRequest
  /// Formal decision drafts opened or edited, per organisation.
  DecisionDraft
  /// Formal decisions finalized or superseded, per organisation.
  DecisionFinalize
  /// Offer drafts created, edited or revised, per organisation.
  OfferDraftWrite
  /// Offers issued, per organisation.
  OfferIssue
  /// Offers withdrawn, per organisation.
  OfferWithdraw
  /// Offer acceptances and declines, per player or guardian answering.
  OfferResponse
  /// Signing packages opened over accepted Offers, per organisation.
  SigningStart
  /// Signing documents attached, drafts edited, packages presented or superseded, per organisation.
  SigningDocumentWrite
  /// A party confirming the exact signing document, per actor (the player, or the club signatory).
  SigningPartyCompletion
  /// Signings completed, per organisation.
  SigningClosure
  /// Signings cancelled or voided by the club, per organisation: its own budget, so completion traffic cannot
  /// exhaust a safety closure.
  SigningSafetyClosure
  /// Contact drafts created or edited, per organisation.
  ContactDraft
  /// Contacts sent to players and guardians, per organisation.
  ContactSend
  /// External contacts recorded, per organisation.
  ContactExternalRecord
  /// Production CV finalizations, per player: only bounds a retry loop.
  BoxCvFinalize
  /// Production CV provider sessions begun, per player.
  BoxCvSessionCreate
  /// Production CV frame batches, per player.
  BoxCvFrames
  /// Box Cam CV Ready Check runs, per player.
  BoxCvReadyCheck
  /// Box Cam capture sessions minted, per player.
  BoxSessionCreate
  /// At-Home Combine attempts started, per player.
  CombineAttempt
  DevelopmentPlanWrite
  DevelopmentItemWrite
  DevelopmentReviewWrite
  /// Box Cam disputes filed, per player. The TypeScript server keeps this window in training.mjs (five a day), not
  /// as its RATE_LIMIT_POLICY entry.
  BoxDispute
  /// Public Passport share link reads, per client address: enumeration is refused long before the keyspace matters.
  PassportShareRead
  /// Trial invitations, per organisation.
  TrialInvite
  /// Recruitment analytics reads (the dashboard and its drill-down rows), per organisation.
  AnalyticsRead
  /// Recruitment Brief creates and edits, per organisation.
  BriefWrite
  /// Explainable Matching queries, per organisation.
  MatchingQuery
  /// Dynamic Watchlist creates and edits, per organisation.
  WatchlistWrite
  /// Second Look reviews, dismissals and reopens, per organisation.
  SecondLookAction
  /// Nobody Missed reviews, dismissals and add-to-room, per organisation.
  NobodyMissedAction
  /// Trial schedules proposed, revised or cancelled, per organisation.
  TrialSchedule
  /// Trial schedule confirmations, declines and cancellations, per player or guardian answering.
  TrialResponse
  /// Box Cam sessions linked to a Trial, per organisation.
  TrialEvidenceLink
  /// Trial attendance and completion records, per organisation.
  TrialAttendance
  /// Representation requests that reach a player lookup, per agent.
  AgentRepresentationRequest
  /// Player lookups from the Agent workspace, per agent.
  AgentPlayerLookup
  /// Agent profile edits and verification submissions, per agent.
  AgentProfileWrite
  /// Agency team and settings changes, per agency.
  AgentAffiliationWrite
  /// Relationship confirmations, declines, terminations and disputes, per player.
  AgentClientResponse
  /// Transaction-workspace invitations a club issues from a case, and their withdrawals, per organisation.
  TransactionHandoff
  /// Opportunities an agent shares with clients, and shares withdrawn, per agent.
  OpportunityShare
  /// Transactions opened and changed by a licensed agent, per agent.
  TransactionWrite
  /// Transaction notes, per writer.
  TransactionNoteWrite
  /// Transaction status moves and party confirmations, per actor.
  TransactionStatusWrite
  /// Transaction document metadata, per writer.
  TransactionDocumentWrite
  /// Context creation, party additions and representation declarations by an agent.
  ComplianceContextWrite
  /// Consent requests by an agent.
  ComplianceConsentRequest
  /// Consent answers by a party.
  ComplianceConsentResponse
  /// Review decisions by a named reviewer.
  TsReviewDecision
  /// Policy version proposals by a Trust & Safety administrator.
  TsPolicyPublish
}

const email_challenge_request_policy = Policy(max: 5, window_ms: 3_600_000)

const email_challenge_confirm_policy = Policy(max: 20, window_ms: 900_000)

const pairing_code_mint_policy = Policy(max: 20, window_ms: 3_600_000)

const pairing_attempt_policy = Policy(max: 20, window_ms: 900_000)

const room_create_policy = Policy(max: 60, window_ms: 3_600_000)

const room_comment_policy = Policy(max: 20, window_ms: 60_000)

const room_combine_request_policy = Policy(max: 60, window_ms: 3_600_000)

const decision_draft_policy = Policy(max: 60, window_ms: 3_600_000)

const decision_finalize_policy = Policy(max: 30, window_ms: 3_600_000)

const offer_draft_write_policy = Policy(max: 120, window_ms: 3_600_000)

const offer_issue_policy = Policy(max: 30, window_ms: 3_600_000)

const offer_withdraw_policy = Policy(max: 30, window_ms: 3_600_000)

const offer_response_policy = Policy(max: 30, window_ms: 3_600_000)

const signing_start_policy = Policy(max: 30, window_ms: 3_600_000)

const signing_document_write_policy = Policy(max: 120, window_ms: 3_600_000)

const signing_party_completion_policy = Policy(max: 30, window_ms: 3_600_000)

const signing_closure_policy = Policy(max: 30, window_ms: 3_600_000)

const signing_safety_closure_policy = Policy(max: 60, window_ms: 3_600_000)

const contact_draft_policy = Policy(max: 60, window_ms: 3_600_000)

const contact_send_policy = Policy(max: 30, window_ms: 3_600_000)

const contact_external_record_policy = Policy(max: 60, window_ms: 3_600_000)

const box_cv_finalize_policy = Policy(max: 80, window_ms: 3_600_000)

const box_cv_session_create_policy = Policy(max: 40, window_ms: 3_600_000)

const box_cv_frames_policy = Policy(max: 600, window_ms: 3_600_000)

const box_cv_ready_check_policy = Policy(max: 120, window_ms: 3_600_000)

const box_session_create_policy = Policy(max: 30, window_ms: 3_600_000)

const combine_attempt_policy = Policy(max: 40, window_ms: 3_600_000)

const development_plan_write_policy = Policy(max: 120, window_ms: 3_600_000)

const development_item_write_policy = Policy(max: 600, window_ms: 3_600_000)

const development_review_write_policy = Policy(max: 60, window_ms: 3_600_000)

const box_dispute_policy = Policy(max: 5, window_ms: 86_400_000)

const passport_share_read_policy = Policy(max: 30, window_ms: 60_000)

const trial_invite_policy = Policy(max: 30, window_ms: 3_600_000)

const analytics_read_policy = Policy(max: 600, window_ms: 3_600_000)

const brief_write_policy = Policy(max: 60, window_ms: 3_600_000)

const matching_query_policy = Policy(max: 240, window_ms: 3_600_000)

const watchlist_write_policy = Policy(max: 120, window_ms: 3_600_000)

const second_look_action_policy = Policy(max: 200, window_ms: 3_600_000)

const nobody_missed_action_policy = Policy(max: 200, window_ms: 3_600_000)

const trial_schedule_policy = Policy(max: 60, window_ms: 3_600_000)

const trial_response_policy = Policy(max: 30, window_ms: 3_600_000)

const trial_evidence_link_policy = Policy(max: 60, window_ms: 3_600_000)

const trial_attendance_policy = Policy(max: 120, window_ms: 3_600_000)

const agent_representation_request_policy =
  Policy(max: 40, window_ms: 86_400_000)

const agent_player_lookup_policy = Policy(max: 120, window_ms: 3_600_000)

const agent_profile_write_policy = Policy(max: 60, window_ms: 3_600_000)

const agent_affiliation_write_policy = Policy(max: 60, window_ms: 3_600_000)

const agent_client_response_policy = Policy(max: 30, window_ms: 3_600_000)

const transaction_handoff_policy = Policy(max: 30, window_ms: 3_600_000)

const opportunity_share_policy = Policy(max: 60, window_ms: 3_600_000)

const transaction_write_policy = Policy(max: 60, window_ms: 3_600_000)

const transaction_note_write_policy = Policy(max: 120, window_ms: 3_600_000)

const context_write_policy = Policy(max: 60, window_ms: 3_600_000)

const consent_request_policy = Policy(max: 30, window_ms: 3_600_000)

const review_decision_policy = Policy(max: 120, window_ms: 3_600_000)

const policy_publish_policy = Policy(max: 10, window_ms: 86_400_000)

pub fn action_name(action: Action) -> String {
  case action {
    EmailChallengeRequest -> "email_challenge_request"
    EmailChallengeConfirm -> "email_challenge_confirm"
    PairingCodeMint -> "pairing_code_mint"
    PairingAttempt -> "pairing_attempt"
    RoomCreate -> "room_create"
    AnalyticsRead -> "analytics_read"
    BriefWrite -> "brief_write"
    MatchingQuery -> "matching_query"
    WatchlistWrite -> "watchlist_write"
    SecondLookAction -> "second_look_action"
    NobodyMissedAction -> "nobody_missed_action"
    RoomComment -> "room_comment"
    RoomCombineRequest -> "room_combine_request"
    DecisionDraft -> "decision_draft"
    DecisionFinalize -> "decision_finalize"
    OfferDraftWrite -> "offer_draft_write"
    OfferIssue -> "offer_issue"
    OfferWithdraw -> "offer_withdraw"
    OfferResponse -> "offer_response"
    SigningStart -> "signing_start"
    SigningDocumentWrite -> "signing_document_write"
    SigningPartyCompletion -> "signing_party_completion"
    SigningClosure -> "signing_closure"
    SigningSafetyClosure -> "signing_safety_closure"
    ContactDraft -> "contact_draft"
    ContactSend -> "contact_send"
    ContactExternalRecord -> "contact_external_record"
    BoxCvFinalize -> "box_cv_finalize"
    BoxCvSessionCreate -> "box_cv_session_create"
    BoxCvFrames -> "box_cv_frames"
    BoxCvReadyCheck -> "box_cv_ready_check"
    BoxSessionCreate -> "box_session_create"
    CombineAttempt -> "combine_attempt"
    DevelopmentPlanWrite -> "development_plan_write"
    DevelopmentItemWrite -> "development_item_write"
    DevelopmentReviewWrite -> "development_review_write"
    BoxDispute -> "box_dispute"
    PassportShareRead -> "passport_share_read"
    TrialInvite -> "trial_invite"
    TrialSchedule -> "trial_schedule"
    TrialResponse -> "trial_response"
    TrialEvidenceLink -> "trial_evidence_link"
    TrialAttendance -> "trial_attendance"
    AgentRepresentationRequest -> "agent_representation_request"
    AgentPlayerLookup -> "agent_player_lookup"
    AgentProfileWrite -> "agent_profile_write"
    AgentAffiliationWrite -> "agent_affiliation_write"
    AgentClientResponse -> "agent_client_response"
    TransactionHandoff -> "transaction_handoff"
    OpportunityShare -> "opportunity_share"
    TransactionWrite -> "transaction_write"
    TransactionNoteWrite -> "transaction_note_write"
    TransactionStatusWrite -> "transaction_status_write"
    TransactionDocumentWrite -> "transaction_document_write"
    ComplianceContextWrite -> "compliance_context_write"
    ComplianceConsentRequest -> "compliance_consent_request"
    ComplianceConsentResponse -> "compliance_consent_response"
    TsReviewDecision -> "ts_review_decision"
    TsPolicyPublish -> "ts_policy_publish"
  }
}

fn action_policy(action: Action) -> Policy {
  case action {
    EmailChallengeRequest -> email_challenge_request_policy
    EmailChallengeConfirm -> email_challenge_confirm_policy
    PairingCodeMint -> pairing_code_mint_policy
    PairingAttempt -> pairing_attempt_policy
    RoomCreate -> room_create_policy
    AnalyticsRead -> analytics_read_policy
    BriefWrite -> brief_write_policy
    MatchingQuery -> matching_query_policy
    WatchlistWrite -> watchlist_write_policy
    SecondLookAction -> second_look_action_policy
    NobodyMissedAction -> nobody_missed_action_policy
    RoomComment -> room_comment_policy
    RoomCombineRequest -> room_combine_request_policy
    DecisionDraft -> decision_draft_policy
    DecisionFinalize -> decision_finalize_policy
    OfferDraftWrite -> offer_draft_write_policy
    OfferIssue -> offer_issue_policy
    OfferWithdraw -> offer_withdraw_policy
    OfferResponse -> offer_response_policy
    SigningStart -> signing_start_policy
    SigningDocumentWrite -> signing_document_write_policy
    SigningPartyCompletion -> signing_party_completion_policy
    SigningClosure -> signing_closure_policy
    SigningSafetyClosure -> signing_safety_closure_policy
    ContactDraft -> contact_draft_policy
    ContactSend -> contact_send_policy
    ContactExternalRecord -> contact_external_record_policy
    BoxCvFinalize -> box_cv_finalize_policy
    BoxCvSessionCreate -> box_cv_session_create_policy
    BoxCvFrames -> box_cv_frames_policy
    BoxCvReadyCheck -> box_cv_ready_check_policy
    BoxSessionCreate -> box_session_create_policy
    CombineAttempt -> combine_attempt_policy
    DevelopmentPlanWrite -> development_plan_write_policy
    DevelopmentItemWrite -> development_item_write_policy
    DevelopmentReviewWrite -> development_review_write_policy
    BoxDispute -> box_dispute_policy
    PassportShareRead -> passport_share_read_policy
    TrialInvite -> trial_invite_policy
    TrialSchedule -> trial_schedule_policy
    TrialResponse -> trial_response_policy
    TrialEvidenceLink -> trial_evidence_link_policy
    TrialAttendance -> trial_attendance_policy
    AgentRepresentationRequest -> agent_representation_request_policy
    AgentPlayerLookup -> agent_player_lookup_policy
    AgentProfileWrite -> agent_profile_write_policy
    AgentAffiliationWrite -> agent_affiliation_write_policy
    AgentClientResponse -> agent_client_response_policy
    TransactionHandoff -> transaction_handoff_policy
    OpportunityShare -> opportunity_share_policy
    TransactionWrite -> transaction_write_policy
    TransactionNoteWrite -> transaction_note_write_policy
    TransactionStatusWrite -> transaction_write_policy
    TransactionDocumentWrite -> transaction_note_write_policy
    ComplianceContextWrite -> context_write_policy
    ComplianceConsentRequest -> consent_request_policy
    ComplianceConsentResponse -> consent_request_policy
    TsReviewDecision -> review_decision_policy
    TsPolicyPublish -> policy_publish_policy
  }
}

const login_policy = Policy(max: 20, window_ms: 900_000)

pub fn start() -> Result(Limits, String) {
  use auth <- result.try(table.start())
  use login <- result.try(table.start())
  use mfa <- result.try(table.start())
  use acts <- result.map(table.start())
  Limits(auth:, login:, mfa:, acts:)
}

fn current(window: option.Option(Window), now: Int, length: Int) -> Window {
  case window {
    Some(w) if now - w.started < length -> w
    _ -> Window(0, now)
  }
}

/// Counts an `/auth` request from `address`. Error(retry after, ms) when over the limit.
pub fn auth_request(
  limits: Limits,
  address: String,
  now: Int,
) -> Result(Nil, Int) {
  table.update(limits.auth, address, fn(entry) {
    let w = current(entry, now, auth_policy.window_ms)
    let w = Window(..w, count: w.count + 1)
    let answer = case w.count > auth_policy.max {
      True -> Error(auth_policy.window_ms - { now - w.started })
      False -> Ok(Nil)
    }
    #(Some(w), answer)
  })
}

/// Spends one of `owner`'s budget for `action`. True when it was already spent: the act is refused.
pub fn limited(
  limits: Limits,
  action: Action,
  owner: String,
  now: Int,
) -> Bool {
  let p = action_policy(action)
  table.update(limits.acts, action_name(action) <> ":" <> owner, fn(entry) {
    let w = current(entry, now, p.window_ms)
    let w = Window(..w, count: w.count + 1)
    #(Some(w), w.count > p.max)
  })
}

/// True when `owner`'s budget for `action` is already used up, without spending any of it (the TypeScript
/// limiter's `peek(…).remaining === 0`): for an act where only a failure is charged.
pub fn spent(limits: Limits, action: Action, owner: String, now: Int) -> Bool {
  let p = action_policy(action)
  table.update(limits.acts, action_name(action) <> ":" <> owner, fn(entry) {
    let w = current(entry, now, p.window_ms)
    #(entry, w.count >= p.max)
  })
}

/// The 429 body for an act over its budget (rateLimitedBody).
/// The live buckets of the acts' budgets, as `GET /__rate-limits` lists them: the action, whose budget it is, and
/// how much of it is spent.
pub fn snapshot(limits: Limits) -> List(#(String, String, Int)) {
  table.entries(limits.acts)
  |> list.map(fn(e) {
    let #(key, w) = e
    case string.split_once(key, ":") {
      Ok(#(action, owner)) -> #(action, owner, w.count)
      Error(Nil) -> #(key, "", w.count)
    }
  })
  |> list.sort(fn(a, b) { string.compare(a.0 <> ":" <> a.1, b.0 <> ":" <> b.1) })
}

/// The 429 body for an act over its budget, as JSON.
pub fn limited_json(action: Action) -> json.Json {
  json.object(
    list.map(limited_body(action), fn(kv) { #(kv.0, json.string(kv.1)) }),
  )
}

pub fn limited_body(action: Action) -> List(#(String, String)) {
  [
    #("error", "RATE_LIMITED"),
    #("action", action_name(action)),
    #(
      "message",
      "Too many requests in a short window — wait a moment and try again.",
    ),
  ]
}

/// The key a sign-in identifier is budgeted under.
pub fn login_key(identifier: String) -> String {
  case identifier |> string.trim |> string.lowercase {
    "" -> "unknown"
    key -> key
  }
}

/// True when the identifier's wrong-guess budget is spent: as the TypeScript limiter's `peek`, once more than `max`
/// wrong guesses are in the window, so the guess that spends the last of it is still answered.
pub fn login_locked(limits: Limits, identifier: String, now: Int) -> Bool {
  table.update(limits.login, login_key(identifier), fn(entry) {
    let w = current(entry, now, login_policy.window_ms)
    #(entry, w.count > login_policy.max)
  })
}

pub fn login_failed(limits: Limits, identifier: String, now: Int) -> Nil {
  table.update(limits.login, login_key(identifier), fn(entry) {
    let w = current(entry, now, login_policy.window_ms)
    #(Some(Window(..w, count: w.count + 1)), Nil)
  })
}

pub fn mfa_locked(limits: Limits, user_id: id.OrgUserId, now: Int) -> Bool {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(entry) {
    #(entry, case entry {
      Some(c) -> c.locked_until > now
      None -> False
    })
  })
}

pub fn mfa_failed(limits: Limits, user_id: id.OrgUserId, now: Int) -> Nil {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(entry) {
    let c = option.unwrap(entry, Codes(0, 0))
    let fails = c.fails + 1
    let c = case fails >= 5 {
      True -> Codes(fails: 0, locked_until: now + 300_000)
      False -> Codes(..c, fails:)
    }
    #(Some(c), Nil)
  })
}

pub fn mfa_clear(limits: Limits, user_id: id.OrgUserId) -> Nil {
  table.update(limits.mfa, id.org_user_to_string(user_id), fn(_) {
    #(None, Nil)
  })
}
