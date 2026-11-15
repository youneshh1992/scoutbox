//// Ages and adulthood (domain.ts `ageOn`, `isAdult`, `adultAgeFor`; temporal.ts `parseDobStrict`).
////
//// A date of birth is a calendar day, `YYYY-MM-DD`, read in UTC. Someone turns N at 00:00 UTC on their birthday;
//// a 29 February birthday counts on 1 March in other years. That rule is exactly "the birth date, as text, is
//// at most today's date N years ago, as text", so adulthood is one string comparison against a cutoff, the
//// same in Gleam (`is_adult`) and in SQL (`adult_sql`). An unreadable date of birth is never adult.

import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import gleam/time/calendar.{type Date, Date}
import gleam/time/timestamp
import scoutbox/platform/sql.{type Fragment}
import sqlight

/// Age of majority by country (ISO alpha-2); every other country is 18.
const adult_ages = [#("KR", 19), #("TH", 20), #("EG", 21), #("SG", 21)]

const default_adult_age = 18

const year_min = 1900

const year_max = 2100

/// The oldest a living person plausibly is.
const max_age_years = 120

pub fn adult_age_for(country: String) -> Int {
  list.key_find(adult_ages, country) |> result.unwrap(default_adult_age)
}

/// The UTC calendar day of an instant.
pub fn day_of(now_ms: Int) -> Date {
  let #(date, _) =
    timestamp.from_unix_seconds_and_nanoseconds(
      now_ms / 1000,
      { now_ms % 1000 } * 1_000_000,
    )
    |> timestamp.to_calendar(calendar.utc_offset)
  date
}

fn pad(n: Int, width: Int) -> String {
  int.to_string(n) |> string.pad_start(width, "0")
}

fn text_of(year: Int, month: Int, day: Int) -> String {
  pad(year, 4) <> "-" <> pad(month, 2) <> "-" <> pad(day, 2)
}

/// A real day written `YYYY-MM-DD`, year 1900–2100 (temporal.ts `parseStrictDateOnly`).
pub fn parse_day(s: String) -> Result(Date, Nil) {
  case string.to_graphemes(s) {
    [y1, y2, y3, y4, "-", m1, m2, "-", d1, d2] -> {
      let digits = [y1, y2, y3, y4, m1, m2, d1, d2]
      use <- bool_guard(list.all(digits, is_digit))
      use year <- result.try(int.parse(y1 <> y2 <> y3 <> y4))
      use month_number <- result.try(int.parse(m1 <> m2))
      use day <- result.try(int.parse(d1 <> d2))
      use month <- result.try(calendar.month_from_int(month_number))
      let date = Date(year:, month:, day:)
      case
        year >= year_min && year <= year_max && calendar.is_valid_date(date)
      {
        True -> Ok(date)
        False -> Error(Nil)
      }
    }
    _ -> Error(Nil)
  }
}

fn is_digit(g: String) -> Bool {
  string.contains("0123456789", g)
}

fn bool_guard(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

/// A date of birth a profile may hold: a real day, not in the future, not over 120 years ago.
pub fn parse_dob(s: String, now_ms: Int) -> Result(String, Nil) {
  use date <- result.try(parse_day(s))
  let today = day_of(now_ms)
  use <- bool_guard(calendar.naive_date_compare(date, today) != order.Gt)
  case age(s, today) {
    Some(a) if a <= max_age_years -> Ok(s)
    _ -> Error(Nil)
  }
}

/// The latest birth date of someone who has turned `years` by `today`, as text.
pub fn born_by(today: Date, years: Int) -> String {
  text_of(today.year - years, calendar.month_to_int(today.month), today.day)
}

/// Completed years on `today`, or `None` when the date of birth cannot be read.
pub fn age(dob: String, today: Date) -> Option(Int) {
  case parse_day(dob) {
    Error(Nil) -> None
    Ok(birth) -> {
      let years = today.year - birth.year
      let before_birthday =
        #(calendar.month_to_int(today.month), today.day)
        |> compare_pair(#(calendar.month_to_int(birth.month), birth.day))
        == order.Lt
      case before_birthday {
        True -> Some(years - 1)
        False -> Some(years)
      }
    }
  }
}

fn compare_pair(a: #(Int, Int), b: #(Int, Int)) -> order.Order {
  case int.compare(a.0, b.0) {
    order.Eq -> int.compare(a.1, b.1)
    other -> other
  }
}

pub fn age_on(dob: String, now_ms: Int) -> Option(Int) {
  age(dob, day_of(now_ms))
}

/// Adult only when the age is known and reaches the country's threshold.
pub fn is_adult(dob: String, country: String, now_ms: Int) -> Bool {
  case parse_day(dob) {
    Error(Nil) -> False
    Ok(_) ->
      string.compare(dob, born_by(day_of(now_ms), adult_age_for(country)))
      != order.Gt
  }
}

/// The SQL form of `is_adult` over a row's birth date and country columns.
pub fn adult_sql(dob: String, country: String, now_ms: Int) -> Fragment {
  let today = day_of(now_ms)
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
