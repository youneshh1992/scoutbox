// S13d — grassroots operations as typed tables with explicit writes (repositories/grassroots.mjs, migration 0037).
// What this suite proves: the migration creates the STRICT tables (no JSON column), empty; the typers refuse junk
// naming the record and field (a day that does not exist, a repeated position, a guardian id on a player's own
// registration, an outcome without its time, a player credited twice, a response from the poster); an open day is
// created with its positions, registered once per player, answered once, counted by the no-ghosting rule only while
// past and unanswered, and deleting it stamps it (it leaves every list, the row and a coverage assignment's key stay);
// a deleted player's registrations lose the name and keep the id; match days and the organisation's open days page
// newest first; the friendlies board pages by date with the radius box and an exact filter, and takes one response per
// club; a rolled-back unit leaves nothing; and a fixture written through the repository is typed, names a missing
// reference and reads back what it wrote. Temporary databases only.
// Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  GRASSROOTS_MIGRATION as MIGRATION, GRASSROOTS_TABLES as TABLES, GRASSROOTS_COLLECTIONS as COLLECTIONS,
  typeOpenTrial, typeRegistration, typeMatchday, typeFriendly, boxAround,
} from '../repositories/grassroots.mjs';
import { haversineKm } from '../domain.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const MOSS = 'org-moss'; const LEY = 'org-ley'; const FAR = 'org-far';
const STAFF = { moss: 'usr-moss', ley: 'usr-ley', far: 'usr-far' };
const club = (id, name, location) => ({ ...ORGS()[0], id, name, level: 'grassroots', plan: 'Grassroots', location });
const FIX = () => ({
  users: [...USERS(), { id: STAFF.moss, orgId: MOSS, name: 'Kev', role: 'Manager', createdAt: 1 }, { id: STAFF.ley, orgId: LEY, name: 'Sam', role: 'Manager', createdAt: 1 }, { id: STAFF.far, orgId: FAR, name: 'Jo', role: 'Manager', createdAt: 1 }],
  orgs: [...ORGS(), club(MOSS, 'Hackney Wick', { city: 'London', lat: 51.545, lng: -0.025 }), club(LEY, 'Leyton Orient Youth', { city: 'London', lat: 51.56, lng: -0.012 }), club(FAR, 'Moss Side', { city: 'Manchester', lat: 53.46, lng: -2.24 })],
  notifications: [], dispatches: [],
});
const trial = (over = {}) => ({
  id: 'open-1', orgId: MOSS, title: 'U15 open morning', date: '2026-12-05', venue: 'Hackney Marshes', ageGroup: 'u16', positions: ['GK', 'ST'],
  notes: '', createdByUserId: STAFF.moss, createdAt: NOW, deletedAt: null, registrations: [], ...over,
});
const reg = (over = {}) => ({ id: 'otr-1', playerId: 'pl-adult', playerName: 'Ada', byGuardian: false, guardianId: null, ts: NOW, ...over });
const matchday = (over = {}) => ({ id: 'md-1', orgId: MOSS, fixture: 'Wick v Rovers', venue: '', date: '2026-11-01', result: '3-1', playerIds: ['pl-adult'], loggedByUserId: STAFF.moss, ts: NOW, ...over });
const friendly = (over = {}) => ({ id: 'fr-1', orgId: MOSS, postedByUserId: STAFF.moss, ageGroup: 'u15', date: '2026-12-10', venue: 'Pitch 2', notes: '', responses: [], createdAt: NOW, ...over });

function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.grassroots, coverage: layer.insightCoverage, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); saveFixture(dir, FIX()); return { dir, s: serverOpen(dir) }; };

// ------------------------------------------------------------- schema
test('[schema] 0037 is registered after 0036 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0036_groups') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13d-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  for (const ok of [typeOpenTrial(trial({ registrations: [reg()] })), typeMatchday(matchday()), typeFriendly(friendly())]) assert.ok(ok.ok, ok.reason);
  assert.match(typeOpenTrial(trial({ date: '2026-02-30' })).reason, /openTrials open-1\.date must be a calendar day/);
  assert.match(typeOpenTrial(trial({ date: '2026-12' })).reason, /date must be a calendar day/);
  assert.match(typeOpenTrial(trial({ positions: ['GK', 'GK'] })).reason, /positions names a position twice/);
  assert.match(typeOpenTrial(trial({ positions: [7] })).reason, /positions\[0\] must be text/);
  assert.match(typeOpenTrial(trial({ orgName: 'x' })).reason, /does not store: orgName/);
  assert.match(typeRegistration(reg({ guardianId: 'gd-1' })).reason, /guardianId is set exactly when a guardian registered/);
  assert.match(typeRegistration(reg({ outcome: 'declined' })).reason, /outcomeAt is set exactly when there is an outcome/);
  assert.match(typeRegistration(reg({ outcome: 'maybe', outcomeAt: NOW })).reason, /outcome must be one of invite_trial\|declined/);
  assert.match(typeMatchday(matchday({ playerIds: ['pl-a', 'pl-a'] })).reason, /playerIds names a player twice/);
  assert.match(typeMatchday(matchday({ result: '3-1 after extra time and penalties' })).reason, /result exceeds 20 characters/);
  assert.match(typeFriendly(friendly({ responses: [{ orgId: MOSS, message: '', respondedByUserId: STAFF.moss, ts: NOW }] })).reason, /is the poster's own/);
  assert.match(typeFriendly(friendly({ status: 'open' })).reason, /does not store: status/);
});

// ------------------------------------------------------------- open days
test('[open days] created with positions; registered once; answered once; no-ghosting counts past unanswered; delete stamps', () => {
  const { dir, s } = seeded('s13d-open');
  const { openTrials: ot } = s.repo;
  assert.deepEqual(plain(ot.create(trial())), plain(trial()));
  refused(() => ot.create(trial({ id: 'open-2', createdByUserId: 'usr-none' })), /GRASSROOTS_REFERENCE_MISSING.*usr-none/);
  ot.create(trial({ id: 'open-past', date: '2026-01-10', positions: [] }));
  ot.register('open-past', reg());
  refused(() => ot.register('open-past', reg({ id: 'otr-2' })), /ALREADY_REGISTERED/);
  ot.register('open-past', reg({ id: 'otr-2', playerId: 'pl-minor', playerName: 'Kid', byGuardian: true, guardianId: 'gd-1' }));
  assert.equal(ot.unresolvedBefore(MOSS, '2026-11-06'), 2, 'two past registrants are owed an answer');
  assert.equal(ot.unresolvedBefore(MOSS, '2026-01-10'), 0, 'not before the day has passed');
  const answered = ot.resolve('open-past', 'otr-1', { outcome: 'declined', note: 'Keep playing', at: NOW + 1 });
  assert.deepEqual([answered.outcome, answered.outcomeNote, answered.outcomeAt], ['declined', 'Keep playing', NOW + 1]);
  refused(() => ot.resolve('open-past', 'otr-1', { outcome: 'invite_trial', at: NOW + 2 }), /ALREADY_RESOLVED/);
  refused(() => ot.resolve('open-1', 'otr-2', { outcome: 'declined', at: NOW }), /GRASSROOTS_NOT_FOUND/, 'the registration belongs to another open day');
  assert.equal(ot.unresolvedBefore(MOSS, '2026-11-06'), 1);
  assert.deepEqual(ot.registrantsOf(MOSS).map((r) => r.playerId).sort(), ['pl-adult', 'pl-minor']);
  // a deleted player keeps the id, loses the name
  assert.equal(ot.redactPlayer('pl-minor'), 1);
  assert.deepEqual(ot.byId('open-past').registrations.map((r) => [r.playerId, r.playerName]), [['pl-adult', 'Ada'], ['pl-minor', null]]);
  // upcoming lists
  assert.deepEqual(ot.upcomingForOrgs([MOSS, LEY], '2026-11-06').map((t) => t.id), ['open-1']);
  assert.deepEqual(ot.inBox(boxAround({ lat: 51.56, lng: -0.012 }, 50)).map((t) => t.id), ['open-past', 'open-1'], 'inside the box, past days too, by date');
  assert.deepEqual(ot.inBox(boxAround({ lat: 53.46, lng: -2.24 }, 50)), [], 'Manchester never sees London');
  // The prefilter never drops what the exact test keeps: a ground 50.0 km due north or east (haversine, R = 6,371 km) is inside the box.
  { const here = { lat: 51.5, lng: -0.1 }; const box = boxAround(here, 50); const deg = (50.04 / 6371) * (180 / Math.PI);
    assert.ok(here.lat + deg <= box.maxLat, 'due north at the edge'); assert.ok(here.lng + deg / Math.cos((here.lat * Math.PI) / 180) <= box.maxLng, 'due east at the edge'); }
  // pages newest first
  const p1 = ot.pageForOrg(MOSS, { limit: 1 });
  assert.deepEqual(p1.items.map((t) => t.id), ['open-past']);
  assert.deepEqual(ot.pageForOrg(MOSS, { limit: 1, after: JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString()) }).items.map((t) => t.id), ['open-1']);
  // a coverage assignment names it; deleting stamps it and the key stays
  s.coverage.assignments.create({
    id: 'cva-1', orgId: LEY, fixture: { kind: 'open_trial', id: 'open-1' }, fixtureDate: '2026-12-05', fixtureLabel: 'Hackney Wick v —', fixtureCompetition: 'Open trial',
    scoutUserId: STAFF.ley, scoutName: 'Sam', targetPlayerIds: [], travelBudget: null, warnings: [], assignedBy: 'Sam', createdAt: NOW, observedAt: null, assessmentId: null, cancelledAt: null,
  });
  assert.equal(ot.remove(LEY, 'open-1', NOW), false, 'only the host deletes');
  assert.equal(ot.remove(MOSS, 'open-1', NOW), true);
  assert.equal(ot.remove(MOSS, 'open-1', NOW), false, 'once');
  assert.equal(ot.byId('open-1'), null);
  assert.equal(ot.countForOrg(MOSS), 1);
  assert.deepEqual(ot.upcomingForOrgs([MOSS], '2026-11-06'), []);
  assert.deepEqual(s.coverage.assignments.byId('cva-1').fixture, { kind: 'open_trial', id: 'open-1' }, 'the assignment keeps its key');
  refused(() => ot.register('open-1', reg({ id: 'otr-3' })), /not a live open day/);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- match days
test('[match days] logged with credited players; page newest first; counted', () => {
  const { dir, s } = seeded('s13d-md');
  const { matchdays: md } = s.repo;
  assert.deepEqual(plain(md.create(matchday())), plain(matchday()));
  md.create(matchday({ id: 'md-2', playerIds: [], result: null }));
  refused(() => md.create(matchday({ id: 'md-3', loggedByUserId: 'usr-none' })), /usr-none/);
  assert.equal(md.countForOrg(MOSS), 2);
  const page = md.pageForOrg(MOSS, { limit: 1 });
  assert.deepEqual(page.items.map((m) => m.id), ['md-2']);
  assert.ok(page.nextCursor);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- friendlies
test('[friendlies] the board pages by date inside the radius; one response per club, never the poster', () => {
  const { dir, s } = seeded('s13d-fr');
  const { friendlies: fr } = s.repo;
  fr.create(friendly());
  fr.create(friendly({ id: 'fr-2', date: '2026-12-01' }));
  fr.create(friendly({ id: 'fr-far', orgId: FAR, postedByUserId: STAFF.far }));
  const orgs = new Map(FIX().orgs.map((o) => [o.id, o]));
  const viewer = orgs.get(LEY);
  const near = (f) => haversineKm(orgs.get(f.orgId).location, viewer.location) <= 50;
  const first = fr.boardPage(LEY, boxAround(viewer.location, 50), { limit: 1 }, near);
  assert.deepEqual(first.items.map((f) => f.id), ['fr-2'], 'by date');
  const after = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  const second = fr.boardPage(LEY, boxAround(viewer.location, 50), { limit: 1, after }, near);
  assert.deepEqual([second.items.map((f) => f.id), second.nextCursor], [['fr-1'], null], 'Manchester\'s friendly never reaches London');
  assert.deepEqual(fr.boardPage(FAR, null, { limit: 10 }).items.map((f) => f.id), ['fr-far'], 'no location: its own only');
  fr.respond('fr-1', { orgId: LEY, message: 'Free that day', respondedByUserId: STAFF.ley, ts: NOW });
  refused(() => fr.respond('fr-1', { orgId: LEY, message: 'again', respondedByUserId: STAFF.ley, ts: NOW }), /ALREADY_RESPONDED/);
  refused(() => fr.respond('fr-1', { orgId: MOSS, message: '', respondedByUserId: STAFF.moss, ts: NOW }), /own friendly/);
  refused(() => fr.respond('fr-1', { orgId: FAR, message: 7, respondedByUserId: STAFF.far, ts: NOW }), /message must be text/);
  assert.deepEqual(plain(fr.byId('fr-1').responses), [{ orgId: LEY, message: 'Free that day', respondedByUserId: STAFF.ley, ts: NOW }]);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- units
test('[unit] a rolled-back unit leaves nothing', () => {
  const { dir, s } = seeded('s13d-unit');
  assert.throws(() => s.unit(() => { s.repo.openTrials.create(trial()); s.repo.openTrials.register('open-1', reg()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.openTrials.byId('open-1'), null);
  for (const w of ['create', 'remove', 'register', 'resolve', 'redactPlayer']) assert.equal(typeof s.repo.reads.openTrials[w], 'undefined', `the reads cannot ${w}`);
  assert.equal(typeof s.repo.reads.friendlies.respond, 'undefined');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- fixtures
/**
 * Open days and friendlies written the way the routes write them: an open day is posted, then each registration made
 * and answered (then a deletion); a friendly is posted, then answered.
 */
const WRITERS = {
  openTrials: (L, records) => {
    for (const { registrations = [], deletedAt = null, ...t } of records) {
      L.grassroots.openTrials.create({ ...t, registrations: [], deletedAt: null });
      for (const { outcome = null, outcomeNote = null, outcomeAt = null, ...r } of registrations) {
        L.grassroots.openTrials.register(t.id, r);
        if (outcome !== null) L.grassroots.openTrials.resolve(t.id, r.id, { outcome, note: outcomeNote, at: outcomeAt });
      }
      if (deletedAt !== null) L.grassroots.openTrials.remove(t.orgId, t.id, deletedAt);
    }
  },
  friendlies: (L, records) => {
    for (const { responses = [], ...f } of records) {
      L.grassroots.friendlies.create({ ...f, responses: [] });
      for (const r of responses) L.grassroots.friendlies.respond(f.id, r);
    }
  },
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: WRITERS });
test('[fixtures] a record written through the repository is typed, a missing reference is named, a refused write leaves nothing, and the records read back as written', () => {
  const dir = tempDir('s13d-fix');
  const full = trial({ registrations: [reg({ outcome: 'invite_trial', outcomeNote: 'Come back', outcomeAt: NOW + 1 })] });
  const resp = friendly({ responses: [{ orgId: LEY, message: 'Yes', respondedByUserId: STAFF.ley, ts: NOW }] });
  write(dir, fixtureDb({ ...FIX(), openTrials: [full], matchdays: [matchday()], friendlies: [resp] }));
  const back = readRecords(dir);
  assert.deepEqual(plain(back.openTrials), [plain(full)]);
  assert.deepEqual(plain(back.matchdays), [plain(matchday())]);
  assert.deepEqual(plain(back.friendlies), [plain(resp)]);
  refused(() => write(dir, { matchdays: [matchday({ id: 'md-2', orgId: 'org-none' })] }), /GRASSROOTS_REFERENCE_MISSING.*org-none/);
  refused(() => write(dir, { openTrials: [{ ...trial({ id: 'open-2' }), orgName: 'x' }], matchdays: [matchday({ id: 'md-3' })] }), /GRASSROOTS_INPUT_INVALID.*does not store: orgName/);
  const after = readRecords(dir);
  assert.deepEqual([after.openTrials.map((t) => t.id), after.matchdays.map((m) => m.id)], [['open-1'], ['md-1']], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} grassroots checks passed`);
