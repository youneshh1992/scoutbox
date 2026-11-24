//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/temporal

// dates: parseDob — A5 domain.parseDob and temporal.parseStrictDateOnly refuse the same day
pub fn a5_domain_parsedob_and_temporal_parsestrictdateonly_refuse_the_same_day_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2010-02-30"),
      temporal.day_text,
    ))
    == None
}

// dates: parseStrictDateOnly — A5 domain.parseDob and temporal.parseStrictDateOnly refuse the same day
pub fn a5_domain_parsedob_and_temporal_parsestrictdateonly_refuse_the_same_day_2_test() {
  assert result.map(temporal.parse_day_between("2010-02-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseInstant — A8 the Trial instant parser IS the platform instant parser
pub fn a8_the_trial_instant_parser_is_the_platform_instant_parser_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:00\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — A8 the Trial instant parser IS the platform instant parser
pub fn a8_the_trial_instant_parser_is_the_platform_instant_parser_2_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:00Z\""), 1900, 2100)
    == Ok(1_772_359_200_000)
}

// dates: parseStrictDateOnly — A9 the Trial date keeps its own 2000–2100 bound on top of the platform bound
pub fn a9_the_trial_date_keeps_its_own_2000_2100_bound_on_top_of_the_platform_b_test() {
  assert result.map(temporal.parse_day_between("1999-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1999-12-31", 946_598_400_000))
}

// dates: parseStrictDateOnly — [neg] B1 "2011-04-31" is not a calendar day (no such day in that month)
pub fn neg_b1_2011_04_31_is_not_a_calendar_day_no_such_day_in_that_month_test() {
  assert result.map(temporal.parse_day_between("2011-04-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — [neg] B1 "2019-02-29" is not a calendar day (no such day in that month)
pub fn neg_b1_2019_02_29_is_not_a_calendar_day_no_such_day_in_that_month_test() {
  assert result.map(temporal.parse_day_between("2019-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-13-01" is not a calendar day (no such month)
pub fn neg_b1_2023_13_01_is_not_a_calendar_day_no_such_month_test() {
  assert result.map(temporal.parse_day_between("2023-13-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-00-10" is not a calendar day (no such month)
pub fn neg_b1_2023_00_10_is_not_a_calendar_day_no_such_month_test() {
  assert result.map(temporal.parse_day_between("2023-00-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-01-00" is not a calendar day (no such day)
pub fn neg_b1_2023_01_00_is_not_a_calendar_day_no_such_day_test() {
  assert result.map(temporal.parse_day_between("2023-01-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-01-32" is not a calendar day (no such day)
pub fn neg_b1_2023_01_32_is_not_a_calendar_day_no_such_day_test() {
  assert result.map(temporal.parse_day_between("2023-01-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — [neg] B1 "02/03/2010" is not a calendar day (wrong shape)
pub fn neg_b1_02_03_2010_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(temporal.parse_day_between("02/03/2010", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-1-5" is not a calendar day (wrong shape)
pub fn neg_b1_2023_1_5_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(temporal.parse_day_between("2023-1-5", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-01-05T00:00:00Z" is not a calendar day (wrong shape)
pub fn neg_b1_2023_01_05t00_00_00z_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(
      temporal.parse_day_between("2023-01-05T00:00:00Z", 1900, 2100),
      fn(d) { #(temporal.day_text(d), temporal.day_start(d)) },
    )
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 "20230105" is not a calendar day (wrong shape)
pub fn neg_b1_20230105_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(temporal.parse_day_between("20230105", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 " 2023-01-05" is not a calendar day (wrong shape)
pub fn neg_b1_2023_01_05_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(
      temporal.parse_day_between(" 2023-01-05", 1900, 2100),
      fn(d) { #(temporal.day_text(d), temporal.day_start(d)) },
    )
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 "2023-01-05 " is not a calendar day (wrong shape)
pub fn neg_b1_2023_01_05_is_not_a_calendar_day_wrong_shape_2_test() {
  assert result.map(
      temporal.parse_day_between("2023-01-05 ", 1900, 2100),
      fn(d) { #(temporal.day_text(d), temporal.day_start(d)) },
    )
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 "1899-12-31" is not a calendar day (year outside 1900–2100)
pub fn neg_b1_1899_12_31_is_not_a_calendar_day_year_outside_1900_2100_test() {
  assert result.map(temporal.parse_day_between("1899-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayYearOutside(1900, 2100))
}

// dates: parseStrictDateOnly — [neg] B1 "2101-01-01" is not a calendar day (year outside 1900–2100)
pub fn neg_b1_2101_01_01_is_not_a_calendar_day_year_outside_1900_2100_test() {
  assert result.map(temporal.parse_day_between("2101-01-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayYearOutside(1900, 2100))
}

// dates: parseStrictDateOnly — [neg] B1 "" is not a calendar day (wrong shape)
pub fn neg_b1_is_not_a_calendar_day_wrong_shape_test() {
  assert result.map(temporal.parse_day_between("", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayWrongShape)
}

// dates: parseStrictDateOnly — [neg] B1 null is not a calendar day (not text)
pub fn neg_b1_null_is_not_a_calendar_day_not_text_test() {
  assert result.map(temporal.read_day(base.body("null")), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayNotText)
}

// dates: parseStrictDateOnly — [neg] B1 20230105 is not a calendar day (not text)
pub fn neg_b1_20230105_is_not_a_calendar_day_not_text_test() {
  assert result.map(temporal.read_day(base.body("20230105")), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayNotText)
}

// dates: parseStrictDateOnly — [neg] B1 {} is not a calendar day (not text)
pub fn neg_b1_is_not_a_calendar_day_not_text_test() {
  assert result.map(temporal.read_day(base.body("{}")), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayNotText)
}

// dates: parseStrictDateOnly — [neg] B1 [] is not a calendar day (not text)
pub fn neg_b1_is_not_a_calendar_day_not_text_2_test() {
  assert result.map(temporal.read_day(base.body("[]")), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayNotText)
}

// dates: parseStrictDateOnly — [neg] B1 true is not a calendar day (not text)
pub fn neg_b1_true_is_not_a_calendar_day_not_text_test() {
  assert result.map(temporal.read_day(base.body("true")), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.DayNotText)
}

// dates: parseStrictDateOnly — B2 2000-02-29 is a calendar day
pub fn b2_2000_02_29_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2000-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-29", 951_782_400_000))
}

// dates: parseStrictDateOnly — B2 2020-02-29 is a calendar day
pub fn b2_2020_02_29_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2020-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2020-02-29", 1_582_934_400_000))
}

// dates: parseStrictDateOnly — B2 2024-02-29 is a calendar day
pub fn b2_2024_02_29_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2024-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-29", 1_709_164_800_000))
}

// dates: parseStrictDateOnly — B2 1900-01-01 is a calendar day
pub fn b2_1900_01_01_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("1900-01-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-01", -2_208_988_800_000))
}

// dates: parseStrictDateOnly — B2 2100-12-31 is a calendar day
pub fn b2_2100_12_31_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2100-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2100-12-31", 4_133_894_400_000))
}

// dates: parseStrictDateOnly — B2 2023-04-30 is a calendar day
pub fn b2_2023_04_30_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2023-04-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-30", 1_682_812_800_000))
}

// dates: parseStrictDateOnly — B2 2023-12-31 is a calendar day
pub fn b2_2023_12_31_is_a_calendar_day_test() {
  assert result.map(temporal.parse_day_between("2023-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-31", 1_703_980_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_test() {
  assert result.map(temporal.parse_day_between("1900-00-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_2_test() {
  assert result.map(temporal.parse_day_between("1900-00-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_3_test() {
  assert result.map(temporal.parse_day_between("1900-00-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_4_test() {
  assert result.map(temporal.parse_day_between("1900-00-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_5_test() {
  assert result.map(temporal.parse_day_between("1900-00-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_6_test() {
  assert result.map(temporal.parse_day_between("1900-00-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_7_test() {
  assert result.map(temporal.parse_day_between("1900-00-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_8_test() {
  assert result.map(temporal.parse_day_between("1900-00-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_9_test() {
  assert result.map(temporal.parse_day_between("1900-00-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_10_test() {
  assert result.map(temporal.parse_day_between("1900-00-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_11_test() {
  assert result.map(temporal.parse_day_between("1900-00-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_12_test() {
  assert result.map(temporal.parse_day_between("1900-00-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_13_test() {
  assert result.map(temporal.parse_day_between("1900-00-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_14_test() {
  assert result.map(temporal.parse_day_between("1900-00-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_15_test() {
  assert result.map(temporal.parse_day_between("1900-00-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_16_test() {
  assert result.map(temporal.parse_day_between("1900-00-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_17_test() {
  assert result.map(temporal.parse_day_between("1900-00-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_18_test() {
  assert result.map(temporal.parse_day_between("1900-00-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_19_test() {
  assert result.map(temporal.parse_day_between("1900-00-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_20_test() {
  assert result.map(temporal.parse_day_between("1900-00-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_21_test() {
  assert result.map(temporal.parse_day_between("1900-00-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_22_test() {
  assert result.map(temporal.parse_day_between("1900-00-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_23_test() {
  assert result.map(temporal.parse_day_between("1900-00-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_24_test() {
  assert result.map(temporal.parse_day_between("1900-00-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_25_test() {
  assert result.map(temporal.parse_day_between("1900-00-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_26_test() {
  assert result.map(temporal.parse_day_between("1900-00-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_27_test() {
  assert result.map(temporal.parse_day_between("1900-00-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_28_test() {
  assert result.map(temporal.parse_day_between("1900-00-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_29_test() {
  assert result.map(temporal.parse_day_between("1900-00-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_30_test() {
  assert result.map(temporal.parse_day_between("1900-00-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_31_test() {
  assert result.map(temporal.parse_day_between("1900-00-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_32_test() {
  assert result.map(temporal.parse_day_between("1900-00-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_33_test() {
  assert result.map(temporal.parse_day_between("1900-00-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_34_test() {
  assert result.map(temporal.parse_day_between("1900-01-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_35_test() {
  assert result.map(temporal.parse_day_between("1900-01-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-02", -2_208_902_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_36_test() {
  assert result.map(temporal.parse_day_between("1900-01-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-03", -2_208_816_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_37_test() {
  assert result.map(temporal.parse_day_between("1900-01-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-04", -2_208_729_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_38_test() {
  assert result.map(temporal.parse_day_between("1900-01-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-05", -2_208_643_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_39_test() {
  assert result.map(temporal.parse_day_between("1900-01-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-06", -2_208_556_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_40_test() {
  assert result.map(temporal.parse_day_between("1900-01-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-07", -2_208_470_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_41_test() {
  assert result.map(temporal.parse_day_between("1900-01-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-08", -2_208_384_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_42_test() {
  assert result.map(temporal.parse_day_between("1900-01-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-09", -2_208_297_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_43_test() {
  assert result.map(temporal.parse_day_between("1900-01-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-10", -2_208_211_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_44_test() {
  assert result.map(temporal.parse_day_between("1900-01-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-11", -2_208_124_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_45_test() {
  assert result.map(temporal.parse_day_between("1900-01-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-12", -2_208_038_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_46_test() {
  assert result.map(temporal.parse_day_between("1900-01-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-13", -2_207_952_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_47_test() {
  assert result.map(temporal.parse_day_between("1900-01-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-14", -2_207_865_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_48_test() {
  assert result.map(temporal.parse_day_between("1900-01-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-15", -2_207_779_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_49_test() {
  assert result.map(temporal.parse_day_between("1900-01-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-16", -2_207_692_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_50_test() {
  assert result.map(temporal.parse_day_between("1900-01-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-17", -2_207_606_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_51_test() {
  assert result.map(temporal.parse_day_between("1900-01-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-18", -2_207_520_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_52_test() {
  assert result.map(temporal.parse_day_between("1900-01-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-19", -2_207_433_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_53_test() {
  assert result.map(temporal.parse_day_between("1900-01-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-20", -2_207_347_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_54_test() {
  assert result.map(temporal.parse_day_between("1900-01-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-21", -2_207_260_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_55_test() {
  assert result.map(temporal.parse_day_between("1900-01-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-22", -2_207_174_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_56_test() {
  assert result.map(temporal.parse_day_between("1900-01-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-23", -2_207_088_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_57_test() {
  assert result.map(temporal.parse_day_between("1900-01-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-24", -2_207_001_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_58_test() {
  assert result.map(temporal.parse_day_between("1900-01-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-25", -2_206_915_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_59_test() {
  assert result.map(temporal.parse_day_between("1900-01-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-26", -2_206_828_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_60_test() {
  assert result.map(temporal.parse_day_between("1900-01-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-27", -2_206_742_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_61_test() {
  assert result.map(temporal.parse_day_between("1900-01-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-28", -2_206_656_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_62_test() {
  assert result.map(temporal.parse_day_between("1900-01-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-29", -2_206_569_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_63_test() {
  assert result.map(temporal.parse_day_between("1900-01-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-30", -2_206_483_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_64_test() {
  assert result.map(temporal.parse_day_between("1900-01-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-01-31", -2_206_396_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_65_test() {
  assert result.map(temporal.parse_day_between("1900-01-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_66_test() {
  assert result.map(temporal.parse_day_between("1900-02-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_67_test() {
  assert result.map(temporal.parse_day_between("1900-02-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-01", -2_206_310_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_68_test() {
  assert result.map(temporal.parse_day_between("1900-02-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-02", -2_206_224_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_69_test() {
  assert result.map(temporal.parse_day_between("1900-02-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-03", -2_206_137_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_70_test() {
  assert result.map(temporal.parse_day_between("1900-02-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-04", -2_206_051_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_71_test() {
  assert result.map(temporal.parse_day_between("1900-02-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-05", -2_205_964_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_72_test() {
  assert result.map(temporal.parse_day_between("1900-02-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-06", -2_205_878_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_73_test() {
  assert result.map(temporal.parse_day_between("1900-02-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-07", -2_205_792_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_74_test() {
  assert result.map(temporal.parse_day_between("1900-02-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-08", -2_205_705_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_75_test() {
  assert result.map(temporal.parse_day_between("1900-02-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-09", -2_205_619_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_76_test() {
  assert result.map(temporal.parse_day_between("1900-02-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-10", -2_205_532_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_77_test() {
  assert result.map(temporal.parse_day_between("1900-02-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-11", -2_205_446_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_78_test() {
  assert result.map(temporal.parse_day_between("1900-02-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-12", -2_205_360_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_79_test() {
  assert result.map(temporal.parse_day_between("1900-02-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-13", -2_205_273_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_80_test() {
  assert result.map(temporal.parse_day_between("1900-02-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-14", -2_205_187_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_81_test() {
  assert result.map(temporal.parse_day_between("1900-02-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-15", -2_205_100_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_82_test() {
  assert result.map(temporal.parse_day_between("1900-02-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-16", -2_205_014_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_83_test() {
  assert result.map(temporal.parse_day_between("1900-02-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-17", -2_204_928_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_84_test() {
  assert result.map(temporal.parse_day_between("1900-02-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-18", -2_204_841_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_85_test() {
  assert result.map(temporal.parse_day_between("1900-02-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-19", -2_204_755_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_86_test() {
  assert result.map(temporal.parse_day_between("1900-02-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-20", -2_204_668_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_87_test() {
  assert result.map(temporal.parse_day_between("1900-02-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-21", -2_204_582_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_88_test() {
  assert result.map(temporal.parse_day_between("1900-02-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-22", -2_204_496_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_89_test() {
  assert result.map(temporal.parse_day_between("1900-02-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-23", -2_204_409_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_90_test() {
  assert result.map(temporal.parse_day_between("1900-02-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-24", -2_204_323_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_91_test() {
  assert result.map(temporal.parse_day_between("1900-02-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-25", -2_204_236_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_92_test() {
  assert result.map(temporal.parse_day_between("1900-02-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-26", -2_204_150_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_93_test() {
  assert result.map(temporal.parse_day_between("1900-02-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-27", -2_204_064_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_94_test() {
  assert result.map(temporal.parse_day_between("1900-02-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-02-28", -2_203_977_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_95_test() {
  assert result.map(temporal.parse_day_between("1900-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_96_test() {
  assert result.map(temporal.parse_day_between("1900-02-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_97_test() {
  assert result.map(temporal.parse_day_between("1900-02-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_98_test() {
  assert result.map(temporal.parse_day_between("1900-02-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_99_test() {
  assert result.map(temporal.parse_day_between("1900-03-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_100_test() {
  assert result.map(temporal.parse_day_between("1900-03-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-01", -2_203_891_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_101_test() {
  assert result.map(temporal.parse_day_between("1900-03-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-02", -2_203_804_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_102_test() {
  assert result.map(temporal.parse_day_between("1900-03-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-03", -2_203_718_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_103_test() {
  assert result.map(temporal.parse_day_between("1900-03-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-04", -2_203_632_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_104_test() {
  assert result.map(temporal.parse_day_between("1900-03-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-05", -2_203_545_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_105_test() {
  assert result.map(temporal.parse_day_between("1900-03-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-06", -2_203_459_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_106_test() {
  assert result.map(temporal.parse_day_between("1900-03-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-07", -2_203_372_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_107_test() {
  assert result.map(temporal.parse_day_between("1900-03-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-08", -2_203_286_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_108_test() {
  assert result.map(temporal.parse_day_between("1900-03-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-09", -2_203_200_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_109_test() {
  assert result.map(temporal.parse_day_between("1900-03-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-10", -2_203_113_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_110_test() {
  assert result.map(temporal.parse_day_between("1900-03-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-11", -2_203_027_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_111_test() {
  assert result.map(temporal.parse_day_between("1900-03-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-12", -2_202_940_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_112_test() {
  assert result.map(temporal.parse_day_between("1900-03-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-13", -2_202_854_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_113_test() {
  assert result.map(temporal.parse_day_between("1900-03-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-14", -2_202_768_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_114_test() {
  assert result.map(temporal.parse_day_between("1900-03-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-15", -2_202_681_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_115_test() {
  assert result.map(temporal.parse_day_between("1900-03-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-16", -2_202_595_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_116_test() {
  assert result.map(temporal.parse_day_between("1900-03-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-17", -2_202_508_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_117_test() {
  assert result.map(temporal.parse_day_between("1900-03-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-18", -2_202_422_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_118_test() {
  assert result.map(temporal.parse_day_between("1900-03-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-19", -2_202_336_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_119_test() {
  assert result.map(temporal.parse_day_between("1900-03-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-20", -2_202_249_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_120_test() {
  assert result.map(temporal.parse_day_between("1900-03-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-21", -2_202_163_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_121_test() {
  assert result.map(temporal.parse_day_between("1900-03-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-22", -2_202_076_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_122_test() {
  assert result.map(temporal.parse_day_between("1900-03-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-23", -2_201_990_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_123_test() {
  assert result.map(temporal.parse_day_between("1900-03-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-24", -2_201_904_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_124_test() {
  assert result.map(temporal.parse_day_between("1900-03-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-25", -2_201_817_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_125_test() {
  assert result.map(temporal.parse_day_between("1900-03-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-26", -2_201_731_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_126_test() {
  assert result.map(temporal.parse_day_between("1900-03-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-27", -2_201_644_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_127_test() {
  assert result.map(temporal.parse_day_between("1900-03-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-28", -2_201_558_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_128_test() {
  assert result.map(temporal.parse_day_between("1900-03-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-29", -2_201_472_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_129_test() {
  assert result.map(temporal.parse_day_between("1900-03-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-30", -2_201_385_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_130_test() {
  assert result.map(temporal.parse_day_between("1900-03-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-03-31", -2_201_299_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_131_test() {
  assert result.map(temporal.parse_day_between("1900-03-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_132_test() {
  assert result.map(temporal.parse_day_between("1900-04-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_133_test() {
  assert result.map(temporal.parse_day_between("1900-04-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-01", -2_201_212_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_134_test() {
  assert result.map(temporal.parse_day_between("1900-04-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-02", -2_201_126_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_135_test() {
  assert result.map(temporal.parse_day_between("1900-04-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-03", -2_201_040_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_136_test() {
  assert result.map(temporal.parse_day_between("1900-04-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-04", -2_200_953_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_137_test() {
  assert result.map(temporal.parse_day_between("1900-04-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-05", -2_200_867_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_138_test() {
  assert result.map(temporal.parse_day_between("1900-04-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-06", -2_200_780_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_139_test() {
  assert result.map(temporal.parse_day_between("1900-04-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-07", -2_200_694_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_140_test() {
  assert result.map(temporal.parse_day_between("1900-04-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-08", -2_200_608_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_141_test() {
  assert result.map(temporal.parse_day_between("1900-04-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-09", -2_200_521_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_142_test() {
  assert result.map(temporal.parse_day_between("1900-04-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-10", -2_200_435_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_143_test() {
  assert result.map(temporal.parse_day_between("1900-04-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-11", -2_200_348_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_144_test() {
  assert result.map(temporal.parse_day_between("1900-04-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-12", -2_200_262_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_145_test() {
  assert result.map(temporal.parse_day_between("1900-04-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-13", -2_200_176_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_146_test() {
  assert result.map(temporal.parse_day_between("1900-04-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-14", -2_200_089_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_147_test() {
  assert result.map(temporal.parse_day_between("1900-04-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-15", -2_200_003_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_148_test() {
  assert result.map(temporal.parse_day_between("1900-04-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-16", -2_199_916_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_149_test() {
  assert result.map(temporal.parse_day_between("1900-04-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-17", -2_199_830_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_150_test() {
  assert result.map(temporal.parse_day_between("1900-04-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-18", -2_199_744_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_151_test() {
  assert result.map(temporal.parse_day_between("1900-04-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-19", -2_199_657_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_152_test() {
  assert result.map(temporal.parse_day_between("1900-04-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-20", -2_199_571_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_153_test() {
  assert result.map(temporal.parse_day_between("1900-04-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-21", -2_199_484_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_154_test() {
  assert result.map(temporal.parse_day_between("1900-04-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-22", -2_199_398_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_155_test() {
  assert result.map(temporal.parse_day_between("1900-04-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-23", -2_199_312_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_156_test() {
  assert result.map(temporal.parse_day_between("1900-04-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-24", -2_199_225_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_157_test() {
  assert result.map(temporal.parse_day_between("1900-04-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-25", -2_199_139_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_158_test() {
  assert result.map(temporal.parse_day_between("1900-04-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-26", -2_199_052_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_159_test() {
  assert result.map(temporal.parse_day_between("1900-04-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-27", -2_198_966_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_160_test() {
  assert result.map(temporal.parse_day_between("1900-04-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-28", -2_198_880_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_161_test() {
  assert result.map(temporal.parse_day_between("1900-04-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-29", -2_198_793_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_162_test() {
  assert result.map(temporal.parse_day_between("1900-04-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-04-30", -2_198_707_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_163_test() {
  assert result.map(temporal.parse_day_between("1900-04-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_164_test() {
  assert result.map(temporal.parse_day_between("1900-04-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_165_test() {
  assert result.map(temporal.parse_day_between("1900-05-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_166_test() {
  assert result.map(temporal.parse_day_between("1900-05-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-01", -2_198_620_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_167_test() {
  assert result.map(temporal.parse_day_between("1900-05-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-02", -2_198_534_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_168_test() {
  assert result.map(temporal.parse_day_between("1900-05-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-03", -2_198_448_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_169_test() {
  assert result.map(temporal.parse_day_between("1900-05-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-04", -2_198_361_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_170_test() {
  assert result.map(temporal.parse_day_between("1900-05-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-05", -2_198_275_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_171_test() {
  assert result.map(temporal.parse_day_between("1900-05-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-06", -2_198_188_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_172_test() {
  assert result.map(temporal.parse_day_between("1900-05-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-07", -2_198_102_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_173_test() {
  assert result.map(temporal.parse_day_between("1900-05-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-08", -2_198_016_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_174_test() {
  assert result.map(temporal.parse_day_between("1900-05-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-09", -2_197_929_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_175_test() {
  assert result.map(temporal.parse_day_between("1900-05-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-10", -2_197_843_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_176_test() {
  assert result.map(temporal.parse_day_between("1900-05-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-11", -2_197_756_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_177_test() {
  assert result.map(temporal.parse_day_between("1900-05-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-12", -2_197_670_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_178_test() {
  assert result.map(temporal.parse_day_between("1900-05-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-13", -2_197_584_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_179_test() {
  assert result.map(temporal.parse_day_between("1900-05-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-14", -2_197_497_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_180_test() {
  assert result.map(temporal.parse_day_between("1900-05-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-15", -2_197_411_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_181_test() {
  assert result.map(temporal.parse_day_between("1900-05-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-16", -2_197_324_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_182_test() {
  assert result.map(temporal.parse_day_between("1900-05-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-17", -2_197_238_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_183_test() {
  assert result.map(temporal.parse_day_between("1900-05-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-18", -2_197_152_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_184_test() {
  assert result.map(temporal.parse_day_between("1900-05-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-19", -2_197_065_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_185_test() {
  assert result.map(temporal.parse_day_between("1900-05-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-20", -2_196_979_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_186_test() {
  assert result.map(temporal.parse_day_between("1900-05-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-21", -2_196_892_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_187_test() {
  assert result.map(temporal.parse_day_between("1900-05-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-22", -2_196_806_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_188_test() {
  assert result.map(temporal.parse_day_between("1900-05-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-23", -2_196_720_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_189_test() {
  assert result.map(temporal.parse_day_between("1900-05-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-24", -2_196_633_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_190_test() {
  assert result.map(temporal.parse_day_between("1900-05-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-25", -2_196_547_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_191_test() {
  assert result.map(temporal.parse_day_between("1900-05-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-26", -2_196_460_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_192_test() {
  assert result.map(temporal.parse_day_between("1900-05-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-27", -2_196_374_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_193_test() {
  assert result.map(temporal.parse_day_between("1900-05-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-28", -2_196_288_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_194_test() {
  assert result.map(temporal.parse_day_between("1900-05-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-29", -2_196_201_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_195_test() {
  assert result.map(temporal.parse_day_between("1900-05-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-30", -2_196_115_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_196_test() {
  assert result.map(temporal.parse_day_between("1900-05-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-05-31", -2_196_028_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_197_test() {
  assert result.map(temporal.parse_day_between("1900-05-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_198_test() {
  assert result.map(temporal.parse_day_between("1900-06-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_199_test() {
  assert result.map(temporal.parse_day_between("1900-06-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-01", -2_195_942_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_200_test() {
  assert result.map(temporal.parse_day_between("1900-06-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-02", -2_195_856_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_201_test() {
  assert result.map(temporal.parse_day_between("1900-06-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-03", -2_195_769_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_202_test() {
  assert result.map(temporal.parse_day_between("1900-06-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-04", -2_195_683_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_203_test() {
  assert result.map(temporal.parse_day_between("1900-06-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-05", -2_195_596_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_204_test() {
  assert result.map(temporal.parse_day_between("1900-06-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-06", -2_195_510_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_205_test() {
  assert result.map(temporal.parse_day_between("1900-06-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-07", -2_195_424_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_206_test() {
  assert result.map(temporal.parse_day_between("1900-06-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-08", -2_195_337_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_207_test() {
  assert result.map(temporal.parse_day_between("1900-06-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-09", -2_195_251_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_208_test() {
  assert result.map(temporal.parse_day_between("1900-06-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-10", -2_195_164_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_209_test() {
  assert result.map(temporal.parse_day_between("1900-06-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-11", -2_195_078_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_210_test() {
  assert result.map(temporal.parse_day_between("1900-06-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-12", -2_194_992_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_211_test() {
  assert result.map(temporal.parse_day_between("1900-06-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-13", -2_194_905_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_212_test() {
  assert result.map(temporal.parse_day_between("1900-06-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-14", -2_194_819_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_213_test() {
  assert result.map(temporal.parse_day_between("1900-06-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-15", -2_194_732_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_214_test() {
  assert result.map(temporal.parse_day_between("1900-06-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-16", -2_194_646_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_215_test() {
  assert result.map(temporal.parse_day_between("1900-06-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-17", -2_194_560_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_216_test() {
  assert result.map(temporal.parse_day_between("1900-06-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-18", -2_194_473_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_217_test() {
  assert result.map(temporal.parse_day_between("1900-06-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-19", -2_194_387_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_218_test() {
  assert result.map(temporal.parse_day_between("1900-06-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-20", -2_194_300_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_219_test() {
  assert result.map(temporal.parse_day_between("1900-06-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-21", -2_194_214_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_220_test() {
  assert result.map(temporal.parse_day_between("1900-06-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-22", -2_194_128_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_221_test() {
  assert result.map(temporal.parse_day_between("1900-06-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-23", -2_194_041_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_222_test() {
  assert result.map(temporal.parse_day_between("1900-06-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-24", -2_193_955_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_223_test() {
  assert result.map(temporal.parse_day_between("1900-06-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-25", -2_193_868_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_224_test() {
  assert result.map(temporal.parse_day_between("1900-06-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-26", -2_193_782_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_225_test() {
  assert result.map(temporal.parse_day_between("1900-06-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-27", -2_193_696_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_226_test() {
  assert result.map(temporal.parse_day_between("1900-06-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-28", -2_193_609_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_227_test() {
  assert result.map(temporal.parse_day_between("1900-06-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-29", -2_193_523_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_228_test() {
  assert result.map(temporal.parse_day_between("1900-06-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-06-30", -2_193_436_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_229_test() {
  assert result.map(temporal.parse_day_between("1900-06-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_230_test() {
  assert result.map(temporal.parse_day_between("1900-06-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_231_test() {
  assert result.map(temporal.parse_day_between("1900-07-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_232_test() {
  assert result.map(temporal.parse_day_between("1900-07-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-01", -2_193_350_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_233_test() {
  assert result.map(temporal.parse_day_between("1900-07-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-02", -2_193_264_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_234_test() {
  assert result.map(temporal.parse_day_between("1900-07-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-03", -2_193_177_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_235_test() {
  assert result.map(temporal.parse_day_between("1900-07-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-04", -2_193_091_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_236_test() {
  assert result.map(temporal.parse_day_between("1900-07-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-05", -2_193_004_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_237_test() {
  assert result.map(temporal.parse_day_between("1900-07-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-06", -2_192_918_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_238_test() {
  assert result.map(temporal.parse_day_between("1900-07-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-07", -2_192_832_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_239_test() {
  assert result.map(temporal.parse_day_between("1900-07-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-08", -2_192_745_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_240_test() {
  assert result.map(temporal.parse_day_between("1900-07-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-09", -2_192_659_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_241_test() {
  assert result.map(temporal.parse_day_between("1900-07-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-10", -2_192_572_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_242_test() {
  assert result.map(temporal.parse_day_between("1900-07-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-11", -2_192_486_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_243_test() {
  assert result.map(temporal.parse_day_between("1900-07-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-12", -2_192_400_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_244_test() {
  assert result.map(temporal.parse_day_between("1900-07-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-13", -2_192_313_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_245_test() {
  assert result.map(temporal.parse_day_between("1900-07-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-14", -2_192_227_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_246_test() {
  assert result.map(temporal.parse_day_between("1900-07-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-15", -2_192_140_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_247_test() {
  assert result.map(temporal.parse_day_between("1900-07-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-16", -2_192_054_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_248_test() {
  assert result.map(temporal.parse_day_between("1900-07-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-17", -2_191_968_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_249_test() {
  assert result.map(temporal.parse_day_between("1900-07-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-18", -2_191_881_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_250_test() {
  assert result.map(temporal.parse_day_between("1900-07-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-19", -2_191_795_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_251_test() {
  assert result.map(temporal.parse_day_between("1900-07-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-20", -2_191_708_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_252_test() {
  assert result.map(temporal.parse_day_between("1900-07-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-21", -2_191_622_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_253_test() {
  assert result.map(temporal.parse_day_between("1900-07-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-22", -2_191_536_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_254_test() {
  assert result.map(temporal.parse_day_between("1900-07-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-23", -2_191_449_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_255_test() {
  assert result.map(temporal.parse_day_between("1900-07-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-24", -2_191_363_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_256_test() {
  assert result.map(temporal.parse_day_between("1900-07-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-25", -2_191_276_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_257_test() {
  assert result.map(temporal.parse_day_between("1900-07-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-26", -2_191_190_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_258_test() {
  assert result.map(temporal.parse_day_between("1900-07-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-27", -2_191_104_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_259_test() {
  assert result.map(temporal.parse_day_between("1900-07-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-28", -2_191_017_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_260_test() {
  assert result.map(temporal.parse_day_between("1900-07-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-29", -2_190_931_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_261_test() {
  assert result.map(temporal.parse_day_between("1900-07-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-30", -2_190_844_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_262_test() {
  assert result.map(temporal.parse_day_between("1900-07-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-07-31", -2_190_758_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_263_test() {
  assert result.map(temporal.parse_day_between("1900-07-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_264_test() {
  assert result.map(temporal.parse_day_between("1900-08-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_265_test() {
  assert result.map(temporal.parse_day_between("1900-08-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-01", -2_190_672_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_266_test() {
  assert result.map(temporal.parse_day_between("1900-08-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-02", -2_190_585_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_267_test() {
  assert result.map(temporal.parse_day_between("1900-08-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-03", -2_190_499_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_268_test() {
  assert result.map(temporal.parse_day_between("1900-08-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-04", -2_190_412_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_269_test() {
  assert result.map(temporal.parse_day_between("1900-08-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-05", -2_190_326_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_270_test() {
  assert result.map(temporal.parse_day_between("1900-08-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-06", -2_190_240_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_271_test() {
  assert result.map(temporal.parse_day_between("1900-08-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-07", -2_190_153_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_272_test() {
  assert result.map(temporal.parse_day_between("1900-08-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-08", -2_190_067_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_273_test() {
  assert result.map(temporal.parse_day_between("1900-08-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-09", -2_189_980_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_274_test() {
  assert result.map(temporal.parse_day_between("1900-08-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-10", -2_189_894_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_275_test() {
  assert result.map(temporal.parse_day_between("1900-08-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-11", -2_189_808_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_276_test() {
  assert result.map(temporal.parse_day_between("1900-08-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-12", -2_189_721_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_277_test() {
  assert result.map(temporal.parse_day_between("1900-08-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-13", -2_189_635_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_278_test() {
  assert result.map(temporal.parse_day_between("1900-08-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-14", -2_189_548_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_279_test() {
  assert result.map(temporal.parse_day_between("1900-08-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-15", -2_189_462_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_280_test() {
  assert result.map(temporal.parse_day_between("1900-08-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-16", -2_189_376_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_281_test() {
  assert result.map(temporal.parse_day_between("1900-08-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-17", -2_189_289_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_282_test() {
  assert result.map(temporal.parse_day_between("1900-08-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-18", -2_189_203_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_283_test() {
  assert result.map(temporal.parse_day_between("1900-08-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-19", -2_189_116_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_284_test() {
  assert result.map(temporal.parse_day_between("1900-08-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-20", -2_189_030_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_285_test() {
  assert result.map(temporal.parse_day_between("1900-08-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-21", -2_188_944_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_286_test() {
  assert result.map(temporal.parse_day_between("1900-08-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-22", -2_188_857_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_287_test() {
  assert result.map(temporal.parse_day_between("1900-08-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-23", -2_188_771_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_288_test() {
  assert result.map(temporal.parse_day_between("1900-08-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-24", -2_188_684_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_289_test() {
  assert result.map(temporal.parse_day_between("1900-08-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-25", -2_188_598_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_290_test() {
  assert result.map(temporal.parse_day_between("1900-08-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-26", -2_188_512_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_291_test() {
  assert result.map(temporal.parse_day_between("1900-08-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-27", -2_188_425_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_292_test() {
  assert result.map(temporal.parse_day_between("1900-08-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-28", -2_188_339_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_293_test() {
  assert result.map(temporal.parse_day_between("1900-08-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-29", -2_188_252_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_294_test() {
  assert result.map(temporal.parse_day_between("1900-08-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-30", -2_188_166_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_295_test() {
  assert result.map(temporal.parse_day_between("1900-08-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-08-31", -2_188_080_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_296_test() {
  assert result.map(temporal.parse_day_between("1900-08-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_297_test() {
  assert result.map(temporal.parse_day_between("1900-09-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_298_test() {
  assert result.map(temporal.parse_day_between("1900-09-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-01", -2_187_993_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_299_test() {
  assert result.map(temporal.parse_day_between("1900-09-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-02", -2_187_907_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_300_test() {
  assert result.map(temporal.parse_day_between("1900-09-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-03", -2_187_820_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_301_test() {
  assert result.map(temporal.parse_day_between("1900-09-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-04", -2_187_734_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_302_test() {
  assert result.map(temporal.parse_day_between("1900-09-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-05", -2_187_648_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_303_test() {
  assert result.map(temporal.parse_day_between("1900-09-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-06", -2_187_561_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_304_test() {
  assert result.map(temporal.parse_day_between("1900-09-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-07", -2_187_475_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_305_test() {
  assert result.map(temporal.parse_day_between("1900-09-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-08", -2_187_388_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_306_test() {
  assert result.map(temporal.parse_day_between("1900-09-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-09", -2_187_302_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_307_test() {
  assert result.map(temporal.parse_day_between("1900-09-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-10", -2_187_216_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_308_test() {
  assert result.map(temporal.parse_day_between("1900-09-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-11", -2_187_129_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_309_test() {
  assert result.map(temporal.parse_day_between("1900-09-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-12", -2_187_043_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_310_test() {
  assert result.map(temporal.parse_day_between("1900-09-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-13", -2_186_956_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_311_test() {
  assert result.map(temporal.parse_day_between("1900-09-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-14", -2_186_870_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_312_test() {
  assert result.map(temporal.parse_day_between("1900-09-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-15", -2_186_784_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_313_test() {
  assert result.map(temporal.parse_day_between("1900-09-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-16", -2_186_697_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_314_test() {
  assert result.map(temporal.parse_day_between("1900-09-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-17", -2_186_611_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_315_test() {
  assert result.map(temporal.parse_day_between("1900-09-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-18", -2_186_524_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_316_test() {
  assert result.map(temporal.parse_day_between("1900-09-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-19", -2_186_438_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_317_test() {
  assert result.map(temporal.parse_day_between("1900-09-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-20", -2_186_352_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_318_test() {
  assert result.map(temporal.parse_day_between("1900-09-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-21", -2_186_265_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_319_test() {
  assert result.map(temporal.parse_day_between("1900-09-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-22", -2_186_179_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_320_test() {
  assert result.map(temporal.parse_day_between("1900-09-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-23", -2_186_092_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_321_test() {
  assert result.map(temporal.parse_day_between("1900-09-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-24", -2_186_006_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_322_test() {
  assert result.map(temporal.parse_day_between("1900-09-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-25", -2_185_920_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_323_test() {
  assert result.map(temporal.parse_day_between("1900-09-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-26", -2_185_833_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_324_test() {
  assert result.map(temporal.parse_day_between("1900-09-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-27", -2_185_747_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_325_test() {
  assert result.map(temporal.parse_day_between("1900-09-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-28", -2_185_660_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_326_test() {
  assert result.map(temporal.parse_day_between("1900-09-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-29", -2_185_574_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_327_test() {
  assert result.map(temporal.parse_day_between("1900-09-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-09-30", -2_185_488_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_328_test() {
  assert result.map(temporal.parse_day_between("1900-09-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_329_test() {
  assert result.map(temporal.parse_day_between("1900-09-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_330_test() {
  assert result.map(temporal.parse_day_between("1900-10-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_331_test() {
  assert result.map(temporal.parse_day_between("1900-10-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-01", -2_185_401_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_332_test() {
  assert result.map(temporal.parse_day_between("1900-10-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-02", -2_185_315_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_333_test() {
  assert result.map(temporal.parse_day_between("1900-10-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-03", -2_185_228_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_334_test() {
  assert result.map(temporal.parse_day_between("1900-10-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-04", -2_185_142_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_335_test() {
  assert result.map(temporal.parse_day_between("1900-10-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-05", -2_185_056_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_336_test() {
  assert result.map(temporal.parse_day_between("1900-10-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-06", -2_184_969_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_337_test() {
  assert result.map(temporal.parse_day_between("1900-10-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-07", -2_184_883_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_338_test() {
  assert result.map(temporal.parse_day_between("1900-10-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-08", -2_184_796_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_339_test() {
  assert result.map(temporal.parse_day_between("1900-10-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-09", -2_184_710_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_340_test() {
  assert result.map(temporal.parse_day_between("1900-10-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-10", -2_184_624_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_341_test() {
  assert result.map(temporal.parse_day_between("1900-10-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-11", -2_184_537_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_342_test() {
  assert result.map(temporal.parse_day_between("1900-10-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-12", -2_184_451_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_343_test() {
  assert result.map(temporal.parse_day_between("1900-10-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-13", -2_184_364_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_344_test() {
  assert result.map(temporal.parse_day_between("1900-10-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-14", -2_184_278_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_345_test() {
  assert result.map(temporal.parse_day_between("1900-10-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-15", -2_184_192_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_346_test() {
  assert result.map(temporal.parse_day_between("1900-10-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-16", -2_184_105_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_347_test() {
  assert result.map(temporal.parse_day_between("1900-10-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-17", -2_184_019_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_348_test() {
  assert result.map(temporal.parse_day_between("1900-10-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-18", -2_183_932_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_349_test() {
  assert result.map(temporal.parse_day_between("1900-10-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-19", -2_183_846_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_350_test() {
  assert result.map(temporal.parse_day_between("1900-10-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-20", -2_183_760_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_351_test() {
  assert result.map(temporal.parse_day_between("1900-10-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-21", -2_183_673_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_352_test() {
  assert result.map(temporal.parse_day_between("1900-10-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-22", -2_183_587_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_353_test() {
  assert result.map(temporal.parse_day_between("1900-10-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-23", -2_183_500_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_354_test() {
  assert result.map(temporal.parse_day_between("1900-10-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-24", -2_183_414_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_355_test() {
  assert result.map(temporal.parse_day_between("1900-10-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-25", -2_183_328_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_356_test() {
  assert result.map(temporal.parse_day_between("1900-10-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-26", -2_183_241_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_357_test() {
  assert result.map(temporal.parse_day_between("1900-10-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-27", -2_183_155_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_358_test() {
  assert result.map(temporal.parse_day_between("1900-10-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-28", -2_183_068_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_359_test() {
  assert result.map(temporal.parse_day_between("1900-10-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-29", -2_182_982_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_360_test() {
  assert result.map(temporal.parse_day_between("1900-10-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-30", -2_182_896_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_361_test() {
  assert result.map(temporal.parse_day_between("1900-10-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-10-31", -2_182_809_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_362_test() {
  assert result.map(temporal.parse_day_between("1900-10-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_363_test() {
  assert result.map(temporal.parse_day_between("1900-11-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_364_test() {
  assert result.map(temporal.parse_day_between("1900-11-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-01", -2_182_723_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_365_test() {
  assert result.map(temporal.parse_day_between("1900-11-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-02", -2_182_636_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_366_test() {
  assert result.map(temporal.parse_day_between("1900-11-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-03", -2_182_550_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_367_test() {
  assert result.map(temporal.parse_day_between("1900-11-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-04", -2_182_464_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_368_test() {
  assert result.map(temporal.parse_day_between("1900-11-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-05", -2_182_377_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_369_test() {
  assert result.map(temporal.parse_day_between("1900-11-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-06", -2_182_291_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_370_test() {
  assert result.map(temporal.parse_day_between("1900-11-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-07", -2_182_204_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_371_test() {
  assert result.map(temporal.parse_day_between("1900-11-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-08", -2_182_118_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_372_test() {
  assert result.map(temporal.parse_day_between("1900-11-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-09", -2_182_032_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_373_test() {
  assert result.map(temporal.parse_day_between("1900-11-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-10", -2_181_945_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_374_test() {
  assert result.map(temporal.parse_day_between("1900-11-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-11", -2_181_859_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_375_test() {
  assert result.map(temporal.parse_day_between("1900-11-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-12", -2_181_772_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_376_test() {
  assert result.map(temporal.parse_day_between("1900-11-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-13", -2_181_686_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_377_test() {
  assert result.map(temporal.parse_day_between("1900-11-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-14", -2_181_600_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_378_test() {
  assert result.map(temporal.parse_day_between("1900-11-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-15", -2_181_513_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_379_test() {
  assert result.map(temporal.parse_day_between("1900-11-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-16", -2_181_427_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_380_test() {
  assert result.map(temporal.parse_day_between("1900-11-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-17", -2_181_340_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_381_test() {
  assert result.map(temporal.parse_day_between("1900-11-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-18", -2_181_254_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_382_test() {
  assert result.map(temporal.parse_day_between("1900-11-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-19", -2_181_168_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_383_test() {
  assert result.map(temporal.parse_day_between("1900-11-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-20", -2_181_081_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_384_test() {
  assert result.map(temporal.parse_day_between("1900-11-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-21", -2_180_995_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_385_test() {
  assert result.map(temporal.parse_day_between("1900-11-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-22", -2_180_908_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_386_test() {
  assert result.map(temporal.parse_day_between("1900-11-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-23", -2_180_822_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_387_test() {
  assert result.map(temporal.parse_day_between("1900-11-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-24", -2_180_736_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_388_test() {
  assert result.map(temporal.parse_day_between("1900-11-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-25", -2_180_649_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_389_test() {
  assert result.map(temporal.parse_day_between("1900-11-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-26", -2_180_563_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_390_test() {
  assert result.map(temporal.parse_day_between("1900-11-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-27", -2_180_476_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_391_test() {
  assert result.map(temporal.parse_day_between("1900-11-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-28", -2_180_390_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_392_test() {
  assert result.map(temporal.parse_day_between("1900-11-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-29", -2_180_304_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_393_test() {
  assert result.map(temporal.parse_day_between("1900-11-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-11-30", -2_180_217_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_394_test() {
  assert result.map(temporal.parse_day_between("1900-11-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_395_test() {
  assert result.map(temporal.parse_day_between("1900-11-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_396_test() {
  assert result.map(temporal.parse_day_between("1900-12-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_397_test() {
  assert result.map(temporal.parse_day_between("1900-12-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-01", -2_180_131_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_398_test() {
  assert result.map(temporal.parse_day_between("1900-12-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-02", -2_180_044_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_399_test() {
  assert result.map(temporal.parse_day_between("1900-12-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-03", -2_179_958_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_400_test() {
  assert result.map(temporal.parse_day_between("1900-12-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-04", -2_179_872_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_401_test() {
  assert result.map(temporal.parse_day_between("1900-12-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-05", -2_179_785_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_402_test() {
  assert result.map(temporal.parse_day_between("1900-12-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-06", -2_179_699_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_403_test() {
  assert result.map(temporal.parse_day_between("1900-12-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-07", -2_179_612_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_404_test() {
  assert result.map(temporal.parse_day_between("1900-12-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-08", -2_179_526_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_405_test() {
  assert result.map(temporal.parse_day_between("1900-12-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-09", -2_179_440_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_406_test() {
  assert result.map(temporal.parse_day_between("1900-12-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-10", -2_179_353_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_407_test() {
  assert result.map(temporal.parse_day_between("1900-12-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-11", -2_179_267_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_408_test() {
  assert result.map(temporal.parse_day_between("1900-12-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-12", -2_179_180_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_409_test() {
  assert result.map(temporal.parse_day_between("1900-12-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-13", -2_179_094_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_410_test() {
  assert result.map(temporal.parse_day_between("1900-12-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-14", -2_179_008_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_411_test() {
  assert result.map(temporal.parse_day_between("1900-12-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-15", -2_178_921_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_412_test() {
  assert result.map(temporal.parse_day_between("1900-12-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-16", -2_178_835_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_413_test() {
  assert result.map(temporal.parse_day_between("1900-12-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-17", -2_178_748_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_414_test() {
  assert result.map(temporal.parse_day_between("1900-12-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-18", -2_178_662_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_415_test() {
  assert result.map(temporal.parse_day_between("1900-12-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-19", -2_178_576_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_416_test() {
  assert result.map(temporal.parse_day_between("1900-12-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-20", -2_178_489_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_417_test() {
  assert result.map(temporal.parse_day_between("1900-12-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-21", -2_178_403_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_418_test() {
  assert result.map(temporal.parse_day_between("1900-12-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-22", -2_178_316_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_419_test() {
  assert result.map(temporal.parse_day_between("1900-12-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-23", -2_178_230_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_420_test() {
  assert result.map(temporal.parse_day_between("1900-12-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-24", -2_178_144_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_421_test() {
  assert result.map(temporal.parse_day_between("1900-12-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-25", -2_178_057_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_422_test() {
  assert result.map(temporal.parse_day_between("1900-12-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-26", -2_177_971_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_423_test() {
  assert result.map(temporal.parse_day_between("1900-12-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-27", -2_177_884_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_424_test() {
  assert result.map(temporal.parse_day_between("1900-12-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-28", -2_177_798_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_425_test() {
  assert result.map(temporal.parse_day_between("1900-12-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-29", -2_177_712_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_426_test() {
  assert result.map(temporal.parse_day_between("1900-12-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-30", -2_177_625_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_427_test() {
  assert result.map(temporal.parse_day_between("1900-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("1900-12-31", -2_177_539_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_428_test() {
  assert result.map(temporal.parse_day_between("1900-12-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_429_test() {
  assert result.map(temporal.parse_day_between("1900-13-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_430_test() {
  assert result.map(temporal.parse_day_between("1900-13-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_431_test() {
  assert result.map(temporal.parse_day_between("1900-13-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_432_test() {
  assert result.map(temporal.parse_day_between("1900-13-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_433_test() {
  assert result.map(temporal.parse_day_between("1900-13-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_434_test() {
  assert result.map(temporal.parse_day_between("1900-13-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_435_test() {
  assert result.map(temporal.parse_day_between("1900-13-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_436_test() {
  assert result.map(temporal.parse_day_between("1900-13-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_437_test() {
  assert result.map(temporal.parse_day_between("1900-13-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_438_test() {
  assert result.map(temporal.parse_day_between("1900-13-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_439_test() {
  assert result.map(temporal.parse_day_between("1900-13-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_440_test() {
  assert result.map(temporal.parse_day_between("1900-13-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_441_test() {
  assert result.map(temporal.parse_day_between("1900-13-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_442_test() {
  assert result.map(temporal.parse_day_between("1900-13-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_443_test() {
  assert result.map(temporal.parse_day_between("1900-13-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_444_test() {
  assert result.map(temporal.parse_day_between("1900-13-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_445_test() {
  assert result.map(temporal.parse_day_between("1900-13-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_446_test() {
  assert result.map(temporal.parse_day_between("1900-13-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_447_test() {
  assert result.map(temporal.parse_day_between("1900-13-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_448_test() {
  assert result.map(temporal.parse_day_between("1900-13-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_449_test() {
  assert result.map(temporal.parse_day_between("1900-13-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_450_test() {
  assert result.map(temporal.parse_day_between("1900-13-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_451_test() {
  assert result.map(temporal.parse_day_between("1900-13-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_452_test() {
  assert result.map(temporal.parse_day_between("1900-13-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_453_test() {
  assert result.map(temporal.parse_day_between("1900-13-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_454_test() {
  assert result.map(temporal.parse_day_between("1900-13-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_455_test() {
  assert result.map(temporal.parse_day_between("1900-13-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_456_test() {
  assert result.map(temporal.parse_day_between("1900-13-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_457_test() {
  assert result.map(temporal.parse_day_between("1900-13-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_458_test() {
  assert result.map(temporal.parse_day_between("1900-13-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_459_test() {
  assert result.map(temporal.parse_day_between("1900-13-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_460_test() {
  assert result.map(temporal.parse_day_between("1900-13-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_461_test() {
  assert result.map(temporal.parse_day_between("1900-13-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_462_test() {
  assert result.map(temporal.parse_day_between("2000-00-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_463_test() {
  assert result.map(temporal.parse_day_between("2000-00-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_464_test() {
  assert result.map(temporal.parse_day_between("2000-00-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_465_test() {
  assert result.map(temporal.parse_day_between("2000-00-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_466_test() {
  assert result.map(temporal.parse_day_between("2000-00-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_467_test() {
  assert result.map(temporal.parse_day_between("2000-00-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_468_test() {
  assert result.map(temporal.parse_day_between("2000-00-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_469_test() {
  assert result.map(temporal.parse_day_between("2000-00-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_470_test() {
  assert result.map(temporal.parse_day_between("2000-00-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_471_test() {
  assert result.map(temporal.parse_day_between("2000-00-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_472_test() {
  assert result.map(temporal.parse_day_between("2000-00-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_473_test() {
  assert result.map(temporal.parse_day_between("2000-00-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_474_test() {
  assert result.map(temporal.parse_day_between("2000-00-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_475_test() {
  assert result.map(temporal.parse_day_between("2000-00-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_476_test() {
  assert result.map(temporal.parse_day_between("2000-00-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_477_test() {
  assert result.map(temporal.parse_day_between("2000-00-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_478_test() {
  assert result.map(temporal.parse_day_between("2000-00-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_479_test() {
  assert result.map(temporal.parse_day_between("2000-00-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_480_test() {
  assert result.map(temporal.parse_day_between("2000-00-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_481_test() {
  assert result.map(temporal.parse_day_between("2000-00-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_482_test() {
  assert result.map(temporal.parse_day_between("2000-00-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_483_test() {
  assert result.map(temporal.parse_day_between("2000-00-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_484_test() {
  assert result.map(temporal.parse_day_between("2000-00-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_485_test() {
  assert result.map(temporal.parse_day_between("2000-00-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_486_test() {
  assert result.map(temporal.parse_day_between("2000-00-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_487_test() {
  assert result.map(temporal.parse_day_between("2000-00-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_488_test() {
  assert result.map(temporal.parse_day_between("2000-00-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_489_test() {
  assert result.map(temporal.parse_day_between("2000-00-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_490_test() {
  assert result.map(temporal.parse_day_between("2000-00-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_491_test() {
  assert result.map(temporal.parse_day_between("2000-00-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_492_test() {
  assert result.map(temporal.parse_day_between("2000-00-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_493_test() {
  assert result.map(temporal.parse_day_between("2000-00-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_494_test() {
  assert result.map(temporal.parse_day_between("2000-00-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_495_test() {
  assert result.map(temporal.parse_day_between("2000-01-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_496_test() {
  assert result.map(temporal.parse_day_between("2000-01-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-01", 946_684_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_497_test() {
  assert result.map(temporal.parse_day_between("2000-01-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-02", 946_771_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_498_test() {
  assert result.map(temporal.parse_day_between("2000-01-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-03", 946_857_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_499_test() {
  assert result.map(temporal.parse_day_between("2000-01-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-04", 946_944_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_500_test() {
  assert result.map(temporal.parse_day_between("2000-01-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-05", 947_030_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_501_test() {
  assert result.map(temporal.parse_day_between("2000-01-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-06", 947_116_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_502_test() {
  assert result.map(temporal.parse_day_between("2000-01-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-07", 947_203_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_503_test() {
  assert result.map(temporal.parse_day_between("2000-01-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-08", 947_289_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_504_test() {
  assert result.map(temporal.parse_day_between("2000-01-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-09", 947_376_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_505_test() {
  assert result.map(temporal.parse_day_between("2000-01-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-10", 947_462_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_506_test() {
  assert result.map(temporal.parse_day_between("2000-01-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-11", 947_548_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_507_test() {
  assert result.map(temporal.parse_day_between("2000-01-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-12", 947_635_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_508_test() {
  assert result.map(temporal.parse_day_between("2000-01-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-13", 947_721_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_509_test() {
  assert result.map(temporal.parse_day_between("2000-01-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-14", 947_808_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_510_test() {
  assert result.map(temporal.parse_day_between("2000-01-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-15", 947_894_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_511_test() {
  assert result.map(temporal.parse_day_between("2000-01-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-16", 947_980_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_512_test() {
  assert result.map(temporal.parse_day_between("2000-01-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-17", 948_067_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_513_test() {
  assert result.map(temporal.parse_day_between("2000-01-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-18", 948_153_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_514_test() {
  assert result.map(temporal.parse_day_between("2000-01-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-19", 948_240_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_515_test() {
  assert result.map(temporal.parse_day_between("2000-01-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-20", 948_326_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_516_test() {
  assert result.map(temporal.parse_day_between("2000-01-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-21", 948_412_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_517_test() {
  assert result.map(temporal.parse_day_between("2000-01-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-22", 948_499_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_518_test() {
  assert result.map(temporal.parse_day_between("2000-01-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-23", 948_585_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_519_test() {
  assert result.map(temporal.parse_day_between("2000-01-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-24", 948_672_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_520_test() {
  assert result.map(temporal.parse_day_between("2000-01-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-25", 948_758_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_521_test() {
  assert result.map(temporal.parse_day_between("2000-01-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-26", 948_844_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_522_test() {
  assert result.map(temporal.parse_day_between("2000-01-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-27", 948_931_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_523_test() {
  assert result.map(temporal.parse_day_between("2000-01-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-28", 949_017_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_524_test() {
  assert result.map(temporal.parse_day_between("2000-01-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-29", 949_104_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_525_test() {
  assert result.map(temporal.parse_day_between("2000-01-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-30", 949_190_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_526_test() {
  assert result.map(temporal.parse_day_between("2000-01-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-31", 949_276_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_527_test() {
  assert result.map(temporal.parse_day_between("2000-01-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_528_test() {
  assert result.map(temporal.parse_day_between("2000-02-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_529_test() {
  assert result.map(temporal.parse_day_between("2000-02-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-01", 949_363_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_530_test() {
  assert result.map(temporal.parse_day_between("2000-02-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-02", 949_449_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_531_test() {
  assert result.map(temporal.parse_day_between("2000-02-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-03", 949_536_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_532_test() {
  assert result.map(temporal.parse_day_between("2000-02-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-04", 949_622_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_533_test() {
  assert result.map(temporal.parse_day_between("2000-02-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-05", 949_708_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_534_test() {
  assert result.map(temporal.parse_day_between("2000-02-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-06", 949_795_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_535_test() {
  assert result.map(temporal.parse_day_between("2000-02-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-07", 949_881_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_536_test() {
  assert result.map(temporal.parse_day_between("2000-02-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-08", 949_968_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_537_test() {
  assert result.map(temporal.parse_day_between("2000-02-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-09", 950_054_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_538_test() {
  assert result.map(temporal.parse_day_between("2000-02-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-10", 950_140_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_539_test() {
  assert result.map(temporal.parse_day_between("2000-02-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-11", 950_227_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_540_test() {
  assert result.map(temporal.parse_day_between("2000-02-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-12", 950_313_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_541_test() {
  assert result.map(temporal.parse_day_between("2000-02-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-13", 950_400_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_542_test() {
  assert result.map(temporal.parse_day_between("2000-02-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-14", 950_486_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_543_test() {
  assert result.map(temporal.parse_day_between("2000-02-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-15", 950_572_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_544_test() {
  assert result.map(temporal.parse_day_between("2000-02-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-16", 950_659_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_545_test() {
  assert result.map(temporal.parse_day_between("2000-02-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-17", 950_745_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_546_test() {
  assert result.map(temporal.parse_day_between("2000-02-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-18", 950_832_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_547_test() {
  assert result.map(temporal.parse_day_between("2000-02-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-19", 950_918_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_548_test() {
  assert result.map(temporal.parse_day_between("2000-02-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-20", 951_004_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_549_test() {
  assert result.map(temporal.parse_day_between("2000-02-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-21", 951_091_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_550_test() {
  assert result.map(temporal.parse_day_between("2000-02-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-22", 951_177_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_551_test() {
  assert result.map(temporal.parse_day_between("2000-02-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-23", 951_264_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_552_test() {
  assert result.map(temporal.parse_day_between("2000-02-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-24", 951_350_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_553_test() {
  assert result.map(temporal.parse_day_between("2000-02-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-25", 951_436_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_554_test() {
  assert result.map(temporal.parse_day_between("2000-02-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-26", 951_523_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_555_test() {
  assert result.map(temporal.parse_day_between("2000-02-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-27", 951_609_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_556_test() {
  assert result.map(temporal.parse_day_between("2000-02-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-02-28", 951_696_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_557_test() {
  assert result.map(temporal.parse_day_between("2000-02-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_558_test() {
  assert result.map(temporal.parse_day_between("2000-02-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_559_test() {
  assert result.map(temporal.parse_day_between("2000-02-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_560_test() {
  assert result.map(temporal.parse_day_between("2000-03-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_561_test() {
  assert result.map(temporal.parse_day_between("2000-03-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-01", 951_868_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_562_test() {
  assert result.map(temporal.parse_day_between("2000-03-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-02", 951_955_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_563_test() {
  assert result.map(temporal.parse_day_between("2000-03-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-03", 952_041_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_564_test() {
  assert result.map(temporal.parse_day_between("2000-03-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-04", 952_128_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_565_test() {
  assert result.map(temporal.parse_day_between("2000-03-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-05", 952_214_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_566_test() {
  assert result.map(temporal.parse_day_between("2000-03-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-06", 952_300_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_567_test() {
  assert result.map(temporal.parse_day_between("2000-03-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-07", 952_387_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_568_test() {
  assert result.map(temporal.parse_day_between("2000-03-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-08", 952_473_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_569_test() {
  assert result.map(temporal.parse_day_between("2000-03-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-09", 952_560_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_570_test() {
  assert result.map(temporal.parse_day_between("2000-03-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-10", 952_646_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_571_test() {
  assert result.map(temporal.parse_day_between("2000-03-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-11", 952_732_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_572_test() {
  assert result.map(temporal.parse_day_between("2000-03-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-12", 952_819_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_573_test() {
  assert result.map(temporal.parse_day_between("2000-03-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-13", 952_905_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_574_test() {
  assert result.map(temporal.parse_day_between("2000-03-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-14", 952_992_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_575_test() {
  assert result.map(temporal.parse_day_between("2000-03-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-15", 953_078_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_576_test() {
  assert result.map(temporal.parse_day_between("2000-03-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-16", 953_164_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_577_test() {
  assert result.map(temporal.parse_day_between("2000-03-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-17", 953_251_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_578_test() {
  assert result.map(temporal.parse_day_between("2000-03-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-18", 953_337_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_579_test() {
  assert result.map(temporal.parse_day_between("2000-03-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-19", 953_424_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_580_test() {
  assert result.map(temporal.parse_day_between("2000-03-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-20", 953_510_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_581_test() {
  assert result.map(temporal.parse_day_between("2000-03-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-21", 953_596_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_582_test() {
  assert result.map(temporal.parse_day_between("2000-03-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-22", 953_683_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_583_test() {
  assert result.map(temporal.parse_day_between("2000-03-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-23", 953_769_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_584_test() {
  assert result.map(temporal.parse_day_between("2000-03-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-24", 953_856_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_585_test() {
  assert result.map(temporal.parse_day_between("2000-03-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-25", 953_942_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_586_test() {
  assert result.map(temporal.parse_day_between("2000-03-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-26", 954_028_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_587_test() {
  assert result.map(temporal.parse_day_between("2000-03-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-27", 954_115_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_588_test() {
  assert result.map(temporal.parse_day_between("2000-03-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-28", 954_201_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_589_test() {
  assert result.map(temporal.parse_day_between("2000-03-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-29", 954_288_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_590_test() {
  assert result.map(temporal.parse_day_between("2000-03-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-30", 954_374_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_591_test() {
  assert result.map(temporal.parse_day_between("2000-03-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-03-31", 954_460_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_592_test() {
  assert result.map(temporal.parse_day_between("2000-03-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_593_test() {
  assert result.map(temporal.parse_day_between("2000-04-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_594_test() {
  assert result.map(temporal.parse_day_between("2000-04-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-01", 954_547_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_595_test() {
  assert result.map(temporal.parse_day_between("2000-04-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-02", 954_633_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_596_test() {
  assert result.map(temporal.parse_day_between("2000-04-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-03", 954_720_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_597_test() {
  assert result.map(temporal.parse_day_between("2000-04-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-04", 954_806_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_598_test() {
  assert result.map(temporal.parse_day_between("2000-04-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-05", 954_892_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_599_test() {
  assert result.map(temporal.parse_day_between("2000-04-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-06", 954_979_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_600_test() {
  assert result.map(temporal.parse_day_between("2000-04-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-07", 955_065_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_601_test() {
  assert result.map(temporal.parse_day_between("2000-04-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-08", 955_152_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_602_test() {
  assert result.map(temporal.parse_day_between("2000-04-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-09", 955_238_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_603_test() {
  assert result.map(temporal.parse_day_between("2000-04-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-10", 955_324_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_604_test() {
  assert result.map(temporal.parse_day_between("2000-04-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-11", 955_411_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_605_test() {
  assert result.map(temporal.parse_day_between("2000-04-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-12", 955_497_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_606_test() {
  assert result.map(temporal.parse_day_between("2000-04-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-13", 955_584_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_607_test() {
  assert result.map(temporal.parse_day_between("2000-04-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-14", 955_670_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_608_test() {
  assert result.map(temporal.parse_day_between("2000-04-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-15", 955_756_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_609_test() {
  assert result.map(temporal.parse_day_between("2000-04-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-16", 955_843_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_610_test() {
  assert result.map(temporal.parse_day_between("2000-04-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-17", 955_929_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_611_test() {
  assert result.map(temporal.parse_day_between("2000-04-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-18", 956_016_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_612_test() {
  assert result.map(temporal.parse_day_between("2000-04-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-19", 956_102_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_613_test() {
  assert result.map(temporal.parse_day_between("2000-04-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-20", 956_188_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_614_test() {
  assert result.map(temporal.parse_day_between("2000-04-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-21", 956_275_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_615_test() {
  assert result.map(temporal.parse_day_between("2000-04-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-22", 956_361_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_616_test() {
  assert result.map(temporal.parse_day_between("2000-04-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-23", 956_448_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_617_test() {
  assert result.map(temporal.parse_day_between("2000-04-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-24", 956_534_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_618_test() {
  assert result.map(temporal.parse_day_between("2000-04-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-25", 956_620_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_619_test() {
  assert result.map(temporal.parse_day_between("2000-04-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-26", 956_707_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_620_test() {
  assert result.map(temporal.parse_day_between("2000-04-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-27", 956_793_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_621_test() {
  assert result.map(temporal.parse_day_between("2000-04-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-28", 956_880_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_622_test() {
  assert result.map(temporal.parse_day_between("2000-04-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-29", 956_966_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_623_test() {
  assert result.map(temporal.parse_day_between("2000-04-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-04-30", 957_052_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_624_test() {
  assert result.map(temporal.parse_day_between("2000-04-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_625_test() {
  assert result.map(temporal.parse_day_between("2000-04-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_626_test() {
  assert result.map(temporal.parse_day_between("2000-05-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_627_test() {
  assert result.map(temporal.parse_day_between("2000-05-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-01", 957_139_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_628_test() {
  assert result.map(temporal.parse_day_between("2000-05-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-02", 957_225_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_629_test() {
  assert result.map(temporal.parse_day_between("2000-05-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-03", 957_312_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_630_test() {
  assert result.map(temporal.parse_day_between("2000-05-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-04", 957_398_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_631_test() {
  assert result.map(temporal.parse_day_between("2000-05-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-05", 957_484_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_632_test() {
  assert result.map(temporal.parse_day_between("2000-05-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-06", 957_571_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_633_test() {
  assert result.map(temporal.parse_day_between("2000-05-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-07", 957_657_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_634_test() {
  assert result.map(temporal.parse_day_between("2000-05-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-08", 957_744_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_635_test() {
  assert result.map(temporal.parse_day_between("2000-05-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-09", 957_830_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_636_test() {
  assert result.map(temporal.parse_day_between("2000-05-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-10", 957_916_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_637_test() {
  assert result.map(temporal.parse_day_between("2000-05-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-11", 958_003_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_638_test() {
  assert result.map(temporal.parse_day_between("2000-05-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-12", 958_089_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_639_test() {
  assert result.map(temporal.parse_day_between("2000-05-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-13", 958_176_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_640_test() {
  assert result.map(temporal.parse_day_between("2000-05-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-14", 958_262_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_641_test() {
  assert result.map(temporal.parse_day_between("2000-05-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-15", 958_348_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_642_test() {
  assert result.map(temporal.parse_day_between("2000-05-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-16", 958_435_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_643_test() {
  assert result.map(temporal.parse_day_between("2000-05-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-17", 958_521_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_644_test() {
  assert result.map(temporal.parse_day_between("2000-05-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-18", 958_608_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_645_test() {
  assert result.map(temporal.parse_day_between("2000-05-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-19", 958_694_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_646_test() {
  assert result.map(temporal.parse_day_between("2000-05-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-20", 958_780_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_647_test() {
  assert result.map(temporal.parse_day_between("2000-05-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-21", 958_867_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_648_test() {
  assert result.map(temporal.parse_day_between("2000-05-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-22", 958_953_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_649_test() {
  assert result.map(temporal.parse_day_between("2000-05-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-23", 959_040_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_650_test() {
  assert result.map(temporal.parse_day_between("2000-05-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-24", 959_126_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_651_test() {
  assert result.map(temporal.parse_day_between("2000-05-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-25", 959_212_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_652_test() {
  assert result.map(temporal.parse_day_between("2000-05-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-26", 959_299_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_653_test() {
  assert result.map(temporal.parse_day_between("2000-05-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-27", 959_385_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_654_test() {
  assert result.map(temporal.parse_day_between("2000-05-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-28", 959_472_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_655_test() {
  assert result.map(temporal.parse_day_between("2000-05-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-29", 959_558_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_656_test() {
  assert result.map(temporal.parse_day_between("2000-05-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-30", 959_644_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_657_test() {
  assert result.map(temporal.parse_day_between("2000-05-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-05-31", 959_731_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_658_test() {
  assert result.map(temporal.parse_day_between("2000-05-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_659_test() {
  assert result.map(temporal.parse_day_between("2000-06-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_660_test() {
  assert result.map(temporal.parse_day_between("2000-06-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-01", 959_817_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_661_test() {
  assert result.map(temporal.parse_day_between("2000-06-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-02", 959_904_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_662_test() {
  assert result.map(temporal.parse_day_between("2000-06-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-03", 959_990_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_663_test() {
  assert result.map(temporal.parse_day_between("2000-06-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-04", 960_076_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_664_test() {
  assert result.map(temporal.parse_day_between("2000-06-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-05", 960_163_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_665_test() {
  assert result.map(temporal.parse_day_between("2000-06-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-06", 960_249_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_666_test() {
  assert result.map(temporal.parse_day_between("2000-06-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-07", 960_336_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_667_test() {
  assert result.map(temporal.parse_day_between("2000-06-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-08", 960_422_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_668_test() {
  assert result.map(temporal.parse_day_between("2000-06-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-09", 960_508_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_669_test() {
  assert result.map(temporal.parse_day_between("2000-06-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-10", 960_595_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_670_test() {
  assert result.map(temporal.parse_day_between("2000-06-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-11", 960_681_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_671_test() {
  assert result.map(temporal.parse_day_between("2000-06-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-12", 960_768_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_672_test() {
  assert result.map(temporal.parse_day_between("2000-06-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-13", 960_854_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_673_test() {
  assert result.map(temporal.parse_day_between("2000-06-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-14", 960_940_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_674_test() {
  assert result.map(temporal.parse_day_between("2000-06-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-15", 961_027_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_675_test() {
  assert result.map(temporal.parse_day_between("2000-06-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-16", 961_113_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_676_test() {
  assert result.map(temporal.parse_day_between("2000-06-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-17", 961_200_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_677_test() {
  assert result.map(temporal.parse_day_between("2000-06-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-18", 961_286_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_678_test() {
  assert result.map(temporal.parse_day_between("2000-06-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-19", 961_372_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_679_test() {
  assert result.map(temporal.parse_day_between("2000-06-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-20", 961_459_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_680_test() {
  assert result.map(temporal.parse_day_between("2000-06-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-21", 961_545_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_681_test() {
  assert result.map(temporal.parse_day_between("2000-06-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-22", 961_632_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_682_test() {
  assert result.map(temporal.parse_day_between("2000-06-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-23", 961_718_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_683_test() {
  assert result.map(temporal.parse_day_between("2000-06-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-24", 961_804_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_684_test() {
  assert result.map(temporal.parse_day_between("2000-06-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-25", 961_891_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_685_test() {
  assert result.map(temporal.parse_day_between("2000-06-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-26", 961_977_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_686_test() {
  assert result.map(temporal.parse_day_between("2000-06-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-27", 962_064_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_687_test() {
  assert result.map(temporal.parse_day_between("2000-06-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-28", 962_150_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_688_test() {
  assert result.map(temporal.parse_day_between("2000-06-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-29", 962_236_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_689_test() {
  assert result.map(temporal.parse_day_between("2000-06-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-06-30", 962_323_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_690_test() {
  assert result.map(temporal.parse_day_between("2000-06-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_691_test() {
  assert result.map(temporal.parse_day_between("2000-06-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_692_test() {
  assert result.map(temporal.parse_day_between("2000-07-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_693_test() {
  assert result.map(temporal.parse_day_between("2000-07-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-01", 962_409_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_694_test() {
  assert result.map(temporal.parse_day_between("2000-07-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-02", 962_496_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_695_test() {
  assert result.map(temporal.parse_day_between("2000-07-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-03", 962_582_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_696_test() {
  assert result.map(temporal.parse_day_between("2000-07-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-04", 962_668_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_697_test() {
  assert result.map(temporal.parse_day_between("2000-07-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-05", 962_755_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_698_test() {
  assert result.map(temporal.parse_day_between("2000-07-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-06", 962_841_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_699_test() {
  assert result.map(temporal.parse_day_between("2000-07-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-07", 962_928_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_700_test() {
  assert result.map(temporal.parse_day_between("2000-07-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-08", 963_014_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_701_test() {
  assert result.map(temporal.parse_day_between("2000-07-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-09", 963_100_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_702_test() {
  assert result.map(temporal.parse_day_between("2000-07-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-10", 963_187_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_703_test() {
  assert result.map(temporal.parse_day_between("2000-07-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-11", 963_273_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_704_test() {
  assert result.map(temporal.parse_day_between("2000-07-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-12", 963_360_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_705_test() {
  assert result.map(temporal.parse_day_between("2000-07-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-13", 963_446_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_706_test() {
  assert result.map(temporal.parse_day_between("2000-07-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-14", 963_532_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_707_test() {
  assert result.map(temporal.parse_day_between("2000-07-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-15", 963_619_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_708_test() {
  assert result.map(temporal.parse_day_between("2000-07-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-16", 963_705_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_709_test() {
  assert result.map(temporal.parse_day_between("2000-07-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-17", 963_792_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_710_test() {
  assert result.map(temporal.parse_day_between("2000-07-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-18", 963_878_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_711_test() {
  assert result.map(temporal.parse_day_between("2000-07-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-19", 963_964_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_712_test() {
  assert result.map(temporal.parse_day_between("2000-07-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-20", 964_051_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_713_test() {
  assert result.map(temporal.parse_day_between("2000-07-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-21", 964_137_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_714_test() {
  assert result.map(temporal.parse_day_between("2000-07-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-22", 964_224_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_715_test() {
  assert result.map(temporal.parse_day_between("2000-07-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-23", 964_310_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_716_test() {
  assert result.map(temporal.parse_day_between("2000-07-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-24", 964_396_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_717_test() {
  assert result.map(temporal.parse_day_between("2000-07-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-25", 964_483_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_718_test() {
  assert result.map(temporal.parse_day_between("2000-07-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-26", 964_569_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_719_test() {
  assert result.map(temporal.parse_day_between("2000-07-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-27", 964_656_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_720_test() {
  assert result.map(temporal.parse_day_between("2000-07-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-28", 964_742_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_721_test() {
  assert result.map(temporal.parse_day_between("2000-07-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-29", 964_828_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_722_test() {
  assert result.map(temporal.parse_day_between("2000-07-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-30", 964_915_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_723_test() {
  assert result.map(temporal.parse_day_between("2000-07-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-07-31", 965_001_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_724_test() {
  assert result.map(temporal.parse_day_between("2000-07-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_725_test() {
  assert result.map(temporal.parse_day_between("2000-08-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_726_test() {
  assert result.map(temporal.parse_day_between("2000-08-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-01", 965_088_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_727_test() {
  assert result.map(temporal.parse_day_between("2000-08-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-02", 965_174_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_728_test() {
  assert result.map(temporal.parse_day_between("2000-08-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-03", 965_260_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_729_test() {
  assert result.map(temporal.parse_day_between("2000-08-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-04", 965_347_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_730_test() {
  assert result.map(temporal.parse_day_between("2000-08-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-05", 965_433_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_731_test() {
  assert result.map(temporal.parse_day_between("2000-08-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-06", 965_520_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_732_test() {
  assert result.map(temporal.parse_day_between("2000-08-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-07", 965_606_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_733_test() {
  assert result.map(temporal.parse_day_between("2000-08-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-08", 965_692_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_734_test() {
  assert result.map(temporal.parse_day_between("2000-08-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-09", 965_779_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_735_test() {
  assert result.map(temporal.parse_day_between("2000-08-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-10", 965_865_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_736_test() {
  assert result.map(temporal.parse_day_between("2000-08-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-11", 965_952_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_737_test() {
  assert result.map(temporal.parse_day_between("2000-08-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-12", 966_038_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_738_test() {
  assert result.map(temporal.parse_day_between("2000-08-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-13", 966_124_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_739_test() {
  assert result.map(temporal.parse_day_between("2000-08-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-14", 966_211_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_740_test() {
  assert result.map(temporal.parse_day_between("2000-08-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-15", 966_297_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_741_test() {
  assert result.map(temporal.parse_day_between("2000-08-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-16", 966_384_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_742_test() {
  assert result.map(temporal.parse_day_between("2000-08-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-17", 966_470_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_743_test() {
  assert result.map(temporal.parse_day_between("2000-08-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-18", 966_556_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_744_test() {
  assert result.map(temporal.parse_day_between("2000-08-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-19", 966_643_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_745_test() {
  assert result.map(temporal.parse_day_between("2000-08-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-20", 966_729_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_746_test() {
  assert result.map(temporal.parse_day_between("2000-08-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-21", 966_816_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_747_test() {
  assert result.map(temporal.parse_day_between("2000-08-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-22", 966_902_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_748_test() {
  assert result.map(temporal.parse_day_between("2000-08-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-23", 966_988_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_749_test() {
  assert result.map(temporal.parse_day_between("2000-08-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-24", 967_075_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_750_test() {
  assert result.map(temporal.parse_day_between("2000-08-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-25", 967_161_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_751_test() {
  assert result.map(temporal.parse_day_between("2000-08-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-26", 967_248_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_752_test() {
  assert result.map(temporal.parse_day_between("2000-08-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-27", 967_334_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_753_test() {
  assert result.map(temporal.parse_day_between("2000-08-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-28", 967_420_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_754_test() {
  assert result.map(temporal.parse_day_between("2000-08-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-29", 967_507_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_755_test() {
  assert result.map(temporal.parse_day_between("2000-08-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-30", 967_593_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_756_test() {
  assert result.map(temporal.parse_day_between("2000-08-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-08-31", 967_680_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_757_test() {
  assert result.map(temporal.parse_day_between("2000-08-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_758_test() {
  assert result.map(temporal.parse_day_between("2000-09-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_759_test() {
  assert result.map(temporal.parse_day_between("2000-09-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-01", 967_766_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_760_test() {
  assert result.map(temporal.parse_day_between("2000-09-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-02", 967_852_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_761_test() {
  assert result.map(temporal.parse_day_between("2000-09-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-03", 967_939_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_762_test() {
  assert result.map(temporal.parse_day_between("2000-09-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-04", 968_025_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_763_test() {
  assert result.map(temporal.parse_day_between("2000-09-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-05", 968_112_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_764_test() {
  assert result.map(temporal.parse_day_between("2000-09-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-06", 968_198_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_765_test() {
  assert result.map(temporal.parse_day_between("2000-09-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-07", 968_284_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_766_test() {
  assert result.map(temporal.parse_day_between("2000-09-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-08", 968_371_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_767_test() {
  assert result.map(temporal.parse_day_between("2000-09-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-09", 968_457_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_768_test() {
  assert result.map(temporal.parse_day_between("2000-09-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-10", 968_544_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_769_test() {
  assert result.map(temporal.parse_day_between("2000-09-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-11", 968_630_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_770_test() {
  assert result.map(temporal.parse_day_between("2000-09-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-12", 968_716_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_771_test() {
  assert result.map(temporal.parse_day_between("2000-09-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-13", 968_803_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_772_test() {
  assert result.map(temporal.parse_day_between("2000-09-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-14", 968_889_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_773_test() {
  assert result.map(temporal.parse_day_between("2000-09-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-15", 968_976_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_774_test() {
  assert result.map(temporal.parse_day_between("2000-09-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-16", 969_062_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_775_test() {
  assert result.map(temporal.parse_day_between("2000-09-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-17", 969_148_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_776_test() {
  assert result.map(temporal.parse_day_between("2000-09-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-18", 969_235_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_777_test() {
  assert result.map(temporal.parse_day_between("2000-09-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-19", 969_321_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_778_test() {
  assert result.map(temporal.parse_day_between("2000-09-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-20", 969_408_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_779_test() {
  assert result.map(temporal.parse_day_between("2000-09-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-21", 969_494_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_780_test() {
  assert result.map(temporal.parse_day_between("2000-09-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-22", 969_580_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_781_test() {
  assert result.map(temporal.parse_day_between("2000-09-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-23", 969_667_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_782_test() {
  assert result.map(temporal.parse_day_between("2000-09-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-24", 969_753_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_783_test() {
  assert result.map(temporal.parse_day_between("2000-09-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-25", 969_840_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_784_test() {
  assert result.map(temporal.parse_day_between("2000-09-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-26", 969_926_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_785_test() {
  assert result.map(temporal.parse_day_between("2000-09-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-27", 970_012_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_786_test() {
  assert result.map(temporal.parse_day_between("2000-09-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-28", 970_099_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_787_test() {
  assert result.map(temporal.parse_day_between("2000-09-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-29", 970_185_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_788_test() {
  assert result.map(temporal.parse_day_between("2000-09-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-09-30", 970_272_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_789_test() {
  assert result.map(temporal.parse_day_between("2000-09-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_790_test() {
  assert result.map(temporal.parse_day_between("2000-09-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_791_test() {
  assert result.map(temporal.parse_day_between("2000-10-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_792_test() {
  assert result.map(temporal.parse_day_between("2000-10-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-01", 970_358_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_793_test() {
  assert result.map(temporal.parse_day_between("2000-10-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-02", 970_444_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_794_test() {
  assert result.map(temporal.parse_day_between("2000-10-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-03", 970_531_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_795_test() {
  assert result.map(temporal.parse_day_between("2000-10-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-04", 970_617_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_796_test() {
  assert result.map(temporal.parse_day_between("2000-10-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-05", 970_704_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_797_test() {
  assert result.map(temporal.parse_day_between("2000-10-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-06", 970_790_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_798_test() {
  assert result.map(temporal.parse_day_between("2000-10-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-07", 970_876_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_799_test() {
  assert result.map(temporal.parse_day_between("2000-10-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-08", 970_963_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_800_test() {
  assert result.map(temporal.parse_day_between("2000-10-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-09", 971_049_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_801_test() {
  assert result.map(temporal.parse_day_between("2000-10-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-10", 971_136_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_802_test() {
  assert result.map(temporal.parse_day_between("2000-10-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-11", 971_222_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_803_test() {
  assert result.map(temporal.parse_day_between("2000-10-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-12", 971_308_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_804_test() {
  assert result.map(temporal.parse_day_between("2000-10-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-13", 971_395_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_805_test() {
  assert result.map(temporal.parse_day_between("2000-10-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-14", 971_481_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_806_test() {
  assert result.map(temporal.parse_day_between("2000-10-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-15", 971_568_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_807_test() {
  assert result.map(temporal.parse_day_between("2000-10-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-16", 971_654_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_808_test() {
  assert result.map(temporal.parse_day_between("2000-10-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-17", 971_740_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_809_test() {
  assert result.map(temporal.parse_day_between("2000-10-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-18", 971_827_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_810_test() {
  assert result.map(temporal.parse_day_between("2000-10-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-19", 971_913_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_811_test() {
  assert result.map(temporal.parse_day_between("2000-10-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-20", 972_000_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_812_test() {
  assert result.map(temporal.parse_day_between("2000-10-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-21", 972_086_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_813_test() {
  assert result.map(temporal.parse_day_between("2000-10-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-22", 972_172_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_814_test() {
  assert result.map(temporal.parse_day_between("2000-10-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-23", 972_259_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_815_test() {
  assert result.map(temporal.parse_day_between("2000-10-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-24", 972_345_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_816_test() {
  assert result.map(temporal.parse_day_between("2000-10-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-25", 972_432_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_817_test() {
  assert result.map(temporal.parse_day_between("2000-10-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-26", 972_518_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_818_test() {
  assert result.map(temporal.parse_day_between("2000-10-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-27", 972_604_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_819_test() {
  assert result.map(temporal.parse_day_between("2000-10-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-28", 972_691_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_820_test() {
  assert result.map(temporal.parse_day_between("2000-10-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-29", 972_777_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_821_test() {
  assert result.map(temporal.parse_day_between("2000-10-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-30", 972_864_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_822_test() {
  assert result.map(temporal.parse_day_between("2000-10-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-10-31", 972_950_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_823_test() {
  assert result.map(temporal.parse_day_between("2000-10-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_824_test() {
  assert result.map(temporal.parse_day_between("2000-11-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_825_test() {
  assert result.map(temporal.parse_day_between("2000-11-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-01", 973_036_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_826_test() {
  assert result.map(temporal.parse_day_between("2000-11-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-02", 973_123_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_827_test() {
  assert result.map(temporal.parse_day_between("2000-11-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-03", 973_209_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_828_test() {
  assert result.map(temporal.parse_day_between("2000-11-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-04", 973_296_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_829_test() {
  assert result.map(temporal.parse_day_between("2000-11-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-05", 973_382_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_830_test() {
  assert result.map(temporal.parse_day_between("2000-11-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-06", 973_468_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_831_test() {
  assert result.map(temporal.parse_day_between("2000-11-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-07", 973_555_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_832_test() {
  assert result.map(temporal.parse_day_between("2000-11-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-08", 973_641_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_833_test() {
  assert result.map(temporal.parse_day_between("2000-11-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-09", 973_728_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_834_test() {
  assert result.map(temporal.parse_day_between("2000-11-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-10", 973_814_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_835_test() {
  assert result.map(temporal.parse_day_between("2000-11-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-11", 973_900_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_836_test() {
  assert result.map(temporal.parse_day_between("2000-11-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-12", 973_987_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_837_test() {
  assert result.map(temporal.parse_day_between("2000-11-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-13", 974_073_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_838_test() {
  assert result.map(temporal.parse_day_between("2000-11-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-14", 974_160_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_839_test() {
  assert result.map(temporal.parse_day_between("2000-11-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-15", 974_246_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_840_test() {
  assert result.map(temporal.parse_day_between("2000-11-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-16", 974_332_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_841_test() {
  assert result.map(temporal.parse_day_between("2000-11-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-17", 974_419_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_842_test() {
  assert result.map(temporal.parse_day_between("2000-11-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-18", 974_505_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_843_test() {
  assert result.map(temporal.parse_day_between("2000-11-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-19", 974_592_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_844_test() {
  assert result.map(temporal.parse_day_between("2000-11-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-20", 974_678_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_845_test() {
  assert result.map(temporal.parse_day_between("2000-11-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-21", 974_764_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_846_test() {
  assert result.map(temporal.parse_day_between("2000-11-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-22", 974_851_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_847_test() {
  assert result.map(temporal.parse_day_between("2000-11-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-23", 974_937_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_848_test() {
  assert result.map(temporal.parse_day_between("2000-11-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-24", 975_024_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_849_test() {
  assert result.map(temporal.parse_day_between("2000-11-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-25", 975_110_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_850_test() {
  assert result.map(temporal.parse_day_between("2000-11-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-26", 975_196_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_851_test() {
  assert result.map(temporal.parse_day_between("2000-11-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-27", 975_283_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_852_test() {
  assert result.map(temporal.parse_day_between("2000-11-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-28", 975_369_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_853_test() {
  assert result.map(temporal.parse_day_between("2000-11-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-29", 975_456_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_854_test() {
  assert result.map(temporal.parse_day_between("2000-11-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-11-30", 975_542_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_855_test() {
  assert result.map(temporal.parse_day_between("2000-11-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_856_test() {
  assert result.map(temporal.parse_day_between("2000-11-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_857_test() {
  assert result.map(temporal.parse_day_between("2000-12-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_858_test() {
  assert result.map(temporal.parse_day_between("2000-12-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-01", 975_628_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_859_test() {
  assert result.map(temporal.parse_day_between("2000-12-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-02", 975_715_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_860_test() {
  assert result.map(temporal.parse_day_between("2000-12-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-03", 975_801_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_861_test() {
  assert result.map(temporal.parse_day_between("2000-12-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-04", 975_888_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_862_test() {
  assert result.map(temporal.parse_day_between("2000-12-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-05", 975_974_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_863_test() {
  assert result.map(temporal.parse_day_between("2000-12-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-06", 976_060_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_864_test() {
  assert result.map(temporal.parse_day_between("2000-12-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-07", 976_147_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_865_test() {
  assert result.map(temporal.parse_day_between("2000-12-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-08", 976_233_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_866_test() {
  assert result.map(temporal.parse_day_between("2000-12-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-09", 976_320_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_867_test() {
  assert result.map(temporal.parse_day_between("2000-12-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-10", 976_406_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_868_test() {
  assert result.map(temporal.parse_day_between("2000-12-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-11", 976_492_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_869_test() {
  assert result.map(temporal.parse_day_between("2000-12-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-12", 976_579_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_870_test() {
  assert result.map(temporal.parse_day_between("2000-12-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-13", 976_665_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_871_test() {
  assert result.map(temporal.parse_day_between("2000-12-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-14", 976_752_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_872_test() {
  assert result.map(temporal.parse_day_between("2000-12-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-15", 976_838_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_873_test() {
  assert result.map(temporal.parse_day_between("2000-12-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-16", 976_924_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_874_test() {
  assert result.map(temporal.parse_day_between("2000-12-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-17", 977_011_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_875_test() {
  assert result.map(temporal.parse_day_between("2000-12-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-18", 977_097_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_876_test() {
  assert result.map(temporal.parse_day_between("2000-12-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-19", 977_184_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_877_test() {
  assert result.map(temporal.parse_day_between("2000-12-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-20", 977_270_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_878_test() {
  assert result.map(temporal.parse_day_between("2000-12-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-21", 977_356_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_879_test() {
  assert result.map(temporal.parse_day_between("2000-12-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-22", 977_443_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_880_test() {
  assert result.map(temporal.parse_day_between("2000-12-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-23", 977_529_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_881_test() {
  assert result.map(temporal.parse_day_between("2000-12-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-24", 977_616_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_882_test() {
  assert result.map(temporal.parse_day_between("2000-12-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-25", 977_702_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_883_test() {
  assert result.map(temporal.parse_day_between("2000-12-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-26", 977_788_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_884_test() {
  assert result.map(temporal.parse_day_between("2000-12-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-27", 977_875_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_885_test() {
  assert result.map(temporal.parse_day_between("2000-12-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-28", 977_961_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_886_test() {
  assert result.map(temporal.parse_day_between("2000-12-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-29", 978_048_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_887_test() {
  assert result.map(temporal.parse_day_between("2000-12-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-30", 978_134_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_888_test() {
  assert result.map(temporal.parse_day_between("2000-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-12-31", 978_220_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_889_test() {
  assert result.map(temporal.parse_day_between("2000-12-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_890_test() {
  assert result.map(temporal.parse_day_between("2000-13-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_891_test() {
  assert result.map(temporal.parse_day_between("2000-13-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_892_test() {
  assert result.map(temporal.parse_day_between("2000-13-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_893_test() {
  assert result.map(temporal.parse_day_between("2000-13-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_894_test() {
  assert result.map(temporal.parse_day_between("2000-13-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_895_test() {
  assert result.map(temporal.parse_day_between("2000-13-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_896_test() {
  assert result.map(temporal.parse_day_between("2000-13-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_897_test() {
  assert result.map(temporal.parse_day_between("2000-13-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_898_test() {
  assert result.map(temporal.parse_day_between("2000-13-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_899_test() {
  assert result.map(temporal.parse_day_between("2000-13-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_900_test() {
  assert result.map(temporal.parse_day_between("2000-13-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_901_test() {
  assert result.map(temporal.parse_day_between("2000-13-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_902_test() {
  assert result.map(temporal.parse_day_between("2000-13-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_903_test() {
  assert result.map(temporal.parse_day_between("2000-13-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_904_test() {
  assert result.map(temporal.parse_day_between("2000-13-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_905_test() {
  assert result.map(temporal.parse_day_between("2000-13-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_906_test() {
  assert result.map(temporal.parse_day_between("2000-13-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_907_test() {
  assert result.map(temporal.parse_day_between("2000-13-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_908_test() {
  assert result.map(temporal.parse_day_between("2000-13-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_909_test() {
  assert result.map(temporal.parse_day_between("2000-13-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_910_test() {
  assert result.map(temporal.parse_day_between("2000-13-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_911_test() {
  assert result.map(temporal.parse_day_between("2000-13-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_912_test() {
  assert result.map(temporal.parse_day_between("2000-13-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_913_test() {
  assert result.map(temporal.parse_day_between("2000-13-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_914_test() {
  assert result.map(temporal.parse_day_between("2000-13-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_915_test() {
  assert result.map(temporal.parse_day_between("2000-13-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_916_test() {
  assert result.map(temporal.parse_day_between("2000-13-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_917_test() {
  assert result.map(temporal.parse_day_between("2000-13-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_918_test() {
  assert result.map(temporal.parse_day_between("2000-13-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_919_test() {
  assert result.map(temporal.parse_day_between("2000-13-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_920_test() {
  assert result.map(temporal.parse_day_between("2000-13-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_921_test() {
  assert result.map(temporal.parse_day_between("2000-13-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_922_test() {
  assert result.map(temporal.parse_day_between("2000-13-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_923_test() {
  assert result.map(temporal.parse_day_between("2023-00-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_924_test() {
  assert result.map(temporal.parse_day_between("2023-00-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_925_test() {
  assert result.map(temporal.parse_day_between("2023-00-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_926_test() {
  assert result.map(temporal.parse_day_between("2023-00-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_927_test() {
  assert result.map(temporal.parse_day_between("2023-00-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_928_test() {
  assert result.map(temporal.parse_day_between("2023-00-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_929_test() {
  assert result.map(temporal.parse_day_between("2023-00-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_930_test() {
  assert result.map(temporal.parse_day_between("2023-00-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_931_test() {
  assert result.map(temporal.parse_day_between("2023-00-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_932_test() {
  assert result.map(temporal.parse_day_between("2023-00-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_933_test() {
  assert result.map(temporal.parse_day_between("2023-00-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_934_test() {
  assert result.map(temporal.parse_day_between("2023-00-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_935_test() {
  assert result.map(temporal.parse_day_between("2023-00-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_936_test() {
  assert result.map(temporal.parse_day_between("2023-00-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_937_test() {
  assert result.map(temporal.parse_day_between("2023-00-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_938_test() {
  assert result.map(temporal.parse_day_between("2023-00-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_939_test() {
  assert result.map(temporal.parse_day_between("2023-00-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_940_test() {
  assert result.map(temporal.parse_day_between("2023-00-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_941_test() {
  assert result.map(temporal.parse_day_between("2023-00-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_942_test() {
  assert result.map(temporal.parse_day_between("2023-00-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_943_test() {
  assert result.map(temporal.parse_day_between("2023-00-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_944_test() {
  assert result.map(temporal.parse_day_between("2023-00-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_945_test() {
  assert result.map(temporal.parse_day_between("2023-00-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_946_test() {
  assert result.map(temporal.parse_day_between("2023-00-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_947_test() {
  assert result.map(temporal.parse_day_between("2023-00-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_948_test() {
  assert result.map(temporal.parse_day_between("2023-00-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_949_test() {
  assert result.map(temporal.parse_day_between("2023-00-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_950_test() {
  assert result.map(temporal.parse_day_between("2023-00-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_951_test() {
  assert result.map(temporal.parse_day_between("2023-00-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_952_test() {
  assert result.map(temporal.parse_day_between("2023-00-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_953_test() {
  assert result.map(temporal.parse_day_between("2023-00-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_954_test() {
  assert result.map(temporal.parse_day_between("2023-00-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_955_test() {
  assert result.map(temporal.parse_day_between("2023-01-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-01", 1_672_531_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_956_test() {
  assert result.map(temporal.parse_day_between("2023-01-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-02", 1_672_617_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_957_test() {
  assert result.map(temporal.parse_day_between("2023-01-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-03", 1_672_704_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_958_test() {
  assert result.map(temporal.parse_day_between("2023-01-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-04", 1_672_790_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_959_test() {
  assert result.map(temporal.parse_day_between("2023-01-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-05", 1_672_876_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_960_test() {
  assert result.map(temporal.parse_day_between("2023-01-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-06", 1_672_963_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_961_test() {
  assert result.map(temporal.parse_day_between("2023-01-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-07", 1_673_049_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_962_test() {
  assert result.map(temporal.parse_day_between("2023-01-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-08", 1_673_136_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_963_test() {
  assert result.map(temporal.parse_day_between("2023-01-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-09", 1_673_222_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_964_test() {
  assert result.map(temporal.parse_day_between("2023-01-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-10", 1_673_308_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_965_test() {
  assert result.map(temporal.parse_day_between("2023-01-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-11", 1_673_395_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_966_test() {
  assert result.map(temporal.parse_day_between("2023-01-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-12", 1_673_481_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_967_test() {
  assert result.map(temporal.parse_day_between("2023-01-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-13", 1_673_568_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_968_test() {
  assert result.map(temporal.parse_day_between("2023-01-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-14", 1_673_654_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_969_test() {
  assert result.map(temporal.parse_day_between("2023-01-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-15", 1_673_740_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_970_test() {
  assert result.map(temporal.parse_day_between("2023-01-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-16", 1_673_827_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_971_test() {
  assert result.map(temporal.parse_day_between("2023-01-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-17", 1_673_913_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_972_test() {
  assert result.map(temporal.parse_day_between("2023-01-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-18", 1_674_000_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_973_test() {
  assert result.map(temporal.parse_day_between("2023-01-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-19", 1_674_086_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_974_test() {
  assert result.map(temporal.parse_day_between("2023-01-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-20", 1_674_172_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_975_test() {
  assert result.map(temporal.parse_day_between("2023-01-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-21", 1_674_259_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_976_test() {
  assert result.map(temporal.parse_day_between("2023-01-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-22", 1_674_345_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_977_test() {
  assert result.map(temporal.parse_day_between("2023-01-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-23", 1_674_432_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_978_test() {
  assert result.map(temporal.parse_day_between("2023-01-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-24", 1_674_518_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_979_test() {
  assert result.map(temporal.parse_day_between("2023-01-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-25", 1_674_604_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_980_test() {
  assert result.map(temporal.parse_day_between("2023-01-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-26", 1_674_691_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_981_test() {
  assert result.map(temporal.parse_day_between("2023-01-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-27", 1_674_777_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_982_test() {
  assert result.map(temporal.parse_day_between("2023-01-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-28", 1_674_864_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_983_test() {
  assert result.map(temporal.parse_day_between("2023-01-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-29", 1_674_950_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_984_test() {
  assert result.map(temporal.parse_day_between("2023-01-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-30", 1_675_036_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_985_test() {
  assert result.map(temporal.parse_day_between("2023-01-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-01-31", 1_675_123_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_986_test() {
  assert result.map(temporal.parse_day_between("2023-02-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_987_test() {
  assert result.map(temporal.parse_day_between("2023-02-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-01", 1_675_209_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_988_test() {
  assert result.map(temporal.parse_day_between("2023-02-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-02", 1_675_296_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_989_test() {
  assert result.map(temporal.parse_day_between("2023-02-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-03", 1_675_382_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_990_test() {
  assert result.map(temporal.parse_day_between("2023-02-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-04", 1_675_468_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_991_test() {
  assert result.map(temporal.parse_day_between("2023-02-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-05", 1_675_555_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_992_test() {
  assert result.map(temporal.parse_day_between("2023-02-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-06", 1_675_641_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_993_test() {
  assert result.map(temporal.parse_day_between("2023-02-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-07", 1_675_728_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_994_test() {
  assert result.map(temporal.parse_day_between("2023-02-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-08", 1_675_814_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_995_test() {
  assert result.map(temporal.parse_day_between("2023-02-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-09", 1_675_900_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_996_test() {
  assert result.map(temporal.parse_day_between("2023-02-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-10", 1_675_987_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_997_test() {
  assert result.map(temporal.parse_day_between("2023-02-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-11", 1_676_073_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_998_test() {
  assert result.map(temporal.parse_day_between("2023-02-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-12", 1_676_160_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_999_test() {
  assert result.map(temporal.parse_day_between("2023-02-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-13", 1_676_246_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1000_test() {
  assert result.map(temporal.parse_day_between("2023-02-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-14", 1_676_332_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1001_test() {
  assert result.map(temporal.parse_day_between("2023-02-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-15", 1_676_419_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1002_test() {
  assert result.map(temporal.parse_day_between("2023-02-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-16", 1_676_505_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1003_test() {
  assert result.map(temporal.parse_day_between("2023-02-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-17", 1_676_592_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1004_test() {
  assert result.map(temporal.parse_day_between("2023-02-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-18", 1_676_678_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1005_test() {
  assert result.map(temporal.parse_day_between("2023-02-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-19", 1_676_764_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1006_test() {
  assert result.map(temporal.parse_day_between("2023-02-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-20", 1_676_851_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1007_test() {
  assert result.map(temporal.parse_day_between("2023-02-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-21", 1_676_937_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1008_test() {
  assert result.map(temporal.parse_day_between("2023-02-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-22", 1_677_024_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1009_test() {
  assert result.map(temporal.parse_day_between("2023-02-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-23", 1_677_110_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1010_test() {
  assert result.map(temporal.parse_day_between("2023-02-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-24", 1_677_196_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1011_test() {
  assert result.map(temporal.parse_day_between("2023-02-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-25", 1_677_283_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1012_test() {
  assert result.map(temporal.parse_day_between("2023-02-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-26", 1_677_369_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1013_test() {
  assert result.map(temporal.parse_day_between("2023-02-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-27", 1_677_456_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1014_test() {
  assert result.map(temporal.parse_day_between("2023-02-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-02-28", 1_677_542_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1015_test() {
  assert result.map(temporal.parse_day_between("2023-02-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1016_test() {
  assert result.map(temporal.parse_day_between("2023-02-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1017_test() {
  assert result.map(temporal.parse_day_between("2023-02-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1018_test() {
  assert result.map(temporal.parse_day_between("2023-02-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1019_test() {
  assert result.map(temporal.parse_day_between("2023-03-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1020_test() {
  assert result.map(temporal.parse_day_between("2023-03-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-01", 1_677_628_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1021_test() {
  assert result.map(temporal.parse_day_between("2023-03-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-02", 1_677_715_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1022_test() {
  assert result.map(temporal.parse_day_between("2023-03-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-03", 1_677_801_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1023_test() {
  assert result.map(temporal.parse_day_between("2023-03-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-04", 1_677_888_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1024_test() {
  assert result.map(temporal.parse_day_between("2023-03-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-05", 1_677_974_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1025_test() {
  assert result.map(temporal.parse_day_between("2023-03-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-06", 1_678_060_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1026_test() {
  assert result.map(temporal.parse_day_between("2023-03-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-07", 1_678_147_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1027_test() {
  assert result.map(temporal.parse_day_between("2023-03-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-08", 1_678_233_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1028_test() {
  assert result.map(temporal.parse_day_between("2023-03-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-09", 1_678_320_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1029_test() {
  assert result.map(temporal.parse_day_between("2023-03-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-10", 1_678_406_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1030_test() {
  assert result.map(temporal.parse_day_between("2023-03-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-11", 1_678_492_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1031_test() {
  assert result.map(temporal.parse_day_between("2023-03-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-12", 1_678_579_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1032_test() {
  assert result.map(temporal.parse_day_between("2023-03-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-13", 1_678_665_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1033_test() {
  assert result.map(temporal.parse_day_between("2023-03-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-14", 1_678_752_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1034_test() {
  assert result.map(temporal.parse_day_between("2023-03-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-15", 1_678_838_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1035_test() {
  assert result.map(temporal.parse_day_between("2023-03-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-16", 1_678_924_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1036_test() {
  assert result.map(temporal.parse_day_between("2023-03-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-17", 1_679_011_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1037_test() {
  assert result.map(temporal.parse_day_between("2023-03-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-18", 1_679_097_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1038_test() {
  assert result.map(temporal.parse_day_between("2023-03-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-19", 1_679_184_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1039_test() {
  assert result.map(temporal.parse_day_between("2023-03-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-20", 1_679_270_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1040_test() {
  assert result.map(temporal.parse_day_between("2023-03-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-21", 1_679_356_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1041_test() {
  assert result.map(temporal.parse_day_between("2023-03-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-22", 1_679_443_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1042_test() {
  assert result.map(temporal.parse_day_between("2023-03-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-23", 1_679_529_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1043_test() {
  assert result.map(temporal.parse_day_between("2023-03-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-24", 1_679_616_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1044_test() {
  assert result.map(temporal.parse_day_between("2023-03-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-25", 1_679_702_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1045_test() {
  assert result.map(temporal.parse_day_between("2023-03-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-26", 1_679_788_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1046_test() {
  assert result.map(temporal.parse_day_between("2023-03-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-27", 1_679_875_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1047_test() {
  assert result.map(temporal.parse_day_between("2023-03-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-28", 1_679_961_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1048_test() {
  assert result.map(temporal.parse_day_between("2023-03-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-29", 1_680_048_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1049_test() {
  assert result.map(temporal.parse_day_between("2023-03-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-30", 1_680_134_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1050_test() {
  assert result.map(temporal.parse_day_between("2023-03-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-03-31", 1_680_220_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1051_test() {
  assert result.map(temporal.parse_day_between("2023-03-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1052_test() {
  assert result.map(temporal.parse_day_between("2023-04-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1053_test() {
  assert result.map(temporal.parse_day_between("2023-04-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-01", 1_680_307_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1054_test() {
  assert result.map(temporal.parse_day_between("2023-04-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-02", 1_680_393_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1055_test() {
  assert result.map(temporal.parse_day_between("2023-04-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-03", 1_680_480_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1056_test() {
  assert result.map(temporal.parse_day_between("2023-04-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-04", 1_680_566_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1057_test() {
  assert result.map(temporal.parse_day_between("2023-04-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-05", 1_680_652_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1058_test() {
  assert result.map(temporal.parse_day_between("2023-04-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-06", 1_680_739_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1059_test() {
  assert result.map(temporal.parse_day_between("2023-04-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-07", 1_680_825_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1060_test() {
  assert result.map(temporal.parse_day_between("2023-04-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-08", 1_680_912_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1061_test() {
  assert result.map(temporal.parse_day_between("2023-04-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-09", 1_680_998_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1062_test() {
  assert result.map(temporal.parse_day_between("2023-04-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-10", 1_681_084_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1063_test() {
  assert result.map(temporal.parse_day_between("2023-04-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-11", 1_681_171_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1064_test() {
  assert result.map(temporal.parse_day_between("2023-04-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-12", 1_681_257_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1065_test() {
  assert result.map(temporal.parse_day_between("2023-04-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-13", 1_681_344_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1066_test() {
  assert result.map(temporal.parse_day_between("2023-04-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-14", 1_681_430_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1067_test() {
  assert result.map(temporal.parse_day_between("2023-04-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-15", 1_681_516_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1068_test() {
  assert result.map(temporal.parse_day_between("2023-04-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-16", 1_681_603_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1069_test() {
  assert result.map(temporal.parse_day_between("2023-04-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-17", 1_681_689_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1070_test() {
  assert result.map(temporal.parse_day_between("2023-04-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-18", 1_681_776_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1071_test() {
  assert result.map(temporal.parse_day_between("2023-04-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-19", 1_681_862_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1072_test() {
  assert result.map(temporal.parse_day_between("2023-04-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-20", 1_681_948_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1073_test() {
  assert result.map(temporal.parse_day_between("2023-04-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-21", 1_682_035_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1074_test() {
  assert result.map(temporal.parse_day_between("2023-04-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-22", 1_682_121_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1075_test() {
  assert result.map(temporal.parse_day_between("2023-04-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-23", 1_682_208_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1076_test() {
  assert result.map(temporal.parse_day_between("2023-04-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-24", 1_682_294_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1077_test() {
  assert result.map(temporal.parse_day_between("2023-04-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-25", 1_682_380_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1078_test() {
  assert result.map(temporal.parse_day_between("2023-04-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-26", 1_682_467_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1079_test() {
  assert result.map(temporal.parse_day_between("2023-04-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-27", 1_682_553_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1080_test() {
  assert result.map(temporal.parse_day_between("2023-04-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-28", 1_682_640_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1081_test() {
  assert result.map(temporal.parse_day_between("2023-04-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-04-29", 1_682_726_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1082_test() {
  assert result.map(temporal.parse_day_between("2023-04-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1083_test() {
  assert result.map(temporal.parse_day_between("2023-04-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1084_test() {
  assert result.map(temporal.parse_day_between("2023-05-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1085_test() {
  assert result.map(temporal.parse_day_between("2023-05-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-01", 1_682_899_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1086_test() {
  assert result.map(temporal.parse_day_between("2023-05-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-02", 1_682_985_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1087_test() {
  assert result.map(temporal.parse_day_between("2023-05-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-03", 1_683_072_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1088_test() {
  assert result.map(temporal.parse_day_between("2023-05-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-04", 1_683_158_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1089_test() {
  assert result.map(temporal.parse_day_between("2023-05-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-05", 1_683_244_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1090_test() {
  assert result.map(temporal.parse_day_between("2023-05-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-06", 1_683_331_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1091_test() {
  assert result.map(temporal.parse_day_between("2023-05-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-07", 1_683_417_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1092_test() {
  assert result.map(temporal.parse_day_between("2023-05-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-08", 1_683_504_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1093_test() {
  assert result.map(temporal.parse_day_between("2023-05-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-09", 1_683_590_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1094_test() {
  assert result.map(temporal.parse_day_between("2023-05-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-10", 1_683_676_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1095_test() {
  assert result.map(temporal.parse_day_between("2023-05-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-11", 1_683_763_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1096_test() {
  assert result.map(temporal.parse_day_between("2023-05-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-12", 1_683_849_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1097_test() {
  assert result.map(temporal.parse_day_between("2023-05-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-13", 1_683_936_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1098_test() {
  assert result.map(temporal.parse_day_between("2023-05-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-14", 1_684_022_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1099_test() {
  assert result.map(temporal.parse_day_between("2023-05-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-15", 1_684_108_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1100_test() {
  assert result.map(temporal.parse_day_between("2023-05-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-16", 1_684_195_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1101_test() {
  assert result.map(temporal.parse_day_between("2023-05-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-17", 1_684_281_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1102_test() {
  assert result.map(temporal.parse_day_between("2023-05-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-18", 1_684_368_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1103_test() {
  assert result.map(temporal.parse_day_between("2023-05-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-19", 1_684_454_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1104_test() {
  assert result.map(temporal.parse_day_between("2023-05-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-20", 1_684_540_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1105_test() {
  assert result.map(temporal.parse_day_between("2023-05-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-21", 1_684_627_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1106_test() {
  assert result.map(temporal.parse_day_between("2023-05-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-22", 1_684_713_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1107_test() {
  assert result.map(temporal.parse_day_between("2023-05-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-23", 1_684_800_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1108_test() {
  assert result.map(temporal.parse_day_between("2023-05-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-24", 1_684_886_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1109_test() {
  assert result.map(temporal.parse_day_between("2023-05-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-25", 1_684_972_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1110_test() {
  assert result.map(temporal.parse_day_between("2023-05-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-26", 1_685_059_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1111_test() {
  assert result.map(temporal.parse_day_between("2023-05-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-27", 1_685_145_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1112_test() {
  assert result.map(temporal.parse_day_between("2023-05-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-28", 1_685_232_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1113_test() {
  assert result.map(temporal.parse_day_between("2023-05-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-29", 1_685_318_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1114_test() {
  assert result.map(temporal.parse_day_between("2023-05-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-30", 1_685_404_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1115_test() {
  assert result.map(temporal.parse_day_between("2023-05-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-05-31", 1_685_491_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1116_test() {
  assert result.map(temporal.parse_day_between("2023-05-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1117_test() {
  assert result.map(temporal.parse_day_between("2023-06-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1118_test() {
  assert result.map(temporal.parse_day_between("2023-06-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-01", 1_685_577_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1119_test() {
  assert result.map(temporal.parse_day_between("2023-06-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-02", 1_685_664_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1120_test() {
  assert result.map(temporal.parse_day_between("2023-06-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-03", 1_685_750_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1121_test() {
  assert result.map(temporal.parse_day_between("2023-06-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-04", 1_685_836_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1122_test() {
  assert result.map(temporal.parse_day_between("2023-06-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-05", 1_685_923_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1123_test() {
  assert result.map(temporal.parse_day_between("2023-06-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-06", 1_686_009_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1124_test() {
  assert result.map(temporal.parse_day_between("2023-06-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-07", 1_686_096_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1125_test() {
  assert result.map(temporal.parse_day_between("2023-06-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-08", 1_686_182_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1126_test() {
  assert result.map(temporal.parse_day_between("2023-06-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-09", 1_686_268_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1127_test() {
  assert result.map(temporal.parse_day_between("2023-06-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-10", 1_686_355_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1128_test() {
  assert result.map(temporal.parse_day_between("2023-06-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-11", 1_686_441_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1129_test() {
  assert result.map(temporal.parse_day_between("2023-06-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-12", 1_686_528_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1130_test() {
  assert result.map(temporal.parse_day_between("2023-06-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-13", 1_686_614_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1131_test() {
  assert result.map(temporal.parse_day_between("2023-06-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-14", 1_686_700_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1132_test() {
  assert result.map(temporal.parse_day_between("2023-06-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-15", 1_686_787_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1133_test() {
  assert result.map(temporal.parse_day_between("2023-06-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-16", 1_686_873_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1134_test() {
  assert result.map(temporal.parse_day_between("2023-06-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-17", 1_686_960_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1135_test() {
  assert result.map(temporal.parse_day_between("2023-06-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-18", 1_687_046_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1136_test() {
  assert result.map(temporal.parse_day_between("2023-06-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-19", 1_687_132_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1137_test() {
  assert result.map(temporal.parse_day_between("2023-06-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-20", 1_687_219_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1138_test() {
  assert result.map(temporal.parse_day_between("2023-06-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-21", 1_687_305_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1139_test() {
  assert result.map(temporal.parse_day_between("2023-06-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-22", 1_687_392_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1140_test() {
  assert result.map(temporal.parse_day_between("2023-06-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-23", 1_687_478_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1141_test() {
  assert result.map(temporal.parse_day_between("2023-06-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-24", 1_687_564_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1142_test() {
  assert result.map(temporal.parse_day_between("2023-06-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-25", 1_687_651_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1143_test() {
  assert result.map(temporal.parse_day_between("2023-06-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-26", 1_687_737_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1144_test() {
  assert result.map(temporal.parse_day_between("2023-06-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-27", 1_687_824_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1145_test() {
  assert result.map(temporal.parse_day_between("2023-06-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-28", 1_687_910_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1146_test() {
  assert result.map(temporal.parse_day_between("2023-06-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-29", 1_687_996_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1147_test() {
  assert result.map(temporal.parse_day_between("2023-06-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-06-30", 1_688_083_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1148_test() {
  assert result.map(temporal.parse_day_between("2023-06-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1149_test() {
  assert result.map(temporal.parse_day_between("2023-06-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1150_test() {
  assert result.map(temporal.parse_day_between("2023-07-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1151_test() {
  assert result.map(temporal.parse_day_between("2023-07-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-01", 1_688_169_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1152_test() {
  assert result.map(temporal.parse_day_between("2023-07-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-02", 1_688_256_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1153_test() {
  assert result.map(temporal.parse_day_between("2023-07-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-03", 1_688_342_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1154_test() {
  assert result.map(temporal.parse_day_between("2023-07-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-04", 1_688_428_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1155_test() {
  assert result.map(temporal.parse_day_between("2023-07-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-05", 1_688_515_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1156_test() {
  assert result.map(temporal.parse_day_between("2023-07-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-06", 1_688_601_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1157_test() {
  assert result.map(temporal.parse_day_between("2023-07-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-07", 1_688_688_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1158_test() {
  assert result.map(temporal.parse_day_between("2023-07-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-08", 1_688_774_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1159_test() {
  assert result.map(temporal.parse_day_between("2023-07-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-09", 1_688_860_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1160_test() {
  assert result.map(temporal.parse_day_between("2023-07-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-10", 1_688_947_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1161_test() {
  assert result.map(temporal.parse_day_between("2023-07-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-11", 1_689_033_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1162_test() {
  assert result.map(temporal.parse_day_between("2023-07-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-12", 1_689_120_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1163_test() {
  assert result.map(temporal.parse_day_between("2023-07-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-13", 1_689_206_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1164_test() {
  assert result.map(temporal.parse_day_between("2023-07-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-14", 1_689_292_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1165_test() {
  assert result.map(temporal.parse_day_between("2023-07-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-15", 1_689_379_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1166_test() {
  assert result.map(temporal.parse_day_between("2023-07-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-16", 1_689_465_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1167_test() {
  assert result.map(temporal.parse_day_between("2023-07-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-17", 1_689_552_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1168_test() {
  assert result.map(temporal.parse_day_between("2023-07-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-18", 1_689_638_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1169_test() {
  assert result.map(temporal.parse_day_between("2023-07-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-19", 1_689_724_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1170_test() {
  assert result.map(temporal.parse_day_between("2023-07-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-20", 1_689_811_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1171_test() {
  assert result.map(temporal.parse_day_between("2023-07-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-21", 1_689_897_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1172_test() {
  assert result.map(temporal.parse_day_between("2023-07-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-22", 1_689_984_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1173_test() {
  assert result.map(temporal.parse_day_between("2023-07-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-23", 1_690_070_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1174_test() {
  assert result.map(temporal.parse_day_between("2023-07-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-24", 1_690_156_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1175_test() {
  assert result.map(temporal.parse_day_between("2023-07-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-25", 1_690_243_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1176_test() {
  assert result.map(temporal.parse_day_between("2023-07-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-26", 1_690_329_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1177_test() {
  assert result.map(temporal.parse_day_between("2023-07-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-27", 1_690_416_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1178_test() {
  assert result.map(temporal.parse_day_between("2023-07-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-28", 1_690_502_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1179_test() {
  assert result.map(temporal.parse_day_between("2023-07-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-29", 1_690_588_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1180_test() {
  assert result.map(temporal.parse_day_between("2023-07-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-30", 1_690_675_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1181_test() {
  assert result.map(temporal.parse_day_between("2023-07-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-07-31", 1_690_761_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1182_test() {
  assert result.map(temporal.parse_day_between("2023-07-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1183_test() {
  assert result.map(temporal.parse_day_between("2023-08-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1184_test() {
  assert result.map(temporal.parse_day_between("2023-08-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-01", 1_690_848_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1185_test() {
  assert result.map(temporal.parse_day_between("2023-08-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-02", 1_690_934_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1186_test() {
  assert result.map(temporal.parse_day_between("2023-08-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-03", 1_691_020_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1187_test() {
  assert result.map(temporal.parse_day_between("2023-08-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-04", 1_691_107_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1188_test() {
  assert result.map(temporal.parse_day_between("2023-08-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-05", 1_691_193_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1189_test() {
  assert result.map(temporal.parse_day_between("2023-08-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-06", 1_691_280_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1190_test() {
  assert result.map(temporal.parse_day_between("2023-08-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-07", 1_691_366_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1191_test() {
  assert result.map(temporal.parse_day_between("2023-08-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-08", 1_691_452_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1192_test() {
  assert result.map(temporal.parse_day_between("2023-08-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-09", 1_691_539_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1193_test() {
  assert result.map(temporal.parse_day_between("2023-08-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-10", 1_691_625_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1194_test() {
  assert result.map(temporal.parse_day_between("2023-08-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-11", 1_691_712_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1195_test() {
  assert result.map(temporal.parse_day_between("2023-08-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-12", 1_691_798_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1196_test() {
  assert result.map(temporal.parse_day_between("2023-08-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-13", 1_691_884_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1197_test() {
  assert result.map(temporal.parse_day_between("2023-08-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-14", 1_691_971_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1198_test() {
  assert result.map(temporal.parse_day_between("2023-08-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-15", 1_692_057_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1199_test() {
  assert result.map(temporal.parse_day_between("2023-08-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-16", 1_692_144_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1200_test() {
  assert result.map(temporal.parse_day_between("2023-08-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-17", 1_692_230_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1201_test() {
  assert result.map(temporal.parse_day_between("2023-08-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-18", 1_692_316_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1202_test() {
  assert result.map(temporal.parse_day_between("2023-08-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-19", 1_692_403_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1203_test() {
  assert result.map(temporal.parse_day_between("2023-08-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-20", 1_692_489_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1204_test() {
  assert result.map(temporal.parse_day_between("2023-08-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-21", 1_692_576_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1205_test() {
  assert result.map(temporal.parse_day_between("2023-08-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-22", 1_692_662_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1206_test() {
  assert result.map(temporal.parse_day_between("2023-08-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-23", 1_692_748_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1207_test() {
  assert result.map(temporal.parse_day_between("2023-08-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-24", 1_692_835_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1208_test() {
  assert result.map(temporal.parse_day_between("2023-08-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-25", 1_692_921_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1209_test() {
  assert result.map(temporal.parse_day_between("2023-08-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-26", 1_693_008_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1210_test() {
  assert result.map(temporal.parse_day_between("2023-08-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-27", 1_693_094_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1211_test() {
  assert result.map(temporal.parse_day_between("2023-08-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-28", 1_693_180_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1212_test() {
  assert result.map(temporal.parse_day_between("2023-08-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-29", 1_693_267_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1213_test() {
  assert result.map(temporal.parse_day_between("2023-08-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-30", 1_693_353_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1214_test() {
  assert result.map(temporal.parse_day_between("2023-08-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-08-31", 1_693_440_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1215_test() {
  assert result.map(temporal.parse_day_between("2023-08-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1216_test() {
  assert result.map(temporal.parse_day_between("2023-09-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1217_test() {
  assert result.map(temporal.parse_day_between("2023-09-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-01", 1_693_526_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1218_test() {
  assert result.map(temporal.parse_day_between("2023-09-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-02", 1_693_612_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1219_test() {
  assert result.map(temporal.parse_day_between("2023-09-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-03", 1_693_699_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1220_test() {
  assert result.map(temporal.parse_day_between("2023-09-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-04", 1_693_785_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1221_test() {
  assert result.map(temporal.parse_day_between("2023-09-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-05", 1_693_872_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1222_test() {
  assert result.map(temporal.parse_day_between("2023-09-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-06", 1_693_958_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1223_test() {
  assert result.map(temporal.parse_day_between("2023-09-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-07", 1_694_044_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1224_test() {
  assert result.map(temporal.parse_day_between("2023-09-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-08", 1_694_131_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1225_test() {
  assert result.map(temporal.parse_day_between("2023-09-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-09", 1_694_217_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1226_test() {
  assert result.map(temporal.parse_day_between("2023-09-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-10", 1_694_304_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1227_test() {
  assert result.map(temporal.parse_day_between("2023-09-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-11", 1_694_390_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1228_test() {
  assert result.map(temporal.parse_day_between("2023-09-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-12", 1_694_476_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1229_test() {
  assert result.map(temporal.parse_day_between("2023-09-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-13", 1_694_563_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1230_test() {
  assert result.map(temporal.parse_day_between("2023-09-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-14", 1_694_649_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1231_test() {
  assert result.map(temporal.parse_day_between("2023-09-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-15", 1_694_736_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1232_test() {
  assert result.map(temporal.parse_day_between("2023-09-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-16", 1_694_822_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1233_test() {
  assert result.map(temporal.parse_day_between("2023-09-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-17", 1_694_908_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1234_test() {
  assert result.map(temporal.parse_day_between("2023-09-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-18", 1_694_995_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1235_test() {
  assert result.map(temporal.parse_day_between("2023-09-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-19", 1_695_081_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1236_test() {
  assert result.map(temporal.parse_day_between("2023-09-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-20", 1_695_168_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1237_test() {
  assert result.map(temporal.parse_day_between("2023-09-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-21", 1_695_254_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1238_test() {
  assert result.map(temporal.parse_day_between("2023-09-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-22", 1_695_340_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1239_test() {
  assert result.map(temporal.parse_day_between("2023-09-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-23", 1_695_427_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1240_test() {
  assert result.map(temporal.parse_day_between("2023-09-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-24", 1_695_513_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1241_test() {
  assert result.map(temporal.parse_day_between("2023-09-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-25", 1_695_600_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1242_test() {
  assert result.map(temporal.parse_day_between("2023-09-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-26", 1_695_686_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1243_test() {
  assert result.map(temporal.parse_day_between("2023-09-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-27", 1_695_772_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1244_test() {
  assert result.map(temporal.parse_day_between("2023-09-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-28", 1_695_859_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1245_test() {
  assert result.map(temporal.parse_day_between("2023-09-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-29", 1_695_945_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1246_test() {
  assert result.map(temporal.parse_day_between("2023-09-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-09-30", 1_696_032_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1247_test() {
  assert result.map(temporal.parse_day_between("2023-09-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1248_test() {
  assert result.map(temporal.parse_day_between("2023-09-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1249_test() {
  assert result.map(temporal.parse_day_between("2023-10-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1250_test() {
  assert result.map(temporal.parse_day_between("2023-10-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-01", 1_696_118_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1251_test() {
  assert result.map(temporal.parse_day_between("2023-10-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-02", 1_696_204_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1252_test() {
  assert result.map(temporal.parse_day_between("2023-10-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-03", 1_696_291_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1253_test() {
  assert result.map(temporal.parse_day_between("2023-10-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-04", 1_696_377_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1254_test() {
  assert result.map(temporal.parse_day_between("2023-10-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-05", 1_696_464_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1255_test() {
  assert result.map(temporal.parse_day_between("2023-10-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-06", 1_696_550_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1256_test() {
  assert result.map(temporal.parse_day_between("2023-10-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-07", 1_696_636_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1257_test() {
  assert result.map(temporal.parse_day_between("2023-10-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-08", 1_696_723_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1258_test() {
  assert result.map(temporal.parse_day_between("2023-10-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-09", 1_696_809_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1259_test() {
  assert result.map(temporal.parse_day_between("2023-10-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-10", 1_696_896_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1260_test() {
  assert result.map(temporal.parse_day_between("2023-10-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-11", 1_696_982_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1261_test() {
  assert result.map(temporal.parse_day_between("2023-10-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-12", 1_697_068_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1262_test() {
  assert result.map(temporal.parse_day_between("2023-10-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-13", 1_697_155_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1263_test() {
  assert result.map(temporal.parse_day_between("2023-10-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-14", 1_697_241_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1264_test() {
  assert result.map(temporal.parse_day_between("2023-10-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-15", 1_697_328_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1265_test() {
  assert result.map(temporal.parse_day_between("2023-10-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-16", 1_697_414_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1266_test() {
  assert result.map(temporal.parse_day_between("2023-10-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-17", 1_697_500_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1267_test() {
  assert result.map(temporal.parse_day_between("2023-10-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-18", 1_697_587_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1268_test() {
  assert result.map(temporal.parse_day_between("2023-10-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-19", 1_697_673_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1269_test() {
  assert result.map(temporal.parse_day_between("2023-10-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-20", 1_697_760_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1270_test() {
  assert result.map(temporal.parse_day_between("2023-10-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-21", 1_697_846_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1271_test() {
  assert result.map(temporal.parse_day_between("2023-10-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-22", 1_697_932_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1272_test() {
  assert result.map(temporal.parse_day_between("2023-10-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-23", 1_698_019_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1273_test() {
  assert result.map(temporal.parse_day_between("2023-10-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-24", 1_698_105_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1274_test() {
  assert result.map(temporal.parse_day_between("2023-10-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-25", 1_698_192_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1275_test() {
  assert result.map(temporal.parse_day_between("2023-10-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-26", 1_698_278_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1276_test() {
  assert result.map(temporal.parse_day_between("2023-10-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-27", 1_698_364_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1277_test() {
  assert result.map(temporal.parse_day_between("2023-10-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-28", 1_698_451_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1278_test() {
  assert result.map(temporal.parse_day_between("2023-10-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-29", 1_698_537_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1279_test() {
  assert result.map(temporal.parse_day_between("2023-10-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-30", 1_698_624_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1280_test() {
  assert result.map(temporal.parse_day_between("2023-10-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-10-31", 1_698_710_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1281_test() {
  assert result.map(temporal.parse_day_between("2023-10-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1282_test() {
  assert result.map(temporal.parse_day_between("2023-11-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1283_test() {
  assert result.map(temporal.parse_day_between("2023-11-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-01", 1_698_796_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1284_test() {
  assert result.map(temporal.parse_day_between("2023-11-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-02", 1_698_883_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1285_test() {
  assert result.map(temporal.parse_day_between("2023-11-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-03", 1_698_969_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1286_test() {
  assert result.map(temporal.parse_day_between("2023-11-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-04", 1_699_056_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1287_test() {
  assert result.map(temporal.parse_day_between("2023-11-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-05", 1_699_142_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1288_test() {
  assert result.map(temporal.parse_day_between("2023-11-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-06", 1_699_228_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1289_test() {
  assert result.map(temporal.parse_day_between("2023-11-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-07", 1_699_315_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1290_test() {
  assert result.map(temporal.parse_day_between("2023-11-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-08", 1_699_401_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1291_test() {
  assert result.map(temporal.parse_day_between("2023-11-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-09", 1_699_488_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1292_test() {
  assert result.map(temporal.parse_day_between("2023-11-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-10", 1_699_574_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1293_test() {
  assert result.map(temporal.parse_day_between("2023-11-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-11", 1_699_660_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1294_test() {
  assert result.map(temporal.parse_day_between("2023-11-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-12", 1_699_747_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1295_test() {
  assert result.map(temporal.parse_day_between("2023-11-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-13", 1_699_833_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1296_test() {
  assert result.map(temporal.parse_day_between("2023-11-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-14", 1_699_920_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1297_test() {
  assert result.map(temporal.parse_day_between("2023-11-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-15", 1_700_006_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1298_test() {
  assert result.map(temporal.parse_day_between("2023-11-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-16", 1_700_092_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1299_test() {
  assert result.map(temporal.parse_day_between("2023-11-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-17", 1_700_179_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1300_test() {
  assert result.map(temporal.parse_day_between("2023-11-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-18", 1_700_265_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1301_test() {
  assert result.map(temporal.parse_day_between("2023-11-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-19", 1_700_352_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1302_test() {
  assert result.map(temporal.parse_day_between("2023-11-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-20", 1_700_438_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1303_test() {
  assert result.map(temporal.parse_day_between("2023-11-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-21", 1_700_524_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1304_test() {
  assert result.map(temporal.parse_day_between("2023-11-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-22", 1_700_611_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1305_test() {
  assert result.map(temporal.parse_day_between("2023-11-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-23", 1_700_697_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1306_test() {
  assert result.map(temporal.parse_day_between("2023-11-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-24", 1_700_784_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1307_test() {
  assert result.map(temporal.parse_day_between("2023-11-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-25", 1_700_870_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1308_test() {
  assert result.map(temporal.parse_day_between("2023-11-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-26", 1_700_956_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1309_test() {
  assert result.map(temporal.parse_day_between("2023-11-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-27", 1_701_043_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1310_test() {
  assert result.map(temporal.parse_day_between("2023-11-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-28", 1_701_129_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1311_test() {
  assert result.map(temporal.parse_day_between("2023-11-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-29", 1_701_216_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1312_test() {
  assert result.map(temporal.parse_day_between("2023-11-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-11-30", 1_701_302_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1313_test() {
  assert result.map(temporal.parse_day_between("2023-11-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1314_test() {
  assert result.map(temporal.parse_day_between("2023-11-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1315_test() {
  assert result.map(temporal.parse_day_between("2023-12-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1316_test() {
  assert result.map(temporal.parse_day_between("2023-12-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-01", 1_701_388_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1317_test() {
  assert result.map(temporal.parse_day_between("2023-12-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-02", 1_701_475_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1318_test() {
  assert result.map(temporal.parse_day_between("2023-12-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-03", 1_701_561_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1319_test() {
  assert result.map(temporal.parse_day_between("2023-12-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-04", 1_701_648_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1320_test() {
  assert result.map(temporal.parse_day_between("2023-12-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-05", 1_701_734_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1321_test() {
  assert result.map(temporal.parse_day_between("2023-12-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-06", 1_701_820_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1322_test() {
  assert result.map(temporal.parse_day_between("2023-12-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-07", 1_701_907_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1323_test() {
  assert result.map(temporal.parse_day_between("2023-12-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-08", 1_701_993_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1324_test() {
  assert result.map(temporal.parse_day_between("2023-12-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-09", 1_702_080_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1325_test() {
  assert result.map(temporal.parse_day_between("2023-12-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-10", 1_702_166_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1326_test() {
  assert result.map(temporal.parse_day_between("2023-12-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-11", 1_702_252_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1327_test() {
  assert result.map(temporal.parse_day_between("2023-12-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-12", 1_702_339_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1328_test() {
  assert result.map(temporal.parse_day_between("2023-12-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-13", 1_702_425_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1329_test() {
  assert result.map(temporal.parse_day_between("2023-12-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-14", 1_702_512_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1330_test() {
  assert result.map(temporal.parse_day_between("2023-12-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-15", 1_702_598_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1331_test() {
  assert result.map(temporal.parse_day_between("2023-12-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-16", 1_702_684_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1332_test() {
  assert result.map(temporal.parse_day_between("2023-12-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-17", 1_702_771_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1333_test() {
  assert result.map(temporal.parse_day_between("2023-12-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-18", 1_702_857_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1334_test() {
  assert result.map(temporal.parse_day_between("2023-12-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-19", 1_702_944_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1335_test() {
  assert result.map(temporal.parse_day_between("2023-12-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-20", 1_703_030_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1336_test() {
  assert result.map(temporal.parse_day_between("2023-12-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-21", 1_703_116_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1337_test() {
  assert result.map(temporal.parse_day_between("2023-12-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-22", 1_703_203_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1338_test() {
  assert result.map(temporal.parse_day_between("2023-12-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-23", 1_703_289_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1339_test() {
  assert result.map(temporal.parse_day_between("2023-12-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-24", 1_703_376_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1340_test() {
  assert result.map(temporal.parse_day_between("2023-12-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-25", 1_703_462_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1341_test() {
  assert result.map(temporal.parse_day_between("2023-12-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-26", 1_703_548_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1342_test() {
  assert result.map(temporal.parse_day_between("2023-12-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-27", 1_703_635_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1343_test() {
  assert result.map(temporal.parse_day_between("2023-12-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-28", 1_703_721_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1344_test() {
  assert result.map(temporal.parse_day_between("2023-12-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-29", 1_703_808_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1345_test() {
  assert result.map(temporal.parse_day_between("2023-12-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2023-12-30", 1_703_894_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1346_test() {
  assert result.map(temporal.parse_day_between("2023-12-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1347_test() {
  assert result.map(temporal.parse_day_between("2023-13-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1348_test() {
  assert result.map(temporal.parse_day_between("2023-13-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1349_test() {
  assert result.map(temporal.parse_day_between("2023-13-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1350_test() {
  assert result.map(temporal.parse_day_between("2023-13-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1351_test() {
  assert result.map(temporal.parse_day_between("2023-13-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1352_test() {
  assert result.map(temporal.parse_day_between("2023-13-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1353_test() {
  assert result.map(temporal.parse_day_between("2023-13-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1354_test() {
  assert result.map(temporal.parse_day_between("2023-13-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1355_test() {
  assert result.map(temporal.parse_day_between("2023-13-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1356_test() {
  assert result.map(temporal.parse_day_between("2023-13-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1357_test() {
  assert result.map(temporal.parse_day_between("2023-13-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1358_test() {
  assert result.map(temporal.parse_day_between("2023-13-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1359_test() {
  assert result.map(temporal.parse_day_between("2023-13-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1360_test() {
  assert result.map(temporal.parse_day_between("2023-13-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1361_test() {
  assert result.map(temporal.parse_day_between("2023-13-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1362_test() {
  assert result.map(temporal.parse_day_between("2023-13-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1363_test() {
  assert result.map(temporal.parse_day_between("2023-13-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1364_test() {
  assert result.map(temporal.parse_day_between("2023-13-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1365_test() {
  assert result.map(temporal.parse_day_between("2023-13-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1366_test() {
  assert result.map(temporal.parse_day_between("2023-13-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1367_test() {
  assert result.map(temporal.parse_day_between("2023-13-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1368_test() {
  assert result.map(temporal.parse_day_between("2023-13-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1369_test() {
  assert result.map(temporal.parse_day_between("2023-13-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1370_test() {
  assert result.map(temporal.parse_day_between("2023-13-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1371_test() {
  assert result.map(temporal.parse_day_between("2023-13-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1372_test() {
  assert result.map(temporal.parse_day_between("2023-13-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1373_test() {
  assert result.map(temporal.parse_day_between("2023-13-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1374_test() {
  assert result.map(temporal.parse_day_between("2023-13-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1375_test() {
  assert result.map(temporal.parse_day_between("2023-13-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1376_test() {
  assert result.map(temporal.parse_day_between("2023-13-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1377_test() {
  assert result.map(temporal.parse_day_between("2023-13-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1378_test() {
  assert result.map(temporal.parse_day_between("2023-13-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1379_test() {
  assert result.map(temporal.parse_day_between("2024-00-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1380_test() {
  assert result.map(temporal.parse_day_between("2024-00-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1381_test() {
  assert result.map(temporal.parse_day_between("2024-00-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1382_test() {
  assert result.map(temporal.parse_day_between("2024-00-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1383_test() {
  assert result.map(temporal.parse_day_between("2024-00-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1384_test() {
  assert result.map(temporal.parse_day_between("2024-00-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1385_test() {
  assert result.map(temporal.parse_day_between("2024-00-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1386_test() {
  assert result.map(temporal.parse_day_between("2024-00-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1387_test() {
  assert result.map(temporal.parse_day_between("2024-00-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1388_test() {
  assert result.map(temporal.parse_day_between("2024-00-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1389_test() {
  assert result.map(temporal.parse_day_between("2024-00-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1390_test() {
  assert result.map(temporal.parse_day_between("2024-00-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1391_test() {
  assert result.map(temporal.parse_day_between("2024-00-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1392_test() {
  assert result.map(temporal.parse_day_between("2024-00-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1393_test() {
  assert result.map(temporal.parse_day_between("2024-00-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1394_test() {
  assert result.map(temporal.parse_day_between("2024-00-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1395_test() {
  assert result.map(temporal.parse_day_between("2024-00-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1396_test() {
  assert result.map(temporal.parse_day_between("2024-00-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1397_test() {
  assert result.map(temporal.parse_day_between("2024-00-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1398_test() {
  assert result.map(temporal.parse_day_between("2024-00-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1399_test() {
  assert result.map(temporal.parse_day_between("2024-00-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1400_test() {
  assert result.map(temporal.parse_day_between("2024-00-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1401_test() {
  assert result.map(temporal.parse_day_between("2024-00-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1402_test() {
  assert result.map(temporal.parse_day_between("2024-00-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1403_test() {
  assert result.map(temporal.parse_day_between("2024-00-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1404_test() {
  assert result.map(temporal.parse_day_between("2024-00-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1405_test() {
  assert result.map(temporal.parse_day_between("2024-00-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1406_test() {
  assert result.map(temporal.parse_day_between("2024-00-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1407_test() {
  assert result.map(temporal.parse_day_between("2024-00-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1408_test() {
  assert result.map(temporal.parse_day_between("2024-00-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1409_test() {
  assert result.map(temporal.parse_day_between("2024-00-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1410_test() {
  assert result.map(temporal.parse_day_between("2024-00-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1411_test() {
  assert result.map(temporal.parse_day_between("2024-00-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1412_test() {
  assert result.map(temporal.parse_day_between("2024-01-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1413_test() {
  assert result.map(temporal.parse_day_between("2024-01-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-01", 1_704_067_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1414_test() {
  assert result.map(temporal.parse_day_between("2024-01-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-02", 1_704_153_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1415_test() {
  assert result.map(temporal.parse_day_between("2024-01-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-03", 1_704_240_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1416_test() {
  assert result.map(temporal.parse_day_between("2024-01-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-04", 1_704_326_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1417_test() {
  assert result.map(temporal.parse_day_between("2024-01-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-05", 1_704_412_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1418_test() {
  assert result.map(temporal.parse_day_between("2024-01-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-06", 1_704_499_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1419_test() {
  assert result.map(temporal.parse_day_between("2024-01-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-07", 1_704_585_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1420_test() {
  assert result.map(temporal.parse_day_between("2024-01-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-08", 1_704_672_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1421_test() {
  assert result.map(temporal.parse_day_between("2024-01-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-09", 1_704_758_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1422_test() {
  assert result.map(temporal.parse_day_between("2024-01-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-10", 1_704_844_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1423_test() {
  assert result.map(temporal.parse_day_between("2024-01-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-11", 1_704_931_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1424_test() {
  assert result.map(temporal.parse_day_between("2024-01-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-12", 1_705_017_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1425_test() {
  assert result.map(temporal.parse_day_between("2024-01-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-13", 1_705_104_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1426_test() {
  assert result.map(temporal.parse_day_between("2024-01-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-14", 1_705_190_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1427_test() {
  assert result.map(temporal.parse_day_between("2024-01-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-15", 1_705_276_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1428_test() {
  assert result.map(temporal.parse_day_between("2024-01-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-16", 1_705_363_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1429_test() {
  assert result.map(temporal.parse_day_between("2024-01-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-17", 1_705_449_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1430_test() {
  assert result.map(temporal.parse_day_between("2024-01-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-18", 1_705_536_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1431_test() {
  assert result.map(temporal.parse_day_between("2024-01-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-19", 1_705_622_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1432_test() {
  assert result.map(temporal.parse_day_between("2024-01-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-20", 1_705_708_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1433_test() {
  assert result.map(temporal.parse_day_between("2024-01-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-21", 1_705_795_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1434_test() {
  assert result.map(temporal.parse_day_between("2024-01-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-22", 1_705_881_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1435_test() {
  assert result.map(temporal.parse_day_between("2024-01-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-23", 1_705_968_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1436_test() {
  assert result.map(temporal.parse_day_between("2024-01-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-24", 1_706_054_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1437_test() {
  assert result.map(temporal.parse_day_between("2024-01-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-25", 1_706_140_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1438_test() {
  assert result.map(temporal.parse_day_between("2024-01-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-26", 1_706_227_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1439_test() {
  assert result.map(temporal.parse_day_between("2024-01-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-27", 1_706_313_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1440_test() {
  assert result.map(temporal.parse_day_between("2024-01-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-28", 1_706_400_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1441_test() {
  assert result.map(temporal.parse_day_between("2024-01-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-29", 1_706_486_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1442_test() {
  assert result.map(temporal.parse_day_between("2024-01-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-30", 1_706_572_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1443_test() {
  assert result.map(temporal.parse_day_between("2024-01-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-01-31", 1_706_659_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1444_test() {
  assert result.map(temporal.parse_day_between("2024-01-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1445_test() {
  assert result.map(temporal.parse_day_between("2024-02-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1446_test() {
  assert result.map(temporal.parse_day_between("2024-02-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-01", 1_706_745_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1447_test() {
  assert result.map(temporal.parse_day_between("2024-02-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-02", 1_706_832_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1448_test() {
  assert result.map(temporal.parse_day_between("2024-02-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-03", 1_706_918_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1449_test() {
  assert result.map(temporal.parse_day_between("2024-02-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-04", 1_707_004_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1450_test() {
  assert result.map(temporal.parse_day_between("2024-02-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-05", 1_707_091_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1451_test() {
  assert result.map(temporal.parse_day_between("2024-02-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-06", 1_707_177_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1452_test() {
  assert result.map(temporal.parse_day_between("2024-02-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-07", 1_707_264_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1453_test() {
  assert result.map(temporal.parse_day_between("2024-02-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-08", 1_707_350_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1454_test() {
  assert result.map(temporal.parse_day_between("2024-02-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-09", 1_707_436_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1455_test() {
  assert result.map(temporal.parse_day_between("2024-02-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-10", 1_707_523_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1456_test() {
  assert result.map(temporal.parse_day_between("2024-02-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-11", 1_707_609_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1457_test() {
  assert result.map(temporal.parse_day_between("2024-02-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-12", 1_707_696_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1458_test() {
  assert result.map(temporal.parse_day_between("2024-02-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-13", 1_707_782_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1459_test() {
  assert result.map(temporal.parse_day_between("2024-02-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-14", 1_707_868_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1460_test() {
  assert result.map(temporal.parse_day_between("2024-02-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-15", 1_707_955_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1461_test() {
  assert result.map(temporal.parse_day_between("2024-02-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-16", 1_708_041_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1462_test() {
  assert result.map(temporal.parse_day_between("2024-02-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-17", 1_708_128_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1463_test() {
  assert result.map(temporal.parse_day_between("2024-02-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-18", 1_708_214_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1464_test() {
  assert result.map(temporal.parse_day_between("2024-02-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-19", 1_708_300_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1465_test() {
  assert result.map(temporal.parse_day_between("2024-02-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-20", 1_708_387_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1466_test() {
  assert result.map(temporal.parse_day_between("2024-02-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-21", 1_708_473_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1467_test() {
  assert result.map(temporal.parse_day_between("2024-02-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-22", 1_708_560_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1468_test() {
  assert result.map(temporal.parse_day_between("2024-02-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-23", 1_708_646_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1469_test() {
  assert result.map(temporal.parse_day_between("2024-02-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-24", 1_708_732_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1470_test() {
  assert result.map(temporal.parse_day_between("2024-02-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-25", 1_708_819_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1471_test() {
  assert result.map(temporal.parse_day_between("2024-02-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-26", 1_708_905_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1472_test() {
  assert result.map(temporal.parse_day_between("2024-02-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-27", 1_708_992_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1473_test() {
  assert result.map(temporal.parse_day_between("2024-02-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-02-28", 1_709_078_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1474_test() {
  assert result.map(temporal.parse_day_between("2024-02-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1475_test() {
  assert result.map(temporal.parse_day_between("2024-02-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1476_test() {
  assert result.map(temporal.parse_day_between("2024-02-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1477_test() {
  assert result.map(temporal.parse_day_between("2024-03-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1478_test() {
  assert result.map(temporal.parse_day_between("2024-03-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-01", 1_709_251_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1479_test() {
  assert result.map(temporal.parse_day_between("2024-03-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-02", 1_709_337_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1480_test() {
  assert result.map(temporal.parse_day_between("2024-03-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-03", 1_709_424_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1481_test() {
  assert result.map(temporal.parse_day_between("2024-03-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-04", 1_709_510_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1482_test() {
  assert result.map(temporal.parse_day_between("2024-03-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-05", 1_709_596_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1483_test() {
  assert result.map(temporal.parse_day_between("2024-03-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-06", 1_709_683_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1484_test() {
  assert result.map(temporal.parse_day_between("2024-03-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-07", 1_709_769_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1485_test() {
  assert result.map(temporal.parse_day_between("2024-03-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-08", 1_709_856_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1486_test() {
  assert result.map(temporal.parse_day_between("2024-03-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-09", 1_709_942_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1487_test() {
  assert result.map(temporal.parse_day_between("2024-03-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-10", 1_710_028_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1488_test() {
  assert result.map(temporal.parse_day_between("2024-03-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-11", 1_710_115_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1489_test() {
  assert result.map(temporal.parse_day_between("2024-03-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-12", 1_710_201_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1490_test() {
  assert result.map(temporal.parse_day_between("2024-03-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-13", 1_710_288_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1491_test() {
  assert result.map(temporal.parse_day_between("2024-03-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-14", 1_710_374_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1492_test() {
  assert result.map(temporal.parse_day_between("2024-03-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-15", 1_710_460_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1493_test() {
  assert result.map(temporal.parse_day_between("2024-03-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-16", 1_710_547_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1494_test() {
  assert result.map(temporal.parse_day_between("2024-03-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-17", 1_710_633_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1495_test() {
  assert result.map(temporal.parse_day_between("2024-03-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-18", 1_710_720_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1496_test() {
  assert result.map(temporal.parse_day_between("2024-03-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-19", 1_710_806_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1497_test() {
  assert result.map(temporal.parse_day_between("2024-03-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-20", 1_710_892_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1498_test() {
  assert result.map(temporal.parse_day_between("2024-03-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-21", 1_710_979_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1499_test() {
  assert result.map(temporal.parse_day_between("2024-03-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-22", 1_711_065_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1500_test() {
  assert result.map(temporal.parse_day_between("2024-03-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-23", 1_711_152_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1501_test() {
  assert result.map(temporal.parse_day_between("2024-03-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-24", 1_711_238_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1502_test() {
  assert result.map(temporal.parse_day_between("2024-03-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-25", 1_711_324_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1503_test() {
  assert result.map(temporal.parse_day_between("2024-03-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-26", 1_711_411_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1504_test() {
  assert result.map(temporal.parse_day_between("2024-03-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-27", 1_711_497_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1505_test() {
  assert result.map(temporal.parse_day_between("2024-03-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-28", 1_711_584_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1506_test() {
  assert result.map(temporal.parse_day_between("2024-03-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-29", 1_711_670_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1507_test() {
  assert result.map(temporal.parse_day_between("2024-03-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-30", 1_711_756_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1508_test() {
  assert result.map(temporal.parse_day_between("2024-03-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-03-31", 1_711_843_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1509_test() {
  assert result.map(temporal.parse_day_between("2024-03-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1510_test() {
  assert result.map(temporal.parse_day_between("2024-04-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1511_test() {
  assert result.map(temporal.parse_day_between("2024-04-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-01", 1_711_929_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1512_test() {
  assert result.map(temporal.parse_day_between("2024-04-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-02", 1_712_016_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1513_test() {
  assert result.map(temporal.parse_day_between("2024-04-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-03", 1_712_102_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1514_test() {
  assert result.map(temporal.parse_day_between("2024-04-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-04", 1_712_188_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1515_test() {
  assert result.map(temporal.parse_day_between("2024-04-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-05", 1_712_275_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1516_test() {
  assert result.map(temporal.parse_day_between("2024-04-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-06", 1_712_361_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1517_test() {
  assert result.map(temporal.parse_day_between("2024-04-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-07", 1_712_448_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1518_test() {
  assert result.map(temporal.parse_day_between("2024-04-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-08", 1_712_534_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1519_test() {
  assert result.map(temporal.parse_day_between("2024-04-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-09", 1_712_620_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1520_test() {
  assert result.map(temporal.parse_day_between("2024-04-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-10", 1_712_707_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1521_test() {
  assert result.map(temporal.parse_day_between("2024-04-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-11", 1_712_793_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1522_test() {
  assert result.map(temporal.parse_day_between("2024-04-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-12", 1_712_880_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1523_test() {
  assert result.map(temporal.parse_day_between("2024-04-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-13", 1_712_966_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1524_test() {
  assert result.map(temporal.parse_day_between("2024-04-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-14", 1_713_052_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1525_test() {
  assert result.map(temporal.parse_day_between("2024-04-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-15", 1_713_139_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1526_test() {
  assert result.map(temporal.parse_day_between("2024-04-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-16", 1_713_225_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1527_test() {
  assert result.map(temporal.parse_day_between("2024-04-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-17", 1_713_312_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1528_test() {
  assert result.map(temporal.parse_day_between("2024-04-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-18", 1_713_398_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1529_test() {
  assert result.map(temporal.parse_day_between("2024-04-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-19", 1_713_484_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1530_test() {
  assert result.map(temporal.parse_day_between("2024-04-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-20", 1_713_571_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1531_test() {
  assert result.map(temporal.parse_day_between("2024-04-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-21", 1_713_657_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1532_test() {
  assert result.map(temporal.parse_day_between("2024-04-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-22", 1_713_744_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1533_test() {
  assert result.map(temporal.parse_day_between("2024-04-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-23", 1_713_830_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1534_test() {
  assert result.map(temporal.parse_day_between("2024-04-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-24", 1_713_916_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1535_test() {
  assert result.map(temporal.parse_day_between("2024-04-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-25", 1_714_003_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1536_test() {
  assert result.map(temporal.parse_day_between("2024-04-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-26", 1_714_089_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1537_test() {
  assert result.map(temporal.parse_day_between("2024-04-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-27", 1_714_176_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1538_test() {
  assert result.map(temporal.parse_day_between("2024-04-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-28", 1_714_262_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1539_test() {
  assert result.map(temporal.parse_day_between("2024-04-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-29", 1_714_348_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1540_test() {
  assert result.map(temporal.parse_day_between("2024-04-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-04-30", 1_714_435_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1541_test() {
  assert result.map(temporal.parse_day_between("2024-04-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1542_test() {
  assert result.map(temporal.parse_day_between("2024-04-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1543_test() {
  assert result.map(temporal.parse_day_between("2024-05-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1544_test() {
  assert result.map(temporal.parse_day_between("2024-05-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-01", 1_714_521_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1545_test() {
  assert result.map(temporal.parse_day_between("2024-05-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-02", 1_714_608_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1546_test() {
  assert result.map(temporal.parse_day_between("2024-05-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-03", 1_714_694_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1547_test() {
  assert result.map(temporal.parse_day_between("2024-05-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-04", 1_714_780_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1548_test() {
  assert result.map(temporal.parse_day_between("2024-05-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-05", 1_714_867_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1549_test() {
  assert result.map(temporal.parse_day_between("2024-05-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-06", 1_714_953_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1550_test() {
  assert result.map(temporal.parse_day_between("2024-05-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-07", 1_715_040_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1551_test() {
  assert result.map(temporal.parse_day_between("2024-05-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-08", 1_715_126_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1552_test() {
  assert result.map(temporal.parse_day_between("2024-05-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-09", 1_715_212_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1553_test() {
  assert result.map(temporal.parse_day_between("2024-05-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-10", 1_715_299_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1554_test() {
  assert result.map(temporal.parse_day_between("2024-05-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-11", 1_715_385_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1555_test() {
  assert result.map(temporal.parse_day_between("2024-05-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-12", 1_715_472_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1556_test() {
  assert result.map(temporal.parse_day_between("2024-05-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-13", 1_715_558_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1557_test() {
  assert result.map(temporal.parse_day_between("2024-05-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-14", 1_715_644_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1558_test() {
  assert result.map(temporal.parse_day_between("2024-05-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-15", 1_715_731_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1559_test() {
  assert result.map(temporal.parse_day_between("2024-05-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-16", 1_715_817_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1560_test() {
  assert result.map(temporal.parse_day_between("2024-05-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-17", 1_715_904_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1561_test() {
  assert result.map(temporal.parse_day_between("2024-05-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-18", 1_715_990_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1562_test() {
  assert result.map(temporal.parse_day_between("2024-05-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-19", 1_716_076_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1563_test() {
  assert result.map(temporal.parse_day_between("2024-05-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-20", 1_716_163_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1564_test() {
  assert result.map(temporal.parse_day_between("2024-05-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-21", 1_716_249_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1565_test() {
  assert result.map(temporal.parse_day_between("2024-05-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-22", 1_716_336_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1566_test() {
  assert result.map(temporal.parse_day_between("2024-05-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-23", 1_716_422_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1567_test() {
  assert result.map(temporal.parse_day_between("2024-05-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-24", 1_716_508_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1568_test() {
  assert result.map(temporal.parse_day_between("2024-05-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-25", 1_716_595_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1569_test() {
  assert result.map(temporal.parse_day_between("2024-05-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-26", 1_716_681_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1570_test() {
  assert result.map(temporal.parse_day_between("2024-05-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-27", 1_716_768_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1571_test() {
  assert result.map(temporal.parse_day_between("2024-05-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-28", 1_716_854_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1572_test() {
  assert result.map(temporal.parse_day_between("2024-05-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-29", 1_716_940_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1573_test() {
  assert result.map(temporal.parse_day_between("2024-05-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-30", 1_717_027_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1574_test() {
  assert result.map(temporal.parse_day_between("2024-05-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-05-31", 1_717_113_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1575_test() {
  assert result.map(temporal.parse_day_between("2024-05-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1576_test() {
  assert result.map(temporal.parse_day_between("2024-06-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1577_test() {
  assert result.map(temporal.parse_day_between("2024-06-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-01", 1_717_200_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1578_test() {
  assert result.map(temporal.parse_day_between("2024-06-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-02", 1_717_286_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1579_test() {
  assert result.map(temporal.parse_day_between("2024-06-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-03", 1_717_372_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1580_test() {
  assert result.map(temporal.parse_day_between("2024-06-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-04", 1_717_459_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1581_test() {
  assert result.map(temporal.parse_day_between("2024-06-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-05", 1_717_545_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1582_test() {
  assert result.map(temporal.parse_day_between("2024-06-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-06", 1_717_632_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1583_test() {
  assert result.map(temporal.parse_day_between("2024-06-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-07", 1_717_718_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1584_test() {
  assert result.map(temporal.parse_day_between("2024-06-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-08", 1_717_804_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1585_test() {
  assert result.map(temporal.parse_day_between("2024-06-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-09", 1_717_891_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1586_test() {
  assert result.map(temporal.parse_day_between("2024-06-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-10", 1_717_977_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1587_test() {
  assert result.map(temporal.parse_day_between("2024-06-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-11", 1_718_064_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1588_test() {
  assert result.map(temporal.parse_day_between("2024-06-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-12", 1_718_150_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1589_test() {
  assert result.map(temporal.parse_day_between("2024-06-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-13", 1_718_236_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1590_test() {
  assert result.map(temporal.parse_day_between("2024-06-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-14", 1_718_323_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1591_test() {
  assert result.map(temporal.parse_day_between("2024-06-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-15", 1_718_409_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1592_test() {
  assert result.map(temporal.parse_day_between("2024-06-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-16", 1_718_496_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1593_test() {
  assert result.map(temporal.parse_day_between("2024-06-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-17", 1_718_582_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1594_test() {
  assert result.map(temporal.parse_day_between("2024-06-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-18", 1_718_668_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1595_test() {
  assert result.map(temporal.parse_day_between("2024-06-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-19", 1_718_755_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1596_test() {
  assert result.map(temporal.parse_day_between("2024-06-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-20", 1_718_841_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1597_test() {
  assert result.map(temporal.parse_day_between("2024-06-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-21", 1_718_928_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1598_test() {
  assert result.map(temporal.parse_day_between("2024-06-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-22", 1_719_014_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1599_test() {
  assert result.map(temporal.parse_day_between("2024-06-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-23", 1_719_100_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1600_test() {
  assert result.map(temporal.parse_day_between("2024-06-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-24", 1_719_187_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1601_test() {
  assert result.map(temporal.parse_day_between("2024-06-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-25", 1_719_273_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1602_test() {
  assert result.map(temporal.parse_day_between("2024-06-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-26", 1_719_360_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1603_test() {
  assert result.map(temporal.parse_day_between("2024-06-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-27", 1_719_446_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1604_test() {
  assert result.map(temporal.parse_day_between("2024-06-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-28", 1_719_532_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1605_test() {
  assert result.map(temporal.parse_day_between("2024-06-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-29", 1_719_619_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1606_test() {
  assert result.map(temporal.parse_day_between("2024-06-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-06-30", 1_719_705_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1607_test() {
  assert result.map(temporal.parse_day_between("2024-06-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1608_test() {
  assert result.map(temporal.parse_day_between("2024-06-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1609_test() {
  assert result.map(temporal.parse_day_between("2024-07-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1610_test() {
  assert result.map(temporal.parse_day_between("2024-07-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-01", 1_719_792_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1611_test() {
  assert result.map(temporal.parse_day_between("2024-07-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-02", 1_719_878_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1612_test() {
  assert result.map(temporal.parse_day_between("2024-07-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-03", 1_719_964_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1613_test() {
  assert result.map(temporal.parse_day_between("2024-07-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-04", 1_720_051_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1614_test() {
  assert result.map(temporal.parse_day_between("2024-07-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-05", 1_720_137_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1615_test() {
  assert result.map(temporal.parse_day_between("2024-07-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-06", 1_720_224_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1616_test() {
  assert result.map(temporal.parse_day_between("2024-07-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-07", 1_720_310_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1617_test() {
  assert result.map(temporal.parse_day_between("2024-07-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-08", 1_720_396_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1618_test() {
  assert result.map(temporal.parse_day_between("2024-07-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-09", 1_720_483_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1619_test() {
  assert result.map(temporal.parse_day_between("2024-07-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-10", 1_720_569_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1620_test() {
  assert result.map(temporal.parse_day_between("2024-07-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-11", 1_720_656_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1621_test() {
  assert result.map(temporal.parse_day_between("2024-07-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-12", 1_720_742_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1622_test() {
  assert result.map(temporal.parse_day_between("2024-07-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-13", 1_720_828_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1623_test() {
  assert result.map(temporal.parse_day_between("2024-07-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-14", 1_720_915_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1624_test() {
  assert result.map(temporal.parse_day_between("2024-07-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-15", 1_721_001_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1625_test() {
  assert result.map(temporal.parse_day_between("2024-07-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-16", 1_721_088_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1626_test() {
  assert result.map(temporal.parse_day_between("2024-07-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-17", 1_721_174_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1627_test() {
  assert result.map(temporal.parse_day_between("2024-07-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-18", 1_721_260_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1628_test() {
  assert result.map(temporal.parse_day_between("2024-07-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-19", 1_721_347_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1629_test() {
  assert result.map(temporal.parse_day_between("2024-07-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-20", 1_721_433_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1630_test() {
  assert result.map(temporal.parse_day_between("2024-07-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-21", 1_721_520_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1631_test() {
  assert result.map(temporal.parse_day_between("2024-07-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-22", 1_721_606_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1632_test() {
  assert result.map(temporal.parse_day_between("2024-07-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-23", 1_721_692_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1633_test() {
  assert result.map(temporal.parse_day_between("2024-07-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-24", 1_721_779_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1634_test() {
  assert result.map(temporal.parse_day_between("2024-07-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-25", 1_721_865_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1635_test() {
  assert result.map(temporal.parse_day_between("2024-07-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-26", 1_721_952_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1636_test() {
  assert result.map(temporal.parse_day_between("2024-07-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-27", 1_722_038_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1637_test() {
  assert result.map(temporal.parse_day_between("2024-07-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-28", 1_722_124_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1638_test() {
  assert result.map(temporal.parse_day_between("2024-07-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-29", 1_722_211_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1639_test() {
  assert result.map(temporal.parse_day_between("2024-07-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-30", 1_722_297_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1640_test() {
  assert result.map(temporal.parse_day_between("2024-07-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-07-31", 1_722_384_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1641_test() {
  assert result.map(temporal.parse_day_between("2024-07-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1642_test() {
  assert result.map(temporal.parse_day_between("2024-08-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1643_test() {
  assert result.map(temporal.parse_day_between("2024-08-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-01", 1_722_470_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1644_test() {
  assert result.map(temporal.parse_day_between("2024-08-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-02", 1_722_556_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1645_test() {
  assert result.map(temporal.parse_day_between("2024-08-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-03", 1_722_643_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1646_test() {
  assert result.map(temporal.parse_day_between("2024-08-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-04", 1_722_729_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1647_test() {
  assert result.map(temporal.parse_day_between("2024-08-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-05", 1_722_816_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1648_test() {
  assert result.map(temporal.parse_day_between("2024-08-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-06", 1_722_902_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1649_test() {
  assert result.map(temporal.parse_day_between("2024-08-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-07", 1_722_988_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1650_test() {
  assert result.map(temporal.parse_day_between("2024-08-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-08", 1_723_075_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1651_test() {
  assert result.map(temporal.parse_day_between("2024-08-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-09", 1_723_161_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1652_test() {
  assert result.map(temporal.parse_day_between("2024-08-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-10", 1_723_248_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1653_test() {
  assert result.map(temporal.parse_day_between("2024-08-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-11", 1_723_334_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1654_test() {
  assert result.map(temporal.parse_day_between("2024-08-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-12", 1_723_420_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1655_test() {
  assert result.map(temporal.parse_day_between("2024-08-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-13", 1_723_507_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1656_test() {
  assert result.map(temporal.parse_day_between("2024-08-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-14", 1_723_593_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1657_test() {
  assert result.map(temporal.parse_day_between("2024-08-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-15", 1_723_680_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1658_test() {
  assert result.map(temporal.parse_day_between("2024-08-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-16", 1_723_766_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1659_test() {
  assert result.map(temporal.parse_day_between("2024-08-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-17", 1_723_852_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1660_test() {
  assert result.map(temporal.parse_day_between("2024-08-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-18", 1_723_939_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1661_test() {
  assert result.map(temporal.parse_day_between("2024-08-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-19", 1_724_025_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1662_test() {
  assert result.map(temporal.parse_day_between("2024-08-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-20", 1_724_112_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1663_test() {
  assert result.map(temporal.parse_day_between("2024-08-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-21", 1_724_198_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1664_test() {
  assert result.map(temporal.parse_day_between("2024-08-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-22", 1_724_284_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1665_test() {
  assert result.map(temporal.parse_day_between("2024-08-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-23", 1_724_371_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1666_test() {
  assert result.map(temporal.parse_day_between("2024-08-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-24", 1_724_457_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1667_test() {
  assert result.map(temporal.parse_day_between("2024-08-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-25", 1_724_544_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1668_test() {
  assert result.map(temporal.parse_day_between("2024-08-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-26", 1_724_630_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1669_test() {
  assert result.map(temporal.parse_day_between("2024-08-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-27", 1_724_716_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1670_test() {
  assert result.map(temporal.parse_day_between("2024-08-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-28", 1_724_803_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1671_test() {
  assert result.map(temporal.parse_day_between("2024-08-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-29", 1_724_889_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1672_test() {
  assert result.map(temporal.parse_day_between("2024-08-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-30", 1_724_976_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1673_test() {
  assert result.map(temporal.parse_day_between("2024-08-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-08-31", 1_725_062_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1674_test() {
  assert result.map(temporal.parse_day_between("2024-08-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1675_test() {
  assert result.map(temporal.parse_day_between("2024-09-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1676_test() {
  assert result.map(temporal.parse_day_between("2024-09-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-01", 1_725_148_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1677_test() {
  assert result.map(temporal.parse_day_between("2024-09-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-02", 1_725_235_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1678_test() {
  assert result.map(temporal.parse_day_between("2024-09-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-03", 1_725_321_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1679_test() {
  assert result.map(temporal.parse_day_between("2024-09-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-04", 1_725_408_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1680_test() {
  assert result.map(temporal.parse_day_between("2024-09-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-05", 1_725_494_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1681_test() {
  assert result.map(temporal.parse_day_between("2024-09-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-06", 1_725_580_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1682_test() {
  assert result.map(temporal.parse_day_between("2024-09-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-07", 1_725_667_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1683_test() {
  assert result.map(temporal.parse_day_between("2024-09-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-08", 1_725_753_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1684_test() {
  assert result.map(temporal.parse_day_between("2024-09-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-09", 1_725_840_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1685_test() {
  assert result.map(temporal.parse_day_between("2024-09-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-10", 1_725_926_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1686_test() {
  assert result.map(temporal.parse_day_between("2024-09-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-11", 1_726_012_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1687_test() {
  assert result.map(temporal.parse_day_between("2024-09-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-12", 1_726_099_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1688_test() {
  assert result.map(temporal.parse_day_between("2024-09-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-13", 1_726_185_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1689_test() {
  assert result.map(temporal.parse_day_between("2024-09-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-14", 1_726_272_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1690_test() {
  assert result.map(temporal.parse_day_between("2024-09-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-15", 1_726_358_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1691_test() {
  assert result.map(temporal.parse_day_between("2024-09-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-16", 1_726_444_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1692_test() {
  assert result.map(temporal.parse_day_between("2024-09-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-17", 1_726_531_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1693_test() {
  assert result.map(temporal.parse_day_between("2024-09-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-18", 1_726_617_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1694_test() {
  assert result.map(temporal.parse_day_between("2024-09-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-19", 1_726_704_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1695_test() {
  assert result.map(temporal.parse_day_between("2024-09-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-20", 1_726_790_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1696_test() {
  assert result.map(temporal.parse_day_between("2024-09-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-21", 1_726_876_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1697_test() {
  assert result.map(temporal.parse_day_between("2024-09-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-22", 1_726_963_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1698_test() {
  assert result.map(temporal.parse_day_between("2024-09-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-23", 1_727_049_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1699_test() {
  assert result.map(temporal.parse_day_between("2024-09-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-24", 1_727_136_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1700_test() {
  assert result.map(temporal.parse_day_between("2024-09-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-25", 1_727_222_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1701_test() {
  assert result.map(temporal.parse_day_between("2024-09-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-26", 1_727_308_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1702_test() {
  assert result.map(temporal.parse_day_between("2024-09-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-27", 1_727_395_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1703_test() {
  assert result.map(temporal.parse_day_between("2024-09-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-28", 1_727_481_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1704_test() {
  assert result.map(temporal.parse_day_between("2024-09-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-29", 1_727_568_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1705_test() {
  assert result.map(temporal.parse_day_between("2024-09-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-09-30", 1_727_654_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1706_test() {
  assert result.map(temporal.parse_day_between("2024-09-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1707_test() {
  assert result.map(temporal.parse_day_between("2024-09-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1708_test() {
  assert result.map(temporal.parse_day_between("2024-10-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1709_test() {
  assert result.map(temporal.parse_day_between("2024-10-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-01", 1_727_740_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1710_test() {
  assert result.map(temporal.parse_day_between("2024-10-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-02", 1_727_827_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1711_test() {
  assert result.map(temporal.parse_day_between("2024-10-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-03", 1_727_913_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1712_test() {
  assert result.map(temporal.parse_day_between("2024-10-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-04", 1_728_000_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1713_test() {
  assert result.map(temporal.parse_day_between("2024-10-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-05", 1_728_086_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1714_test() {
  assert result.map(temporal.parse_day_between("2024-10-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-06", 1_728_172_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1715_test() {
  assert result.map(temporal.parse_day_between("2024-10-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-07", 1_728_259_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1716_test() {
  assert result.map(temporal.parse_day_between("2024-10-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-08", 1_728_345_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1717_test() {
  assert result.map(temporal.parse_day_between("2024-10-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-09", 1_728_432_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1718_test() {
  assert result.map(temporal.parse_day_between("2024-10-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-10", 1_728_518_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1719_test() {
  assert result.map(temporal.parse_day_between("2024-10-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-11", 1_728_604_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1720_test() {
  assert result.map(temporal.parse_day_between("2024-10-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-12", 1_728_691_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1721_test() {
  assert result.map(temporal.parse_day_between("2024-10-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-13", 1_728_777_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1722_test() {
  assert result.map(temporal.parse_day_between("2024-10-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-14", 1_728_864_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1723_test() {
  assert result.map(temporal.parse_day_between("2024-10-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-15", 1_728_950_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1724_test() {
  assert result.map(temporal.parse_day_between("2024-10-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-16", 1_729_036_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1725_test() {
  assert result.map(temporal.parse_day_between("2024-10-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-17", 1_729_123_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1726_test() {
  assert result.map(temporal.parse_day_between("2024-10-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-18", 1_729_209_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1727_test() {
  assert result.map(temporal.parse_day_between("2024-10-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-19", 1_729_296_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1728_test() {
  assert result.map(temporal.parse_day_between("2024-10-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-20", 1_729_382_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1729_test() {
  assert result.map(temporal.parse_day_between("2024-10-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-21", 1_729_468_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1730_test() {
  assert result.map(temporal.parse_day_between("2024-10-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-22", 1_729_555_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1731_test() {
  assert result.map(temporal.parse_day_between("2024-10-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-23", 1_729_641_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1732_test() {
  assert result.map(temporal.parse_day_between("2024-10-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-24", 1_729_728_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1733_test() {
  assert result.map(temporal.parse_day_between("2024-10-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-25", 1_729_814_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1734_test() {
  assert result.map(temporal.parse_day_between("2024-10-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-26", 1_729_900_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1735_test() {
  assert result.map(temporal.parse_day_between("2024-10-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-27", 1_729_987_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1736_test() {
  assert result.map(temporal.parse_day_between("2024-10-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-28", 1_730_073_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1737_test() {
  assert result.map(temporal.parse_day_between("2024-10-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-29", 1_730_160_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1738_test() {
  assert result.map(temporal.parse_day_between("2024-10-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-30", 1_730_246_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1739_test() {
  assert result.map(temporal.parse_day_between("2024-10-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-10-31", 1_730_332_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1740_test() {
  assert result.map(temporal.parse_day_between("2024-10-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1741_test() {
  assert result.map(temporal.parse_day_between("2024-11-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1742_test() {
  assert result.map(temporal.parse_day_between("2024-11-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-01", 1_730_419_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1743_test() {
  assert result.map(temporal.parse_day_between("2024-11-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-02", 1_730_505_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1744_test() {
  assert result.map(temporal.parse_day_between("2024-11-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-03", 1_730_592_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1745_test() {
  assert result.map(temporal.parse_day_between("2024-11-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-04", 1_730_678_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1746_test() {
  assert result.map(temporal.parse_day_between("2024-11-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-05", 1_730_764_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1747_test() {
  assert result.map(temporal.parse_day_between("2024-11-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-06", 1_730_851_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1748_test() {
  assert result.map(temporal.parse_day_between("2024-11-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-07", 1_730_937_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1749_test() {
  assert result.map(temporal.parse_day_between("2024-11-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-08", 1_731_024_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1750_test() {
  assert result.map(temporal.parse_day_between("2024-11-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-09", 1_731_110_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1751_test() {
  assert result.map(temporal.parse_day_between("2024-11-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-10", 1_731_196_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1752_test() {
  assert result.map(temporal.parse_day_between("2024-11-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-11", 1_731_283_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1753_test() {
  assert result.map(temporal.parse_day_between("2024-11-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-12", 1_731_369_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1754_test() {
  assert result.map(temporal.parse_day_between("2024-11-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-13", 1_731_456_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1755_test() {
  assert result.map(temporal.parse_day_between("2024-11-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-14", 1_731_542_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1756_test() {
  assert result.map(temporal.parse_day_between("2024-11-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-15", 1_731_628_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1757_test() {
  assert result.map(temporal.parse_day_between("2024-11-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-16", 1_731_715_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1758_test() {
  assert result.map(temporal.parse_day_between("2024-11-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-17", 1_731_801_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1759_test() {
  assert result.map(temporal.parse_day_between("2024-11-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-18", 1_731_888_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1760_test() {
  assert result.map(temporal.parse_day_between("2024-11-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-19", 1_731_974_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1761_test() {
  assert result.map(temporal.parse_day_between("2024-11-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-20", 1_732_060_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1762_test() {
  assert result.map(temporal.parse_day_between("2024-11-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-21", 1_732_147_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1763_test() {
  assert result.map(temporal.parse_day_between("2024-11-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-22", 1_732_233_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1764_test() {
  assert result.map(temporal.parse_day_between("2024-11-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-23", 1_732_320_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1765_test() {
  assert result.map(temporal.parse_day_between("2024-11-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-24", 1_732_406_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1766_test() {
  assert result.map(temporal.parse_day_between("2024-11-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-25", 1_732_492_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1767_test() {
  assert result.map(temporal.parse_day_between("2024-11-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-26", 1_732_579_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1768_test() {
  assert result.map(temporal.parse_day_between("2024-11-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-27", 1_732_665_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1769_test() {
  assert result.map(temporal.parse_day_between("2024-11-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-28", 1_732_752_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1770_test() {
  assert result.map(temporal.parse_day_between("2024-11-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-29", 1_732_838_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1771_test() {
  assert result.map(temporal.parse_day_between("2024-11-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-11-30", 1_732_924_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1772_test() {
  assert result.map(temporal.parse_day_between("2024-11-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDayInMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1773_test() {
  assert result.map(temporal.parse_day_between("2024-11-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1774_test() {
  assert result.map(temporal.parse_day_between("2024-12-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1775_test() {
  assert result.map(temporal.parse_day_between("2024-12-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-01", 1_733_011_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1776_test() {
  assert result.map(temporal.parse_day_between("2024-12-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-02", 1_733_097_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1777_test() {
  assert result.map(temporal.parse_day_between("2024-12-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-03", 1_733_184_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1778_test() {
  assert result.map(temporal.parse_day_between("2024-12-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-04", 1_733_270_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1779_test() {
  assert result.map(temporal.parse_day_between("2024-12-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-05", 1_733_356_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1780_test() {
  assert result.map(temporal.parse_day_between("2024-12-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-06", 1_733_443_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1781_test() {
  assert result.map(temporal.parse_day_between("2024-12-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-07", 1_733_529_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1782_test() {
  assert result.map(temporal.parse_day_between("2024-12-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-08", 1_733_616_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1783_test() {
  assert result.map(temporal.parse_day_between("2024-12-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-09", 1_733_702_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1784_test() {
  assert result.map(temporal.parse_day_between("2024-12-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-10", 1_733_788_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1785_test() {
  assert result.map(temporal.parse_day_between("2024-12-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-11", 1_733_875_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1786_test() {
  assert result.map(temporal.parse_day_between("2024-12-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-12", 1_733_961_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1787_test() {
  assert result.map(temporal.parse_day_between("2024-12-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-13", 1_734_048_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1788_test() {
  assert result.map(temporal.parse_day_between("2024-12-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-14", 1_734_134_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1789_test() {
  assert result.map(temporal.parse_day_between("2024-12-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-15", 1_734_220_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1790_test() {
  assert result.map(temporal.parse_day_between("2024-12-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-16", 1_734_307_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1791_test() {
  assert result.map(temporal.parse_day_between("2024-12-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-17", 1_734_393_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1792_test() {
  assert result.map(temporal.parse_day_between("2024-12-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-18", 1_734_480_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1793_test() {
  assert result.map(temporal.parse_day_between("2024-12-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-19", 1_734_566_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1794_test() {
  assert result.map(temporal.parse_day_between("2024-12-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-20", 1_734_652_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1795_test() {
  assert result.map(temporal.parse_day_between("2024-12-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-21", 1_734_739_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1796_test() {
  assert result.map(temporal.parse_day_between("2024-12-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-22", 1_734_825_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1797_test() {
  assert result.map(temporal.parse_day_between("2024-12-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-23", 1_734_912_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1798_test() {
  assert result.map(temporal.parse_day_between("2024-12-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-24", 1_734_998_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1799_test() {
  assert result.map(temporal.parse_day_between("2024-12-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-25", 1_735_084_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1800_test() {
  assert result.map(temporal.parse_day_between("2024-12-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-26", 1_735_171_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1801_test() {
  assert result.map(temporal.parse_day_between("2024-12-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-27", 1_735_257_600_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1802_test() {
  assert result.map(temporal.parse_day_between("2024-12-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-28", 1_735_344_000_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1803_test() {
  assert result.map(temporal.parse_day_between("2024-12-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-29", 1_735_430_400_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1804_test() {
  assert result.map(temporal.parse_day_between("2024-12-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-30", 1_735_516_800_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1805_test() {
  assert result.map(temporal.parse_day_between("2024-12-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2024-12-31", 1_735_603_200_000))
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1806_test() {
  assert result.map(temporal.parse_day_between("2024-12-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchDay)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1807_test() {
  assert result.map(temporal.parse_day_between("2024-13-00", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1808_test() {
  assert result.map(temporal.parse_day_between("2024-13-01", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1809_test() {
  assert result.map(temporal.parse_day_between("2024-13-02", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1810_test() {
  assert result.map(temporal.parse_day_between("2024-13-03", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1811_test() {
  assert result.map(temporal.parse_day_between("2024-13-04", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1812_test() {
  assert result.map(temporal.parse_day_between("2024-13-05", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1813_test() {
  assert result.map(temporal.parse_day_between("2024-13-06", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1814_test() {
  assert result.map(temporal.parse_day_between("2024-13-07", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1815_test() {
  assert result.map(temporal.parse_day_between("2024-13-08", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1816_test() {
  assert result.map(temporal.parse_day_between("2024-13-09", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1817_test() {
  assert result.map(temporal.parse_day_between("2024-13-10", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1818_test() {
  assert result.map(temporal.parse_day_between("2024-13-11", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1819_test() {
  assert result.map(temporal.parse_day_between("2024-13-12", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1820_test() {
  assert result.map(temporal.parse_day_between("2024-13-13", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1821_test() {
  assert result.map(temporal.parse_day_between("2024-13-14", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1822_test() {
  assert result.map(temporal.parse_day_between("2024-13-15", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1823_test() {
  assert result.map(temporal.parse_day_between("2024-13-16", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1824_test() {
  assert result.map(temporal.parse_day_between("2024-13-17", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1825_test() {
  assert result.map(temporal.parse_day_between("2024-13-18", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1826_test() {
  assert result.map(temporal.parse_day_between("2024-13-19", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1827_test() {
  assert result.map(temporal.parse_day_between("2024-13-20", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1828_test() {
  assert result.map(temporal.parse_day_between("2024-13-21", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1829_test() {
  assert result.map(temporal.parse_day_between("2024-13-22", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1830_test() {
  assert result.map(temporal.parse_day_between("2024-13-23", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1831_test() {
  assert result.map(temporal.parse_day_between("2024-13-24", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1832_test() {
  assert result.map(temporal.parse_day_between("2024-13-25", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1833_test() {
  assert result.map(temporal.parse_day_between("2024-13-26", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1834_test() {
  assert result.map(temporal.parse_day_between("2024-13-27", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1835_test() {
  assert result.map(temporal.parse_day_between("2024-13-28", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1836_test() {
  assert result.map(temporal.parse_day_between("2024-13-29", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1837_test() {
  assert result.map(temporal.parse_day_between("2024-13-30", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1838_test() {
  assert result.map(temporal.parse_day_between("2024-13-31", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: parseStrictDateOnly — B4 property: 1848 (year, month, day) triples agree with an independent calendar (1900 is not a leap year; 2000 is)
pub fn b4_property_1848_year_month_day_triples_agree_with_an_independent_calend_1839_test() {
  assert result.map(temporal.parse_day_between("2024-13-32", 1900, 2100), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Error(temporal.NoSuchMonth)
}

// dates: readDateOnly — B5 readDateOnly is the stored-field reader: unreadable → null
pub fn b5_readdateonly_is_the_stored_field_reader_unreadable_null_test() {
  assert option.from_result(result.map(
      temporal.read_day(base.body("\"2026-02-30\"")),
      temporal.day_text,
    ))
    == None
}

// dates: readDateOnly — B5 readDateOnly is the stored-field reader: unreadable → null
pub fn b5_readdateonly_is_the_stored_field_reader_unreadable_null_2_test() {
  assert option.from_result(result.map(
      temporal.read_day(base.body("\"2026-03-01\"")),
      temporal.day_text,
    ))
    == Some("2026-03-01")
}

// dates: endOfDayExclusive — B6 a DATE_ONLY end covers the whole day: its instant is the start of the next UTC day
pub fn b6_a_date_only_end_covers_the_whole_day_its_instant_is_the_start_of_the_test() {
  assert option.from_result(result.map(
      temporal.read_day(base.body("\"2026-03-01\"")),
      temporal.day_end,
    ))
    == Some(1_772_409_600_000)
}

// dates: endOfDayExclusive — B6 a DATE_ONLY end covers the whole day: its instant is the start of the next UTC day
pub fn b6_a_date_only_end_covers_the_whole_day_its_instant_is_the_start_of_the_2_test() {
  assert option.from_result(result.map(
      temporal.read_day(base.body("\"2026-02-30\"")),
      temporal.day_end,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2011-04-31: unreadable → age NaN → not adult
pub fn neg_c1_dob_2011_04_31_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2011-04-31"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2019-02-29: unreadable → age NaN → not adult
pub fn neg_c1_dob_2019_02_29_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2019-02-29"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2023-13-01: unreadable → age NaN → not adult
pub fn neg_c1_dob_2023_13_01_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2023-13-01"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2023-00-10: unreadable → age NaN → not adult
pub fn neg_c1_dob_2023_00_10_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2023-00-10"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2023-01-00: unreadable → age NaN → not adult
pub fn neg_c1_dob_2023_01_00_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2023-01-00"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 2023-01-32: unreadable → age NaN → not adult
pub fn neg_c1_dob_2023_01_32_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2023-01-32"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — [neg] C1 dob 02/03/2010: unreadable → age NaN → not adult
pub fn neg_c1_dob_02_03_2010_unreadable_age_nan_not_adult_test() {
  assert option.from_result(result.map(
      temporal.parse_day("02/03/2010"),
      temporal.day_text,
    ))
    == None
}

// dates: parseDob — C2 real leap days are dates of birth
pub fn c2_real_leap_days_are_dates_of_birth_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2000-02-29"),
      temporal.day_text,
    ))
    == Some("2000-02-29")
}

// dates: parseDob — C2 real leap days are dates of birth
pub fn c2_real_leap_days_are_dates_of_birth_2_test() {
  assert option.from_result(result.map(
      temporal.parse_day("2020-02-29"),
      temporal.day_text,
    ))
    == Some("2020-02-29")
}

// dates: parseInstant — [neg] D1 "2026-03-01 10:00" is not an instant (wrong shape)
pub fn neg_d1_2026_03_01_10_00_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"2026-03-01 10:00\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 "2026-03-01" is not an instant (wrong shape)
pub fn neg_d1_2026_03_01_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"2026-03-01\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 "02/03/2026 10:00" is not an instant (wrong shape)
pub fn neg_d1_02_03_2026_10_00_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"02/03/2026 10:00\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 "March 1 2026" is not an instant (wrong shape)
pub fn neg_d1_march_1_2026_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"March 1 2026\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 "1700000000000" is not an instant (wrong shape)
pub fn neg_d1_1700000000000_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"1700000000000\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 "2026-02-30T10:00Z" is not an instant (no such calendar day)
pub fn neg_d1_2026_02_30t10_00z_is_not_an_instant_no_such_calendar_day_test() {
  assert temporal.instant(base.body("\"2026-02-30T10:00Z\""), 1900, 2100)
    == Error(temporal.NoSuchCalendarDay)
}

// dates: parseInstant — [neg] D1 "2026-03-01T24:00Z" is not an instant (no such time of day)
pub fn neg_d1_2026_03_01t24_00z_is_not_an_instant_no_such_time_of_day_test() {
  assert temporal.instant(base.body("\"2026-03-01T24:00Z\""), 1900, 2100)
    == Error(temporal.NoSuchTimeOfDay)
}

// dates: parseInstant — [neg] D1 "2026-03-01T10:60Z" is not an instant (no such time of day)
pub fn neg_d1_2026_03_01t10_60z_is_not_an_instant_no_such_time_of_day_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:60Z\""), 1900, 2100)
    == Error(temporal.NoSuchTimeOfDay)
}

// dates: parseInstant — [neg] D1 "2026-03-01T10:00:60Z" is not an instant (no such time of day)
pub fn neg_d1_2026_03_01t10_00_60z_is_not_an_instant_no_such_time_of_day_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:00:60Z\""), 1900, 2100)
    == Error(temporal.NoSuchTimeOfDay)
}

// dates: parseInstant — [neg] D1 "2026-03-01T10:00+15:00" is not an instant (no such offset)
pub fn neg_d1_2026_03_01t10_00_15_00_is_not_an_instant_no_such_offset_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:00+15:00\""), 1900, 2100)
    == Error(temporal.NoSuchOffset)
}

// dates: parseInstant — [neg] D1 "2026-03-01T10:00+05:60" is not an instant (no such offset)
pub fn neg_d1_2026_03_01t10_00_05_60_is_not_an_instant_no_such_offset_test() {
  assert temporal.instant(base.body("\"2026-03-01T10:00+05:60\""), 1900, 2100)
    == Error(temporal.NoSuchOffset)
}

// dates: parseInstant — [neg] D1 "1899-12-31T23:59Z" is not an instant (no such calendar day)
pub fn neg_d1_1899_12_31t23_59z_is_not_an_instant_no_such_calendar_day_test() {
  assert temporal.instant(base.body("\"1899-12-31T23:59Z\""), 1900, 2100)
    == Error(temporal.NoSuchCalendarDay)
}

// dates: parseInstant — [neg] D1 "2101-01-01T00:00Z" is not an instant (no such calendar day)
pub fn neg_d1_2101_01_01t00_00z_is_not_an_instant_no_such_calendar_day_test() {
  assert temporal.instant(base.body("\"2101-01-01T00:00Z\""), 1900, 2100)
    == Error(temporal.NoSuchCalendarDay)
}

// dates: parseInstant — [neg] D1 1.5 is not an instant (not a whole number)
pub fn neg_d1_1_5_is_not_an_instant_not_a_whole_number_test() {
  assert temporal.instant(base.body("1.5"), 1900, 2100)
    == Error(temporal.NotAWholeNumber)
}

// dates: parseInstant — [neg] D1 "" is not an instant (wrong shape)
pub fn neg_d1_is_not_an_instant_wrong_shape_test() {
  assert temporal.instant(base.body("\"\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — [neg] D1 null is not an instant (not a date-time)
pub fn neg_d1_null_is_not_an_instant_not_a_date_time_test() {
  assert temporal.instant(base.body("null"), 1900, 2100)
    == Error(temporal.NotADateTime)
}

// dates: parseInstant — [neg] D1 {} is not an instant (not a date-time)
pub fn neg_d1_is_not_an_instant_not_a_date_time_test() {
  assert temporal.instant(base.body("{}"), 1900, 2100)
    == Error(temporal.NotADateTime)
}

// dates: parseInstant — [neg] D1 [] is not an instant (not a date-time)
pub fn neg_d1_is_not_an_instant_not_a_date_time_2_test() {
  assert temporal.instant(base.body("[]"), 1900, 2100)
    == Error(temporal.NotADateTime)
}

// dates: parseInstant — [neg] D1 true is not an instant (not a date-time)
pub fn neg_d1_true_is_not_an_instant_not_a_date_time_test() {
  assert temporal.instant(base.body("true"), 1900, 2100)
    == Error(temporal.NotADateTime)
}

// dates: parseInstant — D2b +05:30
pub fn d2b_05_30_test() {
  assert temporal.instant(
      base.body("\"2026-03-01T10:00:00+05:30\""),
      1900,
      2100,
    )
    == Ok(1_772_339_400_000)
}

// dates: parseInstant — D2c -04:00 with milliseconds
pub fn d2c_04_00_with_milliseconds_test() {
  assert temporal.instant(
      base.body("\"2026-03-01T10:00:00.250-04:00\""),
      1900,
      2100,
    )
    == Ok(1_772_373_600_250)
}

// dates: parseInstant — D3 integer milliseconds pass through (0 and -1 are instants, not "absent")
pub fn d3_integer_milliseconds_pass_through_0_and_1_are_instants_not_absent_test() {
  assert temporal.instant(base.body("1790164800000"), 1900, 2100)
    == Ok(1_790_164_800_000)
}

// dates: parseInstant — D3 integer milliseconds pass through (0 and -1 are instants, not "absent")
pub fn d3_integer_milliseconds_pass_through_0_and_1_are_instants_not_absent_2_test() {
  assert temporal.instant(base.body("0"), 1900, 2100) == Ok(0)
}

// dates: parseInstant — D3 integer milliseconds pass through (0 and -1 are instants, not "absent")
pub fn d3_integer_milliseconds_pass_through_0_and_1_are_instants_not_absent_3_test() {
  assert temporal.instant(base.body("-1"), 1900, 2100) == Ok(-1)
}

// dates: utcDayOf — D5 utcDayOf
pub fn d5_utcdayof_test() {
  assert temporal.day_text(temporal.day_of(1_790_164_800_000)) == "2026-09-23"
}

// dates: parseDateOrInstant — E1 a DATE_ONLY resolves to the start of the UTC day (default edge)
pub fn e1_a_date_only_resolves_to_the_start_of_the_utc_day_default_edge_test() {
  assert result.map(temporal.parse_due(base.body("\"2026-03-01\"")), fn(d) {
      #(d, temporal.start(d))
    })
    == Ok(#(temporal.OnDay(base.day("2026-03-01")), 1_772_323_200_000))
}

// dates: parseDateOrInstant — E2 …or the first instant after it, for an expiry
pub fn e2_or_the_first_instant_after_it_for_an_expiry_test() {
  assert result.map(temporal.parse_due(base.body("\"2026-03-01\"")), fn(d) {
      #(d, temporal.end(d))
    })
    == Ok(#(temporal.OnDay(base.day("2026-03-01")), 1_772_409_600_000))
}

// dates: parseDateOrInstant — E3 an instant stays an instant
pub fn e3_an_instant_stays_an_instant_test() {
  assert result.map(
      temporal.parse_due(base.body("\"2026-03-01T10:00Z\"")),
      fn(d) { #(d, temporal.start(d)) },
    )
    == Ok(#(temporal.AtInstant(1_772_359_200_000), 1_772_359_200_000))
}

// dates: parseDateOrInstant — E3 an instant stays an instant
pub fn e3_an_instant_stays_an_instant_2_test() {
  assert result.map(temporal.parse_due(base.body("1790164800000")), fn(d) {
      #(d, temporal.start(d))
    })
    == Ok(#(temporal.AtInstant(1_790_164_800_000), 1_790_164_800_000))
}

// dates: parseDateOrInstant — [neg] E4 "2026-02-30" refused
pub fn neg_e4_2026_02_30_refused_test() {
  assert result.map(temporal.parse_due(base.body("\"2026-02-30\"")), fn(d) {
      #(d, temporal.start(d))
    })
    == Error(temporal.DueDay(temporal.NoSuchDayInMonth))
}

// dates: parseDateOrInstant — [neg] E4 "2026-03-01T10:00" refused
pub fn neg_e4_2026_03_01t10_00_refused_test() {
  assert result.map(
      temporal.parse_due(base.body("\"2026-03-01T10:00\"")),
      fn(d) { #(d, temporal.start(d)) },
    )
    == Error(temporal.DueInstant(temporal.InstantWrongShape))
}

// dates: parseDateOrInstant — [neg] E4 "soon" refused
pub fn neg_e4_soon_refused_test() {
  assert result.map(temporal.parse_due(base.body("\"soon\"")), fn(d) {
      #(d, temporal.start(d))
    })
    == Error(temporal.DueInstant(temporal.InstantWrongShape))
}

// dates: parseDateOrInstant — [neg] E4 "1700000000000" refused
pub fn neg_e4_1700000000000_refused_test() {
  assert result.map(temporal.parse_due(base.body("\"1700000000000\"")), fn(d) {
      #(d, temporal.start(d))
    })
    == Error(temporal.DueInstant(temporal.InstantWrongShape))
}

// dates: parseDateOrInstant — [neg] E4 1.5 refused
pub fn neg_e4_1_5_refused_test() {
  assert result.map(temporal.parse_due(base.body("1.5")), fn(d) {
      #(d, temporal.start(d))
    })
    == Error(temporal.DueInstant(temporal.NotAWholeNumber))
}

// dates: parseDateOrInstant — [neg] E4 null refused
pub fn neg_e4_null_refused_test() {
  assert result.map(temporal.parse_due(base.body("null")), fn(d) {
      #(d, temporal.start(d))
    })
    == Error(temporal.DueInstant(temporal.NotADateTime))
}

// dates: parseLocalDateTimeWithZone — [neg] G1 02:30 on 8 March 2026 does not exist in New York — refused, not shifted
pub fn neg_g1_02_30_on_8_march_2026_does_not_exist_in_new_york_refused_not_shif_test() {
  assert temporal.local_instant(
      "2026-03-08T02:30",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.Nonexistent)
}

// dates: parseLocalDateTimeWithZone — G1b 01:59 is 06:59Z and 03:00 is 07:00Z — one minute apart on the clock, one minute apart in truth
pub fn g1b_01_59_is_06_59z_and_03_00_is_07_00z_one_minute_apart_on_the_clock_on_test() {
  assert temporal.local_instant(
      "2026-03-08T01:59",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_772_953_140_000,
      offset_minutes: -300,
      ambiguous: False,
    ))
}

// dates: parseLocalDateTimeWithZone — G1b 01:59 is 06:59Z and 03:00 is 07:00Z — one minute apart on the clock, one minute apart in truth
pub fn g1b_01_59_is_06_59z_and_03_00_is_07_00z_one_minute_apart_on_the_clock_on_2_test() {
  assert temporal.local_instant(
      "2026-03-08T03:00",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_772_953_200_000,
      offset_minutes: -240,
      ambiguous: False,
    ))
}

// dates: parseLocalDateTimeWithZone — [neg] G2 01:30 on 1 November 2026 happens twice — refused without an explicit resolution
pub fn neg_g2_01_30_on_1_november_2026_happens_twice_refused_without_an_explici_test() {
  assert temporal.local_instant(
      "2026-11-01T01:30",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.Ambiguous([1_793_511_000_000, 1_793_514_600_000]))
}

// dates: parseLocalDateTimeWithZone — G2b resolved "earlier": the EDT instant (05:30Z)
pub fn g2b_resolved_earlier_the_edt_instant_05_30z_test() {
  assert temporal.local_instant(
      "2026-11-01T01:30",
      base.zone("America/New_York"),
      temporal.Earlier,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_793_511_000_000,
      offset_minutes: -240,
      ambiguous: True,
    ))
}

// dates: parseLocalDateTimeWithZone — G2c resolved "later": the EST instant (06:30Z), flagged ambiguous
pub fn g2c_resolved_later_the_est_instant_06_30z_flagged_ambiguous_test() {
  assert temporal.local_instant(
      "2026-11-01T01:30",
      base.zone("America/New_York"),
      temporal.Later,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_793_514_600_000,
      offset_minutes: -300,
      ambiguous: True,
    ))
}

// dates: parseLocalDateTimeWithZone — G3 an ordinary summer morning: 09:00 EDT is 13:00Z
pub fn g3_an_ordinary_summer_morning_09_00_edt_is_13_00z_test() {
  assert temporal.local_instant(
      "2026-06-01T09:00",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_780_318_800_000,
      offset_minutes: -240,
      ambiguous: False,
    ))
}

// dates: parseLocalDateTimeWithZone — G3b an ordinary winter morning: 09:00 EST is 14:00Z
pub fn g3b_an_ordinary_winter_morning_09_00_est_is_14_00z_test() {
  assert temporal.local_instant(
      "2026-01-15T09:00",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_768_485_600_000,
      offset_minutes: -300,
      ambiguous: False,
    ))
}

// dates: parseLocalDateTimeWithZone — [neg] G4 London springs forward too: 01:30 on 29 March 2026 does not exist
pub fn neg_g4_london_springs_forward_too_01_30_on_29_march_2026_does_not_exist_test() {
  assert temporal.local_instant(
      "2026-03-29T01:30",
      base.zone("Europe/London"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.Nonexistent)
}

// dates: parseLocalDateTimeWithZone — [neg] G4b and 01:30 on 25 October 2026 happens twice
pub fn neg_g4b_and_01_30_on_25_october_2026_happens_twice_test() {
  assert temporal.local_instant(
      "2026-10-25T01:30",
      base.zone("Europe/London"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.Ambiguous([1_792_888_200_000, 1_792_891_800_000]))
}

// dates: parseLocalDateTimeWithZone — [neg] G5b a rolled-over day and a 25th hour are refused as local times too
pub fn neg_g5b_a_rolled_over_day_and_a_25th_hour_are_refused_as_local_times_too_test() {
  assert temporal.local_instant(
      "2026-02-30T09:00",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.LocalNoSuchCalendarDay)
}

// dates: parseLocalDateTimeWithZone — [neg] G5b a rolled-over day and a 25th hour are refused as local times too
pub fn neg_g5b_a_rolled_over_day_and_a_25th_hour_are_refused_as_local_times_too_2_test() {
  assert temporal.local_instant(
      "2026-06-01T25:00",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Error(temporal.LocalNoSuchTimeOfDay)
}

// dates: parseLocalDateTimeWithZone — G6 a session from 01:30 to 03:30 on the spring-forward night is ONE elapsed hour — instants, not wall clocks, are stored
pub fn g6_a_session_from_01_30_to_03_30_on_the_spring_forward_night_is_one_elap_test() {
  assert temporal.local_instant(
      "2026-03-08T01:30",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_772_951_400_000,
      offset_minutes: -300,
      ambiguous: False,
    ))
}

// dates: parseLocalDateTimeWithZone — G6 a session from 01:30 to 03:30 on the spring-forward night is ONE elapsed hour — instants, not wall clocks, are stored
pub fn g6_a_session_from_01_30_to_03_30_on_the_spring_forward_night_is_one_elap_2_test() {
  assert temporal.local_instant(
      "2026-03-08T03:30",
      base.zone("America/New_York"),
      temporal.RefuseAmbiguous,
    )
    == Ok(temporal.LocalInstant(
      ms: 1_772_955_000_000,
      offset_minutes: -240,
      ambiguous: False,
    ))
}

// dates: isExpiredAt — H1 no expiry → not expired
pub fn h1_no_expiry_not_expired_test() {
  assert temporal.is_expired_at(None, 1_790_164_800_000) == False
}

// dates: isExpiredAt — H2 expired at exactly the instant (exclusive end)
pub fn h2_expired_at_exactly_the_instant_exclusive_end_test() {
  assert temporal.is_expired_at(Some(1_790_164_800_001), 1_790_164_800_000)
    == False
}

// dates: isExpiredAt — H2 expired at exactly the instant (exclusive end)
pub fn h2_expired_at_exactly_the_instant_exclusive_end_2_test() {
  assert temporal.is_expired_at(Some(1_790_164_800_000), 1_790_164_800_000)
    == True
}

// dates: isExpiredAt — H2 expired at exactly the instant (exclusive end)
pub fn h2_expired_at_exactly_the_instant_exclusive_end_3_test() {
  assert temporal.is_expired_at(Some(1_790_164_799_999), 1_790_164_800_000)
    == True
}

// dates: isEffectiveAt — H4 effective: started, open or unexpired end
pub fn h4_effective_started_open_or_unexpired_end_test() {
  assert temporal.is_effective_at(1_790_164_799_999, None, 1_790_164_800_000)
    == True
}

// dates: isEffectiveAt — H4 effective: started, open or unexpired end
pub fn h4_effective_started_open_or_unexpired_end_2_test() {
  assert temporal.is_effective_at(1_790_164_800_000, None, 1_790_164_800_000)
    == True
}

// dates: isEffectiveAt — H4 effective: started, open or unexpired end
pub fn h4_effective_started_open_or_unexpired_end_3_test() {
  assert temporal.is_effective_at(
      1_790_164_799_999,
      Some(1_790_164_800_001),
      1_790_164_800_000,
    )
    == True
}

// dates: isEffectiveAt — [neg] H5 not yet started / ended exactly now
pub fn neg_h5_not_yet_started_ended_exactly_now_test() {
  assert temporal.is_effective_at(1_790_164_800_001, None, 1_790_164_800_000)
    == False
}

// dates: isEffectiveAt — [neg] H5 not yet started / ended exactly now
pub fn neg_h5_not_yet_started_ended_exactly_now_2_test() {
  assert temporal.is_effective_at(
      1_790_164_799_999,
      Some(1_790_164_800_000),
      1_790_164_800_000,
    )
    == False
}

// dates: isActiveAt — H8 isActiveAt over a record
pub fn h8_isactiveat_over_a_record_test() {
  assert temporal.is_effective_at(
      1_790_164_799_999,
      Some(1_790_164_800_001),
      1_790_164_800_000,
    )
    == True
}

// dates: isOrderedInterval — H9 ordered intervals
pub fn h9_ordered_intervals_test() {
  assert temporal.is_ordered(1, 2, False) == True
}

// dates: isOrderedInterval — H9 ordered intervals
pub fn h9_ordered_intervals_2_test() {
  assert temporal.is_ordered(2, 2, False) == False
}

// dates: isOrderedInterval — H9 ordered intervals
pub fn h9_ordered_intervals_3_test() {
  assert temporal.is_ordered(2, 2, True) == True
}

// dates: isOrderedInterval — H9 ordered intervals
pub fn h9_ordered_intervals_4_test() {
  assert temporal.is_ordered(3, 2, False) == False
}

// dates: isDayWithin — H11 DATE_ONLY windows are inclusive at both ends
pub fn h11_date_only_windows_are_inclusive_at_both_ends_test() {
  assert temporal.is_day_within(
      base.day("2026-09-23"),
      Some("2026-09-01"),
      Some("2026-09-30"),
    )
    == True
}

// dates: isDayWithin — H11 DATE_ONLY windows are inclusive at both ends
pub fn h11_date_only_windows_are_inclusive_at_both_ends_2_test() {
  assert temporal.is_day_within(base.day("2026-09-23"), None, None) == True
}

// dates: isDayWithin — H11 DATE_ONLY windows are inclusive at both ends
pub fn h11_date_only_windows_are_inclusive_at_both_ends_3_test() {
  assert temporal.is_day_within(
      base.day("2026-09-23"),
      Some("2026-09-23"),
      Some("2026-09-23"),
    )
    == True
}

// dates: isDayWithin — [neg] H12 outside
pub fn neg_h12_outside_test() {
  assert temporal.is_day_within(
      base.day("2026-09-23"),
      Some("2026-09-24"),
      None,
    )
    == False
}

// dates: isDayWithin — [neg] H12 outside
pub fn neg_h12_outside_2_test() {
  assert temporal.is_day_within(
      base.day("2026-09-23"),
      None,
      Some("2026-09-22"),
    )
    == False
}

// dates: isDayWithin — [neg] H13 an unreadable bound or day closes the window
pub fn neg_h13_an_unreadable_bound_or_day_closes_the_window_test() {
  assert temporal.is_day_within(base.day("2026-09-23"), Some("garbage"), None)
    == False
}

// dates: isDayWithin — [neg] H13 an unreadable bound or day closes the window
pub fn neg_h13_an_unreadable_bound_or_day_closes_the_window_2_test() {
  assert temporal.is_day_within(
      base.day("2026-09-23"),
      None,
      Some("2026-02-30"),
    )
    == False
}

// dates: parseDateOrInstant — [neg] O #6 a registry expiry that cannot be read is "no expiry" — EXPECT NO
pub fn neg_o_6_a_registry_expiry_that_cannot_be_read_is_no_expiry_expect_no_test() {
  assert result.map(temporal.parse_due(base.body("\"30/06/2028\"")), fn(d) {
      #(d, temporal.end(d))
    })
    == Error(temporal.DueInstant(temporal.InstantWrongShape))
}
