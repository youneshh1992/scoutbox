//// Checks of the rules from the rules suites of operations/clubOperations, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/integrations/webhooks

// clubOperations: webhookUrlProblem — loopback allowed under ALLOW_LOCAL_WEBHOOKS=1 (tests only)
pub fn loopback_allowed_under_allow_local_webhooks_1_tests_only_test() {
  assert webhooks.url_problem("http://127.0.0.1:9999/hook", True) == None
}

// clubOperations: webhookUrlProblem — SSRF guard: private 10.x blocked
pub fn ssrf_guard_private_10_x_blocked_test() {
  assert webhooks.url_problem("https://10.0.0.5/hook", True)
    == Some("private/link-local IP ranges are blocked")
}

// clubOperations: webhookUrlProblem — SSRF guard: link-local metadata endpoint blocked
pub fn ssrf_guard_link_local_metadata_endpoint_blocked_test() {
  assert webhooks.url_problem("https://169.254.169.254/latest/meta-data", True)
    == Some("private/link-local IP ranges are blocked")
}

// clubOperations: webhookUrlProblem — SSRF guard: .internal hostnames blocked
pub fn ssrf_guard_internal_hostnames_blocked_test() {
  assert webhooks.url_problem("https://internal-api.company.internal/x", True)
    == Some("internal hostnames are blocked")
}

// clubOperations: webhookUrlProblem — SSRF guard: credentials in URL blocked
pub fn ssrf_guard_credentials_in_url_blocked_test() {
  assert webhooks.url_problem("https://user:pw@example.com/x", True)
    == Some("credentials in the URL are not allowed")
}

// clubOperations: webhookUrlProblem — SSRF guard: non-http(s) schemes blocked
pub fn ssrf_guard_non_http_s_schemes_blocked_test() {
  assert webhooks.url_problem("ftp://example.com/x", True)
    == Some("only http(s) destinations are allowed")
}

// clubOperations: webhookUrlProblem — external destinations must use https
pub fn external_destinations_must_use_https_test() {
  assert webhooks.url_problem("http://example.com/x", True)
    == Some("external destinations must use https")
}
