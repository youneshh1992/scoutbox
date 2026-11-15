//// Every route the server answers, and the middleware in front of them.

import exception
import gleam/http.{Get, Post, Put}
import gleam/json
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/record_routes as record
import scoutbox/discovery/directory
import scoutbox/discovery/player_routes as discovery
import scoutbox/identity/access
import scoutbox/identity/guardian_routes
import scoutbox/identity/invite_routes
import scoutbox/identity/mfa_routes
import scoutbox/identity/orgs
import scoutbox/identity/player_routes
import scoutbox/identity/players
import scoutbox/identity/sign_in
import scoutbox/identity/staff_routes
import scoutbox/messaging/delivery_prefs
import scoutbox/messaging/feed_routes
import scoutbox/platform/clock
import scoutbox/platform/http as contract
import scoutbox/platform/limits
import scoutbox/platform/store
import scoutbox/platform/wisp_ewe
import scoutbox/recruitment/request_routes
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/admin
import scoutbox/safety/console_routes as console
import scoutbox/safety/report_routes
import scoutbox/vocab/audience
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
        ["player", "signup"] ->
          only(req, Post, fn() { player_routes.signup(ctx, req) })
        ["guardian", "login"] ->
          only(req, Post, fn() { guardian_routes.login(ctx, req) })
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
        ["players", id] ->
          only(req, Get, fn() { discovery.profile(ctx, org, id) })
        ["players", id, "notes"] ->
          only(req, Post, fn() { discovery.add_note(ctx, req, org, id) })
        ["players", id, "save"] ->
          only(req, Post, fn() {
            discovery.mark(ctx, req, org, id, ledger_row.Save)
          })
        ["players", id, "shortlist"] ->
          only(req, Post, fn() {
            discovery.mark(ctx, req, org, id, ledger_row.Shortlist)
          })
        ["players", id, "request"] ->
          only(req, Post, fn() { request_routes.request(ctx, req, org, id) })
        ["shortlist"] -> only(req, Get, fn() { discovery.shortlist(ctx, org) })
        ["players"] ->
          only(req, Get, fn() { directory.directory(ctx, req, org) })
        ["filmroom"] ->
          only(req, Get, fn() { directory.film_room(ctx, req, org) })
        ["fixtures"] ->
          only(req, Get, fn() { directory.fixtures(ctx, req, org) })
        ["ledger"] ->
          only(req, Get, fn() { request_routes.org_ledger(ctx, req, org) })
        ["funnel"] -> only(req, Get, fn() { request_routes.funnel(ctx, org) })
        ["report"] ->
          only(req, Post, fn() { report_routes.org_report(ctx, req, org) })
        ["reports"] ->
          only(req, Get, fn() { report_routes.org_reports(ctx, org) })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(ctx, audience.OrgUser, org.user.id)
          })
        _ -> not_found()
      }
    }
    ["player", ..rest] -> {
      use player <- access.player_session(ctx, req)
      case rest {
        ["block"] ->
          only(req, Post, fn() { report_routes.player_block(ctx, req, player) })
        ["report"] ->
          only(req, Post, fn() { report_routes.player_report(ctx, req, player) })
        ["reports"] ->
          only(req, Get, fn() { report_routes.player_reports(ctx, player) })
        ["timeline"] ->
          only(req, Post, fn() { player_routes.add_timeline(ctx, req, player) })
        ["export"] -> only(req, Get, fn() { player_routes.export(ctx, player) })
        ["me"] -> only(req, Get, fn() { record.me(player) })
        ["availability"] ->
          only(req, Post, fn() { record.availability(ctx, req, player) })
        ["first-team-seeker"] ->
          only(req, Post, fn() { record.first_team_seeker(ctx, req, player) })
        ["academyplus"] ->
          only(req, Post, fn() { record.academy_plus(ctx, req, player) })
        ["medical", "share"] ->
          only(req, Post, fn() { record.medical_share(ctx, req, player) })
        ["stats"] -> only(req, Post, fn() { record.stats(ctx, req, player) })
        ["badges"] -> only(req, Post, fn() { record.badges(ctx, req, player) })
        ["prefs"] -> only(req, Post, fn() { record.prefs(ctx, req, player) })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(ctx, audience.Player, player.player.row.id)
          })
        _ -> not_found()
      }
    }
    ["guardian", ..rest] -> {
      use guardian <- access.guardian_session(ctx, req)
      case rest {
        ["me"] -> only(req, Get, fn() { guardian_routes.me(guardian) })
        ["children"] ->
          only(req, Get, fn() { guardian_routes.children(ctx, guardian) })
        ["children", id, "availability"] ->
          only(req, Post, fn() {
            record.child_availability(ctx, req, guardian, id)
          })
        ["children", id, "medical", "share"] ->
          only(req, Post, fn() {
            record.child_medical_share(ctx, req, guardian, id)
          })
        ["coguardian"] ->
          only(req, Post, fn() {
            guardian_routes.add_co_guardian(ctx, req, guardian)
          })
        ["log"] ->
          only(req, Get, fn() { guardian_routes.log(ctx, req, guardian) })
        ["report"] ->
          only(req, Post, fn() {
            report_routes.guardian_report(ctx, req, guardian)
          })
        ["reports"] ->
          only(req, Get, fn() { report_routes.guardian_reports(ctx, guardian) })
        ["block"] ->
          only(req, Post, fn() {
            report_routes.guardian_block(ctx, req, guardian)
          })
        ["inbox"] ->
          only(req, Get, fn() {
            request_routes.guardian_inbox(ctx, req, guardian)
          })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(ctx, audience.Guardian, guardian.row.id)
          })
        _ -> not_found()
      }
    }
    ["admin", ..rest] -> {
      use <- access.admin(ctx, req)
      case rest {
        ["outbox"] -> only(req, Get, fn() { admin.outbox(ctx, req) })
        ["overview"] -> only(req, Get, fn() { console.overview(ctx) })
        ["metrics"] -> only(req, Get, fn() { console.metrics(ctx) })
        ["reports"] -> only(req, Get, fn() { console.reports(ctx, req) })
        ["reports", id, "resolve"] ->
          only(req, Post, fn() { console.resolve(ctx, req, id) })
        ["blocks"] -> only(req, Get, fn() { console.blocks(ctx, req) })
        ["blocks", id, "lift"] ->
          only(req, Post, fn() { console.lift(ctx, req, id) })
        ["moderation"] -> only(req, Get, fn() { console.moderation(ctx, req) })
        ["clubs"] -> only(req, Get, fn() { console.clubs(ctx, req) })
        ["guardians"] ->
          only(req, Get, fn() { guardian_routes.admin_list(ctx, req) })
        ["guardians", id, "idv"] ->
          only(req, Post, fn() { guardian_routes.review_id(ctx, req, id) })
        ["clubs", id, "credentials"] ->
          only(req, Post, fn() { console.credentials(ctx, req, id) })
        ["clubs", id, "verification"] ->
          only(req, Post, fn() { console.verification(ctx, req, id) })
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
  let counts =
    store.read(ctx.store, fn(read) {
      use players <- result.try(players.count(read))
      use orgs <- result.map(orgs.count(read))
      #(players, orgs)
    })
  case counts {
    Error(failure) -> contract.internal(failure)
    Ok(#(player_count, org_count)) ->
      contract.json(
        200,
        json.object([
          #("ok", json.bool(True)),
          #("service", json.string("scoutbox-server")),
          #("engine", json.string("sqlite")),
          #("devLogins", json.bool(ctx.config.dev_logins)),
          #("uptimeSec", json.int({ clock.now_ms() - ctx.booted_at } / 1000)),
          #("players", json.int(player_count)),
          #("orgs", json.int(org_count)),
        ]),
      )
  }
}
