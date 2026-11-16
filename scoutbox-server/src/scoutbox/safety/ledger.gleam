//// The Discovery Ledger (`ledger`): append-only. `user_id` and `actor_name` are stored exactly as the act names
//// them, so the record stays attributable after the account is removed.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/ledger as row
import sqlight

pub type Type =
  row.Type

pub type Entry {
  Entry(
    entry_type: Type,
    player_id: Option(String),
    org_id: Option(String),
    org_name: Option(String),
    user_id: Option(String),
    actor_name: Option(String),
  )
}

/// Appends an entry and returns its id.
pub fn append(tx: Tx, entry: Entry, at: Int) -> Result(String, Fail(e)) {
  use id <- result.try(ids.next(tx, "led"))
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
  org_id: String,
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  rows_page(read, "org_id = ?", [sqlight.text(org_id)], page)
}

/// A page of these players' ledger, newest first: a guardian's log of their children.
pub fn page_for_players(
  read: Read,
  player_ids: List(String),
  page: Page,
) -> Result(#(List(row.Row), Option(String)), Fail(e)) {
  rows_page(
    read,
    "player_id IN (SELECT value FROM json_each(?))",
    [json.array(player_ids, json.string) |> json.to_string |> sqlight.text],
    page,
  )
}

/// One player's ledger, oldest first.
pub fn for_player(
  read: Read,
  player_id: String,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM ledger WHERE player_id = ? ORDER BY seq",
    [sqlight.text(player_id)],
    row.decoder(),
  )
}

/// The players a club shortlisted, in the order it first did.
pub fn shortlisted_by(
  read: Read,
  org_id: String,
) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist' AND player_id IS NOT NULL GROUP BY player_id ORDER BY MIN(seq)",
    [sqlight.text(org_id)],
    decode.at([0], decode.string),
  )
}

/// One club's events counted for each type that starts with `prefix` (`view` also counts `view_*` types).
pub fn count_for_org(
  read: Read,
  org_id: String,
  prefix: String,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM ledger WHERE org_id = ? AND substr(type, 1, length(?)) = ?",
    [sqlight.text(org_id), sqlight.text(prefix), sqlight.text(prefix)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// One club's busiest actors, most events first (ties: who acted first), at most `n`.
pub fn top_actors_for_org(
  read: Read,
  org_id: String,
  n: Int,
) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT actor_name, COUNT(*) AS events FROM ledger WHERE org_id = ? AND actor_name IS NOT NULL AND actor_name <> '' GROUP BY actor_name ORDER BY events DESC, MIN(seq) LIMIT ?",
    [sqlight.text(org_id), sqlight.int(n)],
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
    #("id", json.string(l.id)),
    #("ts", json.int(l.occurred_at)),
    #("type", json.string(row.type_to_string(l.type_))),
    #("playerId", opt(l.player_id)),
    #("orgId", opt(l.org_id)),
    #("orgName", opt(l.org_name)),
    #("userId", opt(l.user_id)),
    #("scoutName", opt(l.actor_name)),
    #("detail", json.null()),
  ])
}

/// An organisation's whole ledger, oldest first: its audit export.
pub fn all_for_org(
  read: Read,
  org_id: String,
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM ledger WHERE org_id = ? ORDER BY seq",
    [sqlight.text(org_id)],
    row.decoder(),
  )
}
