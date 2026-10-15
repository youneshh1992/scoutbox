// Behavioural tests for the core identity schema: the five tables created by
// migration 0002 (plan step S1, as a shadow) and live one domain at a time
// since — sessions (0003), orgs (0004), players/guardians/guardian_children
// (0005, S4a) — their constraints, foreign keys and the coupled identity
// snapshot that tools read and write through the tables. Everything runs on
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
import { IDENTITY_SNAPSHOT } from '../repositories/identity.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import { failRunAt } from './coreIdentityTestFixtures.mjs';

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
const seedOrgUser = (s, id = 'usr-9001') => { s.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan) VALUES ('org-a', 'Org A', 'club', 'pro', 'Pro')").run(); s.prepare("INSERT INTO org_users (id, org_id, name, role, created_at) VALUES (?, 'org-a', 'Maria Keane', 'Head of Recruitment', ?)").run(id, Date.now()); };

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

// ------------------------------------------------------------- the identity snapshot (S4a)
// Since migration 0005 the players, guardians and guardian_children tables are
// LIVE. A tool reading the file as one snapshot (backups, restores, the
// persistence suites) gets both collections from the tables as the records the
// server sees, and writes them back THROUGH the tables as one coupled
// operation (repositories/identity.mjs IDENTITY_SNAPSHOT): the links derive
// from both collections, so a snapshot carries both or neither.
const PLAYER_ADULT = () => ({ id: 'pl-adult', name: 'Adult Player', dob: '2000-01-01', country: 'GB', city: 'London', position: 'ST', foot: 'right', heightCm: 180, weightKg: 75, stats: { appearances: 20, goals: 9, assists: 3, paceKmh: 33.4, passCompletionPct: 81, duelSuccessPct: 63 }, academyPlus: true, availability: 'available_now', contractStatus: 'free_agent', identityVerified: true, guardianId: null, level: 'semi_pro', location: { lat: 51.5, lng: -0.1 }, medical: { shared: true, records: [], conditionStatus: 'fully_fit' }, notificationPrefs: { quietStart: '22:00', quietEnd: '07:00', schoolHoursMute: null, timezone: null }, programme: { track: 'ST', startedAt: 1_700_000_000_000, completed: [] }, badges: ['Finisher'], createdAt: 1_690_000_000_000, password: 'scrypt$aa$bb' });
const PLAYER_MINOR = (guardianId = 'gd-1') => ({ id: 'pl-minor', name: 'Minor Player', dob: '2011-06-15', country: 'GB', city: 'London', position: 'CM', foot: 'left', guardianId, stats: null, medical: { shared: false, records: [{ id: 'md-1', type: 'clearance', title: 'ok', date: '2026-01-01', cleared: true }], conditionStatus: 'unknown' }, location: null, createdAt: 1_695_000_000_000 });
const GUARDIAN_1 = () => ({ id: 'gd-1', name: 'Guardian One', email: 'one@example.com', password: null, emailVerified: true, emailCode: '123456', idVerified: true, disclaimerAccepted: true, childIds: ['pl-minor'], notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: true, timezone: 'Europe/London' } });
const GUARDIAN_2 = () => ({ id: 'gd-2', name: 'Guardian Two', email: 'two@example.com', coGuardianOf: 'gd-1', childIds: ['pl-minor'] });
/** A consistent synthetic snapshot: two players, a primary and a co-guardian, three organisations, one staff member. */
function cleanSnapshot() {
  const s = syntheticSnapshot();
  return { orgs: s.orgs.filter((o) => o.id !== 'org-bad'), guardians: [GUARDIAN_1(), GUARDIAN_2()], players: [PLAYER_ADULT(), PLAYER_MINOR()], sessions: [], users: [{ id: 'usr-9001', orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', createdAt: 1 }], notes: [{ id: 'n1' }] };
}
const NOW = Date.UTC(2026, 9, 11, 12);
const rows = (s, sql) => s.prepare(sql).all().map((r) => ({ ...r }));
const identityState = (s) => JSON.stringify({ players: rows(s, 'SELECT * FROM players ORDER BY rowid'), guardians: rows(s, 'SELECT * FROM guardians ORDER BY rowid'), links: rows(s, 'SELECT * FROM guardian_children ORDER BY rowid'), blobs: rows(s, 'SELECT name, value FROM collections ORDER BY name') });

test('identity snapshot (tool mode): a tool reads players and guardians from the live tables as the records the server sees (childIds from the links, in order, roles per side), writes a changed snapshot back through the tables — inserts, updates, link changes and removals — and the next server boot attaches to exactly that', () => {
  const dir = tempDir('s4-snap');
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = cleanSnapshot();
  const layer = attachDataLayer({ db, store: server, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 2, links: 2, imported: 4 }, 'a first installation initialises from the records once (imported counts players and guardians)');
  server.save({ savedAt: 1, idCounter: 1000, db });
  assert.deepEqual(rows(server.sqlite, 'SELECT name FROM collections ORDER BY name').map((r) => r.name), ['notes'], 'no identity blob is ever written again');
  server.sqlite.close();
  // The tool reads the tables as records.
  let tool = openStore(dir);
  const snap = tool.load();
  assert.deepEqual(snap.db.players.map((p) => p.id), ['pl-adult', 'pl-minor']);
  assert.deepEqual(snap.db.guardians.map((g) => [g.id, [...g.childIds], g.coGuardianOf ?? null]), [['gd-1', ['pl-minor'], null], ['gd-2', ['pl-minor'], 'gd-1']]);
  assert.equal(snap.db.players[1].guardianId, 'gd-1'); assert.equal(snap.db.players[1].medical.records[0].id, 'md-1', 'a facet reads back');
  assert.equal(snap.db.players[0].stats.paceKmh, 33.4); assert.deepEqual([...snap.db.players[0].badges], ['Finisher']);
  assert.equal(JSON.stringify(snap.db).includes('scrypt$aa$bb'), true, 'the snapshot is the server\'s view: the hash travels with the record (a backup, not an audience response)');
  // Write a changed snapshot back: an update, a new guardian with a new child, the co-guardian removed, the adult's facet edited.
  snap.db.players[0].name = 'Adult Renamed'; snap.db.players[0].badges.push('Captain');
  snap.db.guardians.push({ id: 'gd-3', name: 'Guardian Three', email: 'three@example.com', childIds: ['pl-new'] });
  snap.db.players.push({ id: 'pl-new', name: 'New Child', dob: '2015-02-02', country: 'GB', guardianId: 'gd-3', stats: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } });
  snap.db.guardians = snap.db.guardians.filter((g) => g.id !== 'gd-2');
  tool.save(snap);
  assert.deepEqual(rows(tool.sqlite, 'SELECT id, name FROM players ORDER BY rowid'), [{ id: 'pl-adult', name: 'Adult Renamed' }, { id: 'pl-minor', name: 'Minor Player' }, { id: 'pl-new', name: 'New Child' }]);
  assert.deepEqual(rows(tool.sqlite, 'SELECT id FROM guardians ORDER BY rowid').map((r) => r.id), ['gd-1', 'gd-3']);
  assert.deepEqual(rows(tool.sqlite, 'SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid'), [{ guardian_id: 'gd-1', player_id: 'pl-minor', role: 'primary' }, { guardian_id: 'gd-3', player_id: 'pl-new', role: 'primary' }], 'the links are rewritten from the snapshot: the removed co-guardian\'s link is gone');
  assert.deepEqual(tool.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(rows(tool.sqlite, 'SELECT name FROM collections ORDER BY name').map((r) => r.name), ['notes']);
  tool.sqlite.close();
  // The server attaches to exactly that; the array in memory (a stale copy) imports nothing.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { ...again.load().db, players: [PLAYER_ADULT()], guardians: [GUARDIAN_1(), GUARDIAN_2()] };
  const warnings = [];
  const layer2 = attachDataLayer({ db: db2, store: again, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.deepEqual(layer2.boot.identity, { engine: 'sqlite', players: 3, guardians: 2, links: 2, imported: 0 });
  assert.equal(db2.players.find((p) => p.id === 'pl-adult').name, 'Adult Renamed'); assert.deepEqual([...db2.players.find((p) => p.id === 'pl-adult').badges], ['Finisher', 'Captain']);
  assert.equal(db2.guardians.find((g) => g.id === 'gd-2'), undefined, 'the stale in-memory guardian was not resurrected');
  assert.ok(warnings.some((w) => /guardians table holds 2 row\(s\)/.test(w)), `the stale array is reported: ${JSON.stringify(warnings)}`);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('identity snapshot (tool mode): a malformed collection, a refused record, a dangling relationship, a legacy minor without any guardian link, or one collection without the other refuse the WHOLE save — no row, no link, no blob, no meta changes; a snapshot that carries neither collection leaves the tables alone; explicit empty arrays empty them on purpose', () => {
  const dir = tempDir('s4-snap-refuse');
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = cleanSnapshot();
  attachDataLayer({ db, store: server, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  server.save({ savedAt: 1, idCounter: 1000, db });
  server.sqlite.close();
  const tool = openStore(dir);
  const before = identityState(tool.sqlite); const seqBefore = tool.revision();
  const refuse = (label, mutate, re) => {
    const snap = tool.load(); mutate(snap.db);
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`);
    assert.equal(identityState(tool.sqlite), before, `${label}: nothing changed`);
    assert.equal(tool.revision(), seqBefore, `${label}: the save revision did not advance`);
  };
  refuse('players not an array', (d) => { d.players = { id: 'pl-adult' }; }, /players: the snapshot collection must be an array/);
  refuse('guardians null', (d) => { d.guardians = null; }, /guardians: the snapshot collection must be an array/);
  refuse('players without guardians', (d) => { delete d.guardians; }, /players: a snapshot that carries players must carry guardians too/);
  refuse('guardians without players', (d) => { delete d.players; }, /guardians: a snapshot that carries guardians must carry players too/);
  refuse('a refused record (foot)', (d) => { d.players[0].foot = 'both'; }, /identity snapshot: 1 record\(s\) or relationship\(s\) were refused \(players pl-adult: foot/);
  refuse('a refused record (duplicate e-mail)', (d) => { d.guardians.push({ id: 'gd-dup', name: 'Dup', email: 'ONE@example.com', childIds: [] }); }, /guardians gd-1: shares its e-mail/);
  refuse('a dangling guardianId', (d) => { d.players[1].guardianId = 'gd-missing'; }, /players pl-minor: guardianId names no record \(gd-missing\)/);
  refuse('a removed guardian still referenced', (d) => { d.guardians = d.guardians.filter((g) => g.id !== 'gd-1'); }, /players pl-minor: guardianId names no record \(gd-1\)/);
  refuse('a childIds entry naming nobody', (d) => { d.guardians[0].childIds.push('pl-ghost'); }, /guardians gd-1: childIds names no record \(pl-ghost\)/);
  refuse('a legacy minor without any guardian link (the Founder\'s decision)', (d) => { d.players.push({ id: 'pl-orphan', name: 'Orphan', dob: '2013-04-04', country: 'GB', guardianId: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } }); }, /players pl-orphan: a minor on the evaluation date with no guardian link at all .*Founder's decision/);
  // Partial snapshot: neither collection → the tables are untouched, other blobs are written.
  { const snap = tool.load(); delete snap.db.players; delete snap.db.guardians; snap.db.notes = [{ id: 'n2' }]; tool.save(snap); }
  assert.equal(identityState(tool.sqlite).replace(/"blobs":.*$/, ''), before.replace(/"blobs":.*$/, ''), 'the identity tables are exactly as before');
  assert.equal(tool.sqlite.prepare("SELECT value FROM collections WHERE name = 'notes'").get().value, '[{"id":"n2"}]');
  assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('players', 'guardians')").get().n, 0, 'no blob appeared for an omitted table-backed collection');
  // Explicit empty arrays: intentional, the tables are emptied (players before guardians: no foreign key is left broken).
  { const snap = tool.load(); snap.db.players = []; snap.db.guardians = []; tool.save(snap); }
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n + tool.sqlite.prepare('SELECT COUNT(*) AS n FROM guardians').get().n + tool.sqlite.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 0);
  tool.sqlite.close();
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ db: { ...again.load().db, players: [PLAYER_ADULT()], guardians: [] }, store: again, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 }, 'an intentionally emptied domain stays empty: the array in memory is never imported');
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('identity snapshot (tool mode, review of 9656a4b): a VALID full replacement is accepted whatever the obsolete rows or the input order — a removed guardian\'s e-mail reused by its replacement, two retained guardians swapping e-mails, retained players moving to the replacement, co-guardian references, each also with the collections in reversed order; actual duplicates, missing references and the legacy-minor rule stay refused; a failure in the middle of the rewrite and a failure of the REAL COMMIT leave every row, link, facet and other collection intact and a correct retry succeeds', () => {
  const dir = tempDir('s4-snap-order');
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = cleanSnapshot(); // gd-1 one@ (primary of pl-minor), gd-2 two@ (co of gd-1, co link to pl-minor), pl-adult, pl-minor
  attachDataLayer({ db, store: server, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  server.save({ savedAt: 1, idCounter: 1000, db });
  server.sqlite.close();
  const tool = openStore(dir);
  const otherState = () => JSON.stringify({ blobs: rows(tool.sqlite, 'SELECT name, value FROM collections ORDER BY name'), orgs: rows(tool.sqlite, 'SELECT id, name FROM orgs ORDER BY id'), staff: rows(tool.sqlite, 'SELECT id FROM org_users ORDER BY id') });
  const links = () => rows(tool.sqlite, 'SELECT guardian_id, player_id, role FROM guardian_children ORDER BY guardian_id, player_id');
  const apply = (mutate) => { const snap = tool.load(); mutate(snap.db); tool.save(snap); return tool.load().db; };
  const byId = (arr, id) => arr.find((r) => r.id === id);
  const others = otherState();
  // 1. The reviewer's case, extended: gd-1 is replaced by gd-new with the SAME e-mail; the minor moves to the replacement; the co-guardian now references it.
  let d = apply((x) => {
    const old = byId(x.guardians, 'gd-1');
    x.guardians = x.guardians.filter((g) => g.id !== 'gd-1');
    x.guardians.push({ ...old, id: 'gd-new', childIds: ['pl-minor'] });
    byId(x.guardians, 'gd-2').coGuardianOf = 'gd-new';
    byId(x.players, 'pl-minor').guardianId = 'gd-new';
  });
  assert.deepEqual(d.guardians.map((g) => [g.id, g.email, g.coGuardianOf ?? null, [...g.childIds]]).sort(), [['gd-2', 'two@example.com', 'gd-new', ['pl-minor']], ['gd-new', 'one@example.com', null, ['pl-minor']]]);
  assert.equal(byId(d.guardians, 'gd-new').emailCode, '123456', 'the replacement keeps the facet of the record it replaced (as given)');
  assert.equal(byId(d.players, 'pl-minor').guardianId, 'gd-new'); assert.equal(byId(d.players, 'pl-minor').medical.records[0].id, 'md-1', 'the moved player keeps its facets');
  assert.deepEqual([...byId(d.players, 'pl-adult').badges], ['Finisher']);
  assert.deepEqual(links(), [{ guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }, { guardian_id: 'gd-new', player_id: 'pl-minor', role: 'primary' }]);
  assert.deepEqual(tool.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  // 2. Two retained guardians swap e-mails — in the given order, then with both collections reversed.
  d = apply((x) => { const a = byId(x.guardians, 'gd-new'); const b = byId(x.guardians, 'gd-2'); [a.email, b.email] = [b.email, a.email]; });
  assert.deepEqual(d.guardians.map((g) => [g.id, g.email]).sort(), [['gd-2', 'one@example.com'], ['gd-new', 'two@example.com']]);
  d = apply((x) => { x.guardians.reverse(); x.players.reverse(); const a = byId(x.guardians, 'gd-new'); const b = byId(x.guardians, 'gd-2'); [a.email, b.email] = [b.email, a.email]; });
  assert.deepEqual(d.guardians.map((g) => [g.id, g.email]).sort(), [['gd-2', 'two@example.com'], ['gd-new', 'one@example.com']]);
  assert.deepEqual(links(), [{ guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }, { guardian_id: 'gd-new', player_id: 'pl-minor', role: 'primary' }], 'the links are the same whatever the input order');
  // 3. A new co-guardian listed BEFORE the primary it references, the players reversed again, the adult renamed: all accepted in one write.
  d = apply((x) => { x.players.reverse(); x.guardians.unshift({ id: 'gd-co2', name: 'Co Two', email: 'co2@example.com', coGuardianOf: 'gd-new', childIds: ['pl-minor'] }); byId(x.players, 'pl-adult').name = 'Adult Renamed'; });
  assert.deepEqual(d.guardians.map((g) => g.id).sort(), ['gd-2', 'gd-co2', 'gd-new']); assert.equal(byId(d.guardians, 'gd-co2').coGuardianOf, 'gd-new'); assert.equal(byId(d.players, 'pl-adult').name, 'Adult Renamed');
  assert.deepEqual(links(), [{ guardian_id: 'gd-2', player_id: 'pl-minor', role: 'co' }, { guardian_id: 'gd-co2', player_id: 'pl-minor', role: 'co' }, { guardian_id: 'gd-new', player_id: 'pl-minor', role: 'primary' }]);
  // A round trip without changes keeps the order the tool read.
  { const snap = tool.load(); const order = snap.db.guardians.map((g) => g.id); tool.save(snap); assert.deepEqual(tool.load().db.guardians.map((g) => g.id), order, 'an unchanged snapshot keeps its order'); }
  assert.equal(otherState(), others, 'no other table or blob changed');
  // 4. Real problems stay refused, whole: a duplicate final e-mail (case-insensitive) across a retained and a new guardian, a removed guardian still referenced, a legacy minor without a link.
  const before = identityState(tool.sqlite); const seqBefore = tool.revision();
  const refuse = (label, mutate, re) => {
    const snap = tool.load(); mutate(snap.db);
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`);
    assert.equal(identityState(tool.sqlite), before, `${label}: nothing changed`);
    assert.equal(tool.revision(), seqBefore, `${label}: the save revision did not advance`);
  };
  refuse('a duplicate final e-mail (case-insensitive) between a retained and a new guardian', (x) => { x.guardians.push({ id: 'gd-dup', name: 'Dup', email: 'ONE@example.com', childIds: [] }); }, /shares its e-mail/);
  refuse('a removed guardian still referenced by a retained player', (x) => { x.guardians = x.guardians.filter((g) => g.id !== 'gd-new'); x.players.reverse(); }, /guardianId names no record \(gd-new\)/);
  refuse('a legacy minor without any guardian link (the Founder\'s decision)', (x) => { x.players.push({ id: 'pl-orphan', name: 'Orphan', dob: '2013-04-04', country: 'GB', guardianId: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } }); }, /players pl-orphan: a minor on the evaluation date with no guardian link at all .*Founder's decision/);
  // 5. A failure in the middle of the rewrite (the second player row) leaves everything as it was; the same write then succeeds.
  const change = (x) => { byId(x.players, 'pl-adult').name = 'Adult Twice'; const a = byId(x.guardians, 'gd-new'); const b = byId(x.guardians, 'gd-2'); [a.email, b.email] = [b.email, a.email]; };
  { const probe = failRunAt(tool.sqlite, (sql) => /^INSERT INTO players/.test(sql), 2, 'injected failure writing the second player row');
    try { const snap = tool.load(); change(snap.db); assert.throws(() => tool.save(snap), /injected failure writing the second player row/); } finally { probe.restore(); }
    assert.equal(probe.fired, 1, 'the injected failure happened');
    assert.equal(tool.sqlite.isTransaction, false); assert.equal(identityState(tool.sqlite), before, 'mid-rewrite failure: every row, link and facet as before'); assert.equal(otherState(), others); assert.equal(tool.revision(), seqBefore); }
  // 6. A failure of the REAL COMMIT: a deferred foreign-key violation planted inside the transaction makes SQLite refuse the COMMIT statement itself.
  { const exec = tool.sqlite.exec.bind(tool.sqlite); let fired = 0;
    tool.sqlite.exec = (sql) => { if (sql === 'COMMIT' && !fired) { fired += 1; exec('PRAGMA defer_foreign_keys = ON'); exec('CREATE TABLE fault_parent (id TEXT PRIMARY KEY); CREATE TABLE fault_child (parent_id TEXT NOT NULL REFERENCES fault_parent(id))'); tool.sqlite.prepare('INSERT INTO fault_child (parent_id) VALUES (?)').run('missing'); } return exec(sql); };
    try { const snap = tool.load(); change(snap.db); assert.throws(() => tool.save(snap), /FOREIGN KEY constraint failed/); } finally { tool.sqlite.exec = exec; }
    assert.equal(fired, 1, 'the COMMIT statement was the one that failed');
    assert.equal(tool.sqlite.isTransaction, false); assert.equal(identityState(tool.sqlite), before, 'COMMIT failure: every row, link and facet as before'); assert.equal(otherState(), others); assert.equal(tool.revision(), seqBefore);
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'fault_%'").get().n, 0, 'the rollback took the planted tables with it'); }
  d = apply(change);
  assert.equal(byId(d.players, 'pl-adult').name, 'Adult Twice'); assert.deepEqual(d.guardians.map((g) => [g.id, g.email]).sort(), [['gd-2', 'one@example.com'], ['gd-co2', 'co2@example.com'], ['gd-new', 'two@example.com']], 'the retry lands the whole replacement');
  assert.equal(tool.revision(), seqBefore + 1);
  tool.sqlite.close();
  // The server attaches to exactly that.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { ...again.load().db, players: [], guardians: [] };
  const layer = attachDataLayer({ db: db2, store: again, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 3, links: 3, imported: 0 });
  assert.equal(db2.players.find((p) => p.id === 'pl-minor').guardianId, 'gd-new'); assert.deepEqual([...db2.guardians.find((g) => g.id === 'gd-new').childIds], ['pl-minor']);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('identity snapshot: before the cutover record exists (a pre-S4 file read by a tool) the blobs are authoritative and the tables are ignored; the store contract lists every live collection', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => !/^00(0[56789]|10)_/.test(m.id))); // S6a: 0008 needs 0005 too; S7a: 0009 needs 0008; S7b: 0010 needs 0009
  assert.equal(IDENTITY_SNAPSHOT.read(s), null, 'nothing to read from the tables before the cutover');
  assert.equal(transaction(s, () => IDENTITY_SNAPSHOT.replace(s, { players: [PLAYER_ADULT()], guardians: [] }, { now: NOW })), false, 'nothing is written to the tables before the cutover (the caller writes the blob)');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  assert.equal(IDENTITY_SNAPSHOT.replace(s, { players: [], guardians: [] }), false, 'before the cutover the answer is false even outside a transaction (nothing is touched)');
  // After the cutover (here: a first installation, nothing saved) the dispatcher writes only inside the caller's transaction.
  runDataMigrations(s, DATA_MIGRATIONS, { now: NOW });
  assert.throws(() => IDENTITY_SNAPSHOT.replace(s, { players: [], guardians: [] }, { now: NOW }), /replace\(\) runs inside the caller's transaction/);
  assert.deepEqual(IDENTITY_SNAPSHOT.read(s), { guardians: [], players: [] });
  s.close();
  assert.deepEqual([...TABLE_BACKED], ['orgs', 'players', 'guardians', 'users', 'sessions', 'mediaDeletions', 'emailChallenges', 'pairingCodes', 'notifications', 'notificationPrefs', 'dispatches']);
  assert.deepEqual([...IDENTITY_SNAPSHOT.names], ['players', 'guardians']);
});

console.log(`\n${passed} core-schema checks passed`);
