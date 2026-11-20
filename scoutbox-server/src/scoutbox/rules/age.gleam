//// Ages and adulthood (domain.ts `ageOn`, `isAdult`, `adultAgeFor`; temporal.ts `ageOnMs`, `parseDobStrict`).
////
//// A date of birth is a calendar day, `YYYY-MM-DD`, read in UTC. Someone turns N at 00:00 UTC on their birthday;
//// a 29 February birthday counts on 1 March in other years. That rule is exactly "the birth date, as text, is
//// at most today's date N years ago, as text", so adulthood is one string comparison against a cutoff, the
//// same in Gleam (`is_adult`) and in SQL (`adult_sql`). An unreadable date of birth is never adult.

import gleam/int
import gleam/list
import gleam/option.{type Option}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/temporal.{type Day}
import sqlight

/// Age of majority by country (ISO alpha-2); every other country is 18.
const adult_ages = [#("KR", 19), #("TH", 20), #("EG", 21), #("SG", 21)]

const default_adult_age = 18

/// The oldest a living person plausibly is.
const max_age_years = 120

pub fn adult_age_for(country: String) -> Int {
  list.key_find(adult_ages, country) |> result.unwrap(default_adult_age)
}

/// Why text is not a date of birth a profile may hold (parseDobStrict's `why`).
pub type DobProblem {
  DobNotADay(temporal.DayProblem)
  InTheFuture
  ImplausiblyOld
}

/// A date of birth a profile may hold (parseDobStrict): a real day, not in the future, not over 120 years ago.
pub fn parse_dob(s: String, now_ms: Int) -> Result(Day, DobProblem) {
  use birth <- result.try(temporal.parse_day(s) |> result.map_error(DobNotADay))
  case temporal.day_start(birth) > now_ms, on(birth, now_ms) > max_age_years {
    True, _ -> Error(InTheFuture)
    _, True -> Error(ImplausiblyOld)
    False, False -> Ok(birth)
  }
}

pub fn dob_why(p: DobProblem) -> String {
  case p {
    DobNotADay(p) -> temporal.day_why(p)
    InTheFuture -> "in the future"
    ImplausiblyOld -> "implausibly old"
  }
}

/// The latest birth date, as text, of someone who has turned `years` by `today`. It is a cutoff to compare
/// birth dates with, not a day: 29 February less a year is `…-02-29` still, which sorts where it should.
pub fn born_by(today: Day, years: Int) -> String {
  pad(temporal.day_year(today) - years, 4)
  <> "-"
  <> pad(temporal.day_month(today), 2)
  <> "-"
  <> pad(temporal.day_of_month(today), 2)
}

fn pad(n: Int, width: Int) -> String {
  int.to_string(n) |> string.pad_start(width, "0")
}

/// Completed years on `today` (temporal.ts `ageOnMs`, by day).
pub fn years_on(birth: Day, today: Day) -> Int {
  let years = temporal.day_year(today) - temporal.day_year(birth)
  let birthday = #(temporal.day_month(birth), temporal.day_of_month(birth))
  let now = #(temporal.day_month(today), temporal.day_of_month(today))
  case compare_pair(now, birthday) {
    order.Lt -> years - 1
    _ -> years
  }
}

/// Completed years at an instant (temporal.ts `ageOnMs`).
pub fn on(birth: Day, now_ms: Int) -> Int {
  years_on(birth, temporal.day_of(now_ms))
}

fn compare_pair(a: #(Int, Int), b: #(Int, Int)) -> order.Order {
  case int.compare(a.0, b.0) {
    order.Eq -> int.compare(a.1, b.1)
    other -> other
  }
}

/// A stored date of birth's age at an instant (domain.ts `ageOn`), or `None` when it cannot be read.
pub fn age_on(dob: String, now_ms: Int) -> Option(Int) {
  temporal.parse_day(dob)
  |> option.from_result
  |> option.map(on(_, now_ms))
}

/// Adult only when the age is known and reaches the country's threshold.
pub fn is_adult(dob: String, country: String, now_ms: Int) -> Bool {
  case temporal.parse_day(dob) {
    Error(_) -> False
    Ok(_) ->
      string.compare(
        dob,
        born_by(temporal.day_of(now_ms), adult_age_for(country)),
      )
      != order.Gt
  }
}

/// The SQL form of `is_adult` over a row's birth date and country columns.
pub fn adult_sql(dob: String, country: String, now_ms: Int) -> Fragment {
  let today = temporal.day_of(now_ms)
  sql.concat(
    list.flatten([
      [sql.text(dob <> " <= CASE " <> country)],
      list.flat_map(adult_ages, fn(pair) {
        [
          sql.text(" WHEN "),
          sql.arg(sqlight.text(pair.0)),
          sql.text(" THEN "),
          sql.arg(sqlight.text(born_by(today, pair.1))),
        ]
      }),
      [
        sql.text(" ELSE "),
        sql.arg(sqlight.text(born_by(today, default_adult_age))),
        sql.text(" END"),
      ],
    ]),
  )
}
