// Behavioural tests for migration plan step S2: sessions become table-backed
// with hashed tokens. Everything runs on throwaway databases under the OS temp
// directory with synthetic fixtures; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnChild } from './testChildren.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { createSessionsRepository, validateSessionRow, SESSIONS_CUTOVER_MIGRATION } from '../repositories/sessions.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';
import { createStorage } from '../adapters.mjs';
import { hasBlobTable } from './coreIdentityTestFixtures.mjs';
// The checks below that drive the runner on a raw connection are about the S2/S3
// steps (0001–0004): they run exactly those. The S4a steps that follow them
// (0005 core identity, 0006 media deletions) have their own suites
// (testCoreIdentityMigration, testCoreSchema); the full registered list is what
// attachDataLayer and the real-server checks below run.
const S3_MIGRATIONS = DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id));
import { buildSeed } from '../seed.mjs';
import { freePort } from './testPort.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
async function atest(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const TTL = 30 * DAY;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const ORG_A = { id: 'org-a', name: 'Org A', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' };
const seedOrg = (s, id = 'org-a') => s.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan, created_at) VALUES (?, 'Org', 'club', 'pro', 'Pro', 0)").run(id);
const seedUser = (s, id = 'usr-1', org = 'org-a') => { seedOrg(s, org); s.prepare("INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES (?, ?, 'Staff', ?, 'Scout', 1)").run(id, org, `staff ${id}`); };

/**
 * A fixture written through the repositories (staff with fixed ids included), then the server-mode data layer attached
 * to it. Returns the server-mode store and the layer.
 */
function bootWith(dir, db) {
  writeFixture(dir, db, { idCounter: 1000 });
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  return { store, layer: attachDataLayer({ store, nextId, sessionTtlMs: TTL }) };
}
/** Write a fixture media file into the data directory's storage, as an upload would. */
const storeClip = (dir, id, bytes) => createStorage(dir).saveDataUrl(id, `data:video/webm;base64,${bytes.toString('base64')}`);

const openRaw = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;'); return s; };

// ------------------------------------------------------------- validation
test('validation: every unsupported shape is refused with a reason and nothing is coerced', () => {
  const exists = (id) => id === 'usr-1';
  const ok = validateSessionRow({ token: 't', sid: 's', kind: 'org', refId: 'org-a', userId: 'usr-1', createdAt: 5 }, { orgUserExists: exists });
  assert.equal(ok.ok, true); assert.equal(ok.row.tokenHash, sha256('t')); assert.equal(ok.row.userId, 'usr-1');
  const refused = (raw) => { const v = validateSessionRow(raw, { orgUserExists: exists }); assert.equal(v.ok, false, JSON.stringify(raw)); return v.reason; };
  assert.equal(refused({ sid: 's', kind: 'player', refId: 'p', createdAt: 5 }), 'no token');
  assert.equal(refused({ token: '', sid: 's', kind: 'player', refId: 'p', createdAt: 5 }), 'no token');
  assert.match(refused({ token: 't', sid: 's', kind: 'admin', refId: 'p', createdAt: 5 }), /not a session kind/);
  assert.equal(refused({ token: 't', sid: 's', kind: 'player', createdAt: 5 }), 'no refId');
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p', createdAt: 'yesterday' }), /positive integer/);
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p' }), /positive integer/, 'a missing creation time is unsupported, not coerced');
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p', createdAt: 5.5 }), /positive integer/, 'a fractional time is not truncated');
  assert.match(refused({ token: 't', sid: 's', kind: 'org', refId: 'org-a', createdAt: 5 }), /names no staff member/);
  assert.match(refused({ token: 't', sid: 's', kind: 'org', refId: 'org-a', userId: 'usr-nope', createdAt: 5 }), /does not exist/);
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p', userId: 'usr-1', createdAt: 5 }), /must not name a staff member/);
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p', createdAt: 5, via: 'magic' }), /not supported/);
  assert.match(refused({ token: 't', sid: 's', kind: 'player', refId: 'p', createdAt: 5, colour: 'red' }), /unknown field/);
  assert.match(refused({ token: 't', sid: 42, kind: 'player', refId: 'p', createdAt: 5 }), /sid is not a string/);
  const derived = validateSessionRow({ token: 't', kind: 'player', refId: 'p', createdAt: 5 }, { orgUserExists: exists });
  assert.equal(derived.ok, true); assert.equal(derived.sidDerived, true); assert.equal(derived.row.sid, sha256('t').slice(0, 12));
  const hashed = validateSessionRow({ tokenHash: sha256('t'), sid: 's', kind: 'player', refId: 'p', createdAt: 5 }, { orgUserExists: exists });
  assert.equal(hashed.ok, true); assert.equal(hashed.row.tokenHash, sha256('t'));
});

// ------------------------------------------------------------- the migration
test('migration 0003 on a new database: the sessions table starts empty, the lifetime is recorded, the repository attaches on the record, and a re-run is a no-op', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  const r = runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.ok(r.ran.includes(SESSIONS_CUTOVER_MIGRATION));
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'sessionTtlMs'").get().value, String(TTL));
  assert.deepEqual(createSessionsRepository({ sqlite: s, sessionTtlMs: TTL }).attach(), { engine: 'sqlite', rows: 0 });
  assert.deepEqual(runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, []);
  s.close();
});

// ------------------------------------------------------------- the repository
const liveRepo = (opts = {}) => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: opts.sessionTtlMs ?? TTL } });
  seedUser(s, 'usr-1', 'org-a'); seedUser(s, 'usr-2', 'org-a'); seedUser(s, 'usr-3', 'org-b');
  const repo = createSessionsRepository({ sqlite: s, sessionTtlMs: TTL, ...opts });
  repo.attach();
  return { s, repo };
};
test('repository: create returns the token once; the table and the list queries hold only the hash-free row; lookup is by hash; there is no view (S14f)', () => {
  const { s, repo } = liveRepo();
  const { token, session } = repo.create('player', 'pl-1');
  assert.equal(token.length, 48); assert.equal(session.kind, 'player'); assert.equal(session.refId, 'pl-1'); assert.ok(session.sid);
  assert.ok(!('token' in session) && !('tokenHash' in session));
  assert.deepEqual(repo.byToken(token), session);
  assert.equal(repo.byToken('not-a-token'), null); assert.equal(repo.byToken(''), null); assert.equal(repo.byToken(null), null);
  assert.deepEqual(repo.bySid(session.sid), session); assert.equal(repo.bySid('nope'), null);
  const listed = JSON.stringify(repo.listFor('player', 'pl-1'));
  const dump = JSON.stringify(s.prepare('SELECT * FROM sessions').all()) + listed;
  assert.ok(!dump.includes(token), 'the plain token appears nowhere');
  assert.ok(listed.includes(session.sid) && !listed.includes(sha256(token)), 'a list carries neither token nor hash');
  assert.equal('view' in repo, false, 'no mirror and no view');
  assert.throws(() => repo.create('org', 'org-a', {}), /needs a staff member/);
  assert.throws(() => repo.create('wizard', 'x'), /not a session kind/);
  assert.throws(() => repo.create('player', 'pl-1', { via: 'carrier-pigeon' }), /not supported/);
  s.close();
});
test('repository: expiry is decided from the creation time and the configured lifetime, at the exact boundary', () => {
  let clock = 1_000_000;
  const { s, repo } = liveRepo({ now: () => clock });
  const { token } = repo.create('player', 'pl-1');
  clock += TTL - 1; assert.ok(repo.byToken(token), 'one millisecond before the lifetime: live');
  clock += 1; assert.equal(repo.byToken(token), null, 'at exactly the lifetime: expired and removed');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'an expired session presented is removed on sight');
  const { session: a } = repo.create('guardian', 'gd-1'); clock += 10; repo.create('guardian', 'gd-2');
  clock += TTL - 10; // the first is exactly at the lifetime, the second not yet
  assert.equal(repo.prune(), 1, 'prune removes exactly the expired one'); assert.equal(repo.bySid(a.sid), null);
  s.close();
});
test('repository: a non-default lifetime is honoured, and changing it between boots recomputes expiry for every stored session', () => {
  let clock = 5_000_000;
  const dir = tempDir('s2-ttl');
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: 7 * DAY } });
  let repo = createSessionsRepository({ sqlite: s, sessionTtlMs: 7 * DAY, now: () => clock }); repo.attach();
  const { token, session } = repo.create('player', 'pl-1');
  assert.equal(session.expiresAt, clock + 7 * DAY);
  clock += 8 * DAY; assert.equal(repo.byToken(token), null, 'eight days later a seven-day session is gone');
  clock -= 8 * DAY; const { token: t2 } = repo.create('player', 'pl-2');
  // "Restart" with SESSION_TTL_DAYS=1: the stored row's expiry is recomputed and the shorter lifetime applies to it.
  const logs = []; repo = createSessionsRepository({ sqlite: s, sessionTtlMs: 1 * DAY, now: () => clock, log: (m) => logs.push(m) }); repo.attach();
  assert.equal(s.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(t2)).expires_at, clock + DAY);
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'sessionTtlMs'").get().value, String(DAY));
  assert.match(logs.join('\n'), /lifetime changed/);
  clock += 2 * DAY; assert.equal(repo.byToken(t2), null, 'a two-day-old session is refused under a one-day lifetime');
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('repository: every revocation path removes exactly its own sessions; users and organisations are isolated from each other', () => {
  const { s, repo } = liveRepo();
  const p1 = repo.create('player', 'pl-1'), p1b = repo.create('player', 'pl-1'), p2 = repo.create('player', 'pl-2');
  const u1 = repo.create('org', 'org-a', { userId: 'usr-1' }), u1b = repo.create('org', 'org-a', { userId: 'usr-1', via: 'sso' });
  const u2 = repo.create('org', 'org-a', { userId: 'usr-2' }), u3 = repo.create('org', 'org-b', { userId: 'usr-3' });
  const r1 = repo.create('ts_reviewer', 'rev-1'), r2 = repo.create('ts_reviewer', 'rev-2');
  const alive = () => s.prepare('SELECT sid FROM sessions ORDER BY sid').all().map((r) => r.sid).sort();
  const all = () => [p1, p1b, p2, u1, u1b, u2, u3, r1, r2].map((x) => x.session.sid).sort();
  assert.deepEqual(alive(), all());
  // logout: one session by sid
  assert.equal(repo.revokeSid(p1.session.sid), 1); assert.equal(repo.byToken(p1.token), null); assert.ok(repo.byToken(p1b.token), 'the same player\'s other session survives');
  // own-session management: staff member usr-1 cannot revoke usr-2's session, or usr-3's in another org
  assert.equal(repo.revokeOwn('usr-1', u2.session.sid), 0); assert.equal(repo.revokeOwn('usr-1', u3.session.sid), 0); assert.ok(repo.byToken(u2.token) && repo.byToken(u3.token));
  assert.deepEqual(repo.listOrgUser('usr-1').map((x) => x.sid).sort(), [u1.session.sid, u1b.session.sid].sort(), 'a staff member lists only their own sessions');
  assert.equal(repo.isCurrent(repo.listOrgUser('usr-1')[0], u1.token) || repo.isCurrent(repo.listOrgUser('usr-1')[1], u1.token), true);
  assert.equal(repo.isCurrent(u1.session, u2.token), false);
  assert.equal(repo.revokeOwn('usr-1', u1b.session.sid), 1); assert.equal(repo.byToken(u1b.token), null); assert.ok(repo.byToken(u1.token));
  // staff removal: all of that member's sessions, nobody else's
  assert.equal(repo.revokeOrgUser('usr-1'), 1); assert.equal(repo.byToken(u1.token), null); assert.ok(repo.byToken(u2.token) && repo.byToken(u3.token));
  // player deletion: every session of that player, not another player's
  assert.equal(repo.revokeFor('player', 'pl-1'), 1); assert.equal(repo.byToken(p1b.token), null); assert.ok(repo.byToken(p2.token));
  // reviewer revocation
  assert.equal(repo.revokeFor('ts_reviewer', 'rev-1'), 1); assert.equal(repo.byToken(r1.token), null); assert.ok(repo.byToken(r2.token));
  // revoke by presented token (e.g. a client that logs out with the token it holds)
  assert.equal(repo.revokeToken(p2.token), 1); assert.equal(repo.revokeToken(p2.token), 0);
  assert.deepEqual(alive(), [u2.session.sid, u3.session.sid, r2.session.sid].sort());
  // a staff row deleted outright cascades its sessions and nothing else
  s.prepare("DELETE FROM org_users WHERE id = 'usr-2'").run();
  assert.deepEqual(alive(), [u3.session.sid, r2.session.sid].sort());
  s.close();
});

// ------------------------------------------------------------- fixtures
test('[fixtures] a stored session is its hash, never the token; a plain-token fixture session is hashed on the way in, and the server reads both', () => {
  const dir = tempDir('s2-fix');
  let { store, layer } = bootWith(dir, { orgs: [ORG_A], guardians: [], players: [], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }] });
  const a = layer.sessions.create('player', 'pl-1'), b = layer.sessions.create('org', 'org-a', { userId: 'usr-1' });
  store.sqlite.close();
  const back = readRecords(dir);
  assert.equal(back.sessions.length, 2);
  const rowA = back.sessions.find((x) => x.sid === a.session.sid);
  assert.equal(rowA.tokenHash, sha256(a.token)); assert.ok(!('token' in rowA));
  assert.equal(JSON.stringify(back).includes(a.token), false);
  // A fixture session supplied with a plain token (as a test signs in with) is stored as its hash.
  writeFixture(dir, { sessions: [{ token: 'fixture-token', sid: 'sid-fx', kind: 'player', refId: 'pl-9', createdAt: Date.now() - 2 * DAY }] });
  const written = readRecords(dir).sessions;
  assert.deepEqual(written.map((x) => x.sid).sort(), [a.session.sid, b.session.sid, 'sid-fx'].sort());
  assert.equal(written.find((x) => x.sid === 'sid-fx').tokenHash, sha256('fixture-token'));
  assert.equal(written.find((x) => x.sid === a.session.sid).tokenHash, sha256(a.token), 'the stored hash is unchanged');
  assert.equal(JSON.stringify(written).includes('fixture-token'), false);
  // The server reads the stored rows and every token works.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ store, nextId, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token) && layer2.sessions.byToken(b.token) && layer2.sessions.byToken('fixture-token'));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- concurrency
await atest('busy timeout: a unit of work waits for a concurrent writer in another process instead of failing; without the pragma the same situation fails at once', async () => {
  const dir = tempDir('s2-busy');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ seed: { orgs: [ORG_A] }, store, nextId, sessionTtlMs: TTL });
  const holdMs = 1200;
  const holder = spawnChild(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE'); db.exec("INSERT INTO meta (key, value) VALUES ('lock-probe', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});
  `, path.join(dir, 'scoutbox.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const waitLocked = () => new Promise((resolve) => holder.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve(); }));
  const run = async () => {
    await waitLocked();
    const raw = new DatabaseSync(path.join(dir, 'scoutbox.db')); // no busy_timeout
    assert.throws(() => raw.exec("INSERT INTO meta (key, value) VALUES ('x', '1')"), /SQLITE_BUSY|database is locked/, 'a connection without the pragma fails immediately');
    raw.close();
    const t0 = Date.now();
    // Rewritten in S14a (a save wrote the blob) and S14g (it flushed an organisation facet): an explicit write in a
    // unit of work now (BEGIN IMMEDIATE, which waits through the busy handler, as a route's unit does).
    store.unitOfWork(() => layer.orgs.update('org-a', (d) => { d.suspended = true; }));
    const waited = Date.now() - t0;
    assert.ok(waited >= holdMs - 300, `the store waited for the lock (${waited} ms)`);
    assert.equal(store.sqlite.prepare("SELECT suspended FROM orgs WHERE id = 'org-a'").get().suspended, 1);
  };
  // Awaited by the harness: the check counts only once every assertion above has passed.
  try { await run(); } finally { try { holder.kill(); } catch { /* done */ } store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- through the real server
await atest('server: plain-token sessions in a fixture are stored as hashes, their tokens work after boot and a restart, media links and event streams follow the session, and every revocation path answers 401', async () => {
  const dir = tempDir('s2-server');
  // A fixture built from the real seed plus plain-token sessions (the fixture write hashes them).
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [
    { token: 'legacy-kola-token-000000000000000000000000000', sid: 'sid-kola', kind: 'player', refId: 'pl-adeyemi', createdAt: Date.now() - DAY },
    { token: 'legacy-maria-token-00000000000000000000000000', sid: 'sid-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY },
  ];
  // A deterministic media fixture: one of Kola's clips has a stored file, so a
  // signed media link must resolve to 200 with these bytes. (S14a: written to
  // storage directly; the mediaBlobs collection is gone.)
  const clip = seed.players.find((p) => p.id === 'pl-adeyemi').media[0];
  const clipBytes = Buffer.from('synthetic-webm-bytes-for-the-sessions-suite');
  clip.url = `/media/${clip.id}`;
  storeClip(dir, clip.id, clipBytes);
  writeFixture(dir, seed, { idCounter: 1000 }); // the sessions go into their table, hashed
  const port = await freePort();
  const boot = () => new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve({ proc, log: () => log }); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}) on port ${port}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000).unref();
  });
  const stop = (S) => new Promise((resolve) => { S.proc.on('exit', () => resolve()); S.proc.kill('SIGTERM'); });
  const j = async (method, p, body, token) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let parsed = null; try { parsed = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: parsed };
  };
  let S = await boot();
  try {
    const kola = seed.sessions[0].token, maria = seed.sessions[1].token;
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 200, 'the fixture player token works');
    const notif = await j('GET', '/org/notifications', undefined, maria);
    assert.equal(notif.status, 200, 'the fixture staff token works');
    // The file holds no plain token and no sessions blob.
    const raw = openRaw(dir);
    assert.equal(hasBlobTable(raw), false, 'no blob table (rewritten in S14a: this checked for a sessions blob)');
    assert.ok(raw.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(kola)), 'the session is in the table by hash');
    assert.equal(JSON.stringify(raw.prepare('SELECT * FROM sessions').all()).includes('legacy-kola-token'), false, 'no plain token in the table');
    raw.close();
    // Own-session listing marks the current session and refuses to revoke another user's.
    const mine = await j('GET', '/org/sessions', undefined, maria);
    assert.equal(mine.status, 200); assert.equal(mine.body.items.length, 1); assert.equal(mine.body.items[0].current, true); assert.equal(mine.body.items[0].sid, 'sid-maria');
    assert.ok(!JSON.stringify(mine.body).includes(maria) && !JSON.stringify(mine.body).includes(sha256(maria)), 'the listing carries neither token nor hash');
    assert.deepEqual((await j('POST', '/org/sessions/revoke', { sid: 'sid-kola' }, maria)).body, { revoked: 0 }, 'a staff member cannot revoke a player session by sid');
    // Event stream: the ticket names the session; logout kills the stream's identity.
    const tk = await j('POST', '/events/ticket', {}, kola);
    assert.equal(tk.status, 200);
    const ac = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/events?ticket=${encodeURIComponent(tk.body.ticket)}`, { signal: ac.signal });
    assert.equal(stream.status, 200); ac.abort();
    // Restart: the table is the source of truth; the tokens still work. The plain token never reached the file.
    await stop(S);
    { const c = openRaw(dir); c.exec('PRAGMA wal_checkpoint(TRUNCATE)'); c.close(); }
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes('legacy-kola-token'), 'the file holds no plain token');
    S = await boot();
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 200, 'the player token survives a restart');
    // Signed media URL bound to the session: required, served with the fixture's bytes, dead after logout.
    const me = await j('GET', '/player/me', undefined, kola);
    const mediaUrl = JSON.stringify(me.body).match(new RegExp(`/media/${clip.id}\\?e=\\d+&s=[A-Za-z0-9_-]+&v=sid-kola`))?.[0];
    assert.ok(mediaUrl, 'the profile carries a signed link to the fixture clip, bound to the session id');
    const fetched = await fetch(`http://127.0.0.1:${port}${mediaUrl}`);
    assert.equal(fetched.status, 200, 'the signed link resolves the session and serves the clip');
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString(), clipBytes.toString(), 'the served bytes are the fixture bytes');
    assert.equal((await fetch(`http://127.0.0.1:${port}${mediaUrl.replace(/&v=sid-kola$/, '&v=sid-other')}`)).status, 401, 'a link re-pointed at another sid fails the signature');
    assert.equal((await j('POST', '/auth/logout', {}, kola)).status, 200);
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 401, 'logout revokes the token');
    assert.equal((await fetch(`http://127.0.0.1:${port}${mediaUrl}`)).status, 401, 'the signed media link dies with its session');
    const tk2 = await j('POST', '/events/ticket', {}, kola);
    assert.equal(tk2.status, 401, 'a revoked session cannot mint a stream ticket');
    // Fresh login works and its token is 48 hex, never persisted in clear.
    const login = await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' });
    assert.equal(login.status, 200); assert.match(login.body.token, /^[0-9a-f]{48}$/);
    assert.equal((await j('GET', '/player/me', undefined, login.body.token)).status, 200);
    const cap = await j('GET', '/capabilities');
    assert.equal(cap.body.dataLayer.domains.sessions.mode, 'live');
    assert.ok(cap.body.dataLayer.migrations.includes(SESSIONS_CUTOVER_MIGRATION));
    assert.ok(!JSON.stringify(cap.body).includes(login.body.token));
  } finally {
    await stop(S);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await atest('server: media links are signed with MEDIA_SECRET only — a link survives a restart with the same secret, dies with a different or unset one, and no signing key is written to the database', async () => {
  const dir = tempDir('media-secret');
  const seed = buildSeed();
  const clip = seed.players.find((p) => p.id === 'pl-adeyemi').media[0];
  clip.url = `/media/${clip.id}`;
  storeClip(dir, clip.id, Buffer.from('synthetic-media-secret-bytes'));
  writeFixture(dir, seed, { idCounter: 1000 });
  const port = await freePort();
  const boot = (env) => new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, MEDIA_SECRET: '', ...env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve({ proc }); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}) on port ${port}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000).unref();
  });
  const stop = (S) => new Promise((resolve) => { S.proc.on('exit', () => resolve()); S.proc.kill('SIGTERM'); });
  const status = async (url) => (await fetch(`http://127.0.0.1:${port}${url}`)).status;
  const SECRET = 'synthetic-media-secret-0123456789abcdef';
  let S = await boot({ MEDIA_SECRET: SECRET });
  try {
    const login = await (await fetch(`http://127.0.0.1:${port}/auth/player/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).json();
    const me = await (await fetch(`http://127.0.0.1:${port}/player/me`, { headers: { authorization: `Bearer ${login.token}` } })).json();
    const url = JSON.stringify(me).match(new RegExp(`/media/${clip.id}\\?e=\\d+&s=[A-Za-z0-9_-]+&v=[A-Za-z0-9_-]+`))?.[0];
    assert.ok(url, 'the profile carries a signed link');
    assert.equal(await status(url), 200);
    await stop(S); S = await boot({ MEDIA_SECRET: SECRET });
    assert.equal(await status(url), 200, 'the same MEDIA_SECRET verifies a link minted before the restart');
    await stop(S); S = await boot({ MEDIA_SECRET: `${SECRET}-rotated` });
    assert.equal(await status(url), 401, 'a different secret refuses it');
    await stop(S); S = await boot({ SCOUTBOX_MEDIA_SECRET: SECRET });
    assert.equal(await status(url), 401, 'the old variable name is not read: development signs with a fresh per-process key');
    await stop(S); S = null;
    // Rewritten in S14a: this looked for a secrets blob; now the whole file is searched for the key.
    const raw = openRaw(dir);
    assert.equal(hasBlobTable(raw), false);
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); raw.close();
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes(SECRET), 'no signing key is written to the database');
  } finally {
    if (S) await stop(S);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await atest('server (review correction 2): player and org sessions survive the admin backup (a database copy holding token hashes, never tokens) and a restore into a new directory', async () => {
  const dir = tempDir('s2-server-dbjson');
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [
    { token: 'dbjson-kola-token-000000000000000000000000000', sid: 'sid-json-kola', kind: 'player', refId: 'pl-adeyemi', createdAt: Date.now() - DAY },
    { token: 'dbjson-maria-token-00000000000000000000000000', sid: 'sid-json-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY },
  ];
  writeFixture(dir, seed, { idCounter: 1000 });
  const port = await freePort();
  const proc = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', () => { if (/listening on/.test(log)) resolve(); });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}): ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000).unref();
  });
  try {
    const status = async (p, token) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;
    assert.equal(await status('/player/me', seed.sessions[0].token), 200, 'the player token works');
    assert.equal(await status('/org/notifications', seed.sessions[1].token), 200, 'the org token works');
    const cap = await (await fetch(`http://127.0.0.1:${port}/capabilities`)).json();
    assert.equal(cap.dataLayer.domains.sessions.rows, 2); assert.equal(cap.dataLayer.domains.users.rows, 1);
    assert.ok(!log.includes('dbjson-kola-token') && !log.includes('dbjson-maria-token'), 'no token in the boot log');
    // The admin backup is a copy of the database: the sessions in their stored
    // form — hashes, never tokens — so a restore into an empty directory keeps
    // them alive and boots.
    const backup = await (await fetch(`http://127.0.0.1:${port}/admin/backup`, { method: 'POST', headers: { 'x-admin-key': 'scoutbox-admin' } })).json();
    const copy = new DatabaseSync(path.join(backup.dir, 'scoutbox.db'), { readOnly: true });
    const exported = copy.prepare('SELECT token_hash, sid FROM sessions ORDER BY sid').all();
    copy.close();
    assert.deepEqual(exported.map((r) => r.sid), ['sid-json-kola', 'sid-json-maria']);
    assert.deepEqual(exported.map((r) => r.token_hash), [sha256(seed.sessions[0].token), sha256(seed.sessions[1].token)], 'the backup holds hashes only');
    assert.ok(!fs.readFileSync(path.join(backup.dir, 'scoutbox.db'), 'latin1').includes('dbjson-kola-token'));
    const restoreDir = tempDir('s2-restore'); fs.cpSync(backup.dir, restoreDir, { recursive: true });
    const port2 = await freePort();
    const restored = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port2), DATA_DIR: restoreDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = ''; restored.stdout.on('data', (d) => { log2 += d; }); restored.stderr.on('data', (d) => { log2 += d; });
    try {
      await new Promise((resolve, reject) => {
        restored.stdout.on('data', () => { if (/listening on/.test(log2)) resolve(); });
        restored.on('exit', (code, signal) => reject(new Error(`restored server exited ${code} (${signal}): ${log2}`)));
        setTimeout(() => reject(new Error(`restore boot timeout: ${log2}`)), 20_000).unref();
      });
      const status2 = async (p, token) => (await fetch(`http://127.0.0.1:${port2}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;
      assert.equal(await status2('/player/me', seed.sessions[0].token), 200, 'the player session survives backup and restore');
      assert.equal(await status2('/org/notifications', seed.sessions[1].token), 200, 'the org session survives backup and restore');
      assert.equal(await status2('/player/me', 'not-a-session'), 401);
    } finally {
      await new Promise((resolve) => { restored.on('exit', () => resolve()); restored.kill('SIGTERM'); });
      fs.rmSync(restoreDir, { recursive: true, force: true });
    }
  } finally {
    await new Promise((resolve) => { proc.on('exit', () => resolve()); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- SQLite is required (review correction 4)
test('without node:sqlite the store refuses to open with a compatibility error and touches nothing; the repositories refuse a missing connection', () => {
  const dir = tempDir('s2-nosqlite');
  const probe = execFileSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', `
    try { const { openStore } = await import(${JSON.stringify(path.join(HERE, '..', 'store.mjs'))}); openStore(process.argv[1], { tableBacked: [] }); console.log('OPENED'); }
    catch (err) { console.log('REFUSED ' + err.code + ' ' + err.message); }
  `, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(probe, /^REFUSED SQLITE_REQUIRED .*node:sqlite/m, 'a clear compatibility error, not a silent fallback');
  assert.ok(!probe.includes('OPENED'));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written: no database');
  assert.throws(() => createSessionsRepository({ sqlite: null, sessionTtlMs: TTL }), /SQLite connection/);
  assert.throws(() => attachDataLayer({ store: { sqlite: null }, nextId, sessionTtlMs: TTL }), /SQLite connection/);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} sessions checks passed`);
