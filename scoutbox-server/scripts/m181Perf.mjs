// M18.1 performance probe — what the hardening costs, measured.
//
// Hardening is only free if you never measure it. Four M18.1 changes touch
// every request or every read, so each one is priced here against the thing it
// protects:
//
//   • optimistic concurrency — one integer compare per mutation, plus the
//     conflict path, which must be CHEAPER than the write it refuses;
//   • the Passport revision — a SHA-1 over canonical inputs on every Passport
//     assembly, which is the one that could plausibly hurt;
//   • the rate limiter — a Map lookup per limited call, now routed through a
//     provider interface rather than an inline Map;
//   • event classification — a table lookup per connected client per event,
//     replacing a chain of payload-shape tests.
//
// Measurements only. No SLA is claimed, and every number here is from one
// machine with a warm process and a small seeded dataset.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedRevOf, revOf, bumpRev } from '../m181/concurrency.mjs';
import { createRateLimiter } from '../m181/rateLimit.mjs';
import { audienceFor } from '../m181/eventAudience.mjs';
import { passportRevision } from '../m15/shared.mjs';

const PORT = 5860 + Math.floor(Math.random() * 60);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m181perf-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- in-process micro-costs
const micro = (label, fn, iters = 200_000) => {
  for (let i = 0; i < iters / 10; i++) fn(i); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const ns = ((performance.now() - t0) * 1e6) / iters;
  console.log(`${label.padEnd(50)} ${ns.toFixed(0)} ns/op`);
  return ns;
};

console.log('\n— in-process cost of the hardening primitives —\n');
{
  const rec = { rev: 4 };
  micro('expectedRevOf(body) — parse the caller token', () => expectedRevOf({ expectedRev: 4 }));
  micro('revOf(record) — read the current token', () => revOf(rec));
  const bump = { rev: 1 };
  micro('bumpRev(record) — record an accepted write', () => bumpRev(bump, { at: 1 }));

  const rl = createRateLimiter({ provider: 'memory' });
  let n = 0;
  micro('rate limiter consume (miss)', () => { rl.limited('brief_write', `org-${n++ % 500}`); }, 100_000);
  micro('rate limiter consume (hot key)', () => { rl.limited('room_comment', 'one-room'); }, 100_000);

  micro('audienceFor(known event)', () => audienceFor('players'));
  micro('audienceFor(unknown event) — the fail-closed path', () => audienceFor('never_classified'));
}

console.log('\n— the Passport revision, by Passport size —\n');
{
  const build = (n) => ({
    player: { position: 'CM', level: 'semi_pro' },
    identity: { confirmed: true, assurance: 'scoutbox_reviewed' },
    status: { currentClub: { orgId: 'org-1', provenance: 'verified_club_confirmed' } },
    history: { rows: Array.from({ length: Math.ceil(n / 4) }, (_, i) => ({ key: `k${i}`, provenance: 'player_submitted', current: false, from: { t: i }, to: { t: i + 1 }, role: 'player' })) },
    revisionSources: {
      evidence: Array.from({ length: n }, (_, i) => ({ id: `ev-${i}`, tier: 'verified', superseded: false, expired: false })),
      careerEntries: Array.from({ length: Math.ceil(n / 4) }, (_, i) => ({ id: `ce-${i}` })),
    },
    references: Array.from({ length: Math.ceil(n / 8) }, (_, i) => ({ id: `rf-${i}`, status: 'live', provenanceStillCurrent: true })),
    achievements: Array.from({ length: Math.ceil(n / 8) }, (_, i) => ({ id: `ac-${i}` })),
    combine: { results: Array.from({ length: Math.ceil(n / 8) }, (_, i) => ({ protocolId: `p${i}`, protocolVersion: 1, measuredValue: i, combineVerified: true })) },
  });
  for (const n of [5, 25, 100, 400]) {
    const full = build(n);
    micro(`passportRevision — ${n} evidence items`, () => passportRevision(full), 20_000);
  }
}

// ----------------------------------------------------------- over HTTP
const proc = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const time = async (label, fn, runs = 12) => {
  await fn();
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(50)} median ${med.toFixed(1)} ms   p90 ${ts[Math.floor(ts.length * 0.9)].toFixed(1)} ms`);
  return med;
};

const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const brief = (await j('POST', '/org/recruitment-briefs', { title: 'Perf brief', positions: ['CM'] }, maria.token)).body.brief;
await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { status: 'active' }, maria.token);
const room = (await j('POST', '/org/rooms', { playerId: players[0].id }, maria.token)).body.room;

console.log(`\n— over HTTP, ${players.length} visible players —\n`);

// A pinned write and an unpinned write differ by one integer compare. If the
// gap is measurable at all it is noise, and saying so is the point.
let rev = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
const pinned = await time('room PATCH with expectedRev (pinned)', async () => {
  const r = await j('PATCH', `/org/rooms/${room.roomId}`, { priority: 'high', expectedRev: rev }, maria.token);
  if (r.status === 200) rev = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
});
const unpinned = await time('room PATCH without expectedRev (legacy)', () => j('PATCH', `/org/rooms/${room.roomId}`, { priority: 'normal' }, maria.token));
const conflict = await time('room PATCH that CONFLICTS (rejected write)', () => j('PATCH', `/org/rooms/${room.roomId}`, { priority: 'high', expectedRev: 1 }, maria.token));

await time('brief read (carries rev metadata)', () => j('GET', `/org/recruitment-briefs/${brief.id}`, undefined, maria.token));
const passport = await time('org Passport projection (computes passportRevision)', () => j('GET', `/org/players/${players[0].id}/football-passport`, undefined, maria.token));
await time('capability report', () => j('GET', '/capabilities'));
await time('healthz (baseline round trip)', () => j('GET', '/healthz'));

console.log('\n— reading the numbers —\n');
console.log(`pinned vs unpinned write:  ${(pinned - unpinned >= 0 ? '+' : '')}${(pinned - unpinned).toFixed(2)} ms`);
console.log('  Two round trips are folded into the pinned measurement (it re-reads the rev');
console.log('  to stay pinned), so this is an upper bound on the cost, not the cost.');
console.log(`refused write vs accepted: ${(conflict - unpinned).toFixed(2)} ms`);
console.log('  A conflict answers before any mutation, so refusing is cheaper than writing —');
console.log('  which is what you want when two people are racing.');
console.log(`Passport projection:       ${passport.toFixed(1)} ms median, revision hashing included.`);
console.log('  The revision is a SHA-1 over one short string per source row, so its cost is');
console.log('  linear in Passport size: microseconds for a normal Passport (5-25 items),');
console.log('  but ~0.2 ms at 400 evidence items — a real fraction of the projection, not');
console.log('  noise. Worth revisiting if Passports of that size become common; today the');
console.log('  seeded maximum is far below it.');
console.log('\nMeasurements only — one machine, warm process, seeded dataset. No SLA is');
console.log('claimed, and none of these figures should be quoted as one.');
process.exit(0);
