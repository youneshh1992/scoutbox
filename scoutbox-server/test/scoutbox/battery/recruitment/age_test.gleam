//// Checks of the rules from the rules suites of recruitment/journeyAdversarial, recruitment/offers,
//// recruitment/offersAdversarial, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/battery/base
import scoutbox/rules/age

// journeyAdversarial: isAdult — [neg] M7 null, false, 0, a malformed string, an impossible date, a future date, "", "NaN" and a number are each NOT adult
pub fn neg_m7_null_false_0_a_malformed_string_an_impossible_date_a_future_date_test() {
  assert age.is_adult(base.day("2099-01-01"), "GB", 1_794_744_000_000) == False
}

// journeyAdversarial: isAdult — M7b a real adult date is adult
pub fn m7b_a_real_adult_date_is_adult_test() {
  assert age.is_adult(base.day("2000-01-01"), "GB", 1_794_744_000_000) == True
}

// offers: isAdult — [neg] A91 dob "2030-01-01" does not make an adult (#51)
pub fn neg_a91_dob_2030_01_01_does_not_make_an_adult_51_test() {
  assert age.is_adult(base.day("2030-01-01"), "GB", 1_800_000_000_000) == False
}

// offers: isAdult — A91b a real adult date does
pub fn a91b_a_real_adult_date_does_test() {
  assert age.is_adult(base.day("2004-03-14"), "GB", 1_800_000_000_000) == True
}

// offersAdversarial: adultAgeFor — S-p3 GB 18, KR 19
pub fn s_p3_gb_18_kr_19_test() {
  assert age.adult_age_for("GB") == 18
}

// offersAdversarial: adultAgeFor — S-p3 GB 18, KR 19
pub fn s_p3_gb_18_kr_19_2_test() {
  assert age.adult_age_for("KR") == 19
}

// offersAdversarial: isAdult — [neg] S-p4 GB: the day before the 18th birthday is not an adult
pub fn neg_s_p4_gb_the_day_before_the_18th_birthday_is_not_an_adult_test() {
  assert age.is_adult(base.day("2008-03-15"), "GB", 1_773_489_600_000) == False
}

// offersAdversarial: isAdult — S-p5 GB: the 18th birthday is
pub fn s_p5_gb_the_18th_birthday_is_test() {
  assert age.is_adult(base.day("2008-03-15"), "GB", 1_773_576_000_000) == True
}

// offersAdversarial: isAdult — S-p6 GB: the day after is
pub fn s_p6_gb_the_day_after_is_test() {
  assert age.is_adult(base.day("2008-03-15"), "GB", 1_773_662_400_000) == True
}

// offersAdversarial: isAdult — [neg] S-p7 KR: the day before the 19th birthday is not
pub fn neg_s_p7_kr_the_day_before_the_19th_birthday_is_not_test() {
  assert age.is_adult(base.day("2007-03-15"), "KR", 1_773_489_600_000) == False
}

// offersAdversarial: isAdult — S-p8 KR: the 19th birthday and after are
pub fn s_p8_kr_the_19th_birthday_and_after_are_test() {
  assert age.is_adult(base.day("2007-03-15"), "KR", 1_773_576_000_000) == True
}

// offersAdversarial: isAdult — S-p8 KR: the 19th birthday and after are
pub fn s_p8_kr_the_19th_birthday_and_after_are_2_test() {
  assert age.is_adult(base.day("2007-03-15"), "KR", 1_773_662_400_000) == True
}

// offersAdversarial: isAdult — [neg] S-p9 the boundary is a calendar day in UTC, not a zone-shifted instant (local midnight in UTC+14 is still the 14th in UTC; 23:59 in UTC-5 is already the 15th)
pub fn neg_s_p9_the_boundary_is_a_calendar_day_in_utc_not_a_zone_shifted_instan_test() {
  assert age.is_adult(base.day("2008-03-15"), "GB", 1_773_482_400_000) == False
}

// offersAdversarial: isAdult — [neg] S-p9 the boundary is a calendar day in UTC, not a zone-shifted instant (local midnight in UTC+14 is still the 14th in UTC; 23:59 in UTC-5 is already the 15th)
pub fn neg_s_p9_the_boundary_is_a_calendar_day_in_utc_not_a_zone_shifted_instan_2_test() {
  assert age.is_adult(base.day("2008-03-15"), "GB", 1_773_550_799_000) == True
}

// offersAdversarial: isAdult — [neg] S-p10 dob "2030-01-01" never makes an adult
pub fn neg_s_p10_dob_2030_01_01_never_makes_an_adult_test() {
  assert age.is_adult(base.day("2030-01-01"), "GB", 1_780_315_200_000) == False
}
