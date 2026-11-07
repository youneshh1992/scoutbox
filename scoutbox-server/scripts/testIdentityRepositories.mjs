// The player and guardian repositories (repositories/identity.mjs; explicit since S14h), exercised on temporary
// databases through the real data layer (attachDataLayer runs the registered migrations and attaches every
// repository). Nothing here touches DATA_DIR. Synthetic records only; the clock is fixed where age matters.
// Run with: npm test
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META, PLAYER_RECORD_KEYS, GUARDIAN_RECORD_KEYS, bornByForAge } from '../repositories/identity.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import { adult, child, gSignup, FIXTURE, T0, NOW, TTL, tempDir, clone } from './coreIdentityTestFixtures.mjs';

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
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const layer = attachDataLayer({ db, seed: { orgs: ORGS(), players: clone(players), guardians: clone(guardians) }, store, nextId, sessionTtlMs: TTL, now: () => NOW });
  const all = (sql, ...p) => store.sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
  const get = (sql, ...p) => store.sqlite.prepare(sql).get(...p);
  const invariantBreaks = () => get(`SELECT COUNT(*) AS n FROM players p LEFT JOIN guardian_children l ON l.player_id = p.id AND l.role = 'primary'
    WHERE (p.guardian_id IS NULL) <> (l.guardian_id IS NULL) OR (p.guardian_id IS NOT NULL AND l.guardian_id <> p.guardian_id)`).n
    + store.sqlite.prepare('PRAGMA foreign_key_check').all().length;
  return { dir, store, layer, db, identity: layer.identity, players: layer.players, guardians: layer.guardians, all, get, invariantBreaks,
    unit: (fn) => store.unitOfWork(fn), close: () => store.sqlite.close() };
}
const orgOf = (t, id) => t.layer.orgs.byId(id);
const second = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA busy_timeout = 5000;'); return s; };

// ------------------------------------------------------------------ authority and initialisation
test('authority and initialisation: the repositories attach only behind the cutover record; a first installation imports the seed once (links from childIds, roles from guardianId); a later boot attaches and never imports', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id)));
  assert.throws(() => createIdentityRepositories({ sqlite: s }), /cutover record 0005_core_identity_live is missing/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('players', 'guardians', 'guardian_children')").get().n, 0, 'S14h: 0002 creates no identity shadow');
  const t = boot();
  assert.equal(t.layer.firstInstallation, true);
  assert.deepEqual(t.layer.boot.identity, { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 8 });
  assert.equal(t.get('SELECT value FROM meta WHERE key = ?', CORE_IDENTITY_INIT_META).value, 'done');
  assert.deepEqual(t.all('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid'), [
    { guardian_id: 'gd-primary', player_id: 'pl-child1', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-child2', role: 'primary' },
    { guardian_id: 'gd-primary', player_id: 'pl-grown', role: 'primary' }, { guardian_id: 'gd-co', player_id: 'pl-child1', role: 'co' }, { guardian_id: 'gd-co', player_id: 'pl-child2', role: 'co' },
  ]);
  assert.equal(t.invariantBreaks(), 0);
  t.store.save(); t.close();
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
  assert.throws(() => t.db.players, /db\.players is gone/);
  assert.throws(() => t.db.guardians, /db\.guardians is gone/);
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
test('scans: visibleCandidates applies the under-18 wall (by the country\'s age of majority) for an organisation that cannot see minors, and the grassroots box; the directory filters are SQL; a batch scan visits every admitted player once', () => {
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
  assert.deepEqual(ids('org-grass'), ['pl-adult', 'pl-gb18', 'pl-seeded'], 'a grassroots club: not pro, inside the box around its ground (a prefilter: Manchester is in the box, the exact 50 km test is the caller\'s)');
  assert.deepEqual(ids('org-pro', { position: 'CB' }), ['pl-gb18']);
  assert.deepEqual(ids('org-pro', { ageBelow: 18 }), ['pl-child1', 'pl-child2'].sort(), 'ageBelow is exactly ageOn\'s rule');
  assert.deepEqual(ids('org-pro', { ageAtLeast: 18, ageBelow: 19 }), ['pl-gb18', 'pl-kr'].sort());
  assert.deepEqual(ids('org-pro', { createdSince: NOW - 1 }), [], 'seed players and new ones without createdAt are not new');
  const seen = []; t.players.scan({}, (p) => { seen.push(p.id); }); assert.equal(seen.length, t.players.count());
  const two = []; t.players.scan({}, (p) => { two.push(p.id); return two.length < 2; }); assert.equal(two.length, 2, 'returning false stops the scan');
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

test('the snapshot path: a read gives every live record with its hashes and no derived lists; a save types the whole pair first and rewrites the tables, keeping the retained rows and refusing their ids', () => {
  const t = boot();
  t.players.erase('pl-child2', { at: NOW });
  t.store.save();
  const tool = openStore(t.dir);
  const snap = tool.load();
  const p = snap.db.players.find((x) => x.id === 'pl-adult');
  assert.equal(p.password, 'scrypt$aa$bb'); assert.equal('trialReports' in p, false);
  const g = snap.db.guardians.find((x) => x.id === 'gd-signup');
  assert.equal(g.emailCodeHash.length, 64); assert.equal('coGuardians' in g, false);
  assert.equal(snap.db.players.some((x) => x.id === 'pl-child2'), false, 'a retained record is not a player');
  tool.save(snap);
  assert.equal(tool.sqlite.prepare("SELECT deleted_at FROM players WHERE id = 'pl-child2'").get().deleted_at, NOW, 'the retained row survives the rewrite');
  const resurrect = clone(snap); resurrect.db.players.push(child('pl-child2', 'gd-primary', '2016-08-08'));
  assert.throws(() => tool.save(resurrect), (e) => e.code === 'IDENTITY_IMPORT_BLOCKED' && /pl-child2: the id is a deleted account/.test(e.message));
  const junk = clone(snap); junk.db.players.find((x) => x.id === 'pl-adult').heightCm = 'tall';
  assert.throws(() => tool.save(junk), (e) => e.code === 'IDENTITY_IMPORT_BLOCKED' && /pl-adult: heightCm must be a whole number/.test(e.message));
  assert.equal(tool.sqlite.prepare("SELECT height_cm FROM players WHERE id = 'pl-adult'").get().height_cm, 182, 'nothing was written');
  tool.sqlite.close(); t.close();
});

console.log(`identity repositories: ${passed} checks passed`);
