//// Every route the server answers, and the middleware in front of them.

import exception
import gleam/http.{Get, Post, Put}
import gleam/json
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access
import scoutbox/identity/invite_routes
import scoutbox/identity/mfa_routes
import scoutbox/identity/orgs
import scoutbox/identity/sign_in
import scoutbox/identity/staff_routes
import scoutbox/messaging/delivery_prefs
import scoutbox/platform/clock
import scoutbox/platform/http as contract
import scoutbox/platform/limits
import scoutbox/platform/store
import scoutbox/platform/wisp_ewe
import scoutbox/safety/admin
import wisp.{type Request, type Response}

pub fn handle(ctx: Ctx, req: Request) -> Response {
  use <- rescue
  case wisp.path_segments(req) {
    ["health"] -> only(req, Get, fn() { health(ctx) })
    ["auth", ..rest] -> {
      use <- auth_limit(ctx, req)
      case rest {
        ["org", "login"] -> only(req, Post, fn() { sign_in.login(ctx, req) })
        ["org", "accept-invite"] ->
          only(req, Post, fn() { invite_routes.accept(ctx, req) })
        _ -> not_found()
      }
    }
    // Every /org path needs a staff session, a path the server does not have included.
    ["org", ..rest] -> {
      use org <- access.org_session(ctx, req)
      case rest {
        ["staff"] -> only(req, Get, fn() { staff_routes.list(ctx, org) })
        ["staff", user_id, "remove"] ->
          only(req, Post, fn() { staff_routes.remove(ctx, org, user_id) })
        ["invites"] ->
          only(req, Post, fn() { invite_routes.create(ctx, req, org) })
        ["mfa", "setup"] ->
          only(req, Post, fn() { mfa_routes.setup(ctx, req, org) })
        ["mfa", "verify"] ->
          only(req, Post, fn() { mfa_routes.verify(ctx, req, org) })
        ["mfa", "disable"] ->
          only(req, Post, fn() { mfa_routes.disable(ctx, req, org) })
        ["delivery", "prefs"] ->
          only(req, Put, fn() { delivery_prefs.put(ctx, req, org) })
        _ -> not_found()
      }
    }
    ["admin", ..rest] -> {
      use <- access.admin(ctx, req)
      case rest {
        ["outbox"] -> only(req, Get, fn() { admin.outbox(ctx, req) })
        _ -> not_found()
      }
    }
    _ -> not_found()
  }
}

fn only(
  req: Request,
  method: http.Method,
  handler: fn() -> Response,
) -> Response {
  case req.method == method {
    True -> handler()
    False -> not_found()
  }
}

/// Express answers an unknown route with an HTML page; this server answers in the error contract.
fn not_found() -> Response {
  contract.error(404, "NOT_FOUND")
}

/// A crash in a handler is a 500 with fixed text; the detail goes to the log.
fn rescue(handler: fn() -> Response) -> Response {
  case exception.rescue(handler) {
    Ok(response) -> response
    Error(crash) -> contract.internal(crash)
  }
}

/// Every /auth request counts against its client address: 40 a minute.
fn auth_limit(ctx: Ctx, req: Request, next: fn() -> Response) -> Response {
  let address = contract.header(req, wisp_ewe.peer_header) |> result.unwrap("?")
  case limits.auth_request(ctx.limits, "auth:" <> address, clock.now_ms()) {
    Ok(Nil) -> next()
    Error(retry_after) ->
      contract.json(
        429,
        json.object([
          #("error", json.string("RATE_LIMITED")),
          #(
            "message",
            json.string("Too many attempts — wait a minute and try again."),
          ),
          #("retryAfterMs", json.int(retry_after)),
        ]),
      )
  }
}

/// States and counts only.
fn health(ctx: Ctx) -> Response {
  case store.read(ctx.store, orgs.count) {
    Error(failure) -> contract.internal(failure)
    Ok(org_count) ->
      contract.json(
        200,
        json.object([
          #("ok", json.bool(True)),
          #("service", json.string("scoutbox-server")),
          #("engine", json.string("sqlite")),
          #("devLogins", json.bool(ctx.config.dev_logins)),
          #("uptimeSec", json.int({ clock.now_ms() - ctx.booted_at } / 1000)),
          // Not ported yet: the player count, which the players domain holds.
          #("orgs", json.int(org_count)),
        ]),
      )
  }
}
