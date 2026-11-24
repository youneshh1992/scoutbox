//// Checks of the rules from the rules suites of recruitment/lifecycle, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/recruitment/lifecycle

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_test() {
  assert lifecycle.is_reason("contact_planned") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_2_test() {
  assert lifecycle.is_reason("contact_made") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_3_test() {
  assert lifecycle.is_reason("player_responded") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_4_test() {
  assert lifecycle.is_reason("trial_progression") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_5_test() {
  assert lifecycle.is_reason("trial_completed") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_6_test() {
  assert lifecycle.is_reason("club_decision") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_7_test() {
  assert lifecycle.is_reason("player_declined") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_8_test() {
  assert lifecycle.is_reason("offer_progression") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_9_test() {
  assert lifecycle.is_reason("offer_accepted_in_scoutbox") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_10_test() {
  assert lifecycle.is_reason("signed_outcome") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_11_test() {
  assert lifecycle.is_reason("rejected") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_12_test() {
  assert lifecycle.is_reason("withdrawn") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_13_test() {
  assert lifecycle.is_reason("on_hold") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_14_test() {
  assert lifecycle.is_reason("hold_resumed") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_15_test() {
  assert lifecycle.is_reason("case_closed") == True
}

// lifecycle: isLifecycleReason — V2 and every published lifecycle code passes the lifecycle predicate
pub fn v2_and_every_published_lifecycle_code_passes_the_lifecycle_predicate_16_test() {
  assert lifecycle.is_reason("case_reopened") == True
}
