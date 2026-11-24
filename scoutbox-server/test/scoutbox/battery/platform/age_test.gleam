//// Checks of the rules from the rules suites of platform/contracts, platform/dates, first generated from the
//// TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/result
import scoutbox/battery/base
import scoutbox/platform/temporal
import scoutbox/rules/age

// contracts: ageOn — a person is 18 from the first UTC instant of their 18th birthday
pub fn a_person_is_18_from_the_first_utc_instant_of_their_18th_birthday_test() {
  assert age.age_on(base.day("2008-03-14"), 1_773_446_400_000) == 18
}

// contracts: ageOn — [neg] one second earlier they are 17 — in every time zone the server runs in
pub fn neg_one_second_earlier_they_are_17_in_every_time_zone_the_server_runs_in_test() {
  assert age.age_on(base.day("2008-03-14"), 1_773_446_399_000) == 17
}

// contracts: ageOn — [neg] a host in New York at 23:00 local on the 14th (04:00Z on the 15th) still says 18, not a day off
pub fn neg_a_host_in_new_york_at_23_00_local_on_the_14th_04_00z_on_the_15th_sti_test() {
  assert age.age_on(base.day("2008-03-14"), 1_773_547_200_000) == 18
}

// contracts: ageOn — a leap-day birth is 17 on 28 February of a common year
pub fn a_leap_day_birth_is_17_on_28_february_of_a_common_year_test() {
  assert age.age_on(base.day("2008-02-29"), 1_772_280_000_000) == 17
}

// contracts: ageOn — and 18 on 1 March — the birthday is never skipped
pub fn and_18_on_1_march_the_birthday_is_never_skipped_test() {
  assert age.age_on(base.day("2008-02-29"), 1_772_323_200_000) == 18
}

// contracts: ageOn — and on a real 29 February the maths is exact
pub fn and_on_a_real_29_february_the_maths_is_exact_test() {
  assert age.age_on(base.day("2008-02-29"), 1_835_395_200_000) == 20
}

// contracts: adultAgeFor — majority: 18 by default, 19 in Korea
pub fn majority_18_by_default_19_in_korea_test() {
  assert age.adult_age_for("GB") == 18
}

// contracts: adultAgeFor — majority: 18 by default, 19 in Korea
pub fn majority_18_by_default_19_in_korea_2_test() {
  assert age.adult_age_for("KR") == 19
}

// contracts: adultAgeFor — majority: 18 by default, 19 in Korea
pub fn majority_18_by_default_19_in_korea_3_test() {
  assert age.adult_age_for("XX") == 18
}

// contracts: isAdult — a British 18-year-old is an adult
pub fn a_british_18_year_old_is_an_adult_test() {
  assert age.is_adult(base.day("2008-03-14"), "GB", 1_773_446_400_000) == True
}

// contracts: isAdult — [neg] a Korean 18-year-old is NOT — the same date of birth, a different rule
pub fn neg_a_korean_18_year_old_is_not_the_same_date_of_birth_a_different_rule_test() {
  assert age.is_adult(base.day("2008-03-14"), "KR", 1_773_446_400_000) == False
}

// contracts: isAdult — and becomes one at 19
pub fn and_becomes_one_at_19_test() {
  assert age.is_adult(base.day("2008-03-14"), "KR", 1_804_982_400_000) == True
}

// dates: ageOn — A6 domain.ageOn IS temporal.ageOnMs (18 on the 18th birthday, UTC)
pub fn a6_domain_ageon_is_temporal_ageonms_18_on_the_18th_birthday_utc_test() {
  assert age.age_on(base.day("2008-09-23"), 1_790_164_800_000) == 18
}

// dates: ageOnMs — A6 domain.ageOn IS temporal.ageOnMs (18 on the 18th birthday, UTC)
pub fn a6_domain_ageon_is_temporal_ageonms_18_on_the_18th_birthday_utc_2_test() {
  assert age.age_on(base.day("2008-09-23"), 1_790_164_800_000) == 18
}

// dates: ageOn — C3 18 on the birthday (UTC), 17 the day before
pub fn c3_18_on_the_birthday_utc_17_the_day_before_test() {
  assert age.age_on(base.day("2008-09-24"), 1_790_164_800_000) == 17
}

// dates: isAdult — C4 GB: adult at 18, not at 17y364d
pub fn c4_gb_adult_at_18_not_at_17y364d_test() {
  assert age.is_adult(base.day("2008-09-23"), "GB", 1_790_164_800_000) == True
}

// dates: isAdult — C4 GB: adult at 18, not at 17y364d
pub fn c4_gb_adult_at_18_not_at_17y364d_2_test() {
  assert age.is_adult(base.day("2008-09-24"), "GB", 1_790_164_800_000) == False
}

// dates: isAdult — C5 KR: adult at 19 — an 18-year-old is a minor there
pub fn c5_kr_adult_at_19_an_18_year_old_is_a_minor_there_test() {
  assert age.is_adult(base.day("2007-09-23"), "KR", 1_790_164_800_000) == True
}

// dates: isAdult — C5 KR: adult at 19 — an 18-year-old is a minor there
pub fn c5_kr_adult_at_19_an_18_year_old_is_a_minor_there_2_test() {
  assert age.is_adult(base.day("2007-09-24"), "KR", 1_790_164_800_000) == False
}

// dates: isAdult — C5 KR: adult at 19 — an 18-year-old is a minor there
pub fn c5_kr_adult_at_19_an_18_year_old_is_a_minor_there_3_test() {
  assert age.is_adult(base.day("2008-09-23"), "KR", 1_790_164_800_000) == False
}

// dates: ageOn — C6 a 29 February birthday counts on 1 March in a non-leap year
pub fn c6_a_29_february_birthday_counts_on_1_march_in_a_non_leap_year_test() {
  assert age.age_on(base.day("2008-02-29"), 1_772_236_800_000) == 17
}

// dates: parseDobStrict — [neg] C7 a date of birth in the future is refused
pub fn neg_c7_a_date_of_birth_in_the_future_is_refused_test() {
  assert result.map(age.parse_dob("2030-01-01", 1_790_164_800_000), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(age.InTheFuture)
}

// dates: parseDobStrict — [neg] C7b a 126-year-old is refused
pub fn neg_c7b_a_126_year_old_is_refused_test() {
  assert result.map(age.parse_dob("1900-01-01", 1_790_164_800_000), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(age.ImplausiblyOld)
}

// dates: parseDobStrict — C7c a 119-year-old is accepted — the bound is a bound, not a guess
pub fn c7c_a_119_year_old_is_accepted_the_bound_is_a_bound_not_a_guess_test() {
  assert result.map(age.parse_dob("1906-09-24", 1_790_164_800_000), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1906-09-24", -1_996_704_000_000))
}

// dates: parseDobStrict — C7d born today is accepted
pub fn c7d_born_today_is_accepted_test() {
  assert result.map(age.parse_dob("2026-09-23", 1_790_164_800_000), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2026-09-23", 1_790_121_600_000))
}
