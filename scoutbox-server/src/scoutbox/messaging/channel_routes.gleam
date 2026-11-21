//// The message threads' routes (domains/messaging/channels.mjs): the club's inbox and its figures, the adult
//// player's and the guardian's threads, sending, read receipts and typing, and the admin's thread audit.
////
//// Standing is rechecked on every use: a block, a suspension, or the player leaving the club's platform closes
//// the thread; the history stays for audit. Every message is moderated and logged.
////
//// A send and a read receipt publish the live `messages` event once they commit; a typing ping publishes `typing`
//// at once, since it records nothing.
////

import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/messaging/channels.{
  type Attachment, type Sender, type Side, type Thread, Clip, CounterpartySide,
  ForAdmin, ForCounterparty, ForOrg, OrgSide, Sender, TrialReport,
}
import scoutbox/messaging/live_routes
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_event.{CounterpartyTyping, OrgTyping}
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/store.{type Read}
import scoutbox/recruitment/requests
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/trial_reports as report_row
import scoutbox/rules/visibility.{type Access}
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/party
import wisp.{type Request, type Response}

type Closed {
  Closed(code: String, message: String)
}

fn closed_response(c: Closed) -> Response {
  http.error_message(403, c.code, c.message)
}

fn not_found() -> Response {
  http.error(404, "CHANNEL_NOT_FOUND")
}

/// Why the thread is closed to the organisation, given what the visibility rule and the blocks say of its player.
fn closed_for_org(found: Option(#(players.Player, Access))) -> Option(Closed) {
  case found {
    None ->
      Some(Closed("CHANNEL_CLOSED", "This player account no longer exists."))
    Some(#(_, access)) if access.blocked ->
      Some(Closed(
        "BLOCKED",
        "This player (or their guardian) has blocked your organisation.",
      ))
    Some(#(_, access)) if !access.visible ->
      Some(Closed(
        "CHANNEL_CLOSED",
        "This player is no longer available to your organisation — the thread is closed (history retained for audit).",
      ))
    Some(_) -> None
  }
}

fn org_standing(
  read: Read,
  t: Thread,
  org: Org,
  now: Int,
) -> Result(Option(Closed), store.Fail(e)) {
  players.for_org(read, t.row.player_id, org, now)
  |> result.map(closed_for_org)
}

fn counterparty_standing(
  read: Read,
  t: Thread,
  player_id: id.PlayerId,
) -> Result(Option(Closed), store.Fail(e)) {
  use org <- result.try(orgs.by_id(read, t.row.org_id))
  case org {
    None ->
      Ok(Some(Closed("CHANNEL_CLOSED", "This organisation no longer exists.")))
    Some(org) if org.suspended ->
      Ok(
        Some(Closed(
          "ORG_SUSPENDED",
          "This organisation is suspended pending a safety review — the thread is paused.",
        )),
      )
    Some(org) -> {
      use blocked <- result.map(audit.is_blocked(read, player_id, org.id))
      case blocked {
        True ->
          Some(Closed(
            "BLOCKED",
            "You have blocked this organisation. Lift the block to continue the conversation.",
          ))
        False -> None
      }
    }
  }
}

/// The thread, if `owns` says this reader may use it.
fn find_thread(
  ctx: Ctx,
  id: id.ChannelId,
  owns: fn(Thread) -> Bool,
  next: fn(Thread) -> Response,
) -> Response {
  case store.read(ctx.store, channels.by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(t)) ->
      case owns(t) {
        True -> next(t)
        False -> not_found()
      }
    Ok(None) -> not_found()
  }
}

fn org_thread(
  ctx: Ctx,
  a: OrgAccess,
  id: id.ChannelId,
  next: fn(Thread) -> Response,
) {
  find_thread(ctx, id, fn(t) { t.row.org_id == a.org.id }, next)
}

fn player_thread(
  ctx: Ctx,
  p: PlayerAccess,
  id: id.ChannelId,
  next: fn(Thread) -> Response,
) {
  find_thread(
    ctx,
    id,
    fn(t) {
      t.row.player_id == p.player.row.id && t.row.counterparty == party.Player
    },
    next,
  )
}

fn guardian_thread(
  ctx: Ctx,
  g: Guardian,
  id: id.ChannelId,
  next: fn(Thread) -> Response,
) {
  find_thread(ctx, id, fn(t) { t.row.guardian_id == Some(g.row.id) }, next)
}

// ------------------------------------------------------------------------------------------------- sending

type MessageBody {
  MessageBody(
    text: Option(String),
    client_msg_id: Option(String),
    attach_media_id: Option(String),
    attach_trial_report_id: Option(String),
  )
}

fn message_shape() -> input.Shape(MessageBody) {
  use text <- input.field("text", input.nullish(input.text(channels.text_max)))
  use client_msg_id <- input.field(
    "clientMsgId",
    input.nullish(input.text(channels.client_msg_id_max)),
  )
  use attach_media_id <- input.field(
    "attachMediaId",
    input.nullish(input.text(channels.id_max)),
  )
  use attach_trial_report_id <- input.field(
    "attachTrialReportId",
    input.nullish(input.text(channels.id_max)),
  )
  input.done(MessageBody(
    text:,
    client_msg_id:,
    attach_media_id:,
    attach_trial_report_id:,
  ))
}

/// Empty text is no attachment, as the TypeScript server reads a falsy id.
fn named(id: Option(String)) -> Option(String) {
  case id {
    Some("") -> None
    other -> other
  }
}

type Attach {
  NoAttachment
  With(Attachment)
  AttachmentMissing(code: String)
}

fn attachment(
  read: Read,
  t: Thread,
  body: MessageBody,
  by_staff: Bool,
) -> Result(Attach, store.Fail(e)) {
  case named(body.attach_media_id), named(body.attach_trial_report_id) {
    None, None -> Ok(NoAttachment)
    Some(media_id), _ -> {
      // From the request body.
      let media_id = id.media(media_id)
      use player <- result.map(players.by_id(read, t.row.player_id))
      let clip =
        option.to_result(player, Nil)
        |> result.try(fn(p) {
          list.find(p.media, fn(m) { m.clip.id == media_id })
        })
      case clip {
        Ok(m) ->
          With(Clip(
            media_id: m.clip.id,
            title: Some(m.clip.title),
            url: m.clip.url,
            verified: option.is_some(m.clip.verified_clip_attendance_id),
          ))
        Error(Nil) -> AttachmentMissing("MEDIA_NOT_FOUND")
      }
    }
    None, Some(report_id) -> {
      // From the request body.
      let report_id = id.trial_report(report_id)
      // The club may attach only its own reports; the player or guardian any of the player's.
      let staff = case by_staff {
        True -> Some(t.row.org_id)
        False -> None
      }
      use player <- result.map(players.by_id(read, t.row.player_id))
      let report =
        option.to_result(player, Nil)
        |> result.try(fn(p) {
          list.find(p.trial_reports, fn(r) {
            r.id == report_id && { staff == None || staff == Some(r.org_id) }
          })
        })
      case report {
        Ok(r) -> With(TrialReport(r.id, r.org_name, report_summary(r)))
        Error(Nil) -> AttachmentMissing("TRIAL_REPORT_NOT_FOUND")
      }
    }
  }
}

/// channels.mjs's one-line summary, each figure printed as JavaScript prints a number.
fn report_summary(r: report_row.Row) -> String {
  "accel "
  <> number_text(r.acceleration)
  <> "/10 · "
  <> number_text(r.sprint_speed_kmh)
  <> " km/h · "
  <> number_text(r.distance_km)
  <> " km · pass "
  <> number_text(r.pass_completion_pct)
  <> "% · duels "
  <> number_text(r.duel_success_pct)
  <> "% · coach "
  <> number_text(r.coach_rating)
  <> "/10"
}

fn number_text(f: Float) -> String {
  case float.floor(f) == f {
    True -> int.to_string(float.truncate(f))
    False -> float.to_string(f)
  }
}

fn send(
  ctx: Ctx,
  req: Request,
  t: Thread,
  standing: fn(Read) -> Result(Option(Closed), store.Fail(Nil)),
  kind: String,
  sender: Sender,
) -> Response {
  case store.read(ctx.store, standing) {
    Error(failure) -> http.internal(failure)
    Ok(Some(closed)) -> closed_response(closed)
    Ok(None) -> {
      use body <- http.body(req, message_shape(), [])
      case input.filled(body.text) {
        None -> http.required("TEXT_REQUIRED", "text")
        Some(text) -> {
          use <- moderate.or_refuse(
            ctx,
            text,
            audit.Context(
              kind:,
              player_id: None,
              org_id: None,
              user_id: None,
              channel_id: Some(t.row.id),
              request_id: None,
            ),
          )
          case
            store.read(ctx.store, attachment(
              _,
              t,
              body,
              sender.kind == audience.OrgUser,
            ))
          {
            Error(failure) -> http.internal(failure)
            Ok(AttachmentMissing(code)) -> http.error(400, code)
            Ok(NoAttachment) -> post(ctx, t, sender, text, None, body)
            Ok(With(attached)) ->
              post(ctx, t, sender, text, Some(attached), body)
          }
        }
      }
    }
  }
}

fn post(
  ctx: Ctx,
  t: Thread,
  sender: Sender,
  text: String,
  attachment: Option(Attachment),
  body: MessageBody,
) -> Response {
  let c = t.row
  let client_msg_id = named(body.client_msg_id)
  let now = clock.now_ms()
  let posted =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      // A retried send with the same client id answers the message that already landed.
      use dup <- result.try(case client_msg_id {
        Some(cid) -> channels.by_client_msg_id(read, c.id, sender, cid)
        None -> Ok(None)
      })
      case dup {
        Some(m) -> Ok(m)
        None -> {
          use m <- result.try(channels.append(
            tx,
            c.id,
            sender,
            text,
            attachment,
            client_msg_id,
            now,
          ))
          let sender_name = option.unwrap(m.row.sender_name, "")
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              event: ledger.Plain(ledger_row.Message),
              player_id: Some(c.player_id),
              org_id: Some(c.org_id),
              org_name: Some(c.org_name),
              user_id: m.row.sender_user_id,
              actor_name: m.row.sender_name,
            ),
            now,
          ))
          let notice = fn(kind, id, text) {
            notifications.notify(
              tx,
              to: kind,
              id:,
              type_: "message",
              text:,
              ref_id: Some(id.channel_to_string(c.id)),
              at: now,
            )
          }
          use _ <- result.map(case sender.kind {
            audience.OrgUser -> {
              // The notice's audience id is polymorphic: its kind says whose it is.
              let recipient = case c.counterparty {
                party.Guardian -> #(
                  audience.Guardian,
                  option.map(c.guardian_id, id.guardian_to_string),
                )
                party.Player -> #(
                  audience.Player,
                  Some(id.player_to_string(c.player_id)),
                )
              }
              case recipient {
                #(kind, Some(recipient_id)) ->
                  notice(
                    kind,
                    recipient_id,
                    c.org_name
                      <> " ("
                      <> option.unwrap(c.scout_role, "null")
                      <> ") sent a message.",
                  )
                #(_, None) -> Ok(Nil)
              }
            }
            _ -> {
              // Every staff member who has written in the thread, and the one who sent the request.
              use writers <- result.try(channels.staff_senders(read, c.id))
              use request <- result.try(requests.by_id(read, c.request_id))
              let staff = case request {
                Some(r) ->
                  case list.contains(writers, r.user_id) {
                    True -> writers
                    False -> list.append(writers, [r.user_id])
                  }
                None -> writers
              }
              list.try_each(staff, fn(uid) {
                notice(
                  audience.OrgUser,
                  id.org_user_to_string(uid),
                  sender_name
                    <> " replied in the "
                    <> option.unwrap(c.player_name, "null")
                    <> " thread.",
                )
              })
            }
          })
          store.emit(tx, effect.Live(live_routes.messages(c.id)))
          m
        }
      }
    })
  case posted {
    Ok(m) -> http.json(201, channels.message_view(m))
    Error(failure) -> http.internal(failure)
  }
}

fn mark_read(ctx: Ctx, req: Request, t: Thread, side: Side) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  case
    store.unit(ctx.store, fn(tx) {
      store.emit(tx, effect.Live(live_routes.messages(t.row.id)))
      channels.mark_read(tx, t.row.id, side, now)
    })
  {
    Ok(#(org, counterparty)) ->
      http.json(
        200,
        json.object([#("readBy", channels.receipts_json(org, counterparty))]),
      )
    Error(failure) -> http.internal(failure)
  }
}

fn typing(
  ctx: Ctx,
  req: Request,
  channel_id: id.ChannelId,
  side: live_event.TypingSide,
) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  live_routes.publish(ctx.store, ctx.live, live_routes.typing(channel_id, side))
  http.json(200, json.object([#("ok", json.bool(True))]))
}

// ------------------------------------------------------------------------------------------------- club staff

type InboxQuery {
  InboxQuery(player_id: Option(String), query: paging.Query)
}

fn inbox_shape() -> input.Shape(InboxQuery) {
  use player_id <- input.field("playerId", input.optional(input.id()))
  use limit <- input.field("limit", input.optional(input.text(1000)))
  use cursor <- input.field("cursor", input.optional(input.text(100_000)))
  input.done(InboxQuery(player_id:, query: paging.Query(limit:, cursor:)))
}

/// `GET /org/channels`: most recently active first, each with whether it is closed to the club.
pub fn org_list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use q <- http.query(req, inbox_shape(), [])
  case paging.read(q.query, [IntKind, IntKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let now = clock.now_ms()
      let found =
        store.read(ctx.store, fn(read) {
          use #(items, next) <- result.try(channels.page_for_org(
            read,
            a.org.id,
            q.player_id,
            page,
          ))
          use seen <- result.map(players.for_org_many(
            read,
            list.map(items, fn(t) { t.row.player_id }) |> list.unique,
            a.org,
            now,
          ))
          let closed = fn(t: Thread) {
            list.find(seen, fn(s) { { s.0 }.row.id == t.row.player_id })
            |> option.from_result
            |> closed_for_org
            |> option.is_some
          }
          #(
            list.map(items, fn(t) {
              json.object(
                list.append(channels.view_fields(t, ForOrg), [
                  #("closed", json.bool(closed(t))),
                ]),
              )
            }),
            next,
          )
        })
      case found {
        Ok(#(items, next)) -> pages.respond(items, next, fn(j) { j })
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `GET /org/channels/counts`.
pub fn org_counts(ctx: Ctx, a: OrgAccess) -> Response {
  case store.read(ctx.store, channels.counts_for_org(_, a.org.id)) {
    Ok(#(threads, unread)) ->
      http.json(
        200,
        json.object([
          #("threads", json.int(threads)),
          #("unreadMessages", json.int(unread)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

pub fn org_send(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.ChannelId,
) -> Response {
  use t <- org_thread(ctx, a, id)
  let now = clock.now_ms()
  send(
    ctx,
    req,
    t,
    org_standing(_, t, a.org, now),
    "org_message",
    Sender(
      kind: audience.OrgUser,
      id: id.org_user_to_string(a.user.id),
      name: a.user.name
        <> " · "
        <> case a.user.role {
        "" -> "Scout"
        role -> role
      }
        <> " · "
        <> a.org.name,
    ),
  )
}

pub fn org_read(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.ChannelId,
) -> Response {
  use t <- org_thread(ctx, a, id)
  mark_read(ctx, req, t, OrgSide)
}

pub fn org_typing(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.ChannelId,
) -> Response {
  use t <- org_thread(ctx, a, id)
  case store.read(ctx.store, org_standing(_, t, a.org, clock.now_ms())) {
    Error(failure) -> http.internal(failure)
    Ok(Some(_)) -> http.error(403, "CHANNEL_CLOSED")
    Ok(None) -> typing(ctx, req, t.row.id, OrgTyping)
  }
}

// ------------------------------------------------------------------------------------------------- players

/// `GET /player/channels`: an adult's own threads, oldest first. A child's threads live with the guardian.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True -> http.json(200, json.preprocessed_array([]))
    False ->
      case store.read(ctx.store, channels.for_player(_, p.player.row.id)) {
        Ok(threads) ->
          http.json(200, json.array(threads, channels.view(_, ForCounterparty)))
        Error(failure) -> http.internal(failure)
      }
  }
}

pub fn player_send(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  id: id.ChannelId,
) -> Response {
  use <- access.guardian_managed_only(p)
  use t <- player_thread(ctx, p, id)
  let me = p.player.row
  send(
    ctx,
    req,
    t,
    counterparty_standing(_, t, me.id),
    "player_message",
    Sender(kind: audience.Player, id: id.player_to_string(me.id), name: me.name),
  )
}

pub fn player_read(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  id: id.ChannelId,
) -> Response {
  use <- access.guardian_managed_only(p)
  use t <- player_thread(ctx, p, id)
  mark_read(ctx, req, t, CounterpartySide)
}

pub fn player_typing(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  id: id.ChannelId,
) -> Response {
  use <- access.guardian_managed_only(p)
  use t <- player_thread(ctx, p, id)
  typing(ctx, req, t.row.id, CounterpartyTyping)
}

// ------------------------------------------------------------------------------------------------- guardians

/// `GET /guardian/channels`: oldest first.
pub fn guardian_list(ctx: Ctx, g: Guardian) -> Response {
  case store.read(ctx.store, channels.for_guardian(_, g.row.id)) {
    Ok(threads) ->
      http.json(200, json.array(threads, channels.view(_, ForCounterparty)))
    Error(failure) -> http.internal(failure)
  }
}

pub fn guardian_send(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.ChannelId,
) -> Response {
  use t <- guardian_thread(ctx, g, id)
  send(
    ctx,
    req,
    t,
    counterparty_standing(_, t, t.row.player_id),
    "guardian_message",
    Sender(
      kind: audience.Guardian,
      id: id.guardian_to_string(g.row.id),
      name: g.row.name,
    ),
  )
}

pub fn guardian_read(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.ChannelId,
) -> Response {
  use t <- guardian_thread(ctx, g, id)
  mark_read(ctx, req, t, CounterpartySide)
}

pub fn guardian_typing(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  id: id.ChannelId,
) -> Response {
  use t <- guardian_thread(ctx, g, id)
  typing(ctx, req, t.row.id, CounterpartyTyping)
}

// ------------------------------------------------------------------------------------------------- admin

/// `GET /admin/channels`: most recently active first, "all communications logged", made inspectable.
pub fn admin_list(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [IntKind, IntKind])
  case store.read(ctx.store, channels.page_all(_, page)) {
    Ok(#(items, next)) ->
      pages.respond(items, next, fn(t) {
        json.object(
          list.append(channels.view_fields(t, ForAdmin), [
            #("guardianId", json.nullable(t.row.guardian_id, id.guardian_json)),
          ]),
        )
      })
    Error(failure) -> http.internal(failure)
  }
}
