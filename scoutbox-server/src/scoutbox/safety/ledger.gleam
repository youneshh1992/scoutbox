//// The Discovery Ledger (`ledger`): append-only. `user_id` and `actor_name` are stored exactly as the act names
//// them, so the record stays attributable after the account is removed.

import gleam/option.{type Option}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/store.{type Fail, type Tx}
import sqlight

/// The ledger types this server writes so far. The table's CHECK lists every type the product has.
pub type Type {
  StaffRemoved
}

fn type_name(t: Type) -> String {
  case t {
    StaffRemoved -> "staff_removed"
  }
}

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
  store.run(
    tx,
    "INSERT INTO ledger (id, occurred_at, type, player_id, org_id, org_name, user_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sqlight.text(id),
      sqlight.int(at),
      sqlight.text(type_name(entry.entry_type)),
      sqlight.nullable(sqlight.text, entry.player_id),
      sqlight.nullable(sqlight.text, entry.org_id),
      sqlight.nullable(sqlight.text, entry.org_name),
      sqlight.nullable(sqlight.text, entry.user_id),
      sqlight.nullable(sqlight.text, entry.actor_name),
    ],
  )
}
