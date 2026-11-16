//// Every route the server answers, and the middleware in front of them.

import exception
import gleam/http.{Get, Post, Put}
import gleam/int
import gleam/json
import gleam/list
import gleam/regexp
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/record_routes as record
import scoutbox/discovery/directory
import scoutbox/discovery/player_routes as discovery
import scoutbox/enterprise/audit_export
import scoutbox/identity/access
import scoutbox/identity/guardian_routes
import scoutbox/identity/invite_routes
import scoutbox/identity/mfa_routes
import scoutbox/identity/orgs
import scoutbox/identity/player_routes
import scoutbox/identity/players
import scoutbox/identity/sign_in
import scoutbox/identity/staff_routes
import scoutbox/insight/review_queue
import scoutbox/messaging/channel_routes as threads
import scoutbox/messaging/delivery_prefs
import scoutbox/messaging/feed_routes
import scoutbox/platform/clock
import scoutbox/platform/fault_routes
import scoutbox/platform/faults
import scoutbox/platform/http as contract
import scoutbox/platform/limits
import scoutbox/platform/operator
import scoutbox/platform/store
import scoutbox/platform/wisp_ewe
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/request_routes
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/safety/admin
import scoutbox/safety/console_routes as console
import scoutbox/safety/report_routes
import scoutbox/verification/applications
import scoutbox/verification/console_routes as verification_console
import scoutbox/verification/invite_routes as invites
import scoutbox/verification/org_admin_routes as org_admin
import scoutbox/verification/personal_routes as personal
import scoutbox/verification/reference_routes as references
import scoutbox/verification/review_routes as review
import scoutbox/vocab/audience
import wisp.{type Request, type Response}

pub fn handle(ctx: Ctx, req: Request) -> Response {
  use <- baseline(ctx)
  use <- rescue
  use <- fault(ctx, req)
  case wisp.path_segments(req) {
    ["__faults"] ->
      case faults.enabled(ctx.faults) {
        True -> fault_routes.handle(ctx, req)
        False -> not_found()
      }
    ["health"] -> only(req, Get, fn() { health(ctx) })
    ["healthz"] -> only(req, Get, fn() { healthz(ctx) })
    ["meta"] -> only(req, Get, operator.meta)
    ["capabilities"] -> only(req, Get, fn() { operator.capabilities(ctx) })
    ["orgs"] -> only(req, Get, fn() { sign_in.org_list(ctx, req) })
    ["media", id] -> only(req, Get, fn() { media_file(id) })
    ["auth", ..rest] -> {
      use <- auth_limit(ctx, req)
      case rest {
        ["org", "login"] -> only(req, Post, fn() { sign_in.login(ctx, req) })
        ["org", "accept-invite"] ->
          only(req, Post, fn() { invite_routes.accept(ctx, req) })
        ["org", "verification", "apply"] ->
          only(req, Post, fn() { applications.apply(ctx, req) })
        ["org", "verification", "apply", id, "confirm-email"] ->
          only(req, Post, fn() { applications.confirm_email(ctx, req, id) })
        ["org", "verification", "apply", id, "evidence"] ->
          only(req, Post, fn() { applications.evidence(ctx, req, id) })
        ["org", "verification", "apply", id, "submit"] ->
          only(req, Post, fn() { applications.submit(ctx, req, id) })
        ["org", "verification", "apply", id, "status"] ->
          only(req, Get, fn() { applications.status(ctx, req, id) })
        ["player", "login"] ->
          only(req, Post, fn() { player_routes.login(ctx, req) })
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
        ["verification", ..path] -> verification_org(ctx, req, org, path)
        ["audit", "export"] ->
          only(req, Get, fn() { audit_export.export(ctx, org) })
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
        ["review-queue"] ->
          only(req, Get, fn() { review_queue.review_queue(ctx, org) })
        ["recruitment", "lifecycle"] ->
          only(req, Get, fn() { lifecycle.vocabulary(ctx) })
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
        ["channels"] -> only(req, Get, fn() { threads.org_list(ctx, req, org) })
        ["channels", "counts"] ->
          only(req, Get, fn() { threads.org_counts(ctx, org) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() { threads.org_send(ctx, req, org, id) })
        ["channels", id, "read"] ->
          only(req, Post, fn() { threads.org_read(ctx, req, org, id) })
        ["channels", id, "typing"] ->
          only(req, Post, fn() { threads.org_typing(ctx, req, org, id) })
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
        ["verification", "org", id] ->
          only(req, Get, fn() { personal.public_org(ctx, id) })
        ["invites", "accept"] ->
          only(req, Post, fn() { invites.player_accept(ctx, req, player) })
        ["references"] -> only(req, Get, fn() { references.mine(ctx, player) })
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
        ["channels"] ->
          only(req, Get, fn() { threads.player_list(ctx, player) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() { threads.player_send(ctx, req, player, id) })
        ["channels", id, "read"] ->
          only(req, Post, fn() { threads.player_read(ctx, req, player, id) })
        ["channels", id, "typing"] ->
          only(req, Post, fn() { threads.player_typing(ctx, req, player, id) })
        ["requests", id, "respond"] ->
          only(req, Post, fn() {
            request_routes.player_respond(ctx, req, player, id)
          })
        _ -> not_found()
      }
    }
    ["guardian", ..rest] -> {
      use guardian <- access.guardian_session(ctx, req)
      case rest {
        ["verification", "org", id] ->
          only(req, Get, fn() { personal.public_org(ctx, id) })
        ["invites", "accept"] ->
          only(req, Post, fn() { invites.guardian_accept(ctx, req, guardian) })
        ["children", id, "references"] ->
          only(req, Get, fn() { references.child(ctx, guardian, id) })
        ["me"] -> only(req, Get, fn() { guardian_routes.me(guardian) })
        ["children"] ->
          case req.method {
            Get -> guardian_routes.children(ctx, guardian)
            Post -> player_routes.create_child(ctx, req, guardian)
            _ -> not_found()
          }
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
        ["channels"] ->
          only(req, Get, fn() { threads.guardian_list(ctx, guardian) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() { threads.guardian_send(ctx, req, guardian, id) })
        ["channels", id, "read"] ->
          only(req, Post, fn() { threads.guardian_read(ctx, req, guardian, id) })
        ["channels", id, "typing"] ->
          only(req, Post, fn() {
            threads.guardian_typing(ctx, req, guardian, id)
          })
        ["requests", id, "respond"] ->
          only(req, Post, fn() {
            request_routes.guardian_respond(ctx, req, guardian, id)
          })
        _ -> not_found()
      }
    }
    ["admin", ..rest] -> {
      use <- access.admin(ctx, req)
      case rest {
        ["verification", ..path] -> verification_admin(ctx, req, path)
        ["outbox"] -> only(req, Get, fn() { admin.outbox(ctx, req) })
        ["channels"] -> only(req, Get, fn() { threads.admin_list(ctx, req) })
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

/// `/admin/verification/…`: Trust & Safety's verification surface.
fn verification_admin(ctx: Ctx, req: Request, path: List(String)) -> Response {
  case path {
    ["orgs", id, "appoint-root"] ->
      only(req, Post, fn() { review.appoint_root(ctx, req, id) })
    ["orgs", id, "revoke"] ->
      only(req, Post, fn() { review.revoke_org(ctx, req, id) })
    ["queue"] -> only(req, Get, fn() { review.queue(ctx, req) })
    ["cases", id] -> only(req, Get, fn() { review.case_view(ctx, id) })
    ["evidence", id] ->
      only(req, Get, fn() { review.admin_evidence(ctx, req, id) })
    ["claims", id, "approve"] ->
      only(req, Post, fn() { review.approve(ctx, req, id) })
    ["claims", id, "reject"] ->
      only(req, Post, fn() { review.reject(ctx, req, id) })
    ["claims", id, "request-info"] ->
      only(req, Post, fn() { review.request_info(ctx, req, id) })
    ["claims", id, "suspend"] ->
      only(req, Post, fn() {
        review.suspend_or_revoke(ctx, req, id, claim_row.Suspended)
      })
    ["claims", id, "revoke"] ->
      only(req, Post, fn() {
        review.suspend_or_revoke(ctx, req, id, claim_row.Revoked)
      })
    ["claims", id, "reinstate"] ->
      only(req, Post, fn() { review.reinstate(ctx, req, id) })
    ["root-requests", id, "approve"] ->
      only(req, Post, fn() { applications.approve(ctx, req, id) })
    ["root-requests", id, "reject"] ->
      only(req, Post, fn() { applications.reject(ctx, req, id) })
    ["domain-requests"] -> only(req, Get, fn() { review.domain_requests(ctx) })
    ["domain-requests", id, "decide"] ->
      only(req, Post, fn() { review.decide_domain(ctx, req, id) })
    ["disputes"] -> only(req, Get, fn() { review.disputes(ctx) })
    ["disputes", id, "resolve"] ->
      only(req, Post, fn() { review.resolve_dispute(ctx, req, id) })
    ["authorities", id, "claims"] ->
      only(req, Get, fn() { review.authority_claims(ctx, id) })
    ["authorities", id, "flag"] ->
      only(req, Post, fn() { review.flag_authority(ctx, req, id) })
    _ -> not_found()
  }
}

/// `/org/verification/…`: a staff member's own verification and their organisation's console.
fn verification_org(
  ctx: Ctx,
  req: Request,
  org: access.OrgAccess,
  path: List(String),
) -> Response {
  case path {
    ["me"] -> only(req, Get, fn() { personal.me(ctx, org) })
    ["identity"] -> only(req, Post, fn() { personal.identity(ctx, req, org) })
    ["claims", id, "evidence"] ->
      only(req, Post, fn() { personal.evidence(ctx, req, org, id) })
    ["claims", id, "submit"] ->
      only(req, Post, fn() { personal.submit(ctx, req, org, id) })
    ["claims", id, "dispute"] ->
      only(req, Post, fn() { personal.dispute(ctx, req, org, id) })
    ["affiliation"] ->
      only(req, Post, fn() { personal.affiliation(ctx, req, org) })
    ["work-email"] ->
      only(req, Post, fn() { personal.work_email(ctx, req, org) })
    ["work-email", "confirm"] ->
      only(req, Post, fn() { personal.confirm_work_email(ctx, req, org) })
    ["public", "user", id] ->
      only(req, Get, fn() { personal.public_user(ctx, id) })
    ["public", "org", id] ->
      only(req, Get, fn() { personal.public_org(ctx, id) })
    ["public", "users"] ->
      only(req, Get, fn() { personal.public_users(ctx, req) })
    ["dashboard"] ->
      only(req, Get, fn() { verification_console.dashboard(ctx, org) })
    ["requests"] ->
      only(req, Get, fn() { verification_console.requests(ctx, org) })
    ["requests", id, "decide"] ->
      only(req, Post, fn() { verification_console.decide(ctx, req, org, id) })
    ["staff"] ->
      only(req, Get, fn() { verification_console.staff_register(ctx, req, org) })
    ["staff", id, "departed"] ->
      only(req, Post, fn() { verification_console.departed(ctx, req, org, id) })
    ["references"] ->
      case req.method {
        Get -> references.list_for_org(ctx, org)
        Post -> references.create(ctx, req, org)
        _ -> not_found()
      }
    ["references", id, "withdraw"] ->
      only(req, Post, fn() { references.withdraw(ctx, req, org, id) })
    ["references", id, "correct"] ->
      only(req, Post, fn() { references.correct(ctx, req, org, id) })
    ["player-invites"] ->
      case req.method {
        Get -> invites.list_invites(ctx, org)
        Post -> invites.create(ctx, req, org)
        _ -> not_found()
      }
    ["licence-providers"] ->
      only(req, Get, fn() { review.licence_providers(ctx) })
    ["licence"] -> only(req, Post, fn() { review.new_licence(ctx, req, org) })
    ["licence", id, "submit"] ->
      only(req, Post, fn() { review.submit_licence(ctx, req, org, id) })
    ["evidence", id] ->
      only(req, Get, fn() { review.org_evidence(ctx, req, org, id) })
    ["domains"] ->
      case req.method {
        Get -> org_admin.domains(ctx, org)
        Post -> org_admin.add_domain(ctx, req, org)
        _ -> not_found()
      }
    ["domains", id, "confirm"] ->
      only(req, Post, fn() { org_admin.confirm_domain(ctx, req, org, id) })
    ["admins"] ->
      case req.method {
        Get -> org_admin.admins(ctx, org)
        Post -> org_admin.grant(ctx, req, org)
        _ -> not_found()
      }
    ["admins", id, "revoke"] ->
      only(req, Post, fn() { org_admin.revoke(ctx, req, org, id) })
    ["root-transfers", id, "approve"] ->
      only(req, Post, fn() { org_admin.approve_transfer(ctx, req, org, id) })
    ["conflicts"] ->
      case req.method {
        Get -> org_admin.list_conflicts(ctx, org)
        Post -> org_admin.declare(ctx, req, org)
        _ -> not_found()
      }
    ["conflicts", id, "withdraw"] ->
      only(req, Post, fn() { org_admin.withdraw_conflict(ctx, org, id) })
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

/// The headers on every response, as the TypeScript server's HTTP baseline sets them: the schema version, the
/// browser hardening headers, and on an error whether a retry could succeed. A response that already says
/// whether it is retryable (a simulated fault) keeps its own answer.
fn baseline(ctx: Ctx, handler: fn() -> Response) -> Response {
  let response =
    handler()
    |> wisp.set_header("x-scoutbox-schema", int.to_string(ctx.schema_version))
    |> wisp.set_header("x-content-type-options", "nosniff")
    |> wisp.set_header("referrer-policy", "no-referrer")
    |> wisp.set_header("x-frame-options", "DENY")
    |> wisp.set_header("cross-origin-resource-policy", "same-site")
    |> wisp.set_header(
      "permissions-policy",
      "geolocation=(), microphone=(), payment=()",
    )
  case
    response.status >= 400,
    list.key_find(response.headers, "x-scoutbox-retry")
  {
    True, Error(Nil) ->
      wisp.set_header(response, "x-scoutbox-retry", case response.status {
        429 | 502 | 503 | 504 -> "retryable"
        _ -> "not-retryable"
      })
    _, _ -> response
  }
}

/// The development fault layer, in front of every route but its own.
fn fault(ctx: Ctx, req: Request, next: fn() -> Response) -> Response {
  case faults.for_path(ctx.faults, req.path) {
    faults.Pass -> next()
    faults.Pause(ms) -> {
      faults.pause(ms)
      next()
    }
    faults.Fail(after_ms:, status:, error:, retryable:, message:) -> {
      faults.pause(after_ms)
      contract.json(
        status,
        json.object([
          #("error", json.string(error)),
          #("message", json.string(message)),
          #("retryable", json.bool(retryable)),
          #("simulated", json.bool(True)),
          #("requestId", json.null()),
        ]),
      )
      |> wisp.set_header("x-scoutbox-retry", case retryable {
        True -> "retryable"
        False -> "not-retryable"
      })
    }
  }
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

/// `GET /media/:id`. Not ported yet: signed media links and the media their owners and the organisations that
/// may see them can fetch (uploads are out of this slice's scope). Until then no request is authorised, which is
/// the TypeScript server's answer for every file this server stores: verification evidence, which is never on a
/// public path.
fn media_file(id: String) -> Response {
  let assert Ok(shape) = regexp.from_string("^[a-zA-Z0-9-]+$")
  case regexp.check(shape, id) {
    False -> contract.error(400, "BAD_MEDIA_ID")
    True ->
      contract.json(
        401,
        json.object([
          #("error", json.string("MEDIA_AUTH_REQUIRED")),
          #(
            "message",
            json.string(
              "Media links are short-lived and tied to your login — refetch the profile for a fresh link.",
            ),
          ),
        ]),
      )
  }
}

/// `GET /healthz`: up, for how long, and on which schema.
fn healthz(ctx: Ctx) -> Response {
  contract.json(
    200,
    json.object([
      #("ok", json.bool(True)),
      #("uptimeS", json.int({ clock.now_ms() - ctx.booted_at + 500 } / 1000)),
      #("schemaVersion", json.int(ctx.schema_version)),
    ]),
  )
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
