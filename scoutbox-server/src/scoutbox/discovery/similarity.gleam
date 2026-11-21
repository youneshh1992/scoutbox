//// Statistical similarity between players (domain.ts `similarityScore`), behind a profile's similar players and
//// archetypes and "more like this": a lead for a scout, never a verdict, and drawn only from the players the club
//// may see.

import gleam/float
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/players as player_row
import scoutbox/rules/age
import scoutbox/rules/visibility
import scoutbox/vocab/foot.{type Foot}
import scoutbox/vocab/position.{type Position}

/// What the score reads of a player: their position, foot, age, output and build.
pub type Profile {
  Profile(
    position: Option(Position),
    foot: Option(Foot),
    birth_date: String,
    height_cm: Option(Int),
    weight_kg: Option(Int),
    appearances: Option(Int),
    goals: Option(Int),
    assists: Option(Int),
  )
}

pub fn of_row(r: player_row.Row) -> Profile {
  Profile(
    position: r.position,
    foot: r.foot,
    birth_date: r.birth_date,
    height_cm: r.height_cm,
    weight_kg: r.weight_kg,
    appearances: r.stats_appearances,
    goals: r.stats_goals,
    assists: r.stats_assists,
  )
}

const position_groups = [
  ["GK"],
  ["CB", "RB", "LB", "RWB", "LWB"],
  ["CDM", "CM", "CAM"],
  ["RW", "LW", "ST", "CF"],
]

fn same_group(a: Option(Position), b: Option(Position)) -> Bool {
  case a, b {
    Some(a), Some(b) -> {
      let a = position.to_string(a)
      let b = position.to_string(b)
      list.any(position_groups, fn(g) {
        list.contains(g, a) && list.contains(g, b)
      })
    }
    _, _ -> False
  }
}

/// Goals and assists a game; no appearances count as one.
fn output_per_90(p: Profile) -> Float {
  let apps = case p.appearances {
    None | Some(0) -> 1
    Some(n) -> n
  }
  int.to_float(option.unwrap(p.goals, 0) + option.unwrap(p.assists, 0))
  /. int.to_float(apps)
}

/// 0 to 100: 35 for the same position (18 for the same group), 10 for the same foot, up to 15 for age, 25 for
/// output and 15 for build. Ages are taken at `now`. A stored birth date is always a day, so an age is always
/// known here; an unknown one would earn nothing for age.
pub fn score(a: Profile, b: Profile, now: Int) -> Int {
  let position = case
    a.position == b.position,
    same_group(a.position, b.position)
  {
    True, _ -> 35.0
    False, True -> 18.0
    False, False -> 0.0
  }
  let foot = case a.foot == b.foot {
    True -> 10.0
    False -> 0.0
  }
  let age_part = case
    age.age_on(a.birth_date, now),
    age.age_on(b.birth_date, now)
  {
    Some(x), Some(y) ->
      float.max(0.0, 15.0 -. int.to_float(int.absolute_value(x - y) * 3))
    _, _ -> 0.0
  }
  let output =
    float.max(
      0.0,
      25.0 -. float.absolute_value(output_per_90(a) -. output_per_90(b)) *. 25.0,
    )
  let height = fn(p: Profile) { int.to_float(option.unwrap(p.height_cm, 180)) }
  let weight = fn(p: Profile) { int.to_float(option.unwrap(p.weight_kg, 75)) }
  let build =
    float.max(
      0.0,
      15.0
        -. {
        float.absolute_value(height(a) -. height(b))
        /. 2.0
        +. float.absolute_value(weight(a) -. weight(b))
        /. 3.0
      },
    )
  float.round(float.min(position +. foot +. age_part +. output +. build, 100.0))
}

/// A catalogue archetype (catalogue.mjs `ARCHETYPES`), scored like a player.
pub type Archetype {
  Archetype(id: String, label: String, profile: Profile)
}

fn archetype(
  id: String,
  label: String,
  position: Position,
  foot: Foot,
  birth_date: String,
  height_cm: Int,
  weight_kg: Int,
  goals: Int,
  assists: Int,
) -> Archetype {
  Archetype(
    id:,
    label:,
    profile: Profile(
      position: Some(position),
      foot: Some(foot),
      birth_date:,
      height_cm: Some(height_cm),
      weight_kg: Some(weight_kg),
      appearances: Some(30),
      goals: Some(goals),
      assists: Some(assists),
    ),
  )
}

/// `test/scoutbox/spec_test.gleam` proves these equal e2e/support/spec/catalogue.json.
pub fn archetypes() -> List(Archetype) {
  [
    archetype(
      "arch-pressing-forward",
      "Pressing forward",
      position.ST,
      foot.Right,
      "2002-01-01",
      185,
      80,
      18,
      5,
    ),
    archetype(
      "arch-deep-playmaker",
      "Deep-lying playmaker",
      position.CM,
      foot.Left,
      "2001-01-01",
      177,
      72,
      3,
      10,
    ),
    archetype(
      "arch-ball-playing-cb",
      "Ball-playing centre-back",
      position.CB,
      foot.Right,
      "2001-01-01",
      190,
      84,
      2,
      1,
    ),
    archetype(
      "arch-direct-winger",
      "Direct winger",
      position.RW,
      foot.Left,
      "2003-01-01",
      177,
      71,
      10,
      11,
    ),
    archetype(
      "arch-sweeper-keeper",
      "Sweeper keeper",
      position.GK,
      foot.Right,
      "2000-01-01",
      192,
      87,
      0,
      0,
    ),
  ]
}

/// The `k` archetypes closest to `p`, best first.
pub fn closest_archetypes(
  p: Profile,
  k: Int,
  now: Int,
) -> List(#(Archetype, Int)) {
  archetypes()
  |> list.map(fn(a) { #(a, score(p, a.profile, now)) })
  |> best_first
  |> list.take(k)
}

/// A player among the ones like the base, with their score.
pub type Similar {
  Similar(id: id.PlayerId, name: String, position: Option(Position), score: Int)
}

/// The `k` players `org` may see who are most like `base`, best first; a tie keeps creation order. The base, a
/// removed player and a player who blocked the club are never candidates.
pub fn most_similar(
  read: Read,
  base: player_row.Row,
  org: Org,
  k: Int,
  now: Int,
) -> Result(List(Similar), Fail(e)) {
  let me = of_row(base)
  let query =
    sql.concat([
      sql.text(
        "SELECT "
        <> player_row.qualified("p")
        <> " FROM players p WHERE p.deleted_at IS NULL AND p.id <> ",
      ),
      sql.arg(id.player_sql(base.id)),
      sql.text(" AND "),
      visibility.visible_sql(org, now),
      sql.text(" AND NOT "),
      visibility.blocked_sql(org),
      sql.text(" ORDER BY p.rowid"),
    ])
  use rows <- result.map(store.query(
    read,
    query.sql,
    query.args,
    player_row.decoder(),
  ))
  rows
  |> list.map(fn(r) {
    let s = score(me, of_row(r), now)
    #(Similar(r.id, r.name, r.position, s), s)
  })
  |> best_first
  |> list.take(k)
  |> list.map(fn(pair) { pair.0 })
}

/// Highest score first, equals in the order they came.
fn best_first(scored: List(#(a, Int))) -> List(#(a, Int)) {
  scored
  |> list.index_map(fn(pair, i) { #(pair, i) })
  |> list.sort(fn(x, y) {
    int.compare(y.0.1, x.0.1)
    |> order.break_tie(int.compare(x.1, y.1))
  })
  |> list.map(fn(x) { x.0 })
}
