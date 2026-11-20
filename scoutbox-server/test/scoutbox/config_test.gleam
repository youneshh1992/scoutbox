//// The settings at boot: production refuses an unsafe configuration and names every problem's code, as the
//// TypeScript server does (platform/sessionsAndPorts checks ADMIN_KEY_UNSAFE and AGENT_TEST_PROVIDER_IN_PRODUCTION
//// through a real boot). Each test sets the variables it reads and restores them after.

import envoy
import gleam/json
import gleam/list
import gleam/string
import scoutbox/platform/config
import scoutbox/platform/operator

/// Every variable `config.load` reads that these tests set.
const read = [
  "NODE_ENV", "ADMIN_KEY", "MEDIA_SECRET", "SESSION_TTL_DAYS",
  "AGENT_VERIFICATION_TEST_PROVIDER", "SCOUTBOX_FAULTS", "SCOUTBOX_TEST_CLOCK",
  "ALLOW_DEV_LOGINS", "S3_BUCKET", "BOX_CAM_TEST_PROVIDER", "SENDGRID_API_KEY",
]

fn with_env(pairs: List(#(String, String)), run: fn() -> a) -> a {
  let before = list.map(read, fn(name) { #(name, envoy.get(name)) })
  list.each(read, envoy.unset)
  list.each(pairs, fn(p) { envoy.set(p.0, p.1) })
  let result = run()
  list.each(before, fn(b) {
    case b.1 {
      Ok(value) -> envoy.set(b.0, value)
      Error(Nil) -> envoy.unset(b.0)
    }
  })
  result
}

const safe_production = [
  #("NODE_ENV", "production"),
  #("ADMIN_KEY", "sweep-production-admin-key-0123"),
  #("MEDIA_SECRET", "synthetic-media-secret-0123456789abcdef"),
]

fn refusal(pairs: List(#(String, String))) -> String {
  let assert Error(reason) = with_env(pairs, config.load)
  reason
}

pub fn a_safe_production_configuration_boots_test() {
  let assert Ok(_) = with_env(safe_production, config.load)
}

pub fn production_names_every_unsafe_setting_test() {
  assert refusal([#("NODE_ENV", "production")])
    == "Refusing to start: MEDIA_SECRET_MISSING, ADMIN_KEY_UNSAFE"
}

pub fn the_admin_key_must_be_the_deployments_own_test() {
  let with_key = fn(key) {
    list.key_set(safe_production, "ADMIN_KEY", key) |> refusal
  }
  assert with_key("scoutbox-admin") == "Refusing to start: ADMIN_KEY_UNSAFE"
  // 15 characters: one short.
  assert with_key("fifteen-chars-x") == "Refusing to start: ADMIN_KEY_UNSAFE"
  let assert Ok(_) =
    with_env(
      list.key_set(safe_production, "ADMIN_KEY", "sixteen-chars-xy"),
      config.load,
    )
}

pub fn development_settings_are_refused_in_production_test() {
  let reason =
    refusal(
      list.append(safe_production, [
        #("AGENT_VERIFICATION_TEST_PROVIDER", "1"),
        #("SCOUTBOX_FAULTS", "retryable:/healthz"),
        #("SCOUTBOX_TEST_CLOCK", "1"),
        #("ALLOW_DEV_LOGINS", "1"),
        #("S3_BUCKET", "media"),
      ]),
    )
  assert reason
    == "Refusing to start: PROVIDER_NOT_IMPLEMENTED, DEV_LOGIN_IN_PRODUCTION, FAULTS_IN_PRODUCTION, TEST_CLOCK_IN_PRODUCTION, AGENT_TEST_PROVIDER_IN_PRODUCTION"
}

pub fn development_ignores_the_production_checks_test() {
  let assert Ok(c) =
    with_env([#("AGENT_VERIFICATION_TEST_PROVIDER", "1")], config.load)
  assert c.admin_key == "scoutbox-admin"
  assert c.dev_logins
}

pub fn the_session_lifetime_is_any_positive_number_of_days_test() {
  let ttl = fn(setting) {
    let assert Ok(c) = with_env([#("SESSION_TTL_DAYS", setting)], config.load)
    c.session_ttl_ms
  }
  let day = 86_400_000
  assert ttl("1") == day
  assert ttl("0.5") == day / 2
  assert ttl(" 7 ") == 7 * day
  // Anything else is the default, as in the TypeScript server.
  assert list.all(["0", "-3", "a week", ""], fn(s) { ttl(s) == 30 * day })
  let assert Ok(c) = with_env([], config.load)
  assert c.session_ttl_ms == 30 * day
  assert !string.is_empty(c.media_key)
}

// ------------------------------------------------------------------------------------ the capability report

/// The capability states a configuration reports, as JSON text (`buildCapabilityReport` in the TypeScript rules
/// suite, §49 and §50).
fn states(pairs: List(#(String, String))) -> String {
  let assert Ok(c) = with_env(pairs, config.load)
  json.to_string(operator.capability_states(c))
}

pub fn the_capability_report_carries_no_secret_value_test() {
  let report =
    states([
      #("NODE_ENV", "production"),
      #("ADMIN_KEY", "sweep-production-admin-key-0123"),
      #("MEDIA_SECRET", "super-secret-value-for-the-report-test-0123"),
      #("SENDGRID_API_KEY", "SG.synthetic-not-a-real-key"),
    ])
  assert !string.contains(report, "super-secret-value")
  assert !string.contains(report, "SG.synthetic")
  assert !string.contains(report, "sweep-production-admin-key")
  assert string.contains(
    report,
    "\"media_signing_secret\":{\"state\":\"configured\"",
  )
  // This server has no SendGrid transport (outbound providers are outside the port), so its mail goes to the
  // outbox whatever key is set, and the report says so; the TypeScript server reports `configured`.
  assert string.contains(
    report,
    "\"email_transport\":{\"state\":\"local_outbox\"",
  )
  assert string.contains(
    report,
    "\"distributed_rate_limit\":{\"state\":\"not_configured\"",
  )
}

pub fn the_simulated_observer_is_test_only_when_it_is_on_test() {
  assert string.contains(
    states([]),
    "\"box_cam_test_provider\":{\"state\":\"not_configured\"",
  )
  assert string.contains(
    states([#("BOX_CAM_TEST_PROVIDER", "1")]),
    "\"box_cam_test_provider\":{\"state\":\"test_only\"",
  )
  assert string.contains(
    states([]),
    "\"media_signing_secret\":{\"state\":\"not_configured\"",
  )
}
