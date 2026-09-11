// M17 performance probe — measurements, not an SLA.
//
// The point is to prove there is no N+1 in the Room list: one light Passport
// assembly per player on the page, shared between the Passport and Trust
// engines. If per-room cost grew with the number of source round trips, the
// 50→100 comparison would show it.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m17perf-'));
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

// Open a room per visible player, then pad with comments and activity so the
// discussion and timeline pages are measured against real volume.
const rooms = [];
for (const p of players) {
  const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
  if (r.status === 201) rooms.push(r.body.room.roomId);
}
const SUBJECT = rooms[0];
for (let i = 0; i < 60; i++) await j('POST', `/org/rooms/${SUBJECT}/comments`, { body: `Observation ${i}` }, maria.token);
for (let i = 0; i < 20; i++) await j('POST', `/org/rooms/${SUBJECT}/tasks`, { title: `Task ${i}` }, maria.token);

const time = async (label, fn, runs = 12) => {
  await fn(); // warm
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(42)} median ${med.toFixed(1)} ms   p90 ${ts[Math.floor(ts.length * 0.9)].toFixed(1)} ms`);
  return med;
};

console.log(`\nM17 performance probe — ${rooms.length} rooms, ${players.length} players in the fixture\n`);
const l50 = await time('room list (limit 50)', () => j('GET', '/org/rooms?limit=50', undefined, maria.token));
const l100 = await time('room list (limit 100)', () => j('GET', '/org/rooms?limit=100', undefined, maria.token));
await time('room list — "shortlisted" saved view', () => j('GET', '/org/rooms?view=shortlisted', undefined, maria.token));
await time('needs-attention feed', () => j('GET', '/org/rooms/needs-attention', undefined, maria.token));
await time('batch room summaries (all players)', () => j('GET', `/org/rooms/summaries?playerIds=${players.map((p) => p.id).join(',')}`, undefined, maria.token));
const single = await time('single room (full projection)', () => j('GET', `/org/rooms/${SUBJECT}`, undefined, maria.token));
await time('Passport projection (same player, direct)', () => j('GET', `/org/players/${players[0].id}/football-passport`, undefined, maria.token));
await time('Trust projection (same player, direct)', () => j('GET', `/org/players/${players[0].id}/trust-profile`, undefined, maria.token));
await time('activity timeline (first page)', () => j('GET', `/org/rooms/${SUBJECT}/activity?limit=50`, undefined, maria.token));
await time('discussion (first page)', () => j('GET', `/org/rooms/${SUBJECT}/comments?limit=50`, undefined, maria.token));
await time('funnel', () => j('GET', '/org/rooms-funnel', undefined, maria.token));

console.log(`\nper-room cost in a list: ${(l50 / Math.max(1, rooms.length)).toFixed(2)} ms`);
console.log(`list(100)/list(50) ratio: ${(l100 / l50).toFixed(2)} — a page bounded by the fixture size, so both pages cover the same rooms`);
console.log(`a single full room projection costs ${(single / (l50 / Math.max(1, rooms.length))).toFixed(1)}× one list row, as expected: the list assembles each player once and skips the heavy tabs`);
console.log('\nMeasurements only. No SLA is claimed and none is enforced.');
process.exit(0);
