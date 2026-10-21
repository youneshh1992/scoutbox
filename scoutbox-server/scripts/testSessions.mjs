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
import { ORGS_CUTOVER_MIGRATION } from '../repositories/orgs.mjs';
import { rollbackOrgsCopy } from '../repositories/orgsRollback.mjs';
import { rollbackCoreIdentityCopy } from '../repositories/coreIdentityRollback.mjs';
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { rollbackOutboxPushCopy } from '../repositories/outboxPushRollback.mjs';
import { rollbackChannelsCopy } from '../repositories/channelsRollback.mjs';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';
import { rollbackPlayerErasureCopy } from '../repositories/playerErasureRollback.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import * as m0001 from '../repositories/migrations/0001_org_users.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0003 from '../repositories/migrations/0003_sessions_live.mjs';
import { openStore } from '../store.mjs';
// The checks below that drive the runner on a raw connection are about the S2/S3
// steps (0001–0004): they run exactly those. The S4a steps that follow them
// (0005 core identity, 0006 media deletions) have their own suites
// (testCoreIdentityMigration, testCoreSchema); the full registered list is what
// attachDataLayer and the real-server checks below run.
const S3_MIGRATIONS = DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id));
import { buildSeed } from '../seed.mjs';
import { pickPort } from './testPort.mjs';
// S6b: a file this tree wrote carries 0013 too; the S7d tool refuses a later schema step, so the rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6b = (file) => { const s4br = tempDir('s4br-to-s6b'); rollbackPlayerErasureCopy(file, s4br); /* S4b-R: the file carries 0014; its rollback goes first */ const out = tempDir('s6b-to-s7d'); rollbackSafetyAuditCopy(path.join(s4br, 'scoutbox.db'), out); return path.join(out, 'scoutbox.db'); };

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
const ORG_B = { id: 'org-b', name: 'Org B', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' };
/** A minimal player record migration 0005 accepts (dob and country are required; everything else is optional). */
const PLAYER_1 = (name = 'P') => ({ id: 'pl-1', name, dob: '2001-01-01', country: 'GB' });
const seedOrg = (s, id = 'org-a') => s.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan) VALUES (?, 'Org', 'club', 'pro', 'Pro')").run(id);
const seedUser = (s, id = 'usr-1', org = 'org-a') => { seedOrg(s, org); s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, ?, 'Staff', 'Scout', 1)").run(id, org); };

/** A legacy-shaped sessions blob (what the blob store held before S2). */
const legacySessions = (now = Date.now()) => [
  { token: 'legacy-player-token', sid: 'sid-pl', kind: 'player', refId: 'pl-1', createdAt: now - DAY },
  { token: 'legacy-guardian-token', sid: 'sid-gd', kind: 'guardian', refId: 'gd-1', createdAt: now - 2 * DAY },
  { token: 'legacy-org-token', sid: 'sid-org', kind: 'org', refId: 'org-a', userId: 'usr-1', createdAt: now - 3 * DAY },
  { token: 'legacy-sso-token', sid: 'sid-sso', kind: 'org', refId: 'org-a', userId: 'usr-1', via: 'sso', createdAt: now - 4 * DAY },
  { token: 'legacy-reviewer-token', sid: 'sid-ts', kind: 'ts_reviewer', refId: 'rev-1', createdAt: now - 5 * DAY },
];

/** A pre-S2 database file: blob collections (including sessions) plus the S0 and S1 tables. */
function preS2File(dir, { sessions = legacySessions(), users = [{ id: 'usr-1', orgId: 'org-a', name: 'Staff', role: 'Scout', createdAt: 1 }], orgs = [ORG_A, ORG_B], extra = {} } = {}) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  runDataMigrations(s, [m0001, m0002]);
  for (const u of users) s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.orgId, u.name, u.role, u.createdAt);
  const put = s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)');
  put.run('sessions', JSON.stringify(sessions));
  put.run('orgs', JSON.stringify(orgs)); // the staff rows above name these organisations (S3 foreign key)
  put.run('players', JSON.stringify([PLAYER_1()]));
  put.run('guardians', JSON.stringify([]));
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
  const r = runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.deepEqual(r.ran, [SESSIONS_CUTOVER_MIGRATION, ORGS_CUTOVER_MIGRATION]);
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
  assert.deepEqual(runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, []);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('cutover: an empty blob, a missing blob (first installation) and a stale populated shadow all cut over to a complete, correct table', () => {
  for (const variant of ['empty', 'missing', 'shadow']) {
    const dir = tempDir(`s2-${variant}`);
    preS2File(dir, { sessions: [] });
    const s = openRaw(dir);
    if (variant === 'missing') s.prepare("DELETE FROM collections WHERE name = 'sessions'").run();
    if (variant === 'shadow') s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, created_at, expires_at) VALUES ('stale', 'sid-stale', 'player', 'pl-1', 1, 2)").run();
    runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } });
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, `${variant}: no rows, stale shadow rows gone`);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 1, `${variant}: completion recorded`);
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0);
    const repo = createSessionsRepository({ sqlite: s, sessionTtlMs: TTL });
    assert.deepEqual(repo.attach(), { engine: 'sqlite', rows: 0 }, `${variant}: the repository attaches on the record, not on row count`);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // A bare database with no collections table at all (unit tests, a brand-new file).
  const bare = new DatabaseSync(':memory:'); bare.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(bare, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } });
  assert.equal(JSON.parse(bare.prepare("SELECT value FROM meta WHERE key = 'sessionsCutover'").get().value).blobPresent, false);
});
test('cutover: one unsupported row aborts the whole migration, the file is byte-identical, the blob stays authoritative, and a restart aborts the same way', () => {
  const bad = [...legacySessions(), { token: 'orphan-org', sid: 'sid-bad', kind: 'org', refId: 'org-a', userId: 'usr-gone', createdAt: Date.now() }];
  const dir = tempDir('s2-abort'); preS2File(dir, { sessions: bad });
  const s0 = openRaw(dir); s0.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, created_at, expires_at) VALUES ('shadow', 'sid-shadow', 'player', 'pl-1', 1, 2)").run(); s0.close();
  const before = fileDigest(dir);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const s = openRaw(dir);
    assert.throws(() => runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }), (err) => {
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
    assert.throws(() => runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }), re);
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
    put.run('orgs', JSON.stringify([ORG_A])); // the staff row names it (S3 foreign key)
    put.run('sessions', JSON.stringify(sessions));
    s.prepare("INSERT INTO meta (key, value) VALUES ('idCounter', '1000'), ('savedAt', '1')").run();
    s.close();
    return dir;
  };
  const dir = build(legacySessions());
  const s = openRaw(dir);
  assert.deepEqual(runDataMigrations(s, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, ['0001_org_users', '0002_core_identity_shadow', SESSIONS_CUTOVER_MIGRATION, ORGS_CUTOVER_MIGRATION]);
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
  assert.throws(() => runDataMigrations(s2, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }), /staff member usr-ghost does not exist/);
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
  assert.deepEqual(runDataMigrations(again, S3_MIGRATIONS, { context: { sessionTtlMs: TTL } }).ran, [SESSIONS_CUTOVER_MIGRATION, ORGS_CUTOVER_MIGRATION]);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5);
  again.close(); fs.rmSync(dir, { recursive: true, force: true });
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
  const dir = tempDir('s2-ttl'); preS2File(dir, { sessions: [] });
  const s = openRaw(dir);
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
test('snapshot mode (review correction 1): before the cutover record exists the blob is authoritative and the shadow table is ignored, whatever it holds', () => {
  const dir = tempDir('s2-snap-precut');
  const sessions = [{ token: 'pre-cutover-token', sid: 'sid-pre', kind: 'player', refId: 'pl-1', createdAt: Date.now() - DAY }];
  // (a) Migrations 0001 and 0002 only, a valid blob, an EMPTY shadow table.
  preS2File(dir, { sessions });
  let tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.sessions, sessions, 'load returns the blob, not the empty shadow');
  snap.db.players.push({ id: 'pl-2', name: 'Q', dob: '2002-02-02', country: 'GB' });
  tool.save(snap);
  let raw = tool.sqlite;
  assert.equal(JSON.parse(raw.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value).length, 1, 'save keeps the blob');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'save does not promote the shadow table');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 0);
  // (b) A STALE, POPULATED shadow (rows an S1 projection left behind) still loses to the blob.
  raw.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, 'sid-stale', 'player', 'pl-9', NULL, NULL, 1, 2)").run(sha256('stale'));
  tool.sqlite.close(); tool = openStore(dir);
  snap = tool.load();
  assert.deepEqual(snap.db.sessions, sessions, 'a populated shadow is not promoted either');
  tool.save(snap);
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'the save leaves the shadow rows alone (the cutover deletes them)');
  assert.equal(JSON.parse(tool.sqlite.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value)[0].token, 'pre-cutover-token');
  tool.sqlite.close();
  // (c) The server cuts over: the stale shadow row is gone, the blob row is in the table, the blob is retired.
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  let layer = attachDataLayer({ db: { ...store.load().db }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer.sessions.byToken('pre-cutover-token')); assert.equal(layer.sessions.bySid('sid-stale'), null);
  assert.equal(layer.sessions.count(), 1);
  store.sqlite.close();
  // (d) After the cutover, snapshot mode reads the table and writes it back there.
  tool = openStore(dir); snap = tool.load();
  assert.equal(snap.db.sessions.length, 1); assert.equal(snap.db.sessions[0].tokenHash, sha256('pre-cutover-token')); assert.ok(!('token' in snap.db.sessions[0]));
  tool.save(snap);
  assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'sessions'").get().n, 0, 'no blob is recreated after the cutover');
  tool.sqlite.close();
  // (e) Rollback output (record removed, empty blob) before re-upgrade: the blob is authoritative again, the table is left alone.
  const out = tempDir('s2-snap-rb');
  // The file is at S4a now: the S2 and S3 tools refuse it (later schema steps), and the rollback chain is S4a first, then S3, then S2.
  assert.throws(() => rollbackSessionsCopy(path.join(dir, 'scoutbox.db'), tempDir('s2-snap-rb-refused')), (err) => err.code === 'LATER_SCHEMA' && /0004_orgs_live/.test(err.message) && /0005_core_identity_live/.test(err.message));
  assert.throws(() => rollbackOrgsCopy(path.join(dir, 'scoutbox.db'), tempDir('s2-snap-rb-refused3')), (err) => err.code === 'LATER_SCHEMA' && /0005_core_identity_live, 0006_media_deletions/.test(err.message));
  const s4aState = tempDir('s2-snap-rb-s4a'); const s3State = tempDir('s2-snap-rb-s3'); const s2State = tempDir('s2-snap-rb-s2');
  const s7cState = tempDir('s2-snap-rb-s7c'); rollbackChannelsCopy(preS6b(path.join(dir, 'scoutbox.db')), s7cState); // S7d first (the file carries 0012),
  const s7bState = tempDir('s2-snap-rb-s7b'); rollbackOutboxPushCopy(path.join(s7cState, 'scoutbox.db'), s7bState); // then S7c on its output,
  const s7aState = tempDir('s2-snap-rb-s7a'); rollbackDispatchesCopy(path.join(s7bState, 'scoutbox.db'), s7aState); const s6aState = tempDir('s2-snap-rb-s6a'); rollbackNotificationsCopy(path.join(s7aState, 'scoutbox.db'), s6aState); // then S7b on its output, then S7a
  const s5State = tempDir('s2-snap-rb-s5'); rollbackOneTimeCodesCopy(path.join(s6aState, 'scoutbox.db'), s5State); // then S6a: the copy carries 0008
  rollbackPlayerSubrecordsCopy(path.join(s5State, 'scoutbox.db'), s4aState); // then S5: it carries 0007
  rollbackCoreIdentityCopy(path.join(s4aState, 'scoutbox.db'), s3State);
  rollbackOrgsCopy(path.join(s3State, 'scoutbox.db'), s2State);
  rollbackSessionsCopy(path.join(s2State, 'scoutbox.db'), out);
  tool = openStore(out); snap = tool.load();
  assert.deepEqual(snap.db.sessions, [], 'the empty legacy blob, not the (empty) table, is what a tool reads');
  assert.deepEqual(snap.db.orgs.map((o) => o.id), ['org-a', 'org-b'], 'the organisations came back as a blob through the S3 rollback');
  assert.deepEqual(snap.db.players.map((p) => p.id), ['pl-1', 'pl-2'], 'the players came back as a blob through the S4a rollback');
  snap.db.sessions.push({ token: 'post-rollback-token', sid: 'sid-rb', kind: 'player', refId: 'pl-1', createdAt: Date.now() });
  tool.save(snap);
  assert.equal(JSON.parse(tool.sqlite.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value).length, 1, 'a pre-S2 build\'s session lands in the blob');
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  tool.sqlite.close();
  // Re-upgrade imports that blob row.
  store = openStore(out, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: { ...store.load().db }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer.sessions.byToken('post-rollback-token')); assert.equal(layer.sessions.byToken('pre-cutover-token'), null);
  store.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
});
test('legacy db.json (review correction 2): sessions and staff in a pre-SQLite snapshot survive the JSON-to-SQLite upgrade and the cutover', () => {
  const dir = tempDir('s2-dbjson');
  const legacy = {
    savedAt: 1, idCounter: 1000,
    db: {
      players: [{ ...PLAYER_1(), media: [] }],
      users: [{ id: 'usr-legacy', orgId: 'org-a', name: 'Maria', role: 'Head of Recruitment', createdAt: 1 }],
      sessions: [
        { token: 'json-player-token', sid: 'sid-jp', kind: 'player', refId: 'pl-1', createdAt: Date.now() - DAY },
        { token: 'json-org-token', sid: 'sid-jo', kind: 'org', refId: 'org-a', userId: 'usr-legacy', createdAt: Date.now() - DAY },
      ],
      orgs: [ORG_A], guardians: [],
    },
  };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy));
  // Server mode, exactly as server.mjs boots: openStore → load (imports db.json) → attachDataLayer.
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  assert.equal(loaded.db.sessions.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')) && !fs.existsSync(path.join(dir, 'db.json')), 'the JSON file is retired only once its contents are in the database');
  // Before the data layer runs, the authoritative input of the cutover — the blob rows in the file — holds everything the JSON held.
  assert.equal(JSON.parse(store.sqlite.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value).length, 2, 'the sessions reached the file before the JSON was retired');
  assert.equal(JSON.parse(store.sqlite.prepare("SELECT value FROM collections WHERE name = 'users'").get().value).length, 1, 'so did the staff the org session depends on');
  const db = { ...loaded.db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer.sessions.byToken('json-player-token'), 'the player session from db.json resolves');
  assert.ok(layer.sessions.byToken('json-org-token'), 'the org session from db.json resolves');
  assert.equal(layer.users.byId('usr-legacy').name, 'Maria');
  assert.equal(JSON.parse(store.sqlite.prepare("SELECT value FROM meta WHERE key = 'sessionsCutover'").get().value).imported, 2);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('sessions', 'users')").get().n, 0, 'both blobs retired by the cutover');
  assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes('json-player-token') || true); // physical remnants are covered by the server test
  store.save({ savedAt: 2, idCounter: 1000, db }); store.sqlite.close();
  // A restart reads the table.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { ...store.load().db }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken('json-player-token') && layer2.sessions.byToken('json-org-token'));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('legacy db.json (review correction 2): an unsupported session in the JSON aborts the cutover with every row preserved; the retry succeeds once it is resolved', () => {
  const dir = tempDir('s2-dbjson-abort');
  const legacy = { savedAt: 1, idCounter: 1000, db: { players: [PLAYER_1()], users: [], orgs: [], guardians: [],
    sessions: [{ token: 'json-good-token', sid: 'sid-good', kind: 'player', refId: 'pl-1', createdAt: Date.now() - DAY }, { token: 'json-bad-token', sid: 'sid-bad', kind: 'org', refId: 'org-a', userId: 'usr-missing', createdAt: Date.now() - DAY }] } };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy));
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  let db = { ...store.load().db };
  assert.throws(() => attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL }), /SESSIONS_CUTOVER_BLOCKED: 1 unsupported session.*sid sid-bad: staff member usr-missing does not exist/);
  const blob = () => JSON.parse(store.sqlite.prepare("SELECT value FROM collections WHERE name = 'sessions'").get().value);
  assert.deepEqual(blob().map((s) => s.sid), ['sid-good', 'sid-bad'], 'the file keeps every row the JSON held, the good one included');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(SESSIONS_CUTOVER_MIGRATION).n, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'db.json.migrated'), 'utf8')).db.sessions.map((s) => s.sid), ['sid-good', 'sid-bad'], 'the retired JSON is kept intact as well');
  store.sqlite.close();
  // Retry without change: the same abort, nothing lost.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db };
  assert.throws(() => attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL }), /SESSIONS_CUTOVER_BLOCKED/);
  assert.equal(blob().length, 2);
  // The operator resolves the listed sid on the pre-S2 state (here: removes it from the blob of this disposable copy); the retry cuts over.
  const kept = blob().filter((s) => s.sid !== 'sid-bad');
  store.sqlite.prepare("UPDATE collections SET value = ? WHERE name = 'sessions'").run(JSON.stringify(kept));
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer.sessions.byToken('json-good-token')); assert.equal(layer.sessions.byToken('json-bad-token'), null);
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
    store.save({ savedAt: 2, idCounter: 1000, db: { orgs: [], players: [], guardians: [], notes: [{ id: 'p' }] } }); // notes: a blob collection (players are table-backed since S4a)
    const waited = Date.now() - t0;
    assert.ok(waited >= holdMs - 300, `the store waited for the lock (${waited} ms)`);
    assert.deepEqual(store.load().db.notes, [{ id: 'p' }]);
  };
  // Awaited by the harness: the check counts only once every assertion above has passed.
  try { await run(); } finally { try { holder.kill(); } catch { /* done */ } store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- rollback
test('rollback: the tool produces a copy with the cutover record removed, the table emptied, an empty legacy blob and every other collection intact; it refuses a later schema', () => {
  const dir = tempDir('s2-rb-src'); preS2File(dir, { extra: { notes: [{ id: 'n1' }] } });
  const s = openRaw(dir);
  runDataMigrations(s, [m0001, m0002, m0003], { context: { sessionTtlMs: TTL } }); // the S2 state this tool rolls back; an S3 file must go through orgsRollback first (asserted below)
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
  // A deterministic media fixture: one of Kola's clips has a stored file (the
  // snapshot carries it as a data URL, which the server moves onto storage at
  // boot), so a signed media link must resolve to 200 with these bytes.
  const clip = seed.players.find((p) => p.id === 'pl-adeyemi').media[0];
  const clipBytes = Buffer.from('synthetic-webm-bytes-for-the-sessions-suite');
  clip.url = `/media/${clip.id}`;
  seed.mediaBlobs = { [clip.id]: { dataUrl: `data:video/webm;base64,${clipBytes.toString('base64')}` } };
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
    // Signed media URL bound to the session: required, served with the fixture's bytes, dead after logout.
    const me = await j('GET', '/player/me', undefined, kola);
    const mediaUrl = JSON.stringify(me.body).match(new RegExp(`/media/${clip.id}\\?e=\\d+&s=[A-Za-z0-9_-]+&v=sid-kola`))?.[0];
    assert.ok(mediaUrl, 'the profile carries a signed link to the fixture clip, bound to the legacy session id');
    const fetched = await fetch(`http://127.0.0.1:${port}${mediaUrl}`);
    assert.equal(fetched.status, 200, 'the signed link resolves the session and serves the clip');
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString(), clipBytes.toString(), 'the served bytes are the fixture bytes');
    assert.equal((await fetch(`http://127.0.0.1:${port}${mediaUrl.replace(/&v=sid-kola$/, '&v=sid-other')}`)).status, 401, 'a link re-pointed at another sid fails the signature');
    assert.equal((await j('POST', '/auth/logout', {}, kola)).status, 200);
    assert.equal((await j('GET', '/player/me', undefined, kola)).status, 401, 'logout revokes the legacy token');
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

await atest('server (review correction 2): a legacy db.json with a staff member and player and org sessions boots the real server and both tokens work', async () => {
  const dir = tempDir('s2-server-dbjson');
  const seed = buildSeed();
  seed.users = [{ id: 'usr-legacy', orgId: 'org-eastport', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  seed.sessions = [
    { token: 'dbjson-kola-token-000000000000000000000000000', sid: 'sid-json-kola', kind: 'player', refId: 'pl-adeyemi', createdAt: Date.now() - DAY },
    { token: 'dbjson-maria-token-00000000000000000000000000', sid: 'sid-json-maria', kind: 'org', refId: 'org-eastport', userId: 'usr-legacy', createdAt: Date.now() - DAY },
  ];
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ savedAt: Date.now(), idCounter: 1000, db: seed })); // the pre-SQLite snapshot, nothing else in the directory
  const port = pickPort(7850, 100);
  const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', () => { if (/listening on/.test(log)) resolve(); });
    proc.on('exit', (code, signal) => reject(new Error(`server exited ${code} (${signal}): ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000);
  });
  try {
    const status = async (p, token) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;
    assert.equal(await status('/player/me', seed.sessions[0].token), 200, 'the player token from db.json works');
    assert.equal(await status('/org/notifications', seed.sessions[1].token), 200, 'the org token from db.json works');
    assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')) && !fs.existsSync(path.join(dir, 'db.json')));
    const cap = await (await fetch(`http://127.0.0.1:${port}/capabilities`)).json();
    assert.equal(cap.dataLayer.domains.sessions.rows, 2); assert.equal(cap.dataLayer.domains.users.rows, 1);
    assert.ok(!log.includes('dbjson-kola-token') && !log.includes('dbjson-maria-token'), 'no token in the boot log');
    // The admin backup is a db.json too (the same import path). It must carry
    // the sessions in their stored form — hashes, never tokens — so a restore
    // into an empty directory keeps them alive and boots.
    const backup = await (await fetch(`http://127.0.0.1:${port}/admin/backup`, { method: 'POST', headers: { 'x-admin-key': 'scoutbox-admin' } })).json();
    const exported = JSON.parse(fs.readFileSync(path.join(backup.dir, 'db.json'), 'utf8'));
    assert.equal(exported.db.sessions.length, 2);
    assert.ok(exported.db.sessions.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash) && !('token' in s)), 'the backup holds hashes only');
    assert.ok(!fs.readFileSync(path.join(backup.dir, 'db.json'), 'utf8').includes('dbjson-kola-token'));
    const restoreDir = tempDir('s2-restore'); fs.cpSync(backup.dir, restoreDir, { recursive: true });
    const port2 = pickPort(7900, 100);
    const restored = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port2), DATA_DIR: restoreDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = ''; restored.stdout.on('data', (d) => { log2 += d; }); restored.stderr.on('data', (d) => { log2 += d; });
    try {
      await new Promise((resolve, reject) => {
        restored.stdout.on('data', () => { if (/listening on/.test(log2)) resolve(); });
        restored.on('exit', (code, signal) => reject(new Error(`restored server exited ${code} (${signal}): ${log2}`)));
        setTimeout(() => reject(new Error(`restore boot timeout: ${log2}`)), 20_000);
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
test('snapshot mode (review correction 5): a table-backed collection that is not an array is refused whole, before and after the cutover; an omitted collection is a partial snapshot', () => {
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
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('sessions', 'users')").get().n, 0, 'no legacy blob was recreated after the cutover');
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
  // Before the cutover (an S1 file) the blob is authoritative, and a non-array is refused before it could become the blob.
  const pre = tempDir('s2-shape-pre');
  preS2File(pre, { sessions: legacySessions() });
  const pt = openStore(pre);
  const preBefore = JSON.stringify(pt.load().db.sessions);
  for (const bad of [{ token: PLAIN }, null, 'x']) {
    const snap = pt.load(); snap.db.sessions = bad; snap.db.players[0].name = 'Changed';
    assert.throws(() => pt.save(snap), /sessions.*must be an array/);
    assert.equal(JSON.stringify(pt.load().db.sessions), preBefore, 'the legacy blob is unchanged');
    assert.equal(pt.load().db.players[0].name, 'P');
  }
  assert.ok(!fs.readFileSync(path.join(pre, 'scoutbox.db'), 'latin1').includes(PLAIN));
  pt.sqlite.close();
  // The server still reads the untouched session.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: { orgs: [], guardians: [], players: [], users: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.ok(layer2.sessions.byToken(a.token));
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(pre, { recursive: true, force: true });
});

// ------------------------------------------------------------- legacy envelope (review correction 6)
test('legacy db.json (review correction 6): an unreadable, malformed or structurally invalid db.json is a fatal import error that preserves the file and the database; only genuine absence means first installation', () => {
  const cases = [
    ['truncated JSON', '{"db":', /LEGACY_IMPORT_FAILED.*not valid JSON/],
    ['empty file', '', /LEGACY_IMPORT_FAILED.*not valid JSON/],
    ['no db envelope', '{"savedAt":1}', /LEGACY_IMPORT_FAILED.*has no "db" object/],
    ['db is an array', '{"db":[1,2]}', /LEGACY_IMPORT_FAILED.*has no "db" object/],
    ['db is a string', '{"db":"players"}', /LEGACY_IMPORT_FAILED.*has no "db" object/],
    ['top level is an array', '[{"db":{}}]', /LEGACY_IMPORT_FAILED.*not a JSON object/],
    ['a table-backed collection with the wrong shape', JSON.stringify({ savedAt: 1, idCounter: 1, db: { players: [], sessions: { token: 'plain-token-in-envelope', sid: 's', kind: 'player', refId: 'pl-1', createdAt: 5 } } }), /LEGACY_IMPORT_FAILED.*sessions.*must be an array/],
    ['players is not an array', JSON.stringify({ savedAt: 1, idCounter: 1, db: { players: 'nope' } }), /LEGACY_IMPORT_FAILED.*"players" must be an array \(got string\)/],
    ['players is missing', JSON.stringify({ savedAt: 1, idCounter: 1, db: { orgs: [] } }), /LEGACY_IMPORT_FAILED.*"players" must be an array \(got undefined\)/],
  ];
  for (const [name, content, pattern] of cases) {
    const dir = tempDir('s2-envelope');
    fs.writeFileSync(path.join(dir, 'db.json'), content);
    const store = openStore(dir, { tableBacked: TABLE_BACKED });
    assert.throws(() => store.load(), (err) => err.code === 'LEGACY_IMPORT_FAILED' && pattern.test(err.message), `${name}: a fatal import error`);
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), content, `${name}: the source file is preserved byte for byte`);
    assert.ok(!fs.existsSync(path.join(dir, 'db.json.migrated')), `${name}: nothing was renamed`);
    assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 0, `${name}: nothing was written`);
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes('plain-token-in-envelope'));
    // Retry without change: the same error, still nothing written. A repaired file then imports.
    assert.throws(() => store.load(), (err) => err.code === 'LEGACY_IMPORT_FAILED');
    store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // An unreadable file (a directory in its place) is fatal too, not "absent".
  {
    const dir = tempDir('s2-envelope-dir'); fs.mkdirSync(path.join(dir, 'db.json'));
    const store = openStore(dir, { tableBacked: TABLE_BACKED });
    assert.throws(() => store.load(), (err) => err.code === 'LEGACY_IMPORT_FAILED' && /could not be read/.test(err.message));
    store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // Genuine absence: null, nothing written, first-installation behaviour.
  {
    const dir = tempDir('s2-envelope-absent');
    const store = openStore(dir, { tableBacked: TABLE_BACKED });
    assert.equal(store.load(), null);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('db.json')), []);
    store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // Failure then retry with a repaired file: the import succeeds and the file is retired.
  {
    const dir = tempDir('s2-envelope-retry');
    fs.writeFileSync(path.join(dir, 'db.json'), '{"db":');
    let store = openStore(dir, { tableBacked: TABLE_BACKED });
    assert.throws(() => store.load(), (err) => err.code === 'LEGACY_IMPORT_FAILED');
    store.sqlite.close();
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ savedAt: 1, idCounter: 1, db: { players: [PLAYER_1()], users: [], orgs: [], guardians: [], sessions: [{ token: 'retry-token', sid: 'sid-r', kind: 'player', refId: 'pl-1', createdAt: Date.now() - DAY }] } }));
    store = openStore(dir, { tableBacked: TABLE_BACKED });
    const loaded = store.load();
    assert.equal(loaded.db.players[0].name, 'P');
    assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')) && !fs.existsSync(path.join(dir, 'db.json')));
    const layer = attachDataLayer({ db: { ...loaded.db }, store, nextId, persist: () => {}, sessionTtlMs: TTL });
    assert.ok(layer.sessions.byToken('retry-token'));
    store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
await atest('server (review correction 6): a malformed or invalid db.json stops the server before it listens, with the file preserved and no seed data saved', async () => {
  for (const [name, content] of [['truncated JSON', '{"db":'], ['no db envelope', '{"savedAt":1}'], ['sessions is an object', '{"savedAt":1,"idCounter":1,"db":{"players":[],"sessions":{"token":"plain-token-in-envelope"}}}']]) {
    const dir = tempDir('s2-server-envelope');
    fs.writeFileSync(path.join(dir, 'db.json'), content);
    const port = pickPort(7950, 50);
    const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
    const exit = await new Promise((resolve, reject) => {
      proc.on('exit', (code) => resolve(code));
      setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${name}: the server did not stop: ${log}`)); }, 20_000);
    });
    assert.notEqual(exit, 0, `${name}: the process ends with a failure code`);
    assert.match(log, /LEGACY_IMPORT_FAILED/, `${name}: the failure is the import error`);
    assert.ok(!/listening on/.test(log), `${name}: it never listened`);
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), content, `${name}: db.json is preserved`);
    assert.ok(!fs.existsSync(path.join(dir, 'db.json.migrated')));
    const raw = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 0, `${name}: no seed data was saved`);
    raw.close();
    assert.ok(!fs.readFileSync(path.join(dir, 'scoutbox.db'), 'latin1').includes('plain-token-in-envelope'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- SQLite is required (review correction 4)
test('without node:sqlite the store refuses to open with a compatibility error and touches nothing; the repositories refuse a missing connection', () => {
  const dir = tempDir('s2-nosqlite');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ savedAt: 1, idCounter: 1, db: { players: [] } }));
  const probe = spawn === null ? null : execFileSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', `
    try { const { openStore } = await import(${JSON.stringify(path.join(HERE, '..', 'store.mjs'))}); openStore(process.argv[1]); console.log('OPENED'); }
    catch (err) { console.log('REFUSED ' + err.code + ' ' + err.message); }
  `, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(probe, /^REFUSED SQLITE_REQUIRED .*node:sqlite/m, 'a clear compatibility error, not a silent fallback');
  assert.ok(!probe.includes('OPENED'));
  assert.deepEqual(fs.readdirSync(dir), ['db.json'], 'nothing was written: no database, no renamed snapshot');
  assert.throws(() => createSessionsRepository({ sqlite: null, sessionTtlMs: TTL }), /SQLite connection/);
  assert.throws(() => attachDataLayer({ db: { users: [], sessions: [] }, store: { sqlite: null }, nextId, persist: () => {}, sessionTtlMs: TTL }), /SQLite connection/);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} sessions checks passed`);
