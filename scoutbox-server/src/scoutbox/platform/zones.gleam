//// Wall-clock time in an IANA zone, as temporal.ts's `localParts` and `zoneOffsetMinutes` give it. OTP has no
//// time-zone database, so the offsets come from Node's own ICU: `dev/zone_offsets.mjs` records every zone's
//// transitions from 1800 to 2200 into `priv/zone_offsets.json`, checked against Intl. The table is read once and
//// kept for the life of the node.

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/time/calendar
import gleam/time/timestamp
import global_value
import simplifile
import wisp

type Table {
  Table(
    aliases: Dict(String, String),
    /// Each zone's offsets newest first: `#(from second, offset seconds)`, the oldest from the beginning.
    zones: Dict(String, List(#(Option(Int), Int))),
  )
}

fn table() -> Table {
  global_value.create_with_unique_name("scoutbox/platform/zones.table", fn() {
    let assert Ok(priv) = wisp.priv_directory("scoutbox")
    let assert Ok(text) = simplifile.read(priv <> "/zone_offsets.json")
    let entry = {
      use from <- decode.field(0, decode.optional(decode.int))
      use offset <- decode.field(1, decode.int)
      decode.success(#(from, offset))
    }
    let decoder = {
      use aliases <- decode.field(
        "aliases",
        decode.dict(decode.string, decode.string),
      )
      use zones <- decode.field(
        "zones",
        decode.dict(decode.string, decode.list(entry)),
      )
      decode.success(Table(
        aliases:,
        zones: dict.map_values(zones, fn(_, t) { list.reverse(t) }),
      ))
    }
    let assert Ok(table) = json.parse(text, decoder)
      as "priv/zone_offsets.json is missing or unreadable: run node dev/zone_offsets.mjs"
    table
  })
}

/// An IANA time zone this server knows, by the exact name it was given (validateIanaZone). Only `parse` and
/// `stored` make one, so no rule is asked about a zone it can't read.
pub opaque type Zone {
  Zone(name: String)
}

/// A zone name as sent: exact case, no folding, no fallback (validateIanaZone accepts exactly the table's names).
pub fn parse(name: String) -> Result(Zone, Nil) {
  case dict.has_key(table().aliases, name) {
    True -> Ok(Zone(name))
    False -> Error(Nil)
  }
}

/// A zone a row holds. Every write takes it through `parse`; a name the table doesn't know reads as UTC.
pub fn stored(name: String) -> Zone {
  parse(name) |> result.unwrap(utc())
}

pub fn utc() -> Zone {
  Zone("UTC")
}

pub fn name(zone: Zone) -> String {
  zone.name
}

/// The zone's UTC offset at `ms`, in seconds east of Greenwich.
pub fn offset_seconds(zone: Zone, ms: Int) -> Int {
  let t = table()
  let s = floor_div(ms, 1000)
  case dict.get(t.aliases, zone.name) |> result.try(dict.get(t.zones, _)) {
    Error(Nil) -> 0
    Ok(offsets) ->
      list.find(offsets, fn(o) {
        case o.0 {
          None -> True
          Some(from) -> from <= s
        }
      })
      |> result.map(fn(o) { o.1 })
      |> result.unwrap(0)
  }
}

/// The zone's UTC offset at `ms`, in whole minutes east (zoneOffsetMinutes), rounded as JavaScript's
/// `Math.round` does: half a minute rounds up.
pub fn offset_minutes(zone: Zone, ms: Int) -> Int {
  floor_div(2 * offset_seconds(zone, ms) + 60, 120)
}

pub type LocalParts {
  LocalParts(
    year: Int,
    month: Int,
    day: Int,
    hour: Int,
    minute: Int,
    second: Int,
    weekday: calendar.DayOfWeek,
  )
}

/// The wall-clock date and time at `ms` in `zone`, to the second.
pub fn local_parts(ms: Int, zone: Zone) -> LocalParts {
  // gleam_time rounds an offset to whole minutes, and some zones' early offsets have seconds: add it here.
  let #(date, time) =
    timestamp.from_unix_seconds(floor_div(ms, 1000) + offset_seconds(zone, ms))
    |> timestamp.to_calendar(calendar.utc_offset)
  LocalParts(
    year: date.year,
    month: calendar.month_to_int(date.month),
    day: date.day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
    weekday: calendar.day_of_week(date),
  )
}

fn floor_div(a: Int, b: Int) -> Int {
  case int.floor_divide(a, b) {
    Ok(q) -> q
    Error(Nil) -> 0
  }
}
