//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/trial_rules
import scoutbox/vocab/trial_session_kind

// dates: validateTimezone — A7 the Trial zone check is the platform zone check under a Trial name
pub fn a7_the_trial_zone_check_is_the_platform_zone_check_under_a_trial_name_test() {
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

// dates: validateTimezone — A7 the Trial zone check is the platform zone check under a Trial name
pub fn a7_the_trial_zone_check_is_the_platform_zone_check_under_a_trial_name_2_test() {
  assert result.map_error(
      result.map(trial_rules.valid_timezone(Some("Europe/London")), zones.name),
      base.trial_refusal,
    )
    == Ok("Europe/London")
}

// dates: parseInstant — A8 the Trial instant parser IS the platform instant parser
pub fn a8_the_trial_instant_parser_is_the_platform_instant_parser_test() {
  assert trial_rules.instant(base.body("\"2026-03-01T10:00\""))
    == Error(temporal.InstantWrongShape)
}

// dates: parseInstant — A8 the Trial instant parser IS the platform instant parser
pub fn a8_the_trial_instant_parser_is_the_platform_instant_parser_2_test() {
  assert trial_rules.instant(base.body("\"2026-03-01T10:00Z\""))
    == Ok(1_772_359_200_000)
}

// dates: parseTrialDate — A9 the Trial date keeps its own 2000–2100 bound on top of the platform bound
pub fn a9_the_trial_date_keeps_its_own_2000_2100_bound_on_top_of_the_platform_b_test() {
  assert result.map_error(
      trial_rules.trial_date("1999-12-31"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (year outside 2000–2100).",
    )
}

// dates: validateSessionInput — G6 a session from 01:30 to 03:30 on the spring-forward night is ONE elapsed hour — instants, not wall clocks, are stored
pub fn g6_a_session_from_01_30_to_03_30_on_the_spring_forward_night_is_one_elap_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1772951400000")),
          ends_at: Some(base.body("1772955000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Ok(trial_rules.ValidSession(
      kind: trial_session_kind.Training,
      starts_at: 1_772_951_400_000,
      ends_at: 1_772_955_000_000,
      venue: trial_rules.Venue(name: "Field", town: None, address: None),
      instructions: None,
    ))
}

// dates: icsLocal — G6b and the calendar export prints the wall clocks the family will see
pub fn g6b_and_the_calendar_export_prints_the_wall_clocks_the_family_will_see_test() {
  assert trial_rules.ics_local(1_772_951_400_000, base.zone("America/New_York"))
    == "20260308T013000"
}

// dates: icsLocal — G6b and the calendar export prints the wall clocks the family will see
pub fn g6b_and_the_calendar_export_prints_the_wall_clocks_the_family_will_see_2_test() {
  assert trial_rules.ics_local(1_772_955_000_000, base.zone("America/New_York"))
    == "20260308T033000"
}

// dates: localDay — G6c the local day of an instant is the organiser's day, not the UTC day
pub fn g6c_the_local_day_of_an_instant_is_the_organiser_s_day_not_the_utc_day_test() {
  assert trial_rules.local_day(1_772_953_140_000, base.zone("America/New_York"))
    == "2026-03-08"
}

// dates: localDay — G6c the local day of an instant is the organiser's day, not the UTC day
pub fn g6c_the_local_day_of_an_instant_is_the_organiser_s_day_not_the_utc_day_2_test() {
  assert trial_rules.local_day(1_772_945_940_000, base.zone("America/New_York"))
    == "2026-03-07"
}

// dates: validateSessionInput — G7 two elapsed hours from the first 01:30 print as 01:30→02:30 on the wall: the hour that happens twice is accounted for
pub fn g7_two_elapsed_hours_from_the_first_01_30_print_as_01_30_02_30_on_the_wa_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1793511000000")),
          ends_at: Some(base.body("1793518200000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Ok(trial_rules.ValidSession(
      kind: trial_session_kind.Training,
      starts_at: 1_793_511_000_000,
      ends_at: 1_793_518_200_000,
      venue: trial_rules.Venue(name: "Field", town: None, address: None),
      instructions: None,
    ))
}

// dates: icsLocal — G7 two elapsed hours from the first 01:30 print as 01:30→02:30 on the wall: the hour that happens twice is accounted for
pub fn g7_two_elapsed_hours_from_the_first_01_30_print_as_01_30_02_30_on_the_wa_2_test() {
  assert trial_rules.ics_local(1_793_511_000_000, base.zone("America/New_York"))
    == "20261101T013000"
}

// dates: icsLocal — G7 two elapsed hours from the first 01:30 print as 01:30→02:30 on the wall: the hour that happens twice is accounted for
pub fn g7_two_elapsed_hours_from_the_first_01_30_print_as_01_30_02_30_on_the_wa_3_test() {
  assert trial_rules.ics_local(1_793_518_200_000, base.zone("America/New_York"))
    == "20261101T023000"
}

// dates: validateSessionInput — M1 control
pub fn m1_control_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780308000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Ok(trial_rules.ValidSession(
      kind: trial_session_kind.Training,
      starts_at: 1_780_304_400_000,
      ends_at: 1_780_308_000_000,
      venue: trial_rules.Venue(name: "Field", town: None, address: None),
      instructions: None,
    ))
}

// dates: validateSessionInput — [neg] M2 end must be after start
pub fn neg_m2_end_must_be_after_start_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780304400000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session must end after it starts.",
      "{}",
    ))
}

// dates: validateSessionInput — [neg] M2 end must be after start
pub fn neg_m2_end_must_be_after_start_2_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780304399999")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session must end after it starts.",
      "{}",
    ))
}

// dates: validateSessionInput — [neg] M3 15 minutes is the floor (inclusive)
pub fn neg_m3_15_minutes_is_the_floor_inclusive_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780305299999")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session is at least 15 minutes long.",
      "{}",
    ))
}

// dates: validateSessionInput — [neg] M3 15 minutes is the floor (inclusive)
pub fn neg_m3_15_minutes_is_the_floor_inclusive_2_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780305300000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Ok(trial_rules.ValidSession(
      kind: trial_session_kind.Training,
      starts_at: 1_780_304_400_000,
      ends_at: 1_780_305_300_000,
      venue: trial_rules.Venue(name: "Field", town: None, address: None),
      instructions: None,
    ))
}

// dates: validateSessionInput — [neg] M4 12 hours is the ceiling (inclusive)
pub fn neg_m4_12_hours_is_the_ceiling_inclusive_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780347600001")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session is at most 12 hours long.",
      "{}",
    ))
}

// dates: validateSessionInput — [neg] M4 12 hours is the ceiling (inclusive)
pub fn neg_m4_12_hours_is_the_ceiling_inclusive_2_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1780304400000")),
          ends_at: Some(base.body("1780347600000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Ok(trial_rules.ValidSession(
      kind: trial_session_kind.Training,
      starts_at: 1_780_304_400_000,
      ends_at: 1_780_347_600_000,
      venue: trial_rules.Venue(name: "Field", town: None, address: None),
      instructions: None,
    ))
}

// dates: validateSessionInput — [neg] M5 a bare local time, a date-only and a rolled-over day are not session times
pub fn neg_m5_a_bare_local_time_a_date_only_and_a_rolled_over_day_are_not_sessi_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("\"2026-06-01T09:00\"")),
          ends_at: Some(base.body("1780308000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (wrong shape).",
      "{\"field\":\"startsAt\"}",
    ))
}

// dates: validateSessionInput — [neg] M5 a bare local time, a date-only and a rolled-over day are not session times
pub fn neg_m5_a_bare_local_time_a_date_only_and_a_rolled_over_day_are_not_sessi_2_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("\"2026-06-01\"")),
          ends_at: Some(base.body("1780308000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (wrong shape).",
      "{\"field\":\"startsAt\"}",
    ))
}

// dates: validateSessionInput — [neg] M5 a bare local time, a date-only and a rolled-over day are not session times
pub fn neg_m5_a_bare_local_time_a_date_only_and_a_rolled_over_day_are_not_sessi_3_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("\"2026-02-30T09:00Z\"")),
          ends_at: Some(base.body("1780308000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (no such calendar day).",
      "{\"field\":\"startsAt\"}",
    ))
}

// dates: validateSessionInput — [neg] M6 a new session entirely in the past is refused
pub fn neg_m6_a_new_session_entirely_in_the_past_is_refused_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1767218400000")),
          ends_at: Some(base.body("1767222000000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("Field"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1_767_225_600_000,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session cannot be scheduled entirely in the past.",
      "{}",
    ))
}

// dates: parseTrialDate — M10 a trial day
pub fn m10_a_trial_day_test() {
  assert result.map(trial_rules.trial_date("2026-06-01"), fn(d) {
      #(temporal.day_text(d), temporal.day_start(d))
    })
    == Ok(#("2026-06-01", 1_780_272_000_000))
}

// dates: isTrialDate — M10 a trial day
pub fn m10_a_trial_day_2_test() {
  assert trial_rules.is_trial_date(Some("2026-06-01")) == True
}

// dates: parseTrialDate — [neg] M11 not a trial day
pub fn neg_m11_not_a_trial_day_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-02-30"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (no such day in that month).",
    )
}

// dates: parseTrialDate — [neg] M11 not a trial day
pub fn neg_m11_not_a_trial_day_2_test() {
  assert result.map_error(
      trial_rules.trial_date("2026-06-01T00:00:00Z"),
      trial_rules.trial_date_message,
    )
    == Error(
      "A trial date must be a calendar day written YYYY-MM-DD (wrong shape).",
    )
}

// dates: isTrialDate — [neg] M11 not a trial day
pub fn neg_m11_not_a_trial_day_3_test() {
  assert trial_rules.is_trial_date(None) == False
}

// dates: trialReportDueAt — M12 the report deadline derives from the day, else from acceptance, else null (never NaN)
pub fn m12_the_report_deadline_derives_from_the_day_else_from_acceptance_else_n_test() {
  assert trial_rules.report_due_at(Some("2026-06-01"), 5) == 1_780_876_800_000
}

// dates: trialReportDueAt — M12 the report deadline derives from the day, else from acceptance, else null (never NaN)
pub fn m12_the_report_deadline_derives_from_the_day_else_from_acceptance_else_n_2_test() {
  assert trial_rules.report_due_at(Some("2026-02-30"), 5) == 604_800_005
}

// dates: validateSessionInput — [neg] O #12 a session written as a bare local time is scheduled — EXPECT NO
pub fn neg_o_12_a_session_written_as_a_bare_local_time_is_scheduled_expect_no_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("\"2026-06-01T09:00\"")),
          ends_at: Some(base.body("\"2026-06-01T10:00\"")),
          venue: Some(trial_rules.VenueInput(
            name: Some("F"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (wrong shape).",
      "{\"field\":\"startsAt\"}",
    ))
}

// dates: validateSessionInput — [neg] O #14 a 13-hour session is scheduled — EXPECT NO
pub fn neg_o_14_a_13_hour_session_is_scheduled_expect_no_test() {
  assert result.map_error(
      trial_rules.validate_session(
        trial_rules.SessionInput(
          id: None,
          kind: None,
          starts_at: Some(base.body("1790164800000")),
          ends_at: Some(base.body("1790211600000")),
          venue: Some(trial_rules.VenueInput(
            name: Some("F"),
            town: None,
            address: None,
          )),
          instructions: None,
        ),
        1,
        False,
      ),
      base.trial_refusal,
    )
    == Error(#(
      "TRIAL_SCHEDULE_INVALID",
      "A session is at most 12 hours long.",
      "{}",
    ))
}
