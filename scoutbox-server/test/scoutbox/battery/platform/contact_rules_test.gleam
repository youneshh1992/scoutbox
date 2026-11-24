//// Checks of the rules from the rules suites of platform/dates, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/recruitment/contact_rules
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts
import scoutbox/vocab/party

// dates: validateExternalRecord — L1 control: an integer instant an hour ago
pub fn l1_control_an_integer_instant_an_hour_ago_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("1790161200000")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Ok(contact_rules.External(
      channel: recruitment_contacts.Phone,
      occurred_at: 1_790_161_200_000,
      summary: Some("s"),
    ))
}

// dates: validateExternalRecord — L1b an ISO instant with Z
pub fn l1b_an_iso_instant_with_z_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-09-23T10:00:00Z\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Ok(contact_rules.External(
      channel: recruitment_contacts.Phone,
      occurred_at: 1_790_157_600_000,
      summary: Some("s"),
    ))
}

// dates: validateExternalRecord — L1c an ISO instant with an offset: 06:00 in New York is 10:00Z
pub fn l1c_an_iso_instant_with_an_offset_06_00_in_new_york_is_10_00z_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-09-23T06:00:00-04:00\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Ok(contact_rules.External(
      channel: recruitment_contacts.Phone,
      occurred_at: 1_790_157_600_000,
      summary: Some("s"),
    ))
}

// dates: validateExternalRecord — [neg] L2 a bare local time is refused — it used to mean whatever zone the server ran in
pub fn neg_l2_a_bare_local_time_is_refused_it_used_to_mean_whatever_zone_the_se_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-09-23T10:00\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L2b an ambiguous slash date is refused either way round
pub fn neg_l2b_an_ambiguous_slash_date_is_refused_either_way_round_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"09/22/2026\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L2b an ambiguous slash date is refused either way round
pub fn neg_l2b_an_ambiguous_slash_date_is_refused_either_way_round_2_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"22/09/2026\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L2c a rolled-over day is refused
pub fn neg_l2c_a_rolled_over_day_is_refused_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-02-30T10:00:00Z\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L2d a numeric string and a fraction are refused
pub fn neg_l2d_a_numeric_string_and_a_fraction_are_refused_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"1790161200000\"")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L2d a numeric string and a fraction are refused
pub fn neg_l2d_a_numeric_string_and_a_fraction_are_refused_2_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("1.5")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L3 the reasonableness window is unchanged: not in the future, not older than the evidence limit
pub fn neg_l3_the_reasonableness_window_is_unchanged_not_in_the_future_not_olde_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("1790168400000")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "A contact cannot be recorded before it has happened.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] L3 the reasonableness window is unchanged: not in the future, not older than the evidence limit
pub fn neg_l3_the_reasonableness_window_is_unchanged_not_in_the_future_not_olde_2_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("1774612799999")),
        Some("s"),
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "A contact this old cannot be recorded as recruitment evidence.",
      "{}",
    ))
}

// dates: cooldownFor — [neg] L4 71 hours after delivery: still cooling, retry in an hour
pub fn neg_l4_71_hours_after_delivery_still_cooling_retry_in_an_hour_test() {
  assert contact_rules.cooldown_until(
      [
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            channel: recruitment_contacts.InApp,
            status: recruitment_contacts.Delivered,
            delivered_at: Some(1_789_909_200_000),
          ),
        ),
      ],
      id.org("o"),
      id.player("p"),
      1_790_164_800_000,
      None,
    )
    == Some(1_790_168_400_000)
}

// dates: cooldownFor — L4b exactly 72 hours after: clear (exclusive boundary)
pub fn l4b_exactly_72_hours_after_clear_exclusive_boundary_test() {
  assert contact_rules.cooldown_until(
      [
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            channel: recruitment_contacts.InApp,
            status: recruitment_contacts.Delivered,
            delivered_at: Some(1_789_905_600_000),
          ),
        ),
      ],
      id.org("o"),
      id.player("p"),
      1_790_164_800_000,
      None,
    )
    == None
}

// dates: cooldownFor — L5 an undated delivery null cannot start a cooldown (a rate limit fails OPEN by design: it protects the player, not the club)
pub fn l5_an_undated_delivery_null_cannot_start_a_cooldown_a_rate_limit_fails_o_test() {
  assert contact_rules.cooldown_until(
      [
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            channel: recruitment_contacts.InApp,
            status: recruitment_contacts.Delivered,
            delivered_at: None,
          ),
        ),
      ],
      id.org("o"),
      id.player("p"),
      1_790_164_800_000,
      None,
    )
    == None
}

// dates: cooldownFor — L5 an undated delivery undefined cannot start a cooldown (a rate limit fails OPEN by design: it protects the player, not the club)
pub fn l5_an_undated_delivery_undefined_cannot_start_a_cooldown_a_rate_limit_fa_test() {
  assert contact_rules.cooldown_until(
      [
        contact_rules.Contact(
          ..base.contact(),
          row: recruitment_contacts.Row(
            ..base.contact().row,
            id: id.contact("c1"),
            org_id: id.org("o"),
            player_id: id.player("p"),
            channel: recruitment_contacts.InApp,
            status: recruitment_contacts.Delivered,
          ),
        ),
      ],
      id.org("o"),
      id.player("p"),
      1_790_164_800_000,
      None,
    )
    == None
}

// dates: validateExternalRecord — [neg] O #17 a contact "occurred at" a bare local time is recorded — EXPECT NO
pub fn neg_o_17_a_contact_occurred_at_a_bare_local_time_is_recorded_expect_no_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-09-23T10:00\"")),
        None,
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}

// dates: validateExternalRecord — [neg] O #18 a contact that occurred on 30 February is recorded — EXPECT NO
pub fn neg_o_18_a_contact_that_occurred_on_30_february_is_recorded_expect_no_test() {
  assert result.map_error(
      contact_rules.validate_external(
        Some(base.body("\"phone\"")),
        Some(base.body("\"2026-02-30T10:00:00Z\"")),
        None,
        Some("player"),
        1_790_164_800_000,
        party.Player,
      ),
      base.contact_refusal,
    )
    == Error(#(
      "CONTACT_OCCURRED_AT_INVALID",
      "occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.",
      "{}",
    ))
}
