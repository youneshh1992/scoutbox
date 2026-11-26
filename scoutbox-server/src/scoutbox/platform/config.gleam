//// Every environment setting the server reads, in one place. Secrets have no defaults in production.

import envoy
import gleam/float
import gleam/int
import gleam/io
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/messaging/transport
import scoutbox/passport/trust_rules
import scoutbox/platform/blobs
import scoutbox/platform/cors
import scoutbox/platform/input
import scoutbox/platform/proxy_trust
import scoutbox/platform/secrets
import scoutbox/platform/sigv4

pub type Config {
  Config(
    port: Int,
    data_dir: String,
    /// PUBLIC_DIR: where the built web portals are, one folder each (`platform/portals`). Default `public`, beside
    /// the server, where the deploy image puts them.
    public_dir: String,
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
    /// SCOUTBOX_TEST_CLOCK=1 (development only): a request may pin its time with `x-scoutbox-test-clock`, read by
    /// `clock.request_ms` in the routes that honour it.
    test_clock: Bool,
    /// AGENT_VERIFICATION_TEST_PROVIDER=1 (development only): the synthetic licence register, which verifies any
    /// `TEST-VERIFIED…` reference an agent submits.
    agent_verification_test: Bool,
    /// Development only: a route may inject a named fault for a test of its failure path (the dashboard's
    /// `simulateFailure`), as the TypeScript server allows outside production.
    dev_faults: Bool,
    /// BOX_CAM_TEST_PROVIDER=1: Box Cam's scripted observation provider (`local_test`), whose results are always
    /// labelled simulated.
    box_cam_test_provider: Bool,
    /// The provider connectors' settings that are set (CONNECTOR_STATS_KEY, CONNECTOR_FED_KEY,
    /// CONNECTOR_VIDEO_KEY). No build integrates a provider, so a connector only reports that it was configured.
    configured_connectors: List(String),
    /// What the local test identity provider signs its codes with: TEST_IDP_SECRET, or a random key for this
    /// process, so a code minted against a publicly known string never verifies. Production refuses the setting.
    test_idp_secret: String,
    /// SCOUTBOX_ALLOWED_ORIGINS: the origins a browser may read responses from. Empty, any origin.
    allowed_origins: List(String),
    /// SCOUTBOX_TRUST_PROXY: which proxies' X-Forwarded-For to believe for the client address.
    trust_proxy: proxy_trust.Setting,
    /// SENDGRID_API_KEY (and MAIL_FROM): mail through SendGrid. Unset, the outbox is the delivery.
    mail: transport.Mail,
    /// EXPO_ACCESS_TOKEN: push through Expo. Unset, the push log is the delivery.
    push: transport.Push,
    /// R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY: uploaded files in Cloudflare R2. None
    /// set, they are kept on this instance's disk under DATA_DIR/media.
    blobs: blobs.Blobs,
    /// TS_REVIEWER_BOOTSTRAP_ID, _SECRET and _NAME: the Trust & Safety admin a deployment starts with, created at
    /// boot in any mode if no reviewer has that id. Only a reviewer can create another, so without it a production
    /// database not seeded with the demo world has none.
    reviewer_bootstrap: Option(ReviewerBootstrap),
  )
}

/// The first Trust & Safety reviewer, checked as `POST /ts/reviewers` checks a new one.
pub type ReviewerBootstrap {
  ReviewerBootstrap(id: String, name: String, secret: String)
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

/// An unsafe setting (`productionConfigProblems` in the TypeScript server). Each is logged at boot; production
/// refuses to boot on any of them and names every code.
pub type Problem {
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
  let problems = problems(envoy.get, trust_rules.weights_total())
  list.each(problems, fn(p) {
    io.println_error("CONFIG " <> p.code <> ": " <> p.message)
  })
  use _ <- result.try(case production, problems {
    False, _ | True, [] -> Ok(Nil)
    True, problems ->
      Error(
        "Refusing to start: "
        <> string.join(list.map(problems, fn(p) { p.code }), ", "),
      )
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
  let data_dir = envoy.get("DATA_DIR") |> result.unwrap("data")
  use blobs <- result.try(blobs_from(envoy.get, data_dir, media_key))
  use reviewer_bootstrap <- result.try(reviewer_bootstrap_from(envoy.get))
  Ok(Config(
    port:,
    data_dir:,
    public_dir: case envoy.get("PUBLIC_DIR") {
      Ok("") | Error(Nil) -> "public"
      Ok(dir) -> dir
    },
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
    test_clock: !production && envoy.get("SCOUTBOX_TEST_CLOCK") == Ok("1"),
    agent_verification_test: !production
      && envoy.get("AGENT_VERIFICATION_TEST_PROVIDER") == Ok("1"),
    dev_faults: !production,
    box_cam_test_provider: envoy.get("BOX_CAM_TEST_PROVIDER") == Ok("1"),
    configured_connectors: list.filter(
      ["CONNECTOR_STATS_KEY", "CONNECTOR_FED_KEY", "CONNECTOR_VIDEO_KEY"],
      fn(name) {
        case envoy.get(name) {
          Ok(value) -> value != ""
          Error(Nil) -> False
        }
      },
    ),
    test_idp_secret: case envoy.get("TEST_IDP_SECRET") {
      Ok("") | Error(Nil) -> secrets.random_hex(32)
      Ok(secret) -> secret
    },
    allowed_origins: cors.parse_allowed(envoy.get("SCOUTBOX_ALLOWED_ORIGINS")),
    trust_proxy: proxy_trust.parse(envoy.get("SCOUTBOX_TRUST_PROXY")),
    mail: transport.mail_from_env(envoy.get),
    push: transport.push_from_env(envoy.get),
    blobs:,
    reviewer_bootstrap:,
  ))
}

/// None when neither the id nor the secret is set. Set, both are needed and must be what `POST /ts/reviewers`
/// accepts (the name defaults to the id); anything else is a mistake in any mode, refused rather than trimmed to fit.
pub fn reviewer_bootstrap_from(
  get: fn(String) -> Result(String, Nil),
) -> Result(Option(ReviewerBootstrap), String) {
  let setting = fn(name) {
    case get(name) {
      Ok(value) if value != "" -> Some(value)
      _ -> None
    }
  }
  let invalid = fn(why) { Error("TS_REVIEWER_BOOTSTRAP_" <> why) }
  let assert Ok(id_pattern) =
    regexp.from_string("^[a-zA-Z0-9][a-zA-Z0-9-]{2,39}$")
  case
    setting("TS_REVIEWER_BOOTSTRAP_ID"),
    setting("TS_REVIEWER_BOOTSTRAP_SECRET"),
    setting("TS_REVIEWER_BOOTSTRAP_NAME")
  {
    None, None, None -> Ok(None)
    None, None, Some(_) ->
      invalid("NAME is set without TS_REVIEWER_BOOTSTRAP_ID and _SECRET.")
    Some(_), None, _ ->
      invalid("ID is set without TS_REVIEWER_BOOTSTRAP_SECRET.")
    None, Some(_), _ ->
      invalid("SECRET is set without TS_REVIEWER_BOOTSTRAP_ID.")
    Some(reviewer_id), Some(secret), name -> {
      let name = option.unwrap(name, reviewer_id) |> string.trim
      let secret_length = input.utf16_length(secret)
      case
        regexp.check(id_pattern, reviewer_id),
        input.utf16_length(name),
        secret_length
      {
        False, _, _ -> invalid("ID must be 3 to 40 letters, digits or dashes.")
        _, n, _ if n == 0 || n > 80 ->
          invalid("NAME must be 1 to 80 characters.")
        _, _, n if n < 12 || n > 200 ->
          invalid("SECRET must be 12 to 200 characters.")
        True, _, _ ->
          Ok(Some(ReviewerBootstrap(id: reviewer_id, name:, secret:)))
      }
    }
  }
}

const r2_settings = [
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
]

/// R2 when all four of its settings are set, the local disk when none is; some of them is a mistake in any mode.
/// The local store signs its links with the media key.
pub fn blobs_from(
  get: fn(String) -> Result(String, Nil),
  data_dir: String,
  media_key: String,
) -> Result(blobs.Blobs, String) {
  let set =
    list.map(r2_settings, fn(name) {
      case get(name) {
        Ok(value) if value != "" -> Ok(value)
        _ -> Error(name)
      }
    })
  case result.all(set), result.values(set) {
    Ok([account_id, bucket, access_key_id, secret_access_key]), _ ->
      Ok(blobs.R2(
        credentials: sigv4.Credentials(
          access_key_id:,
          secret_access_key:,
          region: "auto",
        ),
        account_id:,
        bucket:,
      ))
    _, [] -> Ok(blobs.LocalDisk(dir: data_dir <> "/media", secret: media_key))
    _, _ ->
      Error(
        "R2 storage needs all of "
        <> string.join(r2_settings, ", ")
        <> "; missing "
        <> string.join(
          list.filter_map(set, fn(r) {
            case r {
              Error(name) -> Ok(name)
              Ok(_) -> Error(Nil)
            }
          }),
          ", ",
        )
        <> ".",
      )
  }
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

/// The unsafe settings among those `get` reads, in the TypeScript server's order. The Trust Score weights must total
/// 100 in every mode; the rest are unsafe only in production.
pub fn problems(
  get: fn(String) -> Result(String, Nil),
  trust_weights_total: Int,
) -> List(Problem) {
  let weights = case trust_weights_total {
    100 -> []
    total -> [
      Problem(
        "TRUST_WEIGHTS_INVALID",
        "Trust Score component weights total "
          <> int.to_string(total)
          <> ", not 100.",
      ),
    ]
  }
  case get("NODE_ENV") {
    Ok("production") -> list.append(weights, production_problems(get))
    _ -> weights
  }
}

fn production_problems(
  get: fn(String) -> Result(String, Nil),
) -> List(Problem) {
  let flagged = fn(name) {
    case get(name) {
      Ok(value) -> string.trim(value) != ""
      Error(Nil) -> False
    }
  }
  let is_one = fn(name) { get(name) == Ok("1") }
  let admin_key = get("ADMIN_KEY") |> result.unwrap("")
  let media_secret = get("MEDIA_SECRET") |> result.unwrap("")
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
      input.utf16_length(media_secret) < media_secret_min_length,
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
      get("SCOUTBOX_FAULTS") |> result.unwrap("") != "",
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
        || input.utf16_length(admin_key) < admin_key_min_length,
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
    #(
      // An unreadable value would key every per-address limit on the proxy's own address.
      proxy_trust.parse(get("SCOUTBOX_TRUST_PROXY")).state
        == proxy_trust.Invalid,
      Problem(
        "TRUST_PROXY_INVALID",
        "SCOUTBOX_TRUST_PROXY="
          <> json.to_string(json.string(
          get("SCOUTBOX_TRUST_PROXY") |> result.unwrap(""),
        ))
          <> " is not a hop count, true/false, or a list of addresses and subnets.",
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
