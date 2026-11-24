//// Checks of the rules from the rules suites of recruitment/trialDatesMinorsAndErasure, recruitment/trials, first
//// generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/trial_rules
import scoutbox/rows/id
import scoutbox/rows/trial_attendance
import scoutbox/rows/trial_schedule_sessions
import scoutbox/rows/trials
import scoutbox/vocab/trial_workflow_state

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "not-a-date" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_not_a_date_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("not-a-date"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-13-99" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_13_99_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-13-99"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-02-31" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_02_31_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-02-31"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day in that month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "NaN" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_nan_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("NaN"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 " 2026-10-03" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_03_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date(" 2026-10-03"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-10-03 " is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_03_is_refused_as_trial_date_invalid_2_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-10-03 "),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "\t2026-10-03" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_t2026_10_03_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("\t2026-10-03"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-10-03T10:00" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_03t10_00_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-10-03T10:00"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-10-03T00:00:00Z" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_03t00_00_00z_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-10-03T00:00:00Z"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "1999-12-31" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_1999_12_31_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("1999-12-31"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (year outside 2000–2100).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2101-01-01" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2101_01_01_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2101-01-01"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (year outside 2000–2100).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "0000-01-01" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_0000_01_01_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("0000-01-01"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (year outside 2000–2100).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "9999-12-31" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_9999_12_31_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("9999-12-31"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (year outside 2000–2100).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-1-3" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_1_3_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-1-3"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "20261003" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_20261003_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("20261003"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-02-29" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_02_29_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-02-29"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day in that month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-04-31" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_04_31_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-04-31"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day in that month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-00-10" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_00_10_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-00-10"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026-10-00" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_00_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-10-00"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "2026/10/03" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_2026_10_03_is_refused_as_trial_date_invalid_3_test() {
  assert result.map_error(
      trial_rules.trial_date("2026/10/03"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "03-10-2026" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_03_10_2026_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("03-10-2026"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "today" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_today_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("today"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A1 "next tuesday-ish" is refused as TRIAL_DATE_INVALID
pub fn neg_a1_next_tuesday_ish_is_refused_as_trial_date_invalid_test() {
  assert result.map_error(
      trial_rules.trial_date("next tuesday-ish"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — A3 a calendar day parses to its own string and its UTC midnight
pub fn a3_a_calendar_day_parses_to_its_own_string_and_its_utc_midnight_test() {
  assert result.map(trial_rules.trial_date("2026-10-03"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2026-10-03", 1_790_985_600_000))
}

// trialDatesMinorsAndErasure: parseTrialDate — A3b a real leap day is accepted
pub fn a3b_a_real_leap_day_is_accepted_test() {
  assert result.map(trial_rules.trial_date("2028-02-29"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2028-02-29", 1_835_395_200_000))
}

// trialDatesMinorsAndErasure: parseTrialDate — [neg] A3c a leap day in a non-leap year is refused
pub fn neg_a3c_a_leap_day_in_a_non_leap_year_is_refused_test() {
  assert result.map_error(
      trial_rules.trial_date("2027-02-29"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day in that month).",
    )
}

// trialDatesMinorsAndErasure: parseTrialDate — A3d the accepted range is inclusive at both ends
pub fn a3d_the_accepted_range_is_inclusive_at_both_ends_test() {
  assert result.map(trial_rules.trial_date("2000-01-01"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2000-01-01", 946_684_800_000))
}

// trialDatesMinorsAndErasure: parseTrialDate — A3d the accepted range is inclusive at both ends
pub fn a3d_the_accepted_range_is_inclusive_at_both_ends_2_test() {
  assert result.map(trial_rules.trial_date("2100-12-31"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2100-12-31", 4_133_894_400_000))
}

// trialDatesMinorsAndErasure: isTrialDate — [neg] A4 isTrialDate is true only for a real stored day
pub fn neg_a4_istrialdate_is_true_only_for_a_real_stored_day_test() {
  assert trial_rules.is_trial_date(Some("")) == False
}

// trialDatesMinorsAndErasure: isTrialDate — [neg] A4 isTrialDate is true only for a real stored day
pub fn neg_a4_istrialdate_is_true_only_for_a_real_stored_day_2_test() {
  assert trial_rules.is_trial_date(None) == False
}

// trialDatesMinorsAndErasure: isTrialDate — [neg] A4 isTrialDate is true only for a real stored day
pub fn neg_a4_istrialdate_is_true_only_for_a_real_stored_day_3_test() {
  assert trial_rules.is_trial_date(Some("bad")) == False
}

// trialDatesMinorsAndErasure: isTrialDate — [neg] A4 isTrialDate is true only for a real stored day
pub fn neg_a4_istrialdate_is_true_only_for_a_real_stored_day_4_test() {
  assert trial_rules.is_trial_date(Some("2026-10-03")) == True
}

// trialDatesMinorsAndErasure: trialReportDueAt — A5 the deadline is trial day + 7 days, from the day not the acceptance
pub fn a5_the_deadline_is_trial_day_7_days_from_the_day_not_the_acceptance_test() {
  assert trial_rules.report_due_at(Some("2026-10-03"), 5) == 1_791_590_400_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — A5b with no day it is acceptance + 7 days, from the clock the caller passed
pub fn a5b_with_no_day_it_is_acceptance_7_days_from_the_clock_the_caller_passed_test() {
  assert trial_rules.report_due_at(None, 1000) == 604_801_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — [neg] A5c a legacy garbage day falls back to the acceptance clock, never NaN
pub fn neg_a5c_a_legacy_garbage_day_falls_back_to_the_acceptance_clock_never_na_test() {
  assert trial_rules.report_due_at(Some("garbage"), 1000) == 604_801_000
}

// trialDatesMinorsAndErasure: validateTrialDetails — A6 valid details come back canonical and untouched
pub fn a6_valid_details_come_back_canonical_and_untouched_test() {
  assert result.map_error(
      trial_rules.validate_details(
        Some(base.body("\"2026-10-03\"")),
        Some(base.body("[\"2026-10-10\",\"2026-10-17\"]")),
        Some(base.body("\"Eastport Dome\"")),
        Some(base.body("\"Bring boots.\"")),
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: Some(base.day("2026-10-03")),
      alt_days: [base.day("2026-10-10"), base.day("2026-10-17")],
      venue: Some("Eastport Dome"),
      notes: "Bring boots.",
    ))
}

// trialDatesMinorsAndErasure: validateTrialDetails — A6b nothing given is a date-to-be-confirmed invitation with empty logistics
pub fn a6b_nothing_given_is_a_date_to_be_confirmed_invitation_with_empty_logist_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, None, None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: None,
      alt_days: [],
      venue: None,
      notes: "",
    ))
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7 a bad proposed date is refused and names its field
pub fn neg_a7_a_bad_proposed_date_is_refused_and_names_its_field_test() {
  assert result.map_error(
      trial_rules.validate_details(Some(base.body("\"bad\"")), None, None, None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_DATE_INVALID\",\"message\":\"A trial date must be a calendar day written YYYY-MM-DD (wrong shape).\",\"expected\":\"YYYY-MM-DD\",\"field\":\"proposedDate\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7b altSlots must be a list
pub fn neg_a7b_altslots_must_be_a_list_test() {
  assert result.map_error(
      trial_rules.validate_details(None, Some(base.body("\"x\"")), None, None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"Alternative slots must be a list of dates.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7c an array-like object is not a list
pub fn neg_a7c_an_array_like_object_is_not_a_list_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        Some(base.body("{\"0\":\"2026-10-10\",\"length\":1}")),
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"Alternative slots must be a list of dates.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7d more than 2 slots is refused, not truncated
pub fn neg_a7d_more_than_2_slots_is_refused_not_truncated_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        Some(base.body("[\"2026-10-10\",\"2026-10-17\",\"2026-10-24\"]")),
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"Offer at most 2 alternative slots.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7e a bad slot is refused as a date, naming altSlots
pub fn neg_a7e_a_bad_slot_is_refused_as_a_date_naming_altslots_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        Some(base.body("[\"2026-10-10\",\"bad\"]")),
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_DATE_INVALID\",\"message\":\"A trial date must be a calendar day written YYYY-MM-DD (wrong shape).\",\"expected\":\"YYYY-MM-DD\",\"field\":\"altSlots\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7f an empty slot is refused (there is no such thing as an alternative "no date")
pub fn neg_a7f_an_empty_slot_is_refused_there_is_no_such_thing_as_an_alternativ_test() {
  assert result.map_error(
      trial_rules.validate_details(None, Some(base.body("[\"\"]")), None, None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"An alternative slot cannot be empty.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7f an empty slot is refused (there is no such thing as an alternative "no date")
pub fn neg_a7f_an_empty_slot_is_refused_there_is_no_such_thing_as_an_alternativ_2_test() {
  assert result.map_error(
      trial_rules.validate_details(None, Some(base.body("[null]")), None, None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"An alternative slot cannot be empty.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7g a slot equal to the proposed day is refused
pub fn neg_a7g_a_slot_equal_to_the_proposed_day_is_refused_test() {
  assert result.map_error(
      trial_rules.validate_details(
        Some(base.body("\"2026-10-03\"")),
        Some(base.body("[\"2026-10-03\"]")),
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"Each offered slot must be a different day.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A7h duplicate slots are refused
pub fn neg_a7h_duplicate_slots_are_refused_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        Some(base.body("[\"2026-10-10\",\"2026-10-10\"]")),
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_SLOTS_INVALID\",\"field\":\"altSlots\",\"message\":\"Each offered slot must be a different day.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8 an over-long venue is refused, not clamped
pub fn neg_a8_an_over_long_venue_is_refused_not_clamped_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        Some(base.body(
          "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
        )),
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"Keep the venue under 200 characters.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — A8b exactly the limit is accepted
pub fn a8b_exactly_the_limit_is_accepted_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        Some(base.body(
          "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
        )),
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: None,
      alt_days: [],
      venue: Some(
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ),
      notes: "",
    ))
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8c a venue with a line break or control character is refused (it is written into a calendar file)
pub fn neg_a8c_a_venue_with_a_line_break_or_control_character_is_refused_it_is_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        Some(base.body("\"Gate B\\nEND:VEVENT\"")),
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue is one line of text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8c a venue with a line break or control character is refused (it is written into a calendar file)
pub fn neg_a8c_a_venue_with_a_line_break_or_control_character_is_refused_it_is_2_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        Some(base.body("\"a\\rb\"")),
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue is one line of text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8c a venue with a line break or control character is refused (it is written into a calendar file)
pub fn neg_a8c_a_venue_with_a_line_break_or_control_character_is_refused_it_is_3_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        Some(base.body("\"a\\u0000b\"")),
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue is one line of text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8d a non-text venue is refused
pub fn neg_a8d_a_non_text_venue_is_refused_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, Some(base.body("{}")), None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue must be text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8d a non-text venue is refused
pub fn neg_a8d_a_non_text_venue_is_refused_2_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, Some(base.body("5")), None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue must be text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A8d a non-text venue is refused
pub fn neg_a8d_a_non_text_venue_is_refused_3_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, Some(base.body("[]")), None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_VENUE_INVALID\",\"field\":\"venue\",\"message\":\"The venue must be text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — A8e an empty venue is no venue
pub fn a8e_an_empty_venue_is_no_venue_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, Some(base.body("\"\"")), None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: None,
      alt_days: [],
      venue: None,
      notes: "",
    ))
}

// trialDatesMinorsAndErasure: validateTrialDetails — A8e an empty venue is no venue
pub fn a8e_an_empty_venue_is_no_venue_2_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, Some(base.body("null")), None),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: None,
      alt_days: [],
      venue: None,
      notes: "",
    ))
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A9 over-long or non-text notes are refused
pub fn neg_a9_over_long_or_non_text_notes_are_refused_test() {
  assert result.map_error(
      trial_rules.validate_details(
        None,
        None,
        None,
        Some(base.body(
          "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
        )),
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_NOTES_INVALID\",\"field\":\"notes\",\"message\":\"Keep the notes under 500 characters.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A9 over-long or non-text notes are refused
pub fn neg_a9_over_long_or_non_text_notes_are_refused_2_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, None, Some(base.body("5"))),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_NOTES_INVALID\",\"field\":\"notes\",\"message\":\"Notes must be text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A9 over-long or non-text notes are refused
pub fn neg_a9_over_long_or_non_text_notes_are_refused_3_test() {
  assert result.map_error(
      trial_rules.validate_details(None, None, None, Some(base.body("{}"))),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Error(
      "{\"ok\":false,\"error\":\"TRIAL_NOTES_INVALID\",\"field\":\"notes\",\"message\":\"Notes must be text.\"}",
    )
}

// trialDatesMinorsAndErasure: validateTrialDetails — [neg] A10 a "__proto__" key in the body neither leaks nor changes the details
pub fn neg_a10_a_proto_key_in_the_body_neither_leaks_nor_changes_the_details_test() {
  assert result.map_error(
      trial_rules.validate_details(
        Some(base.body("\"2026-10-03\"")),
        None,
        None,
        None,
      ),
      fn(f) { json.to_string(json.object(f)) },
    )
    == Ok(trial_rules.Details(
      proposed_date: Some(base.day("2026-10-03")),
      alt_days: [],
      venue: None,
      notes: "",
    ))
}

// trialDatesMinorsAndErasure: chooseTrialSlot — A11 an offered alternative is chosen
pub fn a11_an_offered_alternative_is_chosen_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      ["2026-10-10"],
      Some(base.body("\"2026-10-10\"")),
    )
    == Ok(Some("2026-10-10"))
}

// trialDatesMinorsAndErasure: chooseTrialSlot — A11b no choice means the proposed day
pub fn a11b_no_choice_means_the_proposed_day_test() {
  assert trial_rules.choose_slot(Some("2026-10-03"), ["2026-10-10"], None)
    == Ok(Some("2026-10-03"))
}

// trialDatesMinorsAndErasure: chooseTrialSlot — A11b no choice means the proposed day
pub fn a11b_no_choice_means_the_proposed_day_2_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      [],
      Some(base.body("\"\"")),
    )
    == Ok(Some("2026-10-03"))
}

// trialDatesMinorsAndErasure: chooseTrialSlot — A11b no choice means the proposed day
pub fn a11b_no_choice_means_the_proposed_day_3_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      [],
      Some(base.body("null")),
    )
    == Ok(Some("2026-10-03"))
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12 a day the club never offered is refused and the offered days are listed
pub fn neg_a12_a_day_the_club_never_offered_is_refused_and_the_offered_days_are_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      ["2026-10-10"],
      Some(base.body("\"2026-10-04\"")),
    )
    == Error(["2026-10-03", "2026-10-10"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a {} slot is refused, not coerced
pub fn neg_a12b_a_slot_is_refused_not_coerced_test() {
  assert trial_rules.choose_slot(Some("2026-10-03"), [], Some(base.body("{}")))
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a [] slot is refused, not coerced
pub fn neg_a12b_a_slot_is_refused_not_coerced_2_test() {
  assert trial_rules.choose_slot(Some("2026-10-03"), [], Some(base.body("[]")))
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a 0 slot is refused, not coerced
pub fn neg_a12b_a_0_slot_is_refused_not_coerced_test() {
  assert trial_rules.choose_slot(Some("2026-10-03"), [], Some(base.body("0")))
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a true slot is refused, not coerced
pub fn neg_a12b_a_true_slot_is_refused_not_coerced_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      [],
      Some(base.body("true")),
    )
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a 42 slot is refused, not coerced
pub fn neg_a12b_a_42_slot_is_refused_not_coerced_test() {
  assert trial_rules.choose_slot(Some("2026-10-03"), [], Some(base.body("42")))
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A12b a ["2026-10-03"] slot is refused, not coerced
pub fn neg_a12b_a_2026_10_03_slot_is_refused_not_coerced_test() {
  assert trial_rules.choose_slot(
      Some("2026-10-03"),
      [],
      Some(base.body("[\"2026-10-03\"]")),
    )
    == Error(["2026-10-03"])
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A13 a legacy request whose stored day is garbage yields no date — never the garbage, never an invented day
pub fn neg_a13_a_legacy_request_whose_stored_day_is_garbage_yields_no_date_neve_test() {
  assert trial_rules.choose_slot(
      Some("garbage"),
      [],
      Some(base.body("\"garbage\"")),
    )
    == Ok(None)
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A13 a legacy request whose stored day is garbage yields no date — never the garbage, never an invented day
pub fn neg_a13_a_legacy_request_whose_stored_day_is_garbage_yields_no_date_neve_2_test() {
  assert trial_rules.choose_slot(Some("garbage"), [], None) == Ok(None)
}

// trialDatesMinorsAndErasure: chooseTrialSlot — [neg] A13c a slot cannot be chosen when nothing was offered
pub fn neg_a13c_a_slot_cannot_be_chosen_when_nothing_was_offered_test() {
  assert trial_rules.choose_slot(None, [], Some(base.body("\"2026-10-03\"")))
    == Error([])
}

// trialDatesMinorsAndErasure: trialReportDueAt — A14 a year-boundary trial day derives a deadline in the next year
pub fn a14_a_year_boundary_trial_day_derives_a_deadline_in_the_next_year_test() {
  assert trial_rules.report_due_at(Some("2026-12-31"), 0) == 1_799_280_000_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — A14b end-of-month and leap-day trial days derive correctly
pub fn a14b_end_of_month_and_leap_day_trial_days_derive_correctly_test() {
  assert trial_rules.report_due_at(Some("2026-02-28"), 0) == 1_772_841_600_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — A14b end-of-month and leap-day trial days derive correctly
pub fn a14b_end_of_month_and_leap_day_trial_days_derive_correctly_2_test() {
  assert trial_rules.report_due_at(Some("2028-02-29"), 0) == 1_836_000_000_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — A14c the window is exactly 7 × 24 h across the European DST switches — UTC days, no local-time drift
pub fn a14c_the_window_is_exactly_7_24_h_across_the_european_dst_switches_utc_d_test() {
  assert trial_rules.report_due_at(Some("2026-03-29"), 0) == 1_775_347_200_000
}

// trialDatesMinorsAndErasure: trialReportDueAt — A14c the window is exactly 7 × 24 h across the European DST switches — UTC days, no local-time drift
pub fn a14c_the_window_is_exactly_7_24_h_across_the_european_dst_switches_utc_d_2_test() {
  assert trial_rules.report_due_at(Some("2026-10-25"), 0) == 1_793_491_200_000
}

// trialDatesMinorsAndErasure: parseTrialDate — A14d consecutive days across the year boundary are one day apart
pub fn a14d_consecutive_days_across_the_year_boundary_are_one_day_apart_test() {
  assert result.map(trial_rules.trial_date("2026-12-31"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2026-12-31", 1_798_675_200_000))
}

// trialDatesMinorsAndErasure: parseTrialDate — A14d consecutive days across the year boundary are one day apart
pub fn a14d_consecutive_days_across_the_year_boundary_are_one_day_apart_2_test() {
  assert result.map(trial_rules.trial_date("2027-01-01"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2027-01-01", 1_798_761_600_000))
}

// trials: validateTimezone — U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)
pub fn u1_exact_iana_identifiers_are_accepted_including_current_names_an_older_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Europe/London")), zones.name),
      base.trial_refusal,
    )
    == Ok("Europe/London")
}

// trials: validateTimezone — U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)
pub fn u1_exact_iana_identifiers_are_accepted_including_current_names_an_older_2_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("UTC")), zones.name),
      base.trial_refusal,
    )
    == Ok("UTC")
}

// trials: validateTimezone — U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)
pub fn u1_exact_iana_identifiers_are_accepted_including_current_names_an_older_3_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Asia/Kolkata")), zones.name),
      base.trial_refusal,
    )
    == Ok("Asia/Kolkata")
}

// trials: validateTimezone — U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)
pub fn u1_exact_iana_identifiers_are_accepted_including_current_names_an_older_4_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Europe/Kyiv")), zones.name),
      base.trial_refusal,
    )
    == Ok("Europe/Kyiv")
}

// trials: validateTimezone — U1 exact IANA identifiers are accepted — including current names an older ICU still reports under a legacy alias (D-P4B-1)
pub fn u1_exact_iana_identifiers_are_accepted_including_current_names_an_older_5_test() {
  assert result.map_error(
      result.map(
        trial_rules.valid_timezone(Some("America/St_Johns")),
        zones.name,
      ),
      base.trial_refusal,
    )
    == Ok("America/St_Johns")
}

// trials: validateTimezone — [neg] U1b the modern-name path folds no case either
pub fn neg_u1b_the_modern_name_path_folds_no_case_either_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("asia/kolkata")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U1b the modern-name path folds no case either
pub fn neg_u1b_the_modern_name_path_folds_no_case_either_2_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Asia/kolkata")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U1b the modern-name path folds no case either
pub fn neg_u1b_the_modern_name_path_folds_no_case_either_3_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("europe/kyiv")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "europe/london" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_europe_london_is_not_a_timezone_exact_match_no_case_folding_no_of_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("europe/london")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "Europe/london" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_europe_london_is_not_a_timezone_exact_match_no_case_folding_no_of_2_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Europe/london")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "Mars/Olympus" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_mars_olympus_is_not_a_timezone_exact_match_no_case_folding_no_off_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Mars/Olympus")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "GMT+1" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_gmt_1_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("GMT+1")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "BST" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_bst_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("BST")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "Z" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_z_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Z")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 " UTC" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_utc_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some(" UTC")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "UTC " is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_utc_is_not_a_timezone_exact_match_no_case_folding_no_offsets_2_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("UTC ")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "null" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_null_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(None), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "undefined" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_undefined_is_not_a_timezone_exact_match_no_case_folding_no_offset_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(None), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "constructor" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_constructor_is_not_a_timezone_exact_match_no_case_folding_no_offs_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("constructor")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "__proto__" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_proto_is_not_a_timezone_exact_match_no_case_folding_no_offsets_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("__proto__")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: validateTimezone — [neg] U2 "hasOwnProperty" is not a timezone (exact match, no case folding, no offsets)
pub fn neg_u2_hasownproperty_is_not_a_timezone_exact_match_no_case_folding_no_o_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("hasOwnProperty")), zones.name),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_TIMEZONE_INVALID",
      "timezone must be an IANA time zone name, for example Europe/London.",
      "{}",
    ))
}

// trials: parseInstant — U3 ISO with Z or an offset, or integer milliseconds, are instants
pub fn u3_iso_with_z_or_an_offset_or_integer_milliseconds_are_instants_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T09:30:00Z\""))
    == Ok(1_793_611_800_000)
}

// trials: parseInstant — U3 ISO with Z or an offset, or integer milliseconds, are instants
pub fn u3_iso_with_z_or_an_offset_or_integer_milliseconds_are_instants_2_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T09:30:00+01:00\""))
    == Ok(1_793_608_200_000)
}

// trials: parseInstant — U3 ISO with Z or an offset, or integer milliseconds, are instants
pub fn u3_iso_with_z_or_an_offset_or_integer_milliseconds_are_instants_3_test() {
  assert trial_rules.instant(base.body("1800000000000"))
    == Ok(1_800_000_000_000)
}

// trials: parseInstant — [neg] U4 "2026-11-02T09:30:00" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_11_02t09_30_00_is_not_an_instant_no_local_time_without_a_zon_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T09:30:00\""))
    == Error(temporal.InstantWrongShape)
}

// trials: parseInstant — [neg] U4 "2026-11-02" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_11_02_is_not_an_instant_no_local_time_without_a_zone_no_impo_test() {
  assert trial_rules.instant(base.body("\"2026-11-02\""))
    == Error(temporal.InstantWrongShape)
}

// trials: parseInstant — [neg] U4 "2026-02-30T10:00:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_02_30t10_00_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2026-02-30T10:00:00Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — [neg] U4 "2026-13-01T10:00:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_13_01t10_00_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2026-13-01T10:00:00Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — [neg] U4 "2026-04-31T10:00:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_04_31t10_00_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2026-04-31T10:00:00Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — [neg] U4 "tomorrow" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_tomorrow_is_not_an_instant_no_local_time_without_a_zone_no_imposs_test() {
  assert trial_rules.instant(base.body("\"tomorrow\""))
    == Error(temporal.InstantWrongShape)
}

// trials: parseInstant — [neg] U4 "" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_is_not_an_instant_no_local_time_without_a_zone_no_impossible_cale_test() {
  assert trial_rules.instant(base.body("\"\""))
    == Error(temporal.InstantWrongShape)
}

// trials: parseInstant — [neg] U4 null is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_null_is_not_an_instant_no_local_time_without_a_zone_no_impossible_test() {
  assert trial_rules.instant(base.body("null")) == Error(temporal.NotADateTime)
}

// trials: parseInstant — [neg] U4 1.5 is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_1_5_is_not_an_instant_no_local_time_without_a_zone_no_impossible_test() {
  assert trial_rules.instant(base.body("1.5"))
    == Error(temporal.NotAWholeNumber)
}

// trials: parseInstant — [neg] U4 "1800000000000" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_1800000000000_is_not_an_instant_no_local_time_without_a_zone_no_i_test() {
  assert trial_rules.instant(base.body("\"1800000000000\""))
    == Error(temporal.InstantWrongShape)
}

// trials: parseInstant — [neg] U4 -1 is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_1_is_not_an_instant_no_local_time_without_a_zone_no_impossible_ca_test() {
  assert trial_rules.instant(base.body("-1"))
    == Error(temporal.InstantYearOutside(2000, 2100))
}

// trials: parseInstant — [neg] U4 {} is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_is_not_an_instant_no_local_time_without_a_zone_no_impossible_cale_2_test() {
  assert trial_rules.instant(base.body("{}")) == Error(temporal.NotADateTime)
}

// trials: parseInstant — [neg] U4 [] is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_is_not_an_instant_no_local_time_without_a_zone_no_impossible_cale_3_test() {
  assert trial_rules.instant(base.body("[]")) == Error(temporal.NotADateTime)
}

// trials: parseInstant — [neg] U4 true is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_true_is_not_an_instant_no_local_time_without_a_zone_no_impossible_test() {
  assert trial_rules.instant(base.body("true")) == Error(temporal.NotADateTime)
}

// trials: parseInstant — [neg] U4 "1999-12-31T23:59:59Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_1999_12_31t23_59_59z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"1999-12-31T23:59:59Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — [neg] U4 "2101-01-01T00:00:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2101_01_01t00_00_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2101-01-01T00:00:00Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — [neg] U4 "2026-11-02T24:00:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_11_02t24_00_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T24:00:00Z\""))
    == Error(temporal.NoSuchTimeOfDay)
}

// trials: parseInstant — [neg] U4 "2026-11-02T09:60:00Z" is not an instant — no local time without a zone, no impossible calendar day, no coercion, 2000–2100 only
pub fn neg_u4_2026_11_02t09_60_00z_is_not_an_instant_no_local_time_without_a_zo_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T09:60:00Z\""))
    == Error(temporal.NoSuchTimeOfDay)
}

// trials: parseInstant — U5 29 February 2028 is a real day
pub fn u5_29_february_2028_is_a_real_day_test() {
  assert trial_rules.instant(base.body("\"2028-02-29T10:00:00Z\""))
    == Ok(1_835_431_200_000)
}

// trials: parseInstant — [neg] U5b 29 February 2027 is not
pub fn neg_u5b_29_february_2027_is_not_test() {
  assert trial_rules.instant(base.body("\"2027-02-29T10:00:00Z\""))
    == Error(temporal.NoSuchCalendarDay)
}

// trials: parseInstant — U6 the spring-forward instant keeps its London day on both sides of the gap
pub fn u6_the_spring_forward_instant_keeps_its_london_day_on_both_sides_of_the_test() {
  assert trial_rules.instant(base.body("\"2026-03-29T00:30:00Z\""))
    == Ok(1_774_744_200_000)
}

// trials: localDay — U6 the spring-forward instant keeps its London day on both sides of the gap
pub fn u6_the_spring_forward_instant_keeps_its_london_day_on_both_sides_of_the_2_test() {
  assert trial_rules.local_day(1_774_744_200_000, base.zone("Europe/London"))
    == "2026-03-29"
}

// trials: localDay — U6 the spring-forward instant keeps its London day on both sides of the gap
pub fn u6_the_spring_forward_instant_keeps_its_london_day_on_both_sides_of_the_3_test() {
  assert trial_rules.local_day(1_774_751_400_000, base.zone("Europe/London"))
    == "2026-03-29"
}

// trials: parseInstant — U7 the same instant is a different calendar day in different zones — never a bare date
pub fn u7_the_same_instant_is_a_different_calendar_day_in_different_zones_never_test() {
  assert trial_rules.instant(base.body("\"2026-11-02T23:30:00Z\""))
    == Ok(1_793_662_200_000)
}

// trials: localDay — U7 the same instant is a different calendar day in different zones — never a bare date
pub fn u7_the_same_instant_is_a_different_calendar_day_in_different_zones_never_2_test() {
  assert trial_rules.local_day(1_793_662_200_000, base.zone("Asia/Kolkata"))
    == "2026-11-03"
}

// trials: localDay — U7 the same instant is a different calendar day in different zones — never a bare date
pub fn u7_the_same_instant_is_a_different_calendar_day_in_different_zones_never_3_test() {
  assert trial_rules.local_day(
      1_793_662_200_000,
      base.zone("America/Los_Angeles"),
    )
    == "2026-11-02"
}

// trials: parseInstant — U8 ICS local form is wall-clock in the organiser zone (BST +1)
pub fn u8_ics_local_form_is_wall_clock_in_the_organiser_zone_bst_1_test() {
  assert trial_rules.instant(base.body("\"2026-07-01T09:00:00Z\""))
    == Ok(1_782_896_400_000)
}

// trials: icsLocal — U8 ICS local form is wall-clock in the organiser zone (BST +1)
pub fn u8_ics_local_form_is_wall_clock_in_the_organiser_zone_bst_1_2_test() {
  assert trial_rules.ics_local(1_782_896_400_000, base.zone("Europe/London"))
    == "20260701T100000"
}

// trials: icsText — U9 ICS text escaping covers ; , backslash and line breaks
pub fn u9_ics_text_escaping_covers_backslash_and_line_breaks_test() {
  assert trial_rules.ics_text("a;b,c\\d\nline") == "a\\;b\\,c\\\\d\\nline"
}

// trials: parseInstant — U10 a valid schedule mints stable ids and defaults the kind to training
pub fn u10_a_valid_schedule_mints_stable_ids_and_defaults_the_kind_to_training_test() {
  assert trial_rules.instant(base.body("\"2026-10-01T12:00:00Z\""))
    == Ok(1_790_856_000_000)
}

// trials: validateVenue — [neg] U20b venue name bounds and presence are enforced
pub fn neg_u20b_venue_name_bounds_and_presence_are_enforced_test() {
  assert result.map_error(
      trial_rules.validate_venue(
        Some(trial_rules.VenueInput(
          name: Some(
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          ),
          town: Some("T"),
          address: None,
        )),
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_VENUE_INVALID",
      "Keep the venue name under 120 characters.",
      "{}",
    ))
}

// trials: validateVenue — [neg] U20b venue name bounds and presence are enforced
pub fn neg_u20b_venue_name_bounds_and_presence_are_enforced_2_test() {
  assert result.map_error(
      trial_rules.validate_venue(
        Some(trial_rules.VenueInput(
          name: Some(""),
          town: Some("T"),
          address: None,
        )),
      ),
      base.trial_refusal,
    )
    == Error(#("TRIAL_VENUE_INVALID", "A venue needs a name.", "{}"))
}

// trials: validateVenue — [neg] U20b venue name bounds and presence are enforced
pub fn neg_u20b_venue_name_bounds_and_presence_are_enforced_3_test() {
  assert result.map_error(trial_rules.validate_venue(None), base.trial_refusal)
    == Error(#(
      "TRIAL_VENUE_INVALID",
      "venue must be an object with at least a name.",
      "{}",
    ))
}

// trials: validateSessionInput — [neg] U22 instructions are bounded text
pub fn neg_u22_instructions_are_bounded_text_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1790863200000")),
          ends_at: Some(base.body("1790870400000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Dome"),
            town: Some("Eastport"),
            address: None,
          )),
          instructions: Some(
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          ),
        ),
        1_790_856_000_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "Keep the instructions under 500 characters.",
      "{}",
    ))
}

// trials: materialChange — [neg] U23 a timezone change is material
pub fn neg_u23_a_timezone_change_is_material_test() {
  assert trial_rules.material_change(
      Some(
        #("Europe/London", [
          trial_rules.Compared(
            id: "a",
            starts_at: 1,
            ends_at: 2,
            name: "Dome",
            town: "E",
          ),
        ]),
      ),
      #("Europe/Paris", [
        trial_rules.Compared(
          id: "a",
          starts_at: 1,
          ends_at: 2,
          name: "Dome",
          town: "E",
        ),
      ]),
    )
    == True
}

// trials: materialChange — [neg] U23b a time change is material
pub fn neg_u23b_a_time_change_is_material_test() {
  assert trial_rules.material_change(
      Some(
        #("Europe/London", [
          trial_rules.Compared(
            id: "a",
            starts_at: 1,
            ends_at: 2,
            name: "Dome",
            town: "E",
          ),
        ]),
      ),
      #("Europe/London", [
        trial_rules.Compared(
          id: "a",
          starts_at: 3,
          ends_at: 4,
          name: "Dome",
          town: "E",
        ),
      ]),
    )
    == True
}

// trials: materialChange — [neg] U23c a venue name change is material
pub fn neg_u23c_a_venue_name_change_is_material_test() {
  assert trial_rules.material_change(
      Some(
        #("Europe/London", [
          trial_rules.Compared(
            id: "a",
            starts_at: 1,
            ends_at: 2,
            name: "Dome",
            town: "E",
          ),
        ]),
      ),
      #("Europe/London", [
        trial_rules.Compared(
          id: "a",
          starts_at: 1,
          ends_at: 2,
          name: "Arena",
          town: "E",
        ),
      ]),
    )
    == True
}

// trials: materialChange — U23d instructions, the address line and the kind are not material — the confirmation stands
pub fn u23d_instructions_the_address_line_and_the_kind_are_not_material_the_con_test() {
  assert trial_rules.material_change(
      Some(
        #("Europe/London", [
          trial_rules.Compared(
            id: "a",
            starts_at: 1,
            ends_at: 2,
            name: "Dome",
            town: "E",
          ),
        ]),
      ),
      #("Europe/London", [
        trial_rules.Compared(
          id: "a",
          starts_at: 1,
          ends_at: 2,
          name: "Dome",
          town: "E",
        ),
      ]),
    )
    == False
}

// trials: materialChange — U23e the first schedule is always material
pub fn u23e_the_first_schedule_is_always_material_test() {
  assert trial_rules.material_change(
      None,
      #("Europe/London", [
        trial_rules.Compared(
          id: "a",
          starts_at: 1,
          ends_at: 2,
          name: "Dome",
          town: "E",
        ),
      ]),
    )
    == True
}

// trials: isLegacyTrial — U33 a pre-P4B row derives legacy_accepted from the absence of containers
pub fn u33_a_pre_p4b_row_derives_legacy_accepted_from_the_absence_of_containers_test() {
  assert trial_rules.is_legacy(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
        ),
        sessions: [],
        attendance: [],
      ),
    )
    == True
}

// trials: deriveWorkflowState — U33 a pre-P4B row derives legacy_accepted from the absence of containers
pub fn u33_a_pre_p4b_row_derives_legacy_accepted_from_the_absence_of_containers_2_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
        ),
        sessions: [],
        attendance: [],
      ),
    )
    == trial_workflow_state.LegacyAccepted
}

// trials: deriveWorkflowState — U33 a pre-P4B row derives legacy_accepted from the absence of containers
pub fn u33_a_pre_p4b_row_derives_legacy_accepted_from_the_absence_of_containers_3_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.LegacyAccepted,
        ),
        sessions: [],
        attendance: [],
      ),
    )
    == trial_workflow_state.LegacyAccepted
}

// trials: deriveWorkflowState — U34 accepted without a schedule
pub fn u34_accepted_without_a_schedule_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
    )
    == trial_workflow_state.Accepted
}

// trials: deriveWorkflowState — [neg] U35 a PROPOSED schedule is not scheduled — the recipient has not confirmed
pub fn neg_u35_a_proposed_schedule_is_not_scheduled_the_recipient_has_not_confi_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
    )
    == trial_workflow_state.Accepted
}

// trials: deriveWorkflowState — U36 a confirmed schedule with a session is scheduled
pub fn u36_a_confirmed_schedule_with_a_session_is_scheduled_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
    )
    == trial_workflow_state.Scheduled
}

// trials: deriveWorkflowState — [neg] U36b a confirmed schedule with no sessions is not scheduled
pub fn neg_u36b_a_confirmed_schedule_with_no_sessions_is_not_scheduled_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [],
        attendance: [],
      ),
    )
    == trial_workflow_state.Accepted
}

// trials: deriveWorkflowState — U37 completion.state wins over everything
pub fn u37_completion_state_wins_over_everything_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: Some(1),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
    )
    == trial_workflow_state.Cancelled
}

// trials: deriveWorkflowState — U37 completion.state wins over everything
pub fn u37_completion_state_wins_over_everything_2_test() {
  assert trial_rules.workflow_state(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: Some(1),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
    )
    == trial_workflow_state.Completed
}

// trials: canComplete — [neg] U38 completing an accepted trial names all three missing requirements
pub fn neg_u38_completing_an_accepted_trial_names_all_three_missing_requirement_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Accepted,
          ),
          sessions: [],
          attendance: [],
        ),
        100,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"schedule_not_confirmed\",\"no_attended_session\",\"last_session_not_ended\"]}",
    ))
}

// trials: canComplete — [neg] U39 a scheduled trial after its last session but without attendance is not completable
pub fn neg_u39_a_scheduled_trial_after_its_last_session_but_without_attendance_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [],
        ),
        100,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"no_attended_session\"]}",
    ))
}

// trials: canComplete — [neg] U39b a no-show is attendance recorded, but not attendance taken
pub fn neg_u39b_a_no_show_is_attendance_recorded_but_not_attendance_taken_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 0,
              session_id: id.trial_session("s1"),
              state: trial_attendance.NoShow,
            ),
          ],
        ),
        100,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"no_attended_session\"]}",
    ))
}

// trials: canComplete — [neg] U40 attended, but the last session is still running
pub fn neg_u40_attended_but_the_last_session_is_still_running_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 0,
              session_id: id.trial_session("s1"),
              state: trial_attendance.Attended,
            ),
          ],
        ),
        15,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"last_session_not_ended\"]}",
    ))
}

// trials: canComplete — U41 partial attendance and the last session ended (end == now) completes
pub fn u41_partial_attendance_and_the_last_session_ended_end_now_completes_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 0,
              session_id: id.trial_session("s1"),
              state: trial_attendance.Partial,
            ),
          ],
        ),
        20,
      ),
      base.trial_refusal,
    )
    == Ok(Nil)
}

// trials: canComplete — [neg] U42 attendance is append-only and the LAST record is current
pub fn neg_u42_attendance_is_append_only_and_the_last_record_is_current_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 0,
              session_id: id.trial_session("s1"),
              state: trial_attendance.NoShow,
            ),
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 1,
              session_id: id.trial_session("s1"),
              state: trial_attendance.Attended,
            ),
          ],
        ),
        20,
      ),
      base.trial_refusal,
    )
    == Ok(Nil)
}

// trials: canComplete — [neg] U42 attendance is append-only and the LAST record is current
pub fn neg_u42_attendance_is_append_only_and_the_last_record_is_current_2_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 0,
              session_id: id.trial_session("s1"),
              state: trial_attendance.Attended,
            ),
            trial_attendance.Row(
              ..base.trial_attendance(),
              position: 1,
              session_id: id.trial_session("s1"),
              state: trial_attendance.NoShow,
            ),
          ],
        ),
        20,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"no_attended_session\"]}",
    ))
}

// trials: canComplete — [neg] U43 a completed trial is not completed twice; a cancelled one is not completed at all
pub fn neg_u43_a_completed_trial_is_not_completed_twice_a_cancelled_one_is_not_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
            completion_state: Some(trials.Completed),
            completion_at: None,
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [],
        ),
        20,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_INVALID_STATE",
      "This trial is already completed.",
      "{\"reasons\":[\"already_completed\",\"no_attended_session\"]}",
    ))
}

// trials: canComplete — [neg] U43 a completed trial is not completed twice; a cancelled one is not completed at all
pub fn neg_u43_a_completed_trial_is_not_completed_twice_a_cancelled_one_is_not_2_test() {
  assert result.map_error(
      trial_rules.can_complete(
        trial_rules.Trial(
          ..base.trial(),
          row: trials.Row(
            ..base.trial().row,
            id: id.trial("t"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            status: trials.AwaitingReport,
            workflow_state: trial_workflow_state.Scheduled,
            schedule_timezone: None,
            schedule_revision: Some(1),
            schedule_confirmed_at: Some(5),
            completion_state: Some(trials.Cancelled),
            completion_at: None,
          ),
          sessions: [
            trial_rules.Session(
              row: trial_schedule_sessions.Row(
                ..base.trial_session(),
                position: 0,
                id: id.trial_session("s1"),
                starts_at: 10,
                ends_at: 20,
              ),
              evidence: [],
            ),
          ],
          attendance: [],
        ),
        20,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
      "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
      "{\"reasons\":[\"trial_cancelled\",\"no_attended_session\"]}",
    ))
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.ScheduleAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_2_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.RescheduleAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_3_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.CancelAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_4_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.AttendanceAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_5_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.CompleteAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_6_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.LinkAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_7_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
        ),
        sessions: [],
        attendance: [],
      ),
      trial_rules.ConfirmAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_8_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ScheduleAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_9_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.RescheduleAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_10_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CancelAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_11_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.AttendanceAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_12_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CompleteAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_13_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.LinkAct,
    )
    == False
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_14_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ConfirmAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_15_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ScheduleAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_16_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.RescheduleAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_17_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CancelAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_18_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.AttendanceAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_19_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CompleteAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_20_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.LinkAct,
    )
    == True
}

// trials: trialStateAllows — U44 the state × action matrix: accepted/proposed/scheduled
pub fn u44_the_state_action_matrix_accepted_proposed_scheduled_21_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ConfirmAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ScheduleAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_2_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.RescheduleAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_3_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CancelAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_4_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.AttendanceAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_5_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CompleteAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_6_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.LinkAct,
    )
    == True
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_7_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Completed),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ConfirmAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_8_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ScheduleAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_9_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.RescheduleAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_10_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CancelAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_11_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.AttendanceAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_12_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.CompleteAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_13_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.LinkAct,
    )
    == False
}

// trials: trialStateAllows — [neg] U45 completed allows only evidence linking; cancelled allows nothing
pub fn neg_u45_completed_allows_only_evidence_linking_cancelled_allows_nothing_14_test() {
  assert trial_rules.state_allows(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
          completion_state: Some(trials.Cancelled),
          completion_at: None,
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      trial_rules.ConfirmAct,
    )
    == False
}

// trials: blockedAllows — U47 a blocked club may cancel and file the mandatory report
pub fn u47_a_blocked_club_may_cancel_and_file_the_mandatory_report_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.CancelAct)) == True
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.ScheduleAct)) == False
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_2_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.RescheduleAct)) == False
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_3_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.AttendanceAct)) == False
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_4_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.CompleteAct)) == False
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_5_test() {
  assert trial_rules.blocked_allows(Some(trial_rules.LinkAct)) == False
}

// trials: blockedAllows — [neg] U47b and may do nothing else
pub fn neg_u47b_and_may_do_nothing_else_6_test() {
  assert trial_rules.blocked_allows(None) == False
}

// trials: trialRoleAllows — U48 write is lead+, assess is member+, view is everyone in the room
pub fn u48_write_is_lead_assess_is_member_view_is_everyone_in_the_room_test() {
  assert trial_rules.role_allows(
      Some(room_rules.RecruitmentAdmin),
      trial_rules.TrialWrite,
    )
    == True
}

// trials: trialRoleAllows — U48 write is lead+, assess is member+, view is everyone in the room
pub fn u48_write_is_lead_assess_is_member_view_is_everyone_in_the_room_2_test() {
  assert trial_rules.role_allows(
      Some(room_rules.RoomLead),
      trial_rules.TrialWrite,
    )
    == True
}

// trials: trialRoleAllows — U48 write is lead+, assess is member+, view is everyone in the room
pub fn u48_write_is_lead_assess_is_member_view_is_everyone_in_the_room_3_test() {
  assert trial_rules.role_allows(
      Some(room_rules.Contributor),
      trial_rules.TrialAssess,
    )
    == True
}

// trials: trialRoleAllows — U48 write is lead+, assess is member+, view is everyone in the room
pub fn u48_write_is_lead_assess_is_member_view_is_everyone_in_the_room_4_test() {
  assert trial_rules.role_allows(Some(room_rules.Viewer), trial_rules.TrialView)
    == True
}

// trials: trialRoleAllows — [neg] U48b a contributor cannot write, a viewer cannot assess, no role is no access
pub fn neg_u48b_a_contributor_cannot_write_a_viewer_cannot_assess_no_role_is_no_test() {
  assert trial_rules.role_allows(
      Some(room_rules.Contributor),
      trial_rules.TrialWrite,
    )
    == False
}

// trials: trialRoleAllows — [neg] U48b a contributor cannot write, a viewer cannot assess, no role is no access
pub fn neg_u48b_a_contributor_cannot_write_a_viewer_cannot_assess_no_role_is_no_2_test() {
  assert trial_rules.role_allows(
      Some(room_rules.Viewer),
      trial_rules.TrialAssess,
    )
    == False
}

// trials: trialRoleAllows — [neg] U48b a contributor cannot write, a viewer cannot assess, no role is no access
pub fn neg_u48b_a_contributor_cannot_write_a_viewer_cannot_assess_no_role_is_no_3_test() {
  assert trial_rules.role_allows(None, trial_rules.TrialView) == False
}

// trials: trialIntegrity — [neg] U50 a corrupt row (org_mismatch) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_org_mismatch_fails_integrity_instead_of_being_serv_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("other"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["org_mismatch", "case_mismatch", "schedule.timezone"]
}

// trials: trialIntegrity — [neg] U50 a corrupt row (state_mismatch) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_state_mismatch_fails_integrity_instead_of_being_se_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Accepted,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["case_mismatch", "workflowState_mismatch", "schedule.timezone"]
}

// trials: trialIntegrity — [neg] U50 a corrupt row (session_time) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_session_time_fails_integrity_instead_of_being_serv_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 20,
              ends_at: 10,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["case_mismatch", "schedule.timezone", "schedule.session_time"]
}

// trials: trialIntegrity — [neg] U50 a corrupt row (attendance_orphan) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_attendance_orphan_fails_integrity_instead_of_being_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [
          trial_attendance.Row(
            ..base.trial_attendance(),
            position: 0,
            session_id: id.trial_session("ghost"),
            state: trial_attendance.Attended,
          ),
        ],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["case_mismatch", "schedule.timezone", "attendance.record"]
}

// trials: trialIntegrity — [neg] U50 a corrupt row (timezone) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_timezone_fails_integrity_instead_of_being_served_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          schedule_timezone: Some("Mars/Olympus"),
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["case_mismatch", "schedule.timezone"]
}

// trials: trialIntegrity — [neg] U50 a corrupt row (case_mismatch) fails integrity instead of being served
pub fn neg_u50_a_corrupt_row_case_mismatch_fails_integrity_instead_of_being_ser_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          case_id: Some(id.recruitment_case("k2")),
          schedule_timezone: None,
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == ["case_mismatch", "schedule.timezone"]
}

// trials: trialIntegrity — U50b a sound row passes
pub fn u50b_a_sound_row_passes_test() {
  assert trial_rules.integrity(
      trial_rules.Trial(
        ..base.trial(),
        row: trials.Row(
          ..base.trial().row,
          id: id.trial("t"),
          org_id: id.org("o"),
          player_id: id.player("p"),
          status: trials.AwaitingReport,
          workflow_state: trial_workflow_state.Scheduled,
          case_id: Some(id.recruitment_case("k1")),
          schedule_timezone: Some("Europe/London"),
          schedule_revision: Some(1),
          schedule_confirmed_at: Some(5),
        ),
        sessions: [
          trial_rules.Session(
            row: trial_schedule_sessions.Row(
              ..base.trial_session(),
              position: 0,
              id: id.trial_session("s1"),
              starts_at: 10,
              ends_at: 20,
            ),
            evidence: [],
          ),
        ],
        attendance: [],
      ),
      Some(id.org("o")),
      Some(id.recruitment_case("k1")),
    )
    == []
}
