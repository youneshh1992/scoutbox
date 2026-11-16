import gleam/int
import gleam/string
import gleam/time/calendar
import gleam/time/timestamp

/// Milliseconds since the Unix epoch: the unit every stored instant uses.
pub fn now_ms() -> Int {
  let #(seconds, nanoseconds) =
    timestamp.system_time() |> timestamp.to_unix_seconds_and_nanoseconds
  seconds * 1000 + nanoseconds / 1_000_000
}

/// An instant as JavaScript's `toISOString` writes it: UTC, milliseconds, `Z`.
pub fn iso(ms: Int) -> String {
  let #(date, time) =
    timestamp.from_unix_seconds_and_nanoseconds(
      ms / 1000,
      { ms % 1000 } * 1_000_000,
    )
    |> timestamp.to_calendar(calendar.utc_offset)
  let pad = fn(n, w) { int.to_string(n) |> string.pad_start(w, "0") }
  pad(date.year, 4)
  <> "-"
  <> pad(calendar.month_to_int(date.month), 2)
  <> "-"
  <> pad(date.day, 2)
  <> "T"
  <> pad(time.hours, 2)
  <> ":"
  <> pad(time.minutes, 2)
  <> ":"
  <> pad(time.seconds, 2)
  <> "."
  <> pad(ms % 1000, 3)
  <> "Z"
}

/// A day as JavaScript's `toDateString` writes it (`Mon Nov 16 2026`), in UTC: the TypeScript server's own zone
/// when it runs in UTC, as its batteries do.
pub fn date_string(ms: Int) -> String {
  let days = int.floor_divide(ms, 86_400_000) |> result_or(0)
  let weekday = case int.modulo(days + 4, 7) |> result_or(0) {
    0 -> "Sun"
    1 -> "Mon"
    2 -> "Tue"
    3 -> "Wed"
    4 -> "Thu"
    5 -> "Fri"
    _ -> "Sat"
  }
  let #(date, _) =
    timestamp.from_unix_seconds(days * 86_400)
    |> timestamp.to_calendar(calendar.utc_offset)
  let month = calendar.month_to_string(date.month) |> string.slice(0, 3)
  weekday
  <> " "
  <> month
  <> " "
  <> { int.to_string(date.day) |> string.pad_start(2, "0") }
  <> " "
  <> int.to_string(date.year)
}

fn result_or(r: Result(a, e), default: a) -> a {
  case r {
    Ok(v) -> v
    Error(_) -> default
  }
}
