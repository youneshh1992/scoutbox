//// The settings at boot: production refuses an unsafe configuration and names every problem's code, as the
//// TypeScript server does (platform/sessionsAndPorts checks ADMIN_KEY_UNSAFE and AGENT_TEST_PROVIDER_IN_PRODUCTION
//// through a real boot). Each test sets the variables it reads and restores them after.

import envoy
import gleam/list
import gleam/string
import scoutbox/platform/config

/// Every variable `config.load` reads that these tests set.
const read = [
  "NODE_ENV", "ADMIN_KEY", "MEDIA_SECRET", "SESSION_TTL_DAYS",
  "AGENT_VERIFICATION_TEST_PROVIDER", "SCOUTBOX_FAULTS", "SCOUTBOX_TEST_CLOCK",
  "ALLOW_DEV_LOGINS", "S3_BUCKET",
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
