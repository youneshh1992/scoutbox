//// Conflict-of-interest declarations (`ver_conflicts`): a staff member declares a relationship that bears on their
//// work, and may withdraw it. A declaration is a disclosure, not a verdict.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/ver_conflicts as row
import sqlight

pub type Conflict =
  row.Row

fn where(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
) -> Result(List(Conflict), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ver_conflicts WHERE "
      <> sql
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  )
}

/// A user's declarations still in force.
pub fn active_for_user(
  read: Read,
  user_id: String,
) -> Result(List(Conflict), Fail(e)) {
  where(read, "user_id = ? AND withdrawn_at IS NULL", [sqlight.text(user_id)])
}

pub fn for_org(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(Conflict), Fail(e)) {
  where(read, "org_id = ?", [id.org_sql(org_id)])
}

pub fn for_org_user(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Result(List(Conflict), Fail(e)) {
  where(read, "org_id = ? AND user_id = ?", [
    id.org_sql(org_id),
    id.org_user_sql(user_id),
  ])
}

pub fn by_id(read: Read, id: String) -> Result(Option(Conflict), Fail(e)) {
  where(read, "id = ?", [sqlight.text(id)])
  |> result.map(fn(rows) {
    case rows {
      [c, ..] -> option.Some(c)
      [] -> option.None
    }
  })
}

pub fn create(tx: Tx, c: Conflict) -> Result(Nil, Fail(e)) {
  store.run(tx, row.insert_sql, row.values(c))
}

/// Withdraws a declaration in force. False when it was already withdrawn.
pub fn withdraw(tx: Tx, id: id.ConflictId, at: Int) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE ver_conflicts SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL RETURNING 1",
    [sqlight.int(at), id.conflict_sql(id)],
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

pub fn record(c: Conflict) -> Json {
  json.object([
    #("id", id.conflict_json(c.id)),
    #("userId", id.org_user_json(c.user_id)),
    #("orgId", id.org_json(c.org_id)),
    #("kind", row.kind_to_json(c.kind)),
    #("subject", json.string(c.subject)),
    #("note", json.string(c.note)),
    #("createdAt", json.int(c.created_at)),
    #("withdrawnAt", json.nullable(c.withdrawn_at, json.int)),
  ])
}
