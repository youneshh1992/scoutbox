//// Push (`push_log`, `push_tokens`; adapters.mjs `createPushSender`). The push record is written after the
//// notice's unit commits, in a unit of its own. The device tokens are the Player app's: players' and guardians'.
////
//// Not ported yet: the Expo transport. Every push is `dev-log`: the record is the delivery, as on a server with
//// no EXPO_ACCESS_TOKEN.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import scoutbox/platform/input
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/push_log as row
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/party.{type Party}
import sqlight

const body_max = 4000

/// Records a push to `kind`/`id`, titled `title`.
pub fn send(
  tx: Tx,
  kind: Audience,
  id: String,
  title: String,
  body: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use push_id <- result.try(id.next_push(tx))
  row.insert(
    tx,
    row.new(
      id: push_id,
      created_at: at,
      audience_kind: kind,
      audience_id: id,
      title:,
      body: input.utf16_take(body, body_max),
      transport: row.DevLog,
    ),
  )
}

/// Newest first, keyed by `seq`.
pub fn page(
  read: Read,
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  let #(where, args) = case page.after {
    Some([IntKey(seq)]) -> #(" WHERE seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM push_log"
      <> where
      <> " ORDER BY seq DESC LIMIT ?",
    list.append(args, [sqlight.int(page.limit + 1)]),
    row.decoder(),
  ))
  paging.page_of(rows, page.limit, fn(p) { [IntKey(p.seq)] })
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM push_log",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

pub fn view(p: row.Row) -> Json {
  json.object([
    #("id", id.push_json(p.id)),
    #("ts", json.int(p.created_at)),
    #(
      "audience",
      json.object([
        #("kind", audience.to_json(p.audience_kind)),
        #("id", json.string(p.audience_id)),
      ]),
    ),
    #("title", json.string(p.title)),
    #("body", json.string(p.body)),
    #("transport", row.transport_to_json(p.transport)),
  ])
}

/// A device token for a player or a guardian. A token another account holds moves to this one; the same account
/// registering it again updates its time. True when it moved.
pub fn register(
  tx: Tx,
  kind: Party,
  ref_id: String,
  token: String,
  at: Int,
) -> Result(Bool, Fail(e)) {
  use held <- result.try(
    store.one(
      store.reading(tx),
      "SELECT ref_kind, ref_id FROM push_tokens WHERE token = ?",
      [sqlight.text(token)],
      {
        use k <- decode.field(0, decode.string)
        use i <- decode.field(1, decode.string)
        decode.success(#(k, i))
      },
    ),
  )
  use _ <- result.map(
    store.run(
      tx,
      "INSERT INTO push_tokens (ref_kind, ref_id, token, registered_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, registered_at = excluded.registered_at",
      [
        sqlight.text(party.to_string(kind)),
        sqlight.text(ref_id),
        sqlight.text(token),
        sqlight.int(at),
      ],
    ),
  )
  case held {
    Ok(#(k, i)) -> k != party.to_string(kind) || i != ref_id
    Error(Nil) -> False
  }
}
