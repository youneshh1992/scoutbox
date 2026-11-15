//// A guardian's account: sign-in, their record, their children and the log of everything about them.

import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
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
            Some(id) -> guardians.by_id(read, id)
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
          let canonical = "guardian:" <> g.row.id
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
    // Not ported yet: password-protected guardians need scrypt (out of this slice's scope). No guardian this
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
          |> result.map(fn(token) { #(token, []) })
        })
      case minted {
        Ok(token) ->
          http.json(
            200,
            json.object([
              #("guardianId", json.string(g.row.id)),
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
