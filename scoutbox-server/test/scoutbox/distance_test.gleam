//// The SQL distance rules agree with the haversine distance on every case in test/fixtures/distance_cases.json
//// (computed by the TypeScript server's domain.ts, and kept as it is: it checks arithmetic, not a design of ours):
//// random pairs, and pairs a hair either side of the 50 km radius and of each rounding edge.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import scoutbox/platform/distance.{At, Columns}
import simplifile
import sqlight

type Case {
  Case(
    why: String,
    a: #(Float, Float),
    b: #(Float, Float),
    km: Float,
    tenths: Int,
    in_radius: Bool,
  )
}

fn number() -> decode.Decoder(Float) {
  decode.one_of(decode.float, [decode.int |> decode.map(int.to_float)])
}

fn point() -> decode.Decoder(#(Float, Float)) {
  use lat <- decode.field("lat", number())
  use lng <- decode.field("lng", number())
  decode.success(#(lat, lng))
}

fn cases() -> List(Case) {
  let assert Ok(text) = simplifile.read("test/fixtures/distance_cases.json")
  let assert Ok(cases) =
    json.parse(
      text,
      decode.list({
        use why <- decode.field("why", decode.string)
        use a <- decode.field("a", point())
        use b <- decode.field("b", point())
        use km <- decode.field("km", number())
        use tenths <- decode.field("tenths", decode.int)
        use in_radius <- decode.field("inRadius", decode.bool)
        decode.success(Case(why:, a:, b:, km:, tenths:, in_radius:))
      }),
    )
  cases
}

type Measured {
  Measured(km: Float, tenths: Int, in_radius: Bool)
}

/// One point bound, the other read from a row, as the player reads use them.
fn measure(conn: sqlight.Connection, c: Case) -> Measured {
  let a = At(c.a.0, c.a.1)
  let b = Columns("p.lat", "p.lng")
  let km = distance.km(a, b)
  let tenths = distance.tenths(a, b)
  let within = distance.within_grassroots_radius(a, b)
  let sql =
    "SELECT "
    <> km.sql
    <> ", "
    <> tenths.sql
    <> ", "
    <> within.sql
    <> " FROM (SELECT ? AS lat, ? AS lng) p"
  let assert Ok([m]) =
    sqlight.query(
      sql,
      conn,
      list.flatten([
        km.args,
        tenths.args,
        within.args,
        [sqlight.float(c.b.0), sqlight.float(c.b.1)],
      ]),
      {
        use km <- decode.field(0, decode.float)
        use tenths <- decode.field(1, decode.int)
        use in_radius <- decode.field(2, sqlight.decode_bool())
        decode.success(Measured(km:, tenths:, in_radius:))
      },
    )
  m
}

/// Every decision and every rounding agrees, except where the distance is within a picometre-scale hair
/// (1e-12 km) of the edge itself. There the last bit decides, and V8 and the C maths library SQLite uses
/// differ in it: macOS's `cos` is not V8's in the last place, and V8's `x ** 2` is not always `x * x`. No
/// implementation outside V8 can match it bit for bit; a stored location that close to an edge is not a
/// real-world case.
pub fn the_sql_rules_agree_with_domain_ts_test() {
  use conn <- sqlight.with_connection(":memory:")
  let all = cases()
  let #(at_an_edge, disagreements) =
    list.filter_map(all, fn(c) {
      let m = measure(conn, c)
      case m.tenths == c.tenths && m.in_radius == c.in_radius {
        True -> Error(Nil)
        False -> Ok(#(c, m))
      }
    })
    |> list.partition(fn(pair) { at_an_edge(pair.0.km) })
  assert list.length(all) > 1500
  assert disagreements == []
  // The adversarial cases do reach the last bit, so the exemption is being exercised, not hiding a gap.
  assert at_an_edge != []
  assert list.length(at_an_edge) < 10
}

/// Within 1e-12 km of 50 km, or of an x.x5 km rounding edge.
fn at_an_edge(km: Float) -> Bool {
  let tenths = km *. 10.0
  let to_rounding_edge =
    float.absolute_value(tenths -. int.to_float(float.truncate(tenths)) -. 0.5)
    /. 10.0
  float.absolute_value(km -. distance.grassroots_radius_km) <. 1.0e-12
  || to_rounding_edge <. 1.0e-12
}

/// The kilometres themselves agree to a few units in the last place: within 1e-15 of the distance (7e-12 km
/// on a pole-to-pole pair, a nanometre on a 1000 km one).
pub fn the_kilometres_agree_test() {
  use conn <- sqlight.with_connection(":memory:")
  let off =
    cases()
    |> list.filter(fn(c) {
      let d = float.absolute_value(measure(conn, c).km -. c.km)
      d >. float.max(1.0e-12, c.km *. 1.0e-15)
    })
  assert off == []
}

/// A point with no coordinates is never within the radius.
pub fn a_missing_location_fails_closed_test() {
  use conn <- sqlight.with_connection(":memory:")
  let within =
    distance.within_grassroots_radius(At(51.5, -0.1), Columns("p.lat", "p.lng"))
  let assert Ok([False]) =
    sqlight.query(
      "SELECT " <> within.sql <> " FROM (SELECT NULL AS lat, NULL AS lng) p",
      conn,
      within.args,
      decode.at([0], sqlight.decode_bool()),
    )
}
