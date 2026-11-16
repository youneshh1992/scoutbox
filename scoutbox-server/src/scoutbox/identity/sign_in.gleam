//// `POST /auth/org/login`: a named staff member signs in to their organisation.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/roles
import scoutbox/identity/sessions
import scoutbox/identity/staff.{type Staff}
import scoutbox/identity/totp
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/platform/vocabulary
import scoutbox/rows/orgs as org_row
import scoutbox/vocab/org_type
import wisp.{type Request, type Response}

pub type Platform {
  Main
  GrassrootsApp
  AgentApp
}

pub fn platforms() -> vocabulary.Vocabulary(Platform) {
  vocabulary.new([
    #("main", Main),
    #("grassroots", GrassrootsApp),
    #("agent", AgentApp),
  ])
}

type Login {
  Login(
    org_id: Option(String),
    scout_name: Option(String),
    role: Option(String),
    platform: Option(Platform),
    password: Option(String),
    mfa_code: Option(String),
    recovery_code: Option(String),
  )
}

fn login_shape() -> input.Shape(Login) {
  use org_id <- input.field("orgId", input.nullish(input.text(80)))
  use scout_name <- input.field(
    "scoutName",
    input.nullish(input.text(staff.name_max)),
  )
  use role <- input.field("role", input.nullish(input.text(staff.role_max)))
  use platform <- input.field(
    "platform",
    input.nullish(vocabulary.check(platforms())),
  )
  use password <- input.field("password", input.nullish(input.text(256)))
  use mfa_code <- input.field("mfaCode", input.nullish(input.text(64)))
  use recovery_code <- input.field(
    "recoveryCode",
    input.nullish(input.text(64)),
  )
  input.done(Login(
    org_id:,
    scout_name:,
    role:,
    platform:,
    password:,
    mfa_code:,
    recovery_code:,
  ))
}

/// Why a sign-in inside the unit was refused. Nothing it would have written is kept.
type Refusal {
  MfaLocked
  MfaRequired
  MfaCodeWrong
  /// The staff repository refused a write this route should never ask for.
  StaffRefused(staff.StaffError)
}

pub fn login(ctx: Ctx, req: Request) -> Response {
  use body <- http.body(req, login_shape(), [])
  let now = clock.now_ms()
  // As the TypeScript server keys it: an absent orgId is budgeted as "org:undefined".
  let budget_key = "org:" <> option.unwrap(body.org_id, "undefined")
  use <- guard(limits.login_locked(ctx.limits, budget_key, now), locked_out)
  let org = case body.org_id {
    Some(id) -> store.read(ctx.store, orgs.by_id(_, id))
    None -> Ok(None)
  }
  case org {
    Error(failure) -> http.internal(failure)
    Ok(None) -> {
      limits.login_failed(ctx.limits, budget_key, now)
      http.error(404, "ORG_NOT_FOUND")
    }
    Ok(Some(org)) -> signing_in(ctx, body, org, now)
  }
}

/// The failed-login budget for an identifier is spent.
pub fn locked_out() -> Response {
  http.json(
    429,
    json.object([
      #("error", json.string("RATE_LIMITED")),
      #("action", json.string("login_failure")),
      #(
        "message",
        json.string(
          "Too many requests in a short window — wait a moment and try again.",
        ),
      ),
    ]),
  )
}

fn guard(
  refused: Bool,
  answer: fn() -> Response,
  next: fn() -> Response,
) -> Response {
  case refused {
    True -> answer()
    False -> next()
  }
}

fn signing_in(ctx: Ctx, body: Login, org: Org, now: Int) -> Response {
  // A grassroots club exists only on ScoutBox Grassroots and every other organisation only on ScoutBox. An agency
  // can still sign in to the club app, where its representation lane lives.
  let wants_grassroots = body.platform == Some(GrassrootsApp)
  use <- guard(orgs.is_grassroots(org) && !wants_grassroots, fn() {
    http.error_message(
      403,
      "GRASSROOTS_PLATFORM_ONLY",
      "This club is registered on ScoutBox Grassroots — log in there.",
    )
  })
  use <- guard(!orgs.is_grassroots(org) && wants_grassroots, fn() {
    http.error_message(
      403,
      "PLATFORM_MISMATCH",
      "ScoutBox Grassroots is for federation-registered grassroots clubs only.",
    )
  })
  use <- guard(
    body.platform == Some(AgentApp) && org.type_ != org_type.Agency,
    fn() {
      http.error_message(
        403,
        "PLATFORM_MISMATCH",
        "ScoutBox Agent is for agency organisations only.",
      )
    },
  )
  case input.filled(body.scout_name) {
    None ->
      http.error_message(
        400,
        "SCOUT_NAME_REQUIRED",
        "Every session is attributed to a named individual.",
      )
    Some(_) if org.password_hash != None ->
      // Not ported yet: password-protected organisations need scrypt, which OTP's crypto lacks, and the
      // routes that set a password (grassroots registration) are not in this server. No organisation it
      // can hold has one.
      http.error_message(
        501,
        "NOT_PORTED",
        "Password-protected organisations are not supported by this server yet.",
      )
    Some(_) if !ctx.config.dev_logins ->
      http.error_message(
        403,
        "DEV_LOGIN_DISABLED",
        "Passwordless demo logins are disabled outside development. Use a credentialed account.",
      )
    Some(name) -> {
      let raw_name = option.unwrap(body.scout_name, name)
      let outcome =
        store.unit(ctx.store, fn(tx) {
          let read = store.reading(tx)
          use user <- result.try(staff.by_org_and_name(read, org.id, raw_name))
          case user {
            Some(user) if user.removed_at != None -> Ok(#(Removed, []))
            _ -> {
              use user <- result.try(second_factor(ctx, tx, user, body, now))
              use user <- result.try(provision(tx, org, user, name, body, now))
              use token <- result.try(sessions.create(
                tx,
                sessions.OrgStaff(org.id, user.id),
                now,
              ))
              use certified <- result.try(orgs.safeguarding_certified(read, org))
              Ok(#(SignedIn(user, token, certified), []))
            }
          }
        })
      case outcome {
        Ok(Removed) ->
          http.error_message(
            403,
            "USER_REMOVED",
            "This staff member's access was removed by the organisation.",
          )
        Ok(SignedIn(user, token, certified)) ->
          signed_in(org, user, token, certified)
        Error(store.Refused(MfaLocked)) ->
          http.error_message(
            429,
            "MFA_LOCKED",
            "Too many wrong codes — try again in a few minutes.",
          )
        Error(store.Refused(MfaRequired)) ->
          http.error_message(
            401,
            "MFA_REQUIRED",
            "This account uses two-factor authentication — send mfaCode (authenticator) or recoveryCode.",
          )
        Error(store.Refused(MfaCodeWrong)) ->
          http.error_message(401, "MFA_CODE_WRONG", "That code is not valid.")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

type Outcome {
  Removed
  SignedIn(Staff, String, Bool)
}

/// With MFA enabled the name alone never gets a session. A recovery code works once: only the call that deleted
/// its row passes.
fn second_factor(
  ctx: Ctx,
  tx: store.Tx,
  user: Option(Staff),
  body: Login,
  now: Int,
) -> Result(Option(Staff), store.Fail(Refusal)) {
  case user {
    Some(user) if user.mfa_enabled_at != None -> {
      use <- guard_unit(limits.mfa_locked(ctx.limits, user.id, now), MfaLocked)
      use passed <- result.try(case body.mfa_code, body.recovery_code {
        Some(code), _ -> {
          use secret <- result.map(staff.mfa_secret_of(
            store.reading(tx),
            user.id,
          ))
          case secret {
            Some(secret) -> totp.valid(secret, code, now)
            None -> False
          }
        }
        None, Some(code) ->
          staff.use_recovery_code(tx, user.id, secrets.sha256_hex(code))
        None, None -> Ok(False)
      })
      let tried = body.mfa_code != None || body.recovery_code != None
      case passed, tried {
        True, _ -> {
          limits.mfa_clear(ctx.limits, user.id)
          Ok(Some(user))
        }
        False, True -> {
          limits.mfa_failed(ctx.limits, user.id, now)
          store.refuse(MfaCodeWrong)
        }
        False, False -> store.refuse(MfaRequired)
      }
    }
    _ -> Ok(user)
  }
}

fn guard_unit(
  refused: Bool,
  refusal: e,
  next: fn() -> Result(a, store.Fail(e)),
) -> Result(a, store.Fail(e)) {
  case refused {
    True -> store.refuse(refusal)
    False -> next()
  }
}

/// A demo organisation (no password) lets a sign-in create its account and name its role: the development
/// shortcut, refused outside development before this point.
fn provision(
  tx: store.Tx,
  org: Org,
  user: Option(Staff),
  name: String,
  body: Login,
  now: Int,
) -> Result(Staff, store.Fail(Refusal)) {
  let role = input.filled(body.role)
  case user, role {
    None, _ ->
      staff.create(
        tx,
        staff.NewStaff(
          org_id: org.id,
          name:,
          role: option.unwrap(role, "Scout"),
          email: None,
          provenance: None,
          created_at: now,
        ),
      )
      |> store.map_refusal(StaffRefused)
    Some(user), Some(role) if role != user.role ->
      staff.set_role(tx, user.id, role) |> store.map_refusal(StaffRefused)
    Some(user), _ -> Ok(user)
  }
}

fn signed_in(
  org: Org,
  user: Staff,
  token: String,
  certified: Bool,
) -> Response {
  let mfa_setup_required =
    org.mfa_required_for_leads
    && roles.is_lead_role(user.role)
    && case staff.mfa(user) {
      staff.MfaEnabled(_) -> False
      _ -> True
    }
  let nudge = case mfa_setup_required {
    // A nudge, not a lockout. Absent rather than false, as the TypeScript server sends it.
    True -> [#("mfaSetupRequired", json.bool(True))]
    False -> []
  }
  http.json(
    200,
    json.object([
      #("userId", json.string(user.id)),
      #("role", json.string(user.role)),
      #(
        "org",
        json.object(
          list.append(orgs.view(org), [
            #("safeguardingCertified", json.bool(certified)),
          ]),
        ),
      ),
      #("token", json.string(token)),
      ..nudge
    ]),
  )
}

/// `GET /orgs?platform=…`: the organisations a sign-in picker lists. The Grassroots app lists only grassroots
/// clubs, the main app never lists them, and the Agent app lists agencies only. Unpaged, as the TypeScript
/// server's is.
pub fn org_list(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use platform <- input.field(
      "platform",
      input.optional(vocabulary.check(platforms())),
    )
    input.done(platform)
  }
  use platform <- http.query(req, shape, [])
  let where = case platform {
    Some(GrassrootsApp) -> " WHERE level = 'grassroots'"
    Some(Main) -> " WHERE (level IS NULL OR level <> 'grassroots')"
    Some(AgentApp) -> " WHERE type = 'agency'"
    None -> ""
  }
  let listed =
    store.read(ctx.store, fn(read) {
      use ids <- result.try(store.query(
        read,
        "SELECT id FROM orgs" <> where <> " ORDER BY rowid",
        [],
        decode.at([0], decode.string),
      ))
      use found <- result.try(list.try_map(ids, orgs.by_id(read, _)))
      list.filter_map(found, option.to_result(_, Nil))
      |> list.try_map(fn(o) {
        use certified <- result.map(orgs.safeguarding_certified(read, o))
        json.object(
          list.flatten([
            [
              #("id", json.string(o.id)),
              #("name", json.string(o.name)),
              #("type", json.string(org_type.to_string(o.type_))),
              #(
                "level",
                json.nullable(o.level, fn(l) {
                  json.string(org_row.level_to_string(l))
                }),
              ),
              #("plan", json.string(org_row.plan_to_string(o.plan))),
              #("trustedPartner", json.bool(o.trusted_partner)),
              #("verified", json.bool(o.verified)),
              #("safeguardingCertified", json.bool(certified)),
            ],
            case orgs.is_grassroots(o) {
              True -> [
                #("city", json.nullable(o.city, json.string)),
                #("federation", json.nullable(o.federation, json.string)),
              ]
              False -> []
            },
          ]),
        )
      })
    })
  case listed {
    Ok(items) -> http.json(200, json.preprocessed_array(items))
    Error(failure) -> http.internal(failure)
  }
}
