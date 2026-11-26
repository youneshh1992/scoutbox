//// Second Look's rules (domains/discovery/shared.mjs): has something changed about a player since the club's
//// decision, relevant to the reason it gave? It never scores or ranks a player, and never tells a club its
//// decision was wrong: every output is a list of plain facts.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/json_text
import scoutbox/rows/id
import scoutbox/rows/second_look_items as item_row

pub const policy_version = 1

const day_ms = 86_400_000

pub const cooldown_days = 30

pub const expiry_days = 120

/// A change unrelated to the reason must clear a higher bar: this many distinct changes, or one substantial one.
pub const general_min_changes = 2

pub const disclaimer =
  "Second Look reports what changed in a player’s record since your decision. It does not judge that decision and does not recommend whether to sign anyone."

pub const dismissal_reasons = [
  "already_reviewed_elsewhere", "change_not_material", "timing_not_right",
  "squad_need_changed", "no_action_required", "other",
]

// ------------------------------------------------------------------------------------------------- change types

pub type ChangeType {
  FullMatchAdded
  EvidenceAdded
  EvidenceQualityImproved
  EvidenceRemoved
  EvidenceDisputed
  VerifiedReferenceAdded
  VerifiedReferenceRevoked
  CombineVerifiedAdded
  CombineVerifiedInvalidated
  CombineVerifiedRestored
  DevelopmentEvidenceStarted
  DevelopmentBlockCompleted
  TrialCompleted
  AssessmentSubmitted
  CurrentClubConfirmed
  PositionChanged
  EvidenceGapClosed
}

pub const change_types = [
  FullMatchAdded,
  EvidenceAdded,
  EvidenceQualityImproved,
  EvidenceRemoved,
  EvidenceDisputed,
  VerifiedReferenceAdded,
  VerifiedReferenceRevoked,
  CombineVerifiedAdded,
  CombineVerifiedInvalidated,
  CombineVerifiedRestored,
  DevelopmentEvidenceStarted,
  DevelopmentBlockCompleted,
  TrialCompleted,
  AssessmentSubmitted,
  CurrentClubConfirmed,
  PositionChanged,
  EvidenceGapClosed,
]

/// Each change type with its text.
pub const change_type_pairs = [
  #("full_match_added", FullMatchAdded),
  #("evidence_added", EvidenceAdded),
  #("evidence_quality_improved", EvidenceQualityImproved),
  #("evidence_removed", EvidenceRemoved),
  #("evidence_disputed", EvidenceDisputed),
  #("verified_reference_added", VerifiedReferenceAdded),
  #("verified_reference_revoked", VerifiedReferenceRevoked),
  #("combine_verified_added", CombineVerifiedAdded),
  #("combine_verified_invalidated", CombineVerifiedInvalidated),
  #("combine_verified_restored", CombineVerifiedRestored),
  #("development_evidence_started", DevelopmentEvidenceStarted),
  #("development_block_completed", DevelopmentBlockCompleted),
  #("trial_completed", TrialCompleted),
  #("assessment_submitted", AssessmentSubmitted),
  #("current_club_confirmed", CurrentClubConfirmed),
  #("position_changed", PositionChanged),
  #("evidence_gap_closed", EvidenceGapClosed),
]

pub fn change_type_from_string(s: String) -> Result(ChangeType, Nil) {
  list.key_find(change_type_pairs, s)
}

pub fn change_type_to_string(t: ChangeType) -> String {
  case t {
    FullMatchAdded -> "full_match_added"
    EvidenceAdded -> "evidence_added"
    EvidenceQualityImproved -> "evidence_quality_improved"
    EvidenceRemoved -> "evidence_removed"
    EvidenceDisputed -> "evidence_disputed"
    VerifiedReferenceAdded -> "verified_reference_added"
    VerifiedReferenceRevoked -> "verified_reference_revoked"
    CombineVerifiedAdded -> "combine_verified_added"
    CombineVerifiedInvalidated -> "combine_verified_invalidated"
    CombineVerifiedRestored -> "combine_verified_restored"
    DevelopmentEvidenceStarted -> "development_evidence_started"
    DevelopmentBlockCompleted -> "development_block_completed"
    TrialCompleted -> "trial_completed"
    AssessmentSubmitted -> "assessment_submitted"
    CurrentClubConfirmed -> "current_club_confirmed"
    PositionChanged -> "position_changed"
    EvidenceGapClosed -> "evidence_gap_closed"
  }
}

/// A change that reduces the evidence available. Not framed as wrongdoing.
pub fn is_negative(t: ChangeType) -> Bool {
  case t {
    EvidenceRemoved
    | EvidenceDisputed
    | VerifiedReferenceRevoked
    | CombineVerifiedInvalidated -> True
    _ -> False
  }
}

pub fn change_copy(t: ChangeType) -> String {
  case t {
    FullMatchAdded -> "A new full match has been added."
    EvidenceAdded -> "New evidence has been added to the player’s record."
    EvidenceQualityImproved ->
      "Existing evidence has been independently confirmed."
    EvidenceRemoved ->
      "A source used in the previous review is no longer current."
    EvidenceDisputed -> "A source used in the previous review is under review."
    VerifiedReferenceAdded -> "A verified coach reference has been added."
    VerifiedReferenceRevoked ->
      "A coach reference used in the previous review is no longer verified."
    CombineVerifiedAdded ->
      "A standardized Combine Verified result is now available."
    CombineVerifiedInvalidated ->
      "A Combine result used in the previous review is no longer valid."
    CombineVerifiedRestored ->
      "A Combine result that had been invalidated has been restored after review."
    DevelopmentEvidenceStarted ->
      "Recorded development activity is now available for the first time since your review."
    DevelopmentBlockCompleted ->
      "A coach-assigned development block has been completed."
    TrialCompleted -> "A trial has been completed and reported."
    AssessmentSubmitted ->
      "A new assessment has been submitted in your organisation."
    CurrentClubConfirmed -> "The player’s current club is now confirmed."
    PositionChanged -> "The player’s declared position has changed."
    EvidenceGapClosed ->
      "An evidence gap your organisation raised has been filled."
  }
}

/// The changes substantial enough to resurface a player on their own.
pub fn is_substantial(t: ChangeType) -> Bool {
  case t {
    FullMatchAdded
    | VerifiedReferenceAdded
    | CombineVerifiedAdded
    | TrialCompleted -> True
    _ -> False
  }
}

/// Which changes may mean the archive reason a club gave no longer applies. A reason about the club (a squad
/// place, a budget) maps to none: no new footage makes one appear.
pub fn reason_changes(code: String) -> List(ChangeType) {
  case code {
    "insufficient_recent_evidence" -> [
      FullMatchAdded, EvidenceAdded, EvidenceQualityImproved, EvidenceGapClosed,
    ]
    "insufficient_full_match" -> [FullMatchAdded, EvidenceGapClosed]
    "reference_missing" -> [VerifiedReferenceAdded]
    "combine_missing" -> [CombineVerifiedAdded, CombineVerifiedRestored]
    "trial_needed" -> [TrialCompleted]
    "continue_monitoring" -> [
      FullMatchAdded, VerifiedReferenceAdded, CombineVerifiedAdded,
      TrialCompleted, CurrentClubConfirmed, EvidenceGapClosed,
    ]
    // Physical development is read as evidence becoming available, not as a prediction about a body.
    "physical_profile" -> [DevelopmentBlockCompleted, CombineVerifiedAdded]
    "technical_fit" | "tactical_fit" -> [FullMatchAdded, TrialCompleted]
    "development_upside" -> [DevelopmentBlockCompleted, FullMatchAdded]
    "not_current_priority" -> [
      FullMatchAdded, VerifiedReferenceAdded, CombineVerifiedAdded,
      TrialCompleted,
    ]
    "position_need" -> [PositionChanged]
    "trial_outcome" -> [TrialCompleted]
    _ -> []
  }
}

/// Every reason code the map names, in its order.
pub const reason_codes = [
  "insufficient_recent_evidence", "insufficient_full_match", "reference_missing",
  "combine_missing", "trial_needed", "continue_monitoring", "physical_profile",
  "technical_fit", "tactical_fit", "development_upside", "not_current_priority",
  "position_need", "trial_outcome", "squad_space", "budget", "timing",
  "registration", "travel_logistics", "eligibility", "player_unavailable",
]

/// Reasons that can never be resolved by a change in the player's record.
pub fn is_club_side(code: String) -> Bool {
  list.contains(reason_codes, code) && reason_changes(code) == []
}

// ------------------------------------------------------------------------------------------------------ changes

/// A source-system fact as a change: only identity, time and type travel, never the payload.
pub type Change {
  Change(
    kind: ChangeType,
    source_system: String,
    source_id: Option(String),
    occurred_at: Int,
    fingerprint: String,
  )
}

/// Excludes the timestamp: the same source fact seen twice is the same change.
pub fn fingerprint(
  kind: ChangeType,
  source_system: String,
  source_id: Option(String),
) -> String {
  fingerprint_text(change_type_to_string(kind), source_system, source_id)
}

/// changeFingerprint over any type's text.
pub fn fingerprint_text(
  type_: String,
  source_system: String,
  source_id: Option(String),
) -> String {
  type_ <> ":" <> source_system <> ":" <> option.unwrap(source_id, "none")
}

/// normalizeMaterialChange: None for a type outside the vocabulary or a change with no time.
pub fn normalize(
  type_: String,
  source_system: String,
  source_id: Option(String),
  occurred_at: Option(Int),
) -> Option(Change) {
  case change_type_from_string(type_), occurred_at {
    Ok(kind), Some(at) -> change(kind, source_system, source_id, at)
    _, _ -> None
  }
}

/// The change as the TypeScript record carries it, without its subject and payload.
pub fn change_json(c: Change) -> Json {
  json.object([
    #("type", json.string(change_type_to_string(c.kind))),
    #("sourceSystem", json.string(c.source_system)),
    #("sourceId", json.nullable(c.source_id, json.string)),
    #("occurredAt", json.int(c.occurred_at)),
    #("negative", json.bool(is_negative(c.kind))),
    #("text", json.string(change_copy(c.kind))),
    #("fingerprint", json.string(c.fingerprint)),
  ])
}

/// normalizeMaterialChange: None for a change with no time.
pub fn change(
  kind: ChangeType,
  source_system: String,
  source_id: Option(String),
  occurred_at: Int,
) -> Option(Change) {
  case occurred_at == 0 {
    True -> None
    False ->
      Some(Change(
        kind:,
        source_system:,
        source_id:,
        occurred_at:,
        fingerprint: fingerprint(kind, source_system, source_id),
      ))
  }
}

/// One real-world change often arrives through several systems at once. Keep the earliest observation; newest
/// first, then by fingerprint.
pub fn dedupe(changes: List(Change)) -> List(Change) {
  list.fold(changes, [], fn(kept: List(Change), c) {
    case list.find(kept, fn(k) { k.fingerprint == c.fingerprint }) {
      Ok(k) if k.occurred_at <= c.occurred_at -> kept
      Ok(_) ->
        list.map(kept, fn(k) {
          case k.fingerprint == c.fingerprint {
            True -> c
            False -> k
          }
        })
      Error(Nil) -> [c, ..kept]
    }
  })
  |> list.sort(fn(a, b) {
    int.compare(b.occurred_at, a.occurred_at)
    |> order.lazy_break_tie(fn() {
      string.compare(a.fingerprint, b.fingerprint)
    })
  })
}

/// The changes after the decision, deduplicated. A future timestamp is a forged or broken event, not a change.
pub fn since(
  changes: List(Change),
  decision_at: Int,
  now: Int,
) -> List(Change) {
  changes
  |> list.filter(fn(c) { c.occurred_at > decision_at && c.occurred_at <= now })
  |> dedupe
}

/// The decision's reasons this change relates to.
pub fn reason_match(c: Change, codes: List(String)) -> List(String) {
  list.filter(codes, fn(code) { list.contains(reason_changes(code), c.kind) })
}

pub fn meets_general_threshold(changes: List(Change)) -> Bool {
  let positive = list.filter(changes, fn(c) { !is_negative(c.kind) })
  list.any(positive, fn(c) { is_substantial(c.kind) })
  || list.length(positive) >= general_min_changes
}

// --------------------------------------------------------------------------------------------- trust movement

fn level_rank(level: String) -> Result(Int, Nil) {
  case level {
    "none" -> Ok(0)
    "limited" -> Ok(1)
    "established" -> Ok(2)
    "strong" -> Ok(3)
    "very_strong" -> Ok(4)
    _ -> Error(Nil)
  }
}

const component_codes = [
  #("identity", #("IDENTITY_CONFIRMED", "CLAIM_REVOKED")),
  #("footballHistory", #("CAREER_RECORD_CONFIRMED", "CLAIM_REVOKED")),
  #("relationships", #("COACH_RELATIONSHIP_CONFIRMED", "CLAIM_REVOKED")),
  #("references", #("REFERENCE_CONFIRMED", "CLAIM_REVOKED")),
  #("evidence", #("BOX_CAM_EVIDENCE_ADDED", "EVIDENCE_EXPIRED")),
  #("combine", #("COMBINE_VERIFIED_ADDED", "COMBINE_INVALIDATED")),
]

pub type Movement {
  Movement(component: String, code: String, up: Bool)
}

/// Trust movement from component levels: a snapshot drops per-component coverage, which a club may not see.
/// Context only, never a trigger on its own. Either side missing is no movement.
pub fn trust_level_changes(
  at_decision: Option(List(#(String, String))),
  now: Option(List(#(String, String))),
) -> List(Movement) {
  case at_decision, now {
    Some(before), Some(after) ->
      list.filter_map(component_codes, fn(entry) {
        let #(key, #(up, down)) = entry
        use b <- result.try(
          list.key_find(before, key) |> result.try(level_rank),
        )
        use a <- result.try(list.key_find(after, key) |> result.try(level_rank))
        case int.compare(a, b) {
          order.Eq -> Error(Nil)
          order.Gt -> Ok(Movement(key, up, True))
          order.Lt -> Ok(Movement(key, down, False))
        }
      })
    _, _ -> []
  }
}

pub fn movement_json(m: Movement) -> Json {
  json.object([
    #("component", json.string(m.component)),
    #("code", json.string(m.code)),
    #(
      "direction",
      json.string(case m.up {
        True -> "up"
        False -> "down"
      }),
    ),
  ])
}

// ---------------------------------------------------------------------------------------- snapshot comparison

/// What a decision-time snapshot recorded, as counts of the references it kept.
pub type Recorded {
  Recorded(
    at: Option(Int),
    trust: Option(#(Float, String)),
    /// None when the snapshot kept no references of that kind.
    evidence: Option(Int),
    combine: Option(Int),
    assessments: Option(Int),
    trials: Option(Int),
  )
}

/// The player's facts now, as the same counts. No snapshot records how many references there were, so
/// `references_at_decision` is None from every route.
pub type Current {
  Current(
    trust: Option(#(Float, String)),
    evidence: Int,
    references: Int,
    references_at_decision: Option(Int),
    combine: Int,
    assessments: Int,
    trials: Int,
  )
}

fn trust_value_json(score: Json, band: String) -> Json {
  json.object([#("score", score), #("band", json.string(band))])
}

fn row(key: String, label: String, was: Option(Json), now: Json) -> Json {
  json.object([
    #("key", json.string(key)),
    #("label", json.string(label)),
    #("was", option.unwrap(was, json.null())),
    #("now", now),
    #("available", json.bool(option.is_some(was))),
    #("changed", case was {
      Some(w) -> json.bool(json.to_string(w) != json.to_string(now))
      None -> json.null()
    }),
  ])
}

/// compareToSnapshot. `available: false` means the snapshot cannot reconstruct the previous value, not that it
/// was zero.
pub fn compare(snapshot: Option(Recorded), current: Current) -> Json {
  let known = fn(count: fn(Recorded) -> Option(Int)) {
    option.then(snapshot, count) |> option.map(json.int)
  }
  json.object([
    #("available", json.bool(option.is_some(snapshot))),
    #("at", json.nullable(option.then(snapshot, fn(s) { s.at }), json.int)),
    #("note", case snapshot {
      Some(_) -> json.null()
      None -> json.string(no_snapshot_note)
    }),
    #(
      "rows",
      json.preprocessed_array([
        row(
          "trust",
          "Evidence confidence",
          option.then(snapshot, fn(s) { s.trust })
            |> option.map(fn(t) { trust_value_json(json_text.number(t.0), t.1) }),
          case current.trust {
            Some(#(score, band)) ->
              trust_value_json(json_text.number(score), band)
            None -> json.null()
          },
        ),
        row(
          "evidence",
          "Evidence items",
          known(fn(s) { s.evidence }),
          json.int(current.evidence),
        ),
        row(
          "references",
          "Verified coach references",
          option.map(current.references_at_decision, json.int),
          json.int(current.references),
        ),
        row(
          "combine",
          "Combine Verified protocols",
          known(fn(s) { s.combine }),
          json.int(current.combine),
        ),
        row(
          "assessments",
          "Assessments in your organisation",
          known(fn(s) { s.assessments }),
          json.int(current.assessments),
        ),
        row(
          "trials",
          "Trials",
          known(fn(s) { s.trials }),
          json.int(current.trials),
        ),
      ]),
    ),
  ])
}

pub const no_snapshot_note =
  "Previous detail unavailable — no decision-time snapshot was recorded."

// -------------------------------------------------------------------------------------------------- candidates

pub type Kind =
  item_row.TriggerType

pub fn kind_label(k: Kind) -> String {
  case k {
    item_row.DirectReasonResolved -> "Worth Another Look"
    item_row.SignificantNewEvidence -> "New Since Your Review"
    item_row.EvidenceRemoved -> "Evidence Changed"
    item_row.GeneralUpdate -> "New Since Your Review"
  }
}

fn kind_rank(k: Kind) -> Int {
  case k {
    item_row.DirectReasonResolved -> 0
    item_row.SignificantNewEvidence -> 1
    item_row.EvidenceRemoved -> 2
    item_row.GeneralUpdate -> 3
  }
}

/// The decision a candidate compares against: the head of the Room's decision chain.
pub type Decided {
  Decided(id: id.RoomDecisionId, at: Int, reason_codes: List(String))
}

pub type Candidate {
  Candidate(
    room_id: id.RecruitmentCaseId,
    player_id: id.PlayerId,
    decision: Decided,
    archived_status: String,
    kind: Kind,
    direct: Bool,
    /// Each change, with the decision's reasons it relates to.
    changes: List(#(Change, List(String))),
    direct_reason_codes: List(String),
    unresolved_reason_codes: List(String),
    /// Sorted.
    fingerprints: List(String),
    latest_change_at: Int,
    summary: String,
  )
}

/// buildSecondLookCandidate: None (the common case) when the player should not be surfaced: they are not
/// visible, the room has not ended, or nothing material changed since the decision.
pub fn candidate(
  room_id: id.RecruitmentCaseId,
  player_id: id.PlayerId,
  archived_status: String,
  visible: Bool,
  decision: Decided,
  changes: List(Change),
  now: Int,
) -> Option(Candidate) {
  let ended =
    list.contains(["archived", "closed", "withdrawn"], archived_status)
  let material = case visible && ended {
    True -> since(changes, decision.at, now)
    False -> []
  }
  case material {
    [] -> None
    [latest, ..] -> {
      let codes = decision.reason_codes
      let directed = list.map(material, fn(c) { #(c, reason_match(c, codes)) })
      let direct = list.filter(directed, fn(d) { d.1 != [] })
      let negative = list.filter(material, fn(c) { is_negative(c.kind) })
      let kind = case direct, negative {
        [_, ..], _ -> Some(item_row.DirectReasonResolved)
        [], [_, ..] if negative == material -> Some(item_row.EvidenceRemoved)
        [], _ ->
          case meets_general_threshold(material), negative {
            True, _ ->
              case list.any(material, fn(c) { is_substantial(c.kind) }) {
                True -> Some(item_row.SignificantNewEvidence)
                False -> Some(item_row.GeneralUpdate)
              }
            False, [_, ..] -> Some(item_row.EvidenceRemoved)
            False, [] -> None
          }
      }
      use kind <- option.map(kind)
      Candidate(
        room_id:,
        player_id:,
        decision:,
        archived_status:,
        kind:,
        direct: direct != [],
        changes: directed,
        direct_reason_codes: list.flat_map(direct, fn(d) { d.1 }) |> list.unique,
        // Club-side reasons are reported as still standing so the UI cannot imply otherwise.
        unresolved_reason_codes: list.filter(codes, is_club_side),
        fingerprints: list.map(material, fn(c) { c.fingerprint })
          |> list.sort(string.compare),
        latest_change_at: latest.occurred_at,
        summary: summary(kind, direct, material),
      )
    }
  }
}

/// The candidate's facts, in buildSecondLookCandidate's key order (without the ids, trust and copy its views add).
pub fn candidate_json(c: Candidate) -> Json {
  json.object([
    #("decisionAt", json.int(c.decision.at)),
    #("archivedStatus", json.string(c.archived_status)),
    #("archiveReasonCodes", json.array(c.decision.reason_codes, json.string)),
    #("kind", item_row.trigger_type_to_json(c.kind)),
    #("kindLabel", json.string(kind_label(c.kind))),
    #(
      "strength",
      json.string(case c.direct {
        True -> "direct"
        False -> "general"
      }),
    ),
    #(
      "changes",
      json.array(c.changes, fn(pair) {
        json.object([
          #("fingerprint", json.string({ pair.0 }.fingerprint)),
          #("relatesTo", json.array(pair.1, json.string)),
        ])
      }),
    ),
    #("changeCount", json.int(list.length(c.changes))),
    #("directReasonCodes", json.array(c.direct_reason_codes, json.string)),
    #(
      "unresolvedReasonCodes",
      json.array(c.unresolved_reason_codes, json.string),
    ),
    #("changeFingerprints", json.array(c.fingerprints, json.string)),
    #("latestChangeAt", json.int(c.latest_change_at)),
    #("summary", json.string(c.summary)),
  ])
}

fn summary(
  kind: Kind,
  direct: List(#(Change, List(String))),
  material: List(Change),
) -> String {
  let n = list.length(material)
  case kind, direct {
    item_row.DirectReasonResolved, [first, ..] -> {
      // Lead with the most substantial change, not merely the most recent.
      let headline =
        list.find(direct, fn(d) { is_substantial({ d.0 }.kind) })
        |> result.unwrap(first)
      change_copy({ headline.0 }.kind)
      <> " This relates to the reason recorded when the room was closed."
    }
    item_row.EvidenceRemoved, _ ->
      case n {
        1 -> "One source used in the previous review is no longer current."
        _ ->
          int.to_string(n)
          <> " sources used in the previous review are no longer current."
      }
    _, _ ->
      int.to_string(n)
      <> " material "
      <> case n {
        1 -> "change"
        _ -> "changes"
      }
      <> " since your review."
  }
}

// ---------------------------------------------------------------------------------------------------- lifecycle

pub fn can_transition(from: item_row.Status, to: item_row.Status) -> Bool {
  case from, to {
    item_row.Open, item_row.Reviewed
    | item_row.Open, item_row.Dismissed
    | item_row.Open, item_row.ReopenedRoom
    | item_row.Open, item_row.Expired
    | item_row.Reviewed, item_row.Dismissed
    | item_row.Reviewed, item_row.ReopenedRoom
    | item_row.Reviewed, item_row.Expired
    | item_row.Dismissed, item_row.Open
    | item_row.Expired, item_row.Open
    -> True
    _, _ -> False
  }
}

/// What the stored item says the club already did, as `secondLookStatus` reads it.
pub type Handled {
  Handled(
    status: item_row.Status,
    fingerprints: List(String),
    dismissed_at: Option(Int),
    reviewed_at: Option(Int),
    updated_at: Int,
  )
}

pub type Verdict {
  Create
  /// Do not resurface as open; the item stays in its tab.
  Suppress(reason: String)
  /// Genuinely new evidence opens a handled item again.
  Reopen(fresh: List(String))
  /// The item already stands for these changes.
  Unchanged
  /// More changes for an item still open.
  Update(fresh: List(String))
}

/// The verdict as secondLookStatus answers it.
pub fn verdict_json(v: Verdict) -> Json {
  let of = fn(action, reason) {
    [#("action", json.string(action)), #("reason", json.string(reason))]
  }
  json.object(case v {
    Create -> of("create", "new")
    Suppress(reason) -> of("suppress", reason)
    Reopen(fresh) ->
      list.append(of("reopen", "materially_new_evidence"), [
        #("fresh", json.array(fresh, json.string)),
      ])
    Unchanged -> of("refresh", "unchanged")
    Update(fresh) ->
      list.append(of("update", "more_evidence"), [
        #("fresh", json.array(fresh, json.string)),
      ])
  })
}

/// Should an item be (re)surfaced, given what this club already did with the same evidence? `changes` are the
/// candidate's, by fingerprint.
pub fn verdict(
  existing: Option(Handled),
  changes: List(#(String, ChangeType)),
  now: Int,
) -> Verdict {
  case existing {
    None -> Create
    Some(e) -> {
      let fresh =
        list.map(changes, fn(c) { c.0 })
        |> list.sort(string.compare)
        |> list.filter(fn(f) { !list.contains(e.fingerprints, f) })
      case e.status {
        item_row.Reviewed | item_row.Dismissed | item_row.Expired ->
          case fresh {
            [] -> Suppress("same_evidence_already_handled")
            _ -> {
              let handled_at =
                option.or(e.dismissed_at, e.reviewed_at)
                |> option.unwrap(e.updated_at)
              let substantial =
                list.any(changes, fn(c) {
                  list.contains(fresh, c.0) && is_substantial(c.1)
                })
              case now - handled_at < cooldown_days * day_ms && !substantial {
                True -> Suppress("within_cooldown")
                False -> Reopen(fresh)
              }
            }
          }
        item_row.ReopenedRoom -> Suppress("club_already_acted")
        item_row.Open ->
          case fresh {
            [] -> Unchanged
            _ -> Update(fresh)
          }
      }
    }
  }
}

/// An open item lapses once nothing has changed for `expiry_days`.
pub fn expired(
  status: item_row.Status,
  latest_change_at: Int,
  now: Int,
) -> Bool {
  status == item_row.Open && now - latest_change_at > expiry_days * day_ms
}

/// The item's fields without the organisation's id (safeM18Projection): a view never shows whose item it is.
pub fn safe_projection(fields: List(#(String, Json))) -> List(#(String, Json)) {
  list.filter(fields, fn(f) { f.0 != "orgId" })
}

/// The queue's order: by kind, then the newest change, then the id. None of it is a quality rank.
pub fn compare_items(
  a: #(Kind, Int, String),
  b: #(Kind, Int, String),
) -> order.Order {
  int.compare(kind_rank(a.0), kind_rank(b.0))
  |> order.lazy_break_tie(fn() { int.compare(b.1, a.1) })
  |> order.lazy_break_tie(fn() { string.compare(a.2, b.2) })
}
