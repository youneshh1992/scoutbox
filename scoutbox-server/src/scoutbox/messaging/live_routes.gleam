//// The event stream's routes and who may see what on it (domains/platform/liveSync.mjs). The hub itself is
//// `platform/live`.
////
//// Authorisation is checked at delivery, from live records, in each stream's own process: a suspension or a
//// staff member's removal silences a stream that is already open.
////
//// Not ported yet: the catalogue pings (`players`, `orgs`, …) and every other event in the registry, and closing a
//// removed staff member's open streams (until then, their stream stays open but receives nothing).

import ewe
import gleam/erlang/process
import gleam/http/response
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/guardians
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/identity/sessions.{type Holder}
import scoutbox/identity/staff
import scoutbox/messaging/channels
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live.{
  type Frame, type Hub, type Route, Audience, Nobody, Thread,
}
import scoutbox/platform/live_event.{
  type Event, type TypingSide, Messages, Notify, Typing,
}
import scoutbox/platform/store.{type Fail, type Read, type Store}
import scoutbox/rows/id
import scoutbox/vocab/audience
import scoutbox/vocab/party
import wisp.{type Request, type Response}

/// The header a successful `GET /events` hands the adapter (`platform/wisp_ewe`) to open the stream with: the last
/// event id the client saw, then the session's sid. The adapter removes it, so it never reaches the client.
pub const stream_header = "x-scoutbox-live-stream"

const ping_ms = 25_000

/// Who a stream belongs to.
pub type Viewer {
  OrgViewer(org_id: id.OrgId, user_id: id.OrgUserId)
  PlayerViewer(player_id: id.PlayerId)
  GuardianViewer(guardian_id: id.GuardianId)
}

/// A session's stream identity. A suspended organisation has none; nor has a Trust & Safety reviewer.
fn viewer(read: Read, holder: Holder) -> Result(Option(Viewer), Fail(e)) {
  case holder {
    sessions.OrgStaff(org_id, user_id) ->
      orgs.by_id(read, org_id)
      |> result.map(fn(org) {
        case org {
          Some(org) if !org.suspended -> Some(OrgViewer(org.id, user_id))
          _ -> None
        }
      })
    sessions.Player(player_id) ->
      players.by_id(read, player_id)
      |> result.map(option.map(_, fn(p) { PlayerViewer(p.row.id) }))
    sessions.Guardian(guardian_id) ->
      guardians.by_id(read, guardian_id)
      |> result.map(option.map(_, fn(g) { GuardianViewer(g.row.id) }))
    sessions.Reviewer(_) -> Ok(None)
  }
}

// ------------------------------------------------------------------------------------------------- publishing

/// A thread changed: a message, or a read receipt.
pub fn messages(channel_id: id.ChannelId) -> Event {
  Messages(id.channel_to_string(channel_id))
}

pub fn typing(channel_id: id.ChannelId, side: TypingSide) -> Event {
  Typing(id.channel_to_string(channel_id), side)
}

/// A notice reached a feed. The audience id is polymorphic: its kind says whose it is.
pub fn notify(kind: audience.Audience, audience_id: String) -> Event {
  Notify(kind, audience_id)
}

/// Resolves who the event may reach, then publishes it. Called after COMMIT (`effect.Live`), or directly for an
/// event that records nothing (typing).
pub fn publish(store: Store, hub: Hub, event: Event) -> Nil {
  let at = clock.now_ms()
  let route =
    store.read(store, fn(read) { route(read, event) }) |> result.unwrap(Nobody)
  live.publish(hub, event, route, at)
}

fn route(read: Read, event: Event) -> Result(Route, Fail(e)) {
  case event {
    Messages(channel_id:) | Typing(channel_id:, ..) -> {
      use found <- result.map(channels.parties(read, id.channel(channel_id)))
      case found {
        Some(c) ->
          Thread(
            org_id: c.org_id,
            player_id: c.player_id,
            counterparty_is_player: c.counterparty == party.Player,
            guardian_id: c.guardian_id,
          )
        None -> Nobody
      }
    }
    Notify(audience_kind: audience.OrgUser, audience_id:) -> {
      use user <- result.map(staff.by_id(read, id.org_user(audience_id)))
      Audience(
        audience.OrgUser,
        audience_id,
        option.map(user, fn(u) { u.org_id }),
      )
    }
    Notify(audience_kind:, audience_id:) ->
      Ok(Audience(audience_kind, audience_id, None))
  }
}

/// Whether the stream's holder may see an event, as their records stand now.
fn may_receive(read: Read, viewer: Viewer, route: Route) -> Bool {
  case viewer, route {
    OrgViewer(org_id:, user_id:), Thread(org_id: to, ..)
    | OrgViewer(org_id:, user_id:),
      Audience(kind: audience.OrgUser, org_id: Some(to), ..)
    -> to == org_id && in_good_standing(read, org_id, user_id)
    PlayerViewer(player_id:), Thread(player_id: to, counterparty_is_player:, ..)
    -> to == player_id && counterparty_is_player
    PlayerViewer(player_id:), Audience(kind: audience.Player, id: to, ..) ->
      to == id.player_to_string(player_id)
    GuardianViewer(guardian_id:), Thread(guardian_id: Some(to), ..) ->
      to == guardian_id
    GuardianViewer(guardian_id:), Audience(kind: audience.Guardian, id: to, ..)
    -> to == id.guardian_to_string(guardian_id)
    _, _ -> False
  }
}

/// The organisation isn't suspended, and the staff member hasn't been removed.
fn in_good_standing(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Bool {
  let standing = {
    use org <- result.try(orgs.by_id(read, org_id))
    use user <- result.map(staff.by_id(read, user_id))
    case org, user {
      Some(org), Some(user) -> !org.suspended && user.removed_at == None
      _, _ -> False
    }
  }
  standing == Ok(True)
}

// ------------------------------------------------------------------------------------------------- routes

/// `POST /events/ticket`.
pub fn ticket(ctx: Ctx, req: Request) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use session <- result.try(case http.bearer(req) {
        Ok(token) ->
          sessions.by_token(read, token, now, ctx.config.session_ttl_ms)
        Error(Nil) -> Ok(None)
      })
      case session {
        Some(s) ->
          viewer(read, s.holder) |> result.map(option.map(_, fn(_) { s.sid }))
        None -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) ->
      http.error_message(
        401,
        "AUTH_REQUIRED",
        "Log in first — live sync is scoped to your account.",
      )
    Ok(Some(sid)) ->
      http.json(
        200,
        json.object([
          #("ticket", json.string(live.mint_ticket(ctx.live, sid, now))),
          #("expiresInMs", json.int(live.ticket_ttl_ms)),
        ]),
      )
  }
}

type Connect {
  Connect(ticket: Option(String), last_event_id: Option(Int))
}

fn connect_shape() -> input.Shape(Connect) {
  use ticket <- input.field("ticket", input.optional(input.text(128)))
  use last_event_id <- input.field(
    "lastEventId",
    input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
  )
  input.done(Connect(ticket:, last_event_id:))
}

/// `GET /events?ticket=…[&lastEventId=…]`. A browser's `Last-Event-ID` header wins over the query.
pub fn connect(ctx: Ctx, req: Request) -> Response {
  use q <- http.query(req, connect_shape(), [])
  let now = clock.now_ms()
  case live.redeem_ticket(ctx.live, option.unwrap(q.ticket, ""), now) {
    Error(Nil) ->
      http.error_message(
        401,
        "TICKET_INVALID",
        "Mint a fresh connect ticket (POST /events/ticket) and reconnect.",
      )
    Ok(sid) ->
      case
        store.read(ctx.store, fn(read) {
          stream_viewer(read, sid, now, ctx.config.session_ttl_ms)
        })
      {
        Error(failure) -> http.internal(failure)
        Ok(None) ->
          http.error_message(
            401,
            "SESSION_INVALID",
            "Log in again — this session is no longer valid.",
          )
        Ok(Some(_)) -> {
          let after = case http.header(req, "last-event-id") {
            Ok(header) -> int.parse(header) |> result.unwrap(0)
            Error(Nil) -> option.unwrap(q.last_event_id, 0)
          }
          wisp.response(200)
          |> wisp.set_header(stream_header, int.to_string(after) <> " " <> sid)
        }
      }
  }
}

/// Resolved from the live session, so a sign-out ends a ticket within its lifetime.
fn stream_viewer(
  read: Read,
  sid: String,
  now: Int,
  ttl_ms: Int,
) -> Result(Option(Viewer), Fail(e)) {
  use session <- result.try(sessions.by_sid(read, sid, now, ttl_ms))
  case session {
    Some(s) -> viewer(read, s.holder)
    None -> Ok(None)
  }
}

// ------------------------------------------------------------------------------------------------- the stream

type Signal {
  Deliver(Frame)
  Ping
  Stop
}

type Stream {
  Stream(viewer: Option(Viewer), signals: process.Subject(Signal))
}

/// Opens the stream `connect` agreed to, in the connection's process. The session is resolved again here: it may
/// have ended since.
pub fn open(
  ctx: Ctx,
  marker: String,
  resp: response.Response(a),
) -> response.Response(ewe.Body) {
  let #(after, sid) = case string.split_once(marker, " ") {
    Ok(#(after, sid)) -> #(int.parse(after) |> result.unwrap(0), sid)
    Error(Nil) -> #(0, "")
  }
  ewe.sse(
    resp,
    on_init: fn(conn, selector) {
      let now = clock.now_ms()
      let signals = process.new_subject()
      let frames = process.new_subject()
      let selector =
        selector
        |> process.select(signals)
        |> process.select_map(frames, Deliver)
      let viewer =
        store.read(ctx.store, fn(read) {
          stream_viewer(read, sid, now, ctx.config.session_ttl_ms)
        })
        |> result.unwrap(None)
      case viewer {
        None -> process.send(signals, Stop)
        Some(viewer) -> {
          let _ = send(conn, live.signal("connected", now))
          case live.join(ctx.live, frames, after) {
            live.Fresh -> Nil
            live.Resync -> {
              let _ = send(conn, live.signal("resync", clock.now_ms()))
              Nil
            }
            live.Replay(missed) -> {
              let deliverable =
                store.read(ctx.store, fn(read) {
                  list.filter(missed, fn(f) {
                    may_receive(read, viewer, f.route)
                  })
                })
              list.each(deliverable, fn(f) { send_frame(conn, f) })
              let _ = send(conn, live.signal("caught_up", clock.now_ms()))
              Nil
            }
          }
          process.send_after(signals, ping_ms, Ping)
          Nil
        }
      }
      #(Stream(viewer:, signals:), selector)
    },
    handler: fn(conn, stream, signal) {
      case signal, stream.viewer {
        Deliver(frame), Some(viewer) -> {
          case
            store.read(ctx.store, fn(read) {
              may_receive(read, viewer, frame.route)
            })
          {
            True ->
              case send_frame(conn, frame) {
                Ok(Nil) -> ewe.continue(stream)
                Error(_) -> ewe.stop()
              }
            False -> ewe.continue(stream)
          }
        }
        Ping, Some(_) ->
          case ewe.send_event(conn, ewe.comment("ping")) {
            Ok(Nil) -> {
              process.send_after(stream.signals, ping_ms, Ping)
              ewe.continue(stream)
            }
            Error(_) -> ewe.stop()
          }
        _, _ -> ewe.stop()
      }
    },
    on_close: fn(_) { live.leave(ctx.live) },
  )
}

fn send(conn: ewe.SseConnection, data: String) -> Result(Nil, ewe.SendError) {
  ewe.send_event(conn, ewe.event(data))
}

fn send_frame(
  conn: ewe.SseConnection,
  frame: Frame,
) -> Result(Nil, ewe.SendError) {
  ewe.send_event(
    conn,
    ewe.event(live.data(frame)) |> ewe.event_id(int.to_string(frame.id)),
  )
}
