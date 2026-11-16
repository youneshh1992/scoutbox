//// A club's direct request to a player, its Discovery Ledger and funnel, and the guardian's Inbox
//// (domains/recruitment/requests.mjs, ledger.mjs, inbox.mjs).
////
//// There is no direct message channel: a club files a request and contact unlocks on acceptance. A minor's
//// request goes to the guardian, never the child.

import gleam/bool
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/channels
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store
import scoutbox/recruitment/requests
import scoutbox/rows/id
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
pub fn request(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.PlayerId,
) -> Response {
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
          channel_id: None,
          request_id: None,
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
  Pending(request_id: id.RequestId)
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
          ref_id: Some(id.request_to_string(r.id)),
          at: now,
        )
      }
      use _ <- result.map(case guardian_id {
        Some(g) -> {
          use _ <- result.try(notice(
            audience.Guardian,
            id.guardian_to_string(g),
            a.org.name
              <> " has requested to discuss a conversation for "
              <> p.row.name
              <> ".",
          ))
          notice(
            audience.Player,
            id.player_to_string(p.row.id),
            a.org.name
              <> " contacted your parent/guardian about a conversation.",
          )
        }
        None ->
          notice(
            audience.Player,
            id.player_to_string(p.row.id),
            a.org.name <> " sent you a contact request.",
          )
      })
      // Not ported yet: the live 'inbox' event.
      r
    })
  case filed {
    Ok(r) ->
      http.json(
        201,
        json.object([
          #("ok", json.bool(True)),
          #("requestId", id.request_json(r.id)),
          #("status", json.string("pending")),
          #("routedTo", party.to_json(r.routed_to)),
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
          #("requestId", id.request_json(request_id)),
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

// ------------------------------------------------------------------------------------------------- answering

type Answer {
  Answer(accept: Bool, message: Option(Dynamic))
}

/// `accept` is true or false, never "false" read as truthy. The slot and the reply keep their own rules.
fn answer_shape() -> input.Shape(Answer) {
  use accept <- input.field("accept", input.required(input.boolean()))
  use _ <- input.field("chosenSlot", input.optional(input.anything()))
  use message <- input.field("message", input.optional(input.anything()))
  input.done(Answer(accept:, message:))
}

const reply_max = 500

/// contact.mjs `plainShared`: tags, angle brackets and control characters removed, trimmed and cut.
///
/// Not ported yet: NFC normalisation (OTP's `unicode:characters_to_nfc_binary` is an FFI this server avoids).
fn plain(text: String) -> String {
  let assert Ok(tags) = regexp.from_string("<[^>]*>|[<>]")
  let assert Ok(controls) =
    regexp.from_string("[\\x{0}-\\x{8}\\x{B}\\x{C}\\x{E}-\\x{1F}\\x{7F}]")
  regexp.replace(tags, text, "")
  |> regexp.replace(controls, _, "")
  |> string.trim
  |> input.utf16_take(reply_max)
}

/// The optional short reply a contact may carry: `Ok(None)` for no reply, or the 400 that refuses it.
fn contact_reply(
  r: requests.Request,
  raw: Option(Dynamic),
) -> Result(Option(String), Response) {
  let as_text = option.map(raw, decode.run(_, decode.string))
  let is_nothing = case raw {
    None -> True
    Some(v) -> dynamic.classify(v) == "Nil" || as_text == Some(Ok(""))
  }
  case is_nothing, as_text, r.type_ {
    True, _, _ -> Ok(None)
    False, Some(Ok(text)), request_row.Contact ->
      case plain(text) {
        "" -> Ok(None)
        reply -> Ok(Some(reply))
      }
    False, _, _ ->
      Error(http.error_message(
        400,
        "CONTACT_RESPONSE_INVALID",
        "A reply must be text, and only a contact can carry one.",
      ))
  }
}

type Responder {
  Responder(kind: party.Party, id: String, name: String)
}

type AnswerRefusal {
  AlreadyResponded
}

/// `POST /player/requests/:id/respond`: an adult answers their own.
pub fn player_respond(
  ctx: Ctx,
  req: Request,
  p: access.PlayerAccess,
  id: id.RequestId,
) -> Response {
  use <- access.guardian_managed_only(p)
  let me = p.player
  case store.read(ctx.store, requests.by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(r)) if r.player_id == me.row.id && r.routed_to == party.Player ->
      respond(
        ctx,
        req,
        r,
        me,
        Responder(party.Player, id.player_to_string(me.row.id), me.row.name),
      )
    Ok(_) -> http.error(404, "REQUEST_NOT_FOUND")
  }
}

/// `POST /guardian/requests/:id/respond`: a child's requests are the guardian's to answer.
pub fn guardian_respond(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.RequestId,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use r <- result.try(requests.by_id(read, id))
      case r {
        Some(r) if r.routed_to == party.Guardian ->
          case list.contains(g.child_ids, r.player_id) {
            True ->
              players.by_id(read, r.player_id)
              |> result.map(option.map(_, fn(p) { #(r, p) }))
            False -> Ok(None)
          }
        _ -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(Some(#(r, p))) ->
      respond(
        ctx,
        req,
        r,
        p,
        Responder(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
      )
    Ok(None) -> http.error(404, "REQUEST_NOT_FOUND")
  }
}

/// One answer to a pending request. A block placed after the request arrived still lets it be declined, never
/// accepted. The answer, its ledger row, the thread and the notices are one unit.
///
/// Not ported yet: answering a trial request (its slot, the trial and the Room's gate), the Contact a Room
/// links to a request (and its budget of 30 answers an hour), and the live `requests` event.
fn respond(
  ctx: Ctx,
  req: Request,
  r: requests.Request,
  player: players.Player,
  by: Responder,
) -> Response {
  use <- bool.lazy_guard(r.status != request_row.Pending, fn() {
    http.error(409, "ALREADY_RESPONDED")
  })
  use body <- http.body(req, answer_shape(), [])
  case contact_reply(r, body.message) {
    Error(refused) -> refused
    Ok(reply) -> {
      use <- moderate_reply(ctx, r, reply)
      case store.read(ctx.store, audit.is_blocked(_, r.player_id, r.org_id)) {
        Error(failure) -> http.internal(failure)
        Ok(True) if body.accept ->
          http.error_message(
            403,
            "BLOCKED",
            "You have blocked this organisation. Lift the block before accepting.",
          )
        Ok(_) ->
          case r.type_ {
            request_row.Trial ->
              http.error_message(
                501,
                "NOT_PORTED",
                "Trial requests are not supported by this server yet.",
              )
            request_row.Contact -> answer(ctx, r, player, by, body.accept)
          }
      }
    }
  }
}

fn moderate_reply(
  ctx: Ctx,
  r: requests.Request,
  reply: Option(String),
  next: fn() -> Response,
) -> Response {
  case reply {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind: "contact_reply",
          player_id: None,
          org_id: None,
          user_id: None,
          channel_id: None,
          request_id: Some(r.id),
        ),
        next,
      )
  }
}

fn answer(
  ctx: Ctx,
  r: requests.Request,
  player: players.Player,
  by: Responder,
  accept: Bool,
) -> Response {
  let now = clock.now_ms()
  let by_guardian = by.kind == party.Guardian
  let who = case by_guardian {
    True -> "The guardian of " <> player.row.name
    False -> player.row.name
  }
  let kind = request_row.type_to_string(r.type_)
  let answered =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      // Answered meanwhile: the first answer stands.
      use current <- result.try(requests.by_id(read, r.id))
      use <- bool.lazy_guard(
        option.map(current, fn(c) { c.status }) != Some(request_row.Pending),
        fn() { store.refuse(AlreadyResponded) },
      )
      use _ <- result.try(requests.record_response(
        tx,
        id.request_to_string(r.id),
        accept,
        by.kind,
        now,
      ))
      let notice = fn(to, id, type_, text, ref_id) {
        notifications.notify(
          tx,
          to:,
          id:,
          type_:,
          text:,
          ref_id: Some(ref_id),
          at: now,
        )
      }
      let ledger_type = case accept, by_guardian {
        True, False -> ledger_row.ContactAccepted
        True, True -> ledger_row.ContactAcceptedByGuardian
        False, False -> ledger_row.ContactDeclined
        False, True -> ledger_row.ContactDeclinedByGuardian
      }
      let outcome = case accept {
        True -> "accepted"
        False -> "declined"
      }
      // The club's notice points at the thread when one opens, else at the request.
      use org_ref <- result.try(case accept {
        True -> {
          use thread <- result.try(channels.open(tx, r, now))
          use _ <- result.map(requests.attach_channel(tx, r.id, thread.id))
          id.channel_to_string(thread.id)
        }
        False -> Ok(id.request_to_string(r.id))
      })
      use _ <- result.try(ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_type,
          player_id: Some(player.row.id),
          org_id: Some(r.org_id),
          org_name: Some(r.org_name),
          user_id: Some(r.user_id),
          actor_name: r.scout_name,
        ),
        now,
      ))
      use _ <- result.try(notice(
        audience.OrgUser,
        id.org_user_to_string(r.user_id),
        outcome,
        case accept {
          True -> who <> " accepted your " <> kind <> " request — thread open."
          False -> who <> " declined your " <> kind <> " request."
        },
        org_ref,
      ))
      // The child hears the outcome as a request outcome, the category the club's own rows use.
      use _ <- result.try(case by_guardian {
        True ->
          notice(
            audience.Player,
            id.player_to_string(player.row.id),
            "guardian_decision",
            "Your parent/guardian "
              <> outcome
              <> " the "
              <> kind
              <> " with "
              <> r.org_name
              <> ".",
            id.request_to_string(r.id),
          )
        False -> Ok(Nil)
      })
      use after <- result.map(requests.by_id(read, r.id))
      let assert Some(after) = after as "the answered request reads back"
      after
    })
  case answered {
    Ok(after) -> http.json(200, requests.recipient_view(after))
    Error(store.Refused(AlreadyResponded)) ->
      http.error(409, "ALREADY_RESPONDED")
    Error(failure) -> http.internal(failure)
  }
}
