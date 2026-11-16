//// A guardian's account: sign-in, their record, their children and the log of everything about them.

import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/safety/ledger
import wisp.{type Request, type Response}

type Login {
  Login(
    guardian_id: Option(String),
    email: Option(String),
    password: Option(String),
  )
}

/// `POST /auth/guardian/login`, by id or by e-mail. The failed-login budget is charged against both the
/// identifier tried and the account it resolved to, or alternating the two would give a guesser two budgets.
pub fn login(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use guardian_id <- input.field("guardianId", input.nullish(input.text(80)))
    use email <- input.field("email", input.nullish(input.text(254)))
    use password <- input.field("password", input.nullish(input.text(256)))
    input.done(Login(guardian_id:, email:, password:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let tried =
    "guardian:"
    <> case body.guardian_id, body.email {
      Some(id), _ -> id
      None, Some(email) -> email
      None, None -> "undefined"
    }
  case limits.login_locked(ctx.limits, tried, now) {
    True -> sign_in.locked_out()
    False -> {
      let found =
        store.read(ctx.store, fn(read) {
          use by_id <- result.try(case body.guardian_id {
            // From the request body.
            Some(guardian_id) -> guardians.by_id(read, id.guardian(guardian_id))
            None -> Ok(None)
          })
          case by_id, body.email {
            Some(g), _ -> Ok(Some(g))
            None, Some(email) -> guardians.by_email(read, email)
            None, None -> Ok(None)
          }
        })
      case found {
        Error(failure) -> http.internal(failure)
        Ok(None) -> {
          limits.login_failed(ctx.limits, tried, now)
          http.error(404, "GUARDIAN_NOT_FOUND")
        }
        Ok(Some(g)) -> {
          let canonical = "guardian:" <> id.guardian_to_string(g.row.id)
          let aliased = limits.login_key(canonical) != limits.login_key(tried)
          case aliased && limits.login_locked(ctx.limits, canonical, now) {
            True -> sign_in.locked_out()
            False -> signing_in(ctx, g, now)
          }
        }
      }
    }
  }
}

fn signing_in(ctx: Ctx, g: Guardian, now: Int) -> Response {
  case g.row.password_hash, ctx.config.dev_logins {
    // Not ported yet: signing a guardian in with a password (`identity/passwords` checks one). No guardian this
    // server can hold has a password.
    Some(_), _ ->
      http.error_message(
        501,
        "NOT_PORTED",
        "Password-protected guardian accounts are not supported by this server yet.",
      )
    None, False ->
      http.error_message(
        403,
        "DEV_LOGIN_DISABLED",
        "Passwordless demo logins are disabled outside development. Use a credentialed account.",
      )
    None, True -> {
      let minted =
        store.unit(ctx.store, fn(tx) {
          sessions.create(tx, sessions.Guardian(g.row.id), now)
        })
      case minted {
        Ok(token) ->
          http.json(
            200,
            json.object([
              #("guardianId", id.guardian_json(g.row.id)),
              #("guardian", guardians.self_view(g)),
              #("token", json.string(token)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `GET /guardian/me`.
pub fn me(g: Guardian) -> Response {
  http.json(200, guardians.self_view(g))
}

/// `GET /guardian/children`.
pub fn children(ctx: Ctx, g: Guardian) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.by_ids(_, g.child_ids)) {
    Ok(kids) ->
      http.json(200, json.array(kids, players.guardian_child_view(_, now)))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/log`: every communication about the children is on the ledger, and the guardian reads all of it.
pub fn log(ctx: Ctx, req: Request, g: Guardian) -> Response {
  use page <- pages.strict(req, [IntKind])
  case store.read(ctx.store, ledger.page_for_players(_, g.child_ids, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, ledger.view)
    Error(failure) -> http.internal(failure)
  }
}

type CoGuardian {
  CoGuardian(name: Option(String), email: Option(String))
}

/// `POST /guardian/coguardian`: created with its links to the children in one unit. The co-guardian passes the
/// gates (ID check, disclaimer) themselves before they can act.
pub fn add_co_guardian(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use name <- input.field("name", input.nullish(input.text(120)))
    use email <- input.field("email", input.nullish(input.text(254)))
    input.done(CoGuardian(name:, email:))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.name), input.filled(body.email) {
    Some(name), Some(email) ->
      case string.contains(email, "@") {
        False ->
          http.json(
            400,
            json.object([
              #("error", json.string("FIELD_INVALID")),
              #("field", json.string("email")),
              #("problem", json.string("invalid")),
              #("message", json.string("email must be an e-mail address.")),
            ]),
          )
        True -> {
          let now = clock.now_ms()
          let created =
            store.unit(ctx.store, fn(tx) {
              use id <- result.try(id.next_guardian(tx))
              guardians.create_co_guardian(
                tx,
                id:,
                primary: g,
                name:,
                email:,
                at: now,
              )
            })
          case created {
            Ok(co) ->
              http.json(
                201,
                json.object([
                  #("guardianId", id.guardian_json(co.row.id)),
                  #(
                    "note",
                    json.string(
                      "The co-guardian must verify their ID and accept the disclaimer before they can act.",
                    ),
                  ),
                ]),
              )
            Error(store.Refused(guardians.EmailInUse)) ->
              http.error_message(
                409,
                "EMAIL_IN_USE",
                "A guardian account with this email already exists.",
              )
            Error(failure) -> http.internal(failure)
          }
        }
      }
    _, _ -> http.error(400, "NAME_AND_EMAIL_REQUIRED")
  }
}

/// `GET /admin/guardians`, oldest first, with the ID-check queue. An allowlist: never a hash.
pub fn admin_list(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  let found =
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(guardians.page(read, page))
      use queue <- result.map(guardians.idv_queue(read))
      json.object([
        #("guardians", json.array(items, guardians.admin_view)),
        #("nextCursor", json.nullable(next, json.string)),
        #("idvQueue", json.array(queue, guardians.idv_view)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /admin/guardians/:id/idv`.
pub fn review_id(ctx: Ctx, req: Request, id: id.GuardianId) -> Response {
  case store.read(ctx.store, guardians.by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "GUARDIAN_NOT_FOUND")
    Ok(Some(_)) -> {
      let shape = {
        use approved <- input.field("approved", input.required(input.boolean()))
        input.done(approved)
      }
      use approved <- http.body(req, shape, [])
      let reviewed =
        store.unit(ctx.store, fn(tx) {
          guardians.review_id_check(tx, id, approved)
        })
      case reviewed {
        Ok(g) -> http.json(200, guardians.admin_view(g))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
