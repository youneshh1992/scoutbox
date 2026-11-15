//// A club's direct request to a player, its Discovery Ledger and funnel, and the guardian's Inbox
//// (domains/recruitment/requests.mjs, ledger.mjs, inbox.mjs).
////
//// There is no direct message channel: a club files a request and contact unlocks on acceptance. A minor's
//// request goes to the guardian, never the child.

import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store
import scoutbox/recruitment/requests
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import wisp.{type Request, type Response}

const message_max = 2000

type Direct {
  Direct(type_: request_row.Type, message: Option(String))
}

/// `POST /org/players/:id/request`.
///
/// Not ported yet: trial requests (their logistics, slots and the overdue-report rule), and the per-club budget
/// of 30 contacts an hour.
pub fn request(ctx: Ctx, req: Request, a: OrgAccess, id: String) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.for_org(_, id, a.org, now)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(_, access))) if !access.visible ->
      case a.org.type_ {
        org_type.Agency ->
          http.error_message(
            403,
            "UNDER_18_WALL",
            "Agency accounts cannot contact minors.",
          )
        org_type.Club ->
          http.error_message(
            403,
            "VERIFIED_CLUBS_ONLY",
            "Only verified clubs can contact under-18 players (via their guardian).",
          )
      }
    Ok(Some(#(_, access))) if access.blocked ->
      http.error_message(
        403,
        "BLOCKED",
        "This player (or their guardian) has blocked your organisation.",
      )
    Ok(Some(#(p, _))) -> {
      let shape = {
        use type_ <- input.field(
          "type",
          input.required(input.one_of(request_row.type_pairs)),
        )
        use message <- input.field(
          "message",
          input.nullish(input.text(message_max)),
        )
        input.done(Direct(type_:, message:))
      }
      use body <- http.body(req, shape, [
        #("type", "TYPE_MUST_BE_CONTACT_OR_TRIAL"),
      ])
      let message = option.unwrap(body.message, "")
      use <- moderate.or_refuse(
        ctx,
        message,
        audit.Context(
          kind: "org_request_message",
          player_id: None,
          org_id: Some(a.org.id),
          user_id: Some(a.user.id),
        ),
      )
      case body.type_ {
        request_row.Trial ->
          http.error_message(
            501,
            "NOT_PORTED",
            "Trial requests are not supported by this server yet.",
          )
        request_row.Contact -> contact(ctx, a, p, message, now)
      }
    }
  }
}

type Refusal {
  Pending(request_id: String)
}

fn contact(
  ctx: Ctx,
  a: OrgAccess,
  p: players.Player,
  message: String,
  now: Int,
) -> Response {
  let minor = !players.is_adult(p, now)
  let guardian_id = case minor {
    True -> p.row.guardian_id
    False -> None
  }
  let filed =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      // One pending request of a type per club and player.
      use pending <- result.try(requests.pending_between(
        read,
        a.org.id,
        p.row.id,
        request_row.Contact,
      ))
      use <- refuse_when(pending, fn(r: requests.Request) { Pending(r.id) })
      use certified <- result.try(orgs.safeguarding_certified(read, a.org))
      use r <- result.try(requests.create_contact(
        tx,
        requests.NewContact(
          player_id: p.row.id,
          player_name: p.row.name,
          org_id: a.org.id,
          org_name: a.org.name,
          org_type: a.org.type_,
          org_verified: a.org.verified,
          org_safeguarding_certified: certified,
          org_trusted_partner: a.org.trusted_partner,
          user_id: a.user.id,
          scout_name: a.user.name,
          scout_role: a.user.role,
          message:,
          guardian_id:,
          at: now,
        ),
      ))
      use _ <- result.try(ledger.append(
        tx,
        ledger.Entry(
          entry_type: case minor {
            True -> ledger_row.ContactRequestToGuardian
            False -> ledger_row.ContactRequest
          },
          player_id: Some(p.row.id),
          org_id: Some(a.org.id),
          org_name: Some(a.org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      ))
      let notice = fn(kind, to, text) {
        notifications.notify(
          tx,
          to: kind,
          id: to,
          type_: "request",
          text:,
          ref_id: Some(r.id),
          at: now,
        )
      }
      use _ <- result.map(case guardian_id {
        Some(g) -> {
          use _ <- result.try(notice(
            audience.Guardian,
            g,
            a.org.name
              <> " has requested to discuss a conversation for "
              <> p.row.name
              <> ".",
          ))
          notice(
            audience.Player,
            p.row.id,
            a.org.name
              <> " contacted your parent/guardian about a conversation.",
          )
        }
        None ->
          notice(
            audience.Player,
            p.row.id,
            a.org.name <> " sent you a contact request.",
          )
      })
      // Not ported yet: the live 'inbox' event.
      #(r, [])
    })
  case filed {
    Ok(r) ->
      http.json(
        201,
        json.object([
          #("ok", json.bool(True)),
          #("requestId", json.string(r.id)),
          #("status", json.string("pending")),
          #("routedTo", json.string(party.to_string(r.routed_to))),
        ]),
      )
    Error(store.Refused(Pending(request_id))) ->
      http.json(
        409,
        json.object([
          #("error", json.string("REQUEST_PENDING")),
          #(
            "message",
            json.string(
              "A contact request to this player is already awaiting an answer.",
            ),
          ),
          #("requestId", json.string(request_id)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

fn refuse_when(
  found: Option(a),
  refusal: fn(a) -> e,
  next: fn() -> Result(b, store.Fail(e)),
) -> Result(b, store.Fail(e)) {
  case found {
    Some(a) -> store.refuse(refusal(a))
    None -> next()
  }
}

/// `GET /org/ledger`: the club's own page of the ledger, newest first.
pub fn org_ledger(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.lenient(req, [IntKind])
  case store.read(ctx.store, ledger.page_for_org(_, a.org.id, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, ledger.view)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /org/funnel`: every figure counted from recorded events.
///
/// Not ported yet: trials booked and reported (the trials) and signings (recruitment's signings) count none.
pub fn funnel(ctx: Ctx, a: OrgAccess) -> Response {
  let id = a.org.id
  let found =
    store.read(ctx.store, fn(read) {
      use views <- result.try(ledger.count_for_org(read, id, "view"))
      use saves <- result.try(ledger.count_for_org(read, id, "save"))
      use shortlists <- result.try(ledger.count_for_org(read, id, "shortlist"))
      use sent <- result.try(requests.count_for_org(read, id, None))
      use accepted <- result.try(requests.count_for_org(
        read,
        id,
        Some(request_row.Accepted),
      ))
      use actors <- result.map(ledger.top_actors_for_org(read, id, 8))
      let stage = fn(key, label, count) {
        json.object([
          #("key", json.string(key)),
          #("label", json.string(label)),
          #("count", json.int(count)),
        ])
      }
      json.object([
        #(
          "stages",
          json.preprocessed_array([
            stage("views", "Profile views", views),
            stage("saves", "Saves", saves),
            stage("shortlists", "Shortlists", shortlists),
            stage("requests", "Requests sent", sent),
            stage("accepted", "Requests accepted", accepted),
            stage("trials", "Trials booked", 0),
            stage("reports", "Reports filed", 0),
            stage("signings", "Signings", 0),
          ]),
        ),
        #(
          "byScout",
          json.array(actors, fn(a) {
            json.object([
              #("scoutName", json.string(a.0)),
              #("events", json.int(a.1)),
            ])
          }),
        ),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/inbox`: the requests about the children, routed to the guardian, newest first.
pub fn guardian_inbox(ctx: Ctx, req: Request, g: Guardian) -> Response {
  use page <- pages.lenient(req, [IntKind])
  case
    store.read(ctx.store, requests.page_for_guardian_of(_, g.child_ids, page))
  {
    Ok(#(items, next)) -> pages.respond(items, next, requests.recipient_view)
    Error(failure) -> http.internal(failure)
  }
}
