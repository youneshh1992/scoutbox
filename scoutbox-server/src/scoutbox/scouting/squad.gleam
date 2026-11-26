//// The club's squad list (`org_squad_members`), as other acts join a player to it (scouting/index.mjs
//// `joinSquad`): a player already on it stays as they are.

import gleam/dynamic/decode
import gleam/option.{type Option, Some}
import gleam/result
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/id
import scoutbox/rows/org_squad_members as squad_row

/// The club setup's limit on a squad entry's name.
pub const name_max = 200

pub fn join(
  tx: Tx,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  name: String,
  position: Option(String),
  source: squad_row.Source,
  approved_by: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use present <- result.try(store.query(
    store.reading(tx),
    "SELECT 1 FROM org_squad_members WHERE org_id = ? AND player_id = ?",
    [id.org_sql(org_id), id.player_sql(player_id)],
    decode.success(Nil),
  ))
  case present {
    [_, ..] -> Ok(Nil)
    [] -> {
      use entry <- result.try(id.next_squad_entry(tx))
      squad_row.insert(
        tx,
        squad_row.Row(
          id: entry,
          org_id:,
          player_id: Some(player_id),
          name: input.utf16_take(name, name_max),
          position:,
          source:,
          approved_by_label: approved_by,
          added_at: at,
        ),
      )
    }
  }
}
