//// The Discovery Ledger (`ledger`): append-only. `user_id` and `actor_name` are stored exactly as the act names
//// them, so the record stays attributable after the account is removed.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/ledger as row
import sqlight

pub type Type =
  row.Type

pub type Entry {
  Entry(
    entry_type: Type,
    player_id: Option(id.PlayerId),
    org_id: Option(id.OrgId),
    org_name: Option(String),
    user_id: Option(id.OrgUserId),
    actor_name: Option(String),
  )
}

/// Appends an entry and returns its id.
pub fn append(
  tx: Tx,
  entry: Entry,
  at: Int,
) -> Result(id.LedgerEntryId, Fail(e)) {
  use id <- result.try(id.next_ledger_entry(tx))
  use _ <- result.map(row.insert(
    tx,
    row.New(
      ..row.new(id:, occurred_at: at, type_: entry.entry_type),
      player_id: entry.player_id,
      org_id: entry.org_id,
      org_name: entry.org_name,
      user_id: entry.user_id,
      actor_name: entry.actor_name,
    ),
  ))
  id
}

// ----------------------------------------------------------------------------------------------- reads

fn rows_page(
  read: Read,
  where: String,
  args: List(sqlight.Value),
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  let #(after, after_args) = case page.after {
    Some([IntKey(seq)]) -> #(" AND seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ledger WHERE "
      <> where
      <> after
      <> " ORDER BY seq DESC LIMIT ?",
    list.flatten([args, after_args, [sqlight.int(page.limit + 1)]]),
    row.decoder(),
  ))
  paging.page_of(rows, page.limit, fn(r) { [IntKey(r.seq)] })
}

/// A page of one club's ledger, newest first.
pub fn page_for_org(
  read: Read,
  org_id: id.OrgId,
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  rows_page(read, "org_id = ?", [id.org_sql(org_id)], page)
}

/// A page of these players' ledger, newest first: a guardian's log of their children.
pub fn page_for_players(
  read: Read,
  player_ids: List(id.PlayerId),
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  rows_page(
    read,
    "player_id IN (SELECT value FROM json_each(?))",
    [json.array(player_ids, id.player_json) |> json.to_string |> sqlight.text],
    page,
  )
}

/// One player's ledger, oldest first.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM ledger WHERE player_id = ? ORDER BY seq",
    [id.player_sql(player_id)],
    row.decoder(),
  )
}

/// One player's ledger with one organisation, oldest first: what a Proof Pack lists.
pub fn for_player_org(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ledger WHERE player_id = ? AND org_id = ? ORDER BY seq",
    [id.player_sql(player_id), id.org_sql(org_id)],
    row.decoder(),
  )
}

/// The players a club shortlisted, in the order it first did.
pub fn shortlisted_by(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist' AND player_id IS NOT NULL GROUP BY player_id ORDER BY MIN(seq)",
    [id.org_sql(org_id)],
    decode.at([0], id.player_decoder()),
  )
}

/// One club's events counted for each type that starts with `prefix` (`view` also counts `view_*` types).
pub fn count_for_org(
  read: Read,
  org_id: id.OrgId,
  prefix: String,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM ledger WHERE org_id = ? AND substr(type, 1, length(?)) = ?",
    [id.org_sql(org_id), sqlight.text(prefix), sqlight.text(prefix)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// One club's busiest actors, most events first (ties: who acted first), at most `n`.
pub fn top_actors_for_org(
  read: Read,
  org_id: id.OrgId,
  n: Int,
) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT actor_name, COUNT(*) AS events FROM ledger WHERE org_id = ? AND actor_name IS NOT NULL AND actor_name <> '' GROUP BY actor_name ORDER BY events DESC, MIN(seq) LIMIT ?",
    [id.org_sql(org_id), sqlight.int(n)],
    {
      use name <- decode.field(0, decode.string)
      use events <- decode.field(1, decode.int)
      decode.success(#(name, events))
    },
  )
}

/// A ledger row as the organisation, the player or the guardian reads it.
///
/// Not ported yet: `detail` carries the box, combine, passport and verification events' details, from domains
/// this server does not run; no event it writes has one.
pub fn view(l: row.Row) -> Json {
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", id.ledger_entry_json(l.id)),
    #("ts", json.int(l.occurred_at)),
    #("type", row.type_to_json(l.type_)),
    #("playerId", json.nullable(l.player_id, id.player_json)),
    #("orgId", json.nullable(l.org_id, id.org_json)),
    #("orgName", opt(l.org_name)),
    #("userId", json.nullable(l.user_id, id.org_user_json)),
    #("scoutName", opt(l.actor_name)),
    #("detail", json.null()),
  ])
}

/// An organisation's whole ledger, oldest first: its audit export.
pub fn all_for_org(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM ledger WHERE org_id = ? ORDER BY seq",
    [id.org_sql(org_id)],
    row.decoder(),
  )
}
