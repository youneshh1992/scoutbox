//// Checks of the rules from the rules suites of discovery/matchingAndWatchlists, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/discovery/matching/criteria

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_test() {
  assert criteria.is_prohibited("position") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_2_test() {
  assert criteria.is_prohibited("age") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_3_test() {
  assert criteria.is_prohibited("geography") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_4_test() {
  assert criteria.is_prohibited("level") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_5_test() {
  assert criteria.is_prohibited("foot") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_6_test() {
  assert criteria.is_prohibited("availability") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_7_test() {
  assert criteria.is_prohibited("evidence") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_8_test() {
  assert criteria.is_prohibited("evidence_recency") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_9_test() {
  assert criteria.is_prohibited("trust_band") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_10_test() {
  assert criteria.is_prohibited("combine_result") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A2 — no criterion type names a protected characteristic
pub fn neg_a2_no_criterion_type_names_a_protected_characteristic_11_test() {
  assert criteria.is_prohibited("combine_measurement") == False
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_test() {
  assert criteria.is_prohibited("race") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_2_test() {
  assert criteria.is_prohibited("ethnicity") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_3_test() {
  assert criteria.is_prohibited("skin_colour") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_4_test() {
  assert criteria.is_prohibited("skin_color") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_5_test() {
  assert criteria.is_prohibited("religion") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_6_test() {
  assert criteria.is_prohibited("faith") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_7_test() {
  assert criteria.is_prohibited("caste") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_8_test() {
  assert criteria.is_prohibited("disability") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_9_test() {
  assert criteria.is_prohibited("medical_condition") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_10_test() {
  assert criteria.is_prohibited("mental_health") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_11_test() {
  assert criteria.is_prohibited("gender_identity") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_12_test() {
  assert criteria.is_prohibited("sexuality") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_13_test() {
  assert criteria.is_prohibited("sexual_orientation") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_14_test() {
  assert criteria.is_prohibited("socioeconomic") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_15_test() {
  assert criteria.is_prohibited("social_background") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_16_test() {
  assert criteria.is_prohibited("family_income") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_17_test() {
  assert criteria.is_prohibited("school_type") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_18_test() {
  assert criteria.is_prohibited("postcode_deprivation") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_19_test() {
  assert criteria.is_prohibited("deprivation") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_20_test() {
  assert criteria.is_prohibited("maturity") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_21_test() {
  assert criteria.is_prohibited("biological_age") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_22_test() {
  assert criteria.is_prohibited("physical_maturity") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_23_test() {
  assert criteria.is_prohibited("immigration_status") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A3 — every protected field a Recruitment Brief refuses, matching refuses too
pub fn neg_a3_every_protected_field_a_recruitment_brief_refuses_matching_refuse_24_test() {
  assert criteria.is_prohibited("national_origin") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A4 — a protected trait is caught whatever the spelling, casing or separator
pub fn neg_a4_a_protected_trait_is_caught_whatever_the_spelling_casing_or_separ_test() {
  assert criteria.is_prohibited("player_ethnicity") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A4 — a protected trait is caught whatever the spelling, casing or separator
pub fn neg_a4_a_protected_trait_is_caught_whatever_the_spelling_casing_or_separ_2_test() {
  assert criteria.is_prohibited("Family-Income") == True
}

// matchingAndWatchlists: isProhibitedCriterion — [neg] A4 — a protected trait is caught whatever the spelling, casing or separator
pub fn neg_a4_a_protected_trait_is_caught_whatever_the_spelling_casing_or_separ_3_test() {
  assert criteria.is_prohibited("SCHOOL TYPE") == True
}

// matchingAndWatchlists: validateCriteria — [neg] A5 — a criterion type ScoutBox cannot evaluate is refused, not ignored
pub fn neg_a5_a_criterion_type_scoutbox_cannot_evaluate_is_refused_not_ignored_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("iq"),
            operator: Some("gte"),
            value: Some(criteria.Number(120.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"iq\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A6 — an operator outside the table is refused — no client-supplied evaluator
pub fn neg_a6_an_operator_outside_the_table_is_refused_no_client_supplied_evalu_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("regex"),
            value: Some(criteria.Text(".*")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"age\",\"error\":\"CRITERION_OPERATOR_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A7 — a real operator applied to a type that does not support it is refused
pub fn neg_a7_a_real_operator_applied_to_a_type_that_does_not_support_it_is_ref_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("in"),
            values: Some([criteria.Number(17.0)]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"age\",\"error\":\"CRITERION_OPERATOR_NOT_SUPPORTED\",\"supported\":[\"between\",\"gte\",\"lte\"]}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A8 — an empty position list is refused rather than treated as "any position"
pub fn neg_a8_an_empty_position_list_is_refused_rather_than_treated_as_any_posi_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"position\",\"error\":\"CRITERION_VALUES_REQUIRED\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A9 — a position outside the taxonomy is refused (DM is not CDM)
pub fn neg_a9_a_position_outside_the_taxonomy_is_refused_dm_is_not_cdm_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("DM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"position\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A10 — an age range that starts after it ends is refused, not quietly swapped
pub fn neg_a10_an_age_range_that_starts_after_it_ends_is_refused_not_quietly_sw_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("between"),
            values: Some([criteria.Number(22.0), criteria.Number(16.0)]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"age\",\"error\":\"CRITERION_RANGE_INVALID\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — an age below the platform floor is refused
pub fn neg_a11_an_age_below_the_platform_floor_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(3.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"age\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A12 — an absurd age ceiling is refused
pub fn neg_a12_an_absurd_age_ceiling_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("lte"),
            value: Some(criteria.Number(900.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"age\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A13 — a negative radius is refused, not clamped into something the club did not ask for
pub fn neg_a13_a_negative_radius_is_refused_not_clamped_into_something_the_club_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(-50.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"geography\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A14 — a zero radius is refused rather than matching nobody in silence
pub fn neg_a14_a_zero_radius_is_refused_rather_than_matching_nobody_in_silence_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(0.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"geography\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A15 — a radius larger than the planet is refused
pub fn neg_a15_a_radius_larger_than_the_planet_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(99_999.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"geography\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A16 — a recency window of zero days is refused
pub fn neg_a16_a_recency_window_of_zero_days_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(0.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"evidence_recency\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A17 — an evidence kind ScoutBox does not hold is refused
pub fn neg_a17_an_evidence_kind_scoutbox_does_not_hold_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(30.0)),
            evidence_kind: Some("telepathy"),
            values: None,
            primary_only: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"evidence_recency\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A18 — an invented evidence-confidence band is refused
pub fn neg_a18_an_invented_evidence_confidence_band_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("trust_band"),
            operator: Some("gte"),
            value: Some(criteria.Text("excellent")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"trust_band\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A19 — an evidence requirement ScoutBox does not record is refused
pub fn neg_a19_an_evidence_requirement_scoutbox_does_not_record_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence"),
            operator: Some("exists"),
            value: Some(criteria.Text("vibes")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"evidence\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A20 — a Combine protocol that does not exist is refused
pub fn neg_a20_a_combine_protocol_that_does_not_exist_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_result"),
            operator: Some("exists"),
            value: Some(criteria.Text("combine-made-up")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"combine_result\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A21 — a Combine threshold with no protocol is refused — a number about nothing
pub fn neg_a21_a_combine_threshold_with_no_protocol_is_refused_a_number_about_n_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("gte"),
            protocol: Some(""),
            value: Some(criteria.Number(10.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"combine_measurement\",\"error\":\"CRITERION_VALUES_REQUIRED\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A22 — a non-numeric Combine threshold is refused
pub fn neg_a22_a_non_numeric_combine_threshold_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("gte"),
            protocol: Some("combine-box-touch-60"),
            value: Some(criteria.Text("many")),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"combine_measurement\",\"error\":\"CRITERION_VALUE_OUT_OF_RANGE\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A23 — a foot that is not a foot is refused
pub fn neg_a23_a_foot_that_is_not_a_foot_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Sideways")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"foot\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A24 — a level outside the platform taxonomy is refused
pub fn neg_a24_a_level_outside_the_platform_taxonomy_is_refused_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("level"),
            operator: Some("in"),
            values: Some([criteria.Text("elite")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"level\",\"error\":\"CRITERION_VALUE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A25 — a protected characteristic is refused with its OWN code, before any other validation
pub fn neg_a25_a_protected_characteristic_is_refused_with_its_own_code_before_a_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("ethnicity"),
            operator: Some("in"),
            values: Some([criteria.Text("x")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERION_PROHIBITED\",\"prohibited\":[\"ethnicity\"],\"message\":\"Players can never be matched on a protected characteristic.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A26 — a protected characteristic is refused in the preferred class too — it is not a "soft" preference
pub fn neg_a26_a_protected_characteristic_is_refused_in_the_preferred_class_too_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [],
        [
          criteria.Raw(
            type_: Some("religion"),
            operator: Some("equals"),
            value: Some(criteria.Text("x")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERION_PROHIBITED\",\"prohibited\":[\"religion\"],\"message\":\"Players can never be matched on a protected characteristic.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A27 — a criteria set beyond the cap is refused rather than evaluated 30 times per candidate
pub fn neg_a27_a_criteria_set_beyond_the_cap_is_refused_rather_than_evaluated_3_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([
              criteria.Text("GK"),
              criteria.Text("CB"),
              criteria.Text("RB"),
              criteria.Text("LB"),
              criteria.Text("RWB"),
              criteria.Text("LWB"),
              criteria.Text("CDM"),
              criteria.Text("CM"),
              criteria.Text("CAM"),
              criteria.Text("RW"),
              criteria.Text("LW"),
              criteria.Text("ST"),
              criteria.Text("CF"),
            ]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_TOO_MANY\",\"limit\":24,\"message\":\"A criteria set may hold at most 24 criteria.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A28 — duplicate positions collapse instead of inflating the value count past its limit
pub fn neg_a28_duplicate_positions_collapse_instead_of_inflating_the_value_coun_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([
              criteria.Text("GK"),
              criteria.Text("CB"),
              criteria.Text("RB"),
              criteria.Text("LB"),
              criteria.Text("RWB"),
              criteria.Text("LWB"),
              criteria.Text("CDM"),
              criteria.Text("CM"),
              criteria.Text("CAM"),
              criteria.Text("RW"),
              criteria.Text("LW"),
              criteria.Text("ST"),
              criteria.Text("CF"),
              criteria.Text("GK"),
              criteria.Text("CB"),
            ]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CAM|CB|CDM|CF|CM|GK|LB|LW|LWB|RB|RW|RWB|ST\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"GK\",\"CB\",\"RB\",\"LB\",\"RWB\",\"LWB\",\"CDM\",\"CM\",\"CAM\",\"RW\",\"LW\",\"ST\",\"CF\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A29 — the same test written twice is one test, so it cannot double-count
pub fn neg_a29_the_same_test_written_twice_is_one_test_so_it_cannot_double_coun_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A30 — every offending row is named by index and class, so the editor can point at it
pub fn neg_a30_every_offending_row_is_named_by_index_and_class_so_the_editor_ca_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("iq"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("nope"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"iq\",\"error\":\"CRITERION_TYPE_UNKNOWN\"},{\"index\":1,\"class\":\"required\",\"type\":\"nope\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A31 — a criteria body of the wrong shape yields no criteria rather than throwing
pub fn neg_a31_a_criteria_body_of_the_wrong_shape_yields_no_criteria_rather_tha_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A31 — a criteria body of the wrong shape yields no criteria rather than throwing
pub fn neg_a31_a_criteria_body_of_the_wrong_shape_yields_no_criteria_rather_tha_2_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [],
        [],
        criteria.Context(
          grassroots: False,
          protocols: Some(["combine-box-touch-60"]),
        ),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A32 — a grassroots club asking for 500 km gets the platform ceiling, not its own number
pub fn neg_a32_a_grassroots_club_asking_for_500_km_gets_the_platform_ceiling_no_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(500.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: True, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"geography:within_radius:value=50\",\"type\":\"geography\",\"operator\":\"within_radius\",\"class\":\"required\",\"value\":50}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A33 — a grassroots club cannot write itself a professional-level criterion
pub fn neg_a33_a_grassroots_club_cannot_write_itself_a_professional_level_crite_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("level"),
            operator: Some("lte"),
            value: Some(criteria.Text("pro")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: True, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"level:lte:value=semi_pro\",\"type\":\"level\",\"operator\":\"lte\",\"class\":\"required\",\"value\":\"semi_pro\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: criterionId — the same test written in a different order is the same criterion id
pub fn the_same_test_written_in_a_different_order_is_the_same_criterion_id_test() {
  assert criteria.criterion_id(criteria.PositionIn(["CDM", "CM"], False))
    == "position:in:primaryOnly=false,values=CDM|CM"
}

// matchingAndWatchlists: criterionId — the same test written in a different order is the same criterion id
pub fn the_same_test_written_in_a_different_order_is_the_same_criterion_id_2_test() {
  assert criteria.criterion_id(criteria.PositionIn(["CM", "CDM"], False))
    == "position:in:primaryOnly=false,values=CDM|CM"
}

// matchingAndWatchlists: validateCriteria — criteria order does not change the version — a re-save is not a change
pub fn criteria_order_does_not_change_the_version_a_re_save_is_not_a_change_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16},{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — criteria order does not change the version — a re-save is not a change
pub fn criteria_order_does_not_change_the_version_a_re_save_is_not_a_change_2_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false},{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: criteriaVersion — criteria order does not change the version — a re-save is not a change
pub fn criteria_order_does_not_change_the_version_a_re_save_is_not_a_change_3_test() {
  assert criteria.version(
      criteria.Criteria(
        required: [
          criteria.Criterion(
            id: "age:gte:value=16",
            class: criteria.Required,
            check: criteria.Age(criteria.AtLeast(16)),
          ),
          criteria.Criterion(
            id: "position:in:primaryOnly=false,values=CDM",
            class: criteria.Required,
            check: criteria.PositionIn(["CDM"], False),
          ),
        ],
        preferred: [],
      ),
    )
    == "cv1:3a4077d4"
}

// matchingAndWatchlists: criteriaVersion — criteria order does not change the version — a re-save is not a change
pub fn criteria_order_does_not_change_the_version_a_re_save_is_not_a_change_4_test() {
  assert criteria.version(
      criteria.Criteria(
        required: [
          criteria.Criterion(
            id: "position:in:primaryOnly=false,values=CDM",
            class: criteria.Required,
            check: criteria.PositionIn(["CDM"], False),
          ),
          criteria.Criterion(
            id: "age:gte:value=16",
            class: criteria.Required,
            check: criteria.Age(criteria.AtLeast(16)),
          ),
        ],
        preferred: [],
      ),
    )
    == "cv1:3a4077d4"
}

// matchingAndWatchlists: validateCriteria — [neg] a real change to a criterion DOES change the version
pub fn neg_a_real_change_to_a_criterion_does_change_the_version_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(17.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=17\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":17},{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: criteriaVersion — [neg] a real change to a criterion DOES change the version
pub fn neg_a_real_change_to_a_criterion_does_change_the_version_2_test() {
  assert criteria.version(
      criteria.Criteria(
        required: [
          criteria.Criterion(
            id: "age:gte:value=17",
            class: criteria.Required,
            check: criteria.Age(criteria.AtLeast(17)),
          ),
          criteria.Criterion(
            id: "position:in:primaryOnly=false,values=CDM",
            class: criteria.Required,
            check: criteria.PositionIn(["CDM"], False),
          ),
        ],
        preferred: [],
      ),
    )
    == "cv1:60c14a3b"
}

// matchingAndWatchlists: validateCriteria — [neg] moving a criterion into the preferred class changes the version
pub fn neg_moving_a_criterion_into_the_preferred_class_changes_the_version_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] moving a criterion into the preferred class changes the version
pub fn neg_moving_a_criterion_into_the_preferred_class_changes_the_version_2_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Left")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16}],\"preferred\":[{\"id\":\"foot:in:values=Left\",\"type\":\"foot\",\"operator\":\"in\",\"class\":\"preferred\",\"values\":[\"Left\"]}],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: criteriaVersion — [neg] moving a criterion into the preferred class changes the version
pub fn neg_moving_a_criterion_into_the_preferred_class_changes_the_version_3_test() {
  assert criteria.version(
      criteria.Criteria(
        required: [
          criteria.Criterion(
            id: "age:gte:value=16",
            class: criteria.Required,
            check: criteria.Age(criteria.AtLeast(16)),
          ),
        ],
        preferred: [],
      ),
    )
    == "cv1:d3f9fcea"
}

// matchingAndWatchlists: criteriaVersion — [neg] moving a criterion into the preferred class changes the version
pub fn neg_moving_a_criterion_into_the_preferred_class_changes_the_version_4_test() {
  assert criteria.version(
      criteria.Criteria(
        required: [
          criteria.Criterion(
            id: "age:gte:value=16",
            class: criteria.Required,
            check: criteria.Age(criteria.AtLeast(16)),
          ),
        ],
        preferred: [
          criteria.Criterion(
            id: "foot:in:values=Left",
            class: criteria.Preferred,
            check: criteria.FootIn(["Left"]),
          ),
        ],
      ),
    )
    == "cv1:0baac089"
}

// matchingAndWatchlists: describeCriteria — describeCriteria renders both classes separately
pub fn describecriteria_renders_both_classes_separately_test() {
  assert json.to_string(
      criteria.describe(
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CDM",
              class: criteria.Required,
              check: criteria.PositionIn(["CDM"], False),
            ),
            criteria.Criterion(
              id: "age:gte:value=16",
              class: criteria.Required,
              check: criteria.Age(criteria.AtLeast(16)),
            ),
          ],
          preferred: [],
        ),
      ),
    )
    == "{\"required\":[\"CDM\",\"age ≥ 16\"],\"preferred\":[]}"
}

// matchingAndWatchlists: validateCriteria — a primary position matches
pub fn a_primary_position_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a secondary position matches by default
pub fn a_secondary_position_matches_by_default_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CM\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] primaryOnly excludes a secondary position
pub fn neg_primaryonly_excludes_a_secondary_position_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CM")]),
            primary_only: Some(True),
            value: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=true,values=CM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CM\"],\"primaryOnly\":true}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] a position the player does not play does not match
pub fn neg_a_position_the_player_does_not_play_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("GK")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=GK\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"GK\"],\"primaryOnly\":false}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — an age inside the range matches
pub fn an_age_inside_the_range_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("between"),
            values: Some([criteria.Number(16.0), criteria.Number(18.0)]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:between:values=16|18\",\"type\":\"age\",\"operator\":\"between\",\"class\":\"required\",\"values\":[16,18]}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] an age below the range does not match
pub fn neg_an_age_below_the_range_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("between"),
            values: Some([criteria.Number(18.0), criteria.Number(20.0)]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:between:values=18|20\",\"type\":\"age\",\"operator\":\"between\",\"class\":\"required\",\"values\":[18,20]}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a player inside the radius matches
pub fn a_player_inside_the_radius_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(20.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: True, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"geography:within_radius:value=20\",\"type\":\"geography\",\"operator\":\"within_radius\",\"class\":\"required\",\"value\":20}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] a player outside the radius does not match
pub fn neg_a_player_outside_the_radius_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(5.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: True, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"geography:within_radius:value=5\",\"type\":\"geography\",\"operator\":\"within_radius\",\"class\":\"required\",\"value\":5}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — the foot criterion matches the stored fact whatever its casing
pub fn the_foot_criterion_matches_the_stored_fact_whatever_its_casing_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Right")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"foot:in:values=Right\",\"type\":\"foot\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"Right\"]}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] the wrong foot does not match
pub fn neg_the_wrong_foot_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Left")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"foot:in:values=Left\",\"type\":\"foot\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"Left\"]}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — availability matches exactly
pub fn availability_matches_exactly_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("availability"),
            operator: Some("equals"),
            value: Some(criteria.Text("available_now")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"availability:equals:value=available_now\",\"type\":\"availability\",\"operator\":\"equals\",\"class\":\"required\",\"value\":\"available_now\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a recorded evidence flag matches
pub fn a_recorded_evidence_flag_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence"),
            operator: Some("exists"),
            value: Some(criteria.Text("recent_full_match")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence:exists:value=recent_full_match\",\"type\":\"evidence\",\"operator\":\"exists\",\"class\":\"required\",\"value\":\"recent_full_match\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] an absent evidence flag does not match
pub fn neg_an_absent_evidence_flag_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence"),
            operator: Some("exists"),
            value: Some(criteria.Text("confirmed_current_club")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence:exists:value=confirmed_current_club\",\"type\":\"evidence\",\"operator\":\"exists\",\"class\":\"required\",\"value\":\"confirmed_current_club\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — footage inside the window matches
pub fn footage_inside_the_window_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(30.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence_recency:within_days:evidenceKind=footage,value=30\",\"type\":\"evidence_recency\",\"operator\":\"within_days\",\"class\":\"required\",\"value\":30,\"evidenceKind\":\"footage\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] footage older than the window does not match
pub fn neg_footage_older_than_the_window_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(10.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence_recency:within_days:evidenceKind=footage,value=10\",\"type\":\"evidence_recency\",\"operator\":\"within_days\",\"class\":\"required\",\"value\":10,\"evidenceKind\":\"footage\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — "any" evidence reads the broader clock
pub fn any_evidence_reads_the_broader_clock_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(15.0)),
            evidence_kind: Some("any"),
            values: None,
            primary_only: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence_recency:within_days:evidenceKind=any,value=15\",\"type\":\"evidence_recency\",\"operator\":\"within_days\",\"class\":\"required\",\"value\":15,\"evidenceKind\":\"any\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a higher evidence band satisfies a lower floor
pub fn a_higher_evidence_band_satisfies_a_lower_floor_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("trust_band"),
            operator: Some("gte"),
            value: Some(criteria.Text("established_evidence")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"trust_band:gte:value=established_evidence\",\"type\":\"trust_band\",\"operator\":\"gte\",\"class\":\"required\",\"value\":\"established_evidence\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] a lower band does not satisfy a higher floor
pub fn neg_a_lower_band_does_not_satisfy_a_higher_floor_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("trust_band"),
            operator: Some("gte"),
            value: Some(criteria.Text("very_strong_evidence")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"trust_band:gte:value=very_strong_evidence\",\"type\":\"trust_band\",\"operator\":\"gte\",\"class\":\"required\",\"value\":\"very_strong_evidence\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a production Combine result matches
pub fn a_production_combine_result_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_result"),
            operator: Some("exists"),
            value: Some(criteria.Text("combine-box-touch-60")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"combine_result:exists:value=combine-box-touch-60\",\"type\":\"combine_result\",\"operator\":\"exists\",\"class\":\"required\",\"value\":\"combine-box-touch-60\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a Combine measurement above the threshold matches
pub fn a_combine_measurement_above_the_threshold_matches_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("gte"),
            protocol: Some("combine-box-touch-60"),
            value: Some(criteria.Number(150.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=150\",\"type\":\"combine_measurement\",\"operator\":\"gte\",\"class\":\"required\",\"protocol\":\"combine-box-touch-60\",\"value\":150}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] a Combine measurement below the threshold does not match
pub fn neg_a_combine_measurement_below_the_threshold_does_not_match_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("gte"),
            protocol: Some("combine-box-touch-60"),
            value: Some(criteria.Number(200.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=200\",\"type\":\"combine_measurement\",\"operator\":\"gte\",\"class\":\"required\",\"protocol\":\"combine-box-touch-60\",\"value\":200}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — a "at most" threshold is evaluated the other way round
pub fn a_at_most_threshold_is_evaluated_the_other_way_round_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("lte"),
            protocol: Some("combine-box-touch-60"),
            value: Some(criteria.Number(200.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"combine_measurement:lte:protocol=combine-box-touch-60,value=200\",\"type\":\"combine_measurement\",\"operator\":\"lte\",\"class\":\"required\",\"protocol\":\"combine-box-touch-60\",\"value\":200}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A36 — a player with no geography fact does not satisfy a geography criterion
pub fn neg_a36_a_player_with_no_geography_fact_does_not_satisfy_a_geography_cri_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("geography"),
            operator: Some("within_radius"),
            value: Some(criteria.Number(500.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: True, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"geography:within_radius:value=50\",\"type\":\"geography\",\"operator\":\"within_radius\",\"class\":\"required\",\"value\":50}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A36 — a player with no level fact does not satisfy a level criterion
pub fn neg_a36_a_player_with_no_level_fact_does_not_satisfy_a_level_criterion_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("level"),
            operator: Some("in"),
            values: Some([criteria.Text("amateur")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"level:in:values=amateur\",\"type\":\"level\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"amateur\"]}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A36 — a player with no evidence_recency fact does not satisfy a evidence_recency criterion
pub fn neg_a36_a_player_with_no_evidence_recency_fact_does_not_satisfy_a_eviden_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(3650.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence_recency:within_days:evidenceKind=footage,value=3650\",\"type\":\"evidence_recency\",\"operator\":\"within_days\",\"class\":\"required\",\"value\":3650,\"evidenceKind\":\"footage\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A36 — a player with no trust_band fact does not satisfy a trust_band criterion
pub fn neg_a36_a_player_with_no_trust_band_fact_does_not_satisfy_a_trust_band_c_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("trust_band"),
            operator: Some("gte"),
            value: Some(criteria.Text("limited_evidence")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"trust_band:gte:value=limited_evidence\",\"type\":\"trust_band\",\"operator\":\"gte\",\"class\":\"required\",\"value\":\"limited_evidence\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A36 — a player with no combine_measurement fact does not satisfy a combine_measurement criterion
pub fn neg_a36_a_player_with_no_combine_measurement_fact_does_not_satisfy_a_com_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("combine_measurement"),
            operator: Some("gte"),
            protocol: Some("combine-box-touch-60"),
            value: Some(criteria.Number(0.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=0\",\"type\":\"combine_measurement\",\"operator\":\"gte\",\"class\":\"required\",\"protocol\":\"combine-box-touch-60\",\"value\":0}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — required criteria alone decide membership
pub fn required_criteria_alone_decide_membership_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Left")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
          criteria.Raw(
            type_: Some("trust_band"),
            operator: Some("gte"),
            value: Some(criteria.Text("strong_evidence")),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false}],\"preferred\":[{\"id\":\"foot:in:values=Left\",\"type\":\"foot\",\"operator\":\"in\",\"class\":\"preferred\",\"values\":[\"Left\"]},{\"id\":\"trust_band:gte:value=strong_evidence\",\"type\":\"trust_band\",\"operator\":\"gte\",\"class\":\"preferred\",\"value\":\"strong_evidence\"}],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A40 — an unmet PREFERRED criterion never removes a player from the match set
pub fn neg_a40_an_unmet_preferred_criterion_never_removes_a_player_from_the_mat_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("position"),
            operator: Some("in"),
            values: Some([criteria.Text("CDM")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [
          criteria.Raw(
            type_: Some("foot"),
            operator: Some("in"),
            values: Some([criteria.Text("Left")]),
            value: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false}],\"preferred\":[{\"id\":\"foot:in:values=Left\",\"type\":\"foot\",\"operator\":\"in\",\"class\":\"preferred\",\"values\":[\"Left\"]}],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — the same facts and criteria at the same instant produce byte-identical explanations
pub fn the_same_facts_and_criteria_at_the_same_instant_produce_byte_identical_e_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("gte"),
            value: Some(criteria.Number(16.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:gte:value=16\",\"type\":\"age\",\"operator\":\"gte\",\"class\":\"required\",\"value\":16}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A25 — a player ages out of a criteria set with no write to any record — the fact changed, not the player
pub fn neg_a25_a_player_ages_out_of_a_criteria_set_with_no_write_to_any_record_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("age"),
            operator: Some("lte"),
            value: Some(criteria.Number(17.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"age:lte:value=17\",\"type\":\"age\",\"operator\":\"lte\",\"class\":\"required\",\"value\":17}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A25 — evidence expires out of a criteria set as the clock moves, with no player write
pub fn neg_a25_evidence_expires_out_of_a_criteria_set_as_the_clock_moves_with_n_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("evidence_recency"),
            operator: Some("within_days"),
            value: Some(criteria.Number(30.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":true,\"criteria\":{\"required\":[{\"id\":\"evidence_recency:within_days:evidenceKind=footage,value=30\",\"type\":\"evidence_recency\",\"operator\":\"within_days\",\"class\":\"required\",\"value\":30,\"evidenceKind\":\"footage\"}],\"preferred\":[],\"schemaVersion\":1}}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — "training_volume" is not a criterion — training volume is not a proxy for ability
pub fn neg_a11_training_volume_is_not_a_criterion_training_volume_is_not_a_prox_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("training_volume"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"training_volume\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — "sessions_per_week" is not a criterion — training volume is not a proxy for ability
pub fn neg_a11_sessions_per_week_is_not_a_criterion_training_volume_is_not_a_pr_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("sessions_per_week"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"sessions_per_week\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — "box_cam_minutes" is not a criterion — training volume is not a proxy for ability
pub fn neg_a11_box_cam_minutes_is_not_a_criterion_training_volume_is_not_a_prox_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("box_cam_minutes"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"box_cam_minutes\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — "streak" is not a criterion — training volume is not a proxy for ability
pub fn neg_a11_streak_is_not_a_criterion_training_volume_is_not_a_proxy_for_abi_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("streak"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"streak\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}

// matchingAndWatchlists: validateCriteria — [neg] A11 — "effort" is not a criterion — training volume is not a proxy for ability
pub fn neg_a11_effort_is_not_a_criterion_training_volume_is_not_a_proxy_for_abi_test() {
  assert json.to_string(
      criteria.validation_json(criteria.validate(
        [
          criteria.Raw(
            type_: Some("effort"),
            operator: Some("gte"),
            value: Some(criteria.Number(1.0)),
            values: None,
            primary_only: None,
            evidence_kind: None,
            protocol: None,
          ),
        ],
        [],
        criteria.Context(grassroots: False, protocols: None),
      )),
    )
    == "{\"ok\":false,\"error\":\"CRITERIA_INVALID\",\"details\":[{\"index\":0,\"class\":\"required\",\"type\":\"effort\",\"error\":\"CRITERION_TYPE_UNKNOWN\"}],\"message\":\"These criteria cannot be saved as written.\"}"
}
