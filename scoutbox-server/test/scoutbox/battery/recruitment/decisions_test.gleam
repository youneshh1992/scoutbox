//// Checks of the rules from the rules suites of recruitment/decisions, recruitment/decisionsPersistence, first
//// generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/recruitment/decisions
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules
import scoutbox/rows/assessments
import scoutbox/rows/id
import scoutbox/rows/room_decisions
import scoutbox/vocab/case_outcome
import scoutbox/vocab/decision_evidence_kind
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/room_status

// decisions: validateOutcome — [neg] U6 "constructor" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_constructor_is_not_an_outcome_prototype_keys_other_types_case_roo_test() {
  assert base.decision_outcome(Some("\"constructor\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "prototype" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_prototype_is_not_an_outcome_prototype_keys_other_types_case_room_test() {
  assert base.decision_outcome(Some("\"prototype\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "__proto__" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_proto_is_not_an_outcome_prototype_keys_other_types_case_room_word_test() {
  assert base.decision_outcome(Some("\"__proto__\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "toString" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_tostring_is_not_an_outcome_prototype_keys_other_types_case_room_w_test() {
  assert base.decision_outcome(Some("\"toString\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "valueOf" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_valueof_is_not_an_outcome_prototype_keys_other_types_case_room_wo_test() {
  assert base.decision_outcome(Some("\"valueOf\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "hasOwnProperty" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_hasownproperty_is_not_an_outcome_prototype_keys_other_types_case_test() {
  assert base.decision_outcome(Some("\"hasOwnProperty\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 {} is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_is_not_an_outcome_prototype_keys_other_types_case_room_words_test() {
  assert base.decision_outcome(Some("{}"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 [] is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_is_not_an_outcome_prototype_keys_other_types_case_room_words_2_test() {
  assert base.decision_outcome(Some("[]"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 true is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_true_is_not_an_outcome_prototype_keys_other_types_case_room_words_test() {
  assert base.decision_outcome(Some("true"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 false is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_false_is_not_an_outcome_prototype_keys_other_types_case_room_word_test() {
  assert base.decision_outcome(Some("false"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 1 is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_1_is_not_an_outcome_prototype_keys_other_types_case_room_words_test() {
  assert base.decision_outcome(Some("1"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 1.5 is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_1_5_is_not_an_outcome_prototype_keys_other_types_case_room_words_test() {
  assert base.decision_outcome(Some("1.5"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 -1 is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_1_is_not_an_outcome_prototype_keys_other_types_case_room_words_2_test() {
  assert base.decision_outcome(Some("-1"))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_is_not_an_outcome_prototype_keys_other_types_case_room_words_3_test() {
  assert base.decision_outcome(Some("\"\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 " " is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_is_not_an_outcome_prototype_keys_other_types_case_room_words_4_test() {
  assert base.decision_outcome(Some("\" \""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "PROGRESS" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_progress_is_not_an_outcome_prototype_keys_other_types_case_room_w_test() {
  assert base.decision_outcome(Some("\"PROGRESS\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "Progress" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_progress_is_not_an_outcome_prototype_keys_other_types_case_room_w_2_test() {
  assert base.decision_outcome(Some("\"Progress\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 " progress" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_progress_is_not_an_outcome_prototype_keys_other_types_case_room_w_3_test() {
  assert base.decision_outcome(Some("\" progress\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "offer" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_offer_is_not_an_outcome_prototype_keys_other_types_case_room_word_test() {
  assert base.decision_outcome(Some("\"offer\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "sign" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_sign_is_not_an_outcome_prototype_keys_other_types_case_room_words_test() {
  assert base.decision_outcome(Some("\"sign\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "archive" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_archive_is_not_an_outcome_prototype_keys_other_types_case_room_wo_test() {
  assert base.decision_outcome(Some("\"archive\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateOutcome — [neg] U6 "accept" is not an outcome (prototype keys, other types, case, Room words)
pub fn neg_u6_accept_is_not_an_outcome_prototype_keys_other_types_case_room_wor_test() {
  assert base.decision_outcome(Some("\"accept\""))
    == Error(base.ByShape("DECISION_OUTCOME_INVALID"))
}

// decisions: validateDecisionReasons — U7 decision reasons come from the Rooms taxonomy, normalised
pub fn u7_decision_reasons_come_from_the_rooms_taxonomy_normalised_test() {
  assert base.decision_reasons(
      Some("[\"tactical_fit\",\"Position_Need\"]"),
      None,
    )
    == Ok(["tactical_fit", "position_need"])
}

// decisions: validateDecisionReasons — [neg] U8 a rejection with no reason is refused
pub fn neg_u8_a_rejection_with_no_reason_is_refused_test() {
  assert base.decision_reasons(Some("[]"), Some(decision_outcome.Reject))
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A rejection needs at least one reason so the decision stays useful later — and so a Second Look can tell whether it still applies.\"}",
    ))
}

// decisions: validateDecisionReasons — U8b hold and progress may carry none
pub fn u8b_hold_and_progress_may_carry_none_test() {
  assert base.decision_reasons(Some("[]"), Some(decision_outcome.Hold))
    == Ok([])
}

// decisions: validateDecisionReasons — [neg] U9 the LIFECYCLE reason "rejected" is not a decision reason (two taxonomies)
pub fn neg_u9_the_lifecycle_reason_rejected_is_not_a_decision_reason_two_taxono_test() {
  assert base.decision_reasons(Some("[\"rejected\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"rejected\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U9 the LIFECYCLE reason "on_hold" is not a decision reason (two taxonomies)
pub fn neg_u9_the_lifecycle_reason_on_hold_is_not_a_decision_reason_two_taxonom_test() {
  assert base.decision_reasons(Some("[\"on_hold\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"on_hold\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U9 the LIFECYCLE reason "club_decision" is not a decision reason (two taxonomies)
pub fn neg_u9_the_lifecycle_reason_club_decision_is_not_a_decision_reason_two_t_test() {
  assert base.decision_reasons(Some("[\"club_decision\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"club_decision\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U9 the LIFECYCLE reason "trial_completed" is not a decision reason (two taxonomies)
pub fn neg_u9_the_lifecycle_reason_trial_completed_is_not_a_decision_reason_two_test() {
  assert base.decision_reasons(Some("[\"trial_completed\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"trial_completed\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U9 the LIFECYCLE reason "case_closed" is not a decision reason (two taxonomies)
pub fn neg_u9_the_lifecycle_reason_case_closed_is_not_a_decision_reason_two_tax_test() {
  assert base.decision_reasons(Some("[\"case_closed\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"case_closed\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "race" is refused
pub fn neg_u10_the_prohibited_reason_race_is_refused_test() {
  assert base.decision_reasons(Some("[\"race\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"race\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "ethnicity" is refused
pub fn neg_u10_the_prohibited_reason_ethnicity_is_refused_test() {
  assert base.decision_reasons(Some("[\"ethnicity\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"ethnicity\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "skin_colour" is refused
pub fn neg_u10_the_prohibited_reason_skin_colour_is_refused_test() {
  assert base.decision_reasons(Some("[\"skin_colour\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"skin_colour\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "skin_color" is refused
pub fn neg_u10_the_prohibited_reason_skin_color_is_refused_test() {
  assert base.decision_reasons(Some("[\"skin_color\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"skin_color\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "nationality" is refused
pub fn neg_u10_the_prohibited_reason_nationality_is_refused_test() {
  assert base.decision_reasons(Some("[\"nationality\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"nationality\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U10 the prohibited reason "nationality_preference" is refused
pub fn neg_u10_the_prohibited_reason_nationality_preference_is_refused_test() {
  assert base.decision_reasons(Some("[\"nationality_preference\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"A protected characteristic can never be recorded as a recruitment reason.\",\"prohibited\":[\"nationality_preference\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "constructor" is not a reason code
pub fn neg_u11_constructor_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"constructor\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"constructor\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "prototype" is not a reason code
pub fn neg_u11_prototype_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"prototype\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"prototype\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "__proto__" is not a reason code
pub fn neg_u11_proto_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"__proto__\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"__proto__\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "toString" is not a reason code
pub fn neg_u11_tostring_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"toString\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"tostring\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "valueOf" is not a reason code
pub fn neg_u11_valueof_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"valueOf\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"valueof\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U11 "hasOwnProperty" is not a reason code
pub fn neg_u11_hasownproperty_is_not_a_reason_code_test() {
  assert base.decision_reasons(Some("[\"hasOwnProperty\"]"), None)
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Reasons must come from the ScoutBox recruitment reason taxonomy.\",\"unknown\":[\"hasownproperty\"]}",
    ))
}

// decisions: validateDecisionReasons — [neg] U12 {} is not a list of reason codes
pub fn neg_u12_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("{}"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 "tactical_fit" is not a list of reason codes
pub fn neg_u12_tactical_fit_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("\"tactical_fit\""), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 1 is not a list of reason codes
pub fn neg_u12_1_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("1"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 true is not a list of reason codes
pub fn neg_u12_true_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("true"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 [1] is not a list of reason codes
pub fn neg_u12_1_is_not_a_list_of_reason_codes_2_test() {
  assert base.decision_reasons(Some("[1]"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 [{}] is not a list of reason codes
pub fn neg_u12_is_not_a_list_of_reason_codes_2_test() {
  assert base.decision_reasons(Some("[{}]"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 [{"toString":1}] is not a list of reason codes
pub fn neg_u12_tostring_1_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("[{\"toString\":1}]"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U12 [null,2] is not a list of reason codes
pub fn neg_u12_null_2_is_not_a_list_of_reason_codes_test() {
  assert base.decision_reasons(Some("[null,2]"), None)
    == Error(base.ByShape("DECISION_REASON_INVALID"))
}

// decisions: validateDecisionReasons — [neg] U13 seven reasons is over the limit of six
pub fn neg_u13_seven_reasons_is_over_the_limit_of_six_test() {
  assert base.decision_reasons(
      Some(
        "[\"technical_fit\",\"tactical_fit\",\"physical_profile\",\"position_need\",\"development_upside\",\"insufficient_full_match\",\"reference_missing\"]",
      ),
      None,
    )
    == Error(base.ByRule(
      "{\"error\":\"DECISION_REASON_INVALID\",\"message\":\"Record up to six reasons.\"}",
    ))
}

// decisions: validateNote — U14 a note is optional, trimmed and stripped of markup
pub fn u14_a_note_is_optional_trimmed_and_stripped_of_markup_test() {
  assert base.decision_note("note", 2000, None) == Ok(None)
}

// decisions: validateNote — U14 a note is optional, trimmed and stripped of markup
pub fn u14_a_note_is_optional_trimmed_and_stripped_of_markup_2_test() {
  assert base.decision_note("note", 2000, Some("\"\"")) == Ok(None)
}

// decisions: validateNote — U14 a note is optional, trimmed and stripped of markup
pub fn u14_a_note_is_optional_trimmed_and_stripped_of_markup_3_test() {
  assert base.decision_note("note", 2000, Some("\"  <b>Fine</b> \""))
    == Ok(Some("Fine"))
}

// decisions: validateNote — [neg] U15 the note limit is 2000, inclusive
pub fn neg_u15_the_note_limit_is_2000_inclusive_test() {
  assert base.decision_note(
      "note",
      2000,
      Some(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      ),
    )
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U15 the note limit is 2000, inclusive
pub fn neg_u15_the_note_limit_is_2000_inclusive_2_test() {
  assert base.decision_note(
      "note",
      2000,
      Some(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      ),
    )
    == Ok(Some(
      "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ))
}

// decisions: validateNote — [neg] U16 a note of type 1 is not text
pub fn neg_u16_a_note_of_type_1_is_not_text_test() {
  assert base.decision_note("note", 2000, Some("1"))
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U16 a note of type true is not text
pub fn neg_u16_a_note_of_type_true_is_not_text_test() {
  assert base.decision_note("note", 2000, Some("true"))
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U16 a note of type {} is not text
pub fn neg_u16_a_note_of_type_is_not_text_test() {
  assert base.decision_note("note", 2000, Some("{}"))
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U16 a note of type [] is not text
pub fn neg_u16_a_note_of_type_is_not_text_2_test() {
  assert base.decision_note("note", 2000, Some("[]"))
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U16 a note of type 1.5 is not text
pub fn neg_u16_a_note_of_type_1_5_is_not_text_test() {
  assert base.decision_note("note", 2000, Some("1.5"))
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateNote — [neg] U17 the supersession reason limit is 500
pub fn neg_u17_the_supersession_reason_limit_is_500_test() {
  assert base.decision_note(
      "supersessionReason",
      500,
      Some(
        "\"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr\"",
      ),
    )
    == Error(base.ByShape("DECISION_CONTENT_INVALID"))
}

// decisions: validateEvidenceRefShapes — U18 references dedupe and carry only { kind, id }
pub fn u18_references_dedupe_and_carry_only_kind_id_test() {
  assert base.decision_refs(None) == Ok([])
}

// decisions: validateEvidenceRefShapes — [neg] U19 {} is not a reference list
pub fn neg_u19_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("{}"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 "x" is not a reference list
pub fn neg_u19_x_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("\"x\""))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 1 is not a reference list
pub fn neg_u19_1_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("1"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"assessment"}] is not a reference list
pub fn neg_u19_kind_assessment_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"assessment\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"id":"a"}] is not a reference list
pub fn neg_u19_id_a_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"id\":\"a\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"rating","id":"a"}] is not a reference list
pub fn neg_u19_kind_rating_id_a_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"rating\",\"id\":\"a\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"assessment","id":""}] is not a reference list
pub fn neg_u19_kind_assessment_id_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"assessment\",\"id\":\"\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"assessment","id":1}] is not a reference list
pub fn neg_u19_kind_assessment_id_1_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"assessment\",\"id\":1}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [null] is not a reference list
pub fn neg_u19_null_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[null]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 ["assessment:a"] is not a reference list
pub fn neg_u19_assessment_a_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[\"assessment:a\"]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"__proto__","id":"a"}] is not a reference list
pub fn neg_u19_kind_proto_id_a_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"__proto__\",\"id\":\"a\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U19 [{"kind":"constructor","id":"a"}] is not a reference list
pub fn neg_u19_kind_constructor_id_a_is_not_a_reference_list_test() {
  assert base.decision_refs(Some("[{\"kind\":\"constructor\",\"id\":\"a\"}]"))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — [neg] U20 fifty-one references is over the limit
pub fn neg_u20_fifty_one_references_is_over_the_limit_test() {
  assert base.decision_refs(Some(
      "[{\"kind\":\"assessment\",\"id\":\"a0\"},{\"kind\":\"assessment\",\"id\":\"a1\"},{\"kind\":\"assessment\",\"id\":\"a2\"},{\"kind\":\"assessment\",\"id\":\"a3\"},{\"kind\":\"assessment\",\"id\":\"a4\"},{\"kind\":\"assessment\",\"id\":\"a5\"},{\"kind\":\"assessment\",\"id\":\"a6\"},{\"kind\":\"assessment\",\"id\":\"a7\"},{\"kind\":\"assessment\",\"id\":\"a8\"},{\"kind\":\"assessment\",\"id\":\"a9\"},{\"kind\":\"assessment\",\"id\":\"a10\"},{\"kind\":\"assessment\",\"id\":\"a11\"},{\"kind\":\"assessment\",\"id\":\"a12\"},{\"kind\":\"assessment\",\"id\":\"a13\"},{\"kind\":\"assessment\",\"id\":\"a14\"},{\"kind\":\"assessment\",\"id\":\"a15\"},{\"kind\":\"assessment\",\"id\":\"a16\"},{\"kind\":\"assessment\",\"id\":\"a17\"},{\"kind\":\"assessment\",\"id\":\"a18\"},{\"kind\":\"assessment\",\"id\":\"a19\"},{\"kind\":\"assessment\",\"id\":\"a20\"},{\"kind\":\"assessment\",\"id\":\"a21\"},{\"kind\":\"assessment\",\"id\":\"a22\"},{\"kind\":\"assessment\",\"id\":\"a23\"},{\"kind\":\"assessment\",\"id\":\"a24\"},{\"kind\":\"assessment\",\"id\":\"a25\"},{\"kind\":\"assessment\",\"id\":\"a26\"},{\"kind\":\"assessment\",\"id\":\"a27\"},{\"kind\":\"assessment\",\"id\":\"a28\"},{\"kind\":\"assessment\",\"id\":\"a29\"},{\"kind\":\"assessment\",\"id\":\"a30\"},{\"kind\":\"assessment\",\"id\":\"a31\"},{\"kind\":\"assessment\",\"id\":\"a32\"},{\"kind\":\"assessment\",\"id\":\"a33\"},{\"kind\":\"assessment\",\"id\":\"a34\"},{\"kind\":\"assessment\",\"id\":\"a35\"},{\"kind\":\"assessment\",\"id\":\"a36\"},{\"kind\":\"assessment\",\"id\":\"a37\"},{\"kind\":\"assessment\",\"id\":\"a38\"},{\"kind\":\"assessment\",\"id\":\"a39\"},{\"kind\":\"assessment\",\"id\":\"a40\"},{\"kind\":\"assessment\",\"id\":\"a41\"},{\"kind\":\"assessment\",\"id\":\"a42\"},{\"kind\":\"assessment\",\"id\":\"a43\"},{\"kind\":\"assessment\",\"id\":\"a44\"},{\"kind\":\"assessment\",\"id\":\"a45\"},{\"kind\":\"assessment\",\"id\":\"a46\"},{\"kind\":\"assessment\",\"id\":\"a47\"},{\"kind\":\"assessment\",\"id\":\"a48\"},{\"kind\":\"assessment\",\"id\":\"a49\"},{\"kind\":\"assessment\",\"id\":\"a50\"}]",
    ))
    == Error(base.ByShape("DECISION_EVIDENCE_INVALID"))
}

// decisions: validateEvidenceRefShapes — U20b fifty is the limit, inclusive
pub fn u20b_fifty_is_the_limit_inclusive_test() {
  assert base.decision_refs(Some(
      "[{\"kind\":\"assessment\",\"id\":\"a0\"},{\"kind\":\"assessment\",\"id\":\"a1\"},{\"kind\":\"assessment\",\"id\":\"a2\"},{\"kind\":\"assessment\",\"id\":\"a3\"},{\"kind\":\"assessment\",\"id\":\"a4\"},{\"kind\":\"assessment\",\"id\":\"a5\"},{\"kind\":\"assessment\",\"id\":\"a6\"},{\"kind\":\"assessment\",\"id\":\"a7\"},{\"kind\":\"assessment\",\"id\":\"a8\"},{\"kind\":\"assessment\",\"id\":\"a9\"},{\"kind\":\"assessment\",\"id\":\"a10\"},{\"kind\":\"assessment\",\"id\":\"a11\"},{\"kind\":\"assessment\",\"id\":\"a12\"},{\"kind\":\"assessment\",\"id\":\"a13\"},{\"kind\":\"assessment\",\"id\":\"a14\"},{\"kind\":\"assessment\",\"id\":\"a15\"},{\"kind\":\"assessment\",\"id\":\"a16\"},{\"kind\":\"assessment\",\"id\":\"a17\"},{\"kind\":\"assessment\",\"id\":\"a18\"},{\"kind\":\"assessment\",\"id\":\"a19\"},{\"kind\":\"assessment\",\"id\":\"a20\"},{\"kind\":\"assessment\",\"id\":\"a21\"},{\"kind\":\"assessment\",\"id\":\"a22\"},{\"kind\":\"assessment\",\"id\":\"a23\"},{\"kind\":\"assessment\",\"id\":\"a24\"},{\"kind\":\"assessment\",\"id\":\"a25\"},{\"kind\":\"assessment\",\"id\":\"a26\"},{\"kind\":\"assessment\",\"id\":\"a27\"},{\"kind\":\"assessment\",\"id\":\"a28\"},{\"kind\":\"assessment\",\"id\":\"a29\"},{\"kind\":\"assessment\",\"id\":\"a30\"},{\"kind\":\"assessment\",\"id\":\"a31\"},{\"kind\":\"assessment\",\"id\":\"a32\"},{\"kind\":\"assessment\",\"id\":\"a33\"},{\"kind\":\"assessment\",\"id\":\"a34\"},{\"kind\":\"assessment\",\"id\":\"a35\"},{\"kind\":\"assessment\",\"id\":\"a36\"},{\"kind\":\"assessment\",\"id\":\"a37\"},{\"kind\":\"assessment\",\"id\":\"a38\"},{\"kind\":\"assessment\",\"id\":\"a39\"},{\"kind\":\"assessment\",\"id\":\"a40\"},{\"kind\":\"assessment\",\"id\":\"a41\"},{\"kind\":\"assessment\",\"id\":\"a42\"},{\"kind\":\"assessment\",\"id\":\"a43\"},{\"kind\":\"assessment\",\"id\":\"a44\"},{\"kind\":\"assessment\",\"id\":\"a45\"},{\"kind\":\"assessment\",\"id\":\"a46\"},{\"kind\":\"assessment\",\"id\":\"a47\"},{\"kind\":\"assessment\",\"id\":\"a48\"},{\"kind\":\"assessment\",\"id\":\"a49\"}]",
    ))
    == Ok([
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a0"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a1"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a2"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a3"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a4"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a5"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a6"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a7"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a8"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a9"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a10"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a11"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a12"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a13"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a14"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a15"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a16"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a17"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a18"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a19"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a20"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a21"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a22"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a23"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a24"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a25"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a26"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a27"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a28"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a29"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a30"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a31"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a32"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a33"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a34"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a35"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a36"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a37"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a38"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a39"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a40"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a41"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a42"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a43"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a44"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a45"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a46"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a47"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a48"),
      decisions.RefShape(kind: decision_evidence_kind.Assessment, id: "a49"),
    ])
}

// decisions: chainHead — U26 the chain head is the one row nothing supersedes
pub fn u26_the_chain_head_is_the_one_row_nothing_supersedes_test() {
  assert option.map(
      decisions.chain_head([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d-1"),
              room_id: id.recruitment_case("c"),
              org_id: id.org("o"),
              recommendation: room_decisions.Shortlist,
              note: Some("n"),
              by_user_id: Some(id.org_user("u")),
              by_name: Some("U"),
              by_role: None,
              created_at: 1,
              superseded_by_id: Some(id.room_decision("d-2")),
            ),
            reason_codes: ["tactical_fit"],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: [],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("d-2"),
              room_id: id.recruitment_case("c"),
              org_id: id.org("o"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              outcome: Some(decision_outcome.Progress),
              recommendation: room_decisions.Offer,
              note: None,
              by_user_id: Some(id.org_user("u")),
              by_name: Some("U"),
              by_role: None,
              created_at: 2,
              supersedes_id: Some(id.room_decision("d-1")),
              superseded_by_id: None,
              rev: Some(1),
              lifecycle_action: None,
              lifecycle_from: None,
              lifecycle_to: None,
              lifecycle_applied: Some(True),
              lifecycle_reason: None,
              lifecycle_at: None,
            ),
            reason_codes: [],
            snapshot: None,
          ),
          refs: [
            decisions.Ref(
              kind: decision_evidence_kind.Assessment,
              id: "a",
              meta: json.null(),
            ),
          ],
          assessment_ids: [],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == Some(id.room_decision("d-2"))
}

// decisions: chainHead — U26 the chain head is the one row nothing supersedes
pub fn u26_the_chain_head_is_the_one_row_nothing_supersedes_2_test() {
  assert option.map(decisions.chain_head([]), fn(d) { d.base.row.id }) == None
}

// decisions: decisionView — U27 a legacy advisory row reads as an advisory recommendation, never as a formal decision
pub fn u27_a_legacy_advisory_row_reads_as_an_advisory_recommendation_never_as_a_test() {
  assert json.to_string(decisions.view(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-1"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            recommendation: room_decisions.Shortlist,
            note: Some("n"),
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 1,
            superseded_by_id: Some(id.room_decision("d-2")),
          ),
          reason_codes: ["tactical_fit"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: [],
      ),
      False,
    ))
    == "{\"id\":\"d-1\",\"kind\":\"recommendation\",\"state\":\"final\",\"outcome\":null,\"outcomeLabel\":null,\"recommendation\":\"shortlist\",\"reasonCodes\":[\"tactical_fit\"],\"note\":\"n\",\"hasNote\":true,\"by\":{\"userId\":\"u\",\"name\":\"U\",\"role\":null},\"createdAt\":1,\"finalizedAt\":1,\"rev\":1,\"supersedes\":null,\"supersededById\":\"d-2\",\"supersession\":null,\"evidenceRefs\":[],\"evidenceCount\":0,\"assessmentSummary\":null,\"lifecycle\":null,\"trigger\":null,\"snapshot\":null,\"policyVersion\":null}"
}

// decisions: draftView — U30 a draft is labelled as not a decision
pub fn u30_a_draft_is_labelled_as_not_a_decision_test() {
  assert json.to_string(decisions.draft_view(None)) == "null"
}

// decisions: decisionIntegrity — U31 sound rows have no problems; legacy rows are not judged here
pub fn u31_sound_rows_have_no_problems_legacy_rows_are_not_judged_here_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      id.org("o"),
      id.recruitment_case("c"),
    )
    == []
}

// decisions: decisionIntegrity — [neg] U32 a formal row with missing_actor is named, not repaired
pub fn neg_u32_a_formal_row_with_missing_actor_is_named_not_repaired_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      id.org("o"),
      id.recruitment_case("c"),
    )
    == ["missing_actor"]
}

// decisions: decisionIntegrity — [neg] U32 a formal row with missing_case is named, not repaired
pub fn neg_u32_a_formal_row_with_missing_case_is_named_not_repaired_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("other"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      id.org("o"),
      id.recruitment_case("c"),
    )
    == ["missing_case"]
}

// decisions: decisionIntegrity — [neg] U32 a formal row with org_mismatch is named, not repaired
pub fn neg_u32_a_formal_row_with_org_mismatch_is_named_not_repaired_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      id.org("o"),
      id.recruitment_case("c"),
    )
    == ["org_mismatch"]
}

// decisions: decisionIntegrity — [neg] U32 a formal row with invalid_reason_code is named, not repaired
pub fn neg_u32_a_formal_row_with_invalid_reason_code_is_named_not_repaired_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: ["race"],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      id.org("o"),
      id.recruitment_case("c"),
    )
    == ["invalid_reason_code"]
}

// decisions: duplicateFinalHeads — [neg] U34 two formal rows without a successor are corruption, not a tie
pub fn neg_u34_two_formal_rows_without_a_successor_are_corruption_not_a_tie_test() {
  assert decisions.duplicate_heads([
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-3"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 3,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
    ])
    == [id.room_decision("d-2"), id.room_decision("d-3")]
}

// decisions: duplicateFinalHeads — [neg] U34 two formal rows without a successor are corruption, not a tie
pub fn neg_u34_two_formal_rows_without_a_successor_are_corruption_not_a_tie_2_test() {
  assert decisions.duplicate_heads([
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-1"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            recommendation: room_decisions.Shortlist,
            note: Some("n"),
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 1,
            superseded_by_id: Some(id.room_decision("d-2")),
          ),
          reason_codes: ["tactical_fit"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: [],
      ),
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("d-2"),
            room_id: id.recruitment_case("c"),
            org_id: id.org("o"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("u")),
            by_name: Some("U"),
            by_role: None,
            created_at: 2,
            supersedes_id: Some(id.room_decision("d-1")),
            superseded_by_id: None,
            rev: Some(1),
            lifecycle_action: None,
            lifecycle_from: None,
            lifecycle_to: None,
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: None,
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "a",
            meta: json.null(),
          ),
        ],
        assessment_ids: [],
      ),
    ])
    == []
}

// decisions: summariseAssessments — U37 unanimity is named only with more than one assessor; one assessor is neither
pub fn u37_unanimity_is_named_only_with_more_than_one_assessor_one_assessor_is_test() {
  assert json.to_string(decisions.summary_json(decisions.summarise([], 0)))
    == "{\"submitted\":0,\"drafts\":0,\"withheld\":0,\"verdicts\":{\"sign\":0,\"monitor\":0,\"pass\":0,\"none\":0},\"disagreement\":null,\"assessments\":[],\"note\":\"Independent assessments, summarised as counts. ScoutBox does not average them and does not decide.\"}"
}

// decisions: assessmentSnapshot — U38 the snapshot a formal row keeps is ids and counts
pub fn u38_the_snapshot_a_formal_row_keeps_is_ids_and_counts_test() {
  assert decisions.snapshot_of(
      decisions.Summary(
        submitted: [
          decisions.Counted(
            row: assessments.Row(
              ..base.counted().row,
              id: id.assessment("x"),
              scout_name: "x",
              scout_user_id: id.org_user("x"),
              state: assessments.Submitted,
              submitted_at: Some(1),
              recommendation_verdict: Some(case_outcome.Sign),
              context_trial_id: None,
              context_trial_session_id: None,
            ),
            rated: 3,
            not_observed: 1,
            confidence: #(1, 1, 1),
            evidence_refs: 2,
          ),
          decisions.Counted(
            row: assessments.Row(
              ..base.counted().row,
              id: id.assessment("y"),
              scout_name: "y",
              scout_user_id: id.org_user("y"),
              state: assessments.Submitted,
              submitted_at: Some(1),
              recommendation_verdict: Some(case_outcome.Pass),
              context_trial_id: None,
              context_trial_session_id: None,
            ),
            rated: 3,
            not_observed: 1,
            confidence: #(1, 1, 1),
            evidence_refs: 2,
          ),
        ],
        drafts: 1,
        withheld: 1,
        verdicts: [#("sign", 1), #("monitor", 0), #("pass", 1), #("none", 0)],
      ),
    )
    == decisions.AssessmentSnapshot(
      submitted: 2,
      withheld: 1,
      verdicts: [#("sign", 1), #("monitor", 0), #("pass", 1), #("none", 0)],
      ids: [id.assessment("x"), id.assessment("y")],
    )
}

// decisions: decisionRequirements — U39 readiness counts what exists and says none of it is required — zero assessments and zero trials do not bar a decision
pub fn u39_readiness_counts_what_exists_and_says_none_of_it_is_required_zero_as_test() {
  assert json.to_string(
      decisions.requirements_json(
        role: Some(room_rules.RoomLead),
        can_finalize: True,
        status: room_status.Shortlisted,
        submitted_assessments: 0,
        completed_trials: 0,
        blocked: False,
        subject_removed: False,
        has_draft: False,
        has_final: False,
        outcomes: [],
      ),
    )
    == "{\"canDraft\":true,\"canFinalize\":true,\"role\":\"room_lead\",\"blocked\":false,\"subjectRemoved\":false,\"hasDraft\":false,\"hasFinal\":false,\"inputs\":{\"submittedAssessments\":0,\"completedTrials\":0,\"note\":\"Inputs are counts of what exists. None of them is required by policy, and none of them decides anything.\"},\"outcomes\":[],\"status\":\"shortlisted\",\"note\":\"A formal decision is an explicit human act by a room lead or recruitment lead. ScoutBox never takes it.\"}"
}

// decisionsPersistence: decisionIntegrity — [neg] the pure integrity check agrees row by row (all eight defects)
pub fn neg_the_pure_integrity_check_agrees_row_by_row_all_eight_defects_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-bad-actor"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: Some("First formal."),
            created_at: 1_800_000_000_003,
            finalized_at: Some(1_800_000_000_010),
            trigger: Some("decision:finalize"),
            client_key: Some("fin-1"),
            supersedes_id: None,
            superseded_by_id: Some(id.room_decision("rdec-formal-2")),
            rev: Some(2),
            rev_at: Some(1_800_000_000_020),
            finalize_key: Some("fin-1"),
            finalize_fp: Some("{\"fixture\":1}"),
            draft_key: Some("draft-1"),
            draft_fp: Some("{\"fixture\":1}"),
            draft_id: Some("rdraft-1"),
            lifecycle_action: Some("considerOffer"),
            lifecycle_from: Some(room_status.Shortlisted),
            lifecycle_to: Some(room_status.OfferConsideration),
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: Some(1_800_000_000_010),
            policy_version: Some(1),
            assessments_submitted: Some(1),
            assessments_withheld: Some(0),
            assessment_verdicts_json: Some(
              "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
            ),
          ),
          reason_codes: ["position_need"],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "ass-1",
            meta: json.object([
              #("scoutName", json.string("S")),
              #("submittedAt", json.int(1_800_000_000_000)),
              #("verdict", json.string("sign")),
              #("trialId", json.null()),
            ]),
          ),
        ],
        assessment_ids: ["ass-1"],
      ),
      id.org("org-x"),
      id.recruitment_case("case-x"),
    )
    == ["missing_actor"]
}

// decisionsPersistence: decisionIntegrity — [neg] the pure integrity check agrees row by row (all eight defects)
pub fn neg_the_pure_integrity_check_agrees_row_by_row_all_eight_defects_2_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-bad-code"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Progress),
            recommendation: room_decisions.Offer,
            note: Some("First formal."),
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_005,
            finalized_at: Some(1_800_000_000_010),
            trigger: Some("decision:finalize"),
            client_key: Some("fin-1"),
            supersedes_id: None,
            superseded_by_id: Some(id.room_decision("rdec-formal-2")),
            rev: Some(2),
            rev_at: Some(1_800_000_000_020),
            finalize_key: Some("fin-1"),
            finalize_fp: Some("{\"fixture\":1}"),
            draft_key: Some("draft-1"),
            draft_fp: Some("{\"fixture\":1}"),
            draft_id: Some("rdraft-1"),
            lifecycle_action: Some("considerOffer"),
            lifecycle_from: Some(room_status.Shortlisted),
            lifecycle_to: Some(room_status.OfferConsideration),
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: Some(1_800_000_000_010),
            policy_version: Some(1),
            assessments_submitted: Some(1),
            assessments_withheld: Some(0),
            assessment_verdicts_json: Some(
              "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
            ),
          ),
          reason_codes: ["race"],
          snapshot: None,
        ),
        refs: [
          decisions.Ref(
            kind: decision_evidence_kind.Assessment,
            id: "ass-1",
            meta: json.object([
              #("scoutName", json.string("S")),
              #("submittedAt", json.int(1_800_000_000_000)),
              #("verdict", json.string("sign")),
              #("trialId", json.null()),
            ]),
          ),
        ],
        assessment_ids: ["ass-1"],
      ),
      id.org("org-x"),
      id.recruitment_case("case-x"),
    )
    == ["invalid_reason_code"]
}

// decisionsPersistence: decisionIntegrity — [neg] the pure integrity check agrees row by row (all eight defects)
pub fn neg_the_pure_integrity_check_agrees_row_by_row_all_eight_defects_3_test() {
  assert decisions.integrity(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-formal-2"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Hold),
            recommendation: room_decisions.ContinueWatching,
            note: Some("Second formal."),
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_020,
            finalized_at: Some(1_800_000_000_020),
            trigger: Some("decision:finalize"),
            client_key: Some("fin-2"),
            supersedes_id: Some(id.room_decision("rdec-formal-1")),
            superseded_by_id: None,
            supersession_of_id: Some(id.room_decision("rdec-formal-1")),
            supersession_reason: Some("Budget review."),
            rev: Some(1),
            rev_at: Some(1_800_000_000_020),
            finalize_key: Some("fin-2"),
            finalize_fp: Some("{\"fixture\":2}"),
            draft_id: Some("rdraft-2"),
            lifecycle_action: Some("holdCase"),
            lifecycle_from: Some(room_status.OfferConsideration),
            lifecycle_to: Some(room_status.OnHold),
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: Some(1_800_000_000_020),
            policy_version: Some(1),
            assessments_submitted: Some(1),
            assessments_withheld: Some(0),
            assessment_verdicts_json: Some(
              "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
            ),
          ),
          reason_codes: ["timing"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: ["ass-1"],
      ),
      id.org("org-x"),
      id.recruitment_case("case-x"),
    )
    == []
}

// decisionsPersistence: duplicateFinalHeads — [neg] the pure check names both heads (the chain reader alone would silently pick the later one)
pub fn neg_the_pure_check_names_both_heads_the_chain_reader_alone_would_silentl_test() {
  assert decisions.duplicate_heads([
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-head-a"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Hold),
            recommendation: room_decisions.ContinueWatching,
            note: Some("Second formal."),
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_020,
            finalized_at: Some(1_800_000_000_020),
            trigger: Some("decision:finalize"),
            client_key: Some("fin-2"),
            supersedes_id: None,
            superseded_by_id: None,
            supersession_of_id: Some(id.room_decision("rdec-formal-1")),
            supersession_reason: Some("Budget review."),
            rev: Some(1),
            rev_at: Some(1_800_000_000_020),
            finalize_key: Some("fin-2"),
            finalize_fp: Some("{\"fixture\":2}"),
            draft_id: Some("rdraft-2"),
            lifecycle_action: Some("holdCase"),
            lifecycle_from: Some(room_status.OfferConsideration),
            lifecycle_to: Some(room_status.OnHold),
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: Some(1_800_000_000_020),
            policy_version: Some(1),
            assessments_submitted: Some(1),
            assessments_withheld: Some(0),
            assessment_verdicts_json: Some(
              "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
            ),
          ),
          reason_codes: ["timing"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: ["ass-1"],
      ),
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-head-b"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            kind: Some(room_decisions.Formal),
            state: Some(room_decisions.Final),
            outcome: Some(decision_outcome.Hold),
            recommendation: room_decisions.ContinueWatching,
            note: Some("Second formal."),
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_021,
            finalized_at: Some(1_800_000_000_020),
            trigger: Some("decision:finalize"),
            client_key: Some("fin-2"),
            supersedes_id: None,
            superseded_by_id: None,
            supersession_of_id: Some(id.room_decision("rdec-formal-1")),
            supersession_reason: Some("Budget review."),
            rev: Some(1),
            rev_at: Some(1_800_000_000_020),
            finalize_key: Some("fin-2"),
            finalize_fp: Some("{\"fixture\":2}"),
            draft_id: Some("rdraft-2"),
            lifecycle_action: Some("holdCase"),
            lifecycle_from: Some(room_status.OfferConsideration),
            lifecycle_to: Some(room_status.OnHold),
            lifecycle_applied: Some(True),
            lifecycle_reason: None,
            lifecycle_at: Some(1_800_000_000_020),
            policy_version: Some(1),
            assessments_submitted: Some(1),
            assessments_withheld: Some(0),
            assessment_verdicts_json: Some(
              "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
            ),
          ),
          reason_codes: ["timing"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: ["ass-1"],
      ),
    ])
    == [id.room_decision("rdec-head-a"), id.room_decision("rdec-head-b")]
}

// decisionsPersistence: chainHead — [neg] the pure check names both heads (the chain reader alone would silently pick the later one)
pub fn neg_the_pure_check_names_both_heads_the_chain_reader_alone_would_silentl_2_test() {
  assert option.map(
      decisions.chain_head([
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("rdec-head-a"),
              room_id: id.recruitment_case("case-x"),
              org_id: id.org("org-x"),
              player_id: id.player("pl-x"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              outcome: Some(decision_outcome.Hold),
              recommendation: room_decisions.ContinueWatching,
              note: Some("Second formal."),
              by_user_id: Some(id.org_user("usr-owner")),
              by_name: Some("Owner"),
              by_role: Some("Head of Recruitment"),
              created_at: 1_800_000_000_020,
              finalized_at: Some(1_800_000_000_020),
              trigger: Some("decision:finalize"),
              client_key: Some("fin-2"),
              supersedes_id: None,
              superseded_by_id: None,
              supersession_of_id: Some(id.room_decision("rdec-formal-1")),
              supersession_reason: Some("Budget review."),
              rev: Some(1),
              rev_at: Some(1_800_000_000_020),
              finalize_key: Some("fin-2"),
              finalize_fp: Some("{\"fixture\":2}"),
              draft_id: Some("rdraft-2"),
              lifecycle_action: Some("holdCase"),
              lifecycle_from: Some(room_status.OfferConsideration),
              lifecycle_to: Some(room_status.OnHold),
              lifecycle_applied: Some(True),
              lifecycle_reason: None,
              lifecycle_at: Some(1_800_000_000_020),
              policy_version: Some(1),
              assessments_submitted: Some(1),
              assessments_withheld: Some(0),
              assessment_verdicts_json: Some(
                "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
              ),
            ),
            reason_codes: ["timing"],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: ["ass-1"],
        ),
        decisions.Decision(
          base: room_records.Decision(
            row: room_decisions.Row(
              ..base.decision().base.row,
              id: id.room_decision("rdec-head-b"),
              room_id: id.recruitment_case("case-x"),
              org_id: id.org("org-x"),
              player_id: id.player("pl-x"),
              kind: Some(room_decisions.Formal),
              state: Some(room_decisions.Final),
              outcome: Some(decision_outcome.Hold),
              recommendation: room_decisions.ContinueWatching,
              note: Some("Second formal."),
              by_user_id: Some(id.org_user("usr-owner")),
              by_name: Some("Owner"),
              by_role: Some("Head of Recruitment"),
              created_at: 1_800_000_000_021,
              finalized_at: Some(1_800_000_000_020),
              trigger: Some("decision:finalize"),
              client_key: Some("fin-2"),
              supersedes_id: None,
              superseded_by_id: None,
              supersession_of_id: Some(id.room_decision("rdec-formal-1")),
              supersession_reason: Some("Budget review."),
              rev: Some(1),
              rev_at: Some(1_800_000_000_020),
              finalize_key: Some("fin-2"),
              finalize_fp: Some("{\"fixture\":2}"),
              draft_id: Some("rdraft-2"),
              lifecycle_action: Some("holdCase"),
              lifecycle_from: Some(room_status.OfferConsideration),
              lifecycle_to: Some(room_status.OnHold),
              lifecycle_applied: Some(True),
              lifecycle_reason: None,
              lifecycle_at: Some(1_800_000_000_020),
              policy_version: Some(1),
              assessments_submitted: Some(1),
              assessments_withheld: Some(0),
              assessment_verdicts_json: Some(
                "{\"sign\":1,\"monitor\":0,\"pass\":0,\"none\":0}",
              ),
            ),
            reason_codes: ["timing"],
            snapshot: None,
          ),
          refs: [],
          assessment_ids: ["ass-1"],
        ),
      ]),
      fn(d) { d.base.row.id },
    )
    == Some(id.room_decision("rdec-head-b"))
}

// decisionsPersistence: isFormal — [neg] no legacy row is formal, whatever it recommends
pub fn neg_no_legacy_row_is_formal_whatever_it_recommends_test() {
  assert decisions.is_formal(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-l1"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            recommendation: room_decisions.Shortlist,
            note: Some("Legacy opinion."),
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_000,
            trigger: Some("decision"),
            supersedes_id: None,
            superseded_by_id: Some(id.room_decision("rdec-l2")),
            client_key: Some("legacy-key"),
          ),
          reason_codes: ["tactical_fit"],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: [],
      ),
    )
    == False
}

// decisionsPersistence: isFormal — [neg] no legacy row is formal, whatever it recommends
pub fn neg_no_legacy_row_is_formal_whatever_it_recommends_2_test() {
  assert decisions.is_formal(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-l2"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            recommendation: room_decisions.Offer,
            note: None,
            by_user_id: Some(id.org_user("usr-owner")),
            by_name: Some("Owner"),
            by_role: Some("Head of Recruitment"),
            created_at: 1_800_000_000_001,
            trigger: Some("decision"),
            supersedes_id: Some(id.room_decision("rdec-l1")),
            superseded_by_id: None,
            client_key: Some("legacy-key"),
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: [],
      ),
    )
    == False
}

// decisionsPersistence: isFormal — [neg] no legacy row is formal, whatever it recommends
pub fn neg_no_legacy_row_is_formal_whatever_it_recommends_3_test() {
  assert decisions.is_formal(
      decisions.Decision(
        base: room_records.Decision(
          row: room_decisions.Row(
            ..base.decision().base.row,
            id: id.room_decision("rdec-l-odd"),
            room_id: id.recruitment_case("case-x"),
            org_id: id.org("org-x"),
            player_id: id.player("pl-x"),
            recommendation: room_decisions.Shortlist,
            note: Some("Legacy opinion."),
            created_at: 1_800_000_000_000,
            trigger: Some("decision"),
            supersedes_id: None,
            superseded_by_id: Some(id.room_decision("rdec-l1")),
            client_key: Some("legacy-key"),
          ),
          reason_codes: [],
          snapshot: None,
        ),
        refs: [],
        assessment_ids: [],
      ),
    )
    == False
}
