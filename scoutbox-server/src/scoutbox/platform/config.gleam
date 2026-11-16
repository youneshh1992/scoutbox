//// Every environment setting the server reads, in one place. Secrets have no defaults in production.

import envoy
import gleam/int
import gleam/result

pub type Config {
  Config(
    port: Int,
    data_dir: String,
    admin_key: String,
    /// Passwordless demo sign-ins and the demo seed: development only.
    dev_logins: Bool,
    quiet_logs: Bool,
    /// TEST_LICENCE_REGISTRY: the synthetic coaching-licence register (e2e/support/CONTRACT.md).
    licence_registry: TestRegistry,
    /// How often the periodic sweeps run: every half second with SCOUTBOX_FAST_SWEEPS=1, else every minute.
    sweep_ms: Int,
  )
}

pub type TestRegistry {
  /// `1`: the synthetic register answers.
  RegistryUp
  /// `down`: it is temporarily unavailable.
  RegistryDown
  /// Unset: no register is configured.
  NoRegistry
}

const dev_admin_key = "scoutbox-admin"

pub fn load() -> Result(Config, String) {
  let production = envoy.get("NODE_ENV") == Ok("production")
  use port <- result.try(case envoy.get("PORT") {
    Error(Nil) -> Ok(4000)
    Ok(text) ->
      int.parse(text) |> result.replace_error("PORT must be a whole number")
  })
  let admin_key = envoy.get("ADMIN_KEY") |> result.unwrap(dev_admin_key)
  use admin_key <- result.try(case production && admin_key == dev_admin_key {
    True ->
      Error(
        "ADMIN_KEY is unset or the development default; the Trust & Safety API would accept a publicly known key",
      )
    False -> Ok(admin_key)
  })
  Ok(
    Config(
      port:,
      data_dir: envoy.get("DATA_DIR") |> result.unwrap("data"),
      admin_key:,
      dev_logins: !production,
      quiet_logs: envoy.get("SCOUTBOX_QUIET_LOGS") == Ok("1"),
      licence_registry: case envoy.get("TEST_LICENCE_REGISTRY") {
        Ok("1") -> RegistryUp
        Ok("down") -> RegistryDown
        _ -> NoRegistry
      },
      sweep_ms: case envoy.get("SCOUTBOX_FAST_SWEEPS") {
        Ok("1") -> 500
        _ -> 60_000
      },
    ),
  )
}
