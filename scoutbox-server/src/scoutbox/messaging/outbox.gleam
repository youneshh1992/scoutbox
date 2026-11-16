//// The mail outbox (`outbox`). Every mail is recorded before its provider call; on the dev transport, which is
//// the only one this server has so far, the outbox is the delivery. It also holds what the delivery centre's
//// local fake provider accepted (`source = 'delivery'`).

import gleam/json.{type Json}
import gleam/list
import gleam/option.{Some}
import gleam/result
import gleam/string
import scoutbox/platform/ids
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/outbox as row
import sqlight

pub type Mail =
  row.Row

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
  row.insert(
    tx,
    row.New(
      ..row.new(
        id:,
        source: row.Mailer,
        created_at: at,
        to_address: to,
        text: string.slice(text, 0, 10_000),
        transport: row.DevOutbox,
      ),
      subject: Some(string.slice(subject, 0, 300)),
      delivered: Some(True),
    ),
  )
}

/// What the delivery centre's local fake provider accepted: the record is the send.
pub fn append_delivery(
  tx: Tx,
  to to: String,
  text text: String,
  provider_message_id provider_message_id: String,
  at at: Int,
) -> Result(Nil, Fail(e)) {
  use id <- result.try(ids.next(tx, "mail"))
  row.insert(
    tx,
    row.New(
      ..row.new(
        id:,
        source: row.Delivery,
        created_at: at,
        to_address: to,
        text: string.slice(text, 0, 300),
        transport: row.LocalFake,
      ),
      channel: Some("email"),
      provider_message_id: Some(provider_message_id),
    ),
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
      <> row.columns
      <> " FROM outbox WHERE 1 = 1 "
      <> where
      <> " ORDER BY seq DESC LIMIT ?",
    list.append(args, [sqlight.int(page.limit + 1)]),
    row.decoder(),
  ))
  paging.page_of(rows, page.limit, fn(m) { [IntKey(m.seq)] })
}

pub fn view(m: Mail) -> Json {
  case m.source {
    row.Mailer -> mail_view(m)
    row.Delivery ->
      json.object([
        #("id", json.string(m.id)),
        #("at", json.int(m.created_at)),
        #("channel", json.string("email")),
        #("to", json.string(m.to_address)),
        #("text", json.string(m.text)),
        #(
          "providerMessageId",
          json.string(option.unwrap(m.provider_message_id, "")),
        ),
        #("provider", row.transport_to_json(m.transport)),
      ])
  }
}

fn mail_view(m: Mail) -> Json {
  json.object([
    #("id", json.string(m.id)),
    #("ts", json.int(m.created_at)),
    #("to", json.string(m.to_address)),
    #("subject", json.string(option.unwrap(m.subject, ""))),
    #("text", json.string(m.text)),
    #("transport", row.transport_to_json(m.transport)),
    #("delivered", json.bool(option.unwrap(m.delivered, False))),
  ])
}
