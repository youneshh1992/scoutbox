// Behavioural tests for the core identity schema: the five tables created by
// migration 0002 (plan step S1, as a shadow) and live one domain at a time
// since — sessions (0003), orgs (0004), players/guardians/guardian_children
// (0005, S4a) — their constraints, foreign keys and the identity records
// as they are typed and read back. Everything runs on
// throwaway databases under the OS temp directory; nothing touches DATA_DIR.
// Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import { hasBlobTable } from './coreIdentityTestFixtures.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const TTL = 30 * DAY;
let counter = 5000;
const nextId = (p) => `${p}-${++counter}`;

const freshDb = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(s, DATA_MIGRATIONS, { now: Date.UTC(2026, 9, 11, 12) }); return s; };
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));

/** A synthetic snapshot in the exact shapes the server writes. No real data. */
function syntheticSnapshot({ orgUserId = 'usr-9001' } = {}) {
  const now = Date.now();
  return {
    orgs: [
      { id: 'org-a', name: 'Alpha FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', location: { lat: 51.5, lng: -0.1, city: 'London' }, verified: true, safeguardingContractSigned: true, trustedPartner: false, verifiedDomain: 'alpha.example', password: 'scrypt$00$11' },
      { id: 'org-b', name: 'Beta Grassroots', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'GB', location: { lat: 53.4, lng: -2.2, city: 'Manchester' }, federationRef: { federation: 'The FA', registrationId: 'FA-1' }, verified: false, suspended: true },
      { id: 'org-c', name: 'Gamma Agency', type: 'agency', level: 'agency', plan: 'Agency', country: 'PT', location: null, verified: true, mfaRequiredForLeads: true, verificationRevokedAt: now - DAY },
      { id: 'org-bad', name: 'Broken Level', type: 'club', level: 'agent', plan: 'Pro', country: 'GB' },
    ],
    guardians: [
      { id: 'gd-1', name: 'Guardian One', email: 'one@example.com', password: null, emailVerified: true, emailCodeHash: 'a'.repeat(64), idVerified: true, disclaimerAccepted: true, childIds: ['pl-minor', 'pl-gone'], notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: true, timezone: 'Europe/London' } },
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
const seedOrgUser = (s, id = 'usr-9001') => { s.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan, created_at) VALUES ('org-a', 'Org A', 'club', 'pro', 'Pro', 0)").run(); s.prepare("INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES (?, 'org-a', 'Maria Keane', ?, 'Head of Recruitment', ?)").run(id, `maria keane ${id}`, Date.now()); };

// ------------------------------------------------------------- migration 0002
test('the five core identity tables exist as STRICT tables after the registered migrations, and the registry applies nothing twice', () => {
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
  const org = (over) => s.prepare("INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES (@id, 'X', @type, @level, @plan, 0)").run({ id: 'o', type: 'club', level: 'pro', plan: 'Pro', ...over });
  assert.throws(() => org({ level: 'agent' }), /CHECK/);
  assert.throws(() => org({ type: 'academy' }), /CHECK/);
  assert.throws(() => org({ plan: 'Gold' }), /CHECK/);
  org({});
  assert.throws(() => s.prepare("UPDATE orgs SET lat = 1 WHERE id = 'o'").run(), /CHECK/, 'lat without lng');
  const player = (over) => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, foot, availability) VALUES (@id, 30, 'P', @dob, 'GB', @foot, @availability)").run({ id: 'p', dob: '2000-01-01', foot: null, availability: 'not_seeking', ...over });
  assert.throws(() => player({ foot: 'both' }), /CHECK/);
  assert.throws(() => player({ dob: '2000-1-1' }), /CHECK/);
  assert.throws(() => player({ availability: 'maybe' }), /CHECK/);
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, height_cm) VALUES ('p2', 30, 'P', '2000-01-01', 'GB', 'tall')").run(), /cannot store TEXT value in INTEGER column/, 'STRICT refuses text in an INTEGER column');
  // S14h: lengths and ranges.
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country) VALUES ('p3', 30, ?, '2000-01-01', 'GB')").run('N'.repeat(121)), /CHECK/, 'a name over 120 characters');
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, height_cm) VALUES ('p3', 30, 'P', '2000-01-01', 'GB', 400)").run(), /CHECK/, 'a height out of range');
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, stats_pass_completion_pct) VALUES ('p3', 30, 'P', '2000-01-01', 'GB', 120)").run(), /CHECK/, 'a percentage over 100');
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, prefs_quiet_start) VALUES ('p3', 30, 'P', '2000-01-01', 'GB', '9pm')").run(), /CHECK/, 'quiet hours not HH:MM');
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, city) VALUES ('p3', 30, 'P', '2000-01-01', 'GB', '')").run(), /CHECK/, 'an empty city is NULL');
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country) VALUES ('p3', 100, 'P', '2000-01-01', 'GB')").run(), /CHECK/, 'a profile figure over 99 (S14i)');
  assert.throws(() => s.prepare("INSERT INTO players (id, name, birth_date, country) VALUES ('p3', 'P', '2000-01-01', 'GB')").run(), /NOT NULL/, 'the profile figure is required (S14i)');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('players') WHERE name = 'facets_json'").get().n, 0, 'no facet storage (S14h)');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('guardians') WHERE name = 'facets_json'").get().n, 0, 'no facet storage (S14h)');
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
  assert.throws(() => s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, guardian_id) VALUES ('p', 30, 'P', '2010-01-01', 'GB', 'gd-none')").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO guardians (id, name, email) VALUES ('g', 'G', 'g@example.com')").run();
  s.prepare("INSERT INTO players (id, profile_signal, name, birth_date, country, guardian_id) VALUES ('p', 30, 'P', '2010-01-01', 'GB', 'g')").run();
  assert.throws(() => s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('g', 'p-none', 'co')").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('g', 'p', 'primary')").run();
  assert.throws(() => s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h', 's', 'org', 'org-a', 'usr-none', 1, 2)").run(), /FOREIGN KEY/);
  seedOrgUser(s, 'usr-1');
  s.prepare("INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES ('h', 's', 'org', 'org-a', 'usr-1', 1, 2)").run();
  // S14h: a guardian with a child is never deleted from under it (RESTRICT), nor a player with a link; one primary per player.
  assert.throws(() => s.prepare("DELETE FROM guardians WHERE id = 'g'").run(), /FOREIGN KEY/);
  assert.throws(() => s.prepare("DELETE FROM players WHERE id = 'p'").run(), /FOREIGN KEY/);
  s.prepare("INSERT INTO guardians (id, name, email) VALUES ('g2', 'G2', 'g2@example.com')").run();
  assert.throws(() => s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('g2', 'p', 'primary')").run(), /UNIQUE/, 'one primary link per player');
  s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('g2', 'p', 'co')").run();
  // Deleting the staff member takes their sessions with them.
  s.prepare("DELETE FROM org_users WHERE id = 'usr-1'").run();
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

// ------------------------------------------------------------- transactions
test('a failing transaction leaves nothing behind', () => {
  const s = freshDb();
  assert.throws(() => transaction(s, () => {
    s.prepare("INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('o1', 'X', 'club', 'pro', 'Pro', 0)").run();
    s.prepare("INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('o2', 'X', 'club', 'nope', 'Pro', 0)").run();
  }), /CHECK/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, 0);
});

// ------------------------------------------------------------- the identity records (S4a)
// Since migration 0005 the players, guardians and guardian_children tables are
// LIVE. Read back, both collections are the records the server sees (childIds
// from the links, in order, roles per side). A first installation types the
// records as one coupled pair (the links derive from both collections).
const PLAYER_ADULT = () => ({ id: 'pl-adult', name: 'Adult Player', dob: '2000-01-01', country: 'GB', city: 'London', position: 'ST', foot: 'right', heightCm: 180, weightKg: 75, stats: { appearances: 20, goals: 9, assists: 3, paceKmh: 33.4, passCompletionPct: 81, duelSuccessPct: 63 }, academyPlus: true, availability: 'available_now', contractStatus: 'free_agent', identityVerified: true, guardianId: null, level: 'semi_pro', location: { lat: 51.5, lng: -0.1 }, medical: { shared: true, records: [], conditionStatus: 'fully_fit' }, notificationPrefs: { quietStart: '22:00', quietEnd: '07:00', schoolHoursMute: null, timezone: null }, programme: { track: 'ST', startedAt: 1_700_000_000_000, completed: [] }, badges: ['Finisher'], createdAt: 1_690_000_000_000, password: 'scrypt$aa$bb' });
const PLAYER_MINOR = (guardianId = 'gd-1') => ({ id: 'pl-minor', name: 'Minor Player', dob: '2011-06-15', country: 'GB', city: 'London', position: 'CM', foot: 'left', guardianId, stats: null, medical: { shared: false, records: [{ id: 'md-1', type: 'clearance', title: 'ok', date: '2026-01-01', cleared: true }], conditionStatus: 'unknown' }, location: null, createdAt: 1_695_000_000_000 });
const GUARDIAN_1 = () => ({ id: 'gd-1', name: 'Guardian One', email: 'one@example.com', password: null, emailVerified: true, emailCodeHash: 'a'.repeat(64), idVerified: true, disclaimerAccepted: true, childIds: ['pl-minor'], notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: true, timezone: 'Europe/London' } });
const GUARDIAN_2 = () => ({ id: 'gd-2', name: 'Guardian Two', email: 'two@example.com', coGuardianOf: 'gd-1', childIds: ['pl-minor'] });
/** A consistent synthetic record set: two players, a primary and a co-guardian, three organisations. */
function cleanRecords() {
  const s = syntheticSnapshot();
  return { orgs: s.orgs.filter((o) => o.id !== 'org-bad'), guardians: [GUARDIAN_1(), GUARDIAN_2()], players: [PLAYER_ADULT(), PLAYER_MINOR()], sessions: [] };
}
const NOW = Date.UTC(2026, 9, 11, 12);
const rows = (s, sql) => s.prepare(sql).all().map((r) => ({ ...r }));
/** A first installation of `records` through the data layer (the seed is imported once). */
const firstInstallation = (server, records, extra = {}) => { const layer = attachDataLayer({ seed: { orgs: records.orgs, players: records.players, guardians: records.guardians }, store: server, nextId, sessionTtlMs: TTL, now: () => NOW, ...extra }); return layer; };

test('identity records: players and guardians read back from the live tables as the records the server sees (childIds from the links, in order, roles per side); records added later are created through the repositories, and the next server boot attaches to exactly that', () => {
  const dir = tempDir('s4-records');
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = firstInstallation(server, cleanRecords());
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 2, links: 2, imported: 4 }, 'a first installation initialises from the records once (imported counts players and guardians)');
  assert.equal(hasBlobTable(server.sqlite), false, 'no blob table: the records are rows (rewritten in S14a: it listed the blob rows)');
  server.sqlite.close();
  // The tables read back as records.
  const back = readRecords(dir);
  assert.deepEqual(back.players.map((p) => p.id), ['pl-adult', 'pl-minor']);
  assert.deepEqual(back.guardians.map((g) => [g.id, [...g.childIds], g.coGuardianOf ?? null]), [['gd-1', ['pl-minor'], null], ['gd-2', ['pl-minor'], 'gd-1']]);
  assert.equal(back.players[1].guardianId, 'gd-1'); assert.equal(back.players[1].medical.records[0].id, 'md-1', 'a facet reads back');
  assert.equal(back.players[0].stats.paceKmh, 33.4); assert.deepEqual([...back.players[0].badges], ['Finisher']);
  assert.equal(JSON.stringify(back).includes('scrypt$aa$bb'), true, 'the read-back is the server\'s view: the hash travels with the record (a backup, not an audience response)');
  // A new guardian with a new child, created on the existing database.
  writeFixture(dir, { guardians: [{ id: 'gd-3', name: 'Guardian Three', email: 'three@example.com', childIds: [] }], players: [{ id: 'pl-new', name: 'New Child', dob: '2015-02-02', country: 'GB', guardianId: 'gd-3', stats: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } }] }, { now: NOW });
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  assert.deepEqual(rows(s, 'SELECT id, name FROM players ORDER BY rowid'), [{ id: 'pl-adult', name: 'Adult Player' }, { id: 'pl-minor', name: 'Minor Player' }, { id: 'pl-new', name: 'New Child' }]);
  assert.deepEqual(rows(s, 'SELECT id FROM guardians ORDER BY rowid').map((r) => r.id), ['gd-1', 'gd-2', 'gd-3']);
  assert.deepEqual(rows(s, 'SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid'), [{ guardian_id: 'gd-1', player_id: 'pl-minor', role: 'primary' }, { guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }, { guardian_id: 'gd-3', player_id: 'pl-new', role: 'primary' }]);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(hasBlobTable(s), false);
  s.close();
  // The server attaches to exactly that; stale records handed in as a seed import nothing.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ seed: { players: [PLAYER_ADULT()], guardians: [GUARDIAN_1(), GUARDIAN_2()] }, store: again, nextId, sessionTtlMs: TTL, now: () => NOW });
  assert.deepEqual(layer2.boot.identity, { engine: 'sqlite', players: 3, guardians: 3, links: 3, imported: 0 });
  assert.deepEqual([...layer2.guardians.byId('gd-3').childIds], ['pl-new']);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('identity records: a first installation types players and guardians as one pair — a refused record, a duplicate e-mail, a dangling relationship or a legacy minor without any guardian link refuse the WHOLE import naming the id and field; nothing is written and initialisation stays pending', () => {
  const refuse = (label, mutate, re) => {
    const dir = tempDir('s4-init-refuse');
    const records = cleanRecords(); mutate(records);
    assert.throws(() => writeFixture(dir, records, { now: NOW }), (e) => e.code === 'CORE_IDENTITY_CUTOVER_BLOCKED' && re.test(e.message), label);
    const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
    try {
      assert.equal(rows(s, 'SELECT (SELECT COUNT(*) FROM players) + (SELECT COUNT(*) FROM guardians) + (SELECT COUNT(*) FROM guardian_children) AS n')[0].n, 0, `${label}: no identity row was written`);
      assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'coreIdentityInit'").get()?.value, 'pending', `${label}: initialisation stays pending`);
    } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  refuse('a refused record (foot)', (d) => { d.players[0].foot = 'both'; }, /players pl-adult: foot must be one of/);
  refuse('a refused record (duplicate e-mail)', (d) => { d.guardians.push({ id: 'gd-dup', name: 'Dup', email: 'ONE@example.com', childIds: [] }); }, /guardians gd-dup: the e-mail is already used by guardian gd-1/);
  refuse('a dangling guardianId', (d) => { d.players[1].guardianId = 'gd-missing'; }, /players pl-minor: guardianId names guardian gd-missing, which the snapshot does not hold/);
  refuse('a guardian missing but still referenced', (d) => { d.guardians = d.guardians.filter((g) => g.id !== 'gd-1'); }, /players pl-minor: guardianId names guardian gd-1, which the snapshot does not hold/);
  refuse('a childIds entry naming nobody', (d) => { d.guardians[0].childIds.push('pl-ghost'); }, /guardians gd-1: childIds names player pl-ghost, which the snapshot does not hold/);
  refuse('a legacy minor without any guardian link (the Founder\'s decision)', (d) => { d.players.push({ id: 'pl-orphan', name: 'Orphan', dob: '2013-04-04', country: 'GB', guardianId: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } }); }, /players pl-orphan: a minor without a primary guardian/);
});

test('identity tables: there is no players table before migration 0005; TABLE_BACKED lists every live collection', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => !/^00(0[56789]|1[0-9]|2[0-9]|3[0-9]|4[0-9])_/.test(m.id))); // each later step needs its predecessor
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'players'").get().n, 0, 'S14h: there is no players table before 0005');
  s.close();
  assert.deepEqual([...TABLE_BACKED], ['orgs', 'players', 'guardians', 'playersRetained', 'users', 'sessions', 'mediaDeletions', 'emailChallenges', 'pairingCodes', 'notifications', 'notificationPrefs', 'dispatches', 'outbox', 'pushLog', 'pushTokens', 'channels', 'blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue', 'requests', 'trials', 'recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState', 'recruitmentContacts', 'recruitmentOffers', 'signingPackages', 'signings', 'followUps', 'outcomeReports', 'evidence', 'coachAffiliations', 'squadInvites', 'assessmentTemplates', 'assessments', 'videoSegments', 'playlists', 'tacticalSetups', 'squadMembers', 'shadowPlayers', 'lookingFor', 'federationChecks', 'vacancies', 'opportunities', 'applications', 'campaigns', 'campaignSubmissions', 'playerPrefs', 'verClaims', 'verEvents', 'verEvidence', 'verTokens', 'verAdmins', 'verRootTransfers', 'verRootRequests', 'verDisputes', 'verReferences', 'verPlayerInvites', 'verConflicts', 'verDomainRequests', 'orgVerifiedDomains', 'passportPrefs', 'passportCareerEntries', 'passportAchievements', 'passportShares', 'passportCorrections', 'transitionCases', 'vouches', 'agentProfiles', 'agencyAffiliations', 'representationAgreements', 'tsReviewers', 'jurisdictionPolicies', 'complianceContexts', 'regulatoryReviews', 'regulatoryConsents', 'agentTransactions', 'transactionRepresentations', 'transactionDocuments', 'devObjectives', 'drillGuidance', 'developmentPlans', 'developmentGoals', 'developmentActions', 'developmentEvidenceLinks', 'developmentReviews', 'boxCamPrefs', 'boxChallenges', 'boxChallengeEntries', 'boxAssignments', 'boxSessions', 'boxCamDisputes', 'combineRequests', 'combineAttempts', 'boxCamCvResults', 'recruitmentBriefs', 'nobodyMissedReviews', 'secondLookItems', 'dynamicWatchlists', 'watchlistHistory', 'exposureEvents', 'reviewLater', 'evidenceSuggestions', 'calibrationSessions', 'fixtures', 'coveragePlans', 'coverageAssignments', 'importBatches', 'prospects', 'identityReviews', 'apiKeys', 'webhookEndpoints', 'webhookDeliveries', 'orgInvites', 'ssoConfigs', 'ssoStates', 'supportTickets', 'supportAccessGrants', 'groups', 'groupGrants', 'openTrials', 'matchdays', 'friendlies', 'uploadSessions', 'savedSearches', 'invoices', 'reputationSeed', 'deliveryCallbacksSeen']);
});

console.log(`\n${passed} core-schema checks passed`);
