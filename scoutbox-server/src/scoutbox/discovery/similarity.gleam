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
import gleam/string
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
import sqlight

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

// The score's numbers (domain.ts `SIMILARITY`), read by `score_aged` and `score_sql` alike: the most each part
// earns, what costs a point of it, and the build assumed when one is missing.
const position_points = 35

const group_points = 18

const foot_points = 10

const age_points = 15

const per_year_apart = 3

const output_points = 25

const per_output_apart = 25

const build_points = 15

const cm_per_point = 2

const kg_per_point = 3

const default_height_cm = 180

const default_weight_kg = 75

/// The most a candidate outside the base's position group can score: everything but the position part. A ranking
/// whose top `k` from the group all beat it needs no other candidate.
pub fn without_position() -> Int {
  foot_points + age_points + output_points + build_points
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
    height: int.to_float(option.unwrap(p.height_cm, default_height_cm)),
    weight: int.to_float(option.unwrap(p.weight_kg, default_weight_kg)),
  )
}

fn score_aged(a: Aged, b: Aged) -> Int {
  let position = case a.position == b.position, a.group, b.group {
    True, _, _ -> position_points
    False, Some(x), Some(y) if x == y -> group_points
    False, _, _ -> 0
  }
  let foot = case a.foot == b.foot {
    True -> foot_points
    False -> 0
  }
  let age_part =
    int.max(0, age_points - int.absolute_value(a.age - b.age) * per_year_apart)
  let output =
    float.max(
      0.0,
      int.to_float(output_points)
        -. float.absolute_value(a.output -. b.output)
        *. int.to_float(per_output_apart),
    )
  let build =
    float.max(
      0.0,
      int.to_float(build_points)
        -. {
        float.absolute_value(a.height -. b.height)
        /. int.to_float(cm_per_point)
        +. float.absolute_value(a.weight -. b.weight)
        /. int.to_float(kg_per_point)
      },
    )
  float.round(float.min(
    int.to_float(position + foot + age_part) +. output +. build,
    100.0,
  ))
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
/// removed player and a player who blocked the club are never candidates. Scored in SQL (`score_sql`), so only the
/// winners leave SQLite. The candidates who share the base's position or group are ranked first: when their `k`th
/// beats `without_position()`, no other candidate can reach the answer and the rest are never scored.
pub fn most_similar(
  read: Read,
  base: player_row.Row,
  org: Org,
  k: Int,
  now: Int,
) -> Result(List(Similar), Fail(e)) {
  let me = aged(of_row(base), now)
  let near =
    sql.concat([
      sql.text("(p.position IS "),
      sql.arg(sqlight.nullable(position_text, me.position)),
      sql.text(" OR "),
      group_sql("p.position"),
      sql.text(" = "),
      sql.arg(sqlight.nullable(sqlight.int, me.group)),
      sql.text(")"),
    ])
  case k <= 0 {
    True -> Ok([])
    False -> {
      use found <- result.try(ranked(read, base, org, me, k, now, Some(near)))
      let full = list.length(found) == k
      let bound = without_position()
      case list.last(found) {
        Ok(kth) if full && kth.score > bound -> Ok(found)
        _ -> ranked(read, base, org, me, k, now, None)
      }
    }
  }
}

/// The best `k` candidates by `score_sql`, narrowed by `narrow` when given.
fn ranked(
  read: Read,
  base: player_row.Row,
  org: Org,
  me: Aged,
  k: Int,
  now: Int,
  narrow: Option(sql.Fragment),
) -> Result(List(Similar), Fail(e)) {
  let query =
    sql.concat([
      sql.text(
        "SELECT id, name, position, CAST(s AS INTEGER) + (s - CAST(s AS INTEGER) >= 0.5) AS score FROM ("
        <> "SELECT p.rowid AS rid, p.id, p.name, p.position, ",
      ),
      score_sql(me, now),
      sql.text(" AS s FROM players p WHERE p.deleted_at IS NULL AND p.id <> "),
      sql.arg(id.player_sql(base.id)),
      sql.text(" AND "),
      visibility.can_see_sql(org, now),
      case narrow {
        Some(f) -> sql.concat([sql.text(" AND "), f])
        None -> sql.text("")
      },
      sql.text(") ORDER BY score DESC, rid LIMIT "),
      sql.arg(sqlight.int(k)),
    ])
  store.query(read, query.sql, query.args, similar_decoder())
}

/// `score(base, p, now)` as SQL over the candidate `p`, before rounding. The terms are added in `score_aged`'s order
/// and each is the same double it works out, so the rounded score is `score`'s own (similarity_test holds them
/// together). A stored birth date is always a day, so its year and `MM-DD` are its text's.
fn score_sql(me: Aged, now: Int) -> sql.Fragment {
  let today = temporal.day_of(now)
  let n = int.to_string
  sql.concat([
    sql.text("MIN(100, (CASE WHEN p.position IS "),
    sql.arg(sqlight.nullable(position_text, me.position)),
    sql.text(" THEN " <> n(position_points) <> " WHEN "),
    group_sql("p.position"),
    sql.text(" = "),
    sql.arg(sqlight.nullable(sqlight.int, me.group)),
    sql.text(
      " THEN " <> n(group_points) <> " ELSE 0 END) + (CASE WHEN p.foot IS ",
    ),
    sql.arg(sqlight.nullable(fn(f) { sqlight.text(foot.to_string(f)) }, me.foot)),
    sql.text(
      " THEN "
      <> n(foot_points)
      <> " ELSE 0 END) + MAX(0, "
      <> n(age_points)
      <> " - ABS(",
    ),
    sql.arg(sqlight.int(temporal.day_year(today))),
    sql.text(
      " - CAST(substr(p.birth_date, 1, 4) AS INTEGER) - (substr(p.birth_date, 6) > ",
    ),
    sql.arg(sqlight.text(string.drop_start(temporal.day_text(today), 5))),
    sql.text(") - "),
    sql.arg(sqlight.int(me.age)),
    sql.text(
      ") * "
      <> n(per_year_apart)
      <> ") + MAX(0, "
      <> n(output_points)
      <> " - ABS(",
    ),
    sql.arg(sqlight.float(me.output)),
    sql.text(
      " - (COALESCE(p.stats_goals, 0) + COALESCE(p.stats_assists, 0)) * 1.0"
      <> " / COALESCE(NULLIF(p.stats_appearances, 0), 1)) * "
      <> n(per_output_apart)
      <> ") + MAX(0, "
      <> n(build_points)
      <> " - (ABS(",
    ),
    sql.arg(sqlight.float(me.height)),
    sql.text(
      " - COALESCE(p.height_cm, "
      <> n(default_height_cm)
      <> ")) / "
      <> n(cm_per_point)
      <> ".0 + ABS(",
    ),
    sql.arg(sqlight.float(me.weight)),
    sql.text(
      " - COALESCE(p.weight_kg, "
      <> n(default_weight_kg)
      <> ")) / "
      <> n(kg_per_point)
      <> ".0)))",
    ),
  ])
}

/// `group_of` as SQL over a position column: NULL for no position.
fn group_sql(column: String) -> sql.Fragment {
  let whens =
    list.filter_map(position.pairs, fn(pair) {
      case group_of(Some(pair.1)) {
        Some(g) ->
          Ok(
            sql.concat([
              sql.text(" WHEN "),
              sql.arg(sqlight.text(pair.0)),
              sql.text(" THEN " <> int.to_string(g)),
            ]),
          )
        None -> Error(Nil)
      }
    })
  sql.concat(
    [sql.text("(CASE " <> column), ..whens] |> list.append([sql.text(" END)")]),
  )
}

fn position_text(p: Position) -> sqlight.Value {
  sqlight.text(position.to_string(p))
}

fn similar_decoder() -> decode.Decoder(Similar) {
  use id <- decode.field(0, id.player_decoder())
  use name <- decode.field(1, decode.string)
  use position <- decode.field(2, decode.optional(position.decoder()))
  use score <- decode.field(3, decode.int)
  decode.success(Similar(id:, name:, position:, score:))
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
