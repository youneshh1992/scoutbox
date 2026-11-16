//// Who is asking: the organisation session behind `/org`, and the admin key behind `/admin`.

import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players.{type Player}
import scoutbox/identity/roles
import scoutbox/identity/sessions.{OrgStaff}
import scoutbox/identity/staff.{type Staff}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import wisp.{type Request, type Response}

/// A staff member signed in to their organisation. A session is minted per named person, so the token resolves
/// to both.
pub type OrgAccess {
  OrgAccess(org: Org, user: Staff)
}

type Denied {
  AuthRequired(message: Bool)
  UserUnknown
  UserRemoved
  Suspended
}

pub fn org_session(
  ctx: Ctx,
  req: Request,
  next: fn(OrgAccess) -> Response,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use session <- result.try(case http.bearer(req) {
        Ok(token) -> sessions.by_token(read, token, now)
        Error(Nil) -> Ok(None)
      })
      case session {
        Some(sessions.Session(holder: OrgStaff(org_id, user_id), ..)) -> {
          use org <- result.try(orgs.by_id(read, org_id))
          use user <- result.map(staff.by_id(read, user_id))
          case org, user {
            None, _ -> Error(AuthRequired(False))
            Some(_), None -> Error(UserUnknown)
            Some(org), Some(user) if user.org_id != org.id -> Error(UserUnknown)
            Some(_), Some(user) if user.removed_at != None -> Error(UserRemoved)
            Some(org), Some(_) if org.suspended -> Error(Suspended)
            Some(org), Some(user) -> Ok(OrgAccess(org:, user:))
          }
        }
        _ -> Ok(Error(AuthRequired(True)))
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Ok(access)) -> next(access)
    Ok(Error(AuthRequired(True))) ->
      http.error_message(
        401,
        "ORG_AUTH_REQUIRED",
        "Log in again — this session is no longer valid.",
      )
    Ok(Error(AuthRequired(False))) -> http.error(401, "ORG_AUTH_REQUIRED")
    Ok(Error(UserUnknown)) -> http.error(401, "USER_UNKNOWN")
    Ok(Error(UserRemoved)) ->
      http.error_message(
        401,
        "USER_REMOVED",
        "Your access to this organisation has been removed.",
      )
    Ok(Error(Suspended)) ->
      http.error_message(
        403,
        "ORG_SUSPENDED",
        "This organisation is suspended pending a safety review.",
      )
  }
}

pub fn is_lead(user: Staff) -> Bool {
  roles.is_lead_role(user.role)
}

pub fn require_lead(access: OrgAccess, next: fn() -> Response) -> Response {
  case is_lead(access.user) {
    True -> next()
    False ->
      http.error_message(
        403,
        "LEAD_REQUIRED",
        "This action needs a recruitment lead (role containing Head/Director/Lead/Manager).",
      )
  }
}

/// ScoutBox's own staff, behind `x-admin-key`.
pub fn admin(ctx: Ctx, req: Request, next: fn() -> Response) -> Response {
  case http.header(req, "x-admin-key") {
    Ok(key) if key == ctx.config.admin_key -> next()
    _ -> http.error(401, "ADMIN_KEY_REQUIRED")
  }
}

/// A player signed in. `minor` is worked out once per request.
pub type PlayerAccess {
  PlayerAccess(player: Player, minor: Bool)
}

fn session_holder(
  req: Request,
  read: store.Read,
  now: Int,
) -> Result(Option(sessions.Holder), store.Fail(e)) {
  case http.bearer(req) {
    Ok(token) ->
      sessions.by_token(read, token, now)
      |> result.map(option.map(_, fn(s) { s.holder }))
    Error(Nil) -> Ok(None)
  }
}

pub fn player_session(
  ctx: Ctx,
  req: Request,
  next: fn(PlayerAccess) -> Response,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use holder <- result.try(session_holder(req, read, now))
      case holder {
        Some(sessions.Player(id)) -> players.by_id(read, id)
        _ -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Some(p)) -> next(PlayerAccess(p, !players.is_adult(p, now)))
    Ok(None) ->
      http.error_message(
        401,
        "PLAYER_AUTH_REQUIRED",
        "Log in again — this session is no longer valid.",
      )
  }
}

/// A child's settings and conversations are the guardian's: a minor is refused with GUARDIAN_MANAGED.
pub fn guardian_managed_only(
  p: PlayerAccess,
  next: fn() -> Response,
) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "This setting is managed by your parent or guardian.",
      )
    False -> next()
  }
}

pub fn guardian_session(
  ctx: Ctx,
  req: Request,
  next: fn(Guardian) -> Response,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use holder <- result.try(session_holder(req, read, now))
      case holder {
        Some(sessions.Guardian(id)) -> guardians.by_id(read, id)
        _ -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Some(g)) -> next(g)
    Ok(None) ->
      http.error_message(
        401,
        "GUARDIAN_AUTH_REQUIRED",
        "Log in again — this session is no longer valid.",
      )
  }
}
