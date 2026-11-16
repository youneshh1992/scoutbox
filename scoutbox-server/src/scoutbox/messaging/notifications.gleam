//// In-app notifications (`notifications`; domains/messaging/notify.mjs). The feed always keeps the record; quiet
//// hours and the minors' school-hours mute only hold back the push. A muted category creates no notice. The same
//// sentence about the same record, still unread within six hours, is refreshed and counted rather than written
//// (or pushed) twice.
////
//// `notify` asks for its push with `store.emit` (none when the notice is muted, repeated or deferred), so it is
//// sent only once the unit commits.
////
//// Not ported yet: the live `notify` event, and a staff member's feed `target` (the recruitment Rooms).

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import gleam/time/calendar
import scoutbox/messaging/notification_prefs
import scoutbox/platform/effect.{SendPush}
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/zones
import scoutbox/rows/guardians as guardian_row
import scoutbox/rows/notifications as row
import scoutbox/rows/players as player_row
import scoutbox/rules/age
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/notification_category
import scoutbox/vocab/party
import sqlight

const coalesce_ms = 21_600_000

const text_max = 2000

/// Quiet hours are wall-clock rules for the person: their own zone when their preferences carry one, otherwise
/// the platform's home zone, never the server's.
const home_zone = "Europe/London"

pub type Notification =
  row.Row

/// Cut to the column's limit at a character boundary, with an ellipsis.
fn cut(text: String) -> String {
  case input.utf16_length(text) > text_max {
    False -> text
    True -> input.utf16_take(text, text_max - 1) <> "…"
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
  deliver(tx, kind, audience_id, type_, text, ref_id, None, at)
}

/// A notice the person must acknowledge, by `deadline` when there is one (delivery.mjs `notifyAction`).
pub fn notify_action(
  tx: Tx,
  to kind: Audience,
  id audience_id: String,
  type_ type_: String,
  text text: String,
  ref_id ref_id: Option(String),
  deadline deadline: Option(Int),
  at at: Int,
) -> Result(Nil, Fail(e)) {
  deliver(tx, kind, audience_id, type_, text, ref_id, Some(deadline), at)
}

fn deliver(
  tx: Tx,
  kind: Audience,
  audience_id: String,
  type_: String,
  text: String,
  ref_id: Option(String),
  action: Option(Option(Int)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  let body = cut(text)
  let category = notification_prefs.category_of(type_, body)
  use allowed <- result.try(notification_prefs.allows(
    read,
    kind,
    audience_id,
    notification_prefs.category_of(type_, text),
  ))
  use <- guard(allowed)
  use existing <- result.try(store.one(
    read,
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
    Ok(id) -> {
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE notifications SET occurred_at = ?, repeat_count = repeat_count + 1 WHERE id = ?",
          [sqlight.int(at), sqlight.text(id)],
        ),
      )
      // A repeat is counted, never pushed again.
      case action {
        None -> Ok(Nil)
        Some(deadline) ->
          store.run(
            tx,
            "UPDATE notifications SET action_required = 1, action_deadline_at = ?, action_acked_at = NULL WHERE id = ?",
            [sqlight.nullable(sqlight.int, deadline), sqlight.text(id)],
          )
      }
    }
    Error(Nil) -> {
      use deferred <- result.try(push_deferred(read, kind, audience_id, at))
      use id <- result.try(ids.next(tx, "ntf"))
      use _ <- result.map(row.insert(
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
          category:,
          deferred_push: deferred,
          action_required: option.is_some(action),
          action_deadline_at: option.flatten(action),
        ),
      ))
      case deferred {
        True -> Nil
        False ->
          store.emit(
            tx,
            SendPush(to: kind, id: audience_id, title: "ScoutBox", body:),
          )
      }
    }
  }
}

fn guard(
  allowed: Bool,
  next: fn() -> Result(Nil, Fail(e)),
) -> Result(Nil, Fail(e)) {
  case allowed {
    True -> next()
    False -> Ok(Nil)
  }
}

type PushPrefs {
  PushPrefs(
    quiet_start: Option(String),
    quiet_end: Option(String),
    school_hours_mute: Option(Bool),
    timezone: Option(String),
    minor: Bool,
  )
}

fn person_prefs(
  read: Read,
  kind: Audience,
  id: String,
  at: Int,
) -> Result(Option(PushPrefs), Fail(e)) {
  case kind {
    audience.Player ->
      store.one(
        read,
        "SELECT " <> player_row.columns <> " FROM players WHERE id = ?",
        [sqlight.text(id)],
        player_row.decoder(),
      )
      |> result.map(fn(found) {
        option.from_result(found)
        |> option.map(fn(p) {
          PushPrefs(
            quiet_start: p.prefs_quiet_start,
            quiet_end: p.prefs_quiet_end,
            school_hours_mute: p.prefs_school_hours_mute,
            timezone: p.prefs_timezone,
            minor: !age.is_adult(p.birth_date, p.country, at),
          )
        })
      })
    audience.Guardian ->
      store.one(
        read,
        "SELECT " <> guardian_row.columns <> " FROM guardians WHERE id = ?",
        [sqlight.text(id)],
        guardian_row.decoder(),
      )
      |> result.map(fn(found) {
        option.from_result(found)
        |> option.map(fn(g) {
          PushPrefs(
            quiet_start: g.prefs_quiet_start,
            quiet_end: g.prefs_quiet_end,
            school_hours_mute: g.prefs_school_hours_mute,
            timezone: g.prefs_timezone,
            minor: False,
          )
        })
      })
    audience.OrgUser -> Ok(None)
  }
}

/// Whether the push waits: school hours for a minor (unless the guardian turned the mute off), or the person's
/// quiet hours, on their own wall clock.
fn push_deferred(
  read: Read,
  kind: Audience,
  id: String,
  at: Int,
) -> Result(Bool, Fail(e)) {
  use prefs <- result.map(person_prefs(read, kind, id, at))
  let zone = case option.then(prefs, fn(p) { p.timezone }) {
    Some(z) ->
      case zones.known(z) {
        True -> z
        False -> home_zone
      }
    None -> home_zone
  }
  let wall = zones.local_parts(at, zone)
  let minutes = wall.hour * 60 + wall.minute
  let school_mute = case prefs {
    Some(p) -> option.unwrap(p.school_hours_mute, p.minor)
    None -> False
  }
  let weekday = case wall.weekday {
    calendar.Saturday | calendar.Sunday -> False
    _ -> True
  }
  let in_school = school_mute && weekday && minutes >= 510 && minutes <= 930
  let in_quiet = case
    option.then(prefs, fn(p) { p.quiet_start }),
    option.then(prefs, fn(p) { p.quiet_end })
  {
    Some(qs), Some(qe) if qs != "" && qe != "" -> {
      let qs = minutes_of(qs)
      let qe = minutes_of(qe)
      case qs <= qe {
        True -> minutes >= qs && minutes < qe
        False -> minutes >= qs || minutes < qe
      }
    }
    _, _ -> False
  }
  in_school || in_quiet
}

fn minutes_of(hhmm: String) -> Int {
  case string.split(hhmm, ":") {
    [h, m] ->
      result.unwrap(int.parse(h), 0) * 60 + result.unwrap(int.parse(m), 0)
    [h] -> result.unwrap(int.parse(h), 0) * 60
    _ -> 0
  }
}

// ------------------------------------------------------------------------------------------------- reads

pub fn by_id(read: Read, id: String) -> Result(Option(Notification), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM notifications WHERE id = ?",
    [sqlight.text(id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

/// A feed row and where it leads: the current resource its `ref_id` points to that this audience may open.
pub type FeedItem {
  FeedItem(notification: Notification, target: Option(Json))
}

/// One audience's feed, newest first, each row with its target.
pub fn feed(
  read: Read,
  kind: Audience,
  id: String,
) -> Result(List(FeedItem), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM notifications WHERE audience_kind = ? AND audience_id = ? ORDER BY seq DESC",
    [sqlight.text(audience.to_string(kind)), sqlight.text(id)],
    row.decoder(),
  ))
  let request_refs =
    list.filter_map(rows, fn(n) {
      case n.ref_id {
        Some("req-" <> _ as ref) -> Ok(ref)
        _ -> Error(Nil)
      }
    })
    |> list.unique
  use requests <- result.map(
    store.query(
      read,
      "SELECT id, player_id, routed_to, guardian_id FROM recruitment_requests WHERE id IN (SELECT value FROM json_each(?))",
      [json.array(request_refs, json.string) |> json.to_string |> sqlight.text],
      {
        use rid <- decode.field(0, decode.string)
        use player_id <- decode.field(1, decode.string)
        use routed_to <- decode.field(2, party.decoder())
        use guardian_id <- decode.field(3, decode.optional(decode.string))
        decode.success(#(rid, #(player_id, routed_to, guardian_id)))
      },
    ),
  )
  let requests = dict.from_list(requests)
  list.map(rows, fn(n) {
    let target = case n.ref_id {
      Some("req-" <> _ as ref) ->
        case dict.get(requests, ref), kind {
          Ok(#(player_id, routed_to, _)), audience.Player
            if player_id == id && routed_to != party.Guardian
          -> Some(inbox_target(ref))
          Ok(#(_, _, Some(guardian_id))), audience.Guardian
            if guardian_id == id
          -> Some(inbox_target(ref))
          // Not ported yet: a staff member's request leads to its recruitment Room.
          _, _ -> None
        }
      _ -> None
    }
    FeedItem(n, target)
  })
}

fn inbox_target(request_id: String) -> Json {
  json.object([
    #("kind", json.string("inbox")),
    #("requestId", json.string(request_id)),
  ])
}

/// Every unread row of one audience, read.
pub fn mark_read(tx: Tx, kind: Audience, id: String) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE notifications SET read = 1 WHERE audience_kind = ? AND audience_id = ? AND read = 0",
    [sqlight.text(audience.to_string(kind)), sqlight.text(id)],
  )
}

/// Records the acknowledgment of an action notice; the first one stands.
pub fn ack(tx: Tx, id: String, at: Int) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE notifications SET action_acked_at = ? WHERE id = ? AND action_required = 1 AND action_acked_at IS NULL",
    [sqlight.int(at), sqlight.text(id)],
  )
}

pub fn awaiting_ack_count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM notifications WHERE action_required = 1 AND action_acked_at IS NULL",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// The notices the delivery centre has not made dispatches for yet, in insertion order after `after_seq`.
pub fn undispatched(
  read: Read,
  after_seq: Int,
  limit: Int,
) -> Result(List(Notification), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM notifications WHERE dispatched_at IS NULL AND seq > ? ORDER BY seq LIMIT ?",
    [sqlight.int(after_seq), sqlight.int(limit)],
    row.decoder(),
  )
}

/// The delivery centre made this notice's dispatches.
pub fn mark_dispatched(tx: Tx, id: String, at: Int) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE notifications SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL",
    [sqlight.int(at), sqlight.text(id)],
  )
}

// ------------------------------------------------------------------------------------------------- views

pub fn view(item: FeedItem) -> Json {
  let n = item.notification
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
            option.map(n.category, notification_category.to_string),
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
      [#("target", option.unwrap(item.target, json.null()))],
    ]),
  )
}
