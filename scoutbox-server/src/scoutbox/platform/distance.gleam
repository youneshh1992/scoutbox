//// Distances, as SQL. The TypeScript server registers `haversine_km` and `distance_tenths` as JavaScript
//// functions on its connection; sqlight cannot register functions, so here they are expressions in SQLite's
//// built-in math functions, written in the same order of operations as domain.ts `haversineKm`. They are
//// the only definition: every read that measures a distance uses them, and `test/scoutbox/distance_test.gleam`
//// proves them against cases generated from domain.ts itself.

import gleam/list
import gleam/string
import sqlight

pub const grassroots_radius_km = 50.0

/// An SQL expression and the values its `?`s bind, in order. Fragments only ever join with `concat`, which
/// keeps each one's arguments with its text, so a point used several times is bound as often as it appears.
pub type Fragment {
  Fragment(sql: String, args: List(sqlight.Value))
}

pub fn concat(parts: List(Fragment)) -> Fragment {
  Fragment(
    sql: list.map(parts, fn(p) { p.sql }) |> string.concat,
    args: list.flat_map(parts, fn(p) { p.args }),
  )
}

pub fn text(sql: String) -> Fragment {
  Fragment(sql, [])
}

/// A point: fixed (bound as arguments) or a pair of column expressions.
pub type Point {
  At(lat: Float, lng: Float)
  Columns(lat: String, lng: String)
}

fn lat(p: Point) -> Fragment {
  case p {
    At(lat, _) -> Fragment("?", [sqlight.float(lat)])
    Columns(lat, _) -> text(lat)
  }
}

fn lng(p: Point) -> Fragment {
  case p {
    At(_, lng) -> Fragment("?", [sqlight.float(lng)])
    Columns(_, lng) -> text(lng)
  }
}

/// `(d * π) / 180`, as domain.ts writes it.
fn rad(d: Fragment) -> Fragment {
  concat([text("((("), d, text(") * pi()) / 180)")])
}

fn difference(x: Fragment, y: Fragment) -> Fragment {
  concat([text("("), x, text(" - "), y, text(")")])
}

fn squared(x: Fragment) -> Fragment {
  concat([text("(("), x, text(") * ("), x, text("))")])
}

fn call(f: String, x: Fragment) -> Fragment {
  concat([text(f <> "("), x, text(")")])
}

/// The great-circle distance from `a` to `b` in km; NULL when either point has a NULL coordinate.
pub fn km(a: Point, b: Point) -> Fragment {
  let half_d_lat =
    call("sin", concat([rad(difference(lat(b), lat(a))), text(" / 2")]))
  let half_d_lng =
    call("sin", concat([rad(difference(lng(b), lng(a))), text(" / 2")]))
  let s =
    concat([
      squared(half_d_lat),
      text(" + "),
      call("cos", rad(lat(a))),
      text(" * "),
      call("cos", rad(lat(b))),
      text(" * "),
      squared(half_d_lng),
    ])
  concat([text("(2 * 6371 * asin(sqrt("), s, text(")))")])
}

/// The distance a Grassroots club is shown, in tenths of a km: domain.ts `Math.round(km * 10)`.
pub fn tenths(a: Point, b: Point) -> Fragment {
  concat([text("CAST(floor("), km(a, b), text(" * 10 + 0.5) AS INTEGER)")])
}

/// Within the Grassroots radius of `a`. A NULL coordinate is never within it: fail closed.
pub fn within_grassroots_radius(a: Point, b: Point) -> Fragment {
  concat([
    text("coalesce("),
    km(a, b),
    text(" <= " <> string.inspect(grassroots_radius_km) <> ", 0)"),
  ])
}
