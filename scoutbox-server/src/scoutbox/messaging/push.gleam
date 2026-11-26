//// Push (`push_log`, `push_tokens`; adapters.mjs `createPushSender`). The push record is written after the
//// notice's unit commits, in a unit of its own. The device tokens are the Player app's: players' and guardians'.
////
////
//// Without EXPO_ACCESS_TOKEN every push is `dev-log`: the record is the delivery. With it the record says `expo`,
//// and once it is written each of the audience's registered tokens is handed to Expo (`deliver`), in a process of
//// its own. Expo's answer is not kept: the record is the push either way.

import gleam/dynamic/decode
import gleam/erlang/process
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import scoutbox/messaging/transport
import scoutbox/platform/input
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Store, type Tx}
import scoutbox/rows/id
import scoutbox/rows/push_log as row
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/party.{type Party}
import sqlight
import wisp

const body_max = 4000

/// Records a push to `kind`/`id`, titled `title`, on `via`.
pub fn send(
  tx: Tx,
  via: transport.Push,
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
      transport: case via {
        transport.DevLog -> row.DevLog
        transport.Expo(..) -> row.Expo
      },
    ),
  )
}

/// After the record is written: on Expo, one call per device token `kind`/`id` registered, oldest first, in a
/// process of its own. Nothing on the dev transport.
pub fn deliver(
  store: Store,
  via: transport.Push,
  kind: Audience,
  id: String,
  title: String,
  body: String,
) -> Nil {
  case via {
    transport.DevLog -> Nil
    transport.Expo(..) ->
      case holder(kind) {
        // Staff never register a device (`POST /push/register` refuses them): there is nobody to call.
        Error(Nil) -> Nil
        Ok(holder) -> {
          process.spawn_unlinked(fn() {
            case store.read(store, tokens(_, holder, id)) {
              Ok(tokens) ->
                list.each(tokens, fn(token) {
                  transport.send_push(via, token:, title:, body:)
                })
              Error(e) ->
                wisp.log_error("push tokens not read: " <> string.inspect(e))
            }
          })
          Nil
        }
      }
  }
}

/// Who may hold a device token among a push's audiences: players and guardians.
fn holder(kind: Audience) -> Result(Party, Nil) {
  case kind {
    audience.Player -> Ok(party.Player)
    audience.Guardian -> Ok(party.Guardian)
    audience.OrgUser -> Error(Nil)
  }
}

/// The device tokens `kind`/`id` registered, oldest first.
pub fn tokens(
  read: Read,
  kind: Party,
  id: String,
) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT token FROM push_tokens WHERE ref_kind = ? AND ref_id = ? ORDER BY registered_at, seq",
    [sqlight.text(party.to_string(kind)), sqlight.text(id)],
    decode.at([0], decode.string),
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
