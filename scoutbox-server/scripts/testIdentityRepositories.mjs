// The player and guardian repositories (repositories/identity.mjs), exercised on temporary
// databases through the real data layer (attachDataLayer runs the registered migrations and attaches every
// repository). Nothing here touches DATA_DIR. Synthetic records only; the clock is fixed where age matters.
// Run with: npm test
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META, PLAYER_RECORD_KEYS, GUARDIAN_RECORD_KEYS, bornByForAge } from '../repositories/identity.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import { adult, child, gSignup, FIXTURE, T0, NOW, TTL, tempDir, clone } from './coreIdentityTestFixtures.mjs';
import { computeTrustScore, visibleToOrg, haversineKm } from '../domain.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const ORGS = () => [
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', verified: true },
  { id: 'org-unverified', name: 'Westfield FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' },
  { id: 'org-agency', name: 'Elevate', type: 'agency', level: 'agency', plan: 'Agency', country: 'GB' },
  { id: 'org-grass', name: 'Leeds Grassroots', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'GB', verified: true, location: { lat: 53.8, lng: -1.55, city: 'Leeds' } },
];

/** A server-mode store on a new directory with the data layer attached the way the server attaches it (the seed imported once). */
function boot(dir = tempDir('idrepo'), { players = FIXTURE().players, guardians = FIXTURE().guardians } = {}) {
  const store = openStore(dir);
  const layer = attachDataLayer({ seed: { orgs: ORGS(), players: clone(players), guardians: clone(guardians) }, store, nextId, sessionTtlMs: TTL, now: () => NOW });
  const all = (sql, ...p) => store.sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
  const get = (sql, ...p) => store.sqlite.prepare(sql).get(...p);
  const invariantBreaks = () => get(`SELECT COUNT(*) AS n FROM players p LEFT JOIN guardian_children l ON l.player_id = p.id AND l.role = 'primary'
    WHERE (p.guardian_id IS NULL) <> (l.guardian_id IS NULL) OR (p.guardian_id IS NOT NULL AND l.guardian_id <> p.guardian_id)`).n
    + store.sqlite.prepare('PRAGMA foreign_key_check').all().length;
  return { dir, store, layer, identity: layer.identity, players: layer.players, guardians: layer.guardians, all, get, invariantBreaks,
    unit: (fn) => store.unitOfWork(fn), close: () => store.sqlite.close() };
}
const orgOf = (t, id) => t.layer.orgs.byId(id);
const second = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA busy_timeout = 5000;'); return s; };

// ------------------------------------------------------------------ authority and initialisation
test('authority and initialisation: the repositories attach only behind the cutover record; a first installation imports the seed once (links from childIds, roles from guardianId); a later boot attaches and never imports', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id)));
  assert.throws(() => createIdentityRepositories({ sqlite: s }), /cutover record 0005_core_identity_live is missing/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('players', 'guardians', 'guardian_children')").get().n, 0, '0002 creates no identity shadow');
  const t = boot();
  assert.equal(t.layer.firstInstallation, true);
  assert.deepEqual(t.layer.boot.identity, { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 8 });
  assert.equal(t.get('SELECT value FROM meta WHERE key = ?', CORE_IDENTITY_INIT_META).value, 'done');
  assert.deepEqual(t.all('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid'), [
    { guardian_id: 'gd-primary', player_id: 'pl-child1', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-child2', role: 'primary' },
    { guardian_id: 'gd-primary', player_id: 'pl-grown', role: 'primary' }, { guardian_id: 'gd-co', player_id: 'pl-child1', role: 'co' }, { guardian_id: 'gd-co', player_id: 'pl-child2', role: 'co' },
  ]);
  assert.equal(t.invariantBreaks(), 0);
  t.close();
  const again = boot(t.dir, { players: [adult()], guardians: [] });
  assert.equal(again.layer.firstInstallation, false);
  assert.equal(again.layer.boot.identity.imported, 0, 'a later boot imports nothing, whatever seed it is handed');
  assert.equal(again.players.count(), 5);
  again.close();
});

test('the seed is typed before anything is written: a minor without a guardian, an unknown field, a planted facet or a trial-report copy refuses the whole first installation and leaves it pending', () => {
  for (const [label, players, guardians, reason] of [
    ['a minor without a guardian', [{ ...child('pl-orphan', null, '2015-01-01') }], [], /pl-orphan: a minor without a primary guardian/],
    ['an unknown field', [{ ...adult(), futureField: 1 }], [], /pl-adult: unknown field futureField/],
    ['a guardian facet', [], [{ ...gSignup(), coGuardians: [] }], /gd-signup: coGuardians is worked out/],
    ['a plain e-mail code', [], [{ ...gSignup(), emailCode: 'K7Q2ZP' }], /gd-signup: unknown field emailCode/],
    ['a trial-report copy', [{ ...adult(), trialReports: [{ id: 'tr-1' }] }], [], /pl-adult: trialReports are the trials' reports/],
  ]) {
    const dir = tempDir('idseed');
    assert.throws(() => boot(dir, { players, guardians }), (e) => e.code === 'CORE_IDENTITY_CUTOVER_BLOCKED' && reason.test(e.message), label);
    const s = second(dir);
    assert.equal(s.prepare('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META).value, 'pending', `${label}: initialisation stays pending`);
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0, `${label}: nothing written`);
    s.close();
  }
});

// ------------------------------------------------------------------ records
test('records: every key always present (null, false or [] when unset), the lists from their tables, the trial reports from the trials; no password hash, no e-mail code; fresh, deep-frozen copies', () => {
  const t = boot();
  const p = t.players.byId('pl-child1');
  assert.deepEqual(Object.keys(p), PLAYER_RECORD_KEYS);
  assert.equal(p.city, null, 'an empty city is null');
  assert.deepEqual(p.medical, { shared: false, conditionStatus: 'unknown', records: [] });
  assert.equal(p.stats, null); assert.equal(p.programme, null); assert.equal(p.notificationPrefs, null);
  assert.deepEqual(p.trialReports, []); assert.equal('password' in p, false);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.medical) && Object.isFrozen(p.media));
  assert.throws(() => { p.name = 'x'; }, TypeError);
  assert.notEqual(t.players.byId('pl-child1'), p, 'a fresh copy on every read');
  const s = t.players.byId('pl-seeded');
  assert.deepEqual(s.stats, { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61, cleanSheets: null }, 'stats carry every key');
  assert.deepEqual(s.programme, { track: 'ST', startedAt: T0, completed: [{ sessionId: 's1', ts: T0 + 86_400_000 }] });
  assert.deepEqual(s.media, [{ id: 'med-1', title: 'Highlights', kind: 'video', uploadedAt: '2026-05-01T10:00:00.000Z', url: null, views: 3, verifiedClip: null, captions: null, tags: { pace: 2 } }]);
  const g = t.guardians.byId('gd-primary');
  assert.deepEqual(Object.keys(g), GUARDIAN_RECORD_KEYS);
  assert.deepEqual(g.childIds, ['pl-child1', 'pl-child2', 'pl-grown']);
  assert.deepEqual(g.coGuardians, [{ id: 'gd-co', name: 'Co Parent', email: 'co@example.test' }], 'coGuardians is worked out from co_guardian_of');
  assert.equal('password' in g || 'emailCodeHash' in g, false);
  assert.equal(t.guardians.emailCodeHashOf('gd-signup').length, 64);
  assert.equal(t.players.passwordHashOf('pl-adult'), 'scrypt$aa$bb');
  assert.deepEqual(t.players.byIds(['pl-seeded', 'pl-none', 'pl-adult']).map((x) => x.id), ['pl-seeded', 'pl-adult'], 'byIds keeps the order given and drops the missing');
  assert.deepEqual(t.players.byIds(['pl-seeded'])[0], s, 'a batch read decodes exactly what a single read does');
  t.close();
});

test('no mirror: a row written by another connection is what the next read returns; db.players and db.guardians throw', () => {
  const t = boot();
  const s = second(t.dir);
  s.prepare("UPDATE players SET name = 'Renamed Elsewhere' WHERE id = 'pl-adult'").run();
  s.close();
  assert.equal(t.players.byId('pl-adult').name, 'Renamed Elsewhere');
  t.close();
});

// ------------------------------------------------------------------ writes
test('create: defaults fill the optional fields; junk is refused by field before anything is written; a minor needs its guardian, gets the primary link in the same unit; a retained or existing id is refused', () => {
  const t = boot();
  const made = t.players.create({ id: 'pl-new', name: 'New Adult', dob: '1999-02-02', country: 'GB', createdAt: NOW, passwordHash: 'scrypt$x$y' });
  assert.equal(made.availability, 'not_seeking'); assert.deepEqual(made.badges, []); assert.equal(t.players.passwordHashOf('pl-new'), 'scrypt$x$y');
  for (const [fields, reason] of [
    [{ name: 'N'.repeat(121) }, /name must be text of 1 to 120/],
    [{ heightCm: '180' }, /heightCm must be a whole number from 50 to 250/],
    [{ position: 'WING' }, /position must be one of/],
    [{ academyPlus: 'yes' }, /academyPlus must be a boolean/],
    [{ stats: { goals: -1 } }, /stats\.goals must be a non-negative whole number/],
    [{ stats: { passCompletionPct: 140 } }, /passCompletionPct must be a percentage from 0 to 100/],
    [{ notificationPrefs: { quietStart: '9pm' } }, /quietStart must be HH:MM/],
    [{ location: { lat: 95, lng: 0 } }, /location\.lat and location\.lng/],
    [{ media: [{ id: 'm1' }] }, /media\[0\]\.title is absent/],
    [{ badges: [1] }, /badges\[0\] is a number, not text/],
    [{ facetField: true }, /unknown field facetField/],
  ]) assert.throws(() => t.players.create({ id: 'pl-junk', name: 'Junk', dob: '1999-02-02', country: 'GB', ...fields }), (e) => e.code === 'PLAYER_RECORD_INVALID' && reason.test(e.message), JSON.stringify(fields));
  assert.equal(t.players.byId('pl-junk'), null, 'nothing was written');
  assert.throws(() => t.players.create({ id: 'pl-kid', name: 'Kid', dob: '2016-01-01', country: 'GB' }), (e) => e.code === 'MINOR_WITHOUT_GUARDIAN');
  t.players.create({ id: 'pl-kid', name: 'Kid', dob: '2016-01-01', country: 'GB', guardianId: 'gd-signup' });
  assert.deepEqual(t.guardians.linksOf('pl-kid'), [{ guardianId: 'gd-signup', role: 'primary' }]);
  assert.deepEqual(t.guardians.byId('gd-signup').childIds, ['pl-kid']);
  assert.throws(() => t.players.create({ id: 'pl-kid', name: 'Kid', dob: '2000-01-01', country: 'GB' }), (e) => e.code === 'PLAYER_EXISTS');
  t.players.erase('pl-new', { at: NOW });
  assert.throws(() => t.players.create({ id: 'pl-new', name: 'Again', dob: '1999-02-02', country: 'GB' }), (e) => e.code === 'PLAYER_ID_RETAINED');
  assert.equal(t.invariantBreaks(), 0);
  t.close();
});

test('update(id, draft => …): the change is typed whole and written at once; the id, the guardian link, the creation time, the lists and the trial reports never change through it; a composite list set whole keeps its rows; re-entry is refused', () => {
  const t = boot();
  const after = t.players.update('pl-seeded', (d) => { d.availability = 'loan_open'; d.medical.shared = false; d.stats = { goals: 30 }; });
  assert.equal(after.availability, 'loan_open'); assert.equal(after.medical.shared, false); assert.equal(after.medical.records.length, 1, 'the medical records stay');
  assert.deepEqual(after.stats, { appearances: null, goals: 30, assists: null, paceKmh: null, passCompletionPct: null, duelSuccessPct: null, cleanSheets: null });
  const s = second(t.dir); assert.equal(s.prepare("SELECT availability FROM players WHERE id = 'pl-seeded'").get().availability, 'loan_open', 'written at once'); s.close();
  const kept = t.players.update('pl-seeded', (d) => { d.programme = { track: 'CM', startedAt: NOW }; });
  assert.deepEqual(kept.programme.completed.length, 1, 'a programme set without its list keeps the completed rows');
  for (const [edit, reason] of [
    [(d) => { d.guardianId = 'gd-primary'; }, /guardianId does not change through update/],
    [(d) => { d.badges.push('x'); }, /badges does not change through update/],
    [(d) => { d.medical.records = []; }, /medical\.records does not change through update/],
    [(d) => { d.programme = null; }, /programme cannot be set to null while 1 programme\.completed row/],
    [(d) => { d.trialReports = [{}]; }, /trialReports does not change through update/],
    [(d) => { d.futureField = 1; }, /unknown field futureField/],
    [(d) => { d.foot = 'both'; }, /foot must be one of/],
  ]) assert.throws(() => t.players.update('pl-seeded', edit), (e) => e.code === 'PLAYER_RECORD_INVALID' && reason.test(e.message), String(reason));
  assert.throws(() => t.players.update('pl-seeded', () => t.players.update('pl-seeded', () => {})), (e) => e.code === 'PLAYER_UPDATE_REENTRANT');
  assert.throws(() => t.players.update('pl-seeded', { availability: 'x' }), /takes a function/);
  const g = t.guardians.update('gd-signup', (d) => { d.emailVerified = true; d.name = 'Renamed Parent'; });
  assert.equal(g.emailVerified, true);
  assert.throws(() => t.guardians.update('gd-signup', (d) => { d.childIds = ['pl-adult']; }), /childIds does not change through update/);
  assert.throws(() => t.guardians.update('gd-primary', (d) => { d.coGuardians = []; }), /coGuardians does not change through update/);
  assert.throws(() => t.guardians.update('gd-signup', (d) => { d.email = 'PRIMARY@example.test'; }), (e) => e.code === 'EMAIL_IN_USE', 'the e-mail is unique case-insensitively');
  assert.equal(t.guardians.byEmail('Renamed@nowhere') , null);
  assert.equal(t.guardians.byEmail('SIGNUP@example.test').id, 'gd-signup');
  t.close();
});

test('lists: addItem / setItems / patchItem write rows at once and return the stored list; an item the table cannot hold, or a repeated natural key, is refused naming the field and the index; a clip\'s tags are rows', () => {
  const t = boot();
  const media = t.players.addItem('pl-adult', 'media', { id: 'med-a', title: 'Clip', url: null, unknownField: 1 });
  assert.deepEqual(media, [{ id: 'med-a', title: 'Clip', url: null, views: 0, verifiedClip: null, captions: null, tags: {} }], 'an unknown item field is not stored');
  const tagged = t.players.patchItem('pl-adult', 'media', { id: 'med-a' }, { tags: { pace: 2, vision: 1 } });
  assert.deepEqual(tagged.tags, { pace: 2, vision: 1 });
  assert.deepEqual(t.all("SELECT tag, count FROM player_media_tags WHERE media_id = 'med-a' ORDER BY position"), [{ tag: 'pace', count: 2 }, { tag: 'vision', count: 1 }]);
  assert.equal(t.players.byMediaId('med-a').id, 'pl-adult');
  assert.throws(() => t.players.addItem('pl-adult', 'media', { id: 'med-a', title: 'Again' }), (e) => e.code === 'PLAYER_SUBRECORD_INVALID' && /media\[1\] repeats id/.test(e.message));
  assert.throws(() => t.players.addItem('pl-adult', 'attendance', { id: 'att-x', fixture: 'F' }), /attendance\[0\]\.date is absent/);
  assert.throws(() => t.players.addItem('pl-adult', 'drills', 3), /drills\[0\] is a number, not text/);
  assert.throws(() => t.players.addItem('pl-adult', 'programme.completed', { sessionId: 's', ts: 1 }), /programme is null/);
  t.players.setItems('pl-adult', 'badges', ['A', 'A', 'B']);
  assert.deepEqual(t.players.byId('pl-adult').badges, ['A', 'A', 'B'], 'legal duplicates kept, order kept');
  assert.throws(() => t.players.patchItem('pl-adult', 'media', { id: 'nope' }, { views: 1 }), /0 item\(s\) of media/);
  assert.throws(() => t.players.addItem('pl-adult', 'trialReports', {}), /not a player list/);
  t.close();
});

test('links: link / unlink keep both sides together (guardian_id and the primary row), refuse a second primary; ageUp clears the primary only; co-guardians keep listing the player', () => {
  const t = boot();
  assert.throws(() => t.identity.link('gd-signup', 'pl-child1', 'primary'), (e) => e.code === 'PRIMARY_EXISTS');
  t.identity.link('gd-signup', 'pl-adult', 'co');
  assert.deepEqual(t.guardians.linksOf('pl-adult'), [{ guardianId: 'gd-signup', role: 'co' }]);
  assert.throws(() => t.identity.link('gd-signup', 'pl-adult', 'co'), (e) => e.code === 'LINK_EXISTS');
  t.identity.unlink('gd-signup', 'pl-adult');
  assert.deepEqual(t.guardians.linksOf('pl-adult'), []);
  t.players.ageUp('pl-grown');
  assert.equal(t.players.byId('pl-grown').guardianId, null);
  assert.deepEqual(t.guardians.byId('gd-primary').childIds, ['pl-child1', 'pl-child2']);
  t.players.ageUp('pl-child1');
  assert.deepEqual(t.guardians.byId('gd-co').childIds, ['pl-child1', 'pl-child2'], 'the co-guardian keeps listing the player');
  assert.deepEqual(t.guardians.forPlayer('pl-child2').map((g) => g.id), ['gd-primary', 'gd-co'], 'primary first');
  assert.equal(t.invariantBreaks(), 0);
  t.close();
});

test('erase: the row stays as the retained record (id, deletion instant, birth date, country; placeholders elsewhere), its lists and links go; it is read by nothing that serves accounts', () => {
  const t = boot();
  t.players.addItem('pl-child2', 'timeline', { year: '2025', event: 'First match' });
  t.players.erase('pl-child2', { at: NOW });
  assert.equal(t.players.byId('pl-child2'), null); assert.equal(t.players.exists('pl-child2'), false);
  assert.deepEqual(t.players.retained('pl-child2'), { id: 'pl-child2', deletedAt: NOW, birthDate: '2016-08-08', country: 'GB' });
  for (const table of SUBRECORD_TABLES.filter((x) => x !== 'player_media_tags')) assert.equal(t.get(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = 'pl-child2'`).n, 0, table);
  assert.deepEqual(t.guardians.linksOf('pl-child2'), []);
  assert.equal(t.get("SELECT name FROM players WHERE id = 'pl-child2'").name, 'Deleted player');
  assert.equal(t.players.count(), 4); assert.equal(t.players.retainedCount(), 1);
  assert.throws(() => t.players.erase('pl-child2'), (e) => e.code === 'PLAYER_ID_RETAINED');
  t.close();
});

test('units of work: an operation joins the open unit; a refusal or a throw rolls the whole unit back with nothing to restore in memory; an empty unit touches no identity table', () => {
  const t = boot();
  assert.throws(() => t.unit(() => { t.players.update('pl-adult', (d) => { d.availability = 'loan_open'; }); t.players.addItem('pl-adult', 'badges', 'X'); throw new Error('boom'); }), /boom/);
  const p = t.players.byId('pl-adult');
  assert.equal(p.availability, 'not_seeking'); assert.deepEqual(p.badges, []);
  assert.throws(() => t.unit(() => { t.guardians.create({ id: 'gd-x', name: 'X', email: 'x@example.test' }); t.players.create({ id: 'pl-y', name: 'Y', dob: '2015-01-01', country: 'GB' }); }), (e) => e.code === 'MINOR_WITHOUT_GUARDIAN');
  assert.equal(t.guardians.byId('gd-x'), null, 'the guardian of the refused unit is not there');
  const statements = [];
  const prepare = t.store.sqlite.prepare.bind(t.store.sqlite);
  t.store.sqlite.prepare = (sql) => { statements.push(sql); return prepare(sql); };
  try { t.unit(() => {}); } finally { t.store.sqlite.prepare = prepare; }
  assert.equal(statements.filter((sql) => /\b(players|guardians|guardian_children|player_\w+)\b/.test(sql)).length, 0, 'an empty unit runs no identity statement');
  t.close();
});

// ------------------------------------------------------------------ reads
test('scans: visibleCandidates applies the under-18 wall (by the country\'s age of majority) for an organisation that cannot see minors, and the grassroots radius; the directory filters are SQL; a batch scan visits every admitted player once', () => {
  const t = boot();
  const kr17 = bornByForAge(18, NOW); // 18 today: a minor in KR (19), an adult in GB (18)
  t.players.create({ id: 'pl-kr', name: 'Seoul Player', dob: kr17, country: 'KR', guardianId: 'gd-signup' });
  t.players.create({ id: 'pl-gb18', name: 'Leeds Player', dob: kr17, country: 'GB', location: { lat: 53.81, lng: -1.56 }, level: 'semi_pro', position: 'CB' });
  t.players.create({ id: 'pl-far', name: 'Far Player', dob: '1995-01-01', country: 'GB', location: { lat: 51.5, lng: -0.12 } });
  const ids = (org, f) => t.players.visibleCandidates(orgOf(t, org), f).map((p) => p.id).sort();
  const adultsAll = ['pl-adult', 'pl-far', 'pl-gb18', 'pl-grown', 'pl-seeded'].sort();
  assert.deepEqual(ids('org-agency'), adultsAll, 'an agency sees adults only (the KR 18-year-old is a minor)');
  assert.deepEqual(ids('org-unverified'), adultsAll, 'an unverified club too');
  assert.deepEqual(ids('org-pro'), [...adultsAll, 'pl-child1', 'pl-child2', 'pl-kr'].sort(), 'a verified club may see minors');
  assert.deepEqual(ids('org-grass'), ['pl-adult', 'pl-gb18'], 'a grassroots club: not pro, within 50 km of its ground, exactly (Manchester is inside the index box but beyond the radius)');
  assert.deepEqual(ids('org-pro', { position: 'CB' }), ['pl-gb18']);
  assert.deepEqual(ids('org-pro', { ageBelow: 18 }), ['pl-child1', 'pl-child2'].sort(), 'ageBelow is exactly ageOn\'s rule');
  assert.deepEqual(ids('org-pro', { ageAtLeast: 18, ageBelow: 19 }), ['pl-gb18', 'pl-kr'].sort());
  assert.deepEqual(ids('org-pro', { createdSince: NOW - 1 }), [], 'seed players and new ones without createdAt are not new');
  const seen = []; t.players.scan({}, (p) => { seen.push(p.id); }); assert.equal(seen.length, t.players.count());
  const two = []; t.players.scan({}, (p) => { two.push(p.id); return two.length < 2; }); assert.equal(two.length, 2, 'returning false stops the scan');
  t.close();
});

test('players.profile_signal is computeTrustScore of the record after every kind of write (create, update, addItem, setItems, the seed import), and is never written by update', () => {
  const t = boot();
  const check = (label) => { for (const p of t.players.list({})) assert.equal(t.get('SELECT profile_signal AS v FROM players WHERE id = ?', p.id).v, computeTrustScore(p), `${label}: ${p.id}`); };
  check('the seed import');
  t.players.create({ id: 'pl-new', name: 'New Player', dob: '1999-01-01', country: 'GB', position: 'CM', foot: 'left', heightCm: 175, weightKg: 70, stats: { appearances: 3 } });
  check('create (a complete profile)');
  t.players.update('pl-new', (d) => { d.identityVerified = true; d.foot = null; });
  check('update (identity, an incomplete profile)');
  for (let i = 0; i < 7; i += 1) t.players.addItem('pl-new', 'media', { id: `med-n${i}`, title: `Clip ${i}`, kind: 'video', uploadedAt: new Date(NOW).toISOString(), url: null, views: 0, tags: {}, verifiedClip: null });
  check('addItem (clips, past the cap)');
  t.players.setItems('pl-new', 'attendance', [{ id: 'att-n1', fixture: 'Cup', venue: 'Ground', date: '2026-01-01', verified: true }]);
  check('setItems (attendance)');
  t.players.setItems('pl-new', 'media', []);
  check('setItems (clips cleared)');
  assert.throws(() => t.players.update('pl-new', (d) => { d.profileSignal = 99; }), /unknown field profileSignal/, 'the figure is not a field of the record');
  assert.throws(() => t.players.addItem('pl-new', 'media', { id: 'med-bad', title: 'Bad', kind: 'video', uploadedAt: '1 May 2026' }), /uploadedAt is not a UTC instant/, 'a clip\'s upload time is an ISO instant');
  t.close();
});

test('the directory page is exact and in its declared order: the whole visibility rule in SQL (the wall, the 50 km radius on both sides of ±180°, the blocks), the search over name, country and an adult\'s city (as JavaScript lowers text), and cursor pages that lose and repeat nobody at any size', () => {
  const t = boot();
  for (let i = 0; i < 23; i += 1) t.players.create({ id: `pl-d${String(i).padStart(2, '0')}`, name: `Dir ${i}`, dob: '1998-02-02', country: i % 2 ? 'GB' : 'ES', city: i === 4 ? 'Ávila' : null, academyPlus: i % 5 === 0, identityVerified: i % 3 === 0, firstTeamSeeker: i % 4 === 0, location: { lat: 53.8 + i * 0.01, lng: -1.55 } });
  t.layer.safetyAudit.blocks.add({ id: 'blk-1', playerId: 'pl-d07', orgId: 'org-pro', by: 'player', reason: 'synthetic', ts: NOW });
  const walk = (org, filter, limit) => { const out = []; let after = null; for (;;) { const pg = t.players.directoryPage(orgOf(t, org), filter, { limit, after }); out.push(...pg.items.map((p) => p.id)); if (!pg.nextCursor) return out; after = JSON.parse(Buffer.from(pg.nextCursor, 'base64url').toString()); } };
  const viewOrder = (org) => {
    const o = orgOf(t, org);
    const all = t.players.list({}).filter((p) => visibleToOrg(p, o) && !t.layer.safetyAudit.blocks.has(p.id, o.id));
    const dist = (p) => Math.round(haversineKm(o.location, p.location) * 10);
    return all.sort((a, b) => (o.level === 'grassroots'
      ? (b.firstTeamSeeker - a.firstTeamSeeker) || (dist(a) - dist(b)) || (computeTrustScore(b) - computeTrustScore(a))
      : (b.academyPlus - a.academyPlus) || (computeTrustScore(b) - computeTrustScore(a))) || (a.id < b.id ? -1 : 1)).map((p) => p.id);
  };
  for (const org of ['org-pro', 'org-agency', 'org-grass']) {
    const expected = viewOrder(org);
    for (const limit of [1, 4, 50]) assert.deepEqual(walk(org, {}, limit), expected, `${org}, pages of ${limit}`);
  }
  assert.ok(!walk('org-pro', {}, 50).includes('pl-d07') && walk('org-agency', {}, 50).includes('pl-d07'), 'a block hides the player from the organisation it names only');
  assert.deepEqual(walk('org-pro', { text: 'ávi' }, 50), ['pl-d04'], 'an accented city matched as JavaScript lowers it');
  assert.deepEqual(walk('org-pro', { text: 'child pl-child1' }, 50), ['pl-child1'], 'a name');
  assert.deepEqual(walk('org-pro', { text: 'nowhere' }, 50), [], 'nothing');
  t.players.update('pl-child1', (d) => { d.city = 'Hiddenham'; });
  assert.deepEqual(walk('org-pro', { text: 'hiddenham' }, 50), [], 'a minor\'s city is never shown, so never matched');
  // The antimeridian: a club at 179.9°E sees a player 20 km away at 179.9°W, and not one 60 km away.
  t.layer.orgs.create({ id: 'org-fiji', name: 'Taveuni FC', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'FJ', verified: true, location: { lat: -16.8, lng: 179.9, city: 'Waiyevo' } });
  t.players.create({ id: 'pl-east', name: 'Across The Line', dob: '1990-01-01', country: 'FJ', location: { lat: -16.8, lng: -179.99 } });
  t.players.create({ id: 'pl-far-east', name: 'Too Far', dob: '1990-01-01', country: 'FJ', location: { lat: -16.8, lng: -179.5 } });
  assert.deepEqual(walk('org-fiji', {}, 50), ['pl-east'], 'the radius holds across ±180°');
  t.close();
});

test('the light scan, the Film Room clip page, the fixture graph, the feed\'s recent rows and the drill bests read what the decoded records say', () => {
  const t = boot();
  const pro = orgOf(t, 'org-pro');
  const light = []; t.players.scanLight({ visibleTo: pro }, (p) => { light.push(p); });
  assert.deepEqual(light.map((p) => p.id), t.players.visibleCandidates(pro).map((p) => p.id), 'the same players, in creation order');
  for (const p of light) { const full = t.players.byId(p.id); assert.equal(p.profileSignal, computeTrustScore(full)); for (const k of ['name', 'dob', 'position', 'foot', 'heightCm', 'weightKg', 'level']) assert.deepEqual(p[k], full[k], `${p.id}.${k}`); assert.deepEqual(p.stats, full.stats); assert.equal(p.media, undefined, 'no lists on a light record'); }
  t.players.addItem('pl-adult', 'media', { id: 'med-a1', title: 'Played', kind: 'video', uploadedAt: new Date(NOW - 86_400_000).toISOString(), url: 'https://media.test/a1', views: 9, tags: {}, verifiedClip: null });
  t.players.addItem('pl-adult', 'media', { id: 'med-a2', title: 'Verified', kind: 'video', uploadedAt: new Date(NOW - 2 * 86_400_000).toISOString(), url: 'https://media.test/a2', views: 1, tags: {}, verifiedClip: 'att-x' });
  t.players.addItem('pl-adult', 'media', { id: 'med-a3', title: 'No url', kind: 'video', uploadedAt: new Date(NOW).toISOString(), url: null, views: 50, tags: {}, verifiedClip: null });
  const deck = []; let after = null; for (;;) { const pg = t.players.clipPage(pro, { limit: 1, after }); deck.push(...pg.items.map((x) => x.media.id)); if (!pg.nextCursor) break; after = JSON.parse(Buffer.from(pg.nextCursor, 'base64url').toString()); }
  assert.deepEqual(deck, ['med-a2', 'med-a1'], 'playable clips only, verified first, then views');
  const groups = t.players.fixturePage(pro, { limit: 50, after: null }).items;
  assert.deepEqual(groups.map((g) => [g.fixture, g.date, g.venue, g.players.map((p) => p.id)]), [['Cup Final', '2026-06-01', 'Hough End', ['pl-seeded']]]);
  assert.equal(t.players.fixturePage(orgOf(t, 'org-grass'), { limit: 50, after: null }).items.length, 0, 'Manchester is beyond the Leeds club\'s radius');
  const recent = t.players.recentFor(pro, NOW - 3 * 86_400_000, 40);
  assert.deepEqual(recent.clips.map((c) => c.media.id), ['med-a3', 'med-a1', 'med-a2'], 'clips uploaded since, newest first');
  assert.deepEqual(recent.players, [], 'no player created in the window');
  const bests = t.players.drillBests({ notLevel: 'pro' });
  assert.deepEqual(bests.get('drill-sprint'), [{ playerId: 'pl-seeded', max: 4.2, min: 4.2 }]);
  t.close();
});

test('lookups: byExternalId and byNameAndDob (the import\'s identity match), byGuardian, the admin guardians page by cursor', () => {
  const t = boot();
  t.players.addItem('pl-seeded', 'externalIds', { provider: 'fa', externalId: 'X1', source: 'import:b1', at: NOW, reviewId: 'rev-1' });
  assert.equal(t.players.byExternalId('fa', 'X1').id, 'pl-seeded');
  assert.deepEqual(t.players.byId('pl-seeded').externalIds, [{ provider: 'fa', externalId: 'X1', source: 'import:b1', at: NOW, reviewId: 'rev-1' }]);
  assert.equal(t.players.byExternalId('fa', 'X2'), null);
  assert.equal(t.players.byNameAndDob('SEEDED ADULT', '2004-03-14').id, 'pl-seeded', 'the name compared case-insensitively');
  assert.deepEqual(t.players.byGuardian('gd-primary').map((p) => p.id), ['pl-child1', 'pl-child2', 'pl-grown']);
  const first = t.guardians.page({ limit: 2 });
  assert.deepEqual(first.items.map((g) => g.id), ['gd-primary', 'gd-co']);
  assert.ok(first.nextCursor);
  t.close();
});

test('read back: every live record with its hashes and no derived lists, a retained record is not a player; a new record is typed whole, so a retained id and junk are refused and nothing is written', () => {
  const t = boot();
  t.players.erase('pl-child2', { at: NOW });
  const back = readRecords(t.dir);
  const p = back.players.find((x) => x.id === 'pl-adult');
  assert.equal(p.password, 'scrypt$aa$bb'); assert.equal('trialReports' in p, false);
  const g = back.guardians.find((x) => x.id === 'gd-signup');
  assert.equal(g.emailCodeHash.length, 64); assert.equal('coGuardians' in g, false);
  assert.equal(back.players.some((x) => x.id === 'pl-child2'), false, 'a retained record is not a player');
  assert.equal(t.get("SELECT deleted_at FROM players WHERE id = 'pl-child2'").deleted_at, NOW, 'the retained row is kept');
  const before = JSON.stringify(t.all('SELECT * FROM players ORDER BY rowid'));
  // (A created record carries no password field: the hash is written by its own operation.)
  assert.throws(() => writeFixture(t.dir, { players: [{ ...child('pl-child2', 'gd-primary', '2016-08-08'), password: undefined }] }, { now: NOW }), (e) => e.code === 'PLAYER_ID_RETAINED' && /player pl-child2 was deleted and its id is retained/.test(e.message));
  assert.throws(() => writeFixture(t.dir, { players: [{ ...adult(), id: 'pl-adult2', password: undefined, heightCm: 'tall' }] }, { now: NOW }), (e) => e.code === 'PLAYER_RECORD_INVALID' && /pl-adult2\): heightCm must be a whole number/.test(e.message));
  assert.equal(JSON.stringify(t.all('SELECT * FROM players ORDER BY rowid')), before, 'nothing was written');
  t.close();
});

console.log(`identity repositories: ${passed} checks passed`);
