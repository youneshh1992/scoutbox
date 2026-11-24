//// Checks of the rules from the rules suites of recruitment/offers, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{Some}
import scoutbox/battery/base
import scoutbox/platform/temporal

// offers: parseInstant — A46b and resolves to the same instant in every server zone
pub fn a46b_and_resolves_to_the_same_instant_in_every_server_zone_test() {
  assert temporal.instant(
      base.body("\"2026-03-08T02:30:00-05:00\""),
      1900,
      2100,
    )
    == Ok(1_772_955_000_000)
}

// offers: parseInstant — A46b and resolves to the same instant in every server zone
pub fn a46b_and_resolves_to_the_same_instant_in_every_server_zone_2_test() {
  assert temporal.instant(base.body("\"2026-03-08T07:30:00Z\""), 1900, 2100)
    == Ok(1_772_955_000_000)
}

// offers: isExpiredAt — A50b the boundary instant follows the ONE temporal helper
pub fn a50b_the_boundary_instant_follows_the_one_temporal_helper_test() {
  assert temporal.is_expired_at(Some(1_800_086_400_000), 1_800_086_400_000)
    == True
}
