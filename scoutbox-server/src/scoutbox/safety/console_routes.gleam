//// The Trust & Safety console, behind the admin key (domains/safety/safety.mjs `registerSafetyConsole`, and the
//// enterprise metrics).

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/guardians
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/messaging/channels
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Read}
import scoutbox/rows/moderation_log
import scoutbox/rows/ops_events
import scoutbox/rows/reports
import scoutbox/safety/audit
import scoutbox/verification/core as verification_core
import scoutbox/verification/review_routes as verification_review
import scoutbox/vocab/audience
import wisp.{type Request, type Response}

const outcome_max = 2000

const password_max = 256

const domain_max = 253

fn count_of(read: Read, table: String) -> Result(Int, store.Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM " <> table,
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// `GET /admin/overview`: counts and states only.
pub fn overview(ctx: Ctx) -> Response {
  let counts =
    store.read(ctx.store, fn(read) {
      use players <- result.try(players.count(read))
      use guardians <- result.try(guardians.count(read))
      use orgs <- result.try(orgs.count(read))
      use open <- result.try(audit.open_report_count(read))
      use blocks <- result.try(audit.block_count(read))
      use hits <- result.try(audit.moderation_count(read, None))
      use emails <- result.try(count_of(read, "outbox"))
      use sessions <- result.try(count_of(read, "sessions"))
      use channel_count <- result.try(channels.count(read))
      use grooming <- result.map(audit.moderation_count(
        read,
        Some(moderation_log.Grooming),
      ))
      json.object([
        #("players", json.int(players)),
        #("guardians", json.int(guardians)),
        #("orgs", json.int(orgs)),
        #("openReports", json.int(open)),
        #("blocks", json.int(blocks)),
        #("moderationHits", json.int(hits)),
        // Not ported yet: signings (recruitment), invoices (billing) and the push log (outbound providers) are
        // domains this server does not run; it holds none of each.
        #("channels", json.int(channel_count)),
        #("signings", json.int(0)),
        #("invoices", json.int(0)),
        #("emailsSent", json.int(emails)),
        #("pushesSent", json.int(0)),
        #("sessions", json.int(sessions)),
        #("storageEngine", json.string("sqlite")),
        #("groomingEscalations", json.int(grooming)),
        #("persisted", json.bool(True)),
      ])
    })
  case counts {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /admin/reports`: urgent first, then oldest pending, then resolved (newest first).
pub fn reports(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind, IntKind, IntKind])
  case store.read(ctx.store, audit.triage_page(_, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, audit.report_view)
    Error(failure) -> http.internal(failure)
  }
}

pub fn blocks(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  case store.read(ctx.store, audit.block_page(_, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, audit.block_view)
    Error(failure) -> http.internal(failure)
  }
}

pub fn moderation(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  case store.read(ctx.store, audit.moderation_page(_, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, audit.moderation_view)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /admin/blocks/:id/lift`: the row is deleted (Q5, docs/decisions.md).
pub fn lift(ctx: Ctx, req: Request, id: String) -> Response {
  use Nil <- http.body(req, input.nothing(), [])
  let outcome =
    store.unit(ctx.store, fn(tx) {
      audit.lift_block(tx, id) |> result.map(fn(b) { #(b, []) })
    })
  case outcome {
    Ok(Some(block)) ->
      http.json(200, json.object([#("lifted", audit.block_view(block))]))
    Ok(None) -> http.error(404, "BLOCK_NOT_FOUND")
    Error(failure) -> http.internal(failure)
  }
}

type Resolve {
  Resolve(outcome: Option(String), action: Option(Action))
}

type Action {
  NoAction
  Warning
  SuspendOrg
  Dismiss
}

/// `POST /admin/reports/:id/resolve`. The resolution, the organisation's suspension and the reporter's notice are
/// one unit; a system escalation has no reporter to tell.
pub fn resolve(ctx: Ctx, req: Request, id: String) -> Response {
  case store.read(ctx.store, audit.report_by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "REPORT_NOT_FOUND")
    Ok(Some(report)) if report.status != reports.PendingReview ->
      http.error(409, "ALREADY_RESOLVED")
    Ok(Some(_)) -> {
      let shape = {
        use outcome <- input.field(
          "outcome",
          input.nullish(input.text(outcome_max)),
        )
        use action <- input.field(
          "action",
          input.nullish(
            input.one_of([
              #("none", NoAction),
              #("warning", Warning),
              #("suspend_org", SuspendOrg),
              #("dismiss", Dismiss),
            ]),
          ),
        )
        input.done(Resolve(outcome:, action:))
      }
      use body <- http.body(req, shape, [])
      case input.filled(body.outcome) {
        None -> http.required("OUTCOME_REQUIRED", "outcome")
        Some(outcome) -> {
          let now = clock.now_ms()
          let resolved =
            store.unit(ctx.store, fn(tx) {
              use r <- result.try(audit.resolve_report(
                tx,
                id,
                outcome:,
                at: now,
              ))
              use _ <- result.try(case body.action, r.target_org_id {
                Some(SuspendOrg), Some(org_id) -> orgs.suspend(tx, org_id)
                _, _ -> Ok(Nil)
              })
              let reporter = case r.by_kind {
                reports.ByKindPlayer -> Some(audience.Player)
                reports.Guardian -> Some(audience.Guardian)
                reports.OrgUser -> Some(audience.OrgUser)
                reports.System -> None
              }
              use _ <- result.map(case reporter {
                None -> Ok(Nil)
                Some(kind) ->
                  notifications.notify(
                    tx,
                    to: kind,
                    id: r.by_id,
                    type_: "report_resolved",
                    text: "Your report was reviewed: " <> outcome,
                    ref_id: Some(r.id),
                    at: now,
                  )
              })
              #(r, [])
            })
          case resolved {
            Ok(r) -> http.json(200, audit.report_view(r))
            Error(store.Refused(audit.AlreadyResolved)) ->
              http.error(409, "ALREADY_RESOLVED")
            Error(store.Refused(audit.ReportNotFound)) ->
              http.error(404, "REPORT_NOT_FOUND")
            Error(failure) -> http.internal(failure)
          }
        }
      }
    }
  }
}

/// The organisation as the console shows it: its view and whether it is safeguarding-certified now.
fn org_standing(read: Read, org: Org) -> Result(json.Json, store.Fail(e)) {
  use certified <- result.map(orgs.safeguarding_certified(read, org))
  json.object(
    list.append(orgs.view(org), [
      #("safeguardingCertified", json.bool(certified)),
    ]),
  )
}

/// `GET /admin/clubs`, oldest first.
pub fn clubs(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind])
  let found =
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(orgs.page(read, page))
      use views <- result.map(list.try_map(items, org_standing(read, _)))
      #(views, next)
    })
  case found {
    Ok(#(views, next)) -> pages.respond(views, next, fn(v) { v })
    Error(failure) -> http.internal(failure)
  }
}

fn with_org(ctx: Ctx, id: String, next: fn(Org) -> Response) -> Response {
  case store.read(ctx.store, orgs.by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "ORG_NOT_FOUND")
    Ok(Some(org)) -> next(org)
  }
}

/// `POST /admin/clubs/:id/credentials`: how real clubs sign in when the demo sign-ins are off.
///
/// Not ported yet: storing the password needs scrypt, which OTP's crypto lacks (see sign-in). The input is
/// checked as the TypeScript server checks it; a valid password is refused as not supported.
pub fn credentials(ctx: Ctx, req: Request, id: String) -> Response {
  use _org <- with_org(ctx, id)
  let shape = {
    use password <- input.field(
      "password",
      input.nullish(input.text(password_max)),
    )
    input.done(password)
  }
  use password <- http.body(req, shape, [])
  case password {
    Some(p) ->
      case input.utf16_length(p) >= 8 {
        True ->
          http.error_message(
            501,
            "NOT_PORTED",
            "Provisioning club passwords is not supported by this server yet.",
          )
        False -> too_short()
      }
    None -> too_short()
  }
}

fn too_short() -> Response {
  http.error_message(
    400,
    "PASSWORD_TOO_SHORT",
    "Club passwords need at least 8 characters.",
  )
}

/// `POST /admin/clubs/:id/verification`: the standing switches, and only those.
///
/// Not ported yet: the TypeScript server mirrors the decision on the organisation's identity claim
/// (verification), and announces the change on the live stream.
pub fn verification(ctx: Ctx, req: Request, id: String) -> Response {
  use org <- with_org(ctx, id)
  let shape = {
    use verified <- input.field("verified", input.optional(input.boolean()))
    use safeguarding <- input.field(
      "safeguardingContractSigned",
      input.optional(input.boolean()),
    )
    use suspended <- input.field("suspended", input.optional(input.boolean()))
    use domain <- input.field(
      "verifiedDomain",
      input.clearable(input.text(domain_max)),
    )
    input.done(orgs.Standing(
      verified:,
      safeguarding_contract_signed: safeguarding,
      suspended:,
      // A blank domain clears it.
      verified_domain: option.map(domain, fn(d) {
        option.then(d, fn(s) {
          case string.trim(s) {
            "" -> None
            trimmed -> Some(trimmed)
          }
        })
      }),
    ))
  }
  use standing <- http.body(req, shape, [])
  let updated =
    store.unit(ctx.store, fn(tx) {
      use _ <- result.try(orgs.set_standing(tx, org.id, standing))
      // Mirrored on the organisation's identity claim in the same unit.
      use _ <- result.try(verification_review.sync_legacy_toggle(
        tx,
        org.id,
        standing.verified,
        clock.now_ms(),
      ))
      let read = store.reading(tx)
      use found <- result.try(orgs.by_id(read, org.id))
      let assert Some(updated) = found as "the organisation is still there"
      use view <- result.map(org_standing(read, updated))
      #(view, [])
    })
  case updated {
    Ok(view) -> http.json(200, view)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /admin/metrics`.
///
/// Not ported yet: the process's request counters (platform metrics), the dispatch backlog (messaging) and the
/// webhook backlog (integrations). An operations event's detail fields arrive with the events that write them.
pub fn metrics(ctx: Ctx) -> Response {
  // On the writer: it holds the verification counters (verification/core `count`).
  let found =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use verification <- result.try(verification_core.metrics(tx))
      use delivery <- result.try(audit.ops_count(
        read,
        ops_events.DeliveryFailed,
      ))
      use webhook <- result.try(audit.ops_count(read, ops_events.WebhookFailed))
      use newest <- result.map(audit.ops_newest(read, 50))
      #(
        json.object([
          #("deliveryFailures", json.int(delivery)),
          #("webhookFailures", json.int(webhook)),
          #("dispatchBacklog", json.int(0)),
          #("webhookBacklog", json.int(0)),
          #(
            "opsEvents",
            json.array(newest, fn(e) {
              json.object([
                #("id", json.string(e.id)),
                #("at", json.int(e.occurred_at)),
                #("kind", json.string(ops_events.kind_to_string(e.kind))),
                #("detail", json.null()),
              ])
            }),
          ),
          #("verification", verification),
          #(
            "note",
            json.string(
              "Counters cover this process since boot. Local development metrics — not a production SLA measurement.",
            ),
          ),
        ]),
        [],
      )
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}
