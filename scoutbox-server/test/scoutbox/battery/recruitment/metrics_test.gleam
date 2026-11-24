//// Checks of the rules from the rules suites of recruitment/analytics, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/recruitment/analytics/metrics

// analytics: assertMetricRegistry — the registry asserts clean at boot (27 metrics, 7 families)
pub fn the_registry_asserts_clean_at_boot_27_metrics_7_families_test() {
  assert #(
      list.length(metrics.metrics),
      list.length(metrics.families),
      metrics.registry_problems(metrics.metrics),
    )
    == #(27, 7, [])
}

// analytics: wire — [neg] N24 — the wire projection drops the internal field declaration and keeps the limitation
pub fn neg_n24_the_wire_projection_drops_the_internal_field_declaration_and_kee_test() {
  assert json.to_string(json.object(metrics.wire("exit_reason_mix")))
    == "{\"id\":\"exit_reason_mix\",\"family\":\"pipeline\",\"name\":\"Why rooms ended\",\"unit\":\"decisions\",\"semantics\":\"window_completion\",\"sources\":[\"roomDecisions\",\"recruitmentCases\"],\"ratio\":true,\"limitation\":\"This is the reason the club recorded, not the reason that operated. A decision carrying codes in two categories counts in both, so the shares add up to more than 100%.\"}"
}

// analytics: ratio — [neg] N37 — a rate over 4 records is withheld and shown as raw counts
pub fn neg_n37_a_rate_over_4_records_is_withheld_and_shown_as_raw_counts_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(0, 0)))
    == "{\"n\":0,\"numerator\":0,\"value\":null,\"empty\":true,\"suppressed\":false}"
}

// analytics: ratio — [neg] N37 — a rate over 4 records is withheld and shown as raw counts
pub fn neg_n37_a_rate_over_4_records_is_withheld_and_shown_as_raw_counts_2_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(0, 12)))
    == "{\"n\":12,\"numerator\":0,\"value\":0,\"empty\":false,\"suppressed\":false}"
}

// analytics: ratio — [neg] N37 — a rate over 4 records is withheld and shown as raw counts
pub fn neg_n37_a_rate_over_4_records_is_withheld_and_shown_as_raw_counts_3_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(1, 4)))
    == "{\"n\":4,\"numerator\":1,\"value\":null,\"empty\":false,\"suppressed\":true,\"minimum\":5}"
}

// analytics: ratio — [neg] N37 — a rate over 4 records is withheld and shown as raw counts
pub fn neg_n37_a_rate_over_4_records_is_withheld_and_shown_as_raw_counts_4_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(3, 10)))
    == "{\"n\":10,\"numerator\":3,\"value\":0.3,\"empty\":false,\"suppressed\":false}"
}

// analytics: ratio — P6 — …and a rate over exactly 5 is shown (the boundary is inclusive)
pub fn p6_and_a_rate_over_exactly_5_is_shown_the_boundary_is_inclusive_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(3, 5)))
    == "{\"n\":5,\"numerator\":3,\"value\":0.6,\"empty\":false,\"suppressed\":false}"
}

// analytics: ratio — [neg] N38 — the suppression boundary bites on one side only
pub fn neg_n38_the_suppression_boundary_bites_on_one_side_only_test() {
  assert json.to_string(metrics.ratio_json(metrics.ratio(3, 4)))
    == "{\"n\":4,\"numerator\":3,\"value\":null,\"empty\":false,\"suppressed\":true,\"minimum\":5}"
}

// analytics: distribution — [neg] N40 — a median over 4 observations is withheld
pub fn neg_n40_a_median_over_4_observations_is_withheld_test() {
  assert json.to_string(
      metrics.distribution_json(metrics.distribution([1.0, 2.0, 3.0, 4.0], 0)),
    )
    == "{\"n\":4,\"median\":null,\"p25\":null,\"p75\":null,\"empty\":false,\"suppressed\":true,\"minimum\":5,\"excluded\":0}"
}

// analytics: distribution — [neg] N40 — a median over 4 observations is withheld
pub fn neg_n40_a_median_over_4_observations_is_withheld_2_test() {
  assert json.to_string(
      metrics.distribution_json(metrics.distribution(
        [1.0, 2.0, 3.0, 4.0, 5.0],
        0,
      )),
    )
    == "{\"n\":5,\"median\":3,\"p25\":2,\"p75\":4,\"min\":1,\"max\":5,\"empty\":false,\"suppressed\":false,\"excluded\":0}"
}

// analytics: distribution — [neg] N41 — a duration carries the count it could not include, so the exclusion cannot hide
pub fn neg_n41_a_duration_carries_the_count_it_could_not_include_so_the_exclusi_test() {
  assert json.to_string(
      metrics.distribution_json(metrics.distribution(
        [1.0, 2.0, 3.0, 4.0, 5.0],
        40,
      )),
    )
    == "{\"n\":5,\"median\":3,\"p25\":2,\"p75\":4,\"min\":1,\"max\":5,\"empty\":false,\"suppressed\":false,\"excluded\":40}"
}

// analytics: distribution — [neg] N42 — one extreme record does not move the reported figure — these are medians, never means
pub fn neg_n42_one_extreme_record_does_not_move_the_reported_figure_these_are_m_test() {
  assert json.to_string(
      metrics.distribution_json(metrics.distribution(
        [1.0, 2.0, 3.0, 4.0, 5.0, 600.0],
        0,
      )),
    )
    == "{\"n\":6,\"median\":3.5,\"p25\":2.25,\"p75\":4.75,\"min\":1,\"max\":600,\"empty\":false,\"suppressed\":false,\"excluded\":0}"
}

// analytics: count — [neg] N43 — a count is never suppressed — a director may always see their own three rooms
pub fn neg_n43_a_count_is_never_suppressed_a_director_may_always_see_their_own_test() {
  assert json.to_string(metrics.count_json(2))
    == "{\"n\":2,\"value\":2,\"empty\":false,\"suppressed\":false}"
}

// analytics: count — [neg] N43 — a count is never suppressed — a director may always see their own three rooms
pub fn neg_n43_a_count_is_never_suppressed_a_director_may_always_see_their_own_2_test() {
  assert json.to_string(metrics.count_json(0))
    == "{\"n\":0,\"value\":0,\"empty\":false,\"suppressed\":false}"
}

// analytics: resolveWindow — a preset window ends today and spans its own length
pub fn a_preset_window_ends_today_and_spans_its_own_length_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("last_30_days"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"last_30_days\",\"from\":\"2026-05-17\",\"to\":\"2026-06-15\",\"days\":30}"
}

// analytics: utcDay — a preset window ends today and spans its own length
pub fn a_preset_window_ends_today_and_spans_its_own_length_2_test() {
  assert metrics.utc_day(1_781_524_800_000) == "2026-06-15"
}

// analytics: inWindow — both boundary days are inside the window
pub fn both_boundary_days_are_inside_the_window_test() {
  assert metrics.in_window(
      1_781_524_800_000,
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
    )
    == True
}

// analytics: inWindow — both boundary days are inside the window
pub fn both_boundary_days_are_inside_the_window_2_test() {
  assert metrics.in_window(
      1_778_976_000_000,
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
    )
    == True
}

// analytics: inWindow — both boundary days are inside the window
pub fn both_boundary_days_are_inside_the_window_3_test() {
  assert metrics.in_window(
      1_781_567_999_000,
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
    )
    == True
}

// analytics: inWindow — [neg] N51 — the instant before the first day is outside
pub fn neg_n51_the_instant_before_the_first_day_is_outside_test() {
  assert metrics.in_window(
      1_778_975_999_999,
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
    )
    == False
}

// analytics: inWindow — [neg] N52 — and the instant after the last day is outside
pub fn neg_n52_and_the_instant_after_the_last_day_is_outside_test() {
  assert metrics.in_window(
      1_781_568_000_000,
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
    )
    == False
}

// analytics: resolveWindow — [neg] N47 — an unknown preset is refused, not widened
pub fn neg_n47_an_unknown_preset_is_refused_not_widened_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("forever"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_UNKNOWN\",\"detail\":\"Unknown window \\\"forever\\\".\",\"allowed\":[\"last_7_days\",\"last_30_days\",\"last_90_days\",\"last_180_days\",\"last_365_days\"]}"
}

// analytics: resolveWindow — [neg] N48 — a reversed range is refused
pub fn neg_n48_a_reversed_range_is_refused_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        None,
        Some("2026-03-05"),
        Some("2026-03-01"),
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_INVALID\",\"detail\":\"from must not be after to.\"}"
}

// analytics: resolveWindow — [neg] N49 — a malformed day is refused, never parsed loosely
pub fn neg_n49_a_malformed_day_is_refused_never_parsed_loosely_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        None,
        Some("5 March"),
        Some("2026-03-09"),
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_INVALID\",\"detail\":\"from and to must both be calendar days as YYYY-MM-DD.\"}"
}

// analytics: resolveWindow — [neg] N50 — a window starting in the future is refused
pub fn neg_n50_a_window_starting_in_the_future_is_refused_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        None,
        Some("2099-01-01"),
        Some("2099-01-02"),
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_INVALID\",\"detail\":\"from must not be in the future.\"}"
}

// analytics: resolveWindow — a custom range counts both end days
pub fn a_custom_range_counts_both_end_days_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        None,
        Some("2026-03-01"),
        Some("2026-03-31"),
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"custom\",\"from\":\"2026-03-01\",\"to\":\"2026-03-31\",\"days\":31}"
}

// analytics: cohortIncomplete — a 30-day window is flagged incomplete against a 120-day typical journey
pub fn a_30_day_window_is_flagged_incomplete_against_a_120_day_typical_journey_test() {
  assert metrics.cohort_incomplete(
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
      Some(120.0),
      1_781_524_800_000,
    )
    == True
}

// analytics: cohortIncomplete — …and is not flagged when the journey is short
pub fn and_is_not_flagged_when_the_journey_is_short_test() {
  assert metrics.cohort_incomplete(
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
      Some(5.0),
      1_781_524_800_000,
    )
    == False
}

// analytics: cohortIncomplete — with no typical journey known, nothing is claimed
pub fn with_no_typical_journey_known_nothing_is_claimed_test() {
  assert metrics.cohort_incomplete(
      metrics.Window(
        preset: "last_30_days",
        from: base.day("2026-05-17"),
        to: base.day("2026-06-15"),
        days: 30,
      ),
      None,
      1_781_524_800_000,
    )
    == False
}

// analytics: resolveWindow — last_7_days resolves to 7 days
pub fn last_7_days_resolves_to_7_days_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("last_7_days"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"last_7_days\",\"from\":\"2026-06-09\",\"to\":\"2026-06-15\",\"days\":7}"
}

// analytics: resolveWindow — last_90_days resolves to 90 days
pub fn last_90_days_resolves_to_90_days_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("last_90_days"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"last_90_days\",\"from\":\"2026-03-18\",\"to\":\"2026-06-15\",\"days\":90}"
}

// analytics: resolveWindow — last_180_days resolves to 180 days
pub fn last_180_days_resolves_to_180_days_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("last_180_days"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"last_180_days\",\"from\":\"2025-12-18\",\"to\":\"2026-06-15\",\"days\":180}"
}

// analytics: resolveWindow — last_365_days resolves to 365 days
pub fn last_365_days_resolves_to_365_days_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("last_365_days"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"preset\":\"last_365_days\",\"from\":\"2025-06-16\",\"to\":\"2026-06-15\",\"days\":365}"
}

// analytics: resolveWindow — [neg] an inherited key "constructor" is not a window preset
pub fn neg_an_inherited_key_constructor_is_not_a_window_preset_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("constructor"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_UNKNOWN\",\"detail\":\"Unknown window \\\"constructor\\\".\",\"allowed\":[\"last_7_days\",\"last_30_days\",\"last_90_days\",\"last_180_days\",\"last_365_days\"]}"
}

// analytics: resolveWindow — [neg] an inherited key "__proto__" is not a window preset
pub fn neg_an_inherited_key_proto_is_not_a_window_preset_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("__proto__"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_UNKNOWN\",\"detail\":\"Unknown window \\\"__proto__\\\".\",\"allowed\":[\"last_7_days\",\"last_30_days\",\"last_90_days\",\"last_180_days\",\"last_365_days\"]}"
}

// analytics: resolveWindow — [neg] an inherited key "toString" is not a window preset
pub fn neg_an_inherited_key_tostring_is_not_a_window_preset_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("toString"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_UNKNOWN\",\"detail\":\"Unknown window \\\"toString\\\".\",\"allowed\":[\"last_7_days\",\"last_30_days\",\"last_90_days\",\"last_180_days\",\"last_365_days\"]}"
}

// analytics: resolveWindow — [neg] an inherited key "hasOwnProperty" is not a window preset
pub fn neg_an_inherited_key_hasownproperty_is_not_a_window_preset_test() {
  assert json.to_string(
      metrics.resolution_json(metrics.resolve_window(
        Some("hasOwnProperty"),
        None,
        None,
        1_781_524_800_000,
      )),
    )
    == "{\"error\":\"WINDOW_UNKNOWN\",\"detail\":\"Unknown window \\\"hasOwnProperty\\\".\",\"allowed\":[\"last_7_days\",\"last_30_days\",\"last_90_days\",\"last_180_days\",\"last_365_days\"]}"
}

// analytics: previousWindow — the comparison period is the same LENGTH as the window
pub fn the_comparison_period_is_the_same_length_as_the_window_test() {
  assert json.to_string(
      metrics.window_json(
        metrics.previous_window(metrics.Window(
          preset: "last_30_days",
          from: base.day("2026-05-17"),
          to: base.day("2026-06-15"),
          days: 30,
        )),
      ),
    )
    == "{\"preset\":\"previous\",\"from\":\"2026-04-17\",\"to\":\"2026-05-16\",\"days\":30}"
}

// analytics: compare — [neg] N25 — a rise from a previous period of zero has NO percentage — it reports the absolute change and says "from none"
pub fn neg_n25_a_rise_from_a_previous_period_of_zero_has_no_percentage_it_repor_test() {
  assert json.to_string(metrics.comparison_json(metrics.compare(3, 0)))
    == "{\"current\":3,\"previous\":0,\"change\":3,\"percentChange\":null,\"upFromZero\":true,\"unchangedAtZero\":false}"
}

// analytics: compare — nothing, compared with nothing, is not a 0% change
pub fn nothing_compared_with_nothing_is_not_a_0_change_test() {
  assert json.to_string(metrics.comparison_json(metrics.compare(0, 0)))
    == "{\"current\":0,\"previous\":0,\"change\":0,\"percentChange\":null,\"upFromZero\":false,\"unchangedAtZero\":true}"
}

// analytics: compare — an ordinary comparison is a plain fraction
pub fn an_ordinary_comparison_is_a_plain_fraction_test() {
  assert json.to_string(metrics.comparison_json(metrics.compare(6, 4)))
    == "{\"current\":6,\"previous\":4,\"change\":2,\"percentChange\":0.5,\"upFromZero\":false,\"unchangedAtZero\":false}"
}

// analytics: compare — a fall is reported as a fall, not an absolute value
pub fn a_fall_is_reported_as_a_fall_not_an_absolute_value_test() {
  assert json.to_string(metrics.comparison_json(metrics.compare(2, 8)))
    == "{\"current\":2,\"previous\":8,\"change\":-6,\"percentChange\":-0.75,\"upFromZero\":false,\"unchangedAtZero\":false}"
}
