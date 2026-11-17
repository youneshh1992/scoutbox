//// Second Look's stored workflow (repositories/discovery.mjs `secondLook`): which item an organisation reviewed,
//// dismissed or acted on, one per decision cycle of a Room. It owns no player truth: what changed is derived from
//// the source records on every read (`second_look`).

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/second_look_item_fingerprints as fingerprint_row
import scoutbox/rows/second_look_item_history as history_row
import scoutbox/rows/second_look_item_reasons as reason_row
import scoutbox/rows/second_look_items as row
import sqlight

pub type Item {
  Item(
    row: row.Row,
    fingerprints: List(String),
    direct_reason_codes: List(String),
    history: List(history_row.Row),
  )
}

fn children(
  read: Read,
  table: String,
  columns: String,
  decoder: decode.Decoder(a),
  item_id: id.SecondLookItemId,
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE item_id = ? ORDER BY ord",
    [id.second_look_item_sql(item_id)],
    decoder,
  )
}

fn load(read: Read, rows: List(row.Row)) -> Result(List(Item), Fail(e)) {
  list.try_map(rows, fn(r) {
    use fps <- result.try(children(
      read,
      fingerprint_row.table,
      fingerprint_row.columns,
      fingerprint_row.decoder(),
      r.id,
    ))
    use reasons <- result.try(children(
      read,
      reason_row.table,
      reason_row.columns,
      reason_row.decoder(),
      r.id,
    ))
    use history <- result.map(children(
      read,
      history_row.table,
      history_row.columns,
      history_row.decoder(),
      r.id,
    ))
    Item(
      row: r,
      fingerprints: list.map(fps, fn(f) { f.fingerprint }),
      direct_reason_codes: list.map(reasons, fn(c) {
        reason_row.code_to_string(c.code)
      }),
      history:,
    )
  })
}

fn first(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(Option(Item), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM second_look_items WHERE " <> where,
    args,
    row.decoder(),
  ))
  use items <- result.map(load(read, rows))
  list.first(items) |> option.from_result
}

/// The item of one decision cycle of one room, or None.
pub fn by_key(
  read: Read,
  org_id: id.OrgId,
  room_id: id.RecruitmentCaseId,
  decision_id: id.RoomDecisionId,
) -> Result(Option(Item), Fail(e)) {
  first(read, "org_id = ? AND room_id = ? AND decision_id = ?", [
    id.org_sql(org_id),
    id.recruitment_case_sql(room_id),
    id.room_decision_sql(decision_id),
  ])
}

/// This organisation's item, or None: another organisation's id is no item.
pub fn for_org_by_id(
  read: Read,
  item_id: id.SecondLookItemId,
  org_id: id.OrgId,
) -> Result(Option(Item), Fail(e)) {
  first(read, "id = ? AND org_id = ?", [
    id.second_look_item_sql(item_id),
    id.org_sql(org_id),
  ])
}

pub fn by_id(
  read: Read,
  item_id: id.SecondLookItemId,
) -> Result(Option(Item), Fail(e)) {
  first(read, "id = ?", [id.second_look_item_sql(item_id)])
}

// ------------------------------------------------------------------------------------------------------ writes

/// The changes an item stands for, rewritten whenever they move on.
pub type Refresh {
  Refresh(
    fingerprints: List(String),
    direct_reason_codes: List(String),
    trigger_type: row.TriggerType,
    latest_change_at: Int,
  )
}

fn write_children(
  tx: Tx,
  item_id: id.SecondLookItemId,
  r: Refresh,
) -> Result(Nil, Fail(e)) {
  let sql_id = [id.second_look_item_sql(item_id)]
  use _ <- result.try(store.run(
    tx,
    "DELETE FROM second_look_item_fingerprints WHERE item_id = ?",
    sql_id,
  ))
  use _ <- result.try(store.run(
    tx,
    "DELETE FROM second_look_item_reasons WHERE item_id = ?",
    sql_id,
  ))
  use _ <- result.try(
    list.index_map(r.fingerprints, fn(fingerprint, ord) {
      fingerprint_row.Row(item_id:, ord:, fingerprint:)
    })
    |> list.try_each(fingerprint_row.insert(tx, _)),
  )
  list.index_map(r.direct_reason_codes, fn(code, ord) { #(code, ord) })
  |> list.try_each(fn(pair) {
    // A direct reason is one of the decision's own codes that the reason map names, so it is in the vocabulary.
    let assert Ok(code) = reason_row.code_from_string(pair.0)
    reason_row.insert(tx, reason_row.Row(item_id:, ord: pair.1, code:))
  })
}

fn append_history(
  tx: Tx,
  item: Item,
  at: Int,
  action: history_row.Action,
  by: Option(#(id.OrgUserId, String)),
  reason: Option(history_row.Reason),
) -> Result(Nil, Fail(e)) {
  history_row.insert(
    tx,
    history_row.Row(
      item_id: item.row.id,
      ord: list.length(item.history),
      at:,
      action:,
      by_user_id: option.map(by, fn(b) { b.0 }),
      by_name: option.map(by, fn(b) { b.1 }),
      reason:,
    ),
  )
}

fn reread(tx: Tx, item_id: id.SecondLookItemId) -> Result(Item, Fail(e)) {
  use found <- result.map(by_id(store.reading(tx), item_id))
  let assert Some(item) = found
  item
}

pub type NewItem {
  NewItem(
    org_id: id.OrgId,
    player_id: id.PlayerId,
    room_id: id.RecruitmentCaseId,
    decision_id: id.RoomDecisionId,
    policy_version: Int,
    refresh: Refresh,
    at: Int,
  )
}

/// A new open item, surfaced by nobody.
pub fn create(tx: Tx, n: NewItem) -> Result(Item, Fail(e)) {
  use item_id <- result.try(id.next_second_look_item(tx))
  let r =
    row.new(
      id: item_id,
      org_id: n.org_id,
      player_id: n.player_id,
      room_id: n.room_id,
      decision_id: n.decision_id,
      policy_version: n.policy_version,
      trigger_type: n.refresh.trigger_type,
      status: row.Open,
      created_at: n.at,
      updated_at: n.at,
      latest_change_at: n.refresh.latest_change_at,
    )
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(write_children(tx, item_id, n.refresh))
  use _ <- result.try(append_history(
    tx,
    Item(r, [], [], []),
    n.at,
    history_row.Surfaced,
    None,
    None,
  ))
  reread(tx, item_id)
}

fn set_refresh(
  tx: Tx,
  item: Item,
  r: Refresh,
  status: row.Status,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE second_look_items SET status = ?, trigger_type = ?, latest_change_at = ?, updated_at = ? WHERE id = ?",
      [
        sqlight.text(row.status_to_string(status)),
        sqlight.text(row.trigger_type_to_string(r.trigger_type)),
        sqlight.int(r.latest_change_at),
        sqlight.int(at),
        id.second_look_item_sql(item.row.id),
      ],
    ),
  )
  write_children(tx, item.row.id, r)
}

/// New changes on a handled item open it again, with the reason (expired at once if they have lapsed by `at`).
pub fn resurface(
  tx: Tx,
  item: Item,
  r: Refresh,
  at: Int,
  expired: Bool,
) -> Result(Item, Fail(e)) {
  let status = case expired {
    True -> row.Expired
    False -> row.Open
  }
  use _ <- result.try(set_refresh(tx, item, r, status, at))
  use _ <- result.try(append_history(
    tx,
    item,
    at,
    history_row.Resurfaced,
    None,
    Some(history_row.MateriallyNewEvidence),
  ))
  reread(tx, item.row.id)
}

/// The changes an open item stands for moved on.
pub fn refresh(
  tx: Tx,
  item: Item,
  r: Refresh,
  at: Int,
  expired: Bool,
) -> Result(Item, Fail(e)) {
  let status = case expired {
    True -> row.Expired
    False -> item.row.status
  }
  use _ <- result.try(set_refresh(tx, item, r, status, at))
  reread(tx, item.row.id)
}

/// The item lapsed at `at`.
pub fn expire(tx: Tx, item: Item, at: Int) -> Result(Item, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE second_look_items SET status = 'expired', updated_at = ? WHERE id = ?",
      [sqlight.int(at), id.second_look_item_sql(item.row.id)],
    ),
  )
  reread(tx, item.row.id)
}

/// Someone in the organisation acted on the item: `reviewed`, `dismissed` (with its reason) or `reopened_room`.
fn stamp(
  tx: Tx,
  item: Item,
  status: row.Status,
  stamp: String,
  by: #(id.OrgUserId, String),
  at: Int,
  reason: Option(row.DismissReason),
) -> Result(Item, Fail(e)) {
  let #(dismiss_sql, dismiss_args) = case status {
    row.Dismissed -> #(", dismiss_reason = ?", [
      case reason {
        Some(r) -> sqlight.text(row.dismiss_reason_to_string(r))
        None -> sqlight.null()
      },
    ])
    _ -> #("", [])
  }
  use _ <- result.try(store.run(
    tx,
    "UPDATE second_look_items SET status = ?, "
      <> stamp
      <> "_at = ?, "
      <> stamp
      <> "_by_user_id = ?, "
      <> stamp
      <> "_by_name = ?"
      <> dismiss_sql
      <> ", updated_at = ? WHERE id = ?",
    list.flatten([
      [
        sqlight.text(row.status_to_string(status)),
        sqlight.int(at),
        id.org_user_sql(by.0),
        sqlight.text(by.1),
      ],
      dismiss_args,
      [sqlight.int(at), id.second_look_item_sql(item.row.id)],
    ]),
  ))
  let action = case status {
    row.Reviewed -> history_row.Reviewed
    row.Dismissed -> history_row.Dismissed
    _ -> history_row.ReopenedRoom
  }
  let history_reason = case status, reason {
    row.Dismissed, Some(r) ->
      history_row.reason_from_string(row.dismiss_reason_to_string(r))
      |> option.from_result
    _, _ -> None
  }
  use _ <- result.try(append_history(
    tx,
    item,
    at,
    action,
    Some(by),
    history_reason,
  ))
  reread(tx, item.row.id)
}

pub fn review(
  tx: Tx,
  item: Item,
  by: #(id.OrgUserId, String),
  at: Int,
) -> Result(Item, Fail(e)) {
  stamp(tx, item, row.Reviewed, "reviewed", by, at, None)
}

pub fn dismiss(
  tx: Tx,
  item: Item,
  by: #(id.OrgUserId, String),
  at: Int,
  reason: Option(row.DismissReason),
) -> Result(Item, Fail(e)) {
  stamp(tx, item, row.Dismissed, "dismissed", by, at, reason)
}

/// The organisation reopened the Room from the item.
pub fn mark_room_reopened(
  tx: Tx,
  item: Item,
  by: #(id.OrgUserId, String),
  at: Int,
) -> Result(Item, Fail(e)) {
  stamp(tx, item, row.ReopenedRoom, "reopened", by, at, None)
}

// ------------------------------------------------------------------------------------------------------- views

fn person(user: Option(id.OrgUserId), name: Option(String)) -> Json {
  case user {
    Some(u) ->
      json.object([
        #("userId", id.org_user_json(u)),
        #("name", json.nullable(name, json.string)),
      ])
    None -> json.null()
  }
}

/// The item as stored (storedView).
pub fn stored_view(i: Item) -> List(#(String, Json)) {
  let r = i.row
  [
    #("id", id.second_look_item_json(r.id)),
    #("playerId", id.player_json(r.player_id)),
    #("roomId", id.recruitment_case_json(r.room_id)),
    #("decisionId", id.room_decision_json(r.decision_id)),
    #("policyVersion", json.int(r.policy_version)),
    #("triggerType", row.trigger_type_to_json(r.trigger_type)),
    #("changeFingerprints", json.array(i.fingerprints, json.string)),
    #("directReasonCodes", json.array(i.direct_reason_codes, json.string)),
    #("status", row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #("updatedAt", json.int(r.updated_at)),
    #("latestChangeAt", json.int(r.latest_change_at)),
    #("reviewedAt", json.nullable(r.reviewed_at, json.int)),
    #("reviewedBy", person(r.reviewed_by_user_id, r.reviewed_by_name)),
    #("dismissedAt", json.nullable(r.dismissed_at, json.int)),
    #("dismissedBy", person(r.dismissed_by_user_id, r.dismissed_by_name)),
    #(
      "dismissReason",
      json.nullable(r.dismiss_reason, row.dismiss_reason_to_json),
    ),
    #("reopenedAt", json.nullable(r.reopened_at, json.int)),
    #("reopenedBy", person(r.reopened_by_user_id, r.reopened_by_name)),
    #("history", json.array(i.history, history_json)),
  ]
}

fn history_json(h: history_row.Row) -> Json {
  json.object(
    list.append(
      [
        #("at", json.int(h.at)),
        #("action", history_row.action_to_json(h.action)),
        #("by", person(h.by_user_id, h.by_name)),
      ],
      case h.action {
        history_row.Resurfaced | history_row.Dismissed -> [
          #("reason", json.nullable(h.reason, history_row.reason_to_json)),
        ]
        _ -> []
      },
    ),
  )
}

pub fn person_json(user: Option(id.OrgUserId), name: Option(String)) -> Json {
  person(user, name)
}
