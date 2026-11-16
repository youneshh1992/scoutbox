//// A player's opportunity board (domains/scouting/views.mjs `opportunityBoardFor`), shared by the player and the
//// Agent workspace: what is open to them, read through mutual visibility, with distance as a band and never a
//// location.
////
//// Not ported yet: club opportunities (`opportunities`, their eligibility and applications) — no route here creates
//// one and the seed has none, so the board holds the grassroots open days only.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/distance
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/open_trials as trial_row
import sqlight

/// One row of the board.
pub type Item {
  OpenDay(
    trial: trial_row.Row,
    org_name: String,
    distance: Option(String),
    registered: Bool,
  )
}

pub fn deadline(item: Item) -> String {
  case item {
    OpenDay(trial:, ..) -> trial.trial_date
  }
}

pub fn item_id(item: Item) -> String {
  case item {
    OpenDay(trial:, ..) -> id.open_trial_to_string(trial.id)
  }
}

/// Distance shown as a band (routeHelpers.mjs `distanceBand`).
fn band(km: Option(Float)) -> Option(String) {
  option.map(km, fn(km) {
    case km {
      _ if km <=. 5.0 -> "under 5 km"
      _ if km <=. 15.0 -> "5–15 km"
      _ if km <=. 30.0 -> "15–30 km"
      _ if km <=. 50.0 -> "30–50 km"
      _ -> "over 50 km"
    }
  })
}

/// The board, by deadline.
pub fn for_player(
  read: Read,
  p: Player,
  now: Int,
) -> Result(List(Item), Fail(e)) {
  let today = clock.iso_day(now)
  let km = case p.row.lat, p.row.lng {
    Some(lat), Some(lng) ->
      distance.km(distance.Columns("o.lat", "o.lng"), distance.At(lat, lng))
    _, _ -> sql.text("NULL")
  }
  let q =
    sql.concat([
      sql.text("SELECT " <> trial_row.qualified("t") <> ", "),
      km,
      sql.text(
        ", EXISTS (SELECT 1 FROM open_trial_registrations r WHERE r.open_trial_id = t.id AND r.player_id = ",
      ),
      sql.arg(id.player_sql(p.row.id)),
      sql.text(
        ") FROM open_trials t JOIN orgs o ON o.id = t.org_id WHERE t.deleted_at IS NULL AND t.trial_date >= ",
      ),
      sql.arg(sqlight.text(today)),
      sql.text(" ORDER BY t.trial_date, t.id"),
    ])
  use rows <- result.try(
    store.query(read, q.sql, q.args, {
      use t <- decode.then(trial_row.decoder())
      use km <- decode.field(trial_row.width, decode.optional(decode.float))
      use registered <- decode.field(trial_row.width + 1, decode.int)
      decode.success(#(t, km, registered == 1))
    }),
  )
  use items <- result.map(
    list.try_map(rows, fn(row) {
      let #(t, km, registered) = row
      use org <- result.try(orgs.by_id(read, t.org_id))
      case org {
        Some(org) if !org.suspended -> {
          use seen <- result.map(players.for_org(read, p.row.id, org, now))
          case seen {
            Some(#(_, access)) if access.visible && !access.blocked -> [
              OpenDay(t, org.name, band(km), registered),
            ]
            _ -> []
          }
        }
        _ -> Ok([])
      }
    }),
  )
  list.flatten(items)
  |> list.sort(fn(a, b) { string.compare(deadline(a), deadline(b)) })
}

/// The player's own view of a row.
pub fn fields(item: Item) -> List(#(String, Json)) {
  case item {
    OpenDay(trial:, org_name:, distance:, registered:) -> [
      #("id", id.open_trial_json(trial.id)),
      #("via", json.string("open_trial")),
      #("type", json.string("open_day")),
      #("orgId", id.org_json(trial.org_id)),
      #("orgName", json.string(org_name)),
      #("title", json.string(trial.title)),
      #("deadline", json.string(trial.trial_date)),
      #("schedule", json.string(trial.trial_date)),
      #("category", json.string("mixed")),
      #("distance", json.nullable(distance, json.string)),
      #("applied", case registered {
        True -> json.object([#("status", json.string("registered"))])
        False -> json.null()
      }),
      #("note", json.string("Registered through the open-day flow.")),
    ]
  }
}

/// The Agent workspace's projection of a row: `with_schedule` for one client's board.
pub fn agent_fields(item: Item, with_schedule: Bool) -> List(#(String, Json)) {
  let all = fields(item)
  let keys = case with_schedule {
    True -> [
      "id", "via", "type", "orgId", "orgName", "title", "deadline", "schedule",
      "category", "distance", "applied",
    ]
    False -> [
      "id", "via", "type", "orgId", "orgName", "title", "deadline", "category",
      "distance", "applied",
    ]
  }
  list.filter_map(keys, fn(k) {
    list.key_find(all, k) |> result.map(fn(v) { #(k, v) })
  })
}
