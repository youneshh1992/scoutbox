//// Checks of the rules from the rules suites of platform/productionHardening, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/platform/limits

// productionHardening: rateLimitedBody — [neg] the limited response names no backend
pub fn neg_the_limited_response_names_no_backend_test() {
  assert limits.limited_body(limits.BriefWrite)
    == [
      #("error", "RATE_LIMITED"),
      #("action", "brief_write"),
      #(
        "message",
        "Too many requests in a short window — wait a moment and try again.",
      ),
    ]
}

// productionHardening: rateLimitedBody — [neg] a limited response says nothing about the subject of the request
pub fn neg_a_limited_response_says_nothing_about_the_subject_of_the_request_test() {
  assert limits.limited_body(limits.NobodyMissedAction)
    == [
      #("error", "RATE_LIMITED"),
      #("action", "nobody_missed_action"),
      #(
        "message",
        "Too many requests in a short window — wait a moment and try again.",
      ),
    ]
}
