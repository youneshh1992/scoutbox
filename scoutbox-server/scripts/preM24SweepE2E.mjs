// PRE-M24 final defect sweep — server regressions for the defects the sweep
// fixed (PRE_M24_DEFECT_REGISTER.md).
//
//   S  sessions (PM-4): a session has an absolute lifetime, decided in ONE
//      place and applied to every way a session is resolved — the bearer
//      lookup, the event-stream ticket and connect, a signed media link. A
//      session with no valid creation time is expired (fail closed). Sign-out
//      revokes the token. Expired sessions are pruned at the next login and
//      stay refused across a restart. A fresh session is unaffected.
//   P  production configuration (PM-1, PM-2) is proved in m181E2E §48; here a
//      real production boot is refused without its own admin key.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
let passed = 0; let negatives = 0; let failures = 0;
const fail = (m) => { failures++; console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const PORT = 7400 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'sbx-prem24-'));
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot(env = {}, dataDir = DATA, port = PORT) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let log = ''; proc.stdout.on('data', (b) => { log += b; }); proc.stderr.on('data', (b) => { log += b; });
  let up = false;
  for (let i = 0; i < 400 && !up; i++) {
    if (proc.exitCode != null) return { proc, up: false, log: () => log };
    try { up = (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  return { proc, up, log: () => log };
}
async function stop(s) { s.proc.kill('SIGTERM'); for (let i = 0; i < 80 && s.proc.exitCode == null; i++) await sleep(100); }
const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* none */ }
  return { status: r.status, body: b };
};
const orgLogin = async () => (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body.token;
const playerLogin = async (id = 'pl-adeyemi') => (await j('POST', '/auth/player/login', { playerId: id })).body.token;

// ================================================================ S — sessions
section('S — sessions have a lifetime, sign-out revokes, every resolution path agrees (PM-4)');
let S = await boot();
ok(S.up, 'server booted');
neg(!/never emits|EVENT REGISTRY/.test(S.log()), `S0 the boot log carries no event-registry drift warning (PM-15)${/never emits/.test(S.log()) ? `: ${S.log().match(/never emits[^\n]*/)[0]}` : ''}`);
{
  // S1–S2 sign-out revokes the bearer token (org and player)
  const t = await orgLogin();
  ok((await j('GET', '/org/notifications', undefined, t)).status === 200, 'S1 a fresh org session is honoured');
  const lo = await j('POST', '/auth/logout', {}, t);
  const after = await j('GET', '/org/notifications', undefined, t);
  neg(lo.status === 200 && after.status === 401, `S1b after sign-out the same token is refused (${after.status} ${after.body?.error})`);
  const pt = await playerLogin();
  await j('POST', '/auth/logout', {}, pt);
  neg((await j('GET', '/player/me', undefined, pt)).status === 401, 'S2 a signed-out player token is refused');
  const tk = await j('POST', '/events/ticket', {}, t);
  neg(tk.status === 401, `S2b a signed-out token cannot mint an event-stream ticket (${tk.status})`);
}
// S3–S6: plant an expired session, a session with no creation time and a fresh one, offline.
const tExpired = await orgLogin();
const tNoBirth = await playerLogin('pl-svensson');
const tFresh = await orgLogin();
const ticket = (await j('POST', '/events/ticket', {}, tExpired)).body?.ticket;
ok(!!ticket, 'setup: a ticket minted while the session was still live');
await stop(S);
{
  const store = openStore(DATA); const snap = store.load();
  const e = snap.db.sessions.find((x) => x.token === tExpired); e.createdAt = Date.now() - 31 * DAY;
  const n = snap.db.sessions.find((x) => x.token === tNoBirth); delete n.createdAt;
  snap.db.sessions.push({ token: 'tok-garbage-birth', sid: 'sidgarbage01', kind: 'org', refId: 'org-eastport', userId: 'usr-1', createdAt: 'yesterday' });
  store.save(snap);
}
S = await boot();
ok(S.up, 'setup: rebooted on the planted store (an expired session, one with no creation time, one with a malformed creation time, one fresh)');
{
  const r1 = await j('GET', '/org/notifications', undefined, tExpired);
  neg(r1.status === 401, `S3 a session older than the lifetime (31 days > 30) is refused on the bearer path (${r1.status} ${r1.body?.error})`);
  const r2 = await j('GET', '/player/me', undefined, tNoBirth);
  neg(r2.status === 401, `S4 a session with no creation time is expired — fail closed (${r2.status} ${r2.body?.error})`);
  const r3 = await j('GET', '/org/notifications', undefined, 'tok-garbage-birth');
  neg(r3.status === 401, `S4b a malformed creation time is expired too (${r3.status})`);
  const r4 = await j('POST', '/events/ticket', {}, tExpired);
  neg(r4.status === 401, `S5 an expired session cannot mint an event-stream ticket (${r4.status})`);
  const r5 = await fetch(`${BASE}/events?ticket=${encodeURIComponent(ticket)}`);
  neg(r5.status === 401, `S5b a ticket minted before expiry does not open a stream for an expired session (${r5.status}; the ticket store did not survive the restart either way)`);
  ok((await j('GET', '/org/notifications', undefined, tFresh)).status === 200, 'S6 a fresh session is unaffected');
}
await stop(S);
{
  const db = openStore(DATA).load().db;
  neg(!db.sessions.some((x) => x.token === tExpired) && !db.sessions.some((x) => x.token === tNoBirth) && !db.sessions.some((x) => x.token === 'tok-garbage-birth'),
    'S7 each expired session was removed from the store when it was presented');
}
// S8: an expired session nobody presents is pruned at the next login.
{
  const store = openStore(DATA); const snap = store.load();
  snap.db.sessions.push({ token: 'tok-stale-unused', sid: 'sidstaleunus', kind: 'player', refId: 'pl-kim', createdAt: Date.now() - 40 * DAY });
  store.save(snap);
}
S = await boot();
await playerLogin('pl-kim');
await stop(S);
{
  const db = openStore(DATA).load().db;
  neg(!db.sessions.some((x) => x.token === 'tok-stale-unused'), 'S8 an expired session nobody presents is pruned at the next login');
  ok(db.sessions.some((x) => x.token === tFresh), 'S8b a live session survives the prune');
}
// S9: the lifetime is configurable; a short lifetime expires a session that is only hours old.
{
  const store = openStore(DATA); const snap = store.load();
  const f = snap.db.sessions.find((x) => x.token === tFresh); f.createdAt = Date.now() - 2 * DAY;
  store.save(snap);
}
S = await boot({ SESSION_TTL_DAYS: '1' });
{
  const r = await j('GET', '/org/notifications', undefined, tFresh);
  neg(r.status === 401, `S9 SESSION_TTL_DAYS=1: a two-day-old session is refused (${r.status})`);
  const t = await orgLogin();
  ok((await j('GET', '/org/notifications', undefined, t)).status === 200, 'S9b a session minted under the short lifetime is honoured');
}
await stop(S);

// ================================================================ A — async handler errors (PM-9)
section('A — a rejected async handler answers 500 and the process keeps serving (PM-9)');
{
  const { installAsyncErrorForwarding } = await import('../m181/asyncErrors.mjs');
  const { createRequire } = await import('node:module');
  const express = createRequire(import.meta.url)('express');
  installAsyncErrorForwarding();
  const app = express();
  app.get('/boom', async () => { throw new Error('async boom'); });
  app.get('/sync', () => { throw new Error('sync boom'); });
  app.get('/ok', (_q, r) => r.json({ ok: true }));
  app.use((err, _q, r, _n) => r.status(500).json({ error: 'INTERNAL', caught: String(err?.message ?? err) }));
  const port = PORT + 250;
  const srv = app.listen(port);
  await sleep(200);
  const b = await fetch(`http://localhost:${port}/boom`); const bb = await b.json();
  neg(b.status === 500 && bb.caught === 'async boom', `A1 an async handler that throws reaches the error middleware (${b.status} ${bb.caught})`);
  const s2 = await fetch(`http://localhost:${port}/sync`);
  ok(s2.status === 500, 'A2 a synchronous throw still reaches it too (unchanged Express behaviour)');
  ok((await fetch(`http://localhost:${port}/ok`)).status === 200, 'A3 the app keeps serving after both');
  srv.close();
}
S = await boot();
{
  const anon = await j('POST', '/auth/guardian/signup', { name: { x: 1 }, email: { y: 2 }, password: { z: 3 } });
  neg(anon.status === 400, `A4 the unauthenticated request that used to END the server is a 400 (${anon.status} ${anon.body?.error})`);
  ok((await fetch(`${BASE}/healthz`)).status === 200, 'A5 the server is still up');
}

// ================================================================ T — typed request fields (PM-10)
section('T — free text is a string: a non-string is a 400 naming the field, never a 500 or a stored object (PM-10)');
{
  const org = await orgLogin();
  const grass = (await j('POST', '/auth/org/login', { orgId: 'org-mossside', scoutName: 'Pat Doyle', role: 'Head Coach', platform: 'grassroots' })).body.token;
  const player = await playerLogin();
  const O = { x: 1 };
  const cases = [
    ['anon', 'POST', '/auth/guardian/signup', { name: O, email: 'g@example.com', password: 'longenough1' }],
    ['anon', 'POST', '/auth/org/register-grassroots', { name: O, federation: 'FA', registrationId: 'R1', lat: 53.4, lng: -2.2, scoutName: 'Sam' }],
    ['anon', 'POST', '/auth/org/register-grassroots', { name: 'Sweep FC', city: O, federation: 'FA', registrationId: 'R1', lat: 53.4, lng: -2.2, scoutName: 'Sam' }],
    ['anon', 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: O, role: 'Scout' }],
    ['anon', 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: O }],
    [org, 'POST', '/org/searches', { name: O }],
    [org, 'POST', '/org/searches', { name: 'Wingers', filters: [1, 2] }],
    [org, 'POST', '/org/verification/email', { email: O }],
    [org, 'POST', '/org/invites', { email: 'x@example.com', name: O }],
    [org, 'POST', '/org/support', { subject: O }],
    [org, 'POST', '/org/verification/licence', { licenceType: O, issuer: 'FA' }],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: O }],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: '25:99' }],
    [grass, 'POST', '/org/squad', { name: O }],
    [grass, 'POST', '/org/squad', { name: 'Sam', position: O }],
    [grass, 'POST', '/org/open-trials', { title: 'Open day', date: '2099-05-01', venue: 'Rec', notes: O }],
    [grass, 'POST', '/org/friendlies', { date: '2099-05-01', ageGroup: O }],
    [player, 'POST', '/player/media', { title: O }],
    [player, 'POST', '/player/medical/records', { title: O }],
    [player, 'POST', '/player/medical/records', { title: 'Knock', layoffWeeks: 'three' }],
    [player, 'POST', '/player/medical/records', { title: 'Knock', cleared: 'yes' }],
  ];
  const bad = [];
  for (const [tok, m, url, body] of cases) {
    const r = await j(m, url, body, tok === 'anon' ? undefined : tok);
    if (r.status !== 400 || JSON.stringify(r.body ?? {}).includes('"x":1')) bad.push(`${m} ${url} ${JSON.stringify(body).slice(0, 60)} → ${r.status} ${r.body?.error}`);
  }
  neg(bad.length === 0, `T1 ${cases.length} malformed bodies across ${new Set(cases.map((c) => c[2])).size} routes each answer 400 and store nothing${bad.length ? ': ' + bad.join(' | ') : ''}`);
  const good = [
    [org, 'POST', '/org/searches', { name: 'Wingers', filters: { position: 'RW' } }, 201],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: '21:00', quietEnd: '07:30', email: true }, 200],
    [grass, 'POST', '/org/squad', { name: 'Sam Keeper', position: 'GK' }, 201],
    [player, 'POST', '/player/medical/records', { type: 'injury', title: 'Knock', layoffWeeks: 2, cleared: false }, 201],
    [player, 'POST', '/player/media', { title: 'Highlights' }, 201],
  ];
  const off = [];
  for (const [tok, m, url, body, want] of good) { const r = await j(m, url, body, tok); if (r.status !== want) off.push(`${url} → ${r.status} ${r.body?.error}`); }
  ok(off.length === 0, `T2 well-formed bodies to the same routes still succeed${off.length ? ': ' + off.join(' | ') : ''}`);
  ok((await fetch(`${BASE}/healthz`)).status === 200, 'T3 the server is up after every malformed request');
}
await stop(S);

// ================================================================ P — production boot
section('P — production refuses to start without its own admin key (PM-1)');
{
  const d2 = mkdtempSync(path.join(tmpdir(), 'sbx-prem24p-'));
  const p1 = await boot({ NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 'sweep-media-secret' }, d2, PORT + 201);
  neg(!p1.up && /Refusing to start: .*ADMIN_KEY_UNSAFE/.test(p1.log()), 'P1 NODE_ENV=production with no ADMIN_KEY: the server refuses to start (ADMIN_KEY_UNSAFE)');
  const p2 = await boot({ NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 'sweep-media-secret', ADMIN_KEY: 'scoutbox-admin' }, d2, PORT + 202);
  neg(!p2.up && /ADMIN_KEY_UNSAFE/.test(p2.log()), 'P2 the development default key is refused too');
  const p3 = await boot({ NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 'sweep-media-secret', ADMIN_KEY: 'sweep-production-admin-key-0123' }, d2, PORT + 203);
  ok(p3.up, 'P3 with its own key the production server starts');
  if (p3.up) {
    const def = await fetch(`http://localhost:${PORT + 203}/admin/reports`, { headers: { 'x-admin-key': 'scoutbox-admin' } });
    const own = await fetch(`http://localhost:${PORT + 203}/admin/reports`, { headers: { 'x-admin-key': 'sweep-production-admin-key-0123' } });
    neg(def.status === 401 && own.status === 200, `P4 the public default key is refused (${def.status}); the configured key works (${own.status})`);
    const dev = await fetch(`http://localhost:${PORT + 203}/auth/org/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) });
    neg(dev.status !== 200, `P5 passwordless demo logins stay refused in production (${dev.status})`);
    await stop(p3);
  }
  const p4 = await boot({ NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 'sweep-media-secret', ADMIN_KEY: 'sweep-production-admin-key-0123', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, d2, PORT + 204);
  neg(!p4.up && /AGENT_TEST_PROVIDER_IN_PRODUCTION/.test(p4.log()), 'P6 the synthetic agent licence register is refused in production (PM-2)');
}

console.log(`\nPRE-M24 sweep server regressions: ${passed} checks passed, ${negatives} negative, ${failures} failed`);
if (failures) console.error(`✗ PRE-M24 sweep server regressions have ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
