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
