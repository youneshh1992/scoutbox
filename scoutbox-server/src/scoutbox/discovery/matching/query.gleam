//// The match reads shared by matching, the watchlists and Nobody Missed (domains/discovery/matching/query.mjs): one
//// SQL query over the players an organisation may see, joined to their stored facts, each required criterion a
//// condition beside its test in the engine. Nothing about a player the organisation may not see escapes, not even
//// a count.

import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/discovery/matching/criteria.{type Criterion}
import scoutbox/discovery/matching/engine.{type Facts, Facts}
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/distance.{At, Columns}
import scoutbox/platform/keyset.{Asc, Desc, OrderKey}
import scoutbox/platform/paging.{IntKind, TextKind}
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rules/age
import scoutbox/rules/visibility
import scoutbox/vocab/playing_level.{type PlayingLevel}
import scoutbox/vocab/trust_band.{type TrustBand}
import sqlight

const day_ms = 86_400_000

/// `FROM …` the players the organisation may see that satisfy every required criterion and every `extra` condition.
pub fn from(
  org: Org,
  required: List(Criterion),
  now: Int,
  extra: List(Fragment),
) -> Fragment {
  sql.concat([
    sql.text(
      "players p JOIN player_match_facts f ON f.player_id = p.id WHERE p.deleted_at IS NULL AND ",
    ),
    visibility.can_see_sql(org, now),
    ..list.map(
      list.append(list.map(required, engine.criterion_sql(_, org, now)), extra),
      fn(c) { sql.concat([sql.text(" AND ("), c, sql.text(")")]) },
    )
  ])
}

pub fn count(read: Read, from: Fragment) -> Result(Int, Fail(e)) {
  let q = sql.concat([sql.text("SELECT COUNT(*) FROM "), from])
  store.one(read, q.sql, q.args, decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

/// Every matching player's id, in id order.
pub fn ids(read: Read, from: Fragment) -> Result(List(id.PlayerId), Fail(e)) {
  let q =
    sql.concat([sql.text("SELECT p.id FROM "), from, sql.text(" ORDER BY p.id")])
  store.query(read, q.sql, q.args, decode.at([0], id.player_decoder()))
}

/// Only these players, among those the organisation may see.
pub fn among(players: List(id.PlayerId)) -> Fragment {
  sql.concat([
    sql.text("p.id IN (SELECT value FROM json_each("),
    sql.arg(
      json.array(players, id.player_json) |> json.to_string |> sqlight.text,
    ),
    sql.text("))"),
  ])
}

pub const no_distance = 10_000_000_000

/// matchOrder's lead key for `sort`, before the player id that breaks ties. An unknown sort is the default.
pub fn lead(sort: String, org: Org, now: Int) -> keyset.OrderKey {
  let today = age.day_of(now)
  case sort {
    "name" -> OrderKey(sql.text("f.name_key"), Asc, TextKind)
    "age" ->
      OrderKey(
        sql.concat([
          sql.text("COALESCE(("),
          sql.arg(sqlight.int(today.year)),
          sql.text(" - CAST(substr(p.birth_date, 1, 4) AS INTEGER) - ("),
          sql.arg(sqlight.text(string.drop_start(age.born_by(today, 0), 5))),
          sql.text(" < substr(p.birth_date, 6, 5))), 999)"),
        ]),
        Asc,
        IntKind,
      )
    "evidence_confidence" ->
      OrderKey(sql.text(engine.band_rank_sql), Desc, IntKind)
    // Only a Grassroots club is shown distance: elsewhere every player ties on it, so neither the order nor a
    // cursor can carry a distance the club is not shown.
    "distance" ->
      case engine.ground(org) {
        Some(#(lat, lng)) ->
          OrderKey(
            sql.concat([
              sql.text("COALESCE("),
              distance.tenths(At(lat, lng), Columns("p.lat", "p.lng")),
              sql.text(", " <> int.to_string(no_distance) <> ")"),
            ]),
            Asc,
            IntKind,
          )
        None -> OrderKey(sql.text(int.to_string(no_distance)), Asc, IntKind)
      }
    _ -> OrderKey(sql.text("COALESCE(f.last_evidence_at, 0)"), Desc, IntKind)
  }
}

/// The order a page is read in: the lead key, then the player id. Tie-break on f.player_id (equal to p.id) so the
/// facts index serves the order.
pub fn order(lead: keyset.OrderKey) -> List(keyset.OrderKey) {
  [lead, OrderKey(sql.text("f.player_id"), Asc, TextKind)]
}

const fact_columns =
  "p.id, p.name, p.birth_date, p.level, p.foot, f.position, f.availability, f.trust_band, f.last_evidence_at, f.last_footage_at, f.coach_reference, f.club_confirmed"

const fact_width = 12

pub opaque type FactRow {
  FactRow(
    player_id: id.PlayerId,
    name: String,
    birth_date: String,
    level: Option(PlayingLevel),
    foot: Option(String),
    position: Option(String),
    availability: Option(String),
    trust_band: Option(TrustBand),
    last_evidence_at: Option(Int),
    last_footage_at: Option(Int),
    coach_reference: Bool,
    club_confirmed: Bool,
  )
}

fn fact_row_decoder() -> decode.Decoder(FactRow) {
  use player_id <- decode.field(0, id.player_decoder())
  use name <- decode.field(1, decode.string)
  use birth_date <- decode.field(2, decode.string)
  use level <- decode.field(3, decode.optional(playing_level.decoder()))
  use foot <- decode.field(4, decode.optional(decode.string))
  use position <- decode.field(5, decode.optional(decode.string))
  use availability <- decode.field(6, decode.optional(decode.string))
  use trust_band <- decode.field(7, decode.optional(trust_band.decoder()))
  use last_evidence_at <- decode.field(8, decode.optional(decode.int))
  use last_footage_at <- decode.field(9, decode.optional(decode.int))
  use coach_reference <- decode.field(10, sqlight.decode_bool())
  use club_confirmed <- decode.field(11, sqlight.decode_bool())
  decode.success(FactRow(
    player_id:,
    name:,
    birth_date:,
    level:,
    foot:,
    position:,
    availability:,
    trust_band:,
    last_evidence_at:,
    last_footage_at:,
    coach_reference:,
    club_confirmed:,
  ))
}

pub fn player_of(r: FactRow) -> id.PlayerId {
  r.player_id
}

/// A page of `from` in `order`, with each row's keys for the next cursor: `limit + 1` rows, as `paging.page_of`
/// reads them.
pub fn page(
  read: Read,
  from: Fragment,
  order: List(keyset.OrderKey),
  page: paging.Page,
) -> Result(List(#(FactRow, List(paging.Key))), Fail(e)) {
  let q = keyset.query(fact_columns, from, order, page)
  store.query(read, q.sql, q.args, {
    use r <- decode.then(fact_row_decoder())
    use keys <- decode.then(keyset.keys_decoder(fact_width, order))
    decode.success(#(r, keys))
  })
}

/// Rows of `from` in player id order (no page): the leavers a watchlist explains, say.
pub fn rows(read: Read, from: Fragment) -> Result(List(FactRow), Fail(e)) {
  let q =
    sql.concat([
      sql.text("SELECT " <> fact_columns <> " FROM "),
      from,
      sql.text(" ORDER BY p.id"),
    ])
  store.query(read, q.sql, q.args, fact_row_decoder())
}

/// The rows' facts: their secondary positions, Combine results and (for a Grassroots club) distance, worked out
/// as the organisation's view does.
pub fn facts_of(
  read: Read,
  org: Org,
  found: List(FactRow),
  now: Int,
) -> Result(List(Facts), Fail(e)) {
  let ids =
    json.array(found, fn(r) { id.player_json(r.player_id) })
    |> json.to_string
    |> sqlight.text
  use secondary <- result.try(
    store.query(
      read,
      "SELECT player_id, code FROM player_match_fact_positions WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY player_id, ord",
      [ids],
      {
        use p <- decode.field(0, id.player_decoder())
        use c <- decode.field(1, decode.string)
        decode.success(#(p, c))
      },
    ),
  )
  use combine <- result.try(
    store.query(
      read,
      "SELECT player_id, protocol_id, best_value FROM player_match_fact_combine WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY player_id, protocol_id",
      [ids],
      {
        use p <- decode.field(0, id.player_decoder())
        use c <- decode.field(1, decode.string)
        use best <- decode.field(2, decode.optional(decode.float))
        decode.success(#(p, #(c, best)))
      },
    ),
  )
  use distances <- result.map(case engine.ground(org) {
    None -> Ok([])
    Some(#(lat, lng)) -> {
      let q =
        sql.concat([
          sql.text("SELECT p.id, "),
          distance.tenths(At(lat, lng), Columns("p.lat", "p.lng")),
          sql.text(
            " FROM players p WHERE p.id IN (SELECT value FROM json_each(",
          ),
          sql.arg(ids),
          sql.text("))"),
        ])
      store.query(read, q.sql, q.args, {
        use p <- decode.field(0, id.player_decoder())
        use t <- decode.field(1, decode.optional(decode.int))
        decode.success(#(p, t))
      })
    }
  })
  let of = fn(pairs: List(#(id.PlayerId, a)), pid) {
    list.filter_map(pairs, fn(x) {
      case x.0 == pid {
        True -> Ok(x.1)
        False -> Error(Nil)
      }
    })
  }
  list.map(found, fn(r) {
    let results = of(combine, r.player_id)
    Facts(
      player_id: r.player_id,
      name: r.name,
      age: age.age_on(r.birth_date, now),
      position: r.position,
      secondary: of(secondary, r.player_id),
      level: r.level,
      foot: r.foot,
      availability: r.availability,
      distance_km: list.key_find(distances, r.player_id)
        |> option.from_result
        |> option.flatten
        |> option.map(fn(t) { int.to_float(t) /. 10.0 }),
      trust_band: r.trust_band,
      combine: list.map(results, fn(c) { c.0 }),
      combine_measurements: list.filter_map(results, fn(c) {
        case c.1 {
          Some(best) -> Ok(#(c.0, best))
          None -> Error(Nil)
        }
      }),
      evidence: list.flatten([
        case r.last_footage_at {
          Some(at) if at > now - 180 * day_ms -> ["recent_full_match"]
          _ -> []
        },
        case r.coach_reference {
          True -> ["coach_reference"]
          False -> []
        },
        case r.club_confirmed {
          True -> ["confirmed_current_club"]
          False -> []
        },
        case results {
          [] -> []
          _ -> ["combine_verified"]
        },
      ]),
      last_evidence_at: r.last_evidence_at,
      last_footage_at: r.last_footage_at,
    )
  })
}
