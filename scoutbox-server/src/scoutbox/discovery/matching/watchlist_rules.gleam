//// Dynamic Watchlists, the pure part (domains/discovery/matching/watchlists.mjs). A watchlist is saved criteria;
//// membership is derived on every read, because a stored list goes stale when a player is blocked, ages out or
//// their evidence expires. There is no scheduler, so membership is correct as of the last read, and the UI says
//// when that was.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/set
import gleam/string
import scoutbox/discovery/matching/criteria
import scoutbox/rows/dynamic_watchlists as row
import scoutbox/rows/watchlist_membership_events as event_row
import scoutbox/vocab/brief_status.{type BriefStatus}

/// None of these says whether the player got better or worse.
pub fn entry_text(r: event_row.Reason) -> String {
  case r {
    event_row.CriterionNowMet -> "A required criterion is now met"
    event_row.CriteriaChanged -> "The saved criteria changed"
    event_row.BriefChanged -> "The linked Recruitment Brief changed"
    event_row.NewlyVisible -> "The player became visible to your organisation"
    event_row.FirstEvaluation -> "First time this watchlist was evaluated"
    event_row.CriterionNoLongerMet -> "A required criterion is no longer met"
    event_row.Unavailable -> unavailable_text
  }
}

/// Losing visibility can mean the player blocked this club, a safeguarding rule changed, or the account was
/// removed. Naming which would leak what the rule protects, so all of them surface as `unavailable`.
const unavailable_text = "This player is no longer available in this watchlist"

// --------------------------------------------------------------------------------------------------- reconcile

pub type Diff {
  Diff(
    entered: List(String),
    left: List(String),
    unchanged: List(String),
    changed: Bool,
  )
}

/// reconcileMembership: sorted, so two reconciliations of the same change produce the same output and fingerprints.
pub fn reconcile(previous: List(String), current: List(String)) -> Diff {
  let before = set.from_list(previous)
  let after = set.from_list(current)
  let sorted = list.sort(_, criteria.utf16_compare)
  let entered =
    list.filter(current, fn(p) { !set.contains(before, p) }) |> sorted
  let left = list.filter(previous, fn(p) { !set.contains(after, p) }) |> sorted
  let unchanged = list.filter(current, set.contains(before, _)) |> sorted
  Diff(entered:, left:, unchanged:, changed: entered != [] || left != [])
}

pub fn diff_json(d: Diff) -> Json {
  json.object([
    #("entered", json.array(d.entered, json.string)),
    #("left", json.array(d.left, json.string)),
    #("unchanged", json.array(d.unchanged, json.string)),
    #("changed", json.bool(d.changed)),
  ])
}

/// transitionFingerprint: the same transition under the same criteria has the same fingerprint, so it is not
/// notified twice.
pub fn fingerprint(
  watchlist_id: String,
  player_id: String,
  criteria_version: String,
  transition: event_row.Transition,
  reason: event_row.Reason,
) -> String {
  string.join(
    [
      "wl",
      watchlist_id,
      player_id,
      criteria_version,
      event_row.transition_to_string(transition),
      event_row.reason_to_string(reason),
    ],
    ":",
  )
}

// ----------------------------------------------------------------------------------------------------- explain

/// One required criterion's outcome, as a match remembers it.
pub type Met {
  Met(criterion_id: String, met: Bool, text: String)
}

pub type Explanation {
  Explanation(
    reason: event_row.Reason,
    criterion_id: Option(String),
    text: String,
  )
}

/// explainTransition: names the criterion that flipped. When the criteria set itself changed, comparing criterion
/// by criterion would mislead, so `criteria_changed` short-circuits it.
pub fn explain(
  previous: Option(List(Met)),
  current: Option(List(Met)),
  criteria_changed: Bool,
  brief_changed: Bool,
  transition: event_row.Transition,
) -> Explanation {
  let entered = transition == event_row.Entered
  let because = fn(reason) { Explanation(reason, None, entry_text(reason)) }
  let named = fn(reason, flipped: List(Met)) {
    case flipped {
      [first, ..] ->
        Explanation(
          reason,
          Some(first.criterion_id),
          list.map(flipped, fn(r) { r.text }) |> string.join(" · "),
        )
      [] -> because(reason)
    }
  }
  case brief_changed, criteria_changed, entered {
    True, _, _ -> because(event_row.BriefChanged)
    False, True, _ -> because(event_row.CriteriaChanged)
    False, False, True ->
      case previous {
        None -> because(event_row.NewlyVisible)
        Some(before) -> {
          let was_unmet = fn(id) {
            list.any(before, fn(b) { b.criterion_id == id && !b.met })
          }
          let flipped =
            option.unwrap(current, [])
            |> list.filter(fn(r) { r.met && was_unmet(r.criterion_id) })
          named(event_row.CriterionNowMet, flipped)
        }
      }
    // No longer visible; why is not ours to say.
    False, False, False ->
      case current {
        None -> because(event_row.Unavailable)
        Some(now) ->
          case list.filter(now, fn(r) { !r.met }) {
            [] -> because(event_row.Unavailable)
            failed -> named(event_row.CriterionNoLongerMet, failed)
          }
      }
  }
}

pub fn explanation_json(e: Explanation) -> Json {
  json.object([
    #("reason", event_row.reason_to_json(e.reason)),
    #("criterionId", json.nullable(e.criterion_id, json.string)),
    #("text", json.string(e.text)),
  ])
}

// ----------------------------------------------------------------------------------------------------- summary

const summary_note =
  "Counts of players against criteria your organisation wrote. Entering a watchlist is not an improvement in a player, and leaving one is not a decline."

/// membershipSummary's fields, by count.
pub fn summary_fields(
  entered: Int,
  left: Int,
  unchanged: Int,
) -> List(#(String, Json)) {
  [
    #("newlyMatched", json.int(entered)),
    #("noLongerMatches", json.int(left)),
    #("unchanged", json.int(unchanged)),
    #("current", json.int(entered + unchanged)),
    #("note", json.string(summary_note)),
  ]
}

pub fn summary(entered: Int, left: Int, unchanged: Int) -> Json {
  json.object(summary_fields(entered, left, unchanged))
}

/// Why membership changed, as one notification says it.
pub type Cause {
  CriteriaEdited
  BriefEdited
  FactsChanged
}

/// membershipNotification: at most one notification per watchlist, so 25 players entering after a brief edit is
/// one sentence. None when nothing changed.
pub fn notification(
  watchlist_name: String,
  entered: Int,
  left: Int,
  cause: Cause,
) -> Option(String) {
  let parts =
    list.flatten([
      case entered {
        0 -> []
        1 -> ["1 player now matches"]
        n -> [int.to_string(n) <> " players now match"]
      },
      case left {
        0 -> []
        1 -> ["1 no longer matches"]
        n -> [int.to_string(n) <> " no longer match"]
      },
    ])
  let tail = case cause {
    BriefEdited -> " after the linked Recruitment Brief changed"
    CriteriaEdited -> " after the criteria changed"
    FactsChanged -> ""
  }
  case parts {
    [] -> None
    _ ->
      Some(
        string.join(parts, ", ") <> " “" <> watchlist_name <> "”" <> tail <> ".",
      )
  }
}

pub fn notification_json(
  text: Option(String),
  entered: Int,
  left: Int,
) -> Json {
  case text {
    None -> json.null()
    Some(t) ->
      json.object([
        #("text", json.string(t)),
        #("grouped", json.bool(True)),
        #("entered", json.int(entered)),
        #("left", json.int(left)),
      ])
  }
}

// ----------------------------------------------------------------------------------------------------- blocked

/// What a linked brief is, when the watchlist follows one: gone, or there with its status.
pub type Link {
  NotLinked
  LinkedTo(Option(BriefStatus))
}

/// watchlistBlockedState: a watchlist that cannot produce matches says why, rather than showing zero as "no
/// players match".
pub fn blocked_state(status: row.Status, link: Link) -> Json {
  let blocked = fn(code, message) {
    json.object([
      #("blocked", json.bool(True)),
      #("code", json.string(code)),
      #("message", json.string(message)),
    ])
  }
  case status, link {
    row.Archived, _ ->
      blocked(
        "WATCHLIST_ARCHIVED",
        "This watchlist is archived. Its history is kept; membership is no longer maintained.",
      )
    row.Paused, _ ->
      json.object([
        #("blocked", json.bool(False)),
        #("paused", json.bool(True)),
        #("code", json.string("WATCHLIST_PAUSED")),
        #(
          "message",
          json.string(
            "This watchlist is paused. Membership is still shown, and no change notifications are sent.",
          ),
        ),
      ])
    _, LinkedTo(None) ->
      blocked(
        "WATCHLIST_BRIEF_UNAVAILABLE",
        "The linked Recruitment Brief is no longer available. Membership cannot be maintained until the link is changed.",
      )
    _, LinkedTo(Some(s)) if s != brief_status.Active ->
      blocked(
        "WATCHLIST_BRIEF_INACTIVE",
        "The linked Recruitment Brief is "
          <> brief_status.to_string(s)
          <> ". Activate it, or switch this watchlist to its own saved criteria.",
      )
    _, _ -> json.object([#("blocked", json.bool(False))])
  }
}

/// Whether the state stops membership being maintained.
pub fn is_blocked(status: row.Status, link: Link) -> Bool {
  case status, link {
    row.Archived, _ -> True
    row.Paused, _ -> False
    _, LinkedTo(None) -> True
    _, LinkedTo(Some(s)) -> s != brief_status.Active
    _, NotLinked -> False
  }
}
