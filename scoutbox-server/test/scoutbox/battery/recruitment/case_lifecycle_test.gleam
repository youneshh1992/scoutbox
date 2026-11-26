//// Checks of the rules from the rules suites of recruitment/journeyAdversarial, recruitment/lifecycle, first generated
//// from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{Some}
import scoutbox/battery/base
import scoutbox/recruitment/case_lifecycle
import scoutbox/vocab/room_status

// journeyAdversarial: lifecycleTargetFor — W10 (pure) a hold with no history resumes to under_review; every other action keeps its static target
pub fn w10_pure_a_hold_with_no_history_resumes_to_under_review_every_other_acti_test() {
  assert base.lifecycle_target(base.room(room_status.OnHold, []), "resumeCase")
    == Some(room_status.UnderReview)
}

// journeyAdversarial: lifecycleTargetFor — W10 (pure) a hold with no history resumes to under_review; every other action keeps its static target
pub fn w10_pure_a_hold_with_no_history_resumes_to_under_review_every_other_acti_2_test() {
  assert base.lifecycle_target(base.room(room_status.OnHold, []), "holdCase")
    == Some(room_status.OnHold)
}

// lifecycle: derivedConditions — decision-pending is answered by looking, not by storing
pub fn decision_pending_is_answered_by_looking_not_by_storing_test() {
  assert json.to_string(
      json.object(case_lifecycle.conditions(
        room_status.TrialCompleted,
        False,
        False,
        False,
      )),
    )
    == "{\"decisionPending\":true,\"trialActive\":false,\"offerAwaitingResponse\":false,\"onHold\":false,\"terminal\":false,\"reopenable\":false}"
}

// lifecycle: derivedConditions — and stops being true the moment a decision exists
pub fn and_stops_being_true_the_moment_a_decision_exists_test() {
  assert json.to_string(
      json.object(case_lifecycle.conditions(
        room_status.TrialCompleted,
        True,
        False,
        False,
      )),
    )
    == "{\"decisionPending\":false,\"trialActive\":false,\"offerAwaitingResponse\":false,\"onHold\":false,\"terminal\":false,\"reopenable\":false}"
}

// lifecycle: validateLifecycleReasons — [neg] V3 a DECISION reason is refused on a lifecycle transition
pub fn neg_v3_a_decision_reason_is_refused_on_a_lifecycle_transition_test() {
  assert base.lifecycle_reasons(Some("[\"squad_space\"]"))
    == Error(base.ByRule(
      "{\"error\":\"LIFECYCLE_REASON_UNKNOWN\",\"message\":\"Reasons must come from the recruitment LIFECYCLE taxonomy, which describes why a case moved — not from the decision taxonomy, which describes what a club concluded about a player.\",\"unknown\":[\"squad_space\"],\"allowed\":[\"contact_planned\",\"contact_made\",\"player_responded\",\"trial_progression\",\"trial_completed\",\"club_decision\",\"player_declined\",\"offer_progression\",\"offer_accepted_in_scoutbox\",\"signed_outcome\",\"rejected\",\"withdrawn\",\"on_hold\",\"hold_resumed\",\"case_closed\",\"case_reopened\"]}",
    ))
}

// lifecycle: validateLifecycleReasons — V4 while a lifecycle reason is accepted
pub fn v4_while_a_lifecycle_reason_is_accepted_test() {
  assert base.lifecycle_reasons(Some("[\"case_closed\"]"))
    == Ok(["case_closed"])
}

// lifecycle: validateLifecycleReasons — [neg] V6 "nationality" is refused as a prohibited characteristic, with the Rooms' own error code
pub fn neg_v6_nationality_is_refused_as_a_prohibited_characteristic_with_the_ro_test() {
  assert base.lifecycle_reasons(Some("[\"nationality\"]"))
    == Error(base.ByRule(
      "{\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"nationality\"]}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V6 "religion" is refused as a prohibited characteristic, with the Rooms' own error code
pub fn neg_v6_religion_is_refused_as_a_prohibited_characteristic_with_the_rooms_test() {
  assert base.lifecycle_reasons(Some("[\"religion\"]"))
    == Error(base.ByRule(
      "{\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"religion\"]}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V6 "disability" is refused as a prohibited characteristic, with the Rooms' own error code
pub fn neg_v6_disability_is_refused_as_a_prohibited_characteristic_with_the_roo_test() {
  assert base.lifecycle_reasons(Some("[\"disability\"]"))
    == Error(base.ByRule(
      "{\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"disability\"]}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V6 "postcode" is refused as a prohibited characteristic, with the Rooms' own error code
pub fn neg_v6_postcode_is_refused_as_a_prohibited_characteristic_with_the_rooms_test() {
  assert base.lifecycle_reasons(Some("[\"postcode\"]"))
    == Error(base.ByRule(
      "{\"error\":\"ROOM_REASON_PROHIBITED\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"postcode\"]}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V7 duplicates collapse rather than tripping the ceiling
pub fn neg_v7_duplicates_collapse_rather_than_tripping_the_ceiling_test() {
  assert base.lifecycle_reasons(Some(
      "[\"case_closed\",\"case_closed\",\"case_closed\",\"case_closed\",\"case_closed\",\"case_closed\",\"case_closed\"]",
    ))
    == Ok(["case_closed"])
}

// lifecycle: validateLifecycleReasons — [neg] V8 but seven distinct reasons on one transition is refused
pub fn neg_v8_but_seven_distinct_reasons_on_one_transition_is_refused_test() {
  assert base.lifecycle_reasons(Some(
      "[\"contact_planned\",\"contact_made\",\"player_responded\",\"trial_progression\",\"trial_completed\",\"club_decision\",\"player_declined\"]",
    ))
    == Error(base.ByRule(
      "{\"error\":\"LIFECYCLE_REASONS_TOO_MANY\",\"message\":\"Record up to 6 reasons.\"}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V9 "case_closed" is not a valid reason list
pub fn neg_v9_case_closed_is_not_a_valid_reason_list_test() {
  assert base.lifecycle_reasons(Some("\"case_closed\""))
    == Error(base.ByShape("LIFECYCLE_REASONS_INVALID"))
}

// lifecycle: validateLifecycleReasons — [neg] V9 0 is not a valid reason list
pub fn neg_v9_0_is_not_a_valid_reason_list_test() {
  assert base.lifecycle_reasons(Some("0"))
    == Error(base.ByShape("LIFECYCLE_REASONS_INVALID"))
}

// lifecycle: validateLifecycleReasons — [neg] V9 {} is not a valid reason list
pub fn neg_v9_is_not_a_valid_reason_list_test() {
  assert base.lifecycle_reasons(Some("{}"))
    == Error(base.ByShape("LIFECYCLE_REASONS_INVALID"))
}

// lifecycle: validateLifecycleReasons — [neg] V9 null is not a valid reason list
pub fn neg_v9_null_is_not_a_valid_reason_list_test() {
  assert base.lifecycle_reasons(Some("null"))
    == Error(base.ByRule(
      "{\"error\":\"LIFECYCLE_REASONS_INVALID\",\"message\":\"Reasons must be a list of lifecycle reason codes.\"}",
    ))
}

// lifecycle: validateLifecycleReasons — [neg] V9 [["case_closed"]] is not a valid reason list
pub fn neg_v9_case_closed_is_not_a_valid_reason_list_2_test() {
  assert base.lifecycle_reasons(Some("[[\"case_closed\"]]"))
    == Error(base.ByShape("LIFECYCLE_REASONS_INVALID"))
}
