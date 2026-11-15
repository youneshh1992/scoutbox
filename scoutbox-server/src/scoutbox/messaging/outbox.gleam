//// The mail outbox (`outbox`). Every mail is recorded before its provider call; on the dev transport, which is
//// the only one this server has so far, the outbox is the delivery.
////
//// The outbox also holds the messaging domain's delivery records (`source = 'delivery'`); they arrive with that
//// domain.

import gleam/dynamic/decode.{type Decoder}
import gleam/json.{type Json}
import gleam/list
import gleam/option.{Some}
import gleam/result
import gleam/string
import scoutbox/platform/ids
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import sqlight

pub type Mail {
  Mail(
    seq: Int,
    id: String,
    ts: Int,
    to: String,
    subject: String,
    text: String,
    transport: String,
    delivered: Bool,
  )
}

fn decoder() -> Decoder(Mail) {
  use seq <- decode.field(0, decode.int)
  use id <- decode.field(1, decode.string)
  use ts <- decode.field(2, decode.int)
  use to <- decode.field(3, decode.string)
  use subject <- decode.field(4, decode.string)
  use text <- decode.field(5, decode.string)
  use transport <- decode.field(6, decode.string)
  use delivered <- decode.field(7, sqlight.decode_bool())
  decode.success(Mail(
    seq:,
    id:,
    ts:,
    to:,
    subject:,
    text:,
    transport:,
    delivered:,
  ))
}

const columns =
  "seq, id, created_at, to_address, subject, text, transport, delivered"

/// Records a mail on the dev transport. A subject or text longer than the columns hold is shortened, never
/// refused: the mail still goes.
pub fn append(
  tx: Tx,
  to to: String,
  subject subject: String,
  text text: String,
  at at: Int,
) -> Result(Nil, Fail(e)) {
  use id <- result.try(ids.next(tx, "mail"))
  store.run(
    tx,
    "INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered) VALUES (?, 'mailer', ?, ?, ?, ?, 'dev-outbox', 1)",
    [
      sqlight.text(id),
      sqlight.int(at),
      sqlight.text(to),
      sqlight.text(string.slice(subject, 0, 300)),
      sqlight.text(string.slice(text, 0, 10_000)),
    ],
  )
}

/// Newest first, keyed by `seq`.
pub fn page(
  read: Read,
  page: Page,
) -> Result(#(List(Mail), option.Option(String)), Fail(e)) {
  let #(where, args) = case page.after {
    Some([IntKey(seq)]) -> #("AND seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM outbox WHERE source = 'mailer' "
      <> where
      <> " ORDER BY seq DESC LIMIT ?",
    list.append(args, [sqlight.int(page.limit + 1)]),
    decoder(),
  ))
  paging.page_of(rows, page.limit, fn(m) { [IntKey(m.seq)] })
}

pub fn view(m: Mail) -> Json {
  json.object([
    #("id", json.string(m.id)),
    #("ts", json.int(m.ts)),
    #("to", json.string(m.to)),
    #("subject", json.string(m.subject)),
    #("text", json.string(m.text)),
    #("transport", json.string(m.transport)),
    #("delivered", json.bool(m.delivered)),
  ])
}
