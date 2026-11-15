// Writes test/fixtures/distance_cases.json: point pairs with what the TypeScript server's rules say about them
// (domain.ts haversineKm, the 50 km Grassroots radius, and distance_tenths' rounding). The Gleam test checks
// the SQL rules against every case. Regenerate with `node dev/distance_cases.mjs` (Node ≥ 22.18 strips types).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const domain = await import(path.join(HERE, '../../../scoutbox/scoutbox-server/domain.ts'));
const { haversineKm, GRASSROOTS_RADIUS_KM } = domain;

// A seeded generator, so the fixture is reproducible.
let seed = 20261115;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const cases = [];
const add = (a, b, why) => {
  const km = haversineKm(a, b);
  cases.push({ why, a, b, km, tenths: Math.round(km * 10), inRadius: km <= GRASSROOTS_RADIUS_KM });
};

// The point `km` from `from` along `bearing` (radians), found by bisection on haversineKm itself, so it is as
// close to the edge as a double allows by the TypeScript rule's own measure.
const along = (from, bearing, km) => {
  const at = (t) => ({ lat: from.lat + Math.cos(bearing) * t, lng: from.lng + Math.sin(bearing) * t });
  let lo = 0;
  let hi = 5;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (haversineKm(from, at(mid)) <= km) lo = mid;
    else hi = mid;
  }
  return [at(lo), at(hi)];
};

for (let i = 0; i < 400; i++) {
  const a = { lat: random() * 180 - 90, lng: random() * 360 - 180 };
  const b = { lat: random() * 180 - 90, lng: random() * 360 - 180 };
  add(a, b, 'random, anywhere');
}
for (let i = 0; i < 300; i++) {
  const a = { lat: 50 + random() * 8, lng: -6 + random() * 8 };
  const b = { lat: a.lat + (random() - 0.5) * 1.5, lng: a.lng + (random() - 0.5) * 2.5 };
  add(a, b, 'random, within about 100 km in the UK');
}
for (let i = 0; i < 200; i++) {
  const a = { lat: 50 + random() * 8, lng: -6 + random() * 8 };
  const [inside, outside] = along(a, random() * 2 * Math.PI, GRASSROOTS_RADIUS_KM);
  add(a, inside, 'the last point inside the radius');
  add(a, outside, 'the first point outside the radius');
}
for (let i = 0; i < 200; i++) {
  const a = { lat: 50 + random() * 8, lng: -6 + random() * 8 };
  const edge = Math.floor(random() * 600) / 10 + 0.05;
  const [below, above] = along(a, random() * 2 * Math.PI, edge);
  add(a, below, 'just below a rounding edge (x.x5 km)');
  add(a, above, 'just above a rounding edge (x.x5 km)');
}
add({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.1 }, 'the same point');
add({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 }, 'across the antimeridian');
add({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }, 'pole to pole');

const out = path.join(HERE, '../test/fixtures/distance_cases.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(cases)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`);
