// Behavioural tests for migration plan step S1: the core identity schema
// (orgs, guardians, players, guardian_children, sessions) created by
// migration 0002 and kept as a verified shadow of the snapshot. Everything
// runs on throwaway databases under the OS temp directory; nothing touches
// DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createCoreIdentityShadow, CORE_SHADOW_TABLES } from '../repositories/shadow.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const TTL = 30 * DAY;
let counter = 5000;
const nextId = (p) => `${p}-${++counter}`;

const freshDb = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(s, DATA_MIGRATIONS); return s; };
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));

/** A synthetic snapshot in the exact shapes the server writes. No real data. */
function syntheticSnapshot({ orgUserId = 'usr-9001' } = {}) {
  const now = Date.now();
  return {
    orgs: [
      { id: 'org-a', name: 'Alpha FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', location: { lat: 51.5, lng: -0.1, city: 'London' }, verified: true, safeguardingContractSigned: true, trustedPartner: false, verifiedDomain: 'alpha.example', password: 'scrypt$00$11' },
      { id: 'org-b', name: 'Beta Grassroots', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'GB', location: { lat: 53.4, lng: -2.2, city: 'Manchester' }, federationRef: { federation: 'The FA', registrationId: 'FA-1' }, verified: false, suspended: true },
      { id: 'org-c', name: 'Gamma Agency', type: 'agency', level: 'agency', plan: 'Agency', country: 'PT', location: null, verified: true, mfaRequiredForLeads: true, verification: { revokedAt: now - DAY, orgType: 'agency' } },
      { id: 'org-bad', name: 'Broken Level', type: 'club', level: 'agent', plan: 'Pro', country: 'GB' },
    ],
    guardians: [
      { id: 'gd-1', name: 'Guardian One', email: 'one@example.com', password: null, emailVerified: true, emailCode: '123456', idVerified: true, disclaimerAccepted: true, childIds: ['pl-minor', 'pl-gone'], notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: true, timezone: 'Europe/London' } },
      { id: 'gd-2', name: 'Guardian Two', email: 'two@example.com', coGuardianOf: 'gd-1', childIds: ['pl-minor'] },
      { id: 'gd-dup', name: 'Guardian Dup', email: 'ONE@example.com', childIds: [] },
      { id: 'gd-3', name: 'Guardian Three', email: 'three@example.com', coGuardianOf: 'gd-missing', childIds: [] },
    ],
    players: [
      { id: 'pl-adult', name: 'Adult Player', dob: '2000-01-01', country: 'GB', city: 'London', position: 'ST', foot: 'right', heightCm: 180, weightKg: 75, stats: { appearances: 20, goals: 9, assists: 3, paceKmh: 33.4, passCompletionPct: 81, duelSuccessPct: 63 }, academyPlus: true, availability: 'available_now', contractStatus: 'free_agent', identityVerified: true, guardianId: null, level: 'semi_pro', location: { lat: 51.5, lng: -0.1 }, medical: { shared: true, records: [], conditionStatus: 'fully_fit' }, notificationPrefs: { quietStart: '22:00', quietEnd: '07:00', schoolHoursMute: null, timezone: null }, programme: { track: 'ST', startedAt: now - 3 * DAY, completed: [] }, createdAt: now - 10 * DAY, password: 'scrypt$aa$bb' },
      { id: 'pl-minor', name: 'Minor Player', dob: '2011-06-15', country: 'GB', city: 'London', position: 'CM', foot: 'left', guardianId: 'gd-1', stats: null, medical: { shared: false, records: [{ id: 'md-1', type: 'clearance', title: 'ok', date: '2026-01-01', cleared: true }], conditionStatus: 'unknown' }, location: null, createdAt: now - 2 * DAY },
      { id: 'pl-orphan', name: 'Orphan Guardian', dob: '2012-02-02', country: 'FR', guardianId: 'gd-missing', stats: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } },
      { id: 'pl-badfoot', name: 'Bad Foot', dob: '1999-09-09', country: 'GB', foot: 'both', medical: { shared: false, records: [], conditionStatus: 'unknown' } },
    ],
    sessions: [
      { token: 'tok-player', sid: 'sid-p', kind: 'player', refId: 'pl-adult', createdAt: now - DAY },
      { token: 'tok-guardian', sid: 'sid-g', kind: 'guardian', refId: 'gd-1', createdAt: now },
      { token: 'tok-org', sid: 'sid-o', kind: 'org', refId: 'org-a', userId: orgUserId, createdAt: now },
      { token: 'tok-sso', sid: 'sid-s', kind: 'org', refId: 'org-a', userId: orgUserId, via: 'sso', createdAt: now },
      { token: 'tok-ts', sid: 'sid-t', kind: 'ts_reviewer', refId: 'reviewer-1', createdAt: now },
      { token: 'tok-nouser', sid: 'sid-n', kind: 'org', refId: 'org-a', createdAt: now },
      { token: 'tok-ghostuser', sid: 'sid-gh', kind: 'org', refId: 'org-a', userId: 'usr-nope', createdAt: now },
      { sid: 'sid-notoken', kind: 'player', refId: 'pl-adult', createdAt: now },
    ],
  };
}
const seedOrgUser = (s, id = 'usr-9001') => s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, 'org-a', 'Maria Keane', 'Head of Recruitment', ?)").run(id, Date.now());

// ------------------------------------------------------------- migration 0002
test('migration 0002 creates the five core tables as STRICT tables and is recorded once', () => {
  const s = freshDb();
  const names = s.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('orgs','guardians','players','guardian_children','sessions') ORDER BY name").all();
  assert.deepEqual(names.map((r) => r.name), ['guardian_children', 'guardians', 'orgs', 'players', 'sessions']);
  for (const r of names) assert.match(r.sql, /\) STRICT$/, `${r.name} is STRICT`);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?").get(m0002.id).n, 1);
  const again = runDataMigrations(s, DATA_MIGRATIONS);
  assert.deepEqual(again.ran, [], 're-running the registry applies nothing');
  assert.equal(again.applied, 2);
});
test('migration 0002 is atomic: a failure inside it leaves no table and no record', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, [DATA_MIGRATIONS[0]]);
  s.exec('CREATE TABLE sessions (x INTEGER)'); // provoke a failure part-way through 0002
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS), /0002_core_identity_shadow failed/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('orgs','guardians','players','guardian_children')").get().n, 0, 'tables created before the failure were rolled back');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?").get(m0002.id).n, 0);
});

// ------------------------------------------------------------- constraints
test('constraints: CHECKs refuse values the code never writes', () => {
  const s = freshDb();
  const org = (over) => s.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES (@id, 'X', @type, @level, @plan)").run({ id: 'o', type: 'club', level: 'pro', plan: 'Pro', ...over });
  assert.throws(() => org({ level: 'agent' }), /CHECK/);
  assert.throws(() => org({ type: 'academy' }), /CHECK/);
  assert.throws(() => org({ plan: 'Gold' }), /CHECK/);
  org({});
  assert.throws(() => s.prepare("UPDATE orgs SET lat = 1 WHERE id = 'o'").run(), /CHECK/, 'lat without lng');
  const player = (over) => s.prepare("INSERT INTO players (id, name, birth_date, country, foot, availability) VALUES (@id, 'P', @dob, 'GB', @foot, @availability)").run({ id: 'p', dob: '2000-01-01', foot: null, availability: 'not_seeking', ...over });
  assert.throws(() => player({ foot: 'both' }), /CHECK/);
  assert.throws(() => player({ dob: '2000-1-1' }), /CHECK/);
  assert.throws(() => player({ availability: 'maybe' }), /CHECK/);
  assert.throws(() => s.prepare("INSERT INTO players (id, name, birth_date, country, height_cm) VALUES ('p2', 'P', '2000-01-01', 'GB', 'tall')").run(), /cannot store TEXT value in INTEGER column/, 'STRICT refuses text in an INTEGER column');
  const session = (over) => s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES (@h, @sid, @kind, 'r', @user, 1, 2)").run({ h: 'h', sid: 's', kind: 'player', user: null, ...over });
  assert.throws(() => session({ kind: 'admin' }), /CHECK/);
  assert.throws(() => session({ kind: 'org' }), /CHECK/, 'an org session must name its staff member');
  assert.throws(() => session({ kind: 'player', user: 'usr-x' }), /CHECK|FOREIGN/, 'a player session cannot name a staff member');
});
test('constraints: the guardian e-mail is unique regardless of case (new rule; code enforces it on signup only)', () => {
  const s = freshDb();
  s.prepare("INSERT INTO guardians (id, name, email) VALUES ('g1', 'A', 'Same@Example.com')").run();
  assert.throws(() => s.prepare("INSERT INTO guardians (id, name, email) VALUES ('g2', 'B', 'same@example.com')").run(), /UNIQUE/);
});

// ------------------------------------------------------------- foreign keys
test('foreign keys are enforced and cascade the way the model owns its rows', () => {
  const s = freshDb();
  assert.throws(() => s.prepare("INSERT INTO players (id, name, birth_date, country, guardian_id) VALUES ('p', 'P', '2010-01-01', 'GB', 'gd-none')").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO guardians (id, name, email) VALUES ('g', 'G', 'g@example.com')").run();
  s.prepare("INSERT INTO players (id, name, birth_date, country, guardian_id) VALUES ('p', 'P', '2010-01-01', 'GB', 'g')").run();
  assert.throws(() => s.prepare("INSERT INTO guardian_children (guardian_id, player_id) VALUES ('g', 'p-none')").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('g', 'p', 'primary')").run();
  assert.throws(() => s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h', 's', 'org', 'org-a', 'usr-none', 1, 2)").run(), /FOREIGN KEY/);
  seedOrgUser(s, 'usr-1');
  s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h', 's', 'org', 'org-a', 'usr-1', 1, 2)").run();
  // Deleting the guardian: the child link goes, the player stays and loses its guardian pointer.
  s.prepare("DELETE FROM guardians WHERE id = 'g'").run();
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 0);
  assert.equal(s.prepare("SELECT guardian_id FROM players WHERE id = 'p'").get().guardian_id, null);
  // Deleting the staff member takes their sessions with them.
  s.prepare("DELETE FROM org_users WHERE id = 'usr-1'").run();
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

// ------------------------------------------------------------- transactions
test('a failing transaction leaves nothing behind', () => {
  const s = freshDb();
  assert.throws(() => transaction(s, () => {
    s.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('o1', 'X', 'club', 'pro', 'Pro')").run();
    s.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('o2', 'X', 'club', 'nope', 'Pro')").run();
  }), /CHECK/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0);
});

// ------------------------------------------------------------- the projection
test('projection: every valid row lands, every refused row is named with its reason, and ids are preserved', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s, sessionTtlMs: TTL, now: () => 1_000 });
  const db = syntheticSnapshot();
  const result = transaction(s, () => shadow.project(db));
  assert.equal(result.error, null);
  assert.deepEqual(Object.fromEntries(Object.entries(result.tables).map(([t, r]) => [t, [r.source, r.written, r.skipped.length]])), {
    orgs: [4, 3, 1], guardians: [4, 3, 1], players: [4, 3, 1], guardian_children: [3, 2, 1], sessions: [8, 5, 3],
  });
  assert.match(result.tables.orgs.skipped[0].reason, /CHECK/); assert.equal(result.tables.orgs.skipped[0].id, 'org-bad');
  assert.match(result.tables.guardians.skipped[0].reason, /UNIQUE/); assert.equal(result.tables.guardians.skipped[0].id, 'gd-dup');
  assert.match(result.tables.players.skipped[0].reason, /CHECK/); assert.equal(result.tables.players.skipped[0].id, 'pl-badfoot');
  assert.deepEqual(result.tables.guardian_children.skipped, [{ id: 'gd-1/pl-gone', reason: 'child player does not exist' }]);
  assert.equal(result.tables.sessions.skipped.length, 3);
  assert.ok(result.tables.sessions.skipped.some((x) => x.id === 'sid-n' && /CHECK/.test(x.reason)), 'an org session without a staff member is refused by the CHECK');
  assert.ok(result.tables.sessions.skipped.some((x) => x.id === 'sid-gh' && /does not exist/.test(x.reason)));
  assert.ok(result.tables.sessions.skipped.some((x) => x.reason === 'no token'));
  // Findings: rows written with an adjustment.
  assert.deepEqual(result.tables.players.findings, [{ id: 'pl-orphan', finding: 'guardianId gd-missing does not exist; written as NULL' }]);
  assert.deepEqual(result.tables.guardians.findings, [{ id: 'gd-3', finding: 'coGuardianOf gd-missing does not exist; written as NULL' }]);
  // Ids and values are preserved exactly.
  assert.deepEqual(s.prepare('SELECT id FROM orgs ORDER BY id').all().map((r) => r.id), ['org-a', 'org-b', 'org-c']);
  const alpha = s.prepare("SELECT * FROM orgs WHERE id = 'org-a'").get();
  assert.equal(alpha.city, 'London'); assert.equal(alpha.lat, 51.5); assert.equal(alpha.verified, 1); assert.equal(alpha.password_hash, 'scrypt$00$11');
  const gamma = s.prepare("SELECT * FROM orgs WHERE id = 'org-c'").get();
  assert.equal(gamma.lat, null); assert.equal(gamma.mfa_required_for_leads, 1); assert.equal(gamma.verification_org_type, 'agency');
  const adult = s.prepare("SELECT * FROM players WHERE id = 'pl-adult'").get();
  assert.equal(adult.birth_date, '2000-01-01'); assert.equal(adult.stats_pace_kmh, 33.4); assert.equal(adult.medical_shared, 1); assert.equal(adult.programme_track, 'ST'); assert.equal(adult.guardian_id, null);
  const minor = s.prepare("SELECT * FROM players WHERE id = 'pl-minor'").get();
  assert.equal(minor.guardian_id, 'gd-1'); assert.equal(minor.stats_goals, null); assert.equal(minor.medical_shared, 0);
});
test('projection: guardian/child links carry the primary/co role and a guardian sees only their own children', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s, sessionTtlMs: TTL });
  transaction(s, () => shadow.project(syntheticSnapshot()));
  const links = s.prepare('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY guardian_id').all().map((r) => ({ ...r }));
  assert.deepEqual(links, [{ guardian_id: 'gd-1', player_id: 'pl-minor', role: 'primary' }, { guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }]);
  assert.deepEqual(s.prepare("SELECT player_id FROM guardian_children WHERE guardian_id = 'gd-3'").all(), [], 'a guardian with no children sees none');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE guardian_id = 'gd-2'").get().n, 0, 'a co-guardian is not the primary guardian');
});
test('projection: session tokens are stored only as hashes, with an expiry column, and org sessions link to their staff member', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s, sessionTtlMs: TTL });
  const db = syntheticSnapshot();
  transaction(s, () => shadow.project(db));
  const cols = s.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  assert.ok(!cols.includes('token'), 'no plain token column exists');
  const row = s.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256('tok-org'));
  assert.ok(row, 'looked up by the hash of the bearer token');
  assert.equal(row.org_user_id, 'usr-9001'); assert.equal(row.kind, 'org'); assert.equal(row.expires_at, row.created_at + TTL);
  assert.equal(s.prepare("SELECT via FROM sessions WHERE sid = 'sid-s'").get().via, 'sso');
  const dump = JSON.stringify(s.prepare('SELECT * FROM sessions').all());
  for (const sess of db.sessions) if (sess.token) assert.ok(!dump.includes(sess.token), `plain token ${sess.token} never reaches the table`);
});
test('projection: re-running on a changed snapshot is deterministic (rewrite, not append)', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s, sessionTtlMs: TTL });
  const db = syntheticSnapshot();
  transaction(s, () => shadow.project(db));
  transaction(s, () => shadow.project(db));
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 3, 'projecting twice does not duplicate');
  db.players = db.players.filter((p) => p.id !== 'pl-adult');
  db.sessions = db.sessions.filter((x) => x.kind !== 'player');
  db.orgs[0].name = 'Alpha United';
  transaction(s, () => shadow.project(db));
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-adult'").get().n, 0, 'a removed player is gone');
  assert.equal(s.prepare("SELECT name FROM orgs WHERE id = 'org-a'").get().name, 'Alpha United', 'a changed field is current');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player'").get().n, 0);
});
test('reconciliation report: counts per table, refused rows and findings, never a token or a password', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s, sessionTtlMs: TTL });
  const db = syntheticSnapshot();
  transaction(s, () => shadow.project(db));
  const report = shadow.report(db);
  assert.equal(report.mode, 'shadow'); assert.equal(report.sourceOfTruth, 'snapshot');
  assert.deepEqual(report.tables.orgs, { ...report.tables.orgs, snapshotRows: 4, tableRows: 3, skipped: 1, findings: 0, reconciled: true });
  assert.deepEqual(report.tables.guardian_children, { ...report.tables.guardian_children, snapshotRows: 3, tableRows: 2, skipped: 1, reconciled: true });
  assert.deepEqual(report.tables.sessions, { ...report.tables.sessions, snapshotRows: 8, tableRows: 5, skipped: 3, reconciled: true });
  const text = JSON.stringify(report);
  assert.ok(!text.includes('tok-org') && !text.includes('scrypt$'), 'the report carries ids and reasons only');
});

// ------------------------------------------------------------- the store
test('store (server mode): the shadow is rewritten inside every save and survives a restart', () => {
  const dir = tempDir('shadow-store');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot();
  db.users = [{ id: 'usr-9001', orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 5);
  const report = layer.report();
  assert.equal(report.shadow.tables.players.tableRows, 3);
  assert.deepEqual(report.tables, ['guardian_children', 'guardians', 'org_users', 'orgs', 'players', 'sessions']);
  assert.deepEqual(report.shadow.store, { failures: 0, lastError: null });
  store.sqlite.close();
  // Restart: the tables are still there, and the blob snapshot still loads without them.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 3, 'rows persist across a restart');
  const loaded = store.load();
  assert.equal(loaded.db.orgs.length, 4, 'the blob snapshot is untouched: the snapshot stays the source of truth');
  assert.equal(loaded.db.users, undefined, 'the live table is not a blob');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (server mode): a projection failure never blocks the blob save', () => {
  const dir = tempDir('shadow-fail');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  runDataMigrations(store.sqlite, DATA_MIGRATIONS);
  let calls = 0;
  store.setProjection(() => { calls += 1; store.sqlite.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('ghost', 'G', 'club', 'pro', 'Pro')").run(); throw new Error('projection exploded'); });
  store.save({ savedAt: 2, idCounter: 1000, db: { players: [{ id: 'p1' }] } });
  assert.equal(calls, 1);
  assert.deepEqual(store.load().db.players, [{ id: 'p1' }], 'the blob was saved');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'the half-written shadow was rolled back to the savepoint');
  const state = store.projectionState();
  assert.equal(state.failures, 1); assert.match(state.lastError.message, /projection exploded/);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): tools reading the file as a snapshot never see the shadow tables as collections', () => {
  const dir = tempDir('shadow-tool');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot(); db.users = [];
  attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db });
  store.sqlite.close();
  store = openStore(dir);
  const snap = store.load();
  assert.equal(snap.db.orgs.length, 4, 'the blob collection, not the shadow table');
  assert.equal(snap.db.guardian_children, undefined);
  assert.deepEqual(snap.db.users, []);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('the shadow table list and the store contract agree on what is shadowed', () => {
  assert.deepEqual([...CORE_SHADOW_TABLES], ['orgs', 'guardians', 'players', 'guardian_children', 'sessions']);
});

console.log(`\n${passed} core-schema checks passed`);
