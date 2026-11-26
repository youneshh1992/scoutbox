//// Checks of the rules from the rules suites of discovery/matchingAndWatchlists, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/battery/base
import scoutbox/rules/age

// matchingAndWatchlists: ageOn — age flips on the birthday itself, in UTC (17 → 18)
pub fn age_flips_on_the_birthday_itself_in_utc_17_18_test() {
  assert age.age_on(base.day("2008-06-01"), 1_780_185_600_000) == 17
}

// matchingAndWatchlists: ageOn — age flips on the birthday itself, in UTC (17 → 18)
pub fn age_flips_on_the_birthday_itself_in_utc_17_18_2_test() {
  assert age.age_on(base.day("2008-06-01"), 1_780_272_000_000) == 18
}
