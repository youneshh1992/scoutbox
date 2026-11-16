//// `POST /auth/org/login`: a named staff member signs in to their organisation.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/passwords
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
import scoutbox/rows/id
import scoutbox/rows/ops_events as ops_row
import scoutbox/rows/org_users as user_row
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
  /// A credentialed organisation has staff, and none by this name.
  StaffNotProvisioned
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
    // From the request body.
    Some(org_id) -> store.read(ctx.store, orgs.by_id(_, id.org(org_id)))
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
    Some(name) -> {
      use credentialed <- password_checked(ctx, org, body, now)
      let raw_name = option.unwrap(body.scout_name, name)
      let outcome =
        store.unit(ctx.store, fn(tx) {
          let read = store.reading(tx)
          use user <- result.try(staff.by_org_and_name(read, org.id, raw_name))
          case user {
            Some(user) if user.removed_at != None -> Ok(Removed)
            _ -> {
              use user <- result.try(second_factor(ctx, tx, user, body, now))
              use #(user, role_note) <- result.try(provision(
                tx,
                org,
                user,
                name,
                body,
                credentialed,
                now,
              ))
              use token <- result.try(sessions.create(
                tx,
                sessions.OrgStaff(org.id, user.id),
                now,
              ))
              use certified <- result.try(orgs.safeguarding_certified(read, org))
              Ok(SignedIn(user, token, certified, role_note))
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
        Ok(SignedIn(user, token, certified, role_note)) ->
          signed_in(org, user, token, certified, role_note)
        Error(store.Refused(StaffNotProvisioned)) ->
          http.error_message(
            403,
            "STAFF_NOT_PROVISIONED",
            "No staff account with this name exists in the organisation. Ask a lead for an invitation — the organisation password does not create accounts.",
          )
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
  SignedIn(Staff, String, Bool, Option(String))
}

/// A credentialed organisation's password, checked before the unit: a hash takes about half a second, and a unit
/// holds the database's only writer. An organisation without one is a demo organisation, which signs in without a
/// password in development only. `next` is told whether the organisation is credentialed.
fn password_checked(
  ctx: Ctx,
  org: Org,
  body: Login,
  now: Int,
  next: fn(Bool) -> Response,
) -> Response {
  case org.password_hash {
    Some(stored) ->
      case passwords.verify(option.unwrap(body.password, ""), stored) {
        True -> next(True)
        False -> {
          limits.login_failed(
            ctx.limits,
            "org:" <> id.org_to_string(org.id),
            now,
          )
          http.error_message(
            401,
            "BAD_PASSWORD",
            "This organisation is password-protected.",
          )
        }
      }
    None if !ctx.config.dev_logins ->
      http.error_message(
        403,
        "DEV_LOGIN_DISABLED",
        "Passwordless demo logins are disabled outside development. Use a credentialed account.",
      )
    None -> next(False)
  }
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

/// Who signs in, and a note when the role sent was ignored. A credentialed organisation gets staff accounts only
/// through server-controlled flows: the registering administrator, a lead's invitation, or, once, the first sign-in
/// with the organisation password, which makes a lead-tier administrator. The role sent with a sign-in never
/// changes a stored one there, so nobody with the shared password can make themselves staff or promote themselves.
/// A demo organisation lets a sign-in create its account and name its role: the development shortcut, refused
/// outside development before this point.
fn provision(
  tx: store.Tx,
  org: Org,
  user: Option(Staff),
  name: String,
  body: Login,
  credentialed: Bool,
  now: Int,
) -> Result(#(Staff, Option(String)), store.Fail(Refusal)) {
  let role = input.filled(body.role)
  case user, role, credentialed {
    None, _, True -> {
      use first <- result.try(staff.first_active(
        store.reading(tx),
        id.org_to_string(org.id),
      ))
      use <- guard_unit(first != None, StaffNotProvisioned)
      let role = case role {
        Some(r) -> roles.is_lead_role(r)
        None -> False
      }
      use created <- result.try(
        staff.create(
          tx,
          staff.NewStaff(
            org_id: org.id,
            name:,
            role: case role, body.role {
              True, Some(r) -> string.trim(r)
              _, _ -> "Manager"
            },
            email: None,
            provenance: Some(user_row.OrgPasswordBootstrap),
            created_at: now,
          ),
        )
        |> store.map_refusal(StaffRefused),
      )
      use ops_id <- result.try(id.next_ops_event(tx))
      use _ <- result.map(ops_row.insert(
        tx,
        ops_row.New(
          ..ops_row.new(
            id: ops_id,
            occurred_at: now,
            kind: ops_row.StaffBootstrapped,
          ),
          detail_org_id: Some(org.id),
          detail_user_id: Some(created.id),
          detail_by: Some(created.name),
        ),
      ))
      #(created, None)
    }
    None, _, False ->
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
      |> result.map(fn(u) { #(u, None) })
    Some(user), Some(role), True if role != user.role ->
      Ok(#(
        user,
        Some(
          "Roles are assigned by your organisation; the role entered at sign-in was not applied.",
        ),
      ))
    Some(user), Some(role), False if role != user.role ->
      staff.set_role(tx, user.id, role)
      |> store.map_refusal(StaffRefused)
      |> result.map(fn(u) { #(u, None) })
    Some(user), _, _ -> Ok(#(user, None))
  }
}

fn signed_in(
  org: Org,
  user: Staff,
  token: String,
  certified: Bool,
  role_note: Option(String),
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
      #("userId", id.org_user_json(user.id)),
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
      ..list.append(
        case role_note {
          Some(note) -> [#("roleNote", json.string(note))]
          None -> []
        },
        nudge,
      )
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
        decode.at([0], id.org_decoder()),
      ))
      use found <- result.try(list.try_map(ids, orgs.by_id(read, _)))
      list.filter_map(found, option.to_result(_, Nil))
      |> list.try_map(fn(o) {
        use certified <- result.map(orgs.safeguarding_certified(read, o))
        json.object(
          list.flatten([
            [
              #("id", id.org_json(o.id)),
              #("name", json.string(o.name)),
              #("type", org_type.to_json(o.type_)),
              #("level", json.nullable(o.level, org_row.level_to_json)),
              #("plan", org_row.plan_to_json(o.plan)),
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
