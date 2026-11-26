// Writes priv/zone_offsets.json: every IANA zone's UTC offsets as Node's ICU (and so the TypeScript server's
// temporal.ts localParts) has them, from 1800 to 2200, so wall-clock rules here agree with it to the second.
//
// For each canonical zone it samples the offset once a day and, where two samples differ, finds the transition
// to the second by bisection. A zone is `[[fromSecond, offsetSeconds], …]`, oldest first; the first entry's
// `fromSecond` is null (since the beginning). `aliases` maps each name validateIanaZone accepts to its zone's
// canonical name. Then 200,000 random instants are checked against Intl.
//
//   node dev/zone_offsets.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, '..', 'priv', 'zone_offsets.json');
const FROM = Date.UTC(1800, 0, 1) / 1000;
const TO = Date.UTC(2200, 0, 1) / 1000;
const DAY = 86_400;

const formatter = (zone) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    era: 'short',
  });
const offsetWith = (f) => (s) => {
  const p = Object.fromEntries(f.formatToParts(new Date(s * 1000)).map((x) => [x.type, x.value]));
  let year = Number(p.year);
  if (p.era === 'BC' || p.era === 'B') year = 1 - year;
  const asUtc = Date.UTC(year, Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc / 1000 - s;
};

function zoneTable(zone) {
  const offset = offsetWith(formatter(zone));
  const out = [[null, offset(FROM)]];
  let prevS = FROM;
  let prev = out[0][1];
  for (let s = FROM + DAY; s <= TO; s += DAY) {
    const o = offset(s);
    // Every change between the samples: a day can hold more than one.
    while (o !== prev) {
      let lo = prevS;
      let hi = s;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offset(mid) === prev) lo = mid;
        else hi = mid;
      }
      prev = offset(hi);
      out.push([hi, prev]);
      prevS = hi;
    }
    prevS = s;
  }
  return out;
}

if (!isMainThread) {
  parentPort.postMessage(workerData.map((z) => [z, zoneTable(z)]));
} else {
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'scoutbox', 'rules', 'time_zones.gleam'), 'utf8');
  const names = [...source.matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1]);
  const canonical = (z) => new Intl.DateTimeFormat('en-GB', { timeZone: z }).resolvedOptions().timeZone;
  const aliases = Object.fromEntries(names.map((n) => [n, canonical(n)]));
  const zones = [...new Set(Object.values(aliases))].sort();
  const n = os.availableParallelism();
  const chunks = Array.from({ length: n }, (_, i) => zones.filter((_, j) => j % n === i));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: chunk });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    ),
  );
  const tables = Object.fromEntries(results.flat().sort(([a], [b]) => (a < b ? -1 : 1)));
  // Check against Intl at random instants, transitions included.
  const lookup = (table, s) => {
    let o = table[0][1];
    for (const [from, off] of table) if (from === null || from <= s) o = off;
    return o;
  };
  let checked = 0;
  for (let i = 0; i < 200_000; i++) {
    const z = zones[i % zones.length];
    const s = FROM + Math.floor(Math.random() * (TO - FROM));
    const want = offsetWith(formatter(z))(s);
    const got = lookup(tables[z], s);
    if (want !== got) throw new Error(`${z} at ${s}: Intl says ${want}, the table ${got}`);
    checked++;
  }
  for (const [z, t] of Object.entries(tables))
    for (const [from, off] of t.slice(1)) {
      const f = offsetWith(formatter(z));
      if (f(from) !== off || f(from - 1) === off) throw new Error(`${z}: the transition at ${from} is misplaced`);
    }
  fs.writeFileSync(OUT, `${JSON.stringify({ aliases, zones: tables })}\n`);
  const transitions = Object.values(tables).reduce((n, t) => n + t.length, 0);
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)}: ${zones.length} zones, ${transitions} offsets, ${checked} instants checked`,
  );
}
