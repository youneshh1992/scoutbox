//// Rows for the store-backed recruitment tests (evidence_test, journey_test): two clubs with a staff member each,
//// and INSERTs built from a base row with some columns replaced, so a test names only what its check is about.

import gleam/list
import gleam/string
import scoutbox/platform/store.{type Store}
import scoutbox/support

/// A column and its SQL literal.
pub type Cols =
  List(#(String, String))

/// A text literal.
pub fn q(text: String) -> String {
  "'" <> string.replace(text, "'", "''") <> "'"
}

/// An integer literal.
pub fn n(i: Int) -> String {
  string.inspect(i)
}

/// An INSERT of `base` with `over` replacing (or adding) columns.
pub fn insert(table: String, base: Cols, over: Cols) -> String {
  let cols = list.fold(over, base, fn(acc, c) { list.key_set(acc, c.0, c.1) })
  "INSERT INTO "
  <> table
  <> " ("
  <> string.join(list.map(cols, fn(c) { c.0 }), ", ")
  <> ") VALUES ("
  <> string.join(list.map(cols, fn(c) { c.1 }), ", ")
  <> ")"
}

const clubs =
  "INSERT INTO orgs (id, name, type, plan, created_at) VALUES ('o1', 'Club One', 'club', 'Pro', 1), ('o2', 'Club Two', 'club', 'Pro', 1)"

const staff =
  "INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES ('u1', 'o1', 'Lead', 'lead', 'Scout', 1), ('u2', 'o2', 'Other', 'other', 'Scout', 1)"

/// A Room of club o1 (owned by u1) on player p1, opened at `created_at`.
pub fn room_at(case_id: String, status: String, created_at: Int) -> String {
  room(case_id, status, created_at, [])
}

/// A Room of club o1 on player p1, with `over` replacing columns.
pub fn room(case_id: String, status: String, created_at: Int, over: Cols) {
  insert(
    "recruitment_cases",
    [
      #("id", q(case_id)),
      #("org_id", q("o1")),
      #("player_id", q("p1")),
      #("owner_user_id", q("u1")),
      #("stage", q("review")),
      #("priority", q("medium")),
      #("restricted", "0"),
      #("created_at", n(created_at)),
      #("room_status", q(status)),
      #("room_priority", q("normal")),
      #("room_updated_at", n(created_at)),
      #("room_rev", "1"),
    ],
    over,
  )
}

/// A case history entry: its action and its detail as a JSON object.
pub fn history(
  case_id: String,
  position: Int,
  at: Int,
  action: String,
  detail: String,
) -> String {
  "INSERT INTO case_history (case_id, position, id, at, action, detail_json) VALUES ("
  <> string.join(
    [
      q(case_id),
      n(position),
      q(case_id <> "-h" <> n(position)),
      n(at),
      q(action),
      q(detail),
    ],
    ", ",
  )
  <> ")"
}

/// A draft in-app contact of club o1 with player p1 on case k1.
pub fn contact(cid: String, over: Cols) -> String {
  insert(
    "recruitment_contacts",
    [
      #("id", q(cid)),
      #("org_id", q("o1")),
      #("case_id", q("k1")),
      #("player_id", q("p1")),
      #("status", q("draft")),
      #("channel", q("in_app")),
      #("contact_mode", q("player_only")),
      #("body", q("PRIVATE draft body")),
      #("created_by_user_id", q("u1")),
      #("created_at", "1"),
      #("updated_at", "1"),
      #("rev", "1"),
      #("policy_version", "1"),
    ],
    over,
  )
}

/// A contact's columns once it was delivered to the player.
pub const delivered = [
  #("status", "'delivered'"),
  #("recipient_type", "'player'"),
  #("recipient_player_id", "'p1'"),
  #("recipient_minor", "0"),
  #("delivered_at", "1"),
]

/// A fresh store (the demo seed) with the two clubs, their staff and `sql`.
pub fn store_with(sql: List(String)) -> Store {
  let s = support.fresh_store(fn(_) { Nil })
  exec(s, [clubs, staff, ..sql])
  s
}

pub fn exec(s: Store, sql: List(String)) -> Nil {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) { list.try_each(sql, store.run(tx, _, [])) })
  Nil
}
