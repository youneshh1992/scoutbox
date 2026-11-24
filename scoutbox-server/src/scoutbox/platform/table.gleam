//// A keyed table held by one process: state that lives in memory for the life of the server (rate-limit
//// windows, wrong-code counts), never in the database. Each `update` is atomic, because one process applies
//// them one at a time.
////
//// A bounded table holds at most `max_keys`. It evicts rather than clears, as the TypeScript limiter
//// (`memoryRateLimitProvider`) does: sign-in keys are whatever the caller typed, so clearing when full would let a
//// flood of made-up names wipe every real budget. When a new key arrives at the cap, expired entries go first,
//// then the quarter that weighs least (a flood touches each key once).

import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/otp/actor
import gleam/result
import gleam/string

pub opaque type Table(v) {
  Table(subject: Subject(Message(v)), bound: Bound(v))
}

/// How a table keeps within its cap.
pub type Bound(v) {
  /// A table of a few fixed keys, which never nears the cap.
  Unbounded
  /// `expired(key, entry, now)`: the entry no longer counts and can go. `weight(entry, now)`: the order entries are
  /// evicted in, lightest first (for a budget, its hits then its start, so the fewest hits go, oldest among
  /// equals).
  Bounded(
    expired: fn(String, v, Int) -> Bool,
    weight: fn(v, Int) -> #(Int, Int),
  )
}

type Message(v) {
  Apply(fn(Dict(String, v)) -> Dict(String, v))
}

/// The most keys a bounded table holds, as the TypeScript limiter.
pub const max_keys = 20_000

pub fn start(bound: Bound(v)) -> Result(Table(v), String) {
  actor.new(dict.new())
  |> actor.on_message(fn(state, message) {
    let Apply(f) = message
    actor.continue(f(state))
  })
  |> actor.start
  |> result.map(fn(started) { Table(started.data, bound) })
  |> result.map_error(string.inspect)
}

/// Applies `f` to the entry under `key` (None: no entry) at time `now`: `f` gives the new entry (None removes it)
/// and an answer, which this returns.
pub fn update(
  table: Table(v),
  key: String,
  now: Int,
  f: fn(Option(v)) -> #(Option(v), answer),
) -> answer {
  let reply = process.new_subject()
  process.send(
    table.subject,
    Apply(fn(state) {
      let existing = dict.get(state, key) |> option.from_result
      let #(entry, answer) = f(existing)
      process.send(reply, answer)
      case entry, existing {
        Some(v), Some(_) -> dict.insert(state, key, v)
        Some(v), None ->
          make_room(state, table.bound, now) |> dict.insert(key, v)
        None, _ -> dict.delete(state, key)
      }
    }),
  )
  let assert Ok(answer) = process.receive(reply, 5000)
    as "the in-memory table did not answer"
  answer
}

/// `state` with room for one more key.
fn make_room(
  state: Dict(String, v),
  bound: Bound(v),
  now: Int,
) -> Dict(String, v) {
  case bound, dict.size(state) >= max_keys {
    Bounded(expired:, weight:), True -> {
      let state = dict.filter(state, fn(k, v) { !expired(k, v, now) })
      case dict.size(state) >= max_keys {
        False -> state
        True -> {
          let victims =
            dict.to_list(state)
            |> list.sort(fn(a, b) {
              let #(x1, x2) = weight(a.1, now)
              let #(y1, y2) = weight(b.1, now)
              int.compare(x1, y1)
              |> order.lazy_break_tie(fn() { int.compare(x2, y2) })
            })
            |> list.take({ dict.size(state) + 3 } / 4)
            |> list.map(fn(e) { e.0 })
          dict.drop(state, victims)
        }
      }
    }
    _, _ -> state
  }
}

/// How many keys the table holds.
pub fn size(table: Table(v)) -> Int {
  ask(table, dict.size)
}

/// Every entry, in no particular order.
pub fn entries(table: Table(v)) -> List(#(String, v)) {
  ask(table, dict.to_list)
}

fn ask(table: Table(v), read: fn(Dict(String, v)) -> a) -> a {
  let reply = process.new_subject()
  process.send(
    table.subject,
    Apply(fn(state) {
      process.send(reply, read(state))
      state
    }),
  )
  let assert Ok(answer) = process.receive(reply, 5000)
    as "the in-memory table did not answer"
  answer
}
