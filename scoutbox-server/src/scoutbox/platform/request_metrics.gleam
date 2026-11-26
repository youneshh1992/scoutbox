//// The process's request counters (domains/platform/metrics.mjs), as `/admin/metrics` shows them: every response
//// counted once it is built, by status class, by slowness and by the first segment of its path, and the counters a
//// route keeps outside a unit (the analytics reads). Counts only, never a person or an organisation.
////
//// They live in one process for the life of the server and start at zero on every boot, like the TypeScript
//// server's in-memory ones. A request sends its count and never waits for it; only the metrics read waits, for a
//// snapshot. The counters a unit keeps (rolled back with a refused act) are `platform/metrics`, on the writer.

import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import gleam/string

/// A response slower than this counts as slow.
const slow_ms = 500

pub opaque type RequestMetrics {
  RequestMetrics(subject: Subject(Message))
}

pub type Snapshot {
  Snapshot(
    requests: Int,
    status_2xx: Int,
    status_4xx: Int,
    status_5xx: Int,
    slow_requests: Int,
    /// `/<first segment>` → count, in the order each was first seen.
    by_route: List(#(String, Int)),
    failed_uploads: Int,
    sse_connects: Int,
    counters: Dict(#(String, String), Int),
  )
}

type Message {
  Finished(path: String, status: Int, ms: Int)
  Count(group: String, name: String)
  Read(reply: Subject(Snapshot))
}

type State {
  State(
    snapshot: Snapshot,
    routes: Dict(String, Int),
    route_order: List(String),
  )
}

pub fn start() -> Result(RequestMetrics, String) {
  let empty =
    Snapshot(
      requests: 0,
      status_2xx: 0,
      status_4xx: 0,
      status_5xx: 0,
      slow_requests: 0,
      by_route: [],
      failed_uploads: 0,
      sse_connects: 0,
      counters: dict.new(),
    )
  actor.new(State(empty, dict.new(), []))
  |> actor.on_message(fn(state, message) {
    case message {
      Finished(path:, status:, ms:) ->
        actor.continue(finished(state, path, status, ms))
      Count(group:, name:) ->
        actor.continue(
          State(
            ..state,
            snapshot: Snapshot(
              ..state.snapshot,
              counters: dict.upsert(
                state.snapshot.counters,
                #(group, name),
                bump,
              ),
            ),
          ),
        )
      Read(reply) -> {
        let by_route =
          list.reverse(state.route_order)
          |> list.map(fn(route) {
            #(route, dict.get(state.routes, route) |> result.unwrap(0))
          })
        process.send(reply, Snapshot(..state.snapshot, by_route:))
        actor.continue(state)
      }
    }
  })
  |> actor.start
  |> result.map(fn(started) { RequestMetrics(started.data) })
  |> result.map_error(string.inspect)
}

fn bump(n: Option(Int)) -> Int {
  case n {
    Some(n) -> n + 1
    None -> 1
  }
}

fn finished(state: State, path: String, status: Int, ms: Int) -> State {
  let s = state.snapshot
  let one = fn(yes) {
    case yes {
      True -> 1
      False -> 0
    }
  }
  let route = "/" <> first_segment(path)
  let order = case dict.has_key(state.routes, route) {
    True -> state.route_order
    False -> [route, ..state.route_order]
  }
  State(
    snapshot: Snapshot(
      ..s,
      requests: s.requests + 1,
      status_2xx: s.status_2xx + one(status < 400),
      status_4xx: s.status_4xx + one(status >= 400 && status < 500),
      status_5xx: s.status_5xx + one(status >= 500),
      slow_requests: s.slow_requests + one(ms > slow_ms),
      failed_uploads: s.failed_uploads
        + one(string.starts_with(path, "/player/uploads") && status >= 400),
      sse_connects: s.sse_connects + one(path == "/events"),
    ),
    routes: dict.upsert(state.routes, route, bump),
    route_order: order,
  )
}

/// JavaScript's `path.split('/')[1] ?? ''`.
fn first_segment(path: String) -> String {
  case string.split(path, "/") {
    [_, segment, ..] -> segment
    _ -> ""
  }
}

/// Counts one finished request.
pub fn finished_request(
  m: RequestMetrics,
  path path: String,
  status status: Int,
  ms ms: Int,
) -> Nil {
  process.send(m.subject, Finished(path:, status:, ms:))
}

/// Counts one occurrence of `name` in `group`, outside any unit.
pub fn count(m: RequestMetrics, group: String, name: String) -> Nil {
  process.send(m.subject, Count(group:, name:))
}

/// The counters as they stand.
pub fn snapshot(m: RequestMetrics) -> Snapshot {
  process.call(m.subject, 5000, Read)
}

/// The names `group` has counted, in code point order.
pub fn names(s: Snapshot, group: String) -> List(String) {
  dict.keys(s.counters)
  |> list.filter_map(fn(key) {
    case key {
      #(g, name) if g == group -> Ok(name)
      _ -> Error(Nil)
    }
  })
  |> list.sort(string.compare)
}

/// One of `group`'s counters (0 when never counted).
pub fn counter(s: Snapshot, group: String, name: String) -> Int {
  dict.get(s.counters, #(group, name)) |> result.unwrap(0)
}
