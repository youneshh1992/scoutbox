//// A keyed table held by one process: state that lives in memory for the life of the server (rate-limit
//// windows, wrong-code counts), never in the database. Each `update` is atomic, because one process applies
//// them one at a time.

import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import gleam/string

pub opaque type Table(v) {
  Table(subject: Subject(Message(v)))
}

type Message(v) {
  Apply(fn(Dict(String, v)) -> Dict(String, v))
}

/// The most keys a table holds; past it, it starts again empty (a crude memory bound, as the TypeScript
/// limiter has).
const max_keys = 10_000

pub fn start() -> Result(Table(v), String) {
  actor.new(dict.new())
  |> actor.on_message(fn(state, message) {
    let Apply(f) = message
    let state = case dict.size(state) > max_keys {
      True -> dict.new()
      False -> state
    }
    actor.continue(f(state))
  })
  |> actor.start
  |> result.map(fn(started) { Table(started.data) })
  |> result.map_error(string.inspect)
}

/// Applies `f` to the entry under `key` (None: no entry): `f` gives the new entry (None removes it) and an
/// answer, which this returns.
pub fn update(
  table: Table(v),
  key: String,
  f: fn(Option(v)) -> #(Option(v), answer),
) -> answer {
  let reply = process.new_subject()
  process.send(
    table.subject,
    Apply(fn(state) {
      let #(entry, answer) = f(dict.get(state, key) |> option.from_result)
      process.send(reply, answer)
      case entry {
        Some(v) -> dict.insert(state, key, v)
        None -> dict.delete(state, key)
      }
    }),
  )
  let assert Ok(answer) = process.receive(reply, 5000)
    as "the in-memory table did not answer"
  answer
}

/// Every entry, in no particular order.
pub fn entries(table: Table(v)) -> List(#(String, v)) {
  let reply = process.new_subject()
  process.send(
    table.subject,
    Apply(fn(state) {
      process.send(reply, dict.to_list(state))
      state
    }),
  )
  let assert Ok(entries) = process.receive(reply, 5000)
    as "the in-memory table did not answer"
  entries
}
