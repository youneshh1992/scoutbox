// The player and guardian repositories (repositories/identity.mjs), exercised
// on temporary databases through the real data layer (attachDataLayer runs the
// registered migrations, 0005 included, and attaches the repositories as the
// store's unit-of-work participant) and, for the authority checks, on raw
// connections prepared by scripts/identityLiveTestSchema.mjs. Nothing here
// touches DATA_DIR. Synthetic records only; the clock is fixed where age
// matters. Run with: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION, MINOR_WITHOUT_LINK_REASON } from '../repositories/identityPreflight.mjs';
import { prepareLiveIdentitySchema } from './identityLiveTestSchema.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const TTL = 30 * DAY;
const NOW = Date.UTC(2026, 9, 11, 12); // 2026-10-11T12:00Z, fixed wherever age matters
const T0 = NOW - 100 * DAY;
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sameShape = (a, b, what) => { assert.deepEqual(Object.keys(b), Object.keys(a), `${what}: key order`); assert.equal(JSON.stringify(b), JSON.stringify(a), `${what}: byte-identical JSON`); };
const squadMember = (id) => ({ id, name: id, position: 'ST', playerId: null, source: 'manual', addedAt: 1 });

// ------------------------------------------------------------------ fixtures (the shapes the application writes today)
const adult = () => ({
  id: 'pl-adult', name: 'Adult Signup', dob: '2001-05-20', country: 'GB', city: 'Leeds', position: 'ST', foot: 'right', heightCm: 182, weightKg: 77,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], guardianId: null, squadNumber: null, contractUntil: null,
  marketValueRange: null, agentName: null, createdAt: T0, password: 'scrypt$aa$bb', level: 'amateur', location: { lat: 53.8, lng: -1.5 },
  medical: { shared: false, records: [], conditionStatus: 'unknown' }, notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
const child = (id, guardianId, dob) => ({
  id, name: `Child ${id}`, dob, country: 'GB', city: '', guardianId, position: null, foot: null, heightCm: null, weightKg: null,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], squadNumber: null, contractUntil: null, marketValueRange: null,
  agentName: null, createdAt: T0 + DAY, password: null, level: 'amateur', location: null, medical: { shared: false, records: [], conditionStatus: 'unknown' },
  notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
/** A seeded adult with every S5 array, split composites with remainders, prototype-named own keys (built from JSON, as a snapshot arrives). */
const seeded = () => JSON.parse(JSON.stringify({
  id: 'pl-seeded', name: 'Seeded Adult', dob: '2004-03-14', country: 'GB', city: 'Manchester', position: 'ST', foot: 'right', heightCm: 184, weightKg: 79,
  badges: ['Finisher'], attendance: [{ id: 'att-1', fixture: 'Cup Final', venue: 'Hough End', date: '2026-06-01', gps: { lat: 53.43, lng: -2.26 }, verified: true }],
  timeline: [{ year: '2019', event: 'Joined academy' }], media: [{ id: 'med-1', title: 'Highlights', kind: 'video', uploadedAt: '2026-05-01T10:00:00.000Z', url: null, views: 3, tags: { pace: 2 }, verifiedClip: null }],
  trialReports: [], medical: { shared: true, records: [{ id: 'md-1', type: 'injury', title: 'Hamstring', date: '2025-11-02', layoffWeeks: 3, cleared: true }], conditionStatus: 'fully_fit' },
  identityVerified: true, academyPlus: true, guardianId: null, squadNumber: 22, contractUntil: '2026-06-30', marketValueRange: '€250K – €450K', agentName: 'Team Elevate',
  availability: 'available_now', contractStatus: 'expiring_summer', drills: ['drill-sprint'], drillResults: [{ id: 'dr-1', drillId: 'drill-sprint', metric: 'time', unit: 's', value: 4.2, verified: false, ts: T0 }],
  activityLog: [T0], createdAt: null, password: null, level: 'semi_pro', location: { lat: 53.483, lng: -2.244 }, seasonHistory: [{ season: '2024/25', appearances: 27, goals: 14, assists: 4 }],
  stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 }, notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: null, timezone: 'Europe/London' },
  programme: { track: 'ST', startedAt: T0, completed: [{ sessionId: 's1', ts: T0 + DAY }] }, firstTeamSeeker: true, futureField: { nested: [1, 2] },
}).replace('"futureField"', '"constructor":"own-constructor","toString":"own-toString","__proto__":{"polluted":true},"futureField"'));
const gPrimary = () => ({
  id: 'gd-primary', name: 'Primary Parent', email: 'primary@example.test', password: null, emailVerified: true, emailCode: null, idVerified: true, idvReference: 'idv-1',
  disclaimerAccepted: true, childIds: ['pl-child1', 'pl-child2'], coGuardians: [{ id: 'gd-co', name: 'Co Parent', email: 'co@example.test' }],
  notificationPrefs: { quietStart: '20:00', quietEnd: '06:30', schoolHoursMute: true, timezone: 'Europe/London' }, createdAt: T0,
});
const gCo = () => ({ id: 'gd-co', name: 'Co Parent', email: 'co@example.test', idVerified: false, disclaimerAccepted: false, childIds: ['pl-child1', 'pl-child2'], coGuardianOf: 'gd-primary' });
const gSignup = () => ({ id: 'gd-signup', name: 'Signup Parent', email: 'signup@example.test', password: 'scrypt$cc$dd', emailVerified: false, emailCode: 'K7Q2ZP', idVerified: false, disclaimerAccepted: false, childIds: [] });
const FIXTURE = () => ({ players: [adult(), child('pl-child1', 'gd-primary', '2014-03-03'), seeded(), child('pl-child2', 'gd-primary', '2016-08-08')], guardians: [gPrimary(), gCo(), gSignup()] });
const ORGS = () => [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', squad: [] }];
const baseDb = (players, guardians) => ({ orgs: ORGS(), users: [{ id: 'usr-1', orgId: 'org-pro', name: 'Maria', role: 'Head of Recruitment', createdAt: 1 }], sessions: [], players, guardians, requests: [{ id: 'req-1', status: 'pending', history: [] }] });

/**
 * A store in server mode on a NEW directory with the data layer attached the way
 * the server attaches it: the registered migrations run (0005 finds nothing saved:
 * a first installation, initialisation pending), the identity repositories
 * initialise from the fixture once and become the store's unit-of-work participant.
 */
function boot(dir, { players = [], guardians = [], warnings = [] } = {}) {
  const db = baseDb(clone(players), clone(guardians));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  return wire({ store, layer, identity: layer.identity, db, bootResult: layer.boot.identity, warnings });
}
/** Reopen an existing directory the way a restart would: load, attach the data layer (the repositories attach to the tables; the arrays in memory are never imported). */
function reopen(dir, { stalePlayers = null, staleGuardians = null, warnings = [] } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: stalePlayers ?? [], guardians: staleGuardians ?? [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  return wire({ store, layer, identity: layer.identity, db, bootResult: layer.boot.identity, warnings });
}
function wire({ store, layer, identity, db, bootResult, warnings }) {
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  store.save(snapshot());
  const raw = (sql, ...p) => store.sqlite.prepare(sql).get(...p);
  const all = (sql, ...p) => store.sqlite.prepare(sql).all(...p);
  const blob = (name) => { const r = raw('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : undefined; };
  const facets = (table, id) => JSON.parse(raw(`SELECT facets_json FROM ${table} WHERE id = ?`, id).facets_json);
  const links = () => all('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid').map((l) => ({ guardian_id: l.guardian_id, player_id: l.player_id, role: l.role }));
  // The invariant: players.guardian_id and the primary row agree, and there is at most one primary per player.
  const invariantBreaks = () => raw(`SELECT COUNT(*) AS n FROM players p LEFT JOIN guardian_children l ON l.player_id = p.id AND l.role = 'primary'
    WHERE (p.guardian_id IS NULL) <> (l.guardian_id IS NULL) OR (p.guardian_id IS NOT NULL AND l.guardian_id <> p.guardian_id)`).n
    + raw("SELECT COUNT(*) AS n FROM (SELECT player_id FROM guardian_children WHERE role = 'primary' GROUP BY player_id HAVING COUNT(*) > 1)").n
    + store.sqlite.prepare('PRAGMA foreign_key_check').all().length;
  return { store, layer, identity, players: identity.players, guardians: identity.guardians, db, snapshot, raw, all, blob, facets, links, invariantBreaks, bootResult, warnings,
    unit: (fn) => store.unitOfWork(fn, { snapshot }), close: () => store.sqlite.close() };
}
// An S3-shaped in-memory database (migrations 0001–0004: the identity tables are the S1 shadow), for the authority checks.
const freshShadowDb = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id))); return s; };

// ------------------------------------------------------------------ authority and initialisation
test('authority: the repositories attach only behind the cutover record, refuse the S1 shadow tables even with the record, never load at construction, and initialisation is explicit state — pending initialises once and atomically, done attaches and never imports', () => {
  const s = freshShadowDb();
  assert.throws(() => createIdentityRepositories({ sqlite: s }), /cutover record 0005_core_identity_live is missing/);
  s.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)').run(CORE_IDENTITY_LIVE_MIGRATION, NOW);
  assert.throws(() => createIdentityRepositories({ sqlite: s }), /S1 shadow definition \(no facets_json column\)/, 'the record alone is not enough: the tables are the shadow');
  prepareLiveIdentitySchema(s, { initState: 'pending', now: NOW });
  const warnings = [];
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.equal(identity.initState(), 'pending'); assert.equal(identity.players.count(), 0, 'construction loads nothing');
  assert.throws(() => identity.attach(FIXTURE().players, FIXTURE().guardians), /initialisation is pending/, 'attach() is not how a first installation starts');
  // The Founder's rule: a legacy minor without any guardian link refuses the whole initialisation; nothing is written; the state stays pending.
  const blocked = FIXTURE(); blocked.players.push(child('pl-legacy', null, '2013-04-04'));
  let err = null; try { identity.initialize(blocked, { now: NOW }); } catch (e) { err = e; }
  assert.equal(err.code, 'CORE_IDENTITY_CUTOVER_BLOCKED'); assert.match(err.message, /players pl-legacy: a minor on the evaluation date with no guardian link/); assert.match(err.message, /legacy minors without any guardian link .*: pl-legacy/);
  assert.equal(err.message.includes('2013-04-04'), false, 'ids, not records'); assert.equal(err.report.legacyMinorsWithoutLink[0], 'pl-legacy');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 0, 'nothing written');
  assert.equal(identity.initState(), 'pending'); assert.equal(identity.players.count(), 0);
  // A malformed batch (duplicate id, dangling guardianId, duplicate e-mail) is refused whole: no partial write.
  const malformed = FIXTURE(); malformed.players.push({ ...adult(), id: 'pl-adult' }); malformed.players.push(child('pl-dangling', 'gd-nobody', '2015-01-01')); malformed.guardians.push({ ...gSignup(), id: 'gd-dup', email: 'PRIMARY@example.test' });
  assert.throws(() => identity.initialize(malformed, { now: NOW }), /CORE_IDENTITY_CUTOVER_BLOCKED/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0); assert.equal(identity.initState(), 'pending');
  // The consistent fixture initialises once, atomically with the state change.
  const r = identity.initialize(FIXTURE(), { now: NOW });
  assert.deepEqual({ players: r.players, guardians: r.guardians, links: r.links }, { players: 4, guardians: 3, links: 4 });
  assert.equal(identity.initState(), 'done'); assert.equal(identity.players.count(), 4); assert.equal(identity.guardians.count(), 3);
  assert.throws(() => identity.initialize(FIXTURE(), { now: NOW }), /already initialised/);
  // Attaching again (a restart) never imports: a stale array naming unknown records is reported and ignored.
  const again = createIdentityRepositories({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  again.attach([...FIXTURE().players, { ...adult(), id: 'pl-stale' }], [{ ...gSignup(), id: 'gd-stale', email: 'stale@example.test' }]);
  assert.equal(again.players.count(), 4); assert.equal(again.guardians.count(), 3);
  assert.ok(warnings.some((w) => /players table holds 4 row\(s\).*1 record\(s\) the table does not hold was ignored/.test(w)), JSON.stringify(warnings));
  s.close();
  // An intentionally empty authoritative domain stays empty: pending + empty initialisation → done; later attaches with stale arrays import nothing.
  const e = freshShadowDb(); prepareLiveIdentitySchema(e, { initState: 'pending', now: NOW });
  const empty = createIdentityRepositories({ sqlite: e, now: () => NOW });
  assert.deepEqual((({ players, guardians, links }) => ({ players, guardians, links }))(empty.initialize({ players: [], guardians: [] }, { now: NOW })), { players: 0, guardians: 0, links: 0 });
  assert.equal(empty.initState(), 'done');
  const later = createIdentityRepositories({ sqlite: e, now: () => NOW, warn: () => {} });
  later.attach(FIXTURE().players, FIXTURE().guardians);
  assert.equal(later.players.count(), 0); assert.equal(later.guardians.count(), 0); assert.equal(e.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  e.close();
});

// ------------------------------------------------------------------ persistence and shapes
test('persistence: every creation shape — adult signup, guardian-created children, a seeded adult with every S5 array and prototype-named own keys, a guardian with an outstanding e-mail code, a co-guardian without password — is byte-identical through initialisation, save and a fresh attach after reopening; childIds keep their order; the code is plain, once, in the facets', () => {
  const dir = tempDir('idrepo-persist');
  const t = boot(dir, { ...FIXTURE() });
  assert.equal(t.invariantBreaks(), 0);
  assert.equal(t.facets('guardians', 'gd-signup').emailCode, 'K7Q2ZP'); assert.equal(t.raw("SELECT email_code_hash FROM guardians WHERE id = 'gd-signup'").email_code_hash, null);
  assert.equal(t.raw("SELECT facets_json FROM guardians WHERE id = 'gd-signup'").facets_json.split('K7Q2ZP').length - 1, 1, 'exactly one copy');
  t.close();
  const r = reopen(dir);
  const want = FIXTURE();
  for (const p of want.players) sameShape(p, r.players.byId(p.id), `player ${p.id} after reopen`);
  for (const g of want.guardians) sameShape(g, r.guardians.byId(g.id), `guardian ${g.id} after reopen`);
  assert.deepEqual([...r.guardians.byId('gd-primary').childIds], ['pl-child1', 'pl-child2'], 'order from the link rows');
  assert.deepEqual(r.links(), [{ guardian_id: 'gd-primary', player_id: 'pl-child1', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-child2', role: 'primary' }, { guardian_id: 'gd-co', player_id: 'pl-child1', role: 'co' }, { guardian_id: 'gd-co', player_id: 'pl-child2', role: 'co' }]);
  const s = r.players.byId('pl-seeded');
  assert.ok(Object.hasOwn(s, 'constructor') && Object.hasOwn(s, 'toString') && Object.hasOwn(s, '__proto__')); assert.equal(s.constructor, 'own-constructor'); assert.equal('polluted' in {}, false);
  assert.equal(r.db.players.length, 4); assert.equal(r.db.guardians.length, 3); assert.equal(r.bootResult.imported, 0);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ guards
test('guards: the views refuse writes to the collections, to column-backed fields (nested location/stats/prefs, medical.shared/conditionStatus, programme.track/startedAt), to childIds and (S5) to every sub-record array and its items, while emailCode, unknown and prototype-named facet keys stay writable in place and are flushed by the next save; the arrays change only through addItem', () => {
  const dir = tempDir('idrepo-guards');
  const t = boot(dir, { ...FIXTURE() });
  const p = t.players.byId('pl-seeded'); const g = t.guardians.byId('gd-primary'); const sg = t.guardians.byId('gd-signup');
  const refused = /identity repositories|domain repository/;
  assert.throws(() => { t.db.players.push({}); }, refused); assert.throws(() => { t.db.guardians[0] = {}; }, refused); assert.throws(() => { t.db.players.length = 0; }, refused);
  for (const fn of [() => { p.name = 'x'; }, () => { p.dob = '2000-01-01'; }, () => { p.guardianId = 'gd-primary'; }, () => { delete p.country; }, () => { p.location.lat = 1; }, () => { p.stats.goals = 99; }, () => { p.notificationPrefs.timezone = 'UTC'; }, () => { p.medical.shared = false; }, () => { p.medical.conditionStatus = 'injured'; }, () => { delete p.medical.shared; }, () => { p.programme.track = 'GK'; }, () => { p.programme.startedAt = 1; }, () => { p.__meta = {}; }]) assert.throws(fn, refused);
  // S5: the arrays and their items are rows of the player_* tables, served read-only.
  for (const fn of [() => { p.badges.push('x'); }, () => { p.badges = []; }, () => { p.media[0].views = 9; }, () => { p.media[0].tags.pace = 3; }, () => { p.attendance.length = 0; }, () => { p.medical.records.push({}); }, () => { p.medical.records = []; }, () => { p.programme.completed.pop(); }, () => { delete p.drills; }, () => { p.trialReports.push({}); }, () => { p.trialReports = []; }]) assert.throws(fn, refused);
  for (const fn of [() => { g.childIds.push('pl-x'); }, () => { g.childIds = []; }, () => { g.childIds.length = 0; }, () => { g.email = 'x@example.test'; }, () => { g.notificationPrefs.quietStart = '1'; }, () => { g.coGuardianOf = 'gd-co'; }]) assert.throws(fn, refused);
  // Sub-records go through the repository (rows at once); facet writes (unknown keys) work in place and persist through the save hook.
  t.players.addItem('pl-seeded', 'medical.records', { id: 'md-new', type: 'clearance', title: 'ok', date: '2026-10-01', cleared: true });
  t.players.addItem('pl-seeded', 'programme.completed', { sessionId: 's2', ts: NOW });
  t.players.addItem('pl-seeded', 'badges', 'Captain'); p.unknownBag = { a: 1 }; p.constructor = 'changed';
  sg.emailCode = null; sg.someFutureField = true; g.coGuardians.push({ id: 'gd-x', name: 'X', email: 'x@example.test' });
  assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 3);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM player_medical_records WHERE player_id = 'pl-seeded'").n, 2, 'the row is committed at once'); assert.equal(t.facets('players', 'pl-seeded').medical, undefined, 'no array in the facets');
  assert.equal(t.facets('players', 'pl-seeded').unknownBag, undefined, 'not yet flushed');
  t.store.save(t.snapshot());
  assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 0);
  assert.deepEqual(t.facets('players', 'pl-seeded').unknownBag, { a: 1 }); assert.equal(t.facets('players', 'pl-seeded').constructor, 'changed'); assert.equal(t.facets('guardians', 'gd-signup').emailCode, null);
  assert.equal(t.raw("SELECT medical_shared FROM players WHERE id = 'pl-seeded'").medical_shared, 1, 'the column-backed sub-key is untouched by facet writes');
  t.close();
  const r = reopen(dir);
  const p2 = r.players.byId('pl-seeded');
  assert.equal(p2.medical.records.length, 2); assert.equal(p2.programme.completed.length, 2); assert.deepEqual([...p2.badges], ['Finisher', 'Captain']); assert.deepEqual(p2.unknownBag, { a: 1 }); assert.equal(p2.constructor, 'changed');
  assert.equal(r.guardians.byId('gd-signup').emailCode, null); assert.equal(r.guardians.byId('gd-signup').someFutureField, true); assert.equal(r.guardians.byId('gd-primary').coGuardians.length, 2);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ updates
test('updates: players.update replaces location/stats/prefs whole and merges medical/programme sub-keys in place (held references to medical.records survive), refuses guardianId, facet sub-keys, unknown and invalid values; players.restore replaces the record content in place without touching the link; guardians.update keeps e-mails unique and coGuardianOf valid; everything persists through a reopen', () => {
  const dir = tempDir('idrepo-update');
  const t = boot(dir, { ...FIXTURE() });
  const p = t.players.byId('pl-seeded'); const records = p.medical.records; const completed = p.programme.completed;
  t.players.update('pl-seeded', { academyPlus: false, availability: 'end_of_season', location: { lat: 1.5, lng: 2.5 }, stats: { goals: 1 }, notificationPrefs: null, medical: { shared: false, conditionStatus: 'injured' }, programme: { track: 'GK' } });
  assert.equal(p.academyPlus, false); assert.equal(p.availability, 'end_of_season'); assert.deepEqual(p.location, { lat: 1.5, lng: 2.5 }); assert.deepEqual(p.stats, { goals: 1 }); assert.equal(p.notificationPrefs, null);
  assert.equal(p.medical.shared, false); assert.equal(p.medical.conditionStatus, 'injured'); assert.equal(p.medical.records, records, 'the records array keeps its identity'); assert.equal(p.programme.track, 'GK'); assert.equal(p.programme.startedAt, T0); assert.equal(p.programme.completed, completed);
  assert.equal(t.raw("SELECT medical_shared, medical_condition_status, programme_track, stats_goals, stats_assists, lat FROM players WHERE id = 'pl-seeded'").medical_condition_status, 'injured');
  assert.equal(t.raw("SELECT stats_assists FROM players WHERE id = 'pl-seeded'").stats_assists, null, 'stats replaced whole');
  for (const [patch, re] of [
    [{ guardianId: 'gd-primary' }, /guardianId changes only through link/], [{ medical: { records: [] } }, /"medical.records" is a player sub-record/], [{ programme: { completed: [] } }, /"programme.completed" is a player sub-record/],
    [{ badges: [] }, /"badges" is a player sub-record/], [{ trialReports: [] }, /derived from the trials collection/], [{ unknownBag: 1 }, /not a column-backed player field/], [{ foot: 'both' }, /foot is not one of/], [{ heightCm: 2 ** 53 }, /not a safe integer/], [{ id: 'other' }, /never changes/],
  ]) assert.throws(() => t.players.update('pl-seeded', patch), re);
  assert.equal(p.foot, 'right', 'a refused update changes nothing');
  // restore: the signing rollback's whole-record write.
  const snapshotOfSeeded = clone(p); snapshotOfSeeded.level = 'pro'; snapshotOfSeeded.badges = ['Restored']; delete snapshotOfSeeded.unknownBag;
  const held = p;
  t.players.restore('pl-seeded', snapshotOfSeeded);
  assert.equal(held.level, 'pro'); assert.deepEqual([...held.badges], ['Restored']); assert.equal(t.players.byId('pl-seeded'), held, 'same view object');
  assert.throws(() => t.players.restore('pl-seeded', { ...snapshotOfSeeded, guardianId: 'gd-primary' }), /cannot change the guardian link/);
  assert.throws(() => t.players.restore('pl-seeded', { ...snapshotOfSeeded, id: 'pl-other' }), /record of the same player/);
  // guardians.update
  t.guardians.update('gd-signup', { emailVerified: true, idvReference: 'idv-9', notificationPrefs: { timezone: 'UTC' } });
  assert.equal(t.guardians.byId('gd-signup').emailVerified, true); assert.deepEqual(t.guardians.byId('gd-signup').notificationPrefs, { timezone: 'UTC' });
  assert.throws(() => t.guardians.update('gd-signup', { email: 'PRIMARY@example.test' }), /EMAIL_IN_USE/);
  assert.throws(() => t.guardians.update('gd-signup', { coGuardianOf: 'gd-nobody' }), /does not exist/);
  assert.throws(() => t.guardians.update('gd-signup', { coGuardianOf: 'gd-signup' }), /cannot name the guardian itself/);
  assert.throws(() => t.guardians.update('gd-signup', { childIds: [] }), /childIds changes only through link/);
  t.guardians.update('gd-signup', { coGuardianOf: 'gd-primary' }); t.guardians.update('gd-signup', { coGuardianOf: null });
  assert.equal(t.raw("SELECT co_guardian_of FROM guardians WHERE id = 'gd-signup'").co_guardian_of, null);
  t.store.save(t.snapshot()); t.close();
  const r = reopen(dir);
  const p2 = r.players.byId('pl-seeded');
  assert.equal(p2.level, 'pro'); assert.equal(p2.medical.conditionStatus, 'injured'); assert.equal(p2.programme.track, 'GK'); assert.equal(p2.programme.completed.length, 1); assert.equal(p2.notificationPrefs, null);
  assert.equal(r.guardians.byId('gd-signup').emailVerified, true); assert.equal(r.invariantBreaks(), 0);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ links
test('links: a minor is created only with its primary guardian (row and link in one transaction), a second primary, a duplicate or dangling link are refused, co links keep the child order, unlink and ageUp clear both sides, remove cascades the links and every childIds entry, the invariant and foreign keys hold throughout, and a write inside a foreign transaction is refused', () => {
  const dir = tempDir('idrepo-links');
  const t = boot(dir, { ...FIXTURE() });
  const primary = t.guardians.byId('gd-primary'); const kids = primary.childIds;
  assert.throws(() => t.players.insert(child('pl-orphan', null, '2015-05-05')), /a minor and has no guardianId/);
  assert.throws(() => t.players.insert(child('pl-orphan', 'gd-nobody', '2015-05-05')), /does not exist/);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-orphan'").n, 0); assert.equal(t.players.byId('pl-orphan'), null);
  const c3 = t.players.insert(child('pl-child3', 'gd-primary', '2015-05-05'));
  assert.equal(c3.guardianId, 'gd-primary'); assert.deepEqual([...kids], ['pl-child1', 'pl-child2', 'pl-child3'], 'the held childIds array grew in place');
  assert.deepEqual(t.links().filter((l) => l.player_id === 'pl-child3'), [{ guardian_id: 'gd-primary', player_id: 'pl-child3', role: 'primary' }]);
  assert.equal(t.players.insert({ ...adult(), id: 'pl-adult2' }).guardianId, null, 'an adult needs no guardian');
  assert.throws(() => t.players.link('gd-co', 'pl-child3', 'primary'), /already has a primary guardian \(gd-primary\); a second primary is refused/);
  assert.throws(() => t.players.link('gd-primary', 'pl-child3', 'co'), /already lists player/);
  assert.throws(() => t.players.link('gd-nobody', 'pl-child3'), /guardian gd-nobody does not exist/);
  assert.throws(() => t.players.link('gd-co', 'pl-nobody'), /player pl-nobody does not exist/);
  assert.throws(() => t.players.link('gd-co', 'pl-child3', 'owner'), /"primary" or "co"/);
  t.players.link('gd-co', 'pl-child3', 'co');
  assert.deepEqual([...t.guardians.byId('gd-co').childIds], ['pl-child1', 'pl-child2', 'pl-child3']); assert.deepEqual(t.guardians.linksOf('pl-child3'), [{ guardianId: 'gd-primary', role: 'primary' }, { guardianId: 'gd-co', role: 'co' }]);
  assert.deepEqual(t.players.byGuardian('gd-primary').map((p) => p.id), ['pl-child1', 'pl-child2', 'pl-child3']);
  // unlink a co link: the player keeps its primary.
  assert.deepEqual(t.players.unlink('gd-co', 'pl-child3'), { guardianId: 'gd-co', playerId: 'pl-child3', role: 'co' });
  assert.equal(t.players.byId('pl-child3').guardianId, 'gd-primary'); assert.throws(() => t.players.unlink('gd-co', 'pl-child3'), /does not list player/);
  // ageUp: today's behaviour — the primary link goes and guardianId is null; co-guardians keep listing the child.
  assert.throws(() => t.players.ageUp('pl-adult'), /no primary guardian/);
  assert.deepEqual(t.players.ageUp('pl-child1'), { playerId: 'pl-child1', guardianId: 'gd-primary' });
  assert.equal(t.players.byId('pl-child1').guardianId, null); assert.deepEqual([...kids], ['pl-child2', 'pl-child3']); assert.deepEqual([...t.guardians.byId('gd-co').childIds], ['pl-child1', 'pl-child2'], 'the co-guardian still lists the player (today\'s gap, preserved)');
  assert.equal(t.raw("SELECT guardian_id FROM players WHERE id = 'pl-child1'").guardian_id, null); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-child1'").n, 1);
  // remove: today's hard delete — row gone, links cascaded, every guardian stops listing the id.
  assert.equal(t.players.remove('pl-child2'), true);
  assert.equal(t.players.byId('pl-child2'), null); assert.equal(t.db.players.some((p) => p.id === 'pl-child2'), false); assert.deepEqual([...kids], ['pl-child3']); assert.deepEqual([...t.guardians.byId('gd-co').childIds], ['pl-child1']);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-child2'").n, 0); assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-child2'").n, 0);
  assert.throws(() => t.players.remove('pl-child2'), /does not exist/);
  assert.equal(t.invariantBreaks(), 0);
  // A foreign open transaction refuses every write (its bookkeeping could not follow a foreign rollback).
  t.store.sqlite.exec('BEGIN');
  assert.throws(() => t.players.insert({ ...adult(), id: 'pl-foreign' }), /cannot run inside an open transaction/);
  assert.throws(() => t.players.link('gd-co', 'pl-child3'), /cannot run inside an open transaction/);
  assert.throws(() => t.guardians.update('gd-co', { name: 'X' }), /cannot run inside an open transaction/);
  t.store.sqlite.exec('ROLLBACK');
  t.store.save(t.snapshot()); t.close();
  const r = reopen(dir);
  assert.deepEqual([...r.guardians.byId('gd-primary').childIds], ['pl-child3']); assert.equal(r.players.byId('pl-child1').guardianId, null); assert.equal(r.players.byId('pl-child2'), null); assert.equal(r.invariantBreaks(), 0);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('guardians: a duplicate e-mail (compared case-insensitively) is refused on insert and update, a co-guardian created with the primary\'s childIds gets co links in the same transaction, coGuardianOf must name an existing other guardian, and lookups are case-insensitive', () => {
  const dir = tempDir('idrepo-guardians');
  const t = boot(dir, { ...FIXTURE() });
  assert.throws(() => t.guardians.insert({ ...gSignup(), id: 'gd-dup', email: 'Primary@Example.TEST' }), /EMAIL_IN_USE: another guardian \(gd-primary\)/);
  assert.equal(t.guardians.count(), 3); assert.equal(t.raw('SELECT COUNT(*) AS n FROM guardians').n, 3);
  assert.throws(() => t.guardians.insert({ ...gSignup(), id: 'gd-x', email: 'x@example.test', coGuardianOf: 'gd-nobody' }), /does not exist/);
  assert.throws(() => t.guardians.insert({ ...gSignup(), id: 'gd-x', email: 'x@example.test', coGuardianOf: 'gd-x' }), /cannot name the guardian itself/);
  assert.throws(() => t.guardians.insert({ ...gSignup(), id: 'gd-x', email: 'x@example.test', childIds: ['pl-nobody'] }), /childIds names player pl-nobody/);
  assert.throws(() => t.guardians.insert({ ...gSignup(), id: 'gd-x', email: 'x@example.test', childIds: ['pl-child1', 'pl-child1'] }), /more than once/);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardians WHERE id = 'gd-x'").n, 0, 'nothing of a refused insert');
  const co2 = t.guardians.insert({ id: 'gd-co2', name: 'Second Co', email: 'co2@example.test', idVerified: false, disclaimerAccepted: false, childIds: [...t.guardians.byId('gd-primary').childIds], coGuardianOf: 'gd-primary' });
  assert.deepEqual([...co2.childIds], ['pl-child1', 'pl-child2']); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE guardian_id = 'gd-co2' AND role = 'co'").n, 2);
  assert.equal(t.players.byId('pl-child1').guardianId, 'gd-primary', 'the primary did not change');
  assert.equal(t.guardians.byEmail('SIGNUP@example.test').id, 'gd-signup'); assert.equal(t.guardians.emailTaken('co2@EXAMPLE.test'), true); assert.equal(t.guardians.emailTaken('co2@example.test', 'gd-co2'), false);
  assert.equal(t.invariantBreaks(), 0);
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the two failure contracts
test('ordinary save: a facet edit in a FAILED ordinary save stays pending (memory is the intended state) and the next ordinary save persists it — for players and guardians', () => {
  const dir = tempDir('idrepo-s3');
  const t = boot(dir, { ...FIXTURE() });
  t.players.byId('pl-adult').pendingNote = 'Pending'; t.guardians.byId('gd-primary').coGuardians.push({ id: 'gd-p', name: 'P', email: 'p@example.test' });
  t.db.requests[0].big = 1n;
  assert.throws(() => t.store.save(t.snapshot()), /BigInt/);
  assert.equal(t.facets('players', 'pl-adult').pendingNote, undefined); assert.equal(t.facets('guardians', 'gd-primary').coGuardians.length, 1);
  assert.equal(t.players.byId('pl-adult').pendingNote, 'Pending', 'memory is not undone'); assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 2);
  delete t.db.requests[0].big;
  t.store.save(t.snapshot());
  assert.equal(t.facets('players', 'pl-adult').pendingNote, 'Pending'); assert.equal(t.facets('guardians', 'gd-primary').coGuardians.length, 2); assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 0);
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/** The multi-collection operation under test: a guardian with a child (row + link), an org facet, a blob edit, a player facet edit, a player update and a session, in one real unit of work. */
function operation(t, { fail = null, afterCommit = null } = {}) {
  const seededPlayer = t.players.byId('pl-seeded');
  let token = null;
  const result = t.unit(() => {
    t.guardians.insert({ id: 'gd-new', name: 'New Parent', email: 'new@example.test', password: 'scrypt$ee$ff', emailVerified: false, emailCode: 'ABC123', idVerified: false, disclaimerAccepted: false, childIds: [] });
    t.players.insert(child('pl-new', 'gd-new', '2015-09-09'));
    t.players.link('gd-co', 'pl-new', 'co');
    t.players.update('pl-adult', { availability: 'available_now', medical: { shared: true } });
    t.players.addItem('pl-seeded', 'medical.records', { id: 'md-op', type: 'x', title: 'y' });
    t.db.orgs[0].squad.push(squadMember('sq-op'));
    t.db.requests[0].status = 'accepted'; t.db.requests[0].history.push('accepted');
    token = t.layer.sessions.create('guardian', 'gd-new').token;
    if (afterCommit) t.store.afterCommit(afterCommit);
    if (fail === 'blob') t.db.requests[0].big = 1n;
    if (fail === 'throw') throw new Error('operation failed late');
    return 'done';
  });
  return { result, token };
}
function assertOperationAbsent(t, { unrelatedSaved }) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardians WHERE id = 'gd-new'").n, 0); assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-new'").n, 0);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-new'").n, 0);
  assert.equal(t.raw("SELECT availability, medical_shared FROM players WHERE id = 'pl-adult'").availability, 'not_seeking'); assert.equal(t.raw("SELECT medical_shared FROM players WHERE id = 'pl-adult'").medical_shared, 0);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM player_medical_records WHERE player_id = 'pl-seeded'").n, 1);
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).squad.length, 0);
  assert.equal(t.blob('requests')[0].status, 'pending'); assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'guardian'").n, 0);
  // Unrelated edits made BEFORE the unit: in the database only after an ordinary save.
  assert.equal(t.facets('players', 'pl-adult').pendingNote, unrelatedSaved ? 'PreUnit' : undefined); assert.equal(t.blob('requests').length, unrelatedSaved ? 2 : 1);
  assert.equal(t.invariantBreaks(), 0);
}
function assertMemoryRestored(t, refs) {
  const { adultView, seededRecords, coKids, coKidsBefore } = refs;
  assert.equal(t.players.byId('pl-new'), null); assert.equal(t.guardians.byId('gd-new'), null); assert.equal(t.db.players.length, 4); assert.equal(t.db.guardians.length, 3);
  assert.equal(t.players.byId('pl-adult'), adultView, 'same view'); assert.equal(adultView.availability, 'not_seeking'); assert.equal(adultView.medical.shared, false);
  assert.equal(t.players.byId('pl-seeded').medical.records, seededRecords, 'same nested array'); assert.equal(seededRecords.length, 1);
  assert.equal(t.guardians.byId('gd-co').childIds, coKids, 'same childIds view'); assert.deepEqual([...coKids], coKidsBefore);
  assert.equal(t.db.orgs[0].squad.length, 0); assert.equal(t.db.requests[0].status, 'pending'); assert.equal(t.db.requests[0].history.length, 0); assert.equal(t.db.requests[0].big, undefined);
  // Pre-unit edits survive, still pending.
  assert.equal(adultView.pendingNote, 'PreUnit'); assert.equal(t.db.requests.length, 2); assert.equal(t.players.uncommitted(), 1);
}
function assertOperationPersisted(t, token) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardians WHERE id = 'gd-new'").n, 1); assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-new'").n, 1);
  assert.deepEqual(t.links().filter((l) => l.player_id === 'pl-new'), [{ guardian_id: 'gd-new', player_id: 'pl-new', role: 'primary' }, { guardian_id: 'gd-co', player_id: 'pl-new', role: 'co' }]);
  assert.equal(t.raw("SELECT availability FROM players WHERE id = 'pl-adult'").availability, 'available_now'); assert.equal(t.raw("SELECT medical_shared FROM players WHERE id = 'pl-adult'").medical_shared, 1);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM player_medical_records WHERE player_id = 'pl-seeded'").n, 2); assert.equal(t.players.byId('pl-seeded').medical.records.length, 2); assert.equal(t.facets('guardians', 'gd-new').emailCode, 'ABC123');
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).squad.length, 1);
  assert.equal(t.blob('requests')[0].status, 'accepted'); assert.ok(t.layer.sessions.byToken(token), 'the session minted inside the unit is live');
  assert.equal(t.facets('players', 'pl-adult').pendingNote, 'PreUnit', 'the pre-unit edit landed with the unit');
  assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 0); assert.equal(t.invariantBreaks(), 0);
}
const prepare = (t) => {
  const adultView = t.players.byId('pl-adult'); adultView.pendingNote = 'PreUnit'; t.db.requests.push({ id: 'req-2', status: 'pending', history: [] }); // unrelated edits, pending before the unit
  return { adultView, seededRecords: t.players.byId('pl-seeded').medical.records, coKids: t.guardians.byId('gd-co').childIds, coKidsBefore: [...t.guardians.byId('gd-co').childIds] };
};

test('unit of work (real store, both repositories, an organisation facet, a blob and a session): everything commits together in one save revision, after-commit work runs once after COMMIT', () => {
  const dir = tempDir('idrepo-uow-ok');
  const t = boot(dir, { ...FIXTURE() });
  prepare(t);
  const calls = []; const rev = t.store.revision();
  const { result, token } = operation(t, { afterCommit: () => calls.push(t.store.sqlite.isTransaction) });
  assert.equal(result, 'done'); assert.deepEqual(calls, [false]); assert.equal(t.store.revision(), rev + 1);
  assertOperationPersisted(t, token);
  assert.deepEqual([...t.guardians.byId('gd-co').childIds], ['pl-child1', 'pl-child2', 'pl-new']); assert.equal(t.players.byId('pl-new').guardianId, 'gd-new');
  t.close();
  const r = reopen(dir);
  assert.equal(r.players.byId('pl-new').guardianId, 'gd-new'); assert.deepEqual([...r.guardians.byId('gd-new').childIds], ['pl-new']); assert.equal(r.players.byId('pl-adult').medical.shared, true); assert.equal(r.invariantBreaks(), 0);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: a failure after the row and link writes (blob write) rolls the database back AND restores memory — no half-linked child or guardian, held views, nested arrays and childIds arrays keep identity and content, indexes and link views agree with the tables, unrelated pending edits survive, after-commit work never runs, an ordinary save persists no fragment, an explicit retry lands everything', () => {
  const dir = tempDir('idrepo-uow-fail');
  const t = boot(dir, { ...FIXTURE() });
  const refs = prepare(t);
  let ran = false; let err = null;
  try { operation(t, { fail: 'blob', afterCommit: () => { ran = true; } }); } catch (e) { err = e; }
  assert.match(err.message, /BigInt/); assert.equal(err.unitOfWork, 'rolled_back'); assert.equal(ran, false); assert.equal(t.store.sqlite.isTransaction, false);
  assertOperationAbsent(t, { unrelatedSaved: false }); assertMemoryRestored(t, refs);
  t.store.save(t.snapshot());
  assertOperationAbsent(t, { unrelatedSaved: true }); assert.equal(t.players.uncommitted(), 0);
  const { token } = operation(t);
  assertOperationPersisted(t, token);
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: a failure thrown by the work after every write, a failure during the facet flush and a failure at COMMIT take the same path — database untouched, memory restored, retry lands everything', () => {
  // thrown late by the work
  let dir = tempDir('idrepo-uow-throw'); let t = boot(dir, { ...FIXTURE() }); let refs = prepare(t);
  assert.throws(() => operation(t, { fail: 'throw' }), /operation failed late/);
  assertOperationAbsent(t, { unrelatedSaved: false }); assertMemoryRestored(t, refs);
  assertOperationPersisted(t, operation(t).token); t.close(); fs.rmSync(dir, { recursive: true, force: true });
  // during the facet flush: a later participant throws after the identity flush wrote its rows
  dir = tempDir('idrepo-uow-flush'); t = boot(dir, { ...FIXTURE() }); refs = prepare(t);
  let explode = true; t.store.setSaveHook({ flush() { if (explode) { explode = false; throw new Error('flush exploded'); } } });
  let err = null; try { operation(t); } catch (e) { err = e; }
  assert.match(err.message, /flush exploded/); assert.equal(err.unitOfWork, 'rolled_back');
  assertOperationAbsent(t, { unrelatedSaved: false }); assertMemoryRestored(t, refs);
  assertOperationPersisted(t, operation(t).token); t.close(); fs.rmSync(dir, { recursive: true, force: true });
  // at COMMIT
  dir = tempDir('idrepo-uow-commit'); t = boot(dir, { ...FIXTURE() }); refs = prepare(t);
  const exec = t.store.sqlite.exec.bind(t.store.sqlite); let boom = true;
  t.store.sqlite.exec = (sql) => { if (boom && sql === 'COMMIT') { boom = false; throw new Error('disk full at commit'); } return exec(sql); };
  err = null; try { operation(t); } catch (e) { err = e; }
  assert.match(err.message, /disk full at commit/); assert.equal(err.unitOfWork, 'rolled_back'); assert.equal(t.store.sqlite.isTransaction, false);
  assertOperationAbsent(t, { unrelatedSaved: false }); assertMemoryRestored(t, refs);
  assertOperationPersisted(t, operation(t).token); t.store.sqlite.exec = exec; t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: a facet changed inside a unit, written by a row update\'s intermediate value and changed back before COMMIT, is overwritten — view and table agree after commit and after rollback, for a player\'s mixed composite and for a guardian facet', () => {
  const dir = tempDir('idrepo-uow-revert');
  const t = boot(dir, { ...FIXTURE() });
  const p = t.players.byId('pl-adult'); const g = t.guardians.byId('gd-primary');
  t.unit(() => {
    p.scratch = ['tmp']; t.players.update('pl-adult', { medical: { conditionStatus: 'fit' } }); p.scratch = [];
    g.coGuardians.push({ id: 'gd-tmp', name: 'T', email: 't@example.test' }); t.guardians.update('gd-primary', { idvReference: 'idv-2' }); g.coGuardians.pop();
  });
  assert.deepEqual(p.scratch, []); assert.deepEqual(t.facets('players', 'pl-adult').scratch, [], 'the final value, not the intermediate one');
  assert.equal(t.raw("SELECT medical_condition_status FROM players WHERE id = 'pl-adult'").medical_condition_status, 'fit');
  assert.equal(g.coGuardians.length, 1); assert.equal(t.facets('guardians', 'gd-primary').coGuardians.length, 1); assert.equal(t.raw("SELECT idv_reference FROM guardians WHERE id = 'gd-primary'").idv_reference, 'idv-2');
  assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 0);
  // The same shape, then a failure: the committed values stay and memory is restored.
  assert.throws(() => t.unit(() => { p.scratch = ['x']; t.players.update('pl-adult', { medical: { conditionStatus: 'injured' } }); p.scratch = []; throw new Error('late'); }), /late/);
  assert.deepEqual(p.scratch, []); assert.equal(p.medical.conditionStatus, 'fit'); assert.equal(t.raw("SELECT medical_condition_status FROM players WHERE id = 'pl-adult'").medical_condition_status, 'fit'); assert.equal(t.players.uncommitted(), 0);
  // Nested: a joined unit that fails inside a caller that swallows the error poisons the whole unit.
  assert.throws(() => t.unit(() => { t.players.update('pl-adult', { academyPlus: true }); try { t.unit(() => { t.guardians.update('gd-primary', { name: 'Nope' }); throw new Error('inner'); }); } catch { /* swallowed */ } }), /cannot commit/);
  assert.equal(p.academyPlus, false); assert.equal(g.name, 'Primary Parent'); assert.equal(t.raw("SELECT academy_plus FROM players WHERE id = 'pl-adult'").academy_plus, 0);
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: a process killed before COMMIT leaves the pre-operation database — a restart sees no new guardian, child, link, facet or blob change', () => {
  const dir = tempDir('idrepo-crash');
  const t = boot(dir, { ...FIXTURE() }); t.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'identityCrashChild.mjs'), dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, 'SIGKILL', `the child must die by SIGKILL: status ${r.status} signal ${r.signal} ${r.stderr.slice(-400)}`); assert.match(r.stdout, /ABOUT_TO_CRASH/);
  const again = reopen(dir);
  assert.equal(again.guardians.byId('gd-crash'), null); assert.equal(again.players.byId('pl-crash'), null); assert.equal(again.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE guardian_id = 'gd-crash'").n, 0);
  assert.equal(again.players.byId('pl-adult').medical.records.length, 0); assert.equal(again.db.requests[0].status, 'pending');
  assert.equal(again.raw('PRAGMA integrity_check').integrity_check, 'ok'); assert.equal(again.invariantBreaks(), 0);
  again.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('integration: the data layer creates the identity repositories behind the registered migration 0005, players and guardians are table-backed, the test schema helper matches what 0005 leaves behind, and server.mjs reaches the repositories only through the data layer', () => {
  assert.deepEqual([...TABLE_BACKED], ['orgs', 'players', 'guardians', 'playersRetained', 'users', 'sessions', 'mediaDeletions', 'emailChallenges', 'pairingCodes', 'notifications', 'notificationPrefs', 'dispatches', 'outbox', 'pushLog', 'pushTokens', 'channels', 'blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue']);
  assert.equal(DATA_MIGRATIONS.filter((m) => m.id === CORE_IDENTITY_LIVE_MIGRATION).length, 1);
  const indexSource = fs.readFileSync(path.join(HERE, '..', 'repositories', 'index.mjs'), 'utf8');
  assert.ok(indexSource.includes('createIdentityRepositories') && indexSource.includes('0005_core_identity_live'), 'repositories/index.mjs creates them and registers the migration');
  const serverSource = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8');
  assert.equal(serverSource.includes('createIdentityRepositories') || serverSource.includes('identityLiveTestSchema'), false, 'server.mjs takes the repositories from the data layer and never reaches the test helper');
  assert.ok(/const \{[^}]*players, guardians, identity[^}]*\} = dataLayer;/.test(serverSource), 'server.mjs destructures players, guardians and identity from the data layer');
  // The test helper (used by the raw-connection checks above) leaves the same schema as the real migration on a first installation.
  const real = new DatabaseSync(':memory:'); real.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(real, DATA_MIGRATIONS, { now: NOW });
  const helper = freshShadowDb(); prepareLiveIdentitySchema(helper, { initState: 'pending', now: NOW });
  for (const t of ['guardians', 'players', 'guardian_children']) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(helper), cols(real), `${t}: the helper's columns are the migration's`);
  }
  assert.equal(real.prepare('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META).value, 'pending', 'a first installation is pending until the data layer initialises it');
  assert.equal(helper.prepare('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META).value, 'pending');
  real.close(); helper.close();
  assert.equal(CORE_IDENTITY_INIT_META, 'coreIdentityInit'); assert.match(MINOR_WITHOUT_LINK_REASON, /Founder's decision/);
});

// ------------------------------------------------------------------ review corrections (independent review of e4a7c53)
/** Patch `exec` so the NEXT COMMIT fails once; returns a probe that says whether the failure really happened. */
function failNextCommit(t) {
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  const probe = { injected: false, restore: () => { t.store.sqlite.exec = exec; } };
  t.store.sqlite.exec = (sql) => { if (sql === 'COMMIT' && !probe.injected) { probe.injected = true; throw new Error('injected COMMIT failure'); } return exec(sql); };
  return probe;
}
/** Run a standalone operation whose COMMIT fails; assert the failure occurred and was reported. */
function standaloneCommitFails(t, fn) {
  const probe = failNextCommit(t);
  let err = null;
  try { fn(); } catch (e) { err = e; } finally { probe.restore(); }
  assert.ok(probe.injected, 'the COMMIT failure must actually have been injected');
  assert.match(String(err?.message), /injected COMMIT failure/, 'the operation reports the failure');
  assert.equal(t.store.sqlite.isTransaction, false);
}

test('review 1: a standalone operation whose COMMIT fails restores repository memory as well as SQL — update, insert with link, remove, link, ageUp, guardians.insert and guardians.update leave held views, nested arrays, childIds, indexes, counts and facet tracking as before; a pending facet edit made earlier stays pending, a later ordinary save persists no fragment, an explicit retry succeeds and a reopen agrees', () => {
  const dir = tempDir('idrepo-standalone-commit');
  const t = boot(dir, { ...FIXTURE() });
  const adultView = t.players.byId('pl-adult'); const seededView = t.players.byId('pl-seeded'); const primary = t.guardians.byId('gd-primary'); const kids = primary.childIds; const co = t.guardians.byId('gd-co'); const coKids = co.childIds;
  adultView.pendingNote = 'PendingBefore'; // an unrelated facet edit, pending before every failed operation
  const records = seededView.medical.records;
  const snapshotCounts = () => ({ players: t.players.count(), guardians: t.guardians.count(), rows: t.raw('SELECT COUNT(*) AS n FROM players').n + t.raw('SELECT COUNT(*) AS n FROM guardians').n + t.raw('SELECT COUNT(*) AS n FROM guardian_children').n, uncommitted: t.players.uncommitted() + t.guardians.uncommitted() });
  const before = snapshotCounts();
  assert.equal(before.uncommitted, 1);
  // update (a scalar and a split composite)
  standaloneCommitFails(t, () => t.players.update('pl-seeded', { name: 'After', medical: { shared: false } }));
  assert.equal(seededView.name, 'Seeded Adult'); assert.equal(seededView.medical.shared, true); assert.equal(seededView.medical.records, records); assert.equal(t.raw("SELECT name FROM players WHERE id = 'pl-seeded'").name, 'Seeded Adult');
  // insert with a primary link
  standaloneCommitFails(t, () => t.players.insert(child('pl-new', 'gd-primary', '2015-05-05')));
  assert.equal(t.players.byId('pl-new'), null); assert.equal(t.db.players.some((p) => p.id === 'pl-new'), false); assert.equal(primary.childIds, kids); assert.deepEqual([...kids], ['pl-child1', 'pl-child2']);
  // remove
  standaloneCommitFails(t, () => t.players.remove('pl-child1'));
  assert.ok(t.players.byId('pl-child1')); assert.deepEqual([...kids], ['pl-child1', 'pl-child2']); assert.deepEqual([...coKids], ['pl-child1', 'pl-child2']); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-child1'").n, 2);
  // link (co) and ageUp (primary unlink)
  standaloneCommitFails(t, () => t.players.link('gd-signup', 'pl-child1', 'co'));
  assert.deepEqual([...t.guardians.byId('gd-signup').childIds], []); assert.deepEqual(t.guardians.linksOf('pl-child1'), [{ guardianId: 'gd-primary', role: 'primary' }, { guardianId: 'gd-co', role: 'co' }]);
  standaloneCommitFails(t, () => t.players.ageUp('pl-child2'));
  assert.equal(t.players.byId('pl-child2').guardianId, 'gd-primary'); assert.deepEqual([...kids], ['pl-child1', 'pl-child2']); assert.equal(t.raw("SELECT guardian_id FROM players WHERE id = 'pl-child2'").guardian_id, 'gd-primary');
  // guardians.insert (with co links) and guardians.update
  standaloneCommitFails(t, () => t.guardians.insert({ id: 'gd-new', name: 'New', email: 'new@example.test', idVerified: false, disclaimerAccepted: false, childIds: ['pl-child1'], coGuardianOf: 'gd-primary' }));
  assert.equal(t.guardians.byId('gd-new'), null); assert.equal(t.guardians.emailTaken('new@example.test'), false); assert.equal(t.db.guardians.length, 3);
  standaloneCommitFails(t, () => t.guardians.update('gd-primary', { name: 'Renamed', idvReference: 'idv-9' }));
  assert.equal(primary.name, 'Primary Parent'); assert.equal(primary.idvReference, 'idv-1'); assert.equal(t.raw("SELECT name FROM guardians WHERE id = 'gd-primary'").name, 'Primary Parent');
  assert.deepEqual(snapshotCounts(), before, 'counts, rows and facet tracking are exactly as before every failed operation');
  assert.equal(t.invariantBreaks(), 0);
  // A later ordinary save persists the earlier pending edit and nothing else.
  t.store.save(t.snapshot());
  assert.equal(t.facets('players', 'pl-adult').pendingNote, 'PendingBefore'); assert.equal(t.raw("SELECT name FROM players WHERE id = 'pl-seeded'").name, 'Seeded Adult'); assert.equal(t.players.uncommitted() + t.guardians.uncommitted(), 0);
  // Explicit retries succeed.
  t.players.update('pl-seeded', { name: 'Retry' }); t.players.insert(child('pl-new', 'gd-primary', '2015-05-05')); t.guardians.update('gd-primary', { name: 'Renamed' });
  assert.equal(seededView.name, 'Retry'); assert.deepEqual([...kids], ['pl-child1', 'pl-child2', 'pl-new']);
  t.close();
  const r = reopen(dir);
  assert.equal(r.players.byId('pl-seeded').name, 'Retry'); assert.equal(r.players.byId('pl-new').guardianId, 'gd-primary'); assert.equal(r.guardians.byId('gd-primary').name, 'Renamed'); assert.equal(r.guardians.byId('gd-new'), null); assert.equal(r.players.byId('pl-adult').pendingNote, 'PendingBefore'); assert.equal(r.invariantBreaks(), 0);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('review 2: inside a real unit, a repository operation that fails after its first SQL write poisons the unit even when the caller catches the error — the outer unit fails, nothing of it commits, after-commit work never runs, memory is restored, earlier edits survive, a later ordinary save persists no fragment and a retry succeeds; a caught VALIDATION refusal (thrown before any SQL) does not poison the unit', () => {
  const dir = tempDir('idrepo-unit-caught');
  const t = boot(dir, { ...FIXTURE() });
  const refs = prepare(t);
  const primary = t.guardians.byId('gd-primary'); const kids = primary.childIds;
  // The player row is written first, then the link row fails: a half-created child, caught by the caller.
  t.store.sqlite.exec("CREATE TRIGGER review_fail_link BEFORE INSERT ON guardian_children BEGIN SELECT RAISE(ABORT, 'injected link failure'); END;");
  let inner = null; let outer = null; let published = 0;
  try {
    t.unit(() => {
      t.db.requests[0].status = 'in-unit';
      try { t.players.insert(child('pl-half', 'gd-primary', '2015-01-01')); } catch (e) { inner = e; }
      t.store.afterCommit(() => { published += 1; });
    });
  } catch (e) { outer = e; }
  assert.match(String(inner?.message), /injected link failure/, 'the mid-operation failure must actually have occurred');
  assert.ok(outer, 'the outer unit must fail'); assert.match(outer.message, /cannot commit/); assert.equal(outer.unitOfWork, 'rolled_back'); assert.equal(published, 0);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-half'").n, 0); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-half'").n, 0); assert.equal(t.blob('requests')[0].status, 'pending');
  assert.equal(t.players.byId('pl-half'), null); assert.equal(primary.childIds, kids); assert.deepEqual([...kids], ['pl-child1', 'pl-child2']); assert.equal(t.db.requests[0].status, 'pending');
  assertMemoryRestored(t, refs);
  t.store.save(t.snapshot());
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-half'").n, 0); assert.equal(t.facets('players', 'pl-adult').pendingNote, 'PreUnit');
  t.store.sqlite.exec('DROP TRIGGER review_fail_link');
  t.unit(() => t.players.insert(child('pl-half', 'gd-primary', '2015-01-01')));
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-half'").n, 1); assert.deepEqual([...kids], ['pl-child1', 'pl-child2', 'pl-half']);
  // The guardian side: a row update that fails inside the unit, caught.
  t.store.sqlite.exec("CREATE TRIGGER review_fail_guardian BEFORE UPDATE ON guardians BEGIN SELECT RAISE(ABORT, 'injected guardian failure'); END;");
  inner = null; outer = null; published = 0;
  try { t.unit(() => { try { t.guardians.update('gd-primary', { name: 'Caught' }); } catch (e) { inner = e; } t.players.update('pl-adult', { academyPlus: true }); t.store.afterCommit(() => { published += 1; }); }); } catch (e) { outer = e; }
  assert.match(String(inner?.message), /injected guardian failure/); assert.ok(outer && /cannot commit/.test(outer.message)); assert.equal(published, 0);
  assert.equal(primary.name, 'Primary Parent'); assert.equal(t.players.byId('pl-adult').academyPlus, false); assert.equal(t.raw("SELECT academy_plus FROM players WHERE id = 'pl-adult'").academy_plus, 0);
  t.store.sqlite.exec('DROP TRIGGER review_fail_guardian');
  // After memory mutation: operations that succeeded earlier in the same unit (a child created, a guardian renamed — memory already changed) are undone when a later caught operation fails; and a relationship operation (unlink) is covered.
  t.store.sqlite.exec("CREATE TRIGGER review_fail_one BEFORE INSERT ON guardian_children WHEN NEW.player_id = 'pl-fail' BEGIN SELECT RAISE(ABORT, 'injected link failure for pl-fail'); END;");
  const coView = t.guardians.byId('gd-co'); const coKids = coView.childIds;
  inner = null; outer = null; published = 0;
  try {
    t.unit(() => {
      t.players.insert(child('pl-ok', 'gd-primary', '2016-02-02')); t.guardians.update('gd-co', { name: 'Mid-unit' }); t.players.link('gd-co', 'pl-ok', 'co');
      assert.ok(t.players.byId('pl-ok')); assert.deepEqual([...kids], ['pl-child1', 'pl-child2', 'pl-half', 'pl-ok']); assert.equal(coView.name, 'Mid-unit');
      try { t.players.insert(child('pl-fail', 'gd-primary', '2016-03-03')); } catch (e) { inner = e; }
      t.store.afterCommit(() => { published += 1; });
    });
  } catch (e) { outer = e; }
  assert.match(String(inner?.message), /injected link failure for pl-fail/); assert.ok(outer && /cannot commit/.test(outer.message)); assert.equal(published, 0);
  assert.equal(t.players.byId('pl-ok'), null); assert.equal(t.players.byId('pl-fail'), null); assert.equal(t.players.count(), 5, 'the four fixture players and pl-half'); assert.equal(primary.childIds, kids); assert.deepEqual([...kids], ['pl-child1', 'pl-child2', 'pl-half']); assert.equal(coView.childIds, coKids); assert.deepEqual([...coKids], ['pl-child1', 'pl-child2']); assert.equal(coView.name, 'Co Parent');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM players WHERE id IN ('pl-ok', 'pl-fail')").n, 0); assert.equal(t.raw("SELECT name FROM guardians WHERE id = 'gd-co'").name, 'Co Parent'); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE guardian_id = 'gd-co'").n, 2);
  t.store.sqlite.exec('DROP TRIGGER review_fail_one');
  t.store.sqlite.exec("CREATE TRIGGER review_fail_unlink BEFORE DELETE ON guardian_children BEGIN SELECT RAISE(ABORT, 'injected unlink failure'); END;");
  inner = null; outer = null; published = 0;
  try { t.unit(() => { try { t.players.unlink('gd-co', 'pl-child1'); } catch (e) { inner = e; } t.store.afterCommit(() => { published += 1; }); }); } catch (e) { outer = e; }
  assert.match(String(inner?.message), /injected unlink failure/); assert.ok(outer && /cannot commit/.test(outer.message)); assert.equal(published, 0);
  assert.deepEqual([...coKids], ['pl-child1', 'pl-child2']); assert.deepEqual(t.guardians.linksOf('pl-child1'), [{ guardianId: 'gd-primary', role: 'primary' }, { guardianId: 'gd-co', role: 'co' }]); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-child1'").n, 2);
  t.store.sqlite.exec('DROP TRIGGER review_fail_unlink');
  t.unit(() => { t.players.insert(child('pl-ok', 'gd-primary', '2016-02-02')); t.players.link('gd-co', 'pl-ok', 'co'); });
  assert.deepEqual([...coKids], ['pl-child1', 'pl-child2', 'pl-ok']); assert.equal(t.raw("SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-ok'").n, 2);
  // A validation refusal is thrown BEFORE the transactional boundary: nothing of the refused operation happened, and a caller that catches it may complete the rest of its unit.
  published = 0; let refusal = null;
  t.unit(() => { try { t.players.insert(child('pl-orphan', null, '2015-01-01')); } catch (e) { refusal = e; } t.players.update('pl-adult', { academyPlus: true }); t.store.afterCommit(() => { published += 1; }); });
  assert.match(String(refusal?.message), /a minor and has no guardianId/); assert.equal(published, 1); assert.equal(t.raw("SELECT academy_plus FROM players WHERE id = 'pl-adult'").academy_plus, 1); assert.equal(t.players.byId('pl-orphan'), null);
  assert.equal(t.invariantBreaks(), 0);
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('review 3: initialisation validates the supplied collections as given — an object, null, a string, a number or a missing collection (either domain) is refused through the preflight contract, writes nothing, leaves the state pending and the input untouched, and a corrected explicit snapshot initialises afterwards; explicitly empty arrays stay valid', () => {
  const s = freshShadowDb(); prepareLiveIdentitySchema(s, { initState: 'pending', now: NOW });
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  const rows = () => s.prepare('SELECT COUNT(*) AS n FROM players').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n;
  const cases = [
    [{ players: { id: 'not-an-array' }, guardians: [] }, /players collection is an object, not an array/],
    [{ players: null, guardians: [] }, /players collection is null, not an array/],
    [{ players: 'x', guardians: [] }, /players collection is a string, not an array/],
    [{ players: 7, guardians: [] }, /players collection is a number, not an array/],
    [{ guardians: [] }, /players collection is absent, not an array/],
    [{ players: [] }, /guardians collection is absent, not an array/],
    [{ players: [], guardians: {} }, /guardians collection is an object, not an array/],
    [{ players: [adult()], guardians: null }, /guardians collection is null, not an array/],
    [undefined, /snapshot is undefined, not an object/],
    ['snapshot', /snapshot is string, not an object/],
  ];
  for (const [input, re] of cases) {
    const before = JSON.stringify(input ?? null);
    let err = null; try { identity.initialize(input, { now: NOW }); } catch (e) { err = e; }
    assert.ok(err, `refused: ${re}`); assert.equal(err.code, 'CORE_IDENTITY_CUTOVER_BLOCKED', String(err?.message)); assert.match(err.message, re);
    assert.equal(identity.initState(), 'pending'); assert.equal(rows(), 0); assert.equal(identity.players.count(), 0);
    assert.equal(JSON.stringify(input ?? null), before, 'the input is untouched');
  }
  // The Founder's rule still holds at initialisation; explicitly empty arrays are valid; a corrected snapshot initialises.
  assert.throws(() => identity.initialize({ players: [child('pl-legacy', null, '2013-04-04')], guardians: [] }, { now: NOW }), /players pl-legacy: a minor on the evaluation date with no guardian link/);
  assert.equal(identity.initState(), 'pending'); assert.equal(rows(), 0);
  const r = identity.initialize({ players: [adult()], guardians: [] }, { now: NOW });
  assert.equal(r.players, 1); assert.equal(identity.initState(), 'done'); assert.equal(identity.players.count(), 1);
  s.close();
  const e = freshShadowDb(); prepareLiveIdentitySchema(e, { initState: 'pending', now: NOW });
  const empty = createIdentityRepositories({ sqlite: e, now: () => NOW });
  assert.equal(empty.initialize({ players: [], guardians: [] }, { now: NOW }).players, 0); assert.equal(empty.initState(), 'done');
  e.close();
});

console.log(`\n${passed} identity repository checks passed`);
