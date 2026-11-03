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
import { createSessionsRepository, validateSessionRow, SESSIONS_TABLE, SESSIONS_CUTOVER_MIGRATION } from '../repositories/sessions.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
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
/** A minimal player record migration 0005 accepts (dob and country are required; everything else is optional). */
const PLAYER_1 = (name = 'P') => ({ id: 'pl-1', name, dob: '2001-01-01', country: 'GB' });
const seedOrg = (s, id = 'org-a') => s.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan) VALUES (?, 'Org', 'club', 'pro', 'Pro')").run(id);
const seedUser = (s, id = 'usr-1', org = 'org-a') => { seedOrg(s, org); s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, ?, 'Staff', 'Scout', 1)").run(id, org); };

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
test('repository: create returns the token once; the table and the view hold only the hash-free row; lookup is by hash', () => {
  const { s, repo } = liveRepo();
  const { token, session } = repo.create('player', 'pl-1');
  assert.equal(token.length, 48); assert.equal(session.kind, 'player'); assert.equal(session.refId, 'pl-1'); assert.ok(session.sid);
  assert.ok(!('token' in session) && !('tokenHash' in session));
  assert.deepEqual(repo.byToken(token), session);
  assert.equal(repo.byToken('not-a-token'), null); assert.equal(repo.byToken(''), null); assert.equal(repo.byToken(null), null);
  assert.deepEqual(repo.bySid(session.sid), session); assert.equal(repo.bySid('nope'), null);
  const dump = JSON.stringify(s.prepare('SELECT * FROM sessions').all()) + JSON.stringify([...repo.view]);
  assert.ok(!dump.includes(token), 'the plain token appears nowhere');
  assert.ok(JSON.stringify([...repo.view]).includes(session.sid) && !JSON.stringify([...repo.view]).includes(sha256(token)), 'the view carries neither token nor hash');
  assert.throws(() => { repo.view.push({}); }, /repositories|read-only|a session/);
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
  // a staff row deleted outright (snapshot replace of a removed user) cascades its sessions and nothing else
  s.prepare("DELETE FROM org_users WHERE id = 'usr-2'").run();
  assert.deepEqual(alive(), [u3.session.sid, r2.session.sid].sort());
  s.close();
});

// ------------------------------------------------------------- snapshot round trips
test('snapshot mode: load exposes hashed rows, save writes them back unchanged, a fabricated plain-token row is hashed, and the server reads the round trip', () => {
  const dir = tempDir('s2-snap');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [ORG_A], guardians: [], players: [], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const a = layer.sessions.create('player', 'pl-1'), b = layer.sessions.create('org', 'org-a', { userId: 'usr-1' });
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  const tool = openStore(dir);
  const snap = tool.load();
  assert.equal(snap.db.sessions.length, 2);
  const rowA = snap.db.sessions.find((x) => x.sid === a.session.sid);
  assert.equal(rowA.tokenHash, sha256(a.token)); assert.ok(!('token' in rowA));
  assert.equal(JSON.stringify(snap.db).includes(a.token), false);
  // Round trip: write the snapshot back; the rows are the same; a fabricated plain-token row (a test fixture) is hashed on the way in.
  snap.db.sessions.push({ token: 'fixture-token', sid: 'sid-fx', kind: 'player', refId: 'pl-9', createdAt: Date.now() - 2 * DAY });
  tool.save(snap);
  const written = SESSIONS_TABLE.read(tool.sqlite);
  assert.deepEqual(written.map((x) => x.sid).sort(), [a.session.sid, b.session.sid, 'sid-fx'].sort());
  assert.equal(written.find((x) => x.sid === 'sid-fx').tokenHash, sha256('fixture-token'));
  assert.equal(written.find((x) => x.sid === a.session.sid).tokenHash, sha256(a.token), 'a hashed row round-trips byte for byte');
  assert.equal(JSON.stringify(written).includes('fixture-token'), false);
  tool.sqlite.close();
  // The server reads the round-tripped rows and the original tokens still work.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token) && layer2.sessions.byToken(b.token) && layer2.sessions.byToken('fixture-token'));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('snapshot mode (review correction 3): an invalid or conflicting session row rejects the whole save; sessions and unrelated data are untouched', () => {
  const dir = tempDir('s2-snap-reject');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [ORG_A], guardians: [], players: [PLAYER_1('Original')], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'A', role: 'Scout', createdAt: 1 }, { id: 'usr-2', orgId: 'org-a', name: 'B', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const a = layer.sessions.create('player', 'pl-1'), b = layer.sessions.create('org', 'org-a', { userId: 'usr-2' });
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  const tool = openStore(dir);
  const before = tool.load();
  const untouched = () => {
    const now = tool.load();
    assert.deepEqual(now.db.sessions, before.db.sessions, 'the sessions are exactly what they were');
    assert.equal(now.db.players[0].name, 'Original', 'the unrelated player change was rolled back with the rest of the save');
    assert.equal(now.saveSeq, before.saveSeq, 'no save revision was spent');
    assert.deepEqual(now.db.users.map((u) => u.id), ['usr-1', 'usr-2']);
  };
  const attempt = (mutate, pattern) => {
    const snap = tool.load();
    snap.db.players[0].name = 'Changed';
    mutate(snap);
    assert.throws(() => tool.save(snap), pattern);
    untouched();
  };
  // Codex's reproduction: a malformed createdAt beside an unrelated player change.
  attempt((s) => { s.db.sessions.find((x) => x.sid === a.session.sid).createdAt = 'yesterday'; }, /sessions: snapshot row .*createdAt is not a positive integer timestamp/);
  // Other malformed rows.
  attempt((s) => { s.db.sessions.push({ sid: 'sid-nokind', refId: 'pl-1', createdAt: 5, tokenHash: sha256('x') }); }, /kind "undefined" is not a session kind/);
  attempt((s) => { s.db.sessions.push({ sid: 'sid-notoken', kind: 'player', refId: 'pl-1', createdAt: 5 }); }, /no token/);
  attempt((s) => { s.db.sessions.push({ sid: 'sid-extra', kind: 'player', refId: 'pl-1', createdAt: 5, tokenHash: sha256('y'), colour: 'red' }); }, /unknown field "colour"/);
  attempt((s) => { s.db.sessions.push('not-a-row'); }, /not an object/);
  // Duplicate session id and duplicate token hash.
  attempt((s) => { s.db.sessions.push({ ...s.db.sessions[0], tokenHash: sha256('other') }); }, /duplicate sid/);
  attempt((s) => { s.db.sessions.push({ ...s.db.sessions[0], sid: 'sid-dup-hash' }); }, /duplicate token/);
  // A staff relationship the snapshot itself contradicts: usr-2 is gone from users but their session is still listed.
  attempt((s) => { s.db.users = s.db.users.filter((u) => u.id !== 'usr-2'); }, /staff member usr-2 does not exist|FOREIGN KEY/);
  // A staff field of the wrong type refuses the whole snapshot write by code, id and field (typed columns, valid input only).
  attempt((s) => { s.db.users[0].email = ['not', 'text']; }, /ORG_USERS_SNAPSHOT_INVALID: staff usr-\S+: email must be text/);
  // Nothing was removed by any refused save; the plain error text names sids and reasons, never a token or hash.
  try { const s = tool.load(); s.db.sessions[0].createdAt = -1; tool.save(s); assert.fail('unreachable'); } catch (err) {
    assert.ok(!err.message.includes(a.token) && !err.message.includes(sha256(a.token)) && !err.message.includes(b.token), 'the error carries no token or hash');
  }
  // A valid save (an unrelated change, sessions as read) still commits.
  const ok = tool.load(); ok.db.players[0].name = 'Renamed'; tool.save(ok);
  assert.equal(tool.load().db.players[0].name, 'Renamed');
  assert.deepEqual(tool.load().db.sessions, before.db.sessions);
  tool.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token) && layer2.sessions.byToken(b.token), 'both sessions survived every refused save');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('snapshot mode: writing the users collection back does not cascade-delete valid sessions; a removed user still takes theirs', () => {
  const dir = tempDir('s2-cascade');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [ORG_A], guardians: [], players: [], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'A', role: 'Scout', createdAt: 1 }, { id: 'usr-2', orgId: 'org-a', name: 'B', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const s1 = layer.sessions.create('org', 'org-a', { userId: 'usr-1' }), s2 = layer.sessions.create('org', 'org-a', { userId: 'usr-2' });
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  // A tool writes a snapshot that carries users but no sessions key at all.
  const tool = openStore(dir);
  tool.save({ savedAt: 2, idCounter: 1000, db: { orgs: [ORG_A], players: [], guardians: [], users: [...db.users].map((u) => ({ ...u })) } });
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2, 'both staff sessions survive a users write');
  // A snapshot in which usr-2 no longer exists: only usr-2's session goes.
  tool.save({ savedAt: 3, idCounter: 1000, db: { orgs: [ORG_A], players: [], guardians: [], users: [{ ...db.users[0] }] } });
  assert.deepEqual(tool.sqlite.prepare('SELECT sid FROM sessions').all().map((r) => r.sid), [s1.session.sid]);
  tool.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(s1.token)); assert.equal(layer2.sessions.byToken(s2.token), null);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- concurrency
await atest('busy timeout: a save waits for a concurrent writer in another process instead of failing; without the pragma the same situation fails at once', async () => {
  const dir = tempDir('s2-busy');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  attachDataLayer({ db: { orgs: [ORG_A], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db: { orgs: [], players: [], guardians: [] } });
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
    store.save({ savedAt: 2, idCounter: 1000, db: { orgs: [], players: [], guardians: [], notes: [{ id: 'p' }] } }); // notes: a blob collection (players are table-backed since S4a)
    const waited = Date.now() - t0;
    assert.ok(waited >= holdMs - 300, `the store waited for the lock (${waited} ms)`);
    assert.deepEqual(store.load().db.notes, [{ id: 'p' }]);
  };
  // Awaited by the harness: the check counts only once every assertion above has passed.
  try { await run(); } finally { try { holder.kill(); } catch { /* done */ } store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- through the real server
await atest('server: plain-token sessions in a fixture are stored as hashes, their tokens work after boot and a restart, media links and event streams follow the session, and every revocation path answers 401', async () => {
  const dir = tempDir('s2-server');
  // A fixture built from the real seed plus plain-token sessions (the snapshot save hashes them).
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [
    { token: 'legacy-kola-token-000000000000000000000000000', sid: 'sid-kola', kind: 'player', refId: 'pl-adeyemi', createdAt: Date.now() - DAY },
    { token: 'legacy-maria-token-00000000000000000000000000', sid: 'sid-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY },
  ];
  // A deterministic media fixture: one of Kola's clips has a stored file (the
  // snapshot carries it as a data URL, which the server moves onto storage at
  // boot), so a signed media link must resolve to 200 with these bytes.
  const clip = seed.players.find((p) => p.id === 'pl-adeyemi').media[0];
  const clipBytes = Buffer.from('synthetic-webm-bytes-for-the-sessions-suite');
  clip.url = `/media/${clip.id}`;
  seed.mediaBlobs = { [clip.id]: { dataUrl: `data:video/webm;base64,${clipBytes.toString('base64')}` } };
  { const t = openStore(dir); t.save({ savedAt: Date.now(), idCounter: 1000, db: seed }); t.sqlite.close(); } // snapshot mode: the sessions go into their table, hashed
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
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0, 'no sessions blob');
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
  seed.mediaBlobs = { [clip.id]: { dataUrl: `data:video/webm;base64,${Buffer.from('synthetic-media-secret-bytes').toString('base64')}` } };
  { const t = openStore(dir); t.save({ savedAt: Date.now(), idCounter: 1000, db: seed }); t.sqlite.close(); }
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
    const raw = openRaw(dir);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'secrets'").get().n, 0, 'no secrets collection is saved');
    raw.close();
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
  { const t = openStore(dir); t.save({ savedAt: Date.now(), idCounter: 1000, db: seed }); t.sqlite.close(); }
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

// ------------------------------------------------------------- collection shape (review correction 5)
test('snapshot mode (review correction 5): a table-backed collection that is not an array is refused whole; an omitted collection is a partial snapshot', () => {
  const dir = tempDir('s2-shape');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [ORG_A], guardians: [], players: [PLAYER_1('Original')], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'A', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const a = layer.sessions.create('player', 'pl-1');
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  const tool = openStore(dir);
  const before = tool.load();
  const PLAIN = 'synthetic-plaintext-token-that-must-never-be-written';
  const untouched = () => {
    const now = tool.load();
    assert.deepEqual(now.db.sessions, before.db.sessions, 'the stored sessions are exactly what they were');
    assert.deepEqual(now.db.users, before.db.users);
    assert.equal(now.db.players[0].name, 'Original', 'the unrelated player change was rolled back');
    assert.equal(now.saveSeq, before.saveSeq, 'no save revision was spent');
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('sessions', 'users')").get().n, 0, 'no blob was written for a table-backed collection');
    assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'the live table still holds the session');
    tool.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes(PLAIN), 'the plaintext token is nowhere in the file');
  };
  const attempt = (collection, value, pattern) => {
    const snap = tool.load();
    snap.db.players[0].name = 'Changed';
    snap.db[collection] = value;
    assert.throws(() => tool.save(snap), pattern);
    untouched();
  };
  // Codex's reproduction: an object carrying a plaintext token in place of the sessions array.
  attempt('sessions', { token: PLAIN, sid: 'sid-obj', kind: 'player', refId: 'pl-1', createdAt: 5 }, /sessions.*must be an array.*got an object/);
  attempt('sessions', null, /sessions.*must be an array.*got null/);
  attempt('sessions', 'not-a-collection', /sessions.*must be an array.*got a string/);
  attempt('sessions', 42, /sessions.*must be an array.*got a number/);
  // The same protection for the other migrated collection.
  attempt('users', { id: 'usr-x', orgId: 'org-a', name: 'X', role: 'Scout' }, /users.*must be an array.*got an object/);
  attempt('users', null, /users.*must be an array.*got null/);
  // An omitted collection is a partial snapshot: the save commits and leaves that table alone.
  const partial = tool.load(); delete partial.db.sessions; delete partial.db.users; partial.db.players[0].name = 'Renamed';
  tool.save(partial);
  assert.equal(tool.load().db.players[0].name, 'Renamed');
  assert.deepEqual(tool.load().db.sessions, before.db.sessions); assert.deepEqual(tool.load().db.users, before.db.users);
  tool.sqlite.close();
  // The server still reads the untouched session.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- SQLite is required (review correction 4)
test('without node:sqlite the store refuses to open with a compatibility error and touches nothing; the repositories refuse a missing connection', () => {
  const dir = tempDir('s2-nosqlite');
  const probe = execFileSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', `
    try { const { openStore } = await import(${JSON.stringify(path.join(HERE, '..', 'store.mjs'))}); openStore(process.argv[1]); console.log('OPENED'); }
    catch (err) { console.log('REFUSED ' + err.code + ' ' + err.message); }
  `, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(probe, /^REFUSED SQLITE_REQUIRED .*node:sqlite/m, 'a clear compatibility error, not a silent fallback');
  assert.ok(!probe.includes('OPENED'));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written: no database');
  assert.throws(() => createSessionsRepository({ sqlite: null, sessionTtlMs: TTL }), /SQLite connection/);
  assert.throws(() => attachDataLayer({ db: { users: [], sessions: [] }, store: { sqlite: null }, nextId, persist: () => {}, sessionTtlMs: TTL }), /SQLite connection/);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} sessions checks passed`);
