//// Checks of the rules from the rules suites of agents/adversarial, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/battery/base
import scoutbox/rules/age

// adversarial: ageOn — AD8e while a REAL leap day still reads — strict is not the same as broken
pub fn ad8e_while_a_real_leap_day_still_reads_strict_is_not_the_same_as_broken_test() {
  assert age.age_on(base.day("2012-02-29"), 1_789_862_400_000) == 14
}
