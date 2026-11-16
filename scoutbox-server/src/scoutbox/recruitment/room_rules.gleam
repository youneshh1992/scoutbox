//// The Recruitment Room's pure rules (domains/recruitment/rooms/shared.mjs): the status machine and its mapping
//// onto the case stages, the reason taxonomy, decisions, readiness and health, room roles and what each may do,
//// task states, the activity feed, the funnel, list rows, tags and page sizes.
////
//// A Room is a facet of a recruitment case, not a second pipeline: its status is the status, and the case's stage
//// is derived from it by `stage_for_room_status`. The generated tests in test/scoutbox/battery/recruitment/ prove
//// these against the TypeScript rules.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/string
import scoutbox/platform/input
import scoutbox/rows/case_history
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_cases.{type Stage} as case_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/vocab/room_status.{
  type RoomStatus, Archived, Closed, ContactPlanned, Contacted, OfferAccepted,
  OfferConsideration, OfferDeclined, OfferMade, OnHold, Priority, Shortlisted,
  Signed, TrialCompleted, TrialRequested, TrialScheduled, UnderReview, Watching,
  Withdrawn,
}
import scoutbox/vocab/source_context.{type SourceContext}
import scoutbox/vocab/task_state.{type TaskState}

// ------------------------------------------------------------------ statuses

/// Every status, in the TypeScript server's order.
pub fn statuses() -> List(RoomStatus) {
  list.map(room_status.pairs, fn(p) { p.1 })
}

pub fn status_label(status: RoomStatus) -> String {
  case status {
    Watching -> "Watching"
    UnderReview -> "Under review"
    ContactPlanned -> "Contact planned"
    Contacted -> "Contacted"
    Shortlisted -> "Shortlisted"
    Priority -> "Priority"
    TrialRequested -> "Trial requested"
    TrialScheduled -> "Trial scheduled"
    TrialCompleted -> "Trial completed"
    OfferConsideration -> "Offer consideration"
    OfferMade -> "Offer made"
    // Must not imply a playing contract, a registration or a completed transfer.
    OfferAccepted -> "Accepted in ScoutBox"
    OfferDeclined -> "Offer declined by player"
    Signed -> "Signed"
    OnHold -> "On hold"
    Withdrawn -> "Withdrawn"
    Archived -> "Archived"
    Closed -> "Closed"
  }
}

pub const terminal = [Signed, Withdrawn, Archived, Closed]

pub const initial = Watching

pub fn is_open(status: RoomStatus) -> Bool {
  !list.contains(terminal, status)
}

pub fn open_statuses() -> List(RoomStatus) {
  list.filter(statuses(), is_open)
}

/// Grassroots clubs run a shorter pipeline; every other organisation runs the professional one.
fn grassroots(level: orgs.Level) -> Bool {
  level == orgs.LevelGrassroots
}

pub fn stage_for_room_status(status: RoomStatus, level: orgs.Level) -> Stage {
  case grassroots(level), status {
    False, Watching -> case_row.Identified
    False, UnderReview | False, ContactPlanned | False, Contacted ->
      case_row.Review
    False, Shortlisted | False, Priority -> case_row.Observation
    False, TrialRequested | False, TrialScheduled | False, TrialCompleted ->
      case_row.Trial
    // A hold is live; resuming it means review.
    False, OnHold -> case_row.Review
    True, Watching
    | True, UnderReview
    | True, ContactPlanned
    | True, Shortlisted
    | True, Priority
    | True, OnHold
    -> case_row.Review
    True, Contacted | True, TrialCompleted -> case_row.AwaitingResponse
    True, TrialRequested | True, TrialScheduled -> case_row.Invited
    _, OfferConsideration
    | _, OfferMade
    | _, OfferAccepted
    | _, OfferDeclined
    -> case_row.Decision
    _, Signed | _, Withdrawn | _, Archived | _, Closed -> case_row.Closed
  }
}

/// The inverse of a lossy projection (`decision` covers four statuses), so it only chooses where a new Room
/// adopting a case starts, never moves an existing one.
pub fn room_status_for_stage(
  stage: Stage,
  level: orgs.Level,
) -> Option(RoomStatus) {
  let canonical = case stage {
    case_row.Identified -> Watching
    case_row.Review -> UnderReview
    case_row.Observation -> Shortlisted
    case_row.Trial | case_row.Invited -> TrialRequested
    case_row.AwaitingResponse -> TrialCompleted
    case_row.Decision -> OfferConsideration
    case_row.Closed -> Archived
  }
  case stage_for_room_status(canonical, level) == stage {
    True -> Some(canonical)
    False -> None
  }
}

// --------------------------------------------------------------- transitions

/// Where a room may move from each status. Anything not listed is refused.
pub fn transitions(from: RoomStatus) -> List(RoomStatus) {
  case from {
    Watching -> [
      UnderReview,
      Shortlisted,
      ContactPlanned,
      OnHold,
      Withdrawn,
      Archived,
    ]
    UnderReview -> [
      Watching,
      Shortlisted,
      Priority,
      ContactPlanned,
      TrialRequested,
      OnHold,
      Withdrawn,
      Archived,
    ]
    ContactPlanned -> [
      Contacted,
      UnderReview,
      Shortlisted,
      Priority,
      OnHold,
      Withdrawn,
      Archived,
    ]
    Contacted -> [
      Shortlisted,
      Priority,
      TrialRequested,
      OfferConsideration,
      UnderReview,
      OnHold,
      Withdrawn,
      Archived,
    ]
    Shortlisted -> [
      UnderReview,
      Priority,
      ContactPlanned,
      TrialRequested,
      OfferConsideration,
      OnHold,
      Withdrawn,
      Archived,
    ]
    Priority -> [
      Shortlisted,
      ContactPlanned,
      TrialRequested,
      OfferConsideration,
      OnHold,
      Withdrawn,
      Archived,
    ]
    TrialRequested -> [
      TrialScheduled,
      Shortlisted,
      Priority,
      OnHold,
      Withdrawn,
      Archived,
    ]
    TrialScheduled -> [
      TrialCompleted,
      TrialRequested,
      OnHold,
      Withdrawn,
      Archived,
    ]
    TrialCompleted -> [
      OfferConsideration,
      Shortlisted,
      Priority,
      OnHold,
      Withdrawn,
      Archived,
    ]
    OfferConsideration -> [
      OfferMade,
      Shortlisted,
      Priority,
      OnHold,
      Withdrawn,
      Archived,
    ]
    // `offer_made → signed` stays for a signing concluded outside ScoutBox; `signed` needs confirmed joining
    // evidence either way.
    OfferMade -> [
      OfferAccepted,
      OfferDeclined,
      Signed,
      OfferConsideration,
      OnHold,
      Withdrawn,
      Archived,
    ]
    OfferAccepted -> [Signed, OnHold, Withdrawn, Archived, Closed]
    OfferDeclined -> [
      UnderReview,
      Shortlisted,
      Priority,
      OnHold,
      Withdrawn,
      Archived,
      Closed,
    ]
    Signed -> [Closed]
    // The lifecycle's resume is the only way back to the held-from state, so this row names none of the states a
    // recipient's answer reaches.
    OnHold -> [
      UnderReview,
      Shortlisted,
      Priority,
      ContactPlanned,
      TrialRequested,
      OfferConsideration,
      Withdrawn,
      Archived,
      Closed,
    ]
    Withdrawn -> [UnderReview, Archived, Closed]
    Archived -> [UnderReview, Closed]
    Closed -> [UnderReview]
  }
}

pub fn can_transition(from: RoomStatus, to: RoomStatus) -> Bool {
  list.contains(transitions(from), to)
}

/// What must actually have happened before a room may reach a status (STATUS_EVIDENCE_REQUIRED).
pub type Evidence {
  ContactDelivered
  TrialInvited
  TrialConfirmed
  TrialCompletedEvidence
  DecisionProgress
  OfferSent
  OfferAcceptedByRecipient
  OfferDeclinedByRecipient
  ConfirmedJoin
}

pub fn evidence_code(evidence: Evidence) -> String {
  case evidence {
    ContactDelivered -> "contact_delivered"
    TrialInvited -> "trial_invited"
    TrialConfirmed -> "trial_confirmed"
    TrialCompletedEvidence -> "trial_completed"
    DecisionProgress -> "decision_progress"
    OfferSent -> "offer_sent"
    OfferAcceptedByRecipient -> "offer_accepted_by_recipient"
    OfferDeclinedByRecipient -> "offer_declined_by_recipient"
    ConfirmedJoin -> "confirmed_join"
  }
}

pub fn evidence_required(to: RoomStatus) -> Option(Evidence) {
  case to {
    Contacted -> Some(ContactDelivered)
    TrialRequested -> Some(TrialInvited)
    TrialScheduled -> Some(TrialConfirmed)
    TrialCompleted -> Some(TrialCompletedEvidence)
    OfferConsideration -> Some(DecisionProgress)
    OfferMade -> Some(OfferSent)
    OfferAccepted -> Some(OfferAcceptedByRecipient)
    OfferDeclined -> Some(OfferDeclinedByRecipient)
    Signed -> Some(ConfirmedJoin)
    _ -> None
  }
}

/// Room creation runs no transition table or evidence gate, so an adopted stage that maps onto an
/// evidence-bearing status starts at `under_review` instead.
pub fn adoption_status_for_stage(
  stage: Stage,
  level: orgs.Level,
) -> RoomStatus {
  case room_status_for_stage(stage, level) {
    None -> Watching
    Some(mapped) ->
      case evidence_required(mapped) {
        Some(_) -> UnderReview
        None -> mapped
      }
  }
}

pub const reason_required = [Withdrawn, Archived, Closed]

pub const reopened_from = [Withdrawn, Archived, Closed]

/// The statuses at which the evidence confidence the club could see is snapshotted.
pub const snapshot_statuses = [
  Shortlisted,
  Priority,
  TrialRequested,
  OfferConsideration,
  OfferMade,
  Signed,
  Withdrawn,
  Archived,
  Closed,
]

pub type Transition {
  Transition(
    reopen: Bool,
    needs_reason: Bool,
    snapshot: Bool,
    requires_evidence: Option(Evidence),
  )
}

pub type TransitionRefusal {
  Unchanged(to: RoomStatus)
  Invalid(from: RoomStatus, to: RoomStatus)
  ReasonRequired(to: RoomStatus)
}

pub fn validate_transition(
  from: RoomStatus,
  to: RoomStatus,
  reason_codes: List(String),
) -> Result(Transition, TransitionRefusal) {
  let needs_reason = list.contains(reason_required, to)
  case from == to, can_transition(from, to), needs_reason, reason_codes {
    True, _, _, _ -> Error(Unchanged(to))
    _, False, _, _ -> Error(Invalid(from, to))
    _, _, True, [] -> Error(ReasonRequired(to))
    _, _, _, _ ->
      Ok(Transition(
        reopen: list.contains(reopened_from, from)
          && !list.contains(reopened_from, to),
        needs_reason:,
        snapshot: list.contains(snapshot_statuses, to),
        requires_evidence: evidence_required(to),
      ))
  }
}

/// A refused transition's code. `ROOM_TRANSITION_INVALID` is a conflict (409); the others are a bad request (400).
pub fn transition_refusal_code(refusal: TransitionRefusal) -> String {
  case refusal {
    Unchanged(_) -> "ROOM_STATUS_UNCHANGED"
    Invalid(..) -> "ROOM_TRANSITION_INVALID"
    ReasonRequired(_) -> "ROOM_REASON_REQUIRED"
  }
}

pub fn transition_refusal_fields(
  refusal: TransitionRefusal,
) -> List(#(String, Json)) {
  let head = [
    #("ok", json.bool(False)),
    #("error", json.string(transition_refusal_code(refusal))),
  ]
  case refusal {
    Unchanged(to) ->
      list.append(head, [
        #(
          "message",
          json.string("This room is already " <> status_label(to) <> "."),
        ),
      ])
    Invalid(from, to) ->
      list.append(head, [
        #(
          "message",
          json.string(
            "A room cannot move from "
            <> status_label(from)
            <> " to "
            <> status_label(to)
            <> ".",
          ),
        ),
        #("allowed", json.array(transitions(from), room_status.to_json)),
      ])
    ReasonRequired(to) ->
      list.append(head, [
        #(
          "message",
          json.string(
            "Recording why keeps the decision useful later — "
            <> status_label(to)
            <> " needs at least one reason.",
          ),
        ),
      ])
  }
}

pub fn transition_json(result: Result(Transition, TransitionRefusal)) -> Json {
  case result {
    Error(refusal) -> json.object(transition_refusal_fields(refusal))
    Ok(t) ->
      json.object([
        #("ok", json.bool(True)),
        #("reopen", json.bool(t.reopen)),
        #("needsReason", json.bool(t.needs_reason)),
        #("snapshot", json.bool(t.snapshot)),
        #(
          "requiresEvidence",
          json.nullable(
            option.map(t.requires_evidence, evidence_code),
            json.string,
          ),
        ),
      ])
  }
}

// ------------------------------------------------------------ reason taxonomy

/// The taxonomy's categories, in order, each with its codes. Only the code is machine-readable, so later analysis
/// never has to read anybody's free text.
pub const reason_codes = [
  #("football", [
    "technical_fit", "tactical_fit", "physical_profile", "position_need",
    "development_upside",
  ]),
  #("evidence", [
    "insufficient_full_match", "insufficient_recent_evidence",
    "reference_missing", "combine_missing",
  ]),
  #("process", [
    "budget", "squad_space", "timing", "registration", "travel_logistics",
    "eligibility",
  ]),
  #("outcome", [
    "trial_needed", "continue_monitoring", "not_current_priority",
    "trial_outcome", "player_unavailable",
  ]),
]

pub fn all_reason_codes() -> List(String) {
  list.flat_map(reason_codes, fn(c) { c.1 })
}

/// Refused with their own code, so an audit cannot mistake the refusal for a typo. A club may still decline a
/// player; it may not record a protected trait as the reason.
pub const prohibited_reason_codes = [
  "race", "ethnicity", "skin_colour", "skin_color", "nationality",
  "nationality_preference", "national_origin", "immigration_status", "religion",
  "faith", "caste", "disability", "medical_condition", "mental_health", "gender",
  "sex", "sexuality", "sexual_orientation", "gender_identity", "socioeconomic",
  "social_background", "family_income", "postcode", "accent", "pregnancy",
  "marital_status", "political_opinion", "union_membership",
]

/// Evidence-shaped reasons: an archived room may be worth a second look when the missing evidence arrives.
pub fn revisitable_reason_codes() -> List(String) {
  let assert Ok(evidence) = list.key_find(reason_codes, "evidence")
  list.append(evidence, ["trial_needed", "continue_monitoring"])
}

pub type ReasonRefusal {
  TooManyReasons
  ProhibitedReasons(codes: List(String))
  UnknownReasons(codes: List(String))
}

/// Cleans the codes (trimmed, lowercased, deduplicated, blanks dropped) and judges them against the taxonomy.
pub fn validate_reason_codes(
  codes: List(String),
) -> Result(List(String), ReasonRefusal) {
  let clean =
    codes
    |> list.map(fn(c) { c |> string.trim |> string.lowercase })
    |> list.filter(fn(c) { c != "" })
    |> list.unique
  let prohibited = list.filter(clean, list.contains(prohibited_reason_codes, _))
  let known = all_reason_codes()
  let unknown = list.filter(clean, fn(c) { !list.contains(known, c) })
  case list.length(clean) > 6, prohibited, unknown {
    True, _, _ -> Error(TooManyReasons)
    _, [_, ..], _ -> Error(ProhibitedReasons(prohibited))
    _, _, [_, ..] -> Error(UnknownReasons(unknown))
    _, _, _ -> Ok(clean)
  }
}

pub fn reason_refusal_fields(refusal: ReasonRefusal) -> List(#(String, Json)) {
  case refusal {
    TooManyReasons -> [
      #("ok", json.bool(False)),
      #("error", json.string("ROOM_REASONS_TOO_MANY")),
      #("message", json.string("Record up to six reasons.")),
    ]
    ProhibitedReasons(codes) -> [
      #("ok", json.bool(False)),
      #("error", json.string("ROOM_REASON_PROHIBITED")),
      #(
        "message",
        json.string(
          "A protected characteristic can never be recorded as a recruitment reason.",
        ),
      ),
      #("prohibited", json.array(codes, json.string)),
    ]
    UnknownReasons(codes) -> [
      #("ok", json.bool(False)),
      #("error", json.string("ROOM_REASON_UNKNOWN")),
      #(
        "message",
        json.string(
          "Reasons must come from the ScoutBox recruitment reason taxonomy.",
        ),
      ),
      #("unknown", json.array(codes, json.string)),
    ]
  }
}

pub fn reasons_json(result: Result(List(String), ReasonRefusal)) -> Json {
  case result {
    Ok(codes) ->
      json.object([
        #("ok", json.bool(True)),
        #("codes", json.array(codes, json.string)),
      ])
    Error(refusal) -> json.object(reason_refusal_fields(refusal))
  }
}

// ----------------------------------------------------------- recommendations

pub type Recommendation =
  decision_row.Recommendation

pub fn recommendations() -> List(Recommendation) {
  list.map(decision_row.recommendation_pairs, fn(p) { p.1 })
}

pub const note_max = 2000

pub type Decision {
  Decision(
    recommendation: Recommendation,
    codes: List(String),
    note: Option(String),
  )
}

pub type DecisionRefusal {
  DecisionReasons(ReasonRefusal)
  ArchiveNeedsReason
  NoteTooLong
}

pub fn validate_decision(
  recommendation: Recommendation,
  reason_codes: List(String),
  note: Option(String),
) -> Result(Decision, DecisionRefusal) {
  case validate_reason_codes(reason_codes) {
    Error(r) -> Error(DecisionReasons(r))
    Ok([]) if recommendation == decision_row.Archive -> Error(ArchiveNeedsReason)
    Ok(codes) ->
      case note {
        Some(n) ->
          case input.utf16_length(n) > note_max {
            True -> Error(NoteTooLong)
            False -> Ok(Decision(recommendation, codes, note))
          }
        None -> Ok(Decision(recommendation, codes, None))
      }
  }
}

pub fn decision_refusal_fields(
  refusal: DecisionRefusal,
) -> List(#(String, Json)) {
  case refusal {
    DecisionReasons(r) -> reason_refusal_fields(r)
    ArchiveNeedsReason -> [
      #("ok", json.bool(False)),
      #("error", json.string("ROOM_REASON_REQUIRED")),
      #(
        "message",
        json.string(
          "Archiving needs at least one reason so the decision stays useful later.",
        ),
      ),
    ]
    NoteTooLong -> [
      #("ok", json.bool(False)),
      #("error", json.string("ROOM_NOTE_TOO_LONG")),
      #("message", json.string("Keep the internal note under 2000 characters.")),
    ]
  }
}

pub fn decision_json(result: Result(Decision, DecisionRefusal)) -> Json {
  case result {
    Error(refusal) -> json.object(decision_refusal_fields(refusal))
    Ok(d) ->
      json.object([
        #("ok", json.bool(True)),
        #(
          "recommendation",
          decision_row.recommendation_to_json(d.recommendation),
        ),
        #("codes", json.array(d.codes, json.string)),
        #("note", json.nullable(d.note, json.string)),
      ])
  }
}

// ----------------------------------------------------------------- readiness

pub type TrialState {
  NoTrial
  TrialRequestedState
  TrialScheduledState
  AwaitingReport
  Reported
}

pub fn trial_state_code(state: TrialState) -> String {
  case state {
    NoTrial -> "none"
    TrialRequestedState -> "requested"
    TrialScheduledState -> "scheduled"
    AwaitingReport -> "awaiting_report"
    Reported -> "reported"
  }
}

/// The facts readiness is counted from.
pub type ReadinessInput {
  ReadinessInput(
    assessments_assigned: Int,
    assessments_submitted: Int,
    recent_full_match: Bool,
    coach_reference: Bool,
    combine_verified: Int,
    combine_requested: Int,
    trial_state: TrialState,
    open_tasks: Int,
    open_evidence_requests: Int,
  )
}

pub const no_readiness =
  ReadinessInput(
    assessments_assigned: 0,
    assessments_submitted: 0,
    recent_full_match: False,
    coach_reference: False,
    combine_verified: 0,
    combine_requested: 0,
    trial_state: NoTrial,
    open_tasks: 0,
    open_evidence_requests: 0,
  )

pub type ItemKey {
  AssessmentsItem
  RecentFullMatchItem
  CoachReferenceItem
  CombineItem
  TrialItem
  OpenTasksItem
}

pub fn item_key_code(key: ItemKey) -> String {
  case key {
    AssessmentsItem -> "assessments"
    RecentFullMatchItem -> "recent_full_match"
    CoachReferenceItem -> "coach_reference"
    CombineItem -> "combine"
    TrialItem -> "trial"
    OpenTasksItem -> "open_tasks"
  }
}

pub type Item {
  Item(
    key: ItemKey,
    label: String,
    value: String,
    complete: Bool,
    outstanding: Option(String),
  )
}

/// Workflow completeness, not a score or a recommendation: each item is a fact a human could check.
pub type Readiness {
  Readiness(items: List(Item), open_evidence_requests: Int)
}

fn available(yes: Bool) -> String {
  case yes {
    True -> "Available"
    False -> "Not available"
  }
}

fn when(yes: Bool, text: String) -> Option(String) {
  case yes {
    True -> Some(text)
    False -> None
  }
}

pub fn decision_readiness(r: ReadinessInput) -> Readiness {
  let assessments =
    Item(
      key: AssessmentsItem,
      label: "Assessments",
      value: int.to_string(r.assessments_submitted)
        <> "/"
        <> int.to_string(r.assessments_assigned)
        <> " submitted",
      complete: r.assessments_assigned > 0
        && r.assessments_submitted >= r.assessments_assigned,
      outstanding: case r.assessments_assigned == 0 {
        True -> Some("None assigned yet")
        False ->
          when(
            r.assessments_submitted < r.assessments_assigned,
            "Awaiting submissions",
          )
      },
    )
  let full_match =
    Item(
      key: RecentFullMatchItem,
      label: "Recent full match",
      value: available(r.recent_full_match),
      complete: r.recent_full_match,
      outstanding: when(
        !r.recent_full_match,
        "No recent full-match evidence on record",
      ),
    )
  let reference =
    Item(
      key: CoachReferenceItem,
      label: "Coach reference",
      value: available(r.coach_reference),
      complete: r.coach_reference,
      outstanding: when(
        !r.coach_reference,
        "No verified coach reference on record",
      ),
    )
  let combine =
    Item(
      key: CombineItem,
      label: "Combine",
      value: case r.combine_verified > 0, r.combine_requested > 0 {
        True, _ -> int.to_string(r.combine_verified) <> " verified"
        False, True -> "Requested"
        False, False -> "No verified result"
      },
      complete: r.combine_verified > 0,
      outstanding: case r.combine_verified > 0, r.combine_requested > 0 {
        True, _ -> None
        False, True -> Some("Requested, not yet completed")
        False, False ->
          Some(
            "No production-supported Combine Verified result is currently available",
          )
      },
    )
  let trial =
    Item(
      key: TrialItem,
      label: "Trial",
      value: case r.trial_state {
        NoTrial -> "Not required yet"
        TrialRequestedState -> "Requested"
        TrialScheduledState -> "Scheduled"
        AwaitingReport -> "Awaiting report"
        Reported -> "Reported"
      },
      complete: r.trial_state == Reported,
      outstanding: case r.trial_state {
        TrialRequestedState | TrialScheduledState | AwaitingReport ->
          Some("Trial in progress")
        NoTrial | Reported -> None
      },
    )
  let tasks =
    Item(
      key: OpenTasksItem,
      label: "Open tasks",
      value: int.to_string(r.open_tasks),
      complete: r.open_tasks == 0,
      outstanding: when(
        r.open_tasks > 0,
        int.to_string(r.open_tasks) <> " open",
      ),
    )
  Readiness(
    items: [assessments, full_match, reference, combine, trial, tasks],
    open_evidence_requests: r.open_evidence_requests,
  )
}

pub fn readiness_json(r: Readiness) -> Json {
  json.object([
    #(
      "items",
      json.array(r.items, fn(i) {
        json.object([
          #("key", json.string(item_key_code(i.key))),
          #("label", json.string(i.label)),
          #("value", json.string(i.value)),
          #("complete", json.bool(i.complete)),
          #("outstanding", json.nullable(i.outstanding, json.string)),
        ])
      }),
    ),
    // Counts, never a percentage or score.
    #("complete", json.int(list.count(r.items, fn(i) { i.complete }))),
    #("total", json.int(list.length(r.items))),
    #(
      "blockers",
      json.preprocessed_array(
        list.filter_map(r.items, fn(i) {
          case i.outstanding {
            Some(text) ->
              Ok(
                json.object([
                  #("key", json.string(item_key_code(i.key))),
                  #("text", json.string(text)),
                ]),
              )
            None -> Error(Nil)
          }
        }),
      ),
    ),
    #("openEvidenceRequests", json.int(r.open_evidence_requests)),
    #(
      "note",
      json.string(
        "Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.",
      ),
    ),
  ])
}

/// A word, never a number: a second numeric score next to the Trust Score would read as a player rating.
pub type Health {
  DecisionRecorded
  TrialPending
  AssessmentOutstanding
  WaitingOnEvidence
  ReadyForReview
}

pub fn health_code(health: Health) -> String {
  case health {
    DecisionRecorded -> "decision_recorded"
    TrialPending -> "trial_pending"
    AssessmentOutstanding -> "assessment_outstanding"
    WaitingOnEvidence -> "waiting_on_evidence"
    ReadyForReview -> "ready_for_review"
  }
}

pub fn health_label(health: Health) -> String {
  case health {
    DecisionRecorded -> "Decision recorded"
    TrialPending -> "Trial pending"
    AssessmentOutstanding -> "Assessment outstanding"
    WaitingOnEvidence -> "Waiting on evidence"
    ReadyForReview -> "Ready for review"
  }
}

pub fn room_health(
  readiness: Option(Readiness),
  has_current_decision: Bool,
  status: RoomStatus,
) -> Health {
  let blocked = case readiness {
    Some(r) ->
      list.filter_map(r.items, fn(i) {
        case i.outstanding {
          Some(_) -> Ok(i.key)
          None -> Error(Nil)
        }
      })
    None -> []
  }
  let ended = list.contains([Signed, Archived, Closed, Withdrawn], status)
  let has = list.contains(blocked, _)
  case has_current_decision && ended {
    True -> DecisionRecorded
    False ->
      case has(TrialItem), has(AssessmentsItem) {
        True, _ -> TrialPending
        False, True -> AssessmentOutstanding
        False, False ->
          case
            has(RecentFullMatchItem)
            || has(CoachReferenceItem)
            || has(CombineItem)
          {
            True -> WaitingOnEvidence
            False -> ReadyForReview
          }
      }
  }
}

// ---------------------------------------------------------------- permissions

/// A member's role in a room, on top of the organisation's own permissions.
pub type RoomRole {
  Viewer
  Contributor
  RoomLead
  RecruitmentAdmin
}

pub fn role_code(role: RoomRole) -> String {
  case role {
    Viewer -> "viewer"
    Contributor -> "contributor"
    RoomLead -> "room_lead"
    RecruitmentAdmin -> "recruitment_admin"
  }
}

pub fn role_rank(role: RoomRole) -> Int {
  case role {
    Viewer -> 0
    Contributor -> 1
    RoomLead -> 2
    RecruitmentAdmin -> 3
  }
}

/// What a room's roles are decided from.
pub type Membership {
  Membership(
    owner: id.OrgUserId,
    lead_scout: Option(id.OrgUserId),
    assignees: List(id.OrgUserId),
    restricted: Bool,
    status: RoomStatus,
  )
}

pub fn room_role(
  m: Membership,
  user: id.OrgUserId,
  is_lead: Bool,
) -> Option(RoomRole) {
  let assigned = list.contains(m.assignees, user)
  case is_lead, m.owner == user || m.lead_scout == Some(user) {
    True, _ -> Some(RecruitmentAdmin)
    False, True -> Some(RoomLead)
    False, False ->
      case m.restricted && !assigned, list.contains(terminal, m.status) {
        True, _ -> None
        // A filed-away room's discussion is read-only except to a room lead or recruitment admin.
        False, True -> Some(Viewer)
        // ScoutBox has no read-only staff tier, so other recruitment staff contribute to an open room.
        False, False -> Some(Contributor)
      }
  }
}

pub type RoomAction {
  Read
  Comment
  CompleteOwnTask
  CreateTask
  Assign
  SetStatus
  RecordDecision
  RequestEvidence
  RequestCombine
  RequestTrial
  ReassignOwner
  ArchiveRoom
  Reopen
  ContactView
  ContactWrite
  TrialView
  TrialAssess
  TrialWrite
  DecisionView
  DecisionDraft
  DecisionFinalize
  OfferView
  OfferDraft
  OfferIssue
  ManageAnyRoom
}

pub fn action_code(action: RoomAction) -> String {
  case action {
    Read -> "read"
    Comment -> "comment"
    CompleteOwnTask -> "complete_own_task"
    CreateTask -> "create_task"
    Assign -> "assign"
    SetStatus -> "set_status"
    RecordDecision -> "record_decision"
    RequestEvidence -> "request_evidence"
    RequestCombine -> "request_combine"
    RequestTrial -> "request_trial"
    ReassignOwner -> "reassign_owner"
    ArchiveRoom -> "archive"
    Reopen -> "reopen"
    ContactView -> "contact_view"
    ContactWrite -> "contact_write"
    TrialView -> "trial_view"
    TrialAssess -> "trial_assess"
    TrialWrite -> "trial_write"
    DecisionView -> "decision_view"
    DecisionDraft -> "decision_draft"
    DecisionFinalize -> "decision_finalize"
    OfferView -> "offer_view"
    OfferDraft -> "offer_draft"
    OfferIssue -> "offer_issue"
    ManageAnyRoom -> "manage_any_room"
  }
}

fn needs(action: RoomAction) -> Int {
  case action {
    Read | ContactView | TrialView | DecisionView | OfferView -> 0
    Comment | CompleteOwnTask | CreateTask | TrialAssess -> 1
    ManageAnyRoom -> 3
    _ -> 2
  }
}

pub fn room_can(role: Option(RoomRole), action: RoomAction) -> Bool {
  case role {
    Some(r) -> role_rank(r) >= needs(action)
    None -> False
  }
}

// ------------------------------------------------------------- source context

pub fn normalise_source_context(value: String) -> SourceContext {
  case source_context.from_string(value) {
    Ok(s) -> s
    Error(_) -> source_context.Direct
  }
}

// ---------------------------------------------------------------------- tasks

pub fn can_task_transition(from: TaskState, to: TaskState) -> Bool {
  let allowed = case from {
    task_state.Open -> [
      task_state.InProgress,
      task_state.Done,
      task_state.Cancelled,
    ]
    task_state.InProgress -> [
      task_state.Done,
      task_state.Cancelled,
      task_state.Open,
    ]
    task_state.Done | task_state.Cancelled -> [task_state.Open]
  }
  list.contains(allowed, to)
}

// ------------------------------------------------------------------ priorities

pub const priority_note =
  "Internal workflow urgency for your organisation. It is not a judgement of the player and is never shown to them."

// -------------------------------------------------------------------- activity

pub const event_types = [
  "room_created", "room_status_changed", "room_reopened", "room_owner_changed",
  "room_member_assigned", "room_task_created", "room_task_updated",
  "room_comment_added", "room_comment_edited", "room_comment_deleted",
  "room_assessment_assigned", "room_evidence_reviewed",
  "room_evidence_requested", "room_combine_requested", "room_trial_linked",
  "room_signing_linked", "room_decision_recorded", "room_tag_changed",
  "room_priority_changed",
]

/// One entry of a case's history.
pub type Event {
  Event(
    id: String,
    at: Int,
    action: String,
    by_kind: Option(case_history.ByKind),
    by_id: Option(String),
    by_name: Option(String),
    detail: Option(Json),
  )
}

/// The numeric suffix of an event id breaks timestamp ties, so events written in the same millisecond keep their
/// order between reads.
fn seq(id: String) -> Int {
  case string.split(id, "-") |> list.last {
    Ok(tail) ->
      case int.parse(tail) {
        Ok(n) -> n
        Error(_) -> 0
      }
    Error(_) -> 0
  }
}

pub type Page(a) {
  Page(items: List(a), next_cursor: Option(String), total: Int)
}

/// Newest first, `limit` at a time after the entry whose id is `cursor` (from the start when it isn't found).
pub fn room_activity(
  history: List(Event),
  limit: Int,
  cursor: Option(String),
) -> Page(Event) {
  let rows =
    list.sort(history, fn(a, b) {
      case int.compare(b.at, a.at) {
        order.Eq -> int.compare(seq(b.id), seq(a.id))
        other -> other
      }
    })
  after_cursor(rows, fn(e: Event) { e.id }, limit, cursor)
}

/// The page of `rows` after the one `id` names, as the TypeScript server's index cursors read.
pub fn after_cursor(
  rows: List(a),
  id: fn(a) -> String,
  limit: Int,
  cursor: Option(String),
) -> Page(a) {
  let total = list.length(rows)
  let rest = case cursor {
    Some(c) ->
      case list.split_while(rows, fn(r) { id(r) != c }) {
        #(_, [_, ..after]) -> after
        #(_, []) -> rows
      }
    None -> rows
  }
  let start = total - list.length(rest)
  let page = list.take(rest, limit)
  let next = case start + limit < total, list.last(page) {
    True, Ok(last) -> Some(id(last))
    _, _ -> None
  }
  Page(items: page, next_cursor: next, total:)
}

pub fn event_json(e: Event) -> Json {
  json.object([
    #("id", json.string(e.id)),
    #("at", json.int(e.at)),
    #(
      "type",
      json.string(case list.contains(event_types, e.action) {
        True -> e.action
        False -> "case_" <> e.action
      }),
    ),
    #("actor", case e.by_id {
      Some(by) ->
        json.object([
          #("kind", json.nullable(e.by_kind, case_history.by_kind_to_json)),
          #("id", json.string(by)),
          #("name", json.nullable(e.by_name, json.string)),
        ])
      None -> json.null()
    }),
    #("detail", option.unwrap(e.detail, json.null())),
  ])
}

pub fn page_json(page: Page(a), item: fn(a) -> Json) -> Json {
  json.object([
    #("items", json.array(page.items, item)),
    #("nextCursor", json.nullable(page.next_cursor, json.string)),
    #("total", json.int(page.total)),
  ])
}

pub fn activity_json(page: Page(Event)) -> Json {
  page_json(page, event_json)
}

// ------------------------------------------------------------ safe projections

pub const trust_note = "Evidence confidence — not football ability."

pub const dev_note =
  "Box Cam activity shows verified training evidence. It does not independently establish football ability."

pub const privacy_note =
  "This room is private to your organisation. The player, their guardian and every other club can never see it."

pub const unavailable_note =
  "Player data is currently unavailable to your organisation under the standing rules. Your internal record remains."

/// A room as a list row needs it.
pub type SummaryRoom {
  SummaryRoom(
    room_id: id.RecruitmentCaseId,
    player_id: id.PlayerId,
    player_name: Option(String),
    status: RoomStatus,
    stage: Stage,
    priority: case_row.RoomPriority,
    tags: List(String),
    owner_user_id: id.OrgUserId,
    owner_name: Option(String),
    lead_scout_user_id: Option(id.OrgUserId),
    updated_at: Int,
    created_at: Int,
  )
}

/// What the player's own record shows a list row, when the club may see them.
pub type SummaryPlayer {
  SummaryPlayer(
    position: Option(String),
    age: Option(Int),
    current_club: Option(String),
  )
}

pub type SummaryTrust {
  SummaryTrust(score: Int, band: String, band_label: String)
}

/// A room row for a list. Carries no player-private field and no source detail.
pub fn room_summary(
  room: SummaryRoom,
  player player: Option(SummaryPlayer),
  trust trust: Option(SummaryTrust),
  open_tasks open_tasks: Int,
  health health: Option(Health),
  last_activity_at last_activity_at: Option(Int),
  visible visible: Bool,
) -> Json {
  let seen = fn(f: fn(SummaryPlayer) -> Option(a), to_json: fn(a) -> Json) {
    case visible {
      True -> json.nullable(option.then(player, f), to_json)
      False -> json.null()
    }
  }
  json.object([
    #("roomId", id.recruitment_case_json(room.room_id)),
    #("playerId", id.player_json(room.player_id)),
    #("playerName", case visible {
      True -> json.nullable(room.player_name, json.string)
      False -> json.null()
    }),
    #("playerAvailable", json.bool(visible)),
    #("position", seen(fn(p) { p.position }, json.string)),
    #("age", seen(fn(p) { p.age }, json.int)),
    #("currentClub", seen(fn(p) { p.current_club }, json.string)),
    #("status", room_status.to_json(room.status)),
    #("statusLabel", json.string(status_label(room.status))),
    #("stage", case_row.stage_to_json(room.stage)),
    #("priority", case_row.room_priority_to_json(room.priority)),
    #("tags", json.array(room.tags, json.string)),
    #("ownerUserId", id.org_user_json(room.owner_user_id)),
    #("ownerName", json.nullable(room.owner_name, json.string)),
    #(
      "leadScoutUserId",
      json.nullable(room.lead_scout_user_id, id.org_user_json),
    ),
    #("trust", case visible, trust {
      True, Some(t) ->
        json.object([
          #("score", json.int(t.score)),
          #("band", json.string(t.band)),
          #("bandLabel", json.string(t.band_label)),
          #("note", json.string(trust_note)),
        ])
      _, _ -> json.null()
    }),
    #("openTasks", json.int(open_tasks)),
    #("health", json.nullable(option.map(health, health_code), json.string)),
    #(
      "healthLabel",
      json.nullable(option.map(health, health_label), json.string),
    ),
    #("lastActivityAt", json.nullable(last_activity_at, json.int)),
    #("updatedAt", json.int(room.updated_at)),
    #("createdAt", json.int(room.created_at)),
  ])
}

// --------------------------------------------------------------------- funnel

pub fn room_funnel(statuses: List(RoomStatus)) -> Json {
  let counts =
    list.map(room_status.pairs, fn(p) {
      #(p.1, list.count(statuses, fn(s) { s == p.1 }))
    })
  funnel_from_counts(counts)
}

/// The funnel from room counts by status, as a GROUP BY answers them (missing statuses count none).
pub fn funnel_from_counts(by_status: List(#(RoomStatus, Int))) -> Json {
  let n = fn(s) {
    case list.key_find(by_status, s) {
      Ok(c) -> c
      Error(_) -> 0
    }
  }
  let sum = fn(ss) { list.fold(ss, 0, fn(t, s) { t + n(s) }) }
  json.object([
    #("total", json.int(sum(statuses()))),
    #("active", json.int(sum(open_statuses()))),
    #("shortlisted", json.int(sum([Shortlisted, Priority]))),
    #("trials", json.int(sum([TrialRequested, TrialScheduled, TrialCompleted]))),
    #("offers", json.int(sum([OfferConsideration, OfferMade]))),
    #("signed", json.int(n(Signed))),
    #("archived", json.int(sum([Archived, Closed, Withdrawn]))),
    #(
      "byStatus",
      json.object(
        list.map(room_status.pairs, fn(p) { #(p.0, json.int(n(p.1))) }),
      ),
    ),
    #(
      "note",
      json.string(
        "Your organisation’s own recruitment activity. ScoutBox publishes no cross-club league table.",
      ),
    ),
  ])
}

// --------------------------------------------------------------------- limits

pub const comment_body_max = 4000

pub const task_title_max = 160

pub const task_description_max = 1000

pub const tasks_per_room = 200

pub const tag_length = 40

pub const tags_per_room = 20

pub const mentions_per_comment = 20

pub const page_size = 50

pub const max_page_size = 100

/// A page size from a query value, as JavaScript's `Number` reads it: a positive number is floored and capped,
/// anything else is the default.
pub fn clamp_page(raw: Option(String)) -> Int {
  let n = case option.map(raw, string.trim) {
    Some("") | None -> Error(Nil)
    Some(text) ->
      case int.parse(text) {
        Ok(i) -> Ok(int.to_float(i))
        Error(_) -> float.parse(text)
      }
  }
  case n {
    Ok(v) if v >. 0.0 -> int.min(float.truncate(float.floor(v)), max_page_size)
    _ -> page_size
  }
}

pub type TagRefusal {
  TagInvalid
  TagEmpty
  TagProhibited
}

pub fn tag_refusal_fields(refusal: TagRefusal) -> List(#(String, Json)) {
  let #(code, message) = case refusal {
    TagInvalid -> #(
      "ROOM_TAGS_INVALID",
      "A tag is text of at most " <> int.to_string(tag_length) <> " characters.",
    )
    TagEmpty -> #("ROOM_TAG_EMPTY", "A tag needs some text.")
    TagProhibited -> #(
      "ROOM_TAG_PROHIBITED",
      "A tag cannot classify a player by a protected characteristic.",
    )
  }
  [
    #("ok", json.bool(False)),
    #("error", json.string(code)),
    #("message", json.string(message)),
  ]
}

/// Tags are internal labels. A tag that reads as a protected trait is refused.
pub fn validate_tag(raw: String) -> Result(String, TagRefusal) {
  let tag = string.trim(raw)
  let flat = flatten(string.lowercase(tag))
  let prohibited =
    list.any(prohibited_reason_codes, fn(c) {
      flat == c
      || string.starts_with(flat, c <> "_")
      || string.ends_with(flat, "_" <> c)
    })
  case input.utf16_length(raw) > tag_length, tag, prohibited {
    True, _, _ -> Error(TagInvalid)
    _, "", _ -> Error(TagEmpty)
    _, _, True -> Error(TagProhibited)
    _, _, False -> Ok(tag)
  }
}

/// Every run of characters other than a–z becomes one `_` (`/[^a-z]+/g`).
fn flatten(s: String) -> String {
  let #(out, _) =
    string.to_utf_codepoints(s)
    |> list.fold(#("", False), fn(acc, c) {
      let #(out, in_run) = acc
      let n = string.utf_codepoint_to_int(c)
      case n >= 97 && n <= 122, in_run {
        True, _ -> #(out <> string.from_utf_codepoints([c]), False)
        False, True -> #(out, True)
        False, False -> #(out <> "_", True)
      }
    })
  out
}

pub fn tag_json(result: Result(String, TagRefusal)) -> Json {
  case result {
    Ok(tag) ->
      json.object([#("ok", json.bool(True)), #("tag", json.string(tag))])
    Error(refusal) -> json.object(tag_refusal_fields(refusal))
  }
}

// ---------------------------------------------------------------------------------------------- second look

/// The decision a filed-away room's Second Look event carries: machine-readable reasons, never the note.
pub type SecondLookDecision {
  SecondLookDecision(
    reason_codes: List(String),
    created_at: Int,
    source_refs: Option(Json),
  )
}

/// The internal shape Second Look reads when a room is filed away. Absent: the note, comments, assessment
/// content and the player's name.
pub fn second_look_event(
  room_id: id.RecruitmentCaseId,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  status: RoomStatus,
  updated_at: Int,
  decision: Option(SecondLookDecision),
) -> Json {
  let codes = case decision {
    Some(d) -> d.reason_codes
    None -> []
  }
  let revisitable = revisitable_reason_codes()
  json.object([
    #("type", json.string("recruitment_room_archived")),
    #("roomId", id.recruitment_case_json(room_id)),
    #("orgId", id.org_json(org_id)),
    #("playerId", id.player_json(player_id)),
    #("status", room_status.to_json(status)),
    #("reasonCodes", json.array(codes, json.string)),
    #("revisitable", json.bool(list.any(codes, list.contains(revisitable, _)))),
    #(
      "decisionAt",
      json.int(case decision {
        Some(d) -> d.created_at
        None -> updated_at
      }),
    ),
    #(
      "sourceVersionRefs",
      option.then(decision, fn(d) { d.source_refs })
        |> option.unwrap(json.null()),
    ),
  ])
}
