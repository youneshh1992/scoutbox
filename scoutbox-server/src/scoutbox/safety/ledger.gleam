//// The Discovery Ledger (`ledger`): append-only. `user_id` and `actor_name` are stored exactly as the act names
//// them, so the record stays attributable after the account is removed.

import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/ledger as row

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

pub fn append(tx: Tx, entry: Entry, at: Int) -> Result(Nil, Fail(e)) {
  use id <- result.try(ids.next(tx, "led"))
  row.insert(
    tx,
    row.New(
      ..row.new(id:, occurred_at: at, type_: entry.entry_type),
      player_id: entry.player_id,
      org_id: entry.org_id,
      org_name: entry.org_name,
      user_id: entry.user_id,
      actor_name: entry.actor_name,
    ),
  )
}
