//// Every environment setting the server reads, in one place. Secrets have no defaults in production.

import envoy
import gleam/float
import gleam/int
import gleam/io
import gleam/list
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
    /// SESSION_TTL_DAYS: a session's absolute lifetime (default 30 days), applied wherever a session is resolved.
    session_ttl_ms: Int,
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

const admin_key_min_length = 16

const media_secret_min_length = 32

const day_ms = 86_400_000

/// An unsafe production setting (`productionConfigProblems` in the TypeScript server). Production refuses to boot
/// on any of them and names every code.
type Problem {
  Problem(code: String, message: String)
}

/// Settings that name a provider no build integrates. Set in production, whoever set them expects behaviour that
/// doesn't exist.
const unimplemented_providers = [
  #(
    "ONFIDO_API_TOKEN",
    "identity verification (guardian ID checks still auto-approve)",
  ),
  #(
    "STRIPE_SECRET_KEY",
    "billing (success fees are recorded in the local ledger only)",
  ),
  #("S3_BUCKET", "object storage (media is stored on this instance's disk)"),
]

pub fn load() -> Result(Config, String) {
  let production = envoy.get("NODE_ENV") == Ok("production")
  use port <- result.try(case envoy.get("PORT") {
    Error(Nil) -> Ok(4000)
    Ok(text) ->
      int.parse(text) |> result.replace_error("PORT must be a whole number")
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
  use _ <- result.try(case production {
    False -> Ok(Nil)
    True ->
      case production_problems() {
        [] -> Ok(Nil)
        problems -> {
          list.each(problems, fn(p) {
            io.println_error("CONFIG " <> p.code <> ": " <> p.message)
          })
          Error(
            "Refusing to start: "
            <> string.join(list.map(problems, fn(p) { p.code }), ", "),
          )
        }
      }
  })
  let admin_key = envoy.get("ADMIN_KEY") |> result.unwrap(dev_admin_key)
  let media_secret = case envoy.get("MEDIA_SECRET") {
    Ok("") | Error(Nil) -> None
    Ok(secret) -> Some(secret)
  }
  let media_key = case media_secret {
    Some(secret) -> secret
    None -> secrets.random_hex(32)
  }
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
    session_ttl_ms: session_ttl_ms(envoy.get("SESSION_TTL_DAYS")),
  ))
}

/// Any positive number of days, fractions included; anything else is the default, as in the TypeScript server.
fn session_ttl_ms(setting: Result(String, Nil)) -> Int {
  let days =
    result.try(setting, fn(text) {
      let text = string.trim(text)
      int.parse(text)
      |> result.map(int.to_float)
      |> result.lazy_or(fn() { float.parse(text) })
    })
  case days {
    Ok(days) if days >. 0.0 -> float.round(days *. int.to_float(day_ms))
    _ -> 30 * day_ms
  }
}

/// Not ported yet: TRUST_WEIGHTS_INVALID (the Passport's Trust Score weights) and TRUST_PROXY_INVALID
/// (SCOUTBOX_TRUST_PROXY, which this server doesn't read yet).
fn production_problems() -> List(Problem) {
  let flagged = fn(name) {
    case envoy.get(name) {
      Ok(value) -> string.trim(value) != ""
      Error(Nil) -> False
    }
  }
  let is_one = fn(name) { envoy.get(name) == Ok("1") }
  let admin_key = envoy.get("ADMIN_KEY") |> result.unwrap("")
  let media_secret = envoy.get("MEDIA_SECRET") |> result.unwrap("")
  [
    #(
      is_one("BOX_CAM_TEST_PROVIDER"),
      Problem(
        "TEST_PROVIDER_IN_PRODUCTION",
        "BOX_CAM_TEST_PROVIDER=1 enables the simulated observer. Simulated captures must never be reachable in production.",
      ),
    ),
    #(
      // A signed media link grants access to a player's footage, so its key must be stable, private and unguessable.
      string.length(media_secret) < media_secret_min_length,
      Problem(
        "MEDIA_SECRET_MISSING",
        "MEDIA_SECRET is unset or shorter than 32 characters; signed media URLs need a stable secret of the deployment's own.",
      ),
    ),
    ..list.map(unimplemented_providers, fn(provider) {
      let #(name, what) = provider
      #(
        flagged(name),
        Problem(
          "PROVIDER_NOT_IMPLEMENTED",
          name
            <> " is set, but no real provider is integrated for "
            <> what
            <> ".",
        ),
      )
    })
  ]
  |> list.append([
    #(
      flagged("ALLOW_DEV_LOGINS"),
      Problem(
        "DEV_LOGIN_IN_PRODUCTION",
        "ALLOW_DEV_LOGINS is set. Passwordless demo logins are never available in production; give demo accounts real passwords instead.",
      ),
    ),
    #(
      envoy.get("SCOUTBOX_FAULTS") |> result.unwrap("") != "",
      Problem(
        "FAULTS_IN_PRODUCTION",
        "SCOUTBOX_FAULTS is set. Simulated failures must never be configured on a production instance.",
      ),
    ),
    #(
      // A client that can set its own clock could, for example, answer an Offer after it expired.
      flagged("SCOUTBOX_TEST_CLOCK"),
      Problem(
        "TEST_CLOCK_IN_PRODUCTION",
        "SCOUTBOX_TEST_CLOCK is set. Requests must never choose their own time on a production instance.",
      ),
    ),
    #(
      // `scoutbox-admin` is the publicly known development key.
      admin_key == dev_admin_key
        || string.length(admin_key) < admin_key_min_length,
      Problem(
        "ADMIN_KEY_UNSAFE",
        "ADMIN_KEY is unset, is the development default or is shorter than 16 characters; the Trust & Safety API would accept a publicly known key.",
      ),
    ),
    #(
      // It verifies any `TEST-VERIFIED-*` reference, so an agent could self-verify a licence.
      is_one("AGENT_VERIFICATION_TEST_PROVIDER"),
      Problem(
        "AGENT_TEST_PROVIDER_IN_PRODUCTION",
        "AGENT_VERIFICATION_TEST_PROVIDER=1 enables the synthetic licence register, which verifies any TEST-VERIFIED reference.",
      ),
    ),
    #(
      flagged("TEST_IDP_SECRET"),
      Problem(
        "TEST_IDP_IN_PRODUCTION",
        "TEST_IDP_SECRET is set. The local test identity provider must never be configured on a production instance.",
      ),
    ),
  ])
  |> list.filter_map(fn(check) {
    case check {
      #(True, problem) -> Ok(problem)
      #(False, _) -> Error(Nil)
    }
  })
}
