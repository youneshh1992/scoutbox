//// Honest benchmarks for the Grassroots journey (domains/development/grassroots.mjs `/player/benchmarks`): the
//// player's best drill results and stats as a percentile among amateur and semi-pro players of their position group.
//// A comparison with fewer than 3 records says "not enough evidence" instead of a percentile, and every row carries
//// its sample size.

import gleam/dict
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/platform/http
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/players as player_row
import scoutbox/vocab/playing_level
import scoutbox/vocab/position.{type Position}
import sqlight
import wisp.{type Response}

pub type Drill {
  Drill(
    id: String,
    name: String,
    metric: String,
    unit: String,
    benchmark: Float,
    lower_is_better: Bool,
  )
}

/// The drill library (record.mjs `DRILLS`; spec_test proves they agree).
pub const drills = [
  Drill(
    "drill-sprint-ladder",
    "Sprint ladder — 6×30m",
    "best 30m time",
    "s",
    4.2,
    True,
  ),
  Drill(
    "drill-passing-gates",
    "Passing gates — both feet",
    "gates hit of 20",
    "/20",
    14.0,
    False,
  ),
  Drill(
    "drill-shooting-arc",
    "Shooting arc — 20 finishes",
    "on-target finishes",
    "/20",
    12.0,
    False,
  ),
  Drill(
    "drill-first-touch",
    "First touch — wall rebounds",
    "touches in 60s",
    "",
    45.0,
    False,
  ),
]

/// The programme tracks' position groups (grassrootsJourney.mjs `PROGRAMME_TRACKS`; spec_test proves they agree).
pub const tracks = [
  #("attack", [position.ST, position.CF, position.RW, position.LW, position.CAM]),
  #("midfield", [
    position.CM,
    position.CDM,
    position.RB,
    position.LB,
    position.RWB,
    position.LWB,
  ]),
  #("defence", [position.CB]),
  #("keeper", [position.GK]),
]

/// A position's track; no position, or one no track names, is midfield.
pub fn track_for(p: Option(Position)) -> String {
  case p {
    None -> "midfield"
    Some(p) ->
      list.find(tracks, fn(t) { list.contains(t.1, p) })
      |> result.map(fn(t) { t.0 })
      |> result.unwrap("midfield")
  }
}

/// The percentile of `value` among `cohort` (grassrootsJourney.mjs `percentileAmong`): the share it beats or
/// matches, or `None` under 3 records.
pub fn percentile_among(
  value: Float,
  cohort: List(Float),
  lower_is_better: Bool,
) -> Option(Int) {
  let n = list.length(cohort)
  case n < 3 {
    True -> None
    False -> {
      let matched =
        list.count(cohort, fn(v) {
          case lower_is_better {
            True -> value <=. v
            False -> value >=. v
          }
        })
      Some(float.round(int.to_float(matched) /. int.to_float(n) *. 100.0))
    }
  }
}

type Stat {
  Stat(
    key: String,
    of: fn(player_row.Row) -> Option(Float),
    json: fn(Float) -> Json,
  )
}

fn whole(n: Option(Int)) -> Option(Float) {
  option.map(n, int.to_float)
}

fn as_int(f: Float) -> Json {
  json.int(float.truncate(f))
}

const method =
  "Percentile of your best result among amateur & semi-pro players in your position group with the same measurement recorded. Cohorts under 3 comparable records show \"not enough evidence\" instead of a percentile. Incompatible records (other positions, pro level, missing values) are excluded."

const note =
  "Percentiles vs amateur & semi-pro players in your position group — context, not competition."

fn stats() -> List(Stat) {
  [
    Stat("goals", fn(r) { whole(r.stats_goals) }, as_int),
    Stat("assists", fn(r) { whole(r.stats_assists) }, as_int),
    Stat("appearances", fn(r) { whole(r.stats_appearances) }, as_int),
    Stat(
      "passCompletionPct",
      fn(r) { r.stats_pass_completion_pct },
      json_text.number,
    ),
    Stat("duelSuccessPct", fn(r) { r.stats_duel_success_pct }, json_text.number),
  ]
}

/// The cohort's filter (players.ts `scanWhere`): not removed, not pro, not the player, in the player's track.
fn cohort_where(me: player_row.Row) -> #(String, List(sqlight.Value)) {
  let track = track_for(me.position)
  let positions =
    position.pairs
    |> list.filter(fn(pair) { track_for(Some(pair.1)) == track })
    |> list.map(fn(pair) { pair.0 })
  let no_position = case track == track_for(None) {
    True -> " OR p.position IS NULL"
    False -> ""
  }
  #(
    "p.deleted_at IS NULL AND p.level <> ? AND p.id <> ? AND (p.position IN (SELECT value FROM json_each(?))"
      <> no_position
      <> ")",
    [
      sqlight.text(playing_level.to_string(playing_level.Pro)),
      id.player_sql(me.id),
      sqlight.text(json.to_string(json.array(positions, json.string))),
    ],
  )
}

type Found {
  Found(
    cohort: List(player_row.Row),
    /// Each drill's per-player best results in the cohort: `#(max, min)`.
    bests: dict.Dict(String, List(#(Float, Float))),
    mine: dict.Dict(String, #(Float, Float)),
  )
}

fn best_decoder() -> decode.Decoder(#(String, #(Float, Float))) {
  use drill_id <- decode.field(0, decode.string)
  use max <- decode.field(1, decode.float)
  use min <- decode.field(2, decode.float)
  decode.success(#(drill_id, #(max, min)))
}

fn found(read: Read, me: player_row.Row) -> Result(Found, Fail(e)) {
  let #(where, args) = cohort_where(me)
  use cohort <- result.try(store.query(
    read,
    "SELECT "
      <> player_row.qualified("p")
      <> " FROM players p WHERE "
      <> where
      <> " ORDER BY p.rowid",
    args,
    player_row.decoder(),
  ))
  use bests <- result.try(store.query(
    read,
    "SELECT d.drill_id, MAX(d.value), MIN(d.value) FROM player_drill_results d JOIN players p ON p.id = d.player_id WHERE "
      <> where
      <> " GROUP BY d.drill_id, d.player_id ORDER BY d.drill_id, p.rowid",
    args,
    best_decoder(),
  ))
  use mine <- result.map(store.query(
    read,
    "SELECT drill_id, MAX(value), MIN(value) FROM player_drill_results WHERE player_id = ? GROUP BY drill_id",
    [id.player_sql(me.id)],
    best_decoder(),
  ))
  Found(
    cohort:,
    bests: list.fold(list.reverse(bests), dict.new(), fn(acc, b) {
      dict.upsert(acc, b.0, fn(had) { [b.1, ..option.unwrap(had, [])] })
    }),
    mine: dict.from_list(mine),
  )
}

fn row_fields(percentile: Option(Int), sample: Int) -> List(#(String, Json)) {
  [
    #("percentile", json.nullable(percentile, json.int)),
    #("sampleSize", json.int(sample)),
    #("insufficient", json.bool(percentile == None)),
  ]
}

/// `GET /player/benchmarks`.
pub fn player(ctx: Ctx, p: PlayerAccess) -> Response {
  let me = p.player.row
  case me.level {
    playing_level.Pro ->
      http.error_message(
        403,
        "GRASSROOTS_ONLY",
        "This is part of the Grassroots journey — pro-level players have moved past it.",
      )
    _ ->
      case store.read(ctx.store, found(_, me)) {
        Error(failure) -> http.internal(failure)
        Ok(f) -> {
          let drill_rows =
            list.filter_map(drills, fn(d) {
              use #(max, min) <- result.map(dict.get(f.mine, d.id))
              let mine = case d.lower_is_better {
                True -> min
                False -> max
              }
              let values =
                dict.get(f.bests, d.id)
                |> result.unwrap([])
                |> list.map(fn(b) {
                  case d.lower_is_better {
                    True -> b.1
                    False -> b.0
                  }
                })
              json.object([
                #("drillId", json.string(d.id)),
                #("name", json.string(d.name)),
                #("metric", json.string(d.metric)),
                #("unit", json.string(d.unit)),
                #("value", json_text.number(mine)),
                ..row_fields(
                  percentile_among(mine, values, d.lower_is_better),
                  list.length(values),
                )
              ])
            })
          let stat_rows =
            list.filter_map(stats(), fn(s) {
              use mine <- result.map(option.to_result(s.of(me), Nil))
              let values =
                list.filter_map(f.cohort, fn(c) {
                  option.to_result(s.of(c), Nil)
                })
              json.object([
                #("stat", json.string(s.key)),
                #("value", s.json(mine)),
                ..row_fields(
                  percentile_among(mine, values, False),
                  list.length(values),
                )
              ])
            })
          http.json(
            200,
            json.object([
              #("cohortSize", json.int(list.length(f.cohort))),
              #("method", json.string(method)),
              #("note", json.string(note)),
              #("drills", json.preprocessed_array(drill_rows)),
              #("stats", json.preprocessed_array(stat_rows)),
            ]),
          )
        }
      }
  }
}
