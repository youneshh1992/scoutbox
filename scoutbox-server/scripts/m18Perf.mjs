// M18 performance probe — measurements, not an SLA.
//
// Both M18 reads derive everything live on every request, because caching
// authorization is how stale visibility leaks happen. This probe shows what
// that costs: the Second Look scan walks every ended room's change sources,
// and the Nobody Missed match runs the brief over a lightweight fact
// projection rather than a full Passport assembly. The interesting numbers are
// the per-item and per-candidate costs, and the gap between a match and a
// Passport read for the same player.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m18perf-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const players = (await j('GET', '/org/players', undefined, maria.token)).body;

// Archive a room for HALF the visible players, then land evidence after every
// decision, so the scan has a real item to build for each of them. The other
// half stays unevaluated, so the Nobody Missed match has real candidates —
// archiving everyone would leave that queue empty and its per-candidate cost
// meaningless.
const rooms = [];
for (const p of players.slice(0, Math.ceil(players.length / 2))) {
  const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
  if (r.status !== 201) continue;
  const id = r.body.room.roomId;
  await j('POST', `/org/rooms/${id}/status`, { status: 'under_review' }, maria.token);
  await j('POST', `/org/rooms/${id}/status`, { status: 'archived', reasonCodes: ['insufficient_recent_evidence'] }, maria.token);
  rooms.push({ id, playerId: p.id });
}
await sleep(10);
for (const r of rooms) {
  for (let i = 0; i < 3; i++) {
    await j('POST', `/org/players/${r.playerId}/evidence`, { claimType: 'footage', label: `Full match ${i}` }, maria.token);
  }
}

// Several briefs, so the whole-organisation coverage read has real work.
const briefIds = [];
for (const [title, positions] of [
  ['2027 Defensive Midfielder', ['CDM', 'CM']],
  ['2027 Wide forward', ['LW', 'RW']],
  ['2028 Centre back', ['CB']],
]) {
  const b = await j('POST', '/org/recruitment-briefs', { title, positions, minAge: 15, maxAge: 35 }, maria.token);
  if (b.status !== 201) continue;
  await j('PATCH', `/org/recruitment-briefs/${b.body.brief.id}`, { status: 'active' }, maria.token);
  briefIds.push(b.body.brief.id);
}
const BRIEF = briefIds[0];

const time = async (label, fn, runs = 12) => {
  await fn(); // warm
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(46)} median ${med.toFixed(1)} ms   p90 ${ts[Math.floor(ts.length * 0.9)].toFixed(1)} ms`);
  return med;
};

const queue = (await j('GET', '/org/second-look?status=all&limit=100', undefined, maria.token)).body;
const nm = (await j(`GET`, `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token)).body;
const items = queue?.total ?? 0;
const candidates = nm?.total ?? 0;
const ITEM = queue?.items?.[0]?.id;

console.log(`\nM18 performance probe — ${rooms.length} archived rooms, ${items} Second Look items, ${briefIds.length} active briefs, ${candidates} candidates\n`);

const scan = await time('Second Look scan + list (status=all)', () => j('GET', '/org/second-look?status=all&limit=100', undefined, maria.token));
await time('Second Look list (open only)', () => j('GET', '/org/second-look', undefined, maria.token));
if (ITEM) {
  await time('one item', () => j('GET', `/org/second-look/${ITEM}`, undefined, maria.token));
  await time('Review Changes comparison', () => j('GET', `/org/second-look/${ITEM}/changes`, undefined, maria.token));
}
const match = await time('Nobody Missed match + coverage (one brief)', () => j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token));
await time('Nobody Missed, ordered by distance', () => j('GET', `/org/nobody-missed?briefId=${BRIEF}&sort=distance`, undefined, maria.token));
await time('Evaluation Coverage (every live brief)', () => j('GET', '/org/evaluation-coverage', undefined, maria.token));
await time('brief list', () => j('GET', '/org/recruitment-briefs', undefined, maria.token));
await time('one brief with its explained criteria', () => j('GET', `/org/recruitment-briefs/${BRIEF}`, undefined, maria.token));
const passport = await time('Passport projection, one player (for scale)', () => j('GET', `/org/players/${players[0].id}/football-passport`, undefined, maria.token));

console.log(`\nper-item cost in the scan:       ${(scan / Math.max(1, items)).toFixed(2)} ms`);
console.log(`per-candidate cost in the match: ${(match / Math.max(1, candidates)).toFixed(2)} ms`);
console.log(`matching the WHOLE brief costs ${(match / Math.max(0.01, passport)).toFixed(2)}× a single Passport assembly — the match runs on light facts, not assembled Passports`);
console.log('\nEverything above is derived live on each read: a block, a suspension or a');
console.log('visibility change takes effect on the very next request, and no');
console.log('authorization decision is cached. Measurements only — no SLA is claimed.');
process.exit(0);
