//// Checks of the rules from the rules suites of agents/adversarial, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/platform/canonical

// adversarial: canonicalJson — G7c canonicalJson is the reason why
pub fn g7c_canonicaljson_is_the_reason_why_test() {
  assert canonical.to_string(
      canonical.Object([#("b", canonical.Int(1)), #("a", canonical.Int(2))]),
    )
    == "{\"a\":2,\"b\":1}"
}

// adversarial: canonicalJson — G7c canonicalJson is the reason why
pub fn g7c_canonicaljson_is_the_reason_why_2_test() {
  assert canonical.to_string(
      canonical.Object([#("a", canonical.Int(2)), #("b", canonical.Int(1))]),
    )
    == "{\"a\":2,\"b\":1}"
}
