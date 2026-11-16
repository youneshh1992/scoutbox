// Writes test/fixtures/zone_cases.json: random instants in random zones (and the moments around transitions),
// each with temporal.ts's localParts and zoneOffsetMinutes. test/scoutbox/zones_test.gleam checks platform/zones
// against them.   node dev/zone_cases.mjs
import fs from 'node:fs';
import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const TS = path.resolve(process.env.SCOUTBOX_TS_SERVER ?? path.join(HERE, '../../../scoutbox/scoutbox-server'));
const { localParts, zoneOffsetMinutes } = await import(path.join(TS, 'temporal.ts'));
const { aliases, zones } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'priv', 'zone_offsets.json'), 'utf8'));
const names = Object.keys(aliases);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const cases = [];
const add = (zone, ms) => {
  const p = localParts(ms, zone);
  cases.push({ zone, ms, parts: [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number), offset: zoneOffsetMinutes(ms, zone) });
};
const lo = Date.UTC(1900, 0, 1);
const hi = Date.UTC(2101, 0, 1);
for (let i = 0; i < 3000; i++) add(names[Math.floor(rand() * names.length)], lo + Math.floor(rand() * (hi - lo)));
for (const zone of ['Europe/London', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Asia/Kathmandu', 'Africa/Casablanca']) {
  for (const [from] of zones[aliases[zone]].slice(1)) if (from * 1000 >= lo && from * 1000 < hi) for (const d of [-1001, -1, 0, 999, 1000]) add(zone, from * 1000 + d);
}
fs.writeFileSync(path.join(HERE, '..', 'test', 'fixtures', 'zone_cases.json'), `${JSON.stringify(cases)}\n`);
console.log(`wrote test/fixtures/zone_cases.json: ${cases.length} cases`);
