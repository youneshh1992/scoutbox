//// Delivery dispatches and their attempts (`dispatches`, `dispatch_attempts`; repositories/dispatches.ts). A
//// dispatch is one notification on one channel: every notification gets an `in_app` row (delivered at once) and an
//// `email` row (sent through the provider, skipped, or held for quiet hours). An attempt is a send or a
//// quiet-hours re-check note, which never counts as a send.

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/dispatch_attempts as attempt_row
import scoutbox/rows/dispatches as row
import scoutbox/rows/id
import scoutbox/vocab/audience
import sqlight

pub type Dispatch {
  Dispatch(row: row.Row, attempts: List(attempt_row.Row))
}

/// The ladder: queued or held → accepted → delivered → opened → actioned. Status only ever moves up it. The side
/// states (skipped, failed, retrying) are off the ladder: no comparison holds for them, as in delivery.mjs.
fn rank(status: row.Status) -> Result(Int, Nil) {
  case status {
    row.Queued | row.HeldQuietHours -> Ok(0)
    row.Accepted -> Ok(1)
    row.Delivered -> Ok(2)
    row.Opened -> Ok(3)
    row.Actioned -> Ok(4)
    row.Skipped | row.Failed | row.Retrying -> Error(Nil)
  }
}

/// Whether `status` is on the ladder below `than`.
pub fn below(status: row.Status, than: row.Status) -> Bool {
  case rank(status), rank(than) {
    Ok(a), Ok(b) -> a < b
    _, _ -> False
  }
}

/// Whether `status` is on the ladder at or below `than`.
pub fn at_most(status: row.Status, than: row.Status) -> Bool {
  case rank(status), rank(than) {
    Ok(a), Ok(b) -> a <= b
    _, _ -> False
  }
}

pub fn create(tx: Tx, new: row.New) -> Result(Nil, Fail(e)) {
  row.insert(tx, new)
}

fn select(where: String) -> String {
  "SELECT " <> row.columns <> " FROM dispatches " <> where
}

fn with_attempts(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Dispatch), Fail(e)) {
  use attempts <- result.map(store.query(
    read,
    "SELECT "
      <> attempt_row.columns
      <> " FROM dispatch_attempts WHERE dispatch_seq IN (SELECT value FROM json_each(?)) ORDER BY dispatch_seq, seq",
    [
      json.array(list.map(rows, fn(r) { r.seq }), json.int)
      |> json.to_string
      |> sqlight.text,
    ],
    attempt_row.decoder(),
  ))
  let by_dispatch =
    list.group(attempts, fn(a) { a.dispatch_seq })
    |> dict.map_values(fn(_, xs) { list.reverse(xs) })
  list.map(rows, fn(r) {
    Dispatch(r, dict.get(by_dispatch, r.seq) |> result.unwrap([]))
  })
}

fn many(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Dispatch), Fail(e)) {
  use rows <- result.try(store.query(read, select(where), args, row.decoder()))
  with_attempts(read, rows)
}

pub fn by_id(
  read: Read,
  id: id.DispatchId,
) -> Result(Option(Dispatch), Fail(e)) {
  many(read, "WHERE id = ?", [id.dispatch_sql(id)])
  |> result.map(fn(ds) { list.first(ds) |> option.from_result })
}

/// Every dispatch of one notification, in creation order.
pub fn for_notification(
  read: Read,
  notification_id: id.NotificationId,
) -> Result(List(Dispatch), Fail(e)) {
  many(read, "WHERE notification_id = ? ORDER BY seq", [
    id.notification_sql(notification_id),
  ])
}

pub fn by_provider_message_id(
  read: Read,
  id: String,
) -> Result(Option(Dispatch), Fail(e)) {
  many(read, "WHERE provider_message_id = ?", [sqlight.text(id)])
  |> result.map(fn(ds) { list.first(ds) |> option.from_result })
}

/// The external sends due at `at` (queued, retrying or held for quiet hours), in creation order.
pub fn due(read: Read, at: Int) -> Result(List(Dispatch), Fail(e)) {
  many(
    read,
    "WHERE status IN ('queued', 'retrying', 'held_quiet_hours') AND next_at <= ? ORDER BY seq",
    [sqlight.int(at)],
  )
}

/// The in-app dispatches not yet opened whose notification was read.
pub fn unopened_in_app_read(read: Read) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.qualified("d")
      <> " FROM dispatches d JOIN notifications n ON n.id = d.notification_id WHERE d.channel = 'in_app' AND d.opened_at IS NULL AND n.read = 1 ORDER BY d.seq",
    [],
    row.decoder(),
  )
}

/// One organisation's staff dispatches, newest first, keyed by `seq`.
pub fn page_for_org(
  read: Read,
  org_id: id.OrgId,
  page: Page,
) -> Result(#(List(Dispatch), Option(String)), Fail(e)) {
  let #(after, args) = case page.after {
    Some([IntKey(seq)]) -> #(" AND seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.try(store.query(
    read,
    select("WHERE org_id = ?" <> after <> " ORDER BY seq DESC LIMIT ?"),
    list.flatten([[id.org_sql(org_id)], args, [sqlight.int(page.limit + 1)]]),
    row.decoder(),
  ))
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(r) { [IntKey(r.seq)] })
  use dispatches <- result.map(with_attempts(read, items))
  #(dispatches, next)
}

/// The newest `limit` dispatches, newest first.
pub fn recent(read: Read, limit: Int) -> Result(List(Dispatch), Fail(e)) {
  many(read, "ORDER BY seq DESC LIMIT ?", [sqlight.int(limit)])
}

/// How many dispatches are in each status; a status with none is absent.
pub fn counts_by_status(read: Read) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT status, COUNT(*) FROM dispatches GROUP BY status ORDER BY status",
    [],
    {
      use s <- decode.field(0, decode.string)
      use n <- decode.field(1, decode.int)
      decode.success(#(s, n))
    },
  )
}

/// Dispatches waiting on the provider: queued or retrying.
pub fn backlog_count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM dispatches WHERE status IN ('queued', 'retrying')",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

pub type Attempt {
  Sent(ok: Bool, error: Option(String))
  QuietRecheck(note: String)
}

/// One attempt at the next position. Returns how many sends the dispatch has made, this one included.
pub fn record_attempt(
  tx: Tx,
  d: row.Row,
  attempt: Attempt,
  at: Int,
) -> Result(Int, Fail(e)) {
  let read = store.reading(tx)
  use position <- result.try(
    store.one(
      read,
      "SELECT COALESCE(MAX(seq) + 1, 0) FROM dispatch_attempts WHERE dispatch_seq = ?",
      [sqlight.int(d.seq)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  let base = attempt_row.new(d.seq, position, attempt_row.Send, at)
  use _ <- result.try(
    attempt_row.insert(tx, case attempt {
      Sent(ok, error) -> attempt_row.Row(..base, ok: Some(ok), error:)
      QuietRecheck(note) ->
        attempt_row.Row(
          ..base,
          kind: attempt_row.QuietRecheck,
          note: Some(note),
        )
    }),
  )
  store.one(
    read,
    "SELECT COUNT(*) FROM dispatch_attempts WHERE dispatch_seq = ? AND kind = 'send'",
    [sqlight.int(d.seq)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// A change to the fields that move after creation, as column assignments.
pub type Change {
  Status(row.Status)
  ProviderMessageId(String)
  NextAt(Int)
  DeliveredAt(Int)
  OpenedAt(Int)
  ActionedAt(Int)
  FailedAt(Int)
  FailReason(String)
}

pub fn patch(
  tx: Tx,
  id: id.DispatchId,
  changes: List(Change),
) -> Result(Nil, Fail(e)) {
  case changes {
    [] -> Ok(Nil)
    _ -> {
      let sets =
        list.map(changes, fn(c) {
          case c {
            Status(s) -> #("status", sqlight.text(row.status_to_string(s)))
            ProviderMessageId(p) -> #("provider_message_id", sqlight.text(p))
            NextAt(t) -> #("next_at", sqlight.int(t))
            DeliveredAt(t) -> #("delivered_at", sqlight.int(t))
            OpenedAt(t) -> #("opened_at", sqlight.int(t))
            ActionedAt(t) -> #("actioned_at", sqlight.int(t))
            FailedAt(t) -> #("failed_at", sqlight.int(t))
            FailReason(r) -> #("fail_reason", sqlight.text(r))
          }
        })
      store.run(
        tx,
        "UPDATE dispatches SET "
          <> string.join(list.map(sets, fn(s) { s.0 <> " = ?" }), ", ")
          <> " WHERE id = ?",
        list.append(list.map(sets, fn(s) { s.1 }), [id.dispatch_sql(id)]),
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------- views

/// A dispatch as the club and the admin see it; the attempts as outcomes and times.
pub fn view(d: Dispatch) -> Json {
  let r = d.row
  let opt_s = json.nullable(_, json.string)
  let opt_i = json.nullable(_, json.int)
  json.object([
    #("id", id.dispatch_json(r.id)),
    #("notificationId", id.notification_json(r.notification_id)),
    #(
      "audience",
      json.object([
        #("kind", audience.to_json(r.audience_kind)),
        #("id", json.string(r.audience_id)),
      ]),
    ),
    #("orgId", json.nullable(r.org_id, id.org_json)),
    #("channel", row.channel_to_json(r.channel)),
    #("to", opt_s(r.to_address)),
    #("provider", row.provider_to_json(r.provider)),
    #("status", row.status_to_json(r.status)),
    #("skipReason", opt_s(r.skip_reason)),
    #("providerMessageId", opt_s(r.provider_message_id)),
    #(
      "attempts",
      json.array(d.attempts, fn(a) {
        case a.kind {
          attempt_row.QuietRecheck ->
            json.object([
              #("at", json.int(a.attempted_at)),
              #("note", opt_s(a.note)),
            ])
          attempt_row.Send ->
            json.object([
              #("at", json.int(a.attempted_at)),
              #("ok", json.bool(a.ok == Some(True))),
              #("error", opt_s(a.error)),
            ])
        }
      }),
    ),
    #("nextAt", json.int(r.next_at)),
    #("actionDeadline", opt_i(r.action_deadline_at)),
    #("createdAt", json.int(r.created_at)),
    #("deliveredAt", opt_i(r.delivered_at)),
    #("openedAt", opt_i(r.opened_at)),
    #("actionedAt", opt_i(r.actioned_at)),
    #("failedAt", opt_i(r.failed_at)),
    #("failReason", opt_s(r.fail_reason)),
  ])
}
