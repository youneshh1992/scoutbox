//// Instants written as text, read as temporal.ts reads them: strictly, years 1900–2100.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/list
import gleam/option
import gleam/regexp
import gleam/result
import gleam/string
import gleam/time/calendar
import gleam/time/timestamp

/// A date a form may send as a calendar day or as an instant (parseDateOrInstant).
pub type Due {
  Day(start_ms: Int)
  Instant(ms: Int)
}

const day_ms = 86_400_000

/// The instant a due date starts at: a day's first millisecond.
pub fn start(d: Due) -> Int {
  case d {
    Day(ms) -> ms
    Instant(ms) -> ms
  }
}

/// The instant a due date ends at: for a day, the start of the next one (`dayEdge: 'end'`).
pub fn end(d: Due) -> Int {
  case d {
    Day(ms) -> ms + day_ms
    Instant(ms) -> ms
  }
}

const year_min = 1900

const year_max = 2100

/// The start of the UTC day `YYYY-MM-DD`, for a real day.
pub fn day_start_ms(s: String) -> Result(Int, Nil) {
  use #(year, month, day) <- result.try(day(s))
  use m <- result.try(calendar.month_from_int(month))
  let date = calendar.Date(year:, month: m, day:)
  case calendar.is_valid_date(date) && year >= year_min && year <= year_max {
    False -> Error(Nil)
    True ->
      Ok(
        timestamp.from_calendar(
          date,
          calendar.TimeOfDay(0, 0, 0, 0),
          calendar.utc_offset,
        )
        |> ms_of,
      )
  }
}

/// A calendar day `YYYY-MM-DD` (parseStrictDateOnly). Error: why not, in temporal.ts's words.
pub fn date_only(s: String) -> Result(String, String) {
  case day(s) {
    Error(Nil) -> Error("wrong shape")
    Ok(#(y, _, _)) if y < year_min || y > year_max ->
      Error(
        "year outside "
        <> int.to_string(year_min)
        <> "–"
        <> int.to_string(year_max),
      )
    Ok(#(_, m, _)) if m < 1 || m > 12 -> Error("no such month")
    Ok(#(_, _, d)) if d < 1 || d > 31 -> Error("no such day")
    Ok(_) ->
      case day_start_ms(s) {
        Ok(_) -> Ok(s)
        Error(Nil) -> Error("no such day in that month")
      }
  }
}

fn day(s: String) -> Result(#(Int, Int, Int), Nil) {
  let assert Ok(shape) = regexp.from_string("^(\\d{4})-(\\d{2})-(\\d{2})$")
  case regexp.check(shape, s), string.split(s, "-") {
    True, [y, m, d] -> {
      use y <- result.try(int.parse(y))
      use m <- result.try(int.parse(m))
      use d <- result.map(int.parse(d))
      #(y, m, d)
    }
    _, _ -> Error(Nil)
  }
}

fn ms_of(t: timestamp.Timestamp) -> Int {
  let #(seconds, nanos) = timestamp.to_unix_seconds_and_nanoseconds(t)
  seconds * 1000 + nanos / 1_000_000
}

/// An ISO 8601 date-time with an offset or Z (parseInstant). Error: why not, in temporal.ts's words.
pub fn instant_ms(s: String) -> Result(Int, String) {
  let assert Ok(shape) =
    regexp.from_string(
      "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?(Z|[+-]\\d{2}:\\d{2})$",
    )
  case regexp.scan(shape, s) {
    [regexp.Match(submatches: [_, _, _, hh, mm, ss, _, zone], ..)] -> {
      let n = fn(v) { v |> option_text |> int.parse |> result.unwrap(0) }
      let date = string.slice(s, 0, 10)
      case day_start_ms(date) {
        Error(Nil) -> Error("no such calendar day")
        Ok(_) ->
          case n(hh) > 23 || n(mm) > 59 || n(ss) > 59 {
            True -> Error("no such time of day")
            False ->
              case zone_ok(option_text(zone)) {
                False -> Error("no such offset")
                True ->
                  case timestamp.parse_rfc3339(with_seconds(s)) {
                    Error(Nil) -> Error("not a real date-time")
                    Ok(t) -> {
                      let ms = ms_of(t)
                      let #(d, _) =
                        timestamp.to_calendar(t, calendar.utc_offset)
                      case d.year < year_min || d.year > year_max {
                        True ->
                          Error(
                            "year outside "
                            <> int.to_string(year_min)
                            <> "–"
                            <> int.to_string(year_max),
                          )
                        False -> Ok(ms)
                      }
                    }
                  }
              }
          }
      }
    }
    _ -> Error("wrong shape")
  }
}

fn option_text(v) -> String {
  case v {
    option.Some(t) -> t
    option.None -> ""
  }
}

fn zone_ok(zone: String) -> Bool {
  case zone {
    "Z" -> True
    _ -> {
      let parts = zone |> string.drop_start(1) |> string.split(":")
      case list.map(parts, int.parse) {
        [Ok(h), Ok(m)] -> h <= 14 && m <= 59
        _ -> False
      }
    }
  }
}

/// RFC 3339 needs seconds; ISO 8601 lets `HH:MM` stand for `HH:MM:00`.
fn with_seconds(s: String) -> String {
  let assert Ok(short) = regexp.from_string("^(.{10}T\\d{2}:\\d{2})(Z|[+-].*)$")
  regexp.replace(short, s, "\\1:00\\2")
}

/// parseInstant over a value as sent: ISO 8601 with an explicit offset or `Z`, or an integer millisecond
/// timestamp, its UTC year in `year_min`–`year_max`. A bare local time or a date-only string is refused. Error: why
/// not, in temporal.ts's words.
pub fn instant(
  v: Dynamic,
  year_min: Int,
  year_max: Int,
) -> Result(Int, String) {
  let year_ok = fn(ms) {
    let #(date, _) =
      timestamp.from_unix_seconds_and_nanoseconds(
        int.floor_divide(ms, 1000) |> result.unwrap(0),
        0,
      )
      |> timestamp.to_calendar(calendar.utc_offset)
    case date.year < year_min || date.year > year_max {
      True ->
        Error(
          "year outside "
          <> int.to_string(year_min)
          <> "–"
          <> int.to_string(year_max),
        )
      False -> Ok(ms)
    }
  }
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> year_ok(n)
    _, Ok(f) ->
      case float.floor(f) == f {
        True -> year_ok(float.truncate(f))
        False -> Error("not a whole number")
      }
    _, _ ->
      case decode.run(v, decode.string) {
        Ok(s) ->
          case string.slice(s, 0, 4) |> int.parse {
            Ok(y) if y < year_min || y > year_max ->
              case instant_ms(s) {
                Error("wrong shape") -> Error("wrong shape")
                _ -> Error("no such calendar day")
              }
            _ -> result.try(instant_ms(s), year_ok)
          }
        Error(_) -> Error("not a date-time")
      }
  }
}
