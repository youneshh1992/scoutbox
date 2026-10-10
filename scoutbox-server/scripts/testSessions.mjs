// Behavioural tests for migration plan step S2: sessions become table-backed
// with hashed tokens. Everything runs on throwaway databases under the OS temp
// directory with synthetic fixtures; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createSessionsRepository, validateSessionRow, SESSIONS_TABLE, SESSIONS_CUTOVER_MIGRATION } from '../repositories/sessions.mjs';
import { rollbackSessionsCopy } from '../repositories/sessionsRollback.mjs';
import { createCoreIdentityShadow } from '../repositories/shadow.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import * as m0001 from '../repositories/migrations/0001_org_users.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0003 from '../repositories/migrations/0003_sessions_live.mjs';
import { openStore } from '../store.mjs';
import { buildSeed } from '../seed.mjs';
import { pickPort } from './testPort.mjs';

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
const seedUser = (s, id = 'usr-1', org = 'org-a') => s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, ?, 'Staff', 'Scout', 1)").run(id, org);

/** A legacy-shaped sessions blob (what the blob store held before S2). */
const legacySessions = (now = Date.now()) => [
  { token: 'legacy-player-token', sid: 'sid-pl', kind: 'player', refId: 'pl-1', createdAt: now - DAY },
  { token: 'legacy-guardian-token', sid: 'sid-gd', kind: 'guardian', refId: 'gd-1', createdAt: now - 2 * DAY },
  { token: 'legacy-org-token', sid: 'sid-org', kind: 'org', refId: 'org-a', userId: 'usr-1', createdAt: now - 3 * DAY },
  { token: 'legacy-sso-token', sid: 'sid-sso', kind: 'org', refId: 'org-a', userId: 'usr-1', via: 'sso', createdAt: now - 4 * DAY },
  { token: 'legacy-reviewer-token', sid: 'sid-ts', kind: 'ts_reviewer', refId: 'rev-1', createdAt: now - 5 * DAY },
];

/** A pre-S2 database file: blob collections (including sessions) plus the S0 and S1 tables. */
function preS2File(dir, { sessions = legacySessions(), users = [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }], extra = {} } = {}) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  runDataMigrations(s, [m0001, m0002]);
  for (const u of users) s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.orgId, u.name, u.role, u.createdAt);
  const put = s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)');
  put.run('sessions', JSON.stringify(sessions));
  put.run('players', JSON.stringify([{ id: 'pl-1', name: 'P' }]));
  for (const [k, v] of Object.entries(extra)) put.run(k, JSON.stringify(v));
  s.prepare("INSERT INTO meta (key, value) VALUES ('idCounter', '1000'), ('savedAt', '1'), ('saveSeq', '1')").run();
  s.close();
}
const fileDigest = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.close(); return sha256(fs.readFileSync(path.join(dir, 'scoutbox.db'))); };
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

// ------------------------------------------------------------- the cutover migration
test('cutover: a valid legacy blob is imported with hashed tokens, the blob is retired and completion is recorded, all in one transaction', () => {
  const dir = tempDir('s2-valid'); preS2File(dir);
  const s = openRaw(dir);
  const r = runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.deepEqual(r.ran, [SESSIONS_CUTOVER_MIGRATION]);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0, 'the legacy blob is gone');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'players'").get().n, 1, 'other blobs are untouched');
  const row = s.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256('legacy-org-token'));
  assert.equal(row.sid, 'sid-org'); assert.equal(row.org_user_id, 'usr-1'); assert.equal(row.expires_at, row.created_at + TTL);
  assert.equal(s.prepare("SELECT via FROM sessions WHERE sid = 'sid-sso'").get().via, 'sso');
  // Logical removal is immediate: no table or blob holds a plain token.
  const logical = JSON.stringify(s.prepare('SELECT * FROM sessions').all()) + JSON.stringify(s.prepare('SELECT * FROM collections').all());
  for (const l of legacySessions()) assert.ok(!logical.includes(l.token), `plain token ${l.token} is not in any table`);
  // Physical remnants of the deleted blob may still sit in free pages or the WAL until the file is vacuumed and checkpointed —
  // exactly the cleanup OPERATIONS.md prescribes after a cutover. After it, the bytes are gone.
  s.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.exec('VACUUM'); s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const physical = fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1') + (fs.existsSync(path.join(dir, 'scoutbox.db-wal')) ? fs.readFileSync(path.join(dir, 'scoutbox.db-wal'), 'latin1') : '');
  for (const l of legacySessions()) assert.ok(!physical.includes(l.token), `after VACUUM and checkpoint, plain token ${l.token} is gone from the file and journal`);
  const cut = JSON.parse(s.prepare("SELECT value FROM meta WHERE key = 'sessionsCutover'").get().value);
  assert.equal(cut.imported, 5); assert.equal(cut.blobPresent, true);
  assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'sessionTtlMs'").get().value, String(TTL));
  // Re-running is a no-op; a restart sees the same state.
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, []);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('cutover: an empty blob, a missing blob (first installation) and a stale populated shadow all cut over to a complete, correct table', () => {
  for (const variant of ['empty', 'missing', 'shadow']) {
    const dir = tempDir(`s2-${variant}`);
    preS2File(dir, { sessions: [] });
    const s = openRaw(dir);
    if (variant === 'missing') s.prepare("DELETE FROM collections WHERE name = 'sessions'").run();
    if (variant === 'shadow') s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, created_at, expires_at) VALUES ('stale', 'sid-stale', 'player', 'pl-1', 1, 2)").run();
    runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, `${variant}: no rows, stale shadow rows gone`);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 1, `${variant}: completion recorded`);
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0);
    const repo = createSessionsRepository({ sqlite: s, sessionTtlMs: TTL });
    assert.deepEqual(repo.attach(), { engine: 'sqlite', rows: 0 }, `${variant}: the repository attaches on the record, not on row count`);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // A bare database with no collections table at all (unit tests, a brand-new file).
  const bare = new DatabaseSync(':memory:'); bare.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(bare, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.equal(JSON.parse(bare.prepare("SELECT value FROM meta WHERE key = 'sessionsCutover'").get().value).blobPresent, false);
});
test('cutover: one unsupported row aborts the whole migration, the file is byte-identical, the blob stays authoritative, and a restart aborts the same way', () => {
  const bad = [...legacySessions(), { token: 'orphan-org', sid: 'sid-bad', kind: 'org', refId: 'org-a', userId: 'usr-gone', createdAt: Date.now() }];
  const dir = tempDir('s2-abort'); preS2File(dir, { sessions: bad });
  const s0 = openRaw(dir); s0.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, created_at, expires_at) VALUES ('shadow', 'sid-shadow', 'player', 'pl-1', 1, 2)").run(); s0.close();
  const before = fileDigest(dir);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const s = openRaw(dir);
    assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }), (err) => {
      assert.match(err.message, /SESSIONS_CUTOVER_BLOCKED/); assert.match(err.message, /sid sid-bad: staff member usr-gone does not exist/);
      assert.ok(!err.message.includes('orphan-org') && !err.message.includes('legacy-org-token'), 'the abort message names sids and reasons, never tokens');
      return true;
    }, `attempt ${attempt} aborts`);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 0, 'no completion record');
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 1, 'the blob is still there');
    assert.deepEqual(s.prepare('SELECT sid FROM sessions').all().map((r) => r.sid), ['sid-shadow'], 'the shadow rows were not touched: no partial cutover');
    assert.throws(() => createSessionsRepository({ sqlite: s, sessionTtlMs: TTL }).attach(), /cutover record .* is missing/, 'the repository refuses to treat the table as the truth');
    s.close();
  }
  assert.equal(fileDigest(dir), before, 'the file is byte-identical after two aborted attempts');
  // Every validation reason and both uniqueness rules abort too.
  const cases = [
    [{ sid: 'x', kind: 'player', refId: 'p', createdAt: 5 }, /no token/],
    [{ token: 't', sid: 'x', kind: 'player', refId: 'p', createdAt: 'yesterday' }, /positive integer/],
    [{ token: 't', sid: 'x', kind: 'wizard', refId: 'p', createdAt: 5 }, /not a session kind/],
    [{ token: 'legacy-player-token', sid: 'x', kind: 'player', refId: 'p', createdAt: 5 }, /duplicate token/],
    [{ token: 't', sid: 'sid-pl', kind: 'player', refId: 'p', createdAt: 5 }, /duplicate sid/],
  ];
  for (const [row, re] of cases) {
    const d = tempDir('s2-abort-case'); preS2File(d, { sessions: [...legacySessions(), row] });
    const s = openRaw(d);
    assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }), re);
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 1);
    s.close(); fs.rmSync(d, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
await atest('cutover: a pre-S0 database (staff still in the users blob) cuts over in one boot — staff imported first, then sessions, both blobs retired; an unknown staff id still aborts', async () => {
  const build = (sessions) => {
    const dir = tempDir('s2-pre-s0');
    const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
    s.exec('CREATE TABLE collections (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const put = s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)');
    put.run('users', JSON.stringify([{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }, { id: 'bogus' }]));
    put.run('sessions', JSON.stringify(sessions));
    s.prepare("INSERT INTO meta (key, value) VALUES ('idCounter', '1000'), ('savedAt', '1')").run();
    s.close();
    return dir;
  };
  const dir = build(legacySessions());
  const s = openRaw(dir);
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, ['0001_org_users', '0002_core_identity_shadow', SESSIONS_CUTOVER_MIGRATION]);
  assert.deepEqual(s.prepare('SELECT id FROM org_users').all().map((r) => r.id), ['usr-1'], 'the staff row was imported by the same rule S0 uses; the non-staff entry was not');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5);
  assert.deepEqual(s.prepare("SELECT name FROM collections ORDER BY name").all().map((r) => r.name), [], 'both legacy blobs are retired');
  // The S0 repository then attaches without re-importing and without a stale-blob warning.
  const logs = [], warns = [];
  const { createUsersRepository } = await import('../repositories/users.mjs');
  const users = createUsersRepository({ sqlite: s, nextId, persist: () => {}, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
  const boot = users.attach([{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }]);
  assert.deepEqual(boot, { engine: 'sqlite', loaded: 1, imported: 0 }); assert.deepEqual(warns, []); assert.match(logs.join('\n'), /superseded by the table/);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
  // An org session naming a staff id the blob does not hold aborts, and nothing was imported.
  const dir2 = build([{ token: 'orphan', sid: 'sid-x', kind: 'org', refId: 'org-a', userId: 'usr-ghost', createdAt: 5 }]);
  const s2 = openRaw(dir2);
  assert.throws(() => runDataMigrations(s2, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }), /staff member usr-ghost does not exist/);
  assert.equal(s2.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('users', 'sessions')").get().n, 2, 'both blobs are still authoritative');
  assert.equal(s2.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'org_users'").get().n, 1, '0001 and 0002 committed on their own; only the cutover rolled back');
  assert.equal(s2.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 0);
  s2.close(); fs.rmSync(dir2, { recursive: true, force: true });
});
test('cutover: a failure injected after the import but before commit leaves no trace, and the next boot cuts over cleanly', () => {
  const dir = tempDir('s2-inject'); preS2File(dir);
  const s = openRaw(dir);
  const before = fileDigest(dir);
  const exploding = { id: m0003.id, note: m0003.note, up(sqlite, ctx) { m0003.up(sqlite, ctx); assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5, 'rows were written inside the transaction'); throw new Error('process died before commit'); } };
  assert.throws(() => runDataMigrations(s, [m0001, m0002, exploding], { context: { sessionTtlMs: TTL } }), /process died before commit/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 1);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 0);
  s.close();
  assert.equal(fileDigest(dir), before, 'nothing of the failed attempt reached the file');
  const again = openRaw(dir);
  assert.deepEqual(runDataMigrations(again, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [SESSIONS_CUTOVER_MIGRATION]);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5);
  again.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- the repository
const liveRepo = (opts = {}) => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: opts.sessionTtlMs ?? TTL } });
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
  const dir = tempDir('s2-ttl'); preS2File(dir, { sessions: [] });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: 7 * DAY } });
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

// ------------------------------------------------------------- the shadow never touches live sessions
test('shadow validation, even when enabled, never writes or deletes live sessions', () => {
  const dir = tempDir('s2-shadow');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [{ id: 'org-a', name: 'A', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' }], guardians: [], players: [], sessions: [{ token: 'ghost', sid: 'ghost', kind: 'player', refId: 'pl-1', createdAt: 1 }], users: [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  const { token } = layer.sessions.create('org', 'org-a', { userId: db.users[0].id });
  for (let i = 1; i <= 3; i++) store.save({ savedAt: i, idCounter: 1000, db });
  assert.ok(layer.sessions.byToken(token), 'the live session survived three projecting saves');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'no fixture session was projected, the live row remains');
  assert.equal(layer.report().shadow.status, 'complete');
  assert.ok(!('sessions' in layer.report().shadow.tables));
  assert.deepEqual(layer.report().domains.sessions, { rows: 1, mode: 'live', lifetimeMs: TTL });
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- snapshot round trips
test('snapshot mode: load exposes hashed rows, save writes them back unchanged, fabricated plain-token rows are hashed, unrepresentable rows are skipped and counted', () => {
  const dir = tempDir('s2-snap');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [], guardians: [], players: [], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const a = layer.sessions.create('player', 'pl-1'), b = layer.sessions.create('org', 'org-a', { userId: 'usr-1' });
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  const tool = openStore(dir);
  const snap = tool.load();
  assert.equal(snap.db.sessions.length, 2);
  const rowA = snap.db.sessions.find((x) => x.sid === a.session.sid);
  assert.equal(rowA.tokenHash, sha256(a.token)); assert.ok(!('token' in rowA));
  assert.equal(JSON.stringify(snap.db).includes(a.token), false);
  // Round trip: write the snapshot back; the rows are the same; a fabricated plain-token row is hashed; junk is skipped.
  const warnings = [];
  snap.db.sessions.push({ token: 'fixture-token', sid: 'sid-fx', kind: 'player', refId: 'pl-9', createdAt: Date.now() - 2 * DAY });
  snap.db.sessions.push({ sid: 'sid-junk', kind: 'player', refId: 'pl-9', createdAt: 'yesterday', token: 'junk' });
  tool.save(snap);
  const written = SESSIONS_TABLE.read(tool.sqlite);
  assert.deepEqual(written.map((x) => x.sid).sort(), [a.session.sid, b.session.sid, 'sid-fx'].sort(), 'the junk row was not written');
  assert.equal(written.find((x) => x.sid === 'sid-fx').tokenHash, sha256('fixture-token'));
  const res = transaction(tool.sqlite, () => SESSIONS_TABLE.replace(tool.sqlite, snap.db.sessions, { warn: (m) => warnings.push(m) }));
  assert.equal(res.skipped, 1); assert.match(warnings[0], /not written \(createdAt is not a positive integer timestamp\)/);
  tool.sqlite.close();
  // The server reads the round-tripped rows and the original tokens still work.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token) && layer2.sessions.byToken(b.token) && layer2.sessions.byToken('fixture-token'));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('snapshot mode: writing the users collection back does not cascade-delete valid sessions; a removed user still takes theirs', () => {
  const dir = tempDir('s2-cascade');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [], guardians: [], players: [], sessions: [], users: [{ id: 'usr-1', orgId: 'org-a', name: 'A', role: 'Scout', createdAt: 1 }, { id: 'usr-2', orgId: 'org-a', name: 'B', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const s1 = layer.sessions.create('org', 'org-a', { userId: 'usr-1' }), s2 = layer.sessions.create('org', 'org-a', { userId: 'usr-2' });
  store.save({ savedAt: 1, idCounter: 1000, db }); store.sqlite.close();
  // A tool writes a snapshot that carries users but no sessions key at all.
  const tool = openStore(dir);
  tool.save({ savedAt: 2, idCounter: 1000, db: { orgs: [], players: [], users: [...db.users].map((u) => ({ ...u })) } });
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2, 'both staff sessions survive a users write');
  // A snapshot in which usr-2 no longer exists: only usr-2's session goes.
  tool.save({ savedAt: 3, idCounter: 1000, db: { orgs: [], players: [], users: [{ ...db.users[0] }] } });
  assert.deepEqual(tool.sqlite.prepare('SELECT sid FROM sessions').all().map((r) => r.sid), [s1.session.sid]);
  tool.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(s1.token)); assert.equal(layer2.sessions.byToken(s2.token), null);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- concurrency
test('busy timeout: a save waits for a concurrent writer in another process instead of failing; without the pragma the same situation fails at once', () => {
  const dir = tempDir('s2-busy');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  attachDataLayer({ db: { orgs: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db: { orgs: [], players: [] } });
  const holdMs = 1200;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
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
    store.save({ savedAt: 2, idCounter: 1000, db: { orgs: [], players: [{ id: 'p' }] } });
    const waited = Date.now() - t0;
    assert.ok(waited >= holdMs - 300, `the store waited for the lock (${waited} ms)`);
    assert.deepEqual(store.load().db.players, [{ id: 'p' }]);
  };
  return run().finally(() => { try { holder.kill(); } catch { /* done */ } store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });
});

// ------------------------------------------------------------- rollback
test('rollback: the tool produces a copy with the cutover record removed, the table emptied, an empty legacy blob and every other collection intact; it refuses a later schema', () => {
  const dir = tempDir('s2-rb-src'); preS2File(dir, { extra: { notes: [{ id: 'n1' }] } });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  const repo = createSessionsRepository({ sqlite: s, sessionTtlMs: TTL }); repo.attach();
  const fresh = repo.create('player', 'pl-1');
  s.close();
  const before = fileDigest(dir);
  const out = tempDir('s2-rb-out');
  const result = rollbackSessionsCopy(path.join(dir, 'scoutbox.db'), out);
  assert.equal(result.sessionsRemoved, 6); assert.equal(result.recordRemoved, true);
  assert.equal(fileDigest(dir), before, 'the source is untouched');
  const o = openRaw(out);
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 0);
  assert.deepEqual(o.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id), ['0001_org_users', '0002_core_identity_shadow'], 'S0 and S1 records stay');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(o.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value, '[]');
  assert.equal(o.prepare("SELECT value FROM collections WHERE name = 'notes'").get().value, '[{"id":"n1"}]', 'other collections are kept');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 1);
  assert.ok(!fs.readFileSync(path.join(out, 'scoutbox.db'), 'utf8').includes(sha256(fresh.token)), 'the vacuumed copy holds no session hash');
  o.close();
  // The pre-S2 store (snapshot/server mode without the sessions table in TABLE_BACKED) reads an empty sessions collection.
  const legacyRead = new DatabaseSync(path.join(out, 'scoutbox.db'));
  assert.deepEqual(JSON.parse(legacyRead.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value), []);
  legacyRead.close();
  // Refuse to touch a database that carries a later schema step.
  const later = openRaw(dir); later.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0004_orgs_live', 1)").run(); later.close();
  const out2 = tempDir('s2-rb-out2');
  const beforeRefusal = fileDigest(dir);
  assert.throws(() => rollbackSessionsCopy(path.join(dir, 'scoutbox.db'), out2), (err) => err.code === 'LATER_SCHEMA' && /0004_orgs_live/.test(err.message));
  assert.ok(!fs.existsSync(path.join(out2, 'scoutbox.db')), 'a refused rollback leaves no output file (the untouched copy would look like a finished rollback)');
  assert.deepEqual(fs.readdirSync(out2), [], 'no WAL or shm remnant of the copy either');
  assert.equal(fileDigest(dir), beforeRefusal, 'the source is untouched by a refusal too');
  // The CLI exits 4 on that refusal and 0 on success.
  const script = path.join(HERE, 'sessionsRollback.mjs');
  const cliOut = tempDir('s2-rb-cli');
  try { execFileSync(process.execPath, [script, dir, path.join(cliOut, 'x')], { stdio: 'pipe' }); assert.fail('should refuse'); } catch (err) { assert.equal(err.status, 4); }
  for (const d of [dir, out, out2, cliOut]) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------- through the real server
await atest('server: legacy bearer tokens survive the cutover and a restart, media links and event streams follow the session, and every revocation path answers 401', async () => {
  const dir = tempDir('s2-server');
  // A pre-S2 file built from the real seed plus legacy plain-token sessions.
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [
    { token: 'legacy-kola-token-000000000000000000000000000', sid: 'sid-kola', kind: 'player', refId: 'pl-adeyemi', createdAt: Date.now() - DAY },
    { token: 'legacy-maria-token-00000000000000000000000000', sid: 'sid-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY },
  ];
  openStore(dir).save({ savedAt: Date.now(), idCounter: 1000, db: seed }); // snapshot mode on a fresh dir: everything is a blob
  const port = pickPort(7700, 100);
  const boot = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve({ proc, log: () => log }); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}) on port ${port}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000);
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
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 200, 'a legacy player token works after the cutover');
    const notif = await j('GET', '/org/notifications', undefined, maria);
    assert.equal(notif.status, 200, 'a legacy staff token works after the cutover');
    // The file holds no plain token and no sessions blob.
    const raw = openRaw(dir);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0, 'the legacy blob is retired');
    assert.ok(raw.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(kola)), 'the legacy session is in the table by hash');
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
    // Restart: the table is the source of truth; the legacy tokens still work.
    // Between the two boots run the post-cutover cleanup an operator would run:
    // afterwards the plain tokens the blob once held are gone from the file too.
    await stop(S);
    { const c = openRaw(dir); c.exec('PRAGMA wal_checkpoint(TRUNCATE)'); c.exec('VACUUM'); c.exec('PRAGMA wal_checkpoint(TRUNCATE)'); c.close(); }
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes('legacy-kola-token'), 'after checkpoint and vacuum the file holds no plain token');
    S = await boot();
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 200, 'the legacy player token survives a restart');
    // Signed media URL bound to the session dies with logout.
    const me = await j('GET', '/player/me', undefined, kola);
    const mediaUrl = JSON.stringify(me.body).match(/\/media\/[A-Za-z0-9-]+\?e=\d+&s=[A-Za-z0-9_-]+&v=sid-kola/)?.[0];
    if (mediaUrl) {
      const fetched = await fetch(`http://127.0.0.1:${port}${mediaUrl}`);
      assert.ok([200, 404].includes(fetched.status), `signed link resolves the session (${fetched.status})`);
    }
    assert.equal((await j('POST', '/auth/logout', {}, kola)).status, 200);
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 401, 'logout revokes the legacy token');
    if (mediaUrl) assert.equal((await fetch(`http://127.0.0.1:${port}${mediaUrl}`)).status, 401, 'a signed media link dies with its session');
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

console.log(`\n${passed} sessions checks passed`);
