//// Checks of the rules from the rules suites of development/hub, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/development/hub
import scoutbox/development/hub_rules
import scoutbox/rows/box_sessions
import scoutbox/rows/combine_attempts
import scoutbox/rows/development_actions
import scoutbox/rows/development_evidence_links
import scoutbox/rows/development_goals
import scoutbox/rows/development_plans
import scoutbox/rows/development_reviews
import scoutbox/rows/id
import scoutbox/vocab/box_provider
import scoutbox/vocab/evidence_source
import scoutbox/vocab/goal_category
import scoutbox/vocab/goal_status

// hub: assertDevelopmentVocabulary — the boot assertion passes ({"planStatuses":5,"goalStatuses":5,"goalCategories":7,"actionTypes":9,"actionStatuses":5,"evidenceSources":5,"forbiddenNames":11,"forbiddenFields":26})
pub fn the_boot_assertion_passes_planstatuses_5_goalstatuses_5_goalcategories_7_test() {
  assert json.to_string(hub_rules.vocabulary_check())
    == "{\"policyVersion\":1,\"problems\":[],\"counts\":{\"planStatuses\":5,\"goalStatuses\":5,\"goalCategories\":7,\"actionTypes\":9,\"actionStatuses\":5,\"evidenceSources\":5,\"forbiddenNames\":11,\"forbiddenFields\":26}}"
}

// hub: scanCopyForForbiddenNames — [neg] N58 — the vocabulary scanner catches a forbidden product name in a label
pub fn neg_n58_the_vocabulary_scanner_catches_a_forbidden_product_name_in_a_lab_test() {
  assert hub_rules.scan_copy([#("GOAL_LIBRARY.x", "Development Score")])
    == ["GOAL_LIBRARY.x: contains forbidden name \"development score\""]
}

// hub: scanCopyForForbiddenNames — [neg] N58 — …including one buried inside a longer sentence
pub fn neg_n58_including_one_buried_inside_a_longer_sentence_test() {
  assert hub_rules.scan_copy([#("x", "Player Progress Rating for this week")])
    == ["x: contains forbidden name \"player progress rating\""]
}

// hub: scanCopyForForbiddenNames — and does NOT catch prose that denies a forbidden thing — the copy scan looks for product names, not field names
pub fn and_does_not_catch_prose_that_denies_a_forbidden_thing_the_copy_scan_loo_test() {
  assert hub_rules.scan_copy([
      #("x", "ScoutBox does not measure a player’s ceiling"),
    ])
    == []
}

// hub: transitionAllowed — [neg] N20 — a goal nobody started cannot go straight to achieved
pub fn neg_n20_a_goal_nobody_started_cannot_go_straight_to_achieved_test() {
  assert hub_rules.allowed(
      hub_rules.goal_transitions,
      goal_status.NotStarted,
      goal_status.Achieved,
    )
    == False
}

// hub: transitionAllowed — [neg] N20 — an archived plan cannot be reactivated
pub fn neg_n20_an_archived_plan_cannot_be_reactivated_test() {
  assert hub_rules.allowed(
      hub_rules.plan_transitions,
      development_plans.Archived,
      development_plans.Active,
    )
    == False
}

// hub: transitionAllowed — [neg] N20 — a cancelled action cannot be marked done
pub fn neg_n20_a_cancelled_action_cannot_be_marked_done_test() {
  assert hub_rules.allowed(
      hub_rules.action_transitions,
      development_actions.Cancelled,
      development_actions.Done,
    )
    == False
}

// hub: transitionAllowed — a mistaken "achieved" can be corrected — history keeps both
pub fn a_mistaken_achieved_can_be_corrected_history_keeps_both_test() {
  assert hub_rules.allowed(
      hub_rules.goal_transitions,
      goal_status.Achieved,
      goal_status.InProgress,
    )
    == True
}

// hub: transitionAllowed — the lifecycle a plan actually has is expressible
pub fn the_lifecycle_a_plan_actually_has_is_expressible_test() {
  assert hub_rules.allowed(
      hub_rules.plan_transitions,
      development_plans.Completed,
      development_plans.Archived,
    )
    == True
}

// hub: transitionAllowed — the lifecycle a plan actually has is expressible
pub fn the_lifecycle_a_plan_actually_has_is_expressible_2_test() {
  assert hub_rules.allowed(
      hub_rules.plan_transitions,
      development_plans.Draft,
      development_plans.Active,
    )
    == True
}

// hub: actionCounts — action counts are counts
pub fn action_counts_are_counts_test() {
  assert json.to_string(
      hub_rules.counts_json(
        hub_rules.action_counts([
          development_actions.Done,
          development_actions.Done,
          development_actions.Todo,
          development_actions.Cancelled,
          development_actions.Blocked,
        ]),
      ),
    )
    == "{\"total\":5,\"todo\":1,\"in_progress\":0,\"done\":2,\"blocked\":1,\"cancelled\":1,\"overdue\":0}"
}

// hub: completionPhrase — completion is a sentence of counts: "2 of 4 actions completed"
pub fn completion_is_a_sentence_of_counts_2_of_4_actions_completed_test() {
  assert json.to_string(hub_rules.completion_json(2, 5, 1))
    == "{\"done\":2,\"of\":4,\"phrase\":\"2 of 4 actions completed\"}"
}

// hub: planSummary — the plan summary is deterministic and made of counts
pub fn the_plan_summary_is_deterministic_and_made_of_counts_test() {
  assert json.to_string(hub_rules.plan_summary_json(
      [goal_status.InProgress, goal_status.Achieved],
      [#(development_actions.Todo, hub_rules.Due("overdue", None))],
      2,
      [1_781_438_400_000],
      Some(1_781_784_000_000),
      1_781_524_800_000,
    ))
    == "{\"goalsByStatus\":{\"not_started\":0,\"in_progress\":1,\"blocked\":0,\"achieved\":1,\"stopped\":0},\"activeGoals\":1,\"actionsDue\":0,\"actionsOverdue\":1,\"linkedEvidenceAvailable\":2,\"lastReviewAt\":1781438400000,\"nextReviewAt\":1781784000000,\"reviewDue\":{\"state\":\"review_due\",\"days\":3},\"note\":\"These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.\"}"
}

// hub: dueState — overdue is a fact about a date
pub fn overdue_is_a_fact_about_a_date_test() {
  assert json.to_string(
      hub_rules.due_json(hub_rules.due_state(
        Some(1_781_352_000_000),
        1_781_524_800_000,
      )),
    )
    == "{\"state\":\"overdue\",\"days\":2}"
}

// hub: dueState — due today and no due date are distinct states
pub fn due_today_and_no_due_date_are_distinct_states_test() {
  assert json.to_string(
      hub_rules.due_json(hub_rules.due_state(
        Some(1_781_524_800_000),
        1_781_524_800_000,
      )),
    )
    == "{\"state\":\"due_today\",\"days\":0}"
}

// hub: dueState — due today and no due date are distinct states
pub fn due_today_and_no_due_date_are_distinct_states_2_test() {
  assert json.to_string(
      hub_rules.due_json(hub_rules.due_state(None, 1_781_524_800_000)),
    )
    == "{\"state\":\"no_due_date\",\"days\":null}"
}

// hub: reviewDueState — review due states are derived the same way
pub fn review_due_states_are_derived_the_same_way_test() {
  assert json.to_string(
      hub_rules.due_json(hub_rules.review_due_state(
        Some(1_781_438_400_000),
        1_781_524_800_000,
      )),
    )
    == "{\"state\":\"review_overdue\",\"days\":1}"
}

// hub: reviewDueState — review due states are derived the same way
pub fn review_due_states_are_derived_the_same_way_2_test() {
  assert json.to_string(
      hub_rules.due_json(hub_rules.review_due_state(None, 1_781_524_800_000)),
    )
    == "{\"state\":\"no_review_scheduled\",\"days\":null}"
}

// hub: utcDay — dates are UTC calendar days — the shared date semantics, reused
pub fn dates_are_utc_calendar_days_the_shared_date_semantics_reused_test() {
  assert hub_rules.utc_day(1_781_567_940_000) == 1_781_481_600_000
}

// hub: utcDay — dates are UTC calendar days — the shared date semantics, reused
pub fn dates_are_utc_calendar_days_the_shared_date_semantics_reused_2_test() {
  assert hub_rules.utc_day(1_781_481_660_000) == 1_781_481_600_000
}

// hub: daysBetween — dates are UTC calendar days — the shared date semantics, reused
pub fn dates_are_utc_calendar_days_the_shared_date_semantics_reused_3_test() {
  assert hub_rules.days_between(1_781_524_800_000, 1_781_611_200_000) == 1
}

// hub: boundedText — [neg] N49 — over-long text is refused, never silently truncated
pub fn neg_n49_over_long_text_is_refused_never_silently_truncated_test() {
  assert json.to_string(hub_rules.bounded_text_json(
      Some(
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ),
      120,
      "title",
    ))
    == "{\"error\":\"TEXT_TOO_LONG\",\"field\":\"title\",\"max\":120,\"length\":200,\"detail\":\"title may be at most 120 characters.\"}"
}

// hub: validateTarget — a valid target pins its protocol version and takes the metric from the protocol
pub fn a_valid_target_pins_its_protocol_version_and_takes_the_metric_from_the_p_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        operator: Some("gte"),
        value: Some(160.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"value\":{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"metricType\":\"count\",\"metricUnit\":\"touches\",\"operator\":\"gte\",\"value\":160,\"protocolTitle\":\"Box Touch 60\",\"direction\":\"higher\",\"precision\":\"integer\"}}"
}

// hub: validateTarget — [neg] N14 — an unsupported Combine protocol is refused
pub fn neg_n14_an_unsupported_combine_protocol_is_refused_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-make-believe"),
        operator: Some("gte"),
        value: Some(1.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_PROTOCOL_UNKNOWN\",\"protocolId\":\"combine-make-believe\",\"allowed\":[\"combine-box-touch-60\",\"combine-box-juggle\",\"combine-box-control-60\",\"combine-box-footwork\",\"combine-box-strength-60\",\"combine-agility-5-10-5\",\"combine-accel-10m\",\"combine-broad-jump\",\"combine-passing-target\"],\"detail\":\"\\\"combine-make-believe\\\" is not a standardized Combine protocol.\"}"
}

// hub: validateTarget — [neg] N14 — an unknown protocol version is refused
pub fn neg_n14_an_unknown_protocol_version_is_refused_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        protocol_version: Some(99),
        operator: Some("gte"),
        value: Some(1.0),
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_PROTOCOL_VERSION_UNKNOWN\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":99,\"detail\":\"Protocol combine-box-touch-60 has no version 99.\"}"
}

// hub: validateTarget — [neg] N54 — a malformed target operator is refused
pub fn neg_n54_a_malformed_target_operator_is_refused_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        operator: Some("approximately"),
        value: Some(160.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_OPERATOR_UNKNOWN\",\"allowed\":[\"gte\",\"gt\",\"lte\",\"lt\",\"eq\"],\"detail\":\"Unknown operator \\\"approximately\\\".\"}"
}

// hub: validateTarget — [neg] N54 — an operator pointing the wrong way down the metric is refused — a target must not set out to get worse
pub fn neg_n54_an_operator_pointing_the_wrong_way_down_the_metric_is_refused_a_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        operator: Some("lte"),
        value: Some(160.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_OPERATOR_INCOMPATIBLE\",\"operator\":\"lte\",\"direction\":\"higher\",\"detail\":\"Box Touch 60 improves as the number rises, so a \\\"≤\\\" target would set out to get worse.\"}"
}

// hub: validateTarget — [neg] N54 — exact equality on a sub-unit measurement is refused rather than stored unreachable
pub fn neg_n54_exact_equality_on_a_sub_unit_measurement_is_refused_rather_than_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-control-60"),
        operator: Some("eq"),
        value: Some(30.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_OPERATOR_INCOMPATIBLE\",\"operator\":\"eq\",\"detail\":\"Box Control 60 is measured to tenths, so an exact-equality target could never be reached.\"}"
}

// hub: validateTarget — [neg] N55 — a negative target value is refused
pub fn neg_n55_a_negative_target_value_is_refused_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        operator: Some("gte"),
        value: Some(-5.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_VALUE_INVALID\",\"detail\":\"A target value must be greater than zero.\"}"
}

// hub: validateTarget — [neg] N55 — a fractional value on a whole-number metric is refused
pub fn neg_n55_a_fractional_value_on_a_whole_number_metric_is_refused_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        operator: Some("gte"),
        value: Some(160.5),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_VALUE_INVALID\",\"detail\":\"Box Touch 60 is counted in whole touches, so the target must be a whole number.\"}"
}

// hub: validateTarget — [neg] N55 — 80 seconds of control inside a 60-second protocol is impossible, not ambitious
pub fn neg_n55_80_seconds_of_control_inside_a_60_second_protocol_is_impossible_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-control-60"),
        operator: Some("gte"),
        value: Some(80.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_VALUE_OUT_OF_RANGE\",\"max\":60,\"detail\":\"Box Control 60 measures at most 60 seconds.\"}"
}

// hub: validateTarget — [neg] N55 — a client cannot rename the protocol’s metric
pub fn neg_n55_a_client_cannot_rename_the_protocol_s_metric_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-touch-60"),
        metric_type: Some("duration"),
        operator: Some("gte"),
        value: Some(160.0),
        protocol_version: None,
      )),
    )
    == "{\"error\":\"TARGET_METRIC_MISMATCH\",\"protocolId\":\"combine-box-touch-60\",\"expected\":\"count\",\"received\":\"duration\",\"detail\":\"Box Touch 60 measures count, not duration.\"}"
}

// hub: validateTarget — [neg] a Box Cam session cannot satisfy a numeric target — observed training is not a measurement
pub fn neg_a_box_cam_session_cannot_satisfy_a_numeric_target_observed_training_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("box_cam_session"),
        protocol_id: Some("x"),
        operator: Some("gte"),
        value: Some(1.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"error\":\"TARGET_SOURCE_UNSUPPORTED\",\"allowed\":[\"combine_attempt\"],\"detail\":\"Only a standardized At-Home Combine measurement can satisfy an objective target. Box Cam records observed training and an assessment records an opinion — neither is a comparable number.\"}"
}

// hub: evaluateTarget — a production-valid result above the threshold reads target_met
pub fn a_production_valid_result_above_the_threshold_reads_target_met_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("catt-1"),
            "combine-box-touch-60",
            1,
            Some(165.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"target_met\",\"reason\":null,\"measured\":{\"value\":165,\"attemptId\":\"catt-1\",\"completedAt\":1781524800000,\"protocolVersion\":1,\"combineVerified\":true},\"note\":\"The stated measurement has been reached. Whether the wider development goal is achieved is a decision for the plan owner or reviewer — one measurement is not the whole objective.\"}"
}

// hub: evaluateTarget — a result below the threshold reads target_not_met
pub fn a_result_below_the_threshold_reads_target_not_met_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("catt-1"),
            "combine-box-touch-60",
            1,
            Some(141.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"target_not_met\",\"reason\":null,\"measured\":{\"value\":141,\"attemptId\":\"catt-1\",\"completedAt\":1781524800000,\"protocolVersion\":1,\"combineVerified\":true},\"note\":\"The stated measurement has not been reached yet.\"}"
}

// hub: evaluateTarget — no attempt at all has its own reason
pub fn no_attempt_at_all_has_its_own_reason_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"no_current_valid_measurement\",\"reason\":\"no_attempts\",\"measured\":null,\"note\":\"No Combine attempt has been recorded for this protocol yet.\"}"
}

// hub: evaluateTarget — [neg] N13 — a test-provider Combine result of 999 does NOT satisfy a production target
pub fn neg_n13_a_test_provider_combine_result_of_999_does_not_satisfy_a_product_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("catt-1"),
            "combine-box-touch-60",
            1,
            Some(999.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.LocalTest,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"no_current_valid_measurement\",\"reason\":\"no_production_valid_attempt\",\"measured\":null,\"note\":\"There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target.\"}"
}

// hub: evaluateTarget — [neg] N12 — an invalidated Combine result stops satisfying the target the moment it is invalidated
pub fn neg_n12_an_invalidated_combine_result_stops_satisfying_the_target_the_mo_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("catt-1"),
            "combine-box-touch-60",
            1,
            Some(165.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateInvalidated),
            box_provider.WebClient,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"no_current_valid_measurement\",\"reason\":\"measurement_invalidated\",\"measured\":null,\"note\":\"The supporting Combine result was invalidated after review, so there is no current valid measurement. The link and its history are kept.\"}"
}

// hub: evaluateTarget — measurements are not compared across protocol versions
pub fn measurements_are_not_compared_across_protocol_versions_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-touch-60",
        protocol_version: 1,
        metric_type: development_goals.Count,
        metric_unit: "touches",
        operator: development_goals.Gte,
        value: 160.0,
        protocol_title: "Box Touch 60",
        direction: development_goals.Higher,
        precision: development_goals.Integer,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("catt-1"),
            "combine-box-touch-60",
            2,
            Some(165.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-touch-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Touch 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":160,\"metricUnit\":\"touches\",\"statement\":\"Box Touch 60 ≥ 160 touches\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"no_current_valid_measurement\",\"reason\":\"protocol_version_mismatch\",\"measured\":null,\"note\":\"Results exist for this protocol, but under a different version of it. Measurements are not compared across protocol versions.\"}"
}

// hub: isProductionValidCombine — the shared predicate answers all three cases the same way Box Cam does
pub fn the_shared_predicate_answers_all_three_cases_the_same_way_box_cam_does_test() {
  assert hub_rules.production_valid(hub_rules.measured_of(
      id.combine_attempt("catt-1"),
      "combine-box-touch-60",
      1,
      Some(165.0),
      Some(1_781_524_800_000),
      combine_attempts.CombineVerified,
      Some(box_sessions.VerificationStateVerified),
      box_provider.WebClient,
    ))
    == True
}

// hub: isProductionValidCombine — the shared predicate answers all three cases the same way Box Cam does
pub fn the_shared_predicate_answers_all_three_cases_the_same_way_box_cam_does_2_test() {
  assert hub_rules.production_valid(hub_rules.measured_of(
      id.combine_attempt("catt-1"),
      "combine-box-touch-60",
      1,
      Some(165.0),
      Some(1_781_524_800_000),
      combine_attempts.CombineVerified,
      Some(box_sessions.VerificationStateVerified),
      box_provider.LocalTest,
    ))
    == False
}

// hub: compare — the comparison itself is one pure function
pub fn the_comparison_itself_is_one_pure_function_test() {
  assert hub_rules.compare(5.0, development_goals.Gte, 5.0) == True
}

// hub: compare — the comparison itself is one pure function
pub fn the_comparison_itself_is_one_pure_function_2_test() {
  assert hub_rules.compare(4.0, development_goals.Gt, 4.0) == False
}

// hub: compare — the comparison itself is one pure function
pub fn the_comparison_itself_is_one_pure_function_3_test() {
  assert hub_rules.compare(3.0, development_goals.Lt, 4.0) == True
}

// hub: bestValidAttempt — best means best in the protocol’s own direction
pub fn best_means_best_in_the_protocol_s_own_direction_test() {
  assert option.map(
      hub_rules.best_valid(
        [
          hub_rules.measured_of(
            id.combine_attempt("a"),
            "combine-box-touch-60",
            1,
            Some(161.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
          hub_rules.measured_of(
            id.combine_attempt("b"),
            "combine-box-touch-60",
            1,
            Some(170.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
        ],
        hub_rules.Target(
          protocol_id: "combine-box-touch-60",
          protocol_version: 1,
          metric_type: development_goals.Count,
          metric_unit: "touches",
          operator: development_goals.Gte,
          value: 160.0,
          protocol_title: "Box Touch 60",
          direction: development_goals.Higher,
          precision: development_goals.Integer,
        ),
      ),
      fn(m: hub_rules.Measured) { m.id },
    )
    == Some(id.combine_attempt("b"))
}

// hub: summariseEvidence — the evidence summary is a count of items
pub fn the_evidence_summary_is_a_count_of_items_test() {
  assert json.to_string(
      hub_rules.summarise_evidence([
        #(True, False),
        #(False, False),
        #(True, True),
      ]),
    )
    == "{\"total\":3,\"available\":2,\"unavailable\":1,\"simulated\":1,\"note\":\"2 of 3 linked items are currently available.\"}"
}

// hub: reviewView — the club reads its own note
pub fn the_club_reads_its_own_note_test() {
  assert json.to_string(hub_rules.review_json(
      hub.Review(
        row: development_reviews.Row(
          ..development_reviews.Row(
            ..base.dev_review(),
            id: id.dev_review("r1"),
            plan_id: id.dev_plan("pl2"),
            reviewer_kind: development_reviews.CoachReview,
            reviewed_at: 1_781_524_800_000,
            shared_summary: Some("Good week."),
            internal_note: Some("SECRET-CLUB-NOTE"),
            shared_with_player_at: None,
          ),
          reviewed_by_name: Some("A Coach"),
        ),
        snapshots: [],
        superseded_by: option.None,
        history: [],
      ),
      hub_rules.Caps(..hub_rules.no_caps, read_internal: True),
    ))
    == "{\"id\":\"r1\",\"planId\":\"pl2\",\"reviewerKind\":\"coach_review\",\"reviewedByName\":\"A Coach\",\"orgId\":null,\"reviewedAt\":1781524800000,\"nextReviewAt\":null,\"goalSnapshots\":[],\"supersedes\":null,\"supersededBy\":null,\"hasInternalNote\":true,\"summary\":\"Good week.\",\"internalNote\":\"SECRET-CLUB-NOTE\"}"
}

// hub: reviewView — the club reads its own note
pub fn the_club_reads_its_own_note_2_test() {
  assert json.to_string(hub_rules.review_json(
      hub.Review(
        row: development_reviews.Row(
          ..development_reviews.Row(
            ..base.dev_review(),
            id: id.dev_review("r1"),
            plan_id: id.dev_plan("pl2"),
            reviewer_kind: development_reviews.CoachReview,
            reviewed_at: 1_781_524_800_000,
            shared_summary: Some("Good week."),
            internal_note: Some("SECRET-CLUB-NOTE"),
            shared_with_player_at: None,
          ),
          reviewed_by_name: Some("A Coach"),
        ),
        snapshots: [],
        superseded_by: option.None,
        history: [],
      ),
      hub_rules.Caps(..hub_rules.no_caps, read_internal: False),
    ))
    == "{\"id\":\"r1\",\"planId\":\"pl2\",\"reviewerKind\":\"coach_review\",\"reviewedByName\":\"A Coach\",\"orgId\":null,\"reviewedAt\":1781524800000,\"nextReviewAt\":null,\"goalSnapshots\":[],\"supersedes\":null,\"supersededBy\":null,\"hasInternalNote\":true,\"summary\":null,\"internalNote\":null,\"internalNoteNote\":\"This review also contains notes kept inside the club. They are not shared.\"}"
}

// hub: reviewView — an explicitly shared summary IS shown
pub fn an_explicitly_shared_summary_is_shown_test() {
  assert json.to_string(hub_rules.review_json(
      hub.Review(
        row: development_reviews.Row(
          ..development_reviews.Row(
            ..base.dev_review(),
            id: id.dev_review("r1"),
            plan_id: id.dev_plan("pl2"),
            reviewer_kind: development_reviews.CoachReview,
            reviewed_at: 1_781_524_800_000,
            shared_summary: Some("Good week."),
            internal_note: Some("SECRET-CLUB-NOTE"),
            shared_with_player_at: Some(1_781_524_800_000),
          ),
          reviewed_by_name: Some("A Coach"),
        ),
        snapshots: [],
        superseded_by: option.None,
        history: [],
      ),
      hub_rules.Caps(..hub_rules.no_caps, read_internal: False),
    ))
    == "{\"id\":\"r1\",\"planId\":\"pl2\",\"reviewerKind\":\"coach_review\",\"reviewedByName\":\"A Coach\",\"orgId\":null,\"reviewedAt\":1781524800000,\"nextReviewAt\":null,\"goalSnapshots\":[],\"supersedes\":null,\"supersededBy\":null,\"hasInternalNote\":true,\"summary\":\"Good week.\",\"internalNote\":null,\"internalNoteNote\":\"This review also contains notes kept inside the club. They are not shared.\"}"
}

// hub: buildGoalSnapshots — a snapshot records what the reviewer saw of the plan
pub fn a_snapshot_records_what_the_reviewer_saw_of_the_plan_test() {
  assert json.to_string(json.array(
      hub_rules.goal_snapshots(
        id.dev_review(""),
        [
          development_goals.Row(
            ..base.dev_goal(),
            id: id.dev_goal("g1"),
            title: "Goal",
            category: goal_category.Technical,
            status: goal_status.InProgress,
            created_at: 1_781_524_800_000,
          ),
        ],
        [
          development_actions.Row(
            ..base.dev_action(),
            goal_id: id.dev_goal("g1"),
            status: development_actions.Done,
          ),
          development_actions.Row(
            ..base.dev_action(),
            goal_id: id.dev_goal("g1"),
            status: development_actions.Todo,
          ),
        ],
        [
          development_evidence_links.Row(
            ..base.dev_link(),
            goal_id: Some(id.dev_goal("g1")),
            source_type: evidence_source.Assessment,
            source_id: "ass-1",
          ),
        ],
        [],
      ),
      hub_rules.snapshot_json,
    ))
    == "[{\"goalId\":\"g1\",\"title\":\"Goal\",\"category\":\"technical\",\"status\":\"in_progress\",\"actionCounts\":{\"total\":2,\"done\":1,\"blocked\":0,\"cancelled\":0},\"completion\":{\"done\":1,\"of\":2,\"phrase\":\"1 of 2 actions completed\"},\"evidenceRefs\":[{\"sourceType\":\"assessment\",\"sourceId\":\"ass-1\"}],\"targetStateAtReview\":null}]"
}

// hub: pageReviews — reviews page newest-first with a stable cursor
pub fn reviews_page_newest_first_with_a_stable_cursor_test() {
  assert hub_rules.page_reviews(
      [#("r1", 3), #("r2", 2), #("r3", 1)],
      Some(2),
      None,
    )
    == Ok(#([#("r1", 3), #("r2", 2)], 3, Some("r2")))
}

// hub: pageReviews — [neg] N67 — a malformed pagination cursor is refused, not ignored
pub fn neg_n67_a_malformed_pagination_cursor_is_refused_not_ignored_test() {
  assert hub_rules.page_reviews([], Some(2), Some("nope")) == Error(Nil)
}

// hub: pageReviews — a page is capped at 50 however large a limit is asked for
pub fn a_page_is_capped_at_50_however_large_a_limit_is_asked_for_test() {
  assert hub_rules.page_reviews(
      [
        #("r0", 0),
        #("r1", 1),
        #("r2", 2),
        #("r3", 3),
        #("r4", 4),
        #("r5", 5),
        #("r6", 6),
        #("r7", 7),
        #("r8", 8),
        #("r9", 9),
        #("r10", 10),
        #("r11", 11),
        #("r12", 12),
        #("r13", 13),
        #("r14", 14),
        #("r15", 15),
        #("r16", 16),
        #("r17", 17),
        #("r18", 18),
        #("r19", 19),
        #("r20", 20),
        #("r21", 21),
        #("r22", 22),
        #("r23", 23),
        #("r24", 24),
        #("r25", 25),
        #("r26", 26),
        #("r27", 27),
        #("r28", 28),
        #("r29", 29),
        #("r30", 30),
        #("r31", 31),
        #("r32", 32),
        #("r33", 33),
        #("r34", 34),
        #("r35", 35),
        #("r36", 36),
        #("r37", 37),
        #("r38", 38),
        #("r39", 39),
        #("r40", 40),
        #("r41", 41),
        #("r42", 42),
        #("r43", 43),
        #("r44", 44),
        #("r45", 45),
        #("r46", 46),
        #("r47", 47),
        #("r48", 48),
        #("r49", 49),
        #("r50", 50),
        #("r51", 51),
        #("r52", 52),
        #("r53", 53),
        #("r54", 54),
        #("r55", 55),
        #("r56", 56),
        #("r57", 57),
        #("r58", 58),
        #("r59", 59),
        #("r60", 60),
        #("r61", 61),
        #("r62", 62),
        #("r63", 63),
        #("r64", 64),
        #("r65", 65),
        #("r66", 66),
        #("r67", 67),
        #("r68", 68),
        #("r69", 69),
        #("r70", 70),
        #("r71", 71),
        #("r72", 72),
        #("r73", 73),
        #("r74", 74),
        #("r75", 75),
        #("r76", 76),
        #("r77", 77),
        #("r78", 78),
        #("r79", 79),
        #("r80", 80),
        #("r81", 81),
        #("r82", 82),
        #("r83", 83),
        #("r84", 84),
        #("r85", 85),
        #("r86", 86),
        #("r87", 87),
        #("r88", 88),
        #("r89", 89),
        #("r90", 90),
        #("r91", 91),
        #("r92", 92),
        #("r93", 93),
        #("r94", 94),
        #("r95", 95),
        #("r96", 96),
        #("r97", 97),
        #("r98", 98),
        #("r99", 99),
        #("r100", 100),
        #("r101", 101),
        #("r102", 102),
        #("r103", 103),
        #("r104", 104),
        #("r105", 105),
        #("r106", 106),
        #("r107", 107),
        #("r108", 108),
        #("r109", 109),
        #("r110", 110),
        #("r111", 111),
        #("r112", 112),
        #("r113", 113),
        #("r114", 114),
        #("r115", 115),
        #("r116", 116),
        #("r117", 117),
        #("r118", 118),
        #("r119", 119),
        #("r120", 120),
        #("r121", 121),
        #("r122", 122),
        #("r123", 123),
        #("r124", 124),
        #("r125", 125),
        #("r126", 126),
        #("r127", 127),
        #("r128", 128),
        #("r129", 129),
        #("r130", 130),
        #("r131", 131),
        #("r132", 132),
        #("r133", 133),
        #("r134", 134),
        #("r135", 135),
        #("r136", 136),
        #("r137", 137),
        #("r138", 138),
        #("r139", 139),
        #("r140", 140),
        #("r141", 141),
        #("r142", 142),
        #("r143", 143),
        #("r144", 144),
        #("r145", 145),
        #("r146", 146),
        #("r147", 147),
        #("r148", 148),
        #("r149", 149),
        #("r150", 150),
        #("r151", 151),
        #("r152", 152),
        #("r153", 153),
        #("r154", 154),
        #("r155", 155),
        #("r156", 156),
        #("r157", 157),
        #("r158", 158),
        #("r159", 159),
        #("r160", 160),
        #("r161", 161),
        #("r162", 162),
        #("r163", 163),
        #("r164", 164),
        #("r165", 165),
        #("r166", 166),
        #("r167", 167),
        #("r168", 168),
        #("r169", 169),
        #("r170", 170),
        #("r171", 171),
        #("r172", 172),
        #("r173", 173),
        #("r174", 174),
        #("r175", 175),
        #("r176", 176),
        #("r177", 177),
        #("r178", 178),
        #("r179", 179),
        #("r180", 180),
        #("r181", 181),
        #("r182", 182),
        #("r183", 183),
        #("r184", 184),
        #("r185", 185),
        #("r186", 186),
        #("r187", 187),
        #("r188", 188),
        #("r189", 189),
        #("r190", 190),
        #("r191", 191),
        #("r192", 192),
        #("r193", 193),
        #("r194", 194),
        #("r195", 195),
        #("r196", 196),
        #("r197", 197),
        #("r198", 198),
        #("r199", 199),
      ],
      Some(999),
      None,
    )
    == Ok(#(
      [
        #("r199", 199),
        #("r198", 198),
        #("r197", 197),
        #("r196", 196),
        #("r195", 195),
        #("r194", 194),
        #("r193", 193),
        #("r192", 192),
        #("r191", 191),
        #("r190", 190),
        #("r189", 189),
        #("r188", 188),
        #("r187", 187),
        #("r186", 186),
        #("r185", 185),
        #("r184", 184),
        #("r183", 183),
        #("r182", 182),
        #("r181", 181),
        #("r180", 180),
        #("r179", 179),
        #("r178", 178),
        #("r177", 177),
        #("r176", 176),
        #("r175", 175),
        #("r174", 174),
        #("r173", 173),
        #("r172", 172),
        #("r171", 171),
        #("r170", 170),
        #("r169", 169),
        #("r168", 168),
        #("r167", 167),
        #("r166", 166),
        #("r165", 165),
        #("r164", 164),
        #("r163", 163),
        #("r162", 162),
        #("r161", 161),
        #("r160", 160),
        #("r159", 159),
        #("r158", 158),
        #("r157", 157),
        #("r156", 156),
        #("r155", 155),
        #("r154", 154),
        #("r153", 153),
        #("r152", 152),
        #("r151", 151),
        #("r150", 150),
      ],
      200,
      Some("r150"),
    ))
}

// hub: refusedClientFields — [neg] N15 — a client body carrying "targetMet" is refused
pub fn neg_n15_a_client_body_carrying_targetmet_is_refused_test() {
  assert hub_rules.refused_client_fields(["targetMet"]) == ["targetMet"]
}

// hub: refusedClientFields — [neg] N15 — a client body carrying "progress" is refused
pub fn neg_n15_a_client_body_carrying_progress_is_refused_test() {
  assert hub_rules.refused_client_fields(["progress"]) == ["progress"]
}

// hub: refusedClientFields — [neg] N15 — a client body carrying "evidenceConfidence" is refused
pub fn neg_n15_a_client_body_carrying_evidenceconfidence_is_refused_test() {
  assert hub_rules.refused_client_fields(["evidenceConfidence"])
    == ["evidenceConfidence"]
}

// hub: refusedClientFields — [neg] N15 — a client body carrying "verified" is refused
pub fn neg_n15_a_client_body_carrying_verified_is_refused_test() {
  assert hub_rules.refused_client_fields(["verified"]) == ["verified"]
}

// hub: refusedClientFields — [neg] N15 — a client body carrying "developmentScore" is refused
pub fn neg_n15_a_client_body_carrying_developmentscore_is_refused_test() {
  assert hub_rules.refused_client_fields(["developmentScore"])
    == ["developmentScore"]
}

// hub: refusedClientFields — [neg] N16 — a forged progress percentage is refused
pub fn neg_n16_a_forged_progress_percentage_is_refused_test() {
  assert hub_rules.refused_client_fields(["progressPercent"])
    == ["progressPercent"]
}

// hub: refusedClientFields — [neg] N17 — a client cannot mark evidence verified
pub fn neg_n17_a_client_cannot_mark_evidence_verified_test() {
  assert hub_rules.refused_client_fields(["verifiedEvidence"])
    == ["verifiedEvidence"]
}

// hub: refusedClientFields — an ordinary body passes through
pub fn an_ordinary_body_passes_through_test() {
  assert hub_rules.refused_client_fields(["title", "category"]) == []
}

// hub: validateTarget — the engine DOES read target_met the moment a production-valid measurement exists — the gap is the detector, not the logic
pub fn the_engine_does_read_target_met_the_moment_a_production_valid_measuremen_test() {
  assert json.to_string(
      hub_rules.validate_target_json(hub_rules.TargetInput(
        source_type: Some("combine_attempt"),
        protocol_id: Some("combine-box-control-60"),
        operator: Some("gte"),
        value: Some(30.0),
        protocol_version: None,
        metric_type: None,
      )),
    )
    == "{\"value\":{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-control-60\",\"protocolVersion\":1,\"metricType\":\"duration\",\"metricUnit\":\"seconds\",\"operator\":\"gte\",\"value\":30,\"protocolTitle\":\"Box Control 60\",\"direction\":\"higher\",\"precision\":\"tenths\"}}"
}

// hub: evaluateTarget — the engine DOES read target_met the moment a production-valid measurement exists — the gap is the detector, not the logic
pub fn the_engine_does_read_target_met_the_moment_a_production_valid_measuremen_2_test() {
  assert json.to_string(hub_rules.evaluation_json(
      hub_rules.Target(
        protocol_id: "combine-box-control-60",
        protocol_version: 1,
        metric_type: development_goals.Duration,
        metric_unit: "seconds",
        operator: development_goals.Gte,
        value: 30.0,
        protocol_title: "Box Control 60",
        direction: development_goals.Higher,
        precision: development_goals.Tenths,
      ),
      hub_rules.evaluate_target(
        hub_rules.Target(
          protocol_id: "combine-box-control-60",
          protocol_version: 1,
          metric_type: development_goals.Duration,
          metric_unit: "seconds",
          operator: development_goals.Gte,
          value: 30.0,
          protocol_title: "Box Control 60",
          direction: development_goals.Higher,
          precision: development_goals.Tenths,
        ),
        [
          hub_rules.measured_of(
            id.combine_attempt("a"),
            "combine-box-control-60",
            1,
            Some(41.0),
            Some(1_781_524_800_000),
            combine_attempts.CombineVerified,
            Some(box_sessions.VerificationStateVerified),
            box_provider.WebClient,
          ),
        ],
      ),
    ))
    == "{\"sourceType\":\"combine_attempt\",\"protocolId\":\"combine-box-control-60\",\"protocolVersion\":1,\"protocolTitle\":\"Box Control 60\",\"operator\":\"gte\",\"operatorSymbol\":\"≥\",\"value\":30,\"metricUnit\":\"seconds\",\"statement\":\"Box Control 60 ≥ 30 seconds\",\"limitation\":\"A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.\",\"state\":\"target_met\",\"reason\":null,\"measured\":{\"value\":41,\"attemptId\":\"a\",\"completedAt\":1781524800000,\"protocolVersion\":1,\"combineVerified\":true},\"note\":\"The stated measurement has been reached. Whether the wider development goal is achieved is a decision for the plan owner or reviewer — one measurement is not the whole objective.\"}"
}
