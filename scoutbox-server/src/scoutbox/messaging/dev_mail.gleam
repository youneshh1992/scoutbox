//// The dev transport's delivered texts (adapters.mjs `devDeliveries`). A mail's stored outbox record withholds its
//// one-time codes, because the record is copied into every backup. On the dev transport the outbox is the delivery,
//// so the full text of the latest such mails is kept in this process's memory only (never saved, gone at restart)
//// and the admin outbox shows it.

import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/option.{type Option}
import gleam/otp/actor
import gleam/result
import gleam/string
import scoutbox/messaging/outbox.{type Mail}
import scoutbox/rows/id

/// How many texts are kept; the oldest goes first.
const limit = 500

pub opaque type Deliveries {
  Deliveries(subject: Subject(Message))
}

type Message {
  Keep(id: String, text: String)
  Get(id: String, reply: Subject(Option(String)))
}

type State {
  State(texts: Dict(String, String), newest_first: List(String))
}

pub fn start() -> Result(Deliveries, String) {
  actor.new(State(dict.new(), []))
  |> actor.on_message(fn(state, message) {
    case message {
      Keep(id:, text:) -> {
        let order = [id, ..state.newest_first]
        let #(kept, dropped) = list.split(order, limit)
        actor.continue(State(
          texts: dict.insert(state.texts, id, text) |> dict.drop(dropped),
          newest_first: kept,
        ))
      }
      Get(id:, reply:) -> {
        process.send(reply, dict.get(state.texts, id) |> option.from_result)
        actor.continue(state)
      }
    }
  })
  |> actor.start
  |> result.map(fn(started) { Deliveries(started.data) })
  |> result.map_error(string.inspect)
}

/// Keeps the full text of a mail whose record withholds a code.
pub fn keep(d: Deliveries, mail: id.MailId, text: String) -> Nil {
  process.send(d.subject, Keep(id.mail_to_string(mail), text))
}

/// The mail as the admin outbox shows it: in full while this process holds its text.
pub fn shown(d: Deliveries, m: Mail) -> Mail {
  let reply = process.new_subject()
  process.send(d.subject, Get(id.mail_to_string(m.id), reply))
  case process.receive(reply, 5000) {
    Ok(option.Some(text)) -> outbox.with_text(m, text)
    _ -> m
  }
}
