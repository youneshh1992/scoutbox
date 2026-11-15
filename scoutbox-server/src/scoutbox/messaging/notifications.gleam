//// In-app notifications (`notifications`): the feed always keeps the record. The same sentence about the same
//// record, still unread within six hours, is refreshed and counted rather than written twice.
////
//// Not ported yet:
//// - Push delivery and its quiet-hours and school-hours deferral are outbound providers, out of this slice's
////   scope: every row is written `deferred_push = 0` and nothing is pushed. The deferral also needs the IANA
////   time-zone database, which neither OTP nor a maintained Gleam package provides.
//// - The per-person category switches (`notification_prefs`): every category is on.
//// - The feed's `target` (the journeys' deep link for a notice).

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/notifications as row
import scoutbox/vocab/audience.{type Audience}
import sqlight

const coalesce_ms = 21_600_000

const text_max = 2000

/// The category a notification type belongs to (notificationPrefs.mjs TYPE_CATEGORY), for the types this
/// server sends.
fn category_of(type_: String) -> Option(row.Category) {
  case type_ {
    "request" -> Some(row.Messages)
    "report_resolved" -> Some(row.SecurityAccount)
    "badge" -> Some(row.DiscoveryNudges)
    _ -> None
  }
}

/// Cut to the column's limit at a character boundary, with an ellipsis.
fn cut(text: String) -> String {
  case input.utf16_length(text) > text_max {
    False -> text
    True -> take_utf16(text, text_max - 1) <> "…"
  }
}

/// The longest prefix of whole characters that fits in `n` UTF-16 units.
fn take_utf16(s: String, n: Int) -> String {
  take(string.to_graphemes(s), n, "")
}

fn take(graphemes: List(String), room: Int, acc: String) -> String {
  case graphemes {
    [g, ..rest] ->
      case input.utf16_length(g) <= room {
        True -> take(rest, room - input.utf16_length(g), acc <> g)
        False -> acc
      }
    [] -> acc
  }
}

pub fn notify(
  tx: Tx,
  to kind: Audience,
  id audience_id: String,
  type_ type_: String,
  text text: String,
  ref_id ref_id: Option(String),
  at at: Int,
) -> Result(Nil, Fail(e)) {
  let body = cut(text)
  use existing <- result.try(store.one(
    store.reading(tx),
    "SELECT id FROM notifications WHERE audience_kind = ? AND audience_id = ? AND read = 0 AND type = ? AND occurred_at >= ? AND text = ? AND ref_id IS ? ORDER BY seq DESC LIMIT 1",
    [
      sqlight.text(audience.to_string(kind)),
      sqlight.text(audience_id),
      sqlight.text(type_),
      sqlight.int(at - coalesce_ms),
      sqlight.text(body),
      sqlight.nullable(sqlight.text, ref_id),
    ],
    decode.at([0], decode.string),
  ))
  case existing {
    Ok(id) ->
      store.run(
        tx,
        "UPDATE notifications SET occurred_at = ?, repeat_count = repeat_count + 1 WHERE id = ?",
        [sqlight.int(at), sqlight.text(id)],
      )
    Error(Nil) -> {
      use id <- result.try(ids.next(tx, "ntf"))
      row.insert(
        tx,
        row.New(
          ..row.new(
            id:,
            occurred_at: at,
            audience_kind: kind,
            audience_id:,
            type_:,
            text: body,
          ),
          ref_id:,
          category: category_of(type_),
        ),
      )
    }
  }
}

/// One audience's feed, newest first.
pub fn feed(
  read: Read,
  kind: Audience,
  id: String,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM notifications WHERE audience_kind = ? AND audience_id = ? ORDER BY seq DESC",
    [sqlight.text(audience.to_string(kind)), sqlight.text(id)],
    row.decoder(),
  )
}

pub fn view(n: row.Row) -> Json {
  json.object(
    list.flatten([
      [
        #("id", json.string(n.id)),
        #("ts", json.int(n.occurred_at)),
        #(
          "audience",
          json.object([
            #("kind", json.string(audience.to_string(n.audience_kind))),
            #("id", json.string(n.audience_id)),
          ]),
        ),
        #("type", json.string(n.type_)),
        #("text", json.string(n.text)),
        #("refId", json.nullable(n.ref_id, json.string)),
        #("read", json.bool(n.read)),
        #("repeatCount", json.int(n.repeat_count)),
        #(
          "groupKey",
          json.nullable(
            option.map(n.ref_id, fn(r) { n.type_ <> ":" <> r }),
            json.string,
          ),
        ),
        #(
          "category",
          json.nullable(
            option.map(n.category, row.category_to_string),
            json.string,
          ),
        ),
        #("deferredPush", json.bool(n.deferred_push)),
      ],
      case n.action_required {
        False -> []
        True -> [
          #(
            "actionRequired",
            json.object([
              #("deadline", json.nullable(n.action_deadline_at, json.int)),
              #("ackedAt", json.nullable(n.action_acked_at, json.int)),
              #(
                "ackedBy",
                json.nullable(
                  option.map(n.action_acked_at, fn(_) { n.audience_id }),
                  json.string,
                ),
              ),
            ]),
          ),
        ]
      },
    ]),
  )
}
