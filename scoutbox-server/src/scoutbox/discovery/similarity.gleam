//// Statistical similarity between players (domain.ts `similarityScore`), behind a profile's similar players and
//// archetypes and "more like this": a lead for a scout, never a verdict, and drawn only from the players the club
//// may see.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal.{type Day}
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
    birth_date: Day,
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

/// The index of the group `p` is in (domain.ts `POSITION_GROUPS`): the keeper, the back line, midfield, attack.
fn group_of(p: Option(Position)) -> Option(Int) {
  use p <- option.map(p)
  case p {
    position.GK -> 0
    position.CB | position.RB | position.LB | position.RWB | position.LWB -> 1
    position.CDM | position.CM | position.CAM -> 2
    position.RW | position.LW | position.ST | position.CF -> 3
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
  score_aged(aged(a, now), aged(b, now))
}

/// What `score` reads of a profile, worked out once: a scan scores one base against every candidate, so the base's
/// age, group and output are not worked out again for each.
type Aged {
  Aged(
    position: Option(Position),
    group: Option(Int),
    foot: Option(Foot),
    age: Int,
    output: Float,
    height: Float,
    weight: Float,
  )
}

fn aged(p: Profile, now: Int) -> Aged {
  Aged(
    position: p.position,
    group: group_of(p.position),
    foot: p.foot,
    age: age.age_on(p.birth_date, now),
    output: output_per_90(p),
    height: int.to_float(option.unwrap(p.height_cm, 180)),
    weight: int.to_float(option.unwrap(p.weight_kg, 75)),
  )
}

fn score_aged(a: Aged, b: Aged) -> Int {
  let position = case a.position == b.position, a.group, b.group {
    True, _, _ -> 35.0
    False, Some(x), Some(y) if x == y -> 18.0
    False, _, _ -> 0.0
  }
  let foot = case a.foot == b.foot {
    True -> 10.0
    False -> 0.0
  }
  let age_part =
    float.max(0.0, 15.0 -. int.to_float(int.absolute_value(a.age - b.age) * 3))
  let output =
    float.max(0.0, 25.0 -. float.absolute_value(a.output -. b.output) *. 25.0)
  let build =
    float.max(
      0.0,
      15.0
        -. {
        float.absolute_value(a.height -. b.height)
        /. 2.0
        +. float.absolute_value(a.weight -. b.weight)
        /. 3.0
      },
    )
  float.round(float.min(position +. foot +. age_part +. output +. build, 100.0))
}

/// A catalogue archetype's birth date, written as a literal below.
fn catalogue_day(text: String) -> Day {
  let assert Ok(d) = temporal.parse_day(text)
    as "an archetype's birth date is a day"
  d
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
      birth_date: catalogue_day(birth_date),
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
  let me = aged(p, now)
  archetypes()
  |> list.map(fn(a) { #(a, score_aged(me, aged(a.profile, now))) })
  |> best_first
  |> list.take(k)
}

/// A player among the ones like the base, with their score.
pub type Similar {
  Similar(id: id.PlayerId, name: String, position: Option(Position), score: Int)
}

/// The `k` players `org` may see who are most like `base`, best first; a tie keeps creation order. The base, a
/// removed player and a player who blocked the club are never candidates. Ranked over light rows, the columns the
/// score and the answer read (search.mjs `mostSimilar` over `scanLight`), keeping only the best `k` as it goes.
pub fn most_similar(
  read: Read,
  base: player_row.Row,
  org: Org,
  k: Int,
  now: Int,
) -> Result(List(Similar), Fail(e)) {
  let me = aged(of_row(base), now)
  let query =
    sql.concat([
      sql.text(
        "SELECT p.id, p.name, p.position, p.foot, p.birth_date, p.height_cm, p.weight_kg, p.stats_appearances,"
        <> " p.stats_goals, p.stats_assists"
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
    candidate_decoder(),
  ))
  rows
  |> list.fold([], fn(best, c: #(Similar, Profile)) {
    let #(similar, profile) = c
    keep_best(
      best,
      Similar(..similar, score: score_aged(me, aged(profile, now))),
      k,
    )
  })
  |> list.reverse
}

/// A light row: the answer's fields (its score still 0) and the profile it is scored on.
fn candidate_decoder() -> decode.Decoder(#(Similar, Profile)) {
  use id <- decode.field(0, id.player_decoder())
  use name <- decode.field(1, decode.string)
  use position <- decode.field(2, decode.optional(position.decoder()))
  use foot <- decode.field(3, decode.optional(foot.decoder()))
  use birth_date <- decode.field(4, temporal.day_decoder())
  use height_cm <- decode.field(5, decode.optional(decode.int))
  use weight_kg <- decode.field(6, decode.optional(decode.int))
  use appearances <- decode.field(7, decode.optional(decode.int))
  use goals <- decode.field(8, decode.optional(decode.int))
  use assists <- decode.field(9, decode.optional(decode.int))
  decode.success(#(
    Similar(id:, name:, position:, score: 0),
    Profile(
      position:,
      foot:,
      birth_date:,
      height_cm:,
      weight_kg:,
      appearances:,
      goals:,
      assists:,
    ),
  ))
}

/// `best` holds at most `k`, worst first. A candidate joins only with a strictly higher score than the worst kept
/// once `k` are kept, and goes in after every kept one with its score, so an equal earlier candidate stays ahead.
fn keep_best(best: List(Similar), c: Similar, k: Int) -> List(Similar) {
  case list.length(best) >= k, best {
    _, _ if k <= 0 -> []
    True, [worst, ..] if c.score <= worst.score -> best
    True, [_, ..rest] -> insert_worst_first(rest, c)
    _, _ -> insert_worst_first(best, c)
  }
}

/// Puts `c` into a worst-first list just before the first entry it doesn't beat: past every lower score, and below
/// any equal one, which came earlier.
fn insert_worst_first(best: List(Similar), c: Similar) -> List(Similar) {
  case best {
    [e, ..rest] if e.score < c.score -> [e, ..insert_worst_first(rest, c)]
    _ -> [c, ..best]
  }
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
