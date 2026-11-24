//// Wall-clock time in a zone, at random instants and either side of real transitions, as blessed in
//// test/fixtures/zone_cases.json (first blessed from temporal.ts's localParts and zoneOffsetMinutes). Re-bless after
//// a tzdb update (dev/zone_offsets.mjs) and review the instants that moved.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import scoutbox/blessed
import scoutbox/platform/zones

pub fn local_parts_are_the_blessed_ones_test() {
  let f = blessed.load("zone_cases")
  let cases = blessed.items(blessed.root(f))
  assert list.length(cases) > 3000
  list.flat_map(cases, fn(c) {
    let name = blessed.read(blessed.field(c, "zone"), decode.string)
    let ms = blessed.read(blessed.field(c, "ms"), decode.int)
    let assert Ok(zone) = zones.parse(name)
    let p = zones.local_parts(ms, zone)
    let what = name <> " at " <> json.to_string(json.int(ms))
    [
      blessed.answer(
        blessed.field(c, "parts"),
        what,
        json.array(
          [p.year, p.month, p.day, p.hour, p.minute, p.second],
          json.int,
        ),
      ),
      blessed.answer(
        blessed.field(c, "offset"),
        what <> " (offset)",
        json.int(zones.offset_minutes(zone, ms)),
      ),
    ]
  })
  |> blessed.check(f, _)
}
