//// Live sync over server-sent events (domains/platform/liveSync.mjs): the hub every open stream subscribes to.
////
//// EventSource can't send headers, and bearer tokens must not go in URLs, so a client mints a short-lived ticket
//// (`POST /events/ticket`) and opens `GET /events?ticket=…`. The ticket holds the session's sid, never its token.
////
//// The hub numbers each event, keeps the last 500 for reconnects (typing is never kept), and sends every event to
//// every open stream. Each stream is its own process and decides there, from live records, whether its holder may
//// see the event, so a suspension silences a stream that is already open, and the checks run in parallel.
////
//// An event is asked for with `store.emit(tx, effect.Live(…))`, so it is published only after its unit commits.
//// Like the TypeScript server's, the hub's state is the process's: tickets and the replay buffer don't survive a
//// restart, and a client reconnecting with an id from before one is told to resync.

import gleam/dict.{type Dict}
import gleam/erlang/process.{type Pid, type Subject}
import gleam/json
import gleam/list
import gleam/option.{type Option}
import gleam/otp/actor
import gleam/result
import gleam/string
import scoutbox/platform/live_event.{type Event}
import scoutbox/platform/secrets
import scoutbox/rows/id
import scoutbox/vocab/audience.{type Audience}

pub const ticket_ttl_ms = 600_000

const log_cap = 500

/// Who an event may reach, resolved once when it is published.
pub type Route {
  /// A thread's parties. The thread's player side is the player only when they speak for themselves.
  Thread(
    org_id: id.OrgId,
    player_id: id.PlayerId,
    counterparty_is_player: Bool,
    guardian_id: Option(id.GuardianId),
  )
  /// A notice's audience; for a staff member, their organisation.
  Audience(kind: Audience, id: String, org_id: Option(id.OrgId))
  /// The event names nothing that exists: nobody gets it.
  Nobody
}

pub type Frame {
  Frame(id: Int, event: Event, route: Route, at: Int)
}

/// A frame's `data`: the event's name, its payload, and when it happened.
pub fn data(frame: Frame) -> String {
  json.object(
    list.flatten([
      [#("event", json.string(live_event.name(frame.event)))],
      live_event.payload(frame.event),
      [#("ts", json.int(frame.at))],
    ]),
  )
  |> json.to_string
}

/// A signal carrying no event (`connected`, `caught_up`, `resync`).
pub fn signal(name: String, at: Int) -> String {
  json.object([#("event", json.string(name)), #("ts", json.int(at))])
  |> json.to_string
}

/// What a stream joining is told about what it missed.
pub type Joined {
  /// It asked for nothing (no last id).
  Fresh
  /// What it missed, oldest first, then it is caught up.
  Replay(List(Frame))
  /// What it missed is gone (evicted, or from before a restart): it must refetch everything.
  Resync
}

pub opaque type Hub {
  Hub(subject: Subject(Message))
}

type Ticket {
  Ticket(sid: String, expires_at: Int)
}

type Stream {
  Stream(frames: Subject(Frame), monitor: process.Monitor)
}

type State {
  State(
    seq: Int,
    /// Newest first, at most `log_cap`.
    log: List(Frame),
    logged: Int,
    tickets: Dict(String, Ticket),
    streams: Dict(Pid, Stream),
  )
}

type Message {
  Publish(event: Event, route: Route, at: Int)
  Join(frames: Subject(Frame), after: Int, reply: Subject(Joined))
  Leave(pid: Pid)
  Down(process.Down)
  Mint(sid: String, now: Int, reply: Subject(String))
  Redeem(ticket: String, now: Int, reply: Subject(Result(String, Nil)))
  Count(reply: Subject(Int))
}

pub fn start() -> Result(Hub, String) {
  actor.new_with_initialiser(1000, fn(subject) {
    let selector =
      process.new_selector()
      |> process.select(subject)
      |> process.select_monitors(Down)
    State(seq: 0, log: [], logged: 0, tickets: dict.new(), streams: dict.new())
    |> actor.initialised
    |> actor.selecting(selector)
    |> actor.returning(subject)
    |> Ok
  })
  |> actor.on_message(handle)
  |> actor.start
  |> result.map(fn(started) { Hub(started.data) })
  |> result.map_error(string.inspect)
}

/// Numbers the event and sends it to every open stream.
pub fn publish(hub: Hub, event: Event, route: Route, at: Int) -> Nil {
  process.send(hub.subject, Publish(event, route, at))
}

/// Mints a connect ticket for a session.
pub fn mint_ticket(hub: Hub, sid: String, now: Int) -> String {
  process.call(hub.subject, 5000, Mint(sid, now, _))
}

/// The sid a live ticket was minted for. A ticket can be used again within its lifetime, as in the TypeScript
/// server: each connect resolves the session afresh, so a sign-out still ends it.
pub fn redeem_ticket(
  hub: Hub,
  ticket: String,
  now: Int,
) -> Result(String, Nil) {
  process.call(hub.subject, 5000, Redeem(ticket, now, _))
}

/// Subscribes the calling process: every event published from now on arrives on `frames`. `after` is the last id
/// the client saw (0 for none). Subscribing and reading what was missed are one step, so nothing falls between.
/// The stream leaves when its process ends, or with `leave`.
pub fn join(hub: Hub, frames: Subject(Frame), after: Int) -> Joined {
  process.call(hub.subject, 5000, Join(frames, after, _))
}

pub fn leave(hub: Hub) -> Nil {
  process.send(hub.subject, Leave(process.self()))
}

/// How many streams are open.
pub fn streams(hub: Hub) -> Int {
  process.call(hub.subject, 5000, Count)
}

fn handle(state: State, message: Message) -> actor.Next(State, Message) {
  case message {
    Publish(event:, route:, at:) -> {
      let frame = Frame(id: state.seq + 1, event:, route:, at:)
      dict.each(state.streams, fn(_, stream) {
        process.send(stream.frames, frame)
      })
      let state = State(..state, seq: frame.id)
      actor.continue(case live_event.replays(event) {
        False -> state
        True ->
          case state.logged < log_cap {
            True ->
              State(
                ..state,
                log: [frame, ..state.log],
                logged: state.logged + 1,
              )
            False ->
              State(..state, log: [frame, ..list.take(state.log, log_cap - 1)])
          }
      })
    }
    Join(frames:, after:, reply:) -> {
      let state = case process.subject_owner(frames) {
        Ok(pid) -> {
          let monitor = process.monitor(pid)
          State(
            ..state,
            streams: dict.insert(state.streams, pid, Stream(frames, monitor)),
          )
        }
        Error(Nil) -> state
      }
      process.send(reply, joined(state, after))
      actor.continue(state)
    }
    Leave(pid:) -> {
      case dict.get(state.streams, pid) {
        Ok(stream) -> process.demonitor_process(stream.monitor)
        Error(Nil) -> Nil
      }
      actor.continue(State(..state, streams: dict.delete(state.streams, pid)))
    }
    Down(process.ProcessDown(pid:, ..)) ->
      actor.continue(State(..state, streams: dict.delete(state.streams, pid)))
    Down(process.PortDown(..)) -> actor.continue(state)
    Mint(sid:, now:, reply:) -> {
      let ticket = secrets.random_hex(24)
      let tickets =
        dict.filter(state.tickets, fn(_, t) { t.expires_at >= now })
        |> dict.insert(ticket, Ticket(sid:, expires_at: now + ticket_ttl_ms))
      process.send(reply, ticket)
      actor.continue(State(..state, tickets:))
    }
    Redeem(ticket:, now:, reply:) -> {
      process.send(reply, case dict.get(state.tickets, ticket) {
        Ok(t) if t.expires_at >= now -> Ok(t.sid)
        _ -> Error(Nil)
      })
      actor.continue(state)
    }
    Count(reply:) -> {
      process.send(reply, dict.size(state.streams))
      actor.continue(state)
    }
  }
}

fn joined(state: State, after: Int) -> Joined {
  let oldest = case list.last(state.log) {
    Ok(frame) -> frame.id
    Error(Nil) -> state.seq + 1
  }
  case after {
    _ if after <= 0 -> Fresh
    _ if after > state.seq || after < oldest - 1 -> Resync
    _ ->
      list.take_while(state.log, fn(frame) { frame.id > after })
      |> list.reverse
      |> Replay
  }
}
