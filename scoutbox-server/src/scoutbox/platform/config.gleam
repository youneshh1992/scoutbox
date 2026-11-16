//// Every environment setting the server reads, in one place. Secrets have no defaults in production.

import envoy
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/secrets

pub type Config {
  Config(
    port: Int,
    data_dir: String,
    admin_key: String,
    /// Passwordless demo sign-ins and the demo seed: development only.
    dev_logins: Bool,
    /// SCOUTBOX_FAULTS: the fault rules at boot (development only).
    fault_rules: String,
    /// SCOUTBOX_SEED_DEMO: load the demo world on a database's first boot. Unset, except in production.
    seed_demo: Bool,
    quiet_logs: Bool,
    /// MEDIA_SECRET, when the deployment set one.
    media_secret: Option(String),
    /// The key media links are signed with: MEDIA_SECRET, or in development a random key for this process, so
    /// links minted before a restart stop verifying and clients re-mint them.
    media_key: String,
    /// TEST_LICENCE_REGISTRY: the synthetic coaching-licence register (e2e/support/CONTRACT.md).
    licence_registry: TestRegistry,
    /// How often the periodic sweeps run: every half second with SCOUTBOX_FAST_SWEEPS=1, else every minute.
    sweep_ms: Int,
    /// SCOUTBOX_FAST_SWEEPS=1: the delivery centre's retry ladder and quiet-hours hold in milliseconds, not minutes.
    fast_sweeps: Bool,
    /// DELIVERY_CALLBACK_SECRET: what the delivery provider signs its callbacks with. Its default is the local fake
    /// provider's, as in the TypeScript server: there is no real provider to call back.
    delivery_callback_secret: String,
    /// ALLOW_LOCAL_WEBHOOKS=1: a webhook may go to a loopback address (the battery's receiver).
    allow_local_webhooks: Bool,
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

const media_secret_min_length = 32

const media_secret_missing =
  "MEDIA_SECRET is unset or shorter than 32 characters; signed media URLs need a stable secret of the deployment's own."

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
  let media_secret = case envoy.get("MEDIA_SECRET") {
    Ok("") | Error(Nil) -> None
    Ok(secret) -> Some(secret)
  }
  use media_key <- result.try(case media_secret {
    Some(secret) if !production -> Ok(secret)
    Some(secret) ->
      case string.length(secret) >= media_secret_min_length {
        True -> Ok(secret)
        False -> Error(media_secret_missing)
      }
    None if production -> Error(media_secret_missing)
    None -> Ok(secrets.random_hex(32))
  })
  use seed_demo <- result.try(case envoy.get("SCOUTBOX_SEED_DEMO") {
    Ok("1") -> Ok(True)
    Ok("0") -> Ok(False)
    Ok("") | Error(Nil) -> Ok(!production)
    Ok(_) ->
      Error(
        "SCOUTBOX_SEED_DEMO must be 1 (load the demo world on first boot) or 0 (start empty).",
      )
  })
  Ok(Config(
    port:,
    data_dir: envoy.get("DATA_DIR") |> result.unwrap("data"),
    admin_key:,
    dev_logins: !production,
    fault_rules: envoy.get("SCOUTBOX_FAULTS") |> result.unwrap(""),
    seed_demo:,
    quiet_logs: envoy.get("SCOUTBOX_QUIET_LOGS") == Ok("1"),
    media_secret:,
    media_key:,
    licence_registry: case envoy.get("TEST_LICENCE_REGISTRY") {
      Ok("1") -> RegistryUp
      Ok("down") -> RegistryDown
      _ -> NoRegistry
    },
    sweep_ms: case envoy.get("SCOUTBOX_FAST_SWEEPS") {
      Ok("1") -> 500
      _ -> 60_000
    },
    fast_sweeps: envoy.get("SCOUTBOX_FAST_SWEEPS") == Ok("1"),
    delivery_callback_secret: case envoy.get("DELIVERY_CALLBACK_SECRET") {
      Ok("") | Error(Nil) -> "local-fake-callback-secret"
      Ok(secret) -> secret
    },
    allow_local_webhooks: envoy.get("ALLOW_LOCAL_WEBHOOKS") == Ok("1"),
  ))
}
