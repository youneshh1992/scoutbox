//// The Second Look rules' checks that couldn't be recorded as cases, ported by hand.

import gleam/option.{None, Some}
import scoutbox/discovery/second_look_rules as rules
import scoutbox/rows/id

const day_ms = 86_400_000

fn decided(at: Int) -> rules.Decided {
  rules.Decided(id: id.room_decision("d1"), at:, reason_codes: [
    "insufficient_recent_evidence",
  ])
}

/// buildSecondLookCandidate({ room: null, … }) is null. Here a candidate is built from a Room's id and a decision,
/// both required, so a call without a Room can't be written; what can be written without one is a Room that has
/// not ended, which is no candidate either.
pub fn no_ended_room_is_no_candidate_test() {
  let now = 1_800_000_000_000
  let assert Some(full_match) =
    rules.change(rules.FullMatchAdded, "evidence", Some("ev-1"), now - day_ms)
  let candidate = fn(status) {
    rules.candidate(
      id.recruitment_case("case-1"),
      id.player("pl-1"),
      status,
      True,
      decided(now - 10 * day_ms),
      [full_match],
      now,
    )
  }
  let assert Some(_) = candidate("archived")
  assert candidate("under_review") == None
  assert candidate("") == None
}
