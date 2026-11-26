//// Checks of the rules from the rules suites of operations/clubOperations, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/battery/base
import scoutbox/rules/age

// clubOperations: ageOn — boundary: a 16-year-old is NOT an adult (GB)
pub fn boundary_a_16_year_old_is_not_an_adult_gb_test() {
  assert age.age_on(base.day("2010-09-09"), 1_788_955_200_000) == 16
}

// clubOperations: isAdult — boundary: a 16-year-old is NOT an adult (GB)
pub fn boundary_a_16_year_old_is_not_an_adult_gb_2_test() {
  assert age.is_adult(base.day("2010-09-09"), "GB", 1_788_955_200_000) == False
}

// clubOperations: ageOn — boundary: a 17-year-old is NOT an adult (GB)
pub fn boundary_a_17_year_old_is_not_an_adult_gb_test() {
  assert age.age_on(base.day("2009-09-09"), 1_788_955_200_000) == 17
}

// clubOperations: isAdult — boundary: a 17-year-old is NOT an adult (GB)
pub fn boundary_a_17_year_old_is_not_an_adult_gb_2_test() {
  assert age.is_adult(base.day("2009-09-09"), "GB", 1_788_955_200_000) == False
}

// clubOperations: isAdult — boundary: 18th birthday today IS adult (GB)
pub fn boundary_18th_birthday_today_is_adult_gb_test() {
  assert age.is_adult(base.day("2008-09-09"), "GB", 1_788_955_200_000) == True
}

// clubOperations: isAdult — boundary: 18 years minus one day is NOT adult
pub fn boundary_18_years_minus_one_day_is_not_adult_test() {
  assert age.is_adult(base.day("2008-09-10"), "GB", 1_788_955_200_000) == False
}

// clubOperations: isAdult — boundary: 18 in KR (majority 19) is NOT adult
pub fn boundary_18_in_kr_majority_19_is_not_adult_test() {
  assert age.is_adult(base.day("2008-09-09"), "KR", 1_788_955_200_000) == False
}
