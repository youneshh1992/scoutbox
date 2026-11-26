//// A club's direct request to a player, its Discovery Ledger and funnel, and the guardian's Inbox
//// (domains/recruitment/requests.mjs, ledger.mjs, inbox.mjs).
////
//// There is no direct message channel: a club files a request and contact unlocks on acceptance. A minor's
//// request goes to the guardian, never the child.

import gleam/bool
import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
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
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store
import scoutbox/platform/temporal
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/contacts
import scoutbox/recruitment/requests
import scoutbox/recruitment/signing_writer
import scoutbox/recruitment/trial_routes
import scoutbox/recruitment/trial_rules
import scoutbox/recruitment/trials
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/reputation_seed as seed_row
import scoutbox/rows/trials as trial_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import wisp.{type Request, type Response}

const message_max = 2000

pub type Direct {
  Direct(
    type_: request_row.Type,
    message: Option(String),
    proposed_date: Option(Dynamic),
    alt_slots: Option(Dynamic),
    venue: Option(Dynamic),
    notes: Option(Dynamic),
  )
}

/// One shape per type (schemas.mjs `oneShapeOf`): a contact carries a message only; a trial its logistics too,
/// judged by the one Trial validator.
pub fn direct_shape() -> input.Shape(Direct) {
  use type_ <- input.field(
    "type",
    input.required(input.one_of(request_row.type_pairs)),
  )
  use message <- input.field("message", input.nullish(input.text(message_max)))
  case type_ {
    request_row.Trial -> {
      use proposed_date <- input.field(
        "proposedDate",
        input.optional(input.anything()),
      )
      use alt_slots <- input.field("altSlots", input.optional(input.anything()))
      use venue <- input.field("venue", input.optional(input.anything()))
      use notes <- input.field("notes", input.optional(input.anything()))
      input.done(Direct(
        type_:,
        message:,
        proposed_date:,
        alt_slots:,
        venue:,
        notes:,
      ))
    }
    request_row.Contact -> {
      input.done(Direct(
        type_:,
        message:,
        proposed_date: None,
        alt_slots: None,
        venue: None,
        notes: None,
      ))
    }
  }
}

/// `POST /org/players/:id/request`.
///
/// A trial request is refused while the club has a trial awaiting its mandatory report.
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
      use body <- http.body(req, direct_shape(), [
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
        request_row.Trial -> direct_trial(ctx, req, a, p, message, body, now)
        request_row.Contact -> contact(ctx, req, a, p, message, now)
      }
    }
  }
}

type Refusal {
  Pending(request_id: id.RequestId)
}

fn direct_trial(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  p: players.Player,
  message: String,
  body: Direct,
  now: Int,
) -> Response {
  // An unfiled report for a trial blocks new trial requests. A tombstoned trial can never be reported, so it does
  // not block.
  case
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT id FROM trials WHERE org_id = ? AND status = 'awaiting_report' AND subject_removed_at IS NULL ORDER BY rowid",
        [id.org_sql(a.org.id)],
        decode.at([0], decode.string),
      )
    })
  {
    Error(e) -> http.internal(e)
    Ok([_, ..] as outstanding) ->
      http.json(
        409,
        json.object([
          #("error", json.string("REPORTS_OUTSTANDING")),
          #(
            "message",
            json.string(
              "You have "
              <> int.to_string(list.length(outstanding))
              <> " trial(s) awaiting a mandatory performance report. File them before requesting new trials.",
            ),
          ),
          #("trialIds", json.array(outstanding, json.string)),
        ]),
      )
    Ok([]) ->
      case
        trial_rules.validate_details(
          body.proposed_date,
          body.alt_slots,
          body.venue,
          body.notes,
        )
      {
        Error(fields) -> http.json(400, json.object(fields))
        Ok(details) -> {
          let notes_checked = fn(next) {
            case details.notes {
              "" -> next()
              n ->
                moderate.or_refuse(
                  ctx,
                  n,
                  audit.Context(
                    kind: "trial_notes",
                    player_id: None,
                    org_id: Some(a.org.id),
                    user_id: None,
                    channel_id: None,
                    request_id: None,
                  ),
                  next,
                )
            }
          }
          use <- notes_checked
          case
            !http.rerun(req)
            && limits.limited(
              ctx.limits,
              limits.TrialInvite,
              id.org_to_string(a.org.id),
              clock.now_ms(),
            )
          {
            True ->
              http.json(
                429,
                json.object(
                  list.map(limits.limited_body(limits.TrialInvite), fn(x) {
                    #(x.0, json.string(x.1))
                  }),
                ),
              )
            False -> file_direct_trial(ctx, a, p, message, details, now)
          }
        }
      }
  }
}

fn file_direct_trial(
  ctx: Ctx,
  a: OrgAccess,
  p: players.Player,
  message: String,
  details: trial_rules.Details,
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
      use pending <- result.try(requests.pending_between(
        read,
        a.org.id,
        p.row.id,
        request_row.Trial,
      ))
      use <- refuse_when(pending, fn(r: requests.Request) { Pending(r.id) })
      use certified <- result.try(orgs.safeguarding_certified(read, a.org))
      use r <- result.try(requests.create_direct_trial(
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
          subject: None,
          contact_id: None,
        ),
        option.map(details.proposed_date, temporal.day_text),
        list.map(details.alt_days, temporal.day_text),
        details.venue,
        details.notes,
      ))
      use _ <- result.map(trial_routes.request_notices(tx, a, p, r, minor, now))
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
              "A trial request to this player is already awaiting an answer.",
            ),
          ),
          #("requestId", id.request_json(request_id)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// A club's own contact request, or a Room contact's send: the request row, its ledger entry and the notices to the
/// recipient (requests.mjs `issueRecruitmentRequest`). A minor's goes to `new.guardian_id`.
pub fn issue_contact(
  tx: store.Tx,
  p: players.Player,
  new: requests.NewContact,
) -> Result(requests.Request, store.Fail(e)) {
  use r <- result.try(requests.create_contact(tx, new))
  let minor = new.guardian_id != None
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      event: ledger.Plain(case minor {
        True -> ledger_row.ContactRequestToGuardian
        False -> ledger_row.ContactRequest
      }),
      player_id: Some(p.row.id),
      org_id: Some(new.org_id),
      org_name: Some(new.org_name),
      user_id: Some(new.user_id),
      actor_name: Some(new.scout_name),
    ),
    new.at,
  ))
  let notice = fn(kind, to, text) {
    notifications.notify(
      tx,
      to: kind,
      id: to,
      type_: "request",
      text:,
      ref_id: Some(id.request_to_string(r.id)),
      at: new.at,
    )
  }
  use _ <- result.map(case new.guardian_id {
    Some(g) -> {
      use _ <- result.try(notice(
        audience.Guardian,
        id.guardian_to_string(g),
        new.org_name
          <> " has requested to discuss a conversation for "
          <> p.row.name
          <> ".",
      ))
      notice(
        audience.Player,
        id.player_to_string(p.row.id),
        new.org_name <> " contacted your parent/guardian about a conversation.",
      )
    }
    None ->
      notice(
        audience.Player,
        id.player_to_string(p.row.id),
        new.org_name <> " sent you a contact request.",
      )
  })
  r
}

fn pending_refusal(request_id: id.RequestId) -> Response {
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
}

fn contact(
  ctx: Ctx,
  req: Request,
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
  // A pending request is refused before the budget is charged; the unit checks again.
  case
    store.read(ctx.store, requests.pending_between(
      _,
      a.org.id,
      p.row.id,
      request_row.Contact,
    ))
  {
    Error(failure) -> http.internal(failure)
    Ok(Some(r)) -> pending_refusal(r.id)
    Ok(None) ->
      case
        !http.rerun(req)
        && limits.limited(
          ctx.limits,
          limits.ContactSend,
          id.org_to_string(a.org.id),
          clock.now_ms(),
        )
      {
        True ->
          http.json(
            429,
            json.object(
              list.map(limits.limited_body(limits.ContactSend), fn(x) {
                #(x.0, json.string(x.1))
              }),
            ),
          )
        False -> file_contact(ctx, a, p, message, guardian_id, now)
      }
  }
}

fn file_contact(
  ctx: Ctx,
  a: OrgAccess,
  p: players.Player,
  message: String,
  guardian_id: Option(id.GuardianId),
  now: Int,
) -> Response {
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
      issue_contact(
        tx,
        p,
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
          subject: None,
          contact_id: None,
        ),
      )
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
    Error(store.Refused(Pending(request_id))) -> pending_refusal(request_id)
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
/// `GET /org/recruitment-counts`: the home dashboard's recruitment figures.
pub fn recruitment_counts(ctx: Ctx, a: OrgAccess) -> Response {
  let id = a.org.id
  let found =
    store.read(ctx.store, fn(read) {
      use pending <- result.try(requests.count_for_org(
        read,
        id,
        Some(request_row.Pending),
      ))
      use awaiting <- result.try(trials.count_for_org(
        read,
        id,
        Some(trial_row.AwaitingReport),
      ))
      use all <- result.map(trials.count_for_org(read, id, None))
      json.object([
        #("requestsPending", json.int(pending)),
        #("trialsAwaitingReport", json.int(awaiting)),
        #("trials", json.int(all)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

type Reputation {
  Reputation(
    scout_name: Option(String),
    org_name: Option(String),
    views: Int,
    contacts: Int,
    trials: Int,
    signings: Int,
  )
}

/// `GET /org/reputation`: the seeded track records beside live rows from the whole ledger. A live row is keyed as
/// TypeScript keys it, by the two names joined as text, so a missing name reads `null`; every type opens a row and
/// five of them count.
pub fn reputation(ctx: Ctx) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use seeded <- result.try(store.query(
        read,
        "SELECT " <> seed_row.columns <> " FROM reputation_seed ORDER BY rowid",
        [],
        seed_row.decoder(),
      ))
      use groups <- result.map(ledger.counts_by_actor(read))
      #(seeded, live_reputation(groups))
    })
  case found {
    Ok(#(seeded, live)) ->
      http.json(
        200,
        json.object([
          #(
            "seeded",
            json.array(seeded, fn(s: seed_row.Row) {
              json.object([
                #("scoutName", json.string(s.scout_name)),
                #("orgName", json.string(s.org_name)),
                #("discoveries", json.int(s.discoveries)),
                #("successRatePct", json.int(s.success_rate_pct)),
                #("avgResaleMultiple", json_text.number(s.avg_resale_multiple)),
                #("seeded", json.bool(True)),
              ])
            }),
          ),
          #(
            "live",
            json.array(live, fn(r: Reputation) {
              json.object([
                #("scoutName", json.nullable(r.scout_name, json.string)),
                #("orgName", json.nullable(r.org_name, json.string)),
                #("views", json.int(r.views)),
                #("contacts", json.int(r.contacts)),
                #("trials", json.int(r.trials)),
                #("signings", json.int(r.signings)),
                #("seeded", json.bool(False)),
              ])
            }),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

fn live_reputation(
  groups: List(#(Option(String), Option(String), String, Int)),
) -> List(Reputation) {
  let name = option.unwrap(_, "null")
  let #(order, rows) =
    list.fold(groups, #([], dict.new()), fn(acc, g) {
      let #(order, rows) = acc
      let #(actor, org, type_, n) = g
      let key = name(actor) <> "|" <> name(org)
      let #(order, current) = case dict.get(rows, key) {
        Ok(r) -> #(order, r)
        Error(Nil) -> #([key, ..order], Reputation(actor, org, 0, 0, 0, 0))
      }
      let next = case type_ {
        "view" -> Reputation(..current, views: current.views + n)
        "contact_request" ->
          Reputation(..current, contacts: current.contacts + n)
        "trial_request" | "trial_report" ->
          Reputation(..current, trials: current.trials + n)
        "signing" -> Reputation(..current, signings: current.signings + n)
        _ -> current
      }
      #(order, dict.insert(rows, key, next))
    })
  order
  |> list.reverse
  |> list.filter_map(dict.get(rows, _))
}

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
      use booked <- result.try(trials.count_for_org(read, id, None))
      use reported <- result.try(trials.count_for_org(
        read,
        id,
        Some(trial_row.Reported),
      ))
      use signed <- result.try(signing_writer.count_for_org(read, id))
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
            stage("trials", "Trials booked", booked),
            stage("reports", "Reports filed", reported),
            stage("signings", "Signings", signed),
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

/// `GET /org/requests`: the club's request records, newest first, by cursor.
pub fn org_page(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.lenient(req, [IntKind])
  case
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(requests.page_for_org(
        read,
        a.org.id,
        page,
      ))
      use with <- result.map(requests.with_slots(read, items))
      #(with, next)
    })
  {
    Ok(#(items, next)) ->
      pages.respond(items, next, fn(p) { requests.record_json(p.0, p.1) })
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /guardian/inbox`: the requests about the children, routed to the guardian, newest first.
pub fn guardian_inbox(ctx: Ctx, req: Request, g: Guardian) -> Response {
  use page <- pages.lenient(req, [IntKind])
  case
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(requests.page_for_guardian_of(
        read,
        g.child_ids,
        page,
      ))
      use with <- result.map(requests.with_slots(read, items))
      #(with, next)
    })
  {
    Ok(#(items, next)) ->
      pages.respond(items, next, fn(p) {
        requests.recipient_view_with(p.0, p.1)
      })
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/inbox`: newest first. A child's inbox never carries a message or a contact channel, only what
/// the guardian decided.
pub fn player_inbox(
  ctx: Ctx,
  req: Request,
  p: access.PlayerAccess,
) -> Response {
  use page <- pages.lenient(req, [IntKind])
  case
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(requests.page_for_player(
        read,
        p.player.row.id,
        page,
      ))
      use with <- result.map(requests.with_slots(read, items))
      #(with, next)
    })
  {
    Ok(#(items, next)) ->
      case p.minor {
        False ->
          pages.respond(items, next, fn(x) {
            requests.recipient_view_with(x.0, x.1)
          })
        True ->
          pages.respond(items, next, fn(x) {
            let r = x.0
            json.object([
              #("id", id.request_json(r.id)),
              #("type", request_row.type_to_json(r.type_)),
              #("orgName", json.string(r.org_name)),
              #("orgVerified", json.bool(r.org_verified)),
              #("status", request_row.status_to_json(r.status)),
              #("guardianManaged", json.bool(True)),
              #("note", json.string(child_inbox_note(r))),
            ])
          })
      }
    Error(failure) -> http.internal(failure)
  }
}

fn child_inbox_note(r: requests.Request) -> String {
  let kind = request_row.type_to_string(r.type_)
  case r.status {
    request_row.Pending ->
      r.org_name
      <> " contacted your parent/guardian about a "
      <> case r.type_ {
        request_row.Trial -> "trial"
        request_row.Contact -> "conversation"
      }
      <> ". They will decide together with you."
    request_row.Accepted ->
      "Your parent/guardian accepted the "
      <> kind
      <> " with "
      <> r.org_name
      <> "."
    _ ->
      "Your parent/guardian declined the "
      <> kind
      <> " with "
      <> r.org_name
      <> "."
  }
}

// ------------------------------------------------------------------------------------------------- answering

type Answer {
  Answer(accept: Bool, chosen_slot: Option(Dynamic), message: Option(Dynamic))
}

/// `accept` is true or false, never "false" read as truthy. The slot and the reply keep their own rules.
fn answer_shape() -> input.Shape(Answer) {
  use accept <- input.field("accept", input.required(input.boolean()))
  use chosen_slot <- input.field("chosenSlot", input.optional(input.anything()))
  use message <- input.field("message", input.optional(input.anything()))
  input.done(Answer(accept:, chosen_slot:, message:))
}

/// The optional short reply a contact may carry: `Ok(None)` for no reply, or the 400 that refuses it.
fn contact_reply(
  r: requests.Request,
  raw: Option(Dynamic),
) -> Result(Option(String), Response) {
  contact_rules.validate_reply(raw, r.type_ == request_row.Contact)
  |> result.map_error(fn(e) { http.error_message(400, e.error, e.message) })
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
/// A trial invitation's chosen slot is checked before the answer is recorded, so a refused slot leaves it
/// pending, and a case-tied invitation re-derives its recipient now (`trial_routes.accept_gate`).
///
/// An answer to a request a Room's Contact sent spends the responder's `contact_response` budget, after the
/// block check, as the TypeScript server orders them.
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
        Ok(_) -> {
          use <- contact_budget(ctx, r, by)
          case r.type_, body.accept {
            request_row.Trial, True ->
              case
                trial_rules.choose_slot(
                  r.trial_proposed_date,
                  requests.alt_days(r),
                  body.chosen_slot,
                )
              {
                Error(offered) ->
                  http.json(
                    400,
                    json.object([
                      #("ok", json.bool(False)),
                      #("error", json.string("TRIAL_SLOT_INVALID")),
                      #(
                        "message",
                        json.string("Pick one of the dates the club offered."),
                      ),
                      #("offered", json.array(offered, json.string)),
                    ]),
                  )
                Ok(date) -> {
                  let gate = case r.case_id {
                    Some(_) -> trial_routes.accept_gate(ctx, r, by.kind, by.id)
                    None -> Ok(Nil)
                  }
                  case gate {
                    Error(refused) -> refused
                    Ok(Nil) -> answer(ctx, r, player, by, True, date, reply)
                  }
                }
              }
            _, _ -> answer(ctx, r, player, by, body.accept, None, reply)
          }
        }
      }
    }
  }
}

fn contact_budget(
  ctx: Ctx,
  r: requests.Request,
  by: Responder,
  next: fn() -> Response,
) -> Response {
  let owner = party.to_string(by.kind) <> ":" <> by.id
  case
    r.contact_id != None
    && limits.limited(ctx.limits, limits.ContactResponse, owner, clock.now_ms())
  {
    True -> http.json(429, limits.limited_json(limits.ContactResponse))
    False -> next()
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
  trial_date: Option(String),
  reply: Option(String),
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
      live_pings.catalogue(
        tx,
        live_event.Requests(id.player_to_string(player.row.id)),
      )
      use _ <- result.try(requests.record_response(
        tx,
        r.id,
        accept,
        by.kind,
        now,
      ))
      use _ <- result.try(contacts.on_request_responded(
        tx,
        r.id,
        r.contact_id,
        r.user_id,
        accept,
        reply,
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
      let ledger_type = case r.type_, accept, by_guardian {
        request_row.Contact, True, False -> ledger_row.ContactAccepted
        request_row.Contact, True, True -> ledger_row.ContactAcceptedByGuardian
        request_row.Contact, False, False -> ledger_row.ContactDeclined
        request_row.Contact, False, True -> ledger_row.ContactDeclinedByGuardian
        request_row.Trial, True, False -> ledger_row.TrialAccepted
        request_row.Trial, True, True -> ledger_row.TrialAcceptedByGuardian
        request_row.Trial, False, False -> ledger_row.TrialDeclined
        request_row.Trial, False, True -> ledger_row.TrialDeclinedByGuardian
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
          event: ledger.Plain(ledger_type),
          player_id: Some(player.row.id),
          org_id: Some(r.org_id),
          org_name: Some(r.org_name),
          user_id: Some(r.user_id),
          actor_name: r.scout_name,
        ),
        now,
      ))
      // A trial invitation's answer is the trial's birth, or its decline, in the same unit.
      let who_answered =
        trial_routes.Answerer(kind: by.kind, id: by.id, name: by.name)
      use _ <- result.try(case r.type_, accept {
        request_row.Trial, True -> {
          use answered <- result.try(requests.by_id(read, r.id))
          let assert Some(answered) = answered
            as "the answered request reads back"
          use t <- result.try(trial_routes.accepted(
            tx,
            answered,
            player,
            trial_date,
            who_answered,
            now,
          ))
          trial_routes.on_accepted(tx, answered, t, who_answered, now)
        }
        request_row.Trial, False ->
          trial_routes.on_declined(tx, r, who_answered, now)
        request_row.Contact, _ -> Ok(Nil)
      })
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
      use after <- result.try(requests.by_id(read, r.id))
      let assert Some(after) = after as "the answered request reads back"
      use slots <- result.map(case after.type_ {
        request_row.Trial -> requests.slots_of(read, after.id)
        request_row.Contact -> Ok([])
      })
      #(after, slots)
    })
  case answered {
    Ok(#(after, slots)) ->
      http.json(200, requests.recipient_view_with(after, slots))
    Error(store.Refused(AlreadyResponded)) ->
      http.error(409, "ALREADY_RESPONDED")
    Error(failure) -> http.internal(failure)
  }
}
