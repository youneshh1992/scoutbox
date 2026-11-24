//// Checks of the rules from the rules suites of operations/clubOperations, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/scouting/suitability

// clubOperations: slotsOverlap — tz-aware overlap: NY morning hits UTC afternoon
pub fn tz_aware_overlap_ny_morning_hits_utc_afternoon_test() {
  assert suitability.slots_overlap(
      suitability.Slot(
        day: "tue",
        start: "10:00",
        end: "11:00",
        tz: "America/New_York",
        label: None,
      ),
      suitability.Slot(
        day: "tue",
        start: "15:30",
        end: "16:30",
        tz: "UTC",
        label: None,
      ),
    )
    == Some(True)
}

// clubOperations: slotsOverlap — same wall-clock in different zones does NOT overlap
pub fn same_wall_clock_in_different_zones_does_not_overlap_test() {
  assert suitability.slots_overlap(
      suitability.Slot(
        day: "tue",
        start: "10:00",
        end: "11:00",
        tz: "America/New_York",
        label: None,
      ),
      suitability.Slot(
        day: "tue",
        start: "10:00",
        end: "11:00",
        tz: "UTC",
        label: None,
      ),
    )
    == Some(False)
}

// clubOperations: slotsOverlap — week-boundary wrap via tz shift still compares
pub fn week_boundary_wrap_via_tz_shift_still_compares_test() {
  assert suitability.slots_overlap(
      suitability.Slot(
        day: "mon",
        start: "01:00",
        end: "02:00",
        tz: "Pacific/Auckland",
        label: None,
      ),
      suitability.Slot(
        day: "sun",
        start: "12:30",
        end: "13:30",
        tz: "UTC",
        label: None,
      ),
    )
    == Some(True)
}

// clubOperations: slotsOverlap — malformed slot yields UNKNOWN, not false
pub fn malformed_slot_yields_unknown_not_false_test() {
  assert suitability.slots_overlap(
      suitability.Slot(
        day: "xxx",
        start: "01:00",
        end: "02:00",
        tz: "UTC",
        label: None,
      ),
      suitability.Slot(
        day: "tue",
        start: "10:00",
        end: "11:00",
        tz: "America/New_York",
        label: None,
      ),
    )
    == None
}
