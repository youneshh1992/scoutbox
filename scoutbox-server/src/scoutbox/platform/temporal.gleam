//// Dates and instants, read as temporal.ts reads them: strictly, years 1900–2100 unless a rule names other bounds.
//// A value is read once, where it arrives, into a `Day` or a millisecond instant; what can't be read is a typed
//// problem, which only the HTTP edge turns into temporal.ts's words (`day_why`, `instant_why`, `due_why`).
////
//// Instants are whole milliseconds since the epoch, UTC, as every stored timestamp column is.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order.{type Order}
import gleam/result
import gleam/string
import gleam/time/calendar
import scoutbox/platform/zones.{type Zone}
import sqlight

pub const year_min = 1900

pub const year_max = 2100

pub const day_ms = 86_400_000

// ------------------------------------------------------------------------------------------------- days

/// A calendar day that exists, read in UTC. Only `parse_day` and `day_of` make one.
pub opaque type Day {
  Day(year: Int, month: Int, day: Int)
}

/// Why text is not a calendar day (parseStrictDateOnly's `why`).
pub type DayProblem {
  DayNotText
  DayWrongShape
  DayYearOutside(min: Int, max: Int)
  NoSuchMonth
  NoSuchDay
  NoSuchDayInMonth
}

/// A calendar day written `YYYY-MM-DD`, its year 1900–2100 (parseStrictDateOnly).
pub fn parse_day(s: String) -> Result(Day, DayProblem) {
  parse_day_between(s, year_min, year_max)
}

/// `parse_day` with a rule's own year bounds.
pub fn parse_day_between(
  s: String,
  min: Int,
  max: Int,
) -> Result(Day, DayProblem) {
  use #(y, m, d) <- result.try(
    digits_of(s, "-", "-", "") |> result.replace_error(DayWrongShape),
  )
  case y < min || y > max, m < 1 || m > 12, d < 1 || d > 31 {
    True, _, _ -> Error(DayYearOutside(min, max))
    _, True, _ -> Error(NoSuchMonth)
    _, _, True -> Error(NoSuchDay)
    _, _, _ ->
      case d <= days_in_month(y, m) {
        True -> Ok(Day(y, m, d))
        False -> Error(NoSuchDayInMonth)
      }
  }
}

/// `parse_day` over a value as sent: anything but text is `DayNotText`.
pub fn read_day(v: Dynamic) -> Result(Day, DayProblem) {
  case decode.run(v, decode.string) {
    Ok(s) -> parse_day(s)
    Error(_) -> Error(DayNotText)
  }
}

/// The UTC calendar day an instant falls on (utcDayOf).
pub fn day_of(ms: Int) -> Day {
  let #(y, m, d) = civil_from_days(floor_div(ms, day_ms))
  Day(y, m, d)
}

/// The day as `YYYY-MM-DD`.
pub fn day_text(d: Day) -> String {
  pad(d.year, 4) <> "-" <> pad(d.month, 2) <> "-" <> pad(d.day, 2)
}

pub fn day_json(d: Day) -> Json {
  json.string(day_text(d))
}

/// A stored day: `YYYY-MM-DD` text that is a real day of any year. Its writer checked the column's own
/// bounds, so the reader only refuses text that is no day at all, which fails the read.
pub fn day_decoder() -> decode.Decoder(Day) {
  use s <- decode.then(decode.string)
  case parse_day_between(s, 0, 9999) {
    Ok(d) -> decode.success(d)
    Error(_) -> decode.failure(Day(1970, 1, 1), "a YYYY-MM-DD day")
  }
}

/// The day bound as its `YYYY-MM-DD` text.
pub fn day_sql(d: Day) -> sqlight.Value {
  sqlight.text(day_text(d))
}

/// The day's first instant, 00:00 UTC.
pub fn day_start(d: Day) -> Int {
  days_from_civil(d.year, d.month, d.day) * day_ms
}

/// The first instant after the day (endOfDayExclusive): a day-precision end covers the whole day.
pub fn day_end(d: Day) -> Int {
  day_start(d) + day_ms
}

pub fn day_date(d: Day) -> calendar.Date {
  let assert Ok(month) = calendar.month_from_int(d.month)
  calendar.Date(year: d.year, month:, day: d.day)
}

pub fn day_year(d: Day) -> Int {
  d.year
}

pub fn day_month(d: Day) -> Int {
  d.month
}

pub fn day_of_month(d: Day) -> Int {
  d.day
}

pub fn compare_days(a: Day, b: Day) -> Order {
  int.compare(day_start(a), day_start(b))
}

/// The day `n` days after `d` (before it, for a negative `n`).
pub fn add_days(d: Day, n: Int) -> Day {
  day_of(day_start(d) + n * day_ms)
}

/// Is `d` inside a window of stored days, both ends included (isDayWithin)? An absent or blank bound is open; one
/// that can't be read closes the window.
pub fn is_day_within(d: Day, from: Option(String), to: Option(String)) -> Bool {
  let bound = fn(b: Option(String), ok: fn(Order) -> Bool) {
    case b {
      None | Some("") -> True
      Some(text) ->
        case parse_day(text) {
          Ok(b) -> ok(compare_days(d, b))
          Error(_) -> False
        }
    }
  }
  bound(from, fn(o) { o != order.Lt }) && bound(to, fn(o) { o != order.Gt })
}

pub fn day_why(p: DayProblem) -> String {
  case p {
    DayNotText -> "not text"
    DayWrongShape -> "wrong shape"
    DayYearOutside(min, max) -> year_outside(min, max)
    NoSuchMonth -> "no such month"
    NoSuchDay -> "no such day"
    NoSuchDayInMonth -> "no such day in that month"
  }
}

// --------------------------------------------------------------------------------------------- instants

/// Why a value is not an instant (parseInstant's `why`).
pub type InstantProblem {
  NotAWholeNumber
  NotADateTime
  InstantWrongShape
  NoSuchCalendarDay
  NoSuchTimeOfDay
  NoSuchOffset
  InstantYearOutside(min: Int, max: Int)
}

/// An ISO 8601 date-time with an offset or Z, its UTC year 1900–2100 (parseInstant over text). A bare local time
/// or a date-only string is refused.
pub fn instant_ms(s: String) -> Result(Int, InstantProblem) {
  instant_text(s, year_min, year_max)
}

/// parseInstant over a value as sent: ISO 8601 with an offset or Z, or integer milliseconds, its UTC year within
/// the bounds. A numeric string is text, refused.
pub fn instant(v: Dynamic, min: Int, max: Int) -> Result(Int, InstantProblem) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> year_checked(n, min, max)
    _, Ok(f) ->
      case float.floor(f) == f {
        True -> year_checked(float.truncate(f), min, max)
        False -> Error(NotAWholeNumber)
      }
    _, _ ->
      case decode.run(v, decode.string) {
        Ok(s) -> instant_text(s, min, max)
        Error(_) -> Error(NotADateTime)
      }
  }
}

fn instant_text(s: String, min: Int, max: Int) -> Result(Int, InstantProblem) {
  use #(date, rest) <- result.try(
    split_at(s, 10) |> result.replace_error(InstantWrongShape),
  )
  use #(time, zone) <- result.try(
    clock_and_zone(rest) |> result.replace_error(InstantWrongShape),
  )
  use _ <- result.try(
    digits_of(date, "-", "-", "") |> result.replace_error(InstantWrongShape),
  )
  use day <- result.try(
    parse_day_between(date, min, max)
    |> result.replace_error(NoSuchCalendarDay),
  )
  let #(hh, mm, ss, millis) = time
  use <- guard(hh > 23 || mm > 59 || ss > 59, NoSuchTimeOfDay)
  use offset_minutes <- result.try(zone)
  let ms =
    day_start(day)
    + { { hh * 60 + mm - offset_minutes } * 60 + ss }
    * 1000
    + millis
  year_checked(ms, min, max)
}

fn year_checked(ms: Int, min: Int, max: Int) -> Result(Int, InstantProblem) {
  let year = day_of(ms).year
  case year < min || year > max {
    True -> Error(InstantYearOutside(min, max))
    False -> Ok(ms)
  }
}

/// `THH:MM[:SS[.f{1,3}]]` then `Z` or `±HH:MM`: the time, and the offset in minutes east or why it isn't one.
fn clock_and_zone(
  s: String,
) -> Result(#(#(Int, Int, Int, Int), Result(Int, InstantProblem)), Nil) {
  use #(head, zone) <- result.try(case string.ends_with(s, "Z") {
    True -> Ok(#(string.drop_end(s, 1), "Z"))
    False -> {
      let n = string.length(s)
      use #(head, zone) <- result.try(split_at(s, n - 6))
      case string.first(zone) {
        Ok("+") | Ok("-") -> Ok(#(head, zone))
        _ -> Error(Nil)
      }
    }
  })
  use time <- result.try(wall_clock(head, True))
  let offset = case zone {
    "Z" -> Ok(Ok(0))
    _ -> {
      use #(sign, hm) <- result.try(string.pop_grapheme(zone))
      use #(oh, om, _) <- result.map(digits_of(hm, ":", "", ""))
      case oh > 14 || om > 59 {
        True -> Error(NoSuchOffset)
        False ->
          case sign {
            "-" -> Ok(0 - { oh * 60 + om })
            _ -> Ok(oh * 60 + om)
          }
      }
    }
  }
  use offset <- result.map(offset)
  #(time, offset)
}

/// `THH:MM[:SS]`, with `.f{1,3}` after the seconds when `fraction`: hours, minutes, seconds, milliseconds.
fn wall_clock(s: String, fraction: Bool) -> Result(#(Int, Int, Int, Int), Nil) {
  case string.pop_grapheme(s) {
    Ok(#("T", rest)) ->
      case string.split(rest, ":") {
        [h, m] -> {
          use #(hh, mm) <- result.map(two_digit_pair(h, m))
          #(hh, mm, 0, 0)
        }
        [h, m, sec] -> {
          use #(hh, mm) <- result.try(two_digit_pair(h, m))
          let #(whole, frac) = case string.split_once(sec, ".") {
            Ok(#(w, f)) -> #(w, Some(f))
            Error(Nil) -> #(sec, None)
          }
          use ss <- result.try(two_digits(whole))
          use millis <- result.map(case frac, fraction {
            None, _ -> Ok(0)
            Some(_), False -> Error(Nil)
            Some(f), True -> {
              let n = string.length(f)
              use <- all_or_nothing(n >= 1 && n <= 3 && all_digits(f))
              use v <- result.map(int.parse(f))
              v * pow10(3 - n)
            }
          })
          #(hh, mm, ss, millis)
        }
        _ -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

fn pow10(n: Int) -> Int {
  case n {
    0 -> 1
    _ -> 10 * pow10(n - 1)
  }
}

fn two_digit_pair(a: String, b: String) -> Result(#(Int, Int), Nil) {
  use x <- result.try(two_digits(a))
  use y <- result.map(two_digits(b))
  #(x, y)
}

fn two_digits(s: String) -> Result(Int, Nil) {
  case string.length(s) == 2 && all_digits(s) {
    True -> int.parse(s)
    False -> Error(Nil)
  }
}

pub fn instant_why(p: InstantProblem) -> String {
  case p {
    NotAWholeNumber -> "not a whole number"
    NotADateTime -> "not a date-time"
    InstantWrongShape -> "wrong shape"
    NoSuchCalendarDay -> "no such calendar day"
    NoSuchTimeOfDay -> "no such time of day"
    NoSuchOffset -> "no such offset"
    InstantYearOutside(min, max) -> year_outside(min, max)
  }
}

// ------------------------------------------------------------------------------------------ day or instant

/// A date a form may send as a calendar day or as an instant (parseDateOrInstant), keeping which it was.
pub type Due {
  OnDay(Day)
  AtInstant(ms: Int)
}

pub type DueProblem {
  DueDay(DayProblem)
  DueInstant(InstantProblem)
}

/// Text shaped `YYYY-MM-DD` is read as a day (and refused as one); anything else as an instant.
pub fn parse_due(v: Dynamic) -> Result(Due, DueProblem) {
  case decode.run(v, decode.string) {
    Ok(s) ->
      case digits_of(s, "-", "-", "") {
        Ok(_) -> parse_day(s) |> result.map(OnDay) |> result.map_error(DueDay)
        Error(Nil) ->
          instant_text(s, year_min, year_max)
          |> result.map(AtInstant)
          |> result.map_error(DueInstant)
      }
    Error(_) ->
      instant(v, year_min, year_max)
      |> result.map(AtInstant)
      |> result.map_error(DueInstant)
  }
}

/// The instant a due date starts at: a day's first millisecond (`dayEdge: 'start'`).
pub fn start(d: Due) -> Int {
  case d {
    OnDay(day) -> day_start(day)
    AtInstant(ms) -> ms
  }
}

/// The instant a due date ends at: for a day, the start of the next one (`dayEdge: 'end'`).
pub fn end(d: Due) -> Int {
  case d {
    OnDay(day) -> day_end(day)
    AtInstant(ms) -> ms
  }
}

pub fn due_why(p: DueProblem) -> String {
  case p {
    DueDay(p) -> day_why(p)
    DueInstant(p) -> instant_why(p)
  }
}

// --------------------------------------------------------------------------------- wall time in a zone

/// How to read a wall-clock time a zone's clocks pass twice.
pub type Resolve {
  /// Refuse it (LOCAL_TIME_AMBIGUOUS): nothing picks silently.
  RefuseAmbiguous
  Earlier
  Later
}

/// A wall-clock time's instant in a zone.
pub type LocalInstant {
  LocalInstant(ms: Int, offset_minutes: Int, ambiguous: Bool)
}

pub type LocalProblem {
  LocalWrongShape
  LocalNoSuchCalendarDay
  LocalNoSuchTimeOfDay
  /// The time falls in a spring-forward gap (LOCAL_TIME_NONEXISTENT).
  Nonexistent
  /// The time happens twice (LOCAL_TIME_AMBIGUOUS): its instants, earliest first.
  Ambiguous(candidates: List(Int))
}

/// `YYYY-MM-DDTHH:MM[:SS]` in `zone`, honestly (parseLocalDateTimeWithZone): one instant on an ordinary day, none
/// inside a spring-forward gap, two inside a fall-back overlap, which only `resolve` may choose between.
pub fn local_instant(
  local: String,
  zone: Zone,
  resolve: Resolve,
) -> Result(LocalInstant, LocalProblem) {
  use #(date, rest) <- result.try(
    split_at(local, 10) |> result.replace_error(LocalWrongShape),
  )
  use _ <- result.try(
    digits_of(date, "-", "-", "") |> result.replace_error(LocalWrongShape),
  )
  use #(hh, mm, ss, _) <- result.try(
    wall_clock(rest, False) |> result.replace_error(LocalWrongShape),
  )
  use day <- result.try(
    parse_day(date) |> result.replace_error(LocalNoSuchCalendarDay),
  )
  use <- guard(hh > 23 || mm > 59 || ss > 59, LocalNoSuchTimeOfDay)
  let wall_as_utc = day_start(day) + { { hh * 60 + mm } * 60 + ss } * 1000
  let wanted = #(day, hh, mm, ss)
  // Every offset the zone uses within a day either side is a candidate; a candidate is real only if it reads back
  // as the same wall time.
  let candidates =
    [wall_as_utc - day_ms, wall_as_utc, wall_as_utc + day_ms]
    |> list.map(zones.offset_minutes(zone, _))
    |> list.unique
    |> list.filter_map(fn(off) {
      let ms = wall_as_utc - off * 60_000
      let p = zones.local_parts(ms, zone)
      let seen = #(Day(p.year, p.month, p.day), p.hour, p.minute, p.second)
      case seen == wanted {
        True -> Ok(#(ms, off))
        False -> Error(Nil)
      }
    })
    |> list.sort(fn(a, b) { int.compare(a.0, b.0) })
  case candidates, resolve {
    [], _ -> Error(Nonexistent)
    [#(ms, off)], _ -> Ok(LocalInstant(ms, off, False))
    [#(ms, off), ..], Earlier -> Ok(LocalInstant(ms, off, True))
    [_, ..], Later -> {
      let assert Ok(#(ms, off)) = list.last(candidates)
      Ok(LocalInstant(ms, off, True))
    }
    _, RefuseAmbiguous -> Error(Ambiguous(list.map(candidates, fn(c) { c.0 })))
  }
}

pub fn local_why(p: LocalProblem) -> String {
  case p {
    LocalWrongShape -> "wrong shape"
    LocalNoSuchCalendarDay -> "no such calendar day"
    LocalNoSuchTimeOfDay -> "no such time of day"
    Nonexistent ->
      "this wall-clock time does not occur in this zone (clocks go forward)"
    Ambiguous(_) ->
      "this wall-clock time occurs twice in this zone (clocks go back)"
  }
}

// ---------------------------------------------------------------------------------------------- predicates

/// Start strictly before end, or at it when `allow_equal` (isOrderedInterval).
pub fn is_ordered(start: Int, end: Int, allow_equal: Bool) -> Bool {
  case allow_equal {
    True -> start <= end
    False -> start < end
  }
}

/// Has an expiry passed at `now` (isExpiredAt)? No expiry never passes; it has passed at exactly `until`.
pub fn is_expired_at(until: Option(Int), now: Int) -> Bool {
  case until {
    None -> False
    Some(u) -> now >= u
  }
}

/// Is a window in force at `now` (isEffectiveAt)? Its start reached, and its end, when it has one, not yet.
pub fn is_effective_at(from: Int, to: Option(Int), now: Int) -> Bool {
  from <= now && !is_expired_at(to, now)
}

// --------------------------------------------------------------------------------------------- arithmetic

fn year_outside(min: Int, max: Int) -> String {
  "year outside " <> int.to_string(min) <> "–" <> int.to_string(max)
}

/// `DDDD<a>DD<b>DD<c>` exactly, all ASCII digits: the three numbers. It reads the bytes: text that is ten
/// digits and separators as graphemes is the same ten bytes, and anything else matches neither shape.
fn digits_of(
  s: String,
  a: String,
  b: String,
  c: String,
) -> Result(#(Int, Int, Int), Nil) {
  case <<s:utf8>> {
    <<y1, y2, y3, y4, sa, m1, m2, sb, d1, d2>> if c == "" -> {
      use <- all_or_nothing(<<sa>> == <<a:utf8>> && <<sb>> == <<b:utf8>>)
      use y <- result.try(number([y1, y2, y3, y4], 0))
      use m <- result.try(number([m1, m2], 0))
      use d <- result.map(number([d1, d2], 0))
      #(y, m, d)
    }
    <<h1, h2, sa, m1, m2>> if b == "" && c == "" -> {
      use <- all_or_nothing(<<sa>> == <<a:utf8>>)
      use h <- result.try(number([h1, h2], 0))
      use m <- result.map(number([m1, m2], 0))
      #(h, m, 0)
    }
    _ -> Error(Nil)
  }
}

/// ASCII digit bytes as the number they write.
fn number(bytes: List(Int), acc: Int) -> Result(Int, Nil) {
  case bytes {
    [] -> Ok(acc)
    [b, ..rest] if b >= 48 && b <= 57 -> number(rest, acc * 10 + b - 48)
    _ -> Error(Nil)
  }
}

fn all_digits(s: String) -> Bool {
  s != ""
  && string.to_utf_codepoints(s)
  |> list.all(fn(c) {
    let n = string.utf_codepoint_to_int(c)
    n >= 48 && n <= 57
  })
}

fn split_at(s: String, n: Int) -> Result(#(String, String), Nil) {
  case n > 0 && string.length(s) > n {
    True -> Ok(#(string.slice(s, 0, n), string.drop_start(s, n)))
    False -> Error(Nil)
  }
}

fn all_or_nothing(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

fn guard(bad: Bool, problem: e, next: fn() -> Result(a, e)) -> Result(a, e) {
  case bad {
    True -> Error(problem)
    False -> next()
  }
}

fn days_in_month(y: Int, m: Int) -> Int {
  case m {
    2 ->
      case calendar.is_leap_year(y) {
        True -> 29
        False -> 28
      }
    4 | 6 | 9 | 11 -> 30
    _ -> 31
  }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: Int, m: Int, d: Int) -> Int {
  let y = case m <= 2 {
    True -> y - 1
    False -> y
  }
  let era = floor_div(y, 400)
  let yoe = y - era * 400
  let mp = { m + 9 } % 12
  let doy = { 153 * mp + 2 } / 5 + d - 1
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146_097 + doe - 719_468
}

/// The date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: Int) -> #(Int, Int, Int) {
  let z = days + 719_468
  let era = floor_div(z, 146_097)
  let doe = z - era * 146_097
  let yoe = { doe - doe / 1460 + doe / 36_524 - doe / 146_096 } / 365
  let doy = doe - { 365 * yoe + yoe / 4 - yoe / 100 }
  let mp = { 5 * doy + 2 } / 153
  let d = doy - { 153 * mp + 2 } / 5 + 1
  let m = case mp < 10 {
    True -> mp + 3
    False -> mp - 9
  }
  let y = yoe + era * 400
  case m <= 2 {
    True -> #(y + 1, m, d)
    False -> #(y, m, d)
  }
}

fn floor_div(a: Int, b: Int) -> Int {
  int.floor_divide(a, b) |> result.unwrap(0)
}

fn pad(n: Int, width: Int) -> String {
  int.to_string(n) |> string.pad_start(width, "0")
}
