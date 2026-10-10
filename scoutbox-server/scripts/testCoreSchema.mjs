// Behavioural tests for migration plan step S1: the core identity schema
// (orgs, guardians, players, guardian_children, sessions) created by
// migration 0002 and kept as a verified shadow of the snapshot. Everything
// runs on throwaway databases under the OS temp directory; nothing touches
// DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createCoreIdentityShadow, CORE_SHADOW_TABLES, SHADOW_STATUS } from '../repositories/shadow.mjs';
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
  assert.equal(again.applied, DATA_MIGRATIONS.length);
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
  const shadow = createCoreIdentityShadow({ sqlite: s, now: () => 1_000 });
  const db = syntheticSnapshot();
  const result = transaction(s, () => shadow.project(db));
  assert.equal(result.error, null);
  // Sessions are live since S2 and are never projected: the fixture's sessions are ignored here.
  assert.deepEqual(Object.fromEntries(Object.entries(result.tables).map(([t, r]) => [t, [r.source, r.written, r.skipped.length]])), {
    orgs: [4, 3, 1], guardians: [4, 3, 1], players: [4, 3, 1], guardian_children: [3, 2, 1],
  });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'the projection wrote nothing into the live sessions table');
  assert.match(result.tables.orgs.skipped[0].reason, /CHECK/); assert.equal(result.tables.orgs.skipped[0].id, 'org-bad');
  assert.match(result.tables.guardians.skipped[0].reason, /UNIQUE/); assert.equal(result.tables.guardians.skipped[0].id, 'gd-dup');
  assert.match(result.tables.players.skipped[0].reason, /CHECK/); assert.equal(result.tables.players.skipped[0].id, 'pl-badfoot');
  assert.deepEqual(result.tables.guardian_children.skipped, [{ id: 'gd-1/pl-gone', reason: 'child player does not exist' }]);
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
  const shadow = createCoreIdentityShadow({ sqlite: s });
  transaction(s, () => shadow.project(syntheticSnapshot()));
  const links = s.prepare('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY guardian_id').all().map((r) => ({ ...r }));
  assert.deepEqual(links, [{ guardian_id: 'gd-1', player_id: 'pl-minor', role: 'primary' }, { guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }]);
  assert.deepEqual(s.prepare("SELECT player_id FROM guardian_children WHERE guardian_id = 'gd-3'").all(), [], 'a guardian with no children sees none');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE guardian_id = 'gd-2'").get().n, 0, 'a co-guardian is not the primary guardian');
});
test('projection: the live sessions table is never written or deleted by the shadow, even with rows in it', () => {
  const s = freshDb(); seedOrgUser(s);
  s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h1', 'sid-live', 'org', 'org-a', 'usr-9001', 1, 2)").run();
  const shadow = createCoreIdentityShadow({ sqlite: s });
  const db = syntheticSnapshot(); // carries eight legacy-shaped sessions, which the shadow must ignore
  transaction(s, () => shadow.project(db));
  transaction(s, () => shadow.project(db));
  assert.deepEqual(s.prepare('SELECT sid FROM sessions').all().map((r) => r.sid), ['sid-live'], 'the live row is untouched and no fixture session was projected');
  assert.ok(!('sessions' in shadow.report(db).tables), 'the report no longer lists sessions');
});
test('projection: re-running on a changed snapshot is deterministic (rewrite, not append)', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s });
  const db = syntheticSnapshot();
  transaction(s, () => shadow.project(db));
  transaction(s, () => shadow.project(db));
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 3, 'projecting twice does not duplicate');
  db.players = db.players.filter((p) => p.id !== 'pl-adult');
  db.orgs[0].name = 'Alpha United';
  transaction(s, () => shadow.project(db));
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-adult'").get().n, 0, 'a removed player is gone');
  assert.equal(s.prepare("SELECT name FROM orgs WHERE id = 'org-a'").get().name, 'Alpha United', 'a changed field is current');
});
test('reconciliation report: counts per table, partial vs complete, every projected row accounted for, never a token or a password', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s });
  const db = syntheticSnapshot();
  // The store writes savedAt and the save revision (saveSeq) on every save.
  s.prepare("INSERT INTO meta (key, value) VALUES ('savedAt', '77'), ('saveSeq', '1')").run();
  transaction(s, () => shadow.project(db, { savedAt: 77, saveSeq: 1 }));
  const report = shadow.report(db, { enabled: true });
  assert.equal(report.mode, 'shadow'); assert.equal(report.sourceOfTruth, 'snapshot'); assert.equal(report.enabled, true);
  assert.equal(report.status, SHADOW_STATUS.PARTIAL, 'rows were refused, so the result is partial, not complete');
  assert.equal(report.reconciled, false);
  assert.deepEqual(report.tables.orgs, { ...report.tables.orgs, snapshotRows: 4, tableRows: 3, projectedRows: 4, skipped: 1, findings: 0, accountedFor: true });
  assert.deepEqual(report.tables.guardian_children, { ...report.tables.guardian_children, snapshotRows: 3, tableRows: 2, skipped: 1, accountedFor: true });
  assert.equal(report.tables.players.findings, 1);
  // The public report carries no row ids, reasons, tokens or hashes; the detailed one adds ids and reasons only.
  const publicText = JSON.stringify(report);
  for (const leak of ['tok-org', 'scrypt$', 'gd-dup', 'sid-gh', 'pl-badfoot', 'details', 'lastError']) assert.ok(!publicText.includes(leak), `public report must not contain ${leak}`);
  const detailed = shadow.report(db, { enabled: true, details: true });
  const detailedText = JSON.stringify(detailed);
  assert.ok(detailedText.includes('gd-dup') && detailedText.includes('UNIQUE'), 'the detailed report names refused rows and reasons');
  assert.equal(detailed.lastError, null);
  for (const leak of ['tok-org', 'tok-player', 'scrypt$', '123456']) assert.ok(!detailedText.includes(leak), `detailed report must not contain ${leak}`);
  assert.equal(report.findings, 2, 'two adjusted relationships in the fixture: pl-orphan.guardianId and gd-3.coGuardianOf');
  // A snapshot with nothing refused but a dangling relationship is still not complete.
  const dangling = syntheticSnapshot();
  dangling.orgs = dangling.orgs.filter((o) => o.id !== 'org-bad'); dangling.guardians = dangling.guardians.filter((g) => g.id !== 'gd-dup'); dangling.guardians[0].childIds = ['pl-minor'];
  dangling.players = dangling.players.filter((p) => p.id !== 'pl-badfoot'); dangling.sessions = dangling.sessions.filter((x) => x.token && x.sid !== 'sid-n' && x.sid !== 'sid-gh');
  s.prepare("UPDATE meta SET value = '2' WHERE key = 'saveSeq'").run();
  transaction(s, () => shadow.project(dangling, { savedAt: 78, saveSeq: 2 }));
  const notClean = shadow.report(dangling, { enabled: true });
  assert.equal(notClean.skipped, 0); assert.equal(notClean.findings, 2);
  assert.equal(notClean.status, SHADOW_STATUS.PARTIAL, 'adjusted relationships keep the result partial'); assert.equal(notClean.reconciled, false);
  // A genuinely clean snapshot (no refused row, no dangling relationship) reconciles completely.
  const clean = JSON.parse(JSON.stringify(dangling));
  clean.players.find((p) => p.id === 'pl-orphan').guardianId = 'gd-1'; clean.guardians[0].childIds = ['pl-minor', 'pl-orphan'];
  clean.guardians.find((g) => g.id === 'gd-3').coGuardianOf = 'gd-1';
  s.prepare("UPDATE meta SET value = '3' WHERE key = 'saveSeq'").run();
  transaction(s, () => shadow.project(clean, { savedAt: 79, saveSeq: 3 }));
  const complete = shadow.report(clean, { enabled: true });
  assert.equal(complete.skipped, 0); assert.equal(complete.findings, 0);
  assert.equal(complete.status, SHADOW_STATUS.COMPLETE); assert.equal(complete.reconciled, true);
  for (const t of CORE_SHADOW_TABLES) assert.equal(complete.tables[t].tableRows, complete.tables[t].snapshotRows, `${t} fully projected`);
});
test('reconciliation report: a projection older than the last save is stale, never reconciled; a thrown projection is failed', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s });
  const db = syntheticSnapshot();
  assert.equal(shadow.report(db).status, SHADOW_STATUS.NEVER);
  s.prepare("INSERT INTO meta (key, value) VALUES ('savedAt', '10'), ('saveSeq', '4')").run();
  transaction(s, () => shadow.project(db, { savedAt: 10, saveSeq: 4 }));
  assert.equal(shadow.report(db).status, SHADOW_STATUS.PARTIAL);
  s.prepare("UPDATE meta SET value = '5' WHERE key = 'saveSeq'").run(); // a later save (same savedAt) without a projection
  const stale = shadow.report(db, { enabled: false });
  assert.equal(stale.status, SHADOW_STATUS.STALE); assert.equal(stale.reconciled, false);
  assert.equal(stale.tables.orgs.tableRows, 3, 'the old rows are still there and are reported as stale, not as current');
  // A projection that throws part-way: the caller rolls back; the report says failed and names the error only in detail.
  const broken = syntheticSnapshot();
  let reads = 0;
  Object.defineProperty(broken, 'players', { get() { if (++reads === 1) throw new Error('snapshot unreadable'); return []; } });
  assert.throws(() => transaction(s, () => shadow.project(broken, { savedAt: 11, saveSeq: 5 })), /snapshot unreadable/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3, 'the transaction rollback kept the previous projection');
  const failed = shadow.report(broken, { enabled: true });
  assert.equal(failed.status, SHADOW_STATUS.FAILED); assert.equal(failed.reconciled, false);
  assert.ok(!JSON.stringify(failed).includes('unreadable'), 'error text is not public');
  assert.match(shadow.report(broken, { details: true }).lastError, /snapshot unreadable/);
});

// ------------------------------------------------------------- regressions found in the handoff review
test('regression: an adjusted relationship (dangling guardianId) is a finding and is never reported as complete', () => {
  const s = freshDb(); seedOrgUser(s);
  const shadow = createCoreIdentityShadow({ sqlite: s });
  const db = {
    orgs: [], guardians: [{ id: 'gd-1', name: 'G', email: 'g@example.com', childIds: [] }],
    players: [{ id: 'pl-x', name: 'X', dob: '2012-01-01', country: 'GB', guardianId: 'gd-missing', medical: { shared: false, records: [], conditionStatus: 'unknown' } }],
    sessions: [],
  };
  s.prepare("INSERT INTO meta (key, value) VALUES ('savedAt', '5')").run();
  transaction(s, () => shadow.project(db, { savedAt: 5, saveSeq: 1 }));
  const r = shadow.report(db, { enabled: true });
  assert.equal(r.tables.players.findings, 1);
  assert.equal(r.tables.players.tableRows, 1, 'the player row is written (with guardian_id NULL)');
  assert.notEqual(r.status, SHADOW_STATUS.COMPLETE, 'an unresolved relationship is not a clean result');
  assert.equal(r.reconciled, false);
  assert.equal(r.findings, 1, 'the report totals the findings');
  assert.deepEqual(shadow.report(db, { details: true }).tables.players.details.findings, [{ id: 'pl-x', finding: 'guardianId gd-missing does not exist; written as NULL' }]);
});
test('regression: guardian projection does not depend on array order; a co-guardian listed before their primary keeps the link', () => {
  const run = (guardians) => {
    const s = freshDb();
    const shadow = createCoreIdentityShadow({ sqlite: s });
    const db = { orgs: [], guardians, players: [], sessions: [] };
    const result = transaction(s, () => shadow.project(db));
    return { s, result };
  };
  const primary = { id: 'gd-primary', name: 'Primary', email: 'p@example.com', childIds: [] };
  const co = { id: 'gd-co', name: 'Co', email: 'c@example.com', coGuardianOf: 'gd-primary', childIds: [] };
  for (const order of [[co, primary], [primary, co]]) {
    const { s, result } = run(order);
    assert.deepEqual(result.tables.guardians.skipped, [], `no guardian is refused for order ${order.map((g) => g.id).join(',')}`);
    assert.deepEqual(result.tables.guardians.findings, []);
    assert.equal(s.prepare("SELECT co_guardian_of FROM guardians WHERE id = 'gd-co'").get().co_guardian_of, 'gd-primary', 'the valid link is kept');
    assert.equal(s.prepare("SELECT co_guardian_of FROM guardians WHERE id = 'gd-primary'").get().co_guardian_of, null);
    assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys stay on');
  }
  // A genuinely missing target is an explicit finding, written as NULL, never silently dropped or refused.
  const { s, result } = run([{ ...co, coGuardianOf: 'gd-nobody' }, primary]);
  assert.deepEqual(result.tables.guardians.findings, [{ id: 'gd-co', finding: 'coGuardianOf gd-nobody does not exist; written as NULL' }]);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 2);
  // A target that was itself refused (here: no name, NOT NULL) is reported, not linked to a row that does not exist.
  const refused = { id: 'gd-refused', name: null, email: 'r@example.com', childIds: [] };
  const r3 = run([{ ...co, coGuardianOf: 'gd-refused' }, refused, primary]);
  assert.deepEqual(r3.result.tables.guardians.skipped.map((x) => x.id), ['gd-refused']);
  assert.deepEqual(r3.result.tables.guardians.findings, [{ id: 'gd-co', finding: 'coGuardianOf gd-refused refers to a guardian that was not written; written as NULL' }]);
  assert.equal(r3.s.prepare("SELECT co_guardian_of FROM guardians WHERE id = 'gd-co'").get().co_guardian_of, null);
});
test('regression: freshness is a persisted save revision, not the savedAt timestamp (same savedAt, different content → stale)', () => {
  const dir = tempDir('shadow-rev');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot(); db.users = [];
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  store.save({ savedAt: 1, idCounter: 1000, db });
  assert.equal(layer.report().shadow.status, SHADOW_STATUS.PARTIAL, 'projected in this save');
  assert.equal(store.sqlite.prepare("SELECT name FROM players WHERE id = 'pl-adult'").get().name, 'Adult Player');
  store.sqlite.close();
  // Restart with projection off, change a name, save with the SAME savedAt.
  const db2 = JSON.parse(JSON.stringify(db));
  db2.players.find((p) => p.id === 'pl-adult').name = 'Renamed Player';
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 1, idCounter: 1000, db: db2 });
  const r = layer.report().shadow;
  assert.equal(store.sqlite.prepare("SELECT name FROM players WHERE id = 'pl-adult'").get().name, 'Adult Player', 'the shadow still holds the old name');
  assert.equal(r.status, SHADOW_STATUS.STALE, 'a save made while projection was off makes the shadow stale regardless of savedAt');
  assert.equal(r.reconciled, false);
  assert.ok(r.snapshotRevision > r.lastProjectionRevision, 'the file carries a revision the projection has not seen');
  // A failed projection leaves the revision behind too (a restarted server builds a fresh db object).
  store.sqlite.close();
  const db3 = JSON.parse(JSON.stringify(db2));
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: db3, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  store.setProjection(() => { throw new Error('boom'); });
  store.save({ savedAt: 1, idCounter: 1000, db: db3 });
  assert.notEqual(layer.report().shadow.status, SHADOW_STATUS.COMPLETE);
  assert.equal(layer.report().shadow.reconciled, false);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- the store
test('attachDataLayer (default): shadow validation is off, a save is the plain blob save and never touches the shadow tables', () => {
  const dir = tempDir('shadow-off');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot();
  db.users = [{ id: 'usr-9001', orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.equal(store.projectionState().enabled, false, 'no projection is registered unless asked for');
  // Count every SQL statement the store executes during a save: no SAVEPOINT, no shadow writes.
  const exec = store.sqlite.exec.bind(store.sqlite);
  const seen = [];
  store.sqlite.exec = (sql) => { seen.push(sql); return exec(sql); };
  for (let i = 1; i <= 3; i++) store.save({ savedAt: i, idCounter: 1000, db });
  assert.ok(!seen.some((sql) => /SAVEPOINT|shadow/i.test(sql)), 'no savepoint and no shadow statement in the save path');
  for (const t of CORE_SHADOW_TABLES) assert.equal(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} untouched`);
  assert.equal(store.load().db.orgs.length, 4, 'the blob is saved exactly as before');
  const report = layer.report();
  assert.equal(report.shadow.enabled, false); assert.equal(report.shadow.status, SHADOW_STATUS.NEVER); assert.equal(report.shadow.reconciled, false);
  assert.deepEqual(report.shadow.store, { enabled: false, failures: 0, lastErrorAt: null });
  assert.equal(report.domains.users.mode, 'live', 'the S0 live table is unaffected');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('attachDataLayer (shadowValidation: true): the shadow is rewritten inside every save, survives a restart, and goes stale when validation is switched off', () => {
  const dir = tempDir('shadow-on');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot();
  db.users = [{ id: 'usr-9001', orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  assert.equal(store.projectionState().enabled, true);
  store.save({ savedAt: 1, idCounter: 1000, db });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 3);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'sessions are live (S2): the fixture sessions are not projected');
  let report = layer.report();
  assert.equal(report.shadow.enabled, true); assert.equal(report.shadow.status, SHADOW_STATUS.PARTIAL);
  assert.equal(report.shadow.lastProjectionSavedAt, 1); assert.equal(report.shadow.snapshotSavedAt, 1);
  assert.deepEqual(report.tables, ['guardian_children', 'guardians', 'org_users', 'orgs', 'players', 'sessions']);
  assert.deepEqual(report.shadow.store, { enabled: true, failures: 0, lastErrorAt: null });
  // Save again with a changed snapshot: rewritten, no duplicates, no stale row.
  db.players.push({ id: 'pl-new', name: 'New', dob: '2001-01-01', country: 'GB', medical: { shared: false, records: [], conditionStatus: 'unknown' } });
  db.orgs = db.orgs.filter((o) => o.id !== 'org-c');
  store.save({ savedAt: 2, idCounter: 1000, db });
  assert.deepEqual(store.sqlite.prepare('SELECT id FROM players ORDER BY id').all().map((r) => r.id), ['pl-adult', 'pl-minor', 'pl-new', 'pl-orphan']);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-c'").get().n, 0, 'a removed org is gone');
  store.sqlite.close();
  // Restart with validation still on: the persisted summary says the tables match the last save.
  // (A restarted server builds a fresh db object; the old one carries the frozen users view.)
  const restarted = () => JSON.parse(JSON.stringify(db));
  let db2 = restarted();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 4, 'rows persist across a restart');
  report = layer.report();
  assert.equal(report.shadow.status, SHADOW_STATUS.PARTIAL, 'freshness is known from the file, not from this process');
  assert.equal(report.shadow.tables.players.accountedFor, true);
  assert.equal(store.load().db.orgs.length, 3, 'the blob snapshot is untouched: the snapshot stays the source of truth');
  store.sqlite.close();
  // Restart with validation off: the next save leaves the tables alone and the report says stale.
  db2 = restarted();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: db2, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 3, idCounter: 1000, db: db2 });
  report = layer.report();
  assert.equal(report.shadow.enabled, false); assert.equal(report.shadow.status, SHADOW_STATUS.STALE); assert.equal(report.shadow.reconciled, false);
  assert.equal(report.shadow.tables.players.tableRows, 4, 'old rows remain, labelled stale');
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (server mode): a projection failure never blocks the blob save and leaves the previous summary in place', () => {
  const dir = tempDir('shadow-fail');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  runDataMigrations(store.sqlite, DATA_MIGRATIONS);
  let calls = 0;
  store.setProjection(() => { calls += 1; store.sqlite.prepare("INSERT INTO orgs (id, name, type, level, plan) VALUES ('ghost', 'G', 'club', 'pro', 'Pro')").run(); throw new Error('projection exploded'); });
  store.save({ savedAt: 2, idCounter: 1000, db: { players: [{ id: 'p1' }] } });
  assert.equal(calls, 1);
  assert.deepEqual(store.load().db.players, [{ id: 'p1' }], 'the blob was saved');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0, 'the half-written shadow was rolled back to the savepoint');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'shadowSummary'").get().n, 0, 'no summary is recorded for a failed projection');
  const state = store.projectionState();
  assert.equal(state.enabled, true); assert.equal(state.failures, 1); assert.match(state.lastError.message, /projection exploded/);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): tools reading the file as a snapshot never see the shadow tables as collections', () => {
  const dir = tempDir('shadow-tool');
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot(); db.users = [];
  attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, shadowValidation: true });
  store.save({ savedAt: 1, idCounter: 1000, db });
  store.sqlite.close();
  store = openStore(dir);
  const snap = store.load();
  assert.equal(snap.db.orgs.length, 4, 'the blob collection, not the shadow table');
  assert.equal(snap.db.guardian_children, undefined);
  assert.deepEqual(snap.db.users, []);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('validateShadow.mjs: runs the projection on a copy, reports every refused row, and leaves the source file byte-identical', () => {
  const dir = tempDir('shadow-validate');
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = syntheticSnapshot(); db.users = [{ id: 'usr-9001', orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }];
  attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  store.save({ savedAt: 5, idCounter: 1000, db });
  store.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.sqlite.close();
  const digest = () => sha256(fs.readFileSync(path.join(dir, 'scoutbox.db')));
  const before = digest();
  const out = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'validateShadow.mjs'), dir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const result = JSON.parse(out);
  assert.equal(digest(), before, 'the source database is untouched');
  assert.ok(!fs.existsSync(result.work ?? '/nonexistent'), 'the working copy is removed');
  assert.equal(result.error, null);
  assert.equal(result.report.status, SHADOW_STATUS.PARTIAL);
  assert.equal(result.report.tables.orgs.tableRows, 3); assert.equal(result.report.tables.orgs.skipped, 1);
  assert.deepEqual(result.report.tables.orgs.details.skipped.map((x) => x.id), ['org-bad']);
  assert.deepEqual(result.report.tables.guardian_children.details.skipped, [{ id: 'gd-1/pl-gone', reason: 'child player does not exist' }]);
  assert.ok(!out.includes('tok-org') && !out.includes('scrypt$'), 'no token or password hash in the validation output');
  // The source still has no shadow rows: validation happened on the copy only.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  assert.equal(again.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('regression: strict validation accepts a clean backup from before the save-revision field, refuses an invalid one, and never touches the source', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validateShadow.mjs');
  const run = (dir, ...flags) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, dir, '--json', ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (err) { return { code: err.status, out: err.stdout }; }
  };
  const fixture = (mutate) => {
    const dir = tempDir('shadow-legacy');
    const store = openStore(dir, { tableBacked: TABLE_BACKED });
    const db = { orgs: [{ id: 'org-a', name: 'A', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' }], guardians: [], players: [], sessions: [], users: [] };
    attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
    mutate?.(db);
    store.save({ savedAt: 1, idCounter: 1000, db });
    return { dir, store };
  };
  const digest = (dir) => { const s = openStore(dir, { tableBacked: TABLE_BACKED }); s.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); s.sqlite.close(); return sha256(fs.readFileSync(path.join(dir, 'scoutbox.db'))); };
  // 1. A clean legacy backup: no meta.saveSeq (saved by a build before the revision field).
  const legacy = fixture();
  legacy.store.sqlite.exec("DELETE FROM meta WHERE key = 'saveSeq'"); legacy.store.sqlite.close();
  const before = digest(legacy.dir);
  const r1 = run(legacy.dir, '--strict');
  const j1 = JSON.parse(r1.out);
  assert.equal(r1.code, 0, 'a clean legacy backup passes the strict gate');
  assert.equal(j1.report.status, SHADOW_STATUS.COMPLETE); assert.equal(j1.legacyRevisionInitialised, true);
  assert.equal(digest(legacy.dir), before, 'the source is byte-identical');
  const src = openStore(legacy.dir, { tableBacked: TABLE_BACKED });
  assert.equal(src.sqlite.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'saveSeq'").get().n, 0, 'the revision was initialised on the copy only');
  src.sqlite.close();
  // 2. An invalid legacy backup (a refused row) still fails the strict gate.
  const bad = fixture((db) => db.orgs.push({ id: 'org-bad', name: 'B', type: 'club', level: 'agent', plan: 'Pro', country: 'GB' }));
  bad.store.sqlite.exec("DELETE FROM meta WHERE key = 'saveSeq'"); bad.store.sqlite.close();
  const r2 = run(bad.dir, '--strict');
  assert.equal(r2.code, 3); assert.equal(JSON.parse(r2.out).report.status, SHADOW_STATUS.PARTIAL);
  assert.equal(JSON.parse(r2.out).report.skipped, 1);
  // 3. A current backup (revision present) passes without any initialisation.
  const current = fixture(); current.store.sqlite.close();
  const r3 = run(current.dir, '--strict');
  assert.equal(r3.code, 0); assert.equal(JSON.parse(r3.out).legacyRevisionInitialised, false); assert.equal(JSON.parse(r3.out).report.status, SHADOW_STATUS.COMPLETE);
  // 4. The running server's own report keeps calling a revision-less file stale: no weakening of live freshness.
  const live = fixture(); live.store.sqlite.exec("DELETE FROM meta WHERE key = 'saveSeq'");
  const liveShadow = createCoreIdentityShadow({ sqlite: live.store.sqlite });
  live.store.sqlite.exec("INSERT INTO meta (key, value) VALUES ('shadowSummary', '{\"at\":1,\"savedAt\":1,\"saveSeq\":null,\"durationMs\":0,\"tables\":{}}')");
  assert.notEqual(liveShadow.report({ orgs: [] }).status, SHADOW_STATUS.COMPLETE);
  live.store.sqlite.close();
  for (const d of [legacy.dir, bad.dir, current.dir, live.dir]) fs.rmSync(d, { recursive: true, force: true });
});
test('the shadow table list and the store contract agree on what is shadowed', () => {
  assert.deepEqual([...CORE_SHADOW_TABLES], ['orgs', 'guardians', 'players', 'guardian_children'], 'sessions left the shadow at S2');
});

console.log(`\n${passed} core-schema checks passed`);
