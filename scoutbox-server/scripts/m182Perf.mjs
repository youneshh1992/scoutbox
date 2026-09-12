// M18.2 performance probe — what the cleanup costs, measured.
//
// M18.2 put four things on every request or every read:
//
//   • the HTTP contract middleware — one header set per response and a
//     wrapped res.json;
//   • the fault layer — a rule scan per request (zero rules in normal use);
//   • payload minimisation — an allowlist filter per broadcast;
//   • notification preference enforcement — a category lookup and a
//     preference read per notification created.
//
// And two things at boot: the migration registry and the integrity check,
// which are linear in snapshot size and run once.
//
// It also answers matrix #18 honestly: is `findPlayer` (an O(n) scan on
// every request that names a player) worth an index? The scan is timed at
// the seeded size and at 10× and 100× that, so the decision is a number,
// not a feeling.
//
// Measurements only. No SLA is claimed; every figure is from one machine
// with a warm process and a small seeded dataset.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { minimizePayload, eventFingerprint } from '../m182/eventRegistry.mjs';
import { categoryOf, registerNotificationPrefs } from '../m182/notificationPrefs.mjs';
import { runMigrations } from '../m182/migrations.mjs';
import { integrityReport } from '../m182/integrity.mjs';
import { createFaultLayer } from '../m182/faults.mjs';
import { ageOn } from '../domain.mjs';
import { briefIsLiveOn } from '../m18/shared.mjs';

const PORT = 5920 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m182perf-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const micro = (label, fn, iters = 200_000) => {
  for (let i = 0; i < iters / 10; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const ns = ((performance.now() - t0) * 1e6) / iters;
  console.log(`${label.padEnd(56)} ${ns.toFixed(0)} ns/op`);
  return ns;
};

console.log('\n— in-process cost of the M18.2 primitives —\n');
{
  micro('minimizePayload(recruitment_room_archived, 5 keys)', () => minimizePayload('recruitment_room_archived', { orgId: 'o', roomId: 'r', note: 'x', dob: 'y', name: 'z' }));
  micro('eventFingerprint(recruitment_room_archived)', () => eventFingerprint('recruitment_room_archived', { orgId: 'o', roomId: 'r' }));
  micro('categoryOf(recruitment_room, mention text)', () => categoryOf('recruitment_room', 'Maria Keane mentioned you in the Recruitment Room for K.'));
  const db = { notificationPrefs: [] };
  const stub = { get() {}, put() {} };
  const { allows } = registerNotificationPrefs({ db, orgRouter: stub, playerRouter: stub, guardianRouter: stub, persist() {} });
  for (let i = 0; i < 500; i++) db.notificationPrefs.push({ audienceKind: 'org_user', audienceId: `u-${i}`, categories: { mentions: i % 2 === 0 }, emailIntent: false });
  micro('notification allows() — 500 stored preference rows', () => allows({ kind: 'org_user', id: 'u-250' }, 'recruitment_room', 'x mentioned you'), 100_000);
  micro('notification allows() — no stored row (defaults)', () => allows({ kind: 'org_user', id: 'u-nope' }, 'combine', ''), 100_000);
  const fl = createFaultLayer({ env: { NODE_ENV: 'development', SCOUTBOX_FAULTS: 'delay:/org/players/*/trust:1;unavailable:/org/rooms/*' } });
  const req = { originalUrl: '/org/recruitment-briefs/b-1' };
  micro('fault layer middleware — 2 rules, no match', () => fl.middleware(req, {}, () => {}), 100_000);
  const none = createFaultLayer({ env: { NODE_ENV: 'development' } });
  micro('fault layer middleware — no rules (normal use)', () => none.middleware(req, {}, () => {}), 100_000);
  micro('ageOn(dob) — UTC getters', () => ageOn('2008-03-14', new Date(1_800_000_000_000)));
  micro('briefIsLiveOn(brief, today)', () => briefIsLiveOn({ status: 'active', activeFrom: '2026-01-01', activeUntil: '2026-12-31' }, '2026-09-12'));
}

console.log('\n— boot-time work, by snapshot size —\n');
{
  const build = (n) => ({
    orgs: Array.from({ length: Math.ceil(n / 50) }, (_, i) => ({ id: `o${i}` })),
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })),
    recruitmentCases: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, orgId: `o${i % Math.ceil(n / 50)}`, playerId: `p${i}`, room: { status: i % 3 ? 'watching' : 'archived' } })),
    recruitmentBriefs: Array.from({ length: Math.ceil(n / 10) }, (_, i) => ({ id: `b${i}` })),
    secondLookItems: Array.from({ length: Math.ceil(n / 5) }, (_, i) => ({ id: `s${i}`, orgId: 'o0', roomId: `c${i}`, changes: [{ fingerprint: `f${i}` }] })),
    notifications: Array.from({ length: n * 4 }, (_, i) => ({ id: `n${i}` })),
  });
  for (const n of [50, 500, 5000]) {
    const snap = build(n);
    let t0 = performance.now();
    runMigrations(snap);
    const mig = performance.now() - t0;
    t0 = performance.now();
    const r = integrityReport(snap);
    const integ = performance.now() - t0;
    console.log(`${`${n} players / ${n} rooms / ${n * 4} notifications`.padEnd(56)} migrations ${mig.toFixed(2)} ms   integrity ${integ.toFixed(2)} ms (${r.checked} records)`);
  }
}

console.log('\n— matrix #18: is findPlayer worth an index? —\n');
{
  for (const n of [30, 300, 3000]) {
    const players = Array.from({ length: n }, (_, i) => ({ id: `pl-${i}`, name: `P ${i}` }));
    const index = new Map(players.map((p) => [p.id, p]));
    const target = `pl-${n - 1}`; // worst case: last
    const scan = micro(`Array.find over ${n} players (worst case)`, () => players.find((p) => p.id === target), 100_000);
    const mapped = micro(`Map.get over ${n} players`, () => index.get(target), 100_000);
    console.log(`   → scan/lookup ratio ${(scan / mapped).toFixed(0)}×; scan costs ${(scan / 1000).toFixed(1)} µs per call`);
  }
  console.log('   Reading: the seeded dataset is ~30 players; a scan costs well under a microsecond.');
  console.log('   An index becomes worth its invalidation risk (every mutation path must keep it');
  console.log('   fresh) only when the scan reaches tens of microseconds per call, i.e. thousands');
  console.log('   of players. Decision: NOT added in M18.2; the threshold is recorded in the docs.');
}

// ----------------------------------------------------------- over HTTP
const proc = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const time = async (label, fn, runs = 12) => {
  await fn();
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(56)} median ${med.toFixed(1)} ms   p90 ${ts[Math.floor(ts.length * 0.9)].toFixed(1)} ms`);
  return med;
};

const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const room = (await j('POST', '/org/rooms', { playerId: players[0].id }, maria.token)).body.room;
// Some audit history to page over.
for (const s of ['under_review', 'shortlisted']) await j('POST', `/org/rooms/${room.roomId}/status`, { status: s }, maria.token);

console.log(`\n— over HTTP, ${players.length} visible players —\n`);
const health = await time('healthz (baseline round trip, contract headers on)', () => j('GET', '/healthz'));
await time('Discover list (sorted with id tie-break + ordering header)', () => j('GET', '/org/players', undefined, maria.token));
await time('notification preferences read', () => j('GET', '/org/notification-preferences', undefined, maria.token));
await time('notification preferences write', () => j('PUT', '/org/notification-preferences', { categories: { mentions: true } }, maria.token));
const audit = await time('audit log page (limit 25)', () => j('GET', '/org/audit?limit=25', undefined, maria.token));
await time('capabilities (schema + integrity + events)', () => j('GET', '/capabilities'));
await j('POST', '/__faults', { rules: 'delay:/org/players/*/trust:1' });
const withRule = await time('Discover list with one non-matching fault rule', () => j('GET', '/org/players', undefined, maria.token));
await j('POST', '/__faults', { rules: '' });
const noRule = await time('Discover list with no fault rules', () => j('GET', '/org/players', undefined, maria.token));

console.log('\n— reading the numbers —\n');
console.log(`fault layer, rule present but not matching: ${(withRule - noRule >= 0 ? '+' : '')}${(withRule - noRule).toFixed(2)} ms vs none — noise at this scale.`);
console.log(`audit page: ${audit.toFixed(1)} ms median. It is a projection over every Room, Brief and ledger row`);
console.log('  of the organisation on every read, then sorted, then sliced. Linear in history size;');
console.log('  fine for hundreds of rows, worth a materialised index if organisations reach tens');
console.log('  of thousands. Recorded as a known limitation, not fixed speculatively.');
console.log(`healthz: ${health.toFixed(1)} ms — the contract middleware adds a header and a closure per response.`);
console.log('\nMeasurements only — one machine, warm process, seeded dataset. No SLA is');
console.log('claimed, and none of these figures should be quoted as one.');
process.exit(0);
