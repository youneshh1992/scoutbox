//// Wall-clock time in a zone agrees with temporal.ts (localParts, zoneOffsetMinutes) at random instants and at
//// either side of real transitions (test/fixtures/zone_cases.json, from dev/zone_cases.mjs).

import gleam/dynamic/decode
import gleam/json
import gleam/list
import scoutbox/platform/zones
import simplifile

pub fn local_parts_agree_with_temporal_ts_test() {
  let assert Ok(text) = simplifile.read("test/fixtures/zone_cases.json")
  let assert Ok(cases) =
    json.parse(
      text,
      decode.list({
        use zone <- decode.field("zone", decode.string)
        use ms <- decode.field("ms", decode.int)
        use parts <- decode.field("parts", decode.list(decode.int))
        use offset <- decode.field("offset", decode.int)
        decode.success(#(zone, ms, parts, offset))
      }),
    )
  assert list.length(cases) > 3000
  list.each(cases, fn(c) {
    let #(zone, ms, parts, offset) = c
    let assert Ok(zone) = zones.parse(zone)
    let p = zones.local_parts(ms, zone)
    assert [p.year, p.month, p.day, p.hour, p.minute, p.second] == parts
    assert zones.offset_minutes(zone, ms) == offset
  })
}
