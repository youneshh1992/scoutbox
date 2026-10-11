// S4a, first bounded part: player/guardian mapping, validation and the
// read-only preflight (repositories/identityMapping.mjs,
// repositories/identityPreflight.mjs, scripts/preflightCoreIdentity.mjs).
// Nothing here registers a migration, cuts a collection over, boots a server
// or touches DATA_DIR: every database is a temporary file or in memory, every
// record is synthetic. Run with: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  playerToRow, playerFromRow, guardianToRow, guardianFromRow, validatePlayerRecord, validateGuardianRecord,
  PLAYER_COLUMNS, GUARDIAN_COLUMNS, PLAYER_MIGRATED_KEYS,
} from '../repositories/identityMapping.mjs';
import {
  validateCoreIdentity, publicReport, createCandidateSchema, writeCandidate, CANDIDATE_DDL,
  PREFLIGHT_STATUS, DECISION_MINOR_WITHOUT_LINK, AUTHORISES_NOTHING,
} from '../repositories/identityPreflight.mjs';
import { transaction } from '../repositories/database.mjs';
import { openStore } from '../store.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DAY = 86_400_000;
// A fixed evaluation instant (2026-10-11T12:00:00Z) so adult/minor is reproducible.
const NOW = Date.UTC(2026, 9, 11, 12);
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const memDb = () => { const s = new DatabaseSync(':memory:'); createCandidateSchema(s); return s; };

// ------------------------------------------------------------------ fixtures
// The exact shapes the application writes today (server.mjs signup routes,
// the seed's player() defaults, the boot defaults). Synthetic values only.
const T0 = NOW - 100 * DAY;
/** Adult signup (server.mjs /auth/player/signup), key order as written there. */
const adultSignup = () => ({
  id: 'pl-9001', name: 'Adult Signup', dob: '2001-05-20', country: 'GB', city: 'Leeds', position: 'ST', foot: 'right', heightCm: 182, weightKg: 77,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], guardianId: null, squadNumber: null, contractUntil: null,
  marketValueRange: null, agentName: null, createdAt: T0, password: 'scrypt$aa$bb', level: 'amateur', location: { lat: 53.8, lng: -1.5 },
  medical: { shared: false, records: [], conditionStatus: 'unknown' },
  // boot defaults (server.mjs) applied to every loaded player
  notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
/** Guardian-created child (POST /guardian/children): city '', no password, primary guardian set. */
const childOf = (guardianId, id = 'pl-9002', dob = '2014-03-03') => ({
  id, name: 'Child Player', dob, country: 'GB', city: '', guardianId, position: null, foot: null, heightCm: null, weightKg: null,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], squadNumber: null, contractUntil: null, marketValueRange: null,
  agentName: null, createdAt: T0 + DAY, password: null, level: 'amateur', location: null, medical: { shared: false, records: [], conditionStatus: 'unknown' },
  notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
/** A seeded, fully populated adult: every S5 array present with content, split composites with remainders, facets, unknown field. */
const seededAdult = () => ({
  badges: ['Finisher', 'Pressing Forward'],
  attendance: [{ id: 'att-1', fixture: 'Cup Final', venue: 'Hough End', date: '2026-06-01', gps: { lat: 53.43, lng: -2.26 }, deviceConfirmed: true, verified: true, corroboratedBy: 'Riverside Juniors' }],
  timeline: [{ year: '2019', event: 'Joined academy' }, { year: '2025', event: 'Top scorer' }],
  media: [{ id: 'med-1', title: 'Highlights', kind: 'video', uploadedAt: '2026-05-01T10:00:00.000Z', url: null, views: 3, tags: { pace: 2 }, verifiedClip: 'att-1', captions: 'WEBVTT', sizeBytes: 1024 }],
  trialReports: [{ id: 'rep-1', orgId: 'org-x', notes: 'strong' }],
  medical: { shared: true, records: [{ id: 'md-1', type: 'injury', title: 'Hamstring', date: '2025-11-02', layoffWeeks: 3, cleared: true }, { id: 'md-2', type: 'clearance', title: 'Screen', date: '2026-01-15', cleared: null }], conditionStatus: 'fully_fit' },
  identityVerified: true, academyPlus: true, guardianId: null, squadNumber: 22, contractUntil: '2026-06-30', marketValueRange: '€250K – €450K', agentName: 'Team Elevate',
  availability: 'available_now', contractStatus: 'expiring_summer',
  drills: ['drill-sprint'], drillResults: [{ id: 'dr-1', drillId: 'drill-sprint', drillName: 'Sprint', metric: 'time', unit: 's', value: 4.2, verified: false, ts: T0 }],
  activityLog: [T0, T0 + DAY], createdAt: null, password: null, level: 'semi_pro', location: { lat: 53.483, lng: -2.244 },
  id: 'pl-9003', name: 'Seeded Adult', dob: '2004-03-14', country: 'GB', city: 'Manchester', position: 'ST', foot: 'right', heightCm: 184, weightKg: 79,
  seasonHistory: [{ season: '2024/25', appearances: 27, goals: 14, assists: 4 }],
  stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61, xg: 0.4 },
  externalIds: [{ provider: 'fa', externalId: 'FA-1', source: 'import:b1', by: 'Maria', at: T0, claim: { row: 1 } }],
  notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: null, timezone: 'Europe/London' },
  programme: { track: 'ST', startedAt: T0, completed: [{ sessionId: 's1', ts: T0 + DAY }] },
  firstTeamSeeker: true, footballCategory: 'senior',
  futureField: { nested: [1, 2, { deep: true }] },
});
/** Guardian signup (/auth/guardian/signup) with an outstanding e-mail code. */
const guardianSignup = (id = 'gd-9001', email = 'parent.one@example.com', childIds = []) => ({
  id, name: 'Parent One', email, password: 'scrypt$cc$dd', emailVerified: false, emailCode: 'K7Q2ZP', idVerified: false, disclaimerAccepted: false, childIds,
});
/** Co-guardian (POST /guardian/coguardian): no password, no emailVerified, no createdAt. */
const coGuardianOf = (primary, id = 'gd-9002', email = 'parent.two@example.com') => ({
  id, name: 'Parent Two', email, idVerified: false, disclaimerAccepted: false, childIds: [...primary.childIds], coGuardianOf: primary.id,
});
/** A verified seeded guardian with prefs and a facet of co-guardians. */
const seededGuardian = () => ({
  id: 'gd-9003', name: 'Amara Seed', email: 'amara.seed@example.com', password: null, emailVerified: true, emailCode: null, idVerified: true, idvReference: 'idv-1',
  disclaimerAccepted: true, childIds: ['pl-9002', 'pl-9004'], coGuardians: [{ id: 'gd-9002', name: 'Parent Two', email: 'parent.two@example.com' }],
  notificationPrefs: { quietStart: '20:00', quietEnd: '06:30', schoolHoursMute: true, timezone: 'Europe/London' }, createdAt: T0, legacyNote: 'kept',
});

/** A consistent synthetic snapshot: adult, seeded adult, primary guardian with two children, a co-guardian, and every shape above. */
function consistentSnapshot() {
  const primary = seededGuardian();
  const co = coGuardianOf(primary);
  const signup = guardianSignup();
  return {
    players: [adultSignup(), childOf('gd-9003'), seededAdult(), childOf('gd-9003', 'pl-9004', '2016-08-08')],
    guardians: [primary, co, signup],
  };
}

const roundTripPlayer = (rec) => playerFromRow(playerToRow(rec));
const roundTripGuardian = (rec) => guardianFromRow(guardianToRow(rec), rec.childIds ?? []);
const sameShape = (a, b, what) => {
  assert.deepEqual(Object.keys(b), Object.keys(a), `${what}: key order`);
  assert.equal(JSON.stringify(b), JSON.stringify(a), `${what}: byte-identical JSON`);
};

// ------------------------------------------------------------------ round trips
test('round trip: the adult signup shape is byte-identical — explicit nulls (stats, guardianId, squadNumber…) stay null, booleans stay, the boot defaults stay, key order is kept', () => {
  const rec = adultSignup();
  const row = playerToRow(rec);
  assert.equal(row.birth_date, '2001-05-20'); assert.equal(row.password_hash, 'scrypt$aa$bb'); assert.equal(row.guardian_id, null); assert.equal(row.lat, 53.8);
  assert.equal(row.stats_appearances, null); assert.equal(row.medical_shared, 0); assert.equal(row.medical_condition_status, 'unknown');
  assert.equal(row.email_code_hash, undefined, 'no guardian column leaks onto a player row');
  sameShape(rec, roundTripPlayer(rec), 'adult signup');
});

test('round trip: a guardian-created child keeps city "", password null, guardianId set and position/foot/height null', () => {
  const rec = childOf('gd-9003');
  const row = playerToRow(rec);
  assert.equal(row.city, ''); assert.equal(row.password_hash, null); assert.equal(row.guardian_id, 'gd-9003'); assert.equal(row.position, null);
  sameShape(rec, roundTripPlayer(rec), 'child');
});

test('round trip: a seeded adult with every S5 array, split composites (medical.records, programme.completed), unknown stats sub-key, external ids, an unknown field and createdAt null is byte-identical; the row carries the scalars', () => {
  const rec = seededAdult();
  const row = playerToRow(rec);
  assert.equal(row.medical_shared, 1); assert.equal(row.medical_condition_status, 'fully_fit'); assert.equal(row.programme_track, 'ST'); assert.equal(row.programme_started_at, T0);
  assert.equal(row.stats_pace_kmh, 34.1); assert.equal(row.contract_until_date, '2026-06-30'); assert.equal(row.first_team_seeker, 1); assert.equal(row.created_at, null);
  const facets = JSON.parse(row.facets_json);
  assert.deepEqual(facets.__rest, { medical: { records: rec.medical.records }, programme: { completed: rec.programme.completed }, stats: { xg: 0.4 } }, 'composite remainders ride in __rest');
  assert.deepEqual(facets.media, rec.media); assert.deepEqual(facets.attendance, rec.attendance); assert.deepEqual(facets.drillResults, rec.drillResults);
  assert.deepEqual(facets.futureField, rec.futureField); assert.equal('name' in facets, false, 'a column-backed field is not duplicated in the facets');
  assert.ok(facets.__meta.nulls.includes('createdAt'));
  sameShape(rec, roundTripPlayer(rec), 'seeded adult');
});

test('round trip: absent versus explicit null is preserved for every player column — an absent drillResults / firstTeamSeeker / programme stays absent, a null stats stays null, a defaulted NOT NULL column (availability) absent on the record stays absent on the way back', () => {
  const minimal = { id: 'pl-min', name: 'Minimal', dob: '2003-01-01', country: 'FR', stats: null, location: null, notificationPrefs: null, medical: null, programme: null, academyPlus: null };
  const row = playerToRow(minimal);
  assert.equal(row.availability, 'not_seeking'); assert.equal(row.level, 'amateur'); assert.equal(row.academy_plus, 0); assert.equal(row.medical_shared, 0);
  const back = roundTripPlayer(minimal);
  sameShape(minimal, back, 'minimal');
  assert.equal('availability' in back, false); assert.equal('drillResults' in back, false); assert.equal('firstTeamSeeker' in back, false);
  assert.equal(back.stats, null); assert.equal(back.academyPlus, null); assert.equal(back.medical, null);
  // Partial composites: only the sub-keys the record had come back, in order; a null sub-key stays null.
  const partial = { id: 'pl-part', name: 'Partial', dob: '2003-01-01', country: 'FR', stats: { goals: 3 }, medical: { conditionStatus: 'fit', shared: null }, notificationPrefs: { timezone: null } };
  sameShape(partial, roundTripPlayer(partial), 'partial composites');
});

test('round trip: a guardian signup with an outstanding e-mail code keeps the code exactly as it is — in the facets, once, plain; email_code_hash stays NULL; disclaimer_accepted_at stays NULL; a verified guardian with emailCode null keeps the null', () => {
  const rec = guardianSignup();
  const row = guardianToRow(rec);
  assert.equal(row.email_code_hash, null, 'not hashed in S4a (readiness review §8.2)');
  assert.equal(row.disclaimer_accepted_at, null); assert.equal(row.password_hash, 'scrypt$cc$dd'); assert.equal(row.email_verified, 0);
  const facets = JSON.parse(row.facets_json);
  assert.equal(facets.emailCode, 'K7Q2ZP');
  assert.equal(row.facets_json.split('K7Q2ZP').length - 1, 1, 'exactly one copy of the code on the row');
  assert.equal(JSON.stringify(row).split('K7Q2ZP').length - 1, 1, 'no second copy in any column');
  assert.equal('childIds' in facets, false, 'childIds is not a facet (it becomes link rows)');
  sameShape(rec, roundTripGuardian(rec), 'guardian signup');
  const verified = { ...rec, emailVerified: true, emailCode: null };
  const back = roundTripGuardian(verified);
  sameShape(verified, back, 'verified guardian'); assert.equal(back.emailCode, null);
});

test('round trip: a co-guardian without password, emailVerified or createdAt stays without them (absent, not false/null); coGuardianOf goes to its column; childIds order and the primary\'s coGuardians facet are kept', () => {
  const primary = seededGuardian();
  const co = coGuardianOf(primary);
  const row = guardianToRow(co);
  assert.equal(row.password_hash, null); assert.equal(row.email_verified, 0); assert.equal(row.created_at, null); assert.equal(row.co_guardian_of, 'gd-9003');
  const back = roundTripGuardian(co);
  sameShape(co, back, 'co-guardian');
  assert.equal('password' in back, false); assert.equal('emailVerified' in back, false); assert.equal('createdAt' in back, false);
  assert.deepEqual(back.childIds, ['pl-9002', 'pl-9004']);
  const prow = guardianToRow(primary);
  assert.equal(prow.prefs_school_hours_mute, 1); assert.equal(prow.idv_reference, 'idv-1');
  const pback = roundTripGuardian(primary);
  sameShape(primary, pback, 'primary guardian');
  assert.deepEqual(pback.coGuardians, primary.coGuardians); assert.equal(pback.legacyNote, 'kept');
  // childIds comes back where it was, from the link rows, in their order; a guardian that never had the key stays without it.
  const noKids = { id: 'gd-nk', name: 'No Kids Key', email: 'nk@example.com' };
  assert.equal('childIds' in roundTripGuardian(noKids), false);
  assert.deepEqual(guardianFromRow(guardianToRow(noKids), ['pl-9002']).childIds, ['pl-9002'], 'links that exist are always served');
  const emptyKids = { id: 'gd-ek', name: 'Empty', email: 'ek@example.com', childIds: [] };
  assert.deepEqual(roundTripGuardian(emptyKids).childIds, []);
});

// ------------------------------------------------------------------ rejection
test('rejection: every unsupported player shape is refused with the field and the reason, nothing is coerced, and the input is unchanged', () => {
  const cases = [
    [{ ...adultSignup(), id: '' }, /id is empty/],
    [{ ...adultSignup(), name: null }, /name is null/],
    [{ ...adultSignup(), dob: '2001-02-30' }, /dob .*no such day/],
    [{ ...adultSignup(), dob: '20-01-2001' }, /dob .*wrong shape/],
    [{ ...adultSignup(), dob: 1234 }, /dob .*not text/],
    [{ ...adultSignup(), country: undefined }, /country is absent/],
    [{ ...adultSignup(), position: 'striker' }, /position is not one of/],
    [{ ...adultSignup(), foot: 'both' }, /foot is not one of/],
    [{ ...adultSignup(), level: null }, /level is null/],
    [{ ...adultSignup(), availability: 'maybe' }, /availability is not one of/],
    [{ ...adultSignup(), contractStatus: 'tbd' }, /contractStatus is not one of/],
    [{ ...adultSignup(), contractUntil: '2026-13-01' }, /contractUntil is not a valid/],
    [{ ...adultSignup(), heightCm: 180.5 }, /heightCm is 180.5, not an integer/],
    [{ ...adultSignup(), squadNumber: '22' }, /squadNumber is a string, not an integer/],
    [{ ...adultSignup(), academyPlus: 'yes' }, /academyPlus is a string, not a boolean/],
    [{ ...adultSignup(), createdAt: -1 }, /createdAt is -1, below 0/],
    [{ ...adultSignup(), createdAt: '2026' }, /createdAt is a string/],
    [{ ...adultSignup(), stats: 'none' }, /stats is a string, not an object/],
    [{ ...adultSignup(), stats: { goals: 2.5 } }, /stats.goals is 2.5, not an integer/],
    [{ ...adultSignup(), stats: { paceKmh: 'fast' } }, /stats.paceKmh is a string, not a finite number/],
    [{ ...adultSignup(), location: { lat: 1 } }, /location has one of lat\/lng without the other/],
    [{ ...adultSignup(), location: { lat: 'x', lng: 'y' } }, /location.lat is a string/],
    [{ ...adultSignup(), location: [1, 2] }, /location is an array, not an object/],
    [{ ...adultSignup(), medical: 'private' }, /medical is a string, not an object/],
    [{ ...adultSignup(), medical: { shared: 1, records: [], conditionStatus: 'unknown' } }, /medical.shared is a number, not a boolean/],
    [{ ...adultSignup(), medical: { shared: false, records: {}, conditionStatus: 'unknown' } }, /medical.records is an object, not an array/],
    [{ ...adultSignup(), medical: { shared: false, records: [], conditionStatus: null } }, /medical.conditionStatus is null/],
    [{ ...adultSignup(), notificationPrefs: { schoolHoursMute: 'no' } }, /notificationPrefs.schoolHoursMute is a string/],
    [{ ...adultSignup(), programme: { track: 5 } }, /programme.track is a number, not text/],
    [{ ...adultSignup(), programme: { completed: 'none' } }, /programme.completed is a string, not an array/],
    [{ ...adultSignup(), media: {} }, /media is an object, not an array/],
    [{ ...adultSignup(), drillResults: null, attendance: 'x' }, /attendance is a string, not an array/],
    [{ ...adultSignup(), __meta: {} }, /reserved field "__meta"/],
    [{ ...adultSignup(), weird: { n: 1n } }, /weird cannot be stored as JSON/],
    ['not a record', /not an object/],
  ];
  for (const [rec, re] of cases) {
    const before = typeof rec === 'object' ? JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? 'BIGINT' : v)) : rec;
    const v = validatePlayerRecord(rec);
    assert.equal(v.ok, false, `refused: ${re}`);
    assert.ok(v.problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(v.problems)}`);
    const after = typeof rec === 'object' ? JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? 'BIGINT' : v)) : rec;
    assert.equal(after, before, 'the input is unchanged');
  }
  // A record with several problems reports all of them.
  const multi = validatePlayerRecord({ id: 'pl-multi', name: 'M', dob: 'nope', country: '', foot: 'both', level: 'elite' });
  assert.equal(multi.problems.length, 4, JSON.stringify(multi.problems));
  // Absent is not invalid.
  assert.deepEqual(validatePlayerRecord({ id: 'pl-ok', name: 'Ok', dob: '2000-01-01', country: 'GB' }), { ok: true });
  assert.deepEqual(validatePlayerRecord(seededAdult()), { ok: true });
});

test('rejection: every unsupported guardian shape is refused with a reason, the e-mail code is never quoted, absent optional fields are accepted', () => {
  const cases = [
    [{ ...guardianSignup(), id: 7 }, /id is a number, not text/],
    [{ ...guardianSignup(), name: '' }, /name is empty/],
    [{ ...guardianSignup(), email: null }, /email is null/],
    [{ ...guardianSignup(), password: 12 }, /password is a number/],
    [{ ...guardianSignup(), emailCode: 123456 }, /emailCode is a number, not text/],
    [{ ...guardianSignup(), emailVerified: 'true' }, /emailVerified is a string, not a boolean/],
    [{ ...guardianSignup(), childIds: 'pl-1' }, /childIds is a string, not an array/],
    [{ ...guardianSignup(), childIds: ['pl-1', 7, ''] }, /childIds\[1\] is a number/],
    [{ ...guardianSignup(), coGuardianOf: ['gd-1'] }, /coGuardianOf is an array/],
    [{ ...guardianSignup(), coGuardians: 'none' }, /coGuardians is a string/],
    [{ ...guardianSignup(), notificationPrefs: 'quiet' }, /notificationPrefs is a string/],
    [{ ...guardianSignup(), createdAt: 1.5 }, /createdAt is 1.5, not an integer/],
    [{ ...guardianSignup(), __rest: {} }, /reserved field "__rest"/],
    [null, /not an object/],
  ];
  for (const [rec, re] of cases) {
    const v = validateGuardianRecord(rec);
    assert.equal(v.ok, false, String(re));
    assert.ok(v.problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(v.problems)}`);
    assert.equal(JSON.stringify(v.problems).includes('K7Q2ZP'), false, 'the code is never reported');
  }
  assert.deepEqual(validateGuardianRecord(coGuardianOf(seededGuardian())), { ok: true });
  assert.deepEqual(validateGuardianRecord({ id: 'gd-bare', name: 'Bare', email: 'bare@example.com' }), { ok: true }, 'no childIds, no flags: absent is not invalid');
});

// ------------------------------------------------------------------ relationships
test('relationships: a consistent snapshot is complete — roles are primary where guardianId agrees and co otherwise, the co-guardian arrangement is counted, the candidate holds every row and link, and the report never carries an address, a hash or a code', () => {
  const snap = consistentSnapshot();
  const before = JSON.stringify(snap);
  const r = validateCoreIdentity(snap, { now: NOW });
  assert.equal(r.status, PREFLIGHT_STATUS.COMPLETE, JSON.stringify(r.refusals));
  assert.equal(r.evaluatedAt, NOW);
  assert.deepEqual(r.counts, { players: 4, guardians: 3, validPlayers: 4, validGuardians: 3, links: 4, primaryLinks: 2, coLinks: 2, adultsStillLinked: 0, coGuardianArrangements: 1, minorsWithCoLinksOnly: 0, refusals: 0, findings: 3, decisionsRequired: 0 });
  assert.deepEqual(r.candidate.links, [
    { guardian_id: 'gd-9003', player_id: 'pl-9002', role: 'primary' }, { guardian_id: 'gd-9003', player_id: 'pl-9004', role: 'primary' },
    { guardian_id: 'gd-9002', player_id: 'pl-9002', role: 'co' }, { guardian_id: 'gd-9002', player_id: 'pl-9004', role: 'co' },
  ]);
  assert.deepEqual(r.findings.map((f) => f.kind), ['co_guardian_arrangement', 'co_link', 'co_link']);
  assert.equal(r.candidate.players.length, 4); assert.equal(r.candidate.guardians.length, 3);
  assert.equal(r.authorises, AUTHORISES_NOTHING);
  assert.equal(JSON.stringify(snap), before, 'the input is unchanged');
  const printed = JSON.stringify(publicReport(r));
  for (const secret of ['example.com', 'scrypt$', 'K7Q2ZP', 'Parent One', 'Hamstring']) assert.equal(printed.includes(secret), false, `${secret} is not in the public report`);
  assert.deepEqual(publicReport(r).candidate, { guardians: 3, players: 4, links: 4 });
});

test('relationships: the report and the candidate links are the same whatever the input order of guardians and players', () => {
  const a = consistentSnapshot();
  const b = { players: a.players.slice().reverse(), guardians: a.guardians.slice().reverse() };
  const ra = validateCoreIdentity(a, { now: NOW }); const rb = validateCoreIdentity(b, { now: NOW });
  assert.deepEqual(publicReport(ra), publicReport(rb));
  const sortLinks = (l) => l.slice().sort((x, y) => `${x.guardian_id}/${x.player_id}`.localeCompare(`${y.guardian_id}/${y.player_id}`));
  assert.deepEqual(sortLinks(ra.candidate.links), sortLinks(rb.candidate.links));
});

test('relationships: empty collections are complete with an empty candidate; a missing or malformed collection, a non-object snapshot and unparseable records are invalid with no candidate', () => {
  const empty = validateCoreIdentity({ players: [], guardians: [] }, { now: NOW });
  assert.equal(empty.status, PREFLIGHT_STATUS.COMPLETE); assert.deepEqual(empty.candidate, { guardians: [], players: [], links: [] });
  for (const [db, re] of [
    [{ players: [] }, /guardians collection is absent/],
    [{ guardians: [] }, /players collection is absent/],
    [{ players: {}, guardians: [] }, /players collection is an object/],
    [{ players: [], guardians: null }, /guardians collection is null/],
    [null, /snapshot is null/],
    ['snapshot', /snapshot is string/],
    [{ players: ['pl-1', 7], guardians: [] }, /players #0: not an object/],
  ]) {
    const r = validateCoreIdentity(db, { now: NOW });
    assert.equal(r.status, PREFLIGHT_STATUS.INVALID, String(re)); assert.equal(r.candidate, null);
    assert.ok(r.refusals.some((x) => re.test(`${x.collection} ${x.id}: ${x.reason}`)), `${re} in ${JSON.stringify(r.refusals)}`);
  }
});

test('relationships: duplicate ids, duplicate e-mails under lower(email), dangling references, primary-link disagreement, duplicate links, a self co-guardian and an invalid date are each refused by id with the reason — and the refusal set is complete, not first-problem-only', () => {
  const snap = consistentSnapshot();
  snap.players.push({ ...adultSignup(), id: 'pl-9001' });                          // duplicate player id
  snap.guardians.push({ ...guardianSignup('gd-9001-dup', 'PARENT.ONE@example.com') }); // duplicate email (different id)
  snap.players.push({ ...childOf('gd-missing', 'pl-dangling', '2015-01-01') });      // guardianId → nobody
  snap.guardians.push({ id: 'gd-self', name: 'Self', email: 'self@example.com', childIds: [], coGuardianOf: 'gd-self' });
  snap.guardians.push({ id: 'gd-ghost', name: 'Ghost', email: 'ghost@example.com', childIds: ['pl-nobody', 'pl-9004', 'pl-9004'], coGuardianOf: 'gd-nowhere' });
  snap.players.push({ ...childOf('gd-9001', 'pl-disagree', '2015-02-02') });        // gd-9001's childIds is [] → disagreement
  snap.players.push({ ...childOf('gd-9003', 'pl-baddate', '2015-02-30') });         // invalid date (and listed by nobody)
  const before = JSON.stringify(snap);
  const r = validateCoreIdentity(snap, { now: NOW });
  assert.equal(r.status, PREFLIGHT_STATUS.INVALID); assert.equal(r.candidate, null);
  const has = (collection, id, re) => assert.ok(r.refusals.some((x) => x.collection === collection && x.id === id && re.test(x.reason)), `${collection} ${id} ${re} in ${JSON.stringify(r.refusals, null, 1)}`);
  has('players', 'pl-9001', /duplicate id \(2 records\)/);
  has('guardians', 'gd-9001', /shares its e-mail .* with gd-9001-dup/); has('guardians', 'gd-9001-dup', /shares its e-mail .* with gd-9001/);
  has('players', 'pl-dangling', /guardianId names no record \(gd-missing\)/);
  has('guardians', 'gd-self', /coGuardianOf names itself/);
  has('guardians', 'gd-ghost', /childIds names no record \(pl-nobody\)/); has('guardians', 'gd-ghost', /lists pl-9004 more than once/); has('guardians', 'gd-ghost', /coGuardianOf names no record \(gd-nowhere\)/);
  has('players', 'pl-disagree', /does not list the player/);
  has('players', 'pl-baddate', /dob is not a valid YYYY-MM-DD date \(no such day in that month\)/);
  assert.equal(JSON.stringify(r.refusals).includes('example.com'), false, 'no address in the report');
  assert.equal(JSON.stringify(snap), before, 'refused input is unchanged');
  // Sorted, so two runs print identically.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  assert.deepEqual(r.refusals, r.refusals.slice().sort((a, b) => cmp(a.collection, b.collection) || cmp(String(a.id), String(b.id)) || cmp(a.reason, b.reason)));
  assert.deepEqual(r, validateCoreIdentity(JSON.parse(before), { now: NOW }), 'a second run over the same input produces the same report');
});

test('relationships: a legacy minor with no guardian link blocks on the undecided rule — listed by id, not admitted, not deleted, no guardian invented, no candidate; the same data with the link resolved is complete', () => {
  const snap = consistentSnapshot();
  snap.players.push({ ...childOf(null, 'pl-legacy-minor', '2013-04-04') });
  const r = validateCoreIdentity(snap, { now: NOW });
  assert.equal(r.status, PREFLIGHT_STATUS.BLOCKED_ON_DECISION);
  assert.equal(r.candidate, null, 'no candidate while the rule is undecided (a candidate would admit the record)');
  assert.deepEqual(r.decisionsRequired, [{ kind: DECISION_MINOR_WITHOUT_LINK, id: 'pl-legacy-minor' }]);
  assert.equal(r.refusals.length, 0, 'not a refusal: the record itself is valid');
  assert.equal(snap.players.length, 5, 'nothing deleted'); assert.equal(snap.guardians.length, 3, 'no guardian created');
  // Unknown age is not adult: a minor is decided by isAdult (domain.mjs); on an evaluation date after the 18th birthday the same record is an adult without a link — complete, no finding.
  const later = validateCoreIdentity(snap, { now: Date.UTC(2031, 3, 5) });
  assert.equal(later.status, PREFLIGHT_STATUS.COMPLETE); assert.equal(later.counts.decisionsRequired, 0);
  // Resolved by hand (a guardian lists the child and the child names it): complete.
  const resolved = consistentSnapshot();
  resolved.players.push({ ...childOf('gd-9003', 'pl-legacy-minor', '2013-04-04') });
  resolved.guardians[0].childIds.push('pl-legacy-minor');
  assert.equal(validateCoreIdentity(resolved, { now: NOW }).status, PREFLIGHT_STATUS.COMPLETE);
});

test('relationships: an adult still linked, and a minor listed only as a co child, are counted findings that keep the report complete — distinct from malformed references', () => {
  const snap = consistentSnapshot();
  // An adult (born 2004) still listed by the primary guardian and still naming it (the seed has one such record).
  snap.players[2].guardianId = 'gd-9003'; snap.guardians[0].childIds.push('pl-9003'); snap.guardians[1].childIds.push('pl-9003');
  // A minor with guardianId null but listed by a guardian: a co link only, no primary.
  snap.players.push({ ...childOf(null, 'pl-co-only', '2015-05-05') }); snap.guardians[2].childIds.push('pl-co-only');
  const r = validateCoreIdentity(snap, { now: NOW });
  assert.equal(r.status, PREFLIGHT_STATUS.COMPLETE, JSON.stringify(r.refusals));
  assert.equal(r.counts.adultsStillLinked, 1); assert.equal(r.counts.minorsWithCoLinksOnly, 1);
  assert.ok(r.findings.some((f) => f.kind === 'adult_still_linked' && f.id === 'pl-9003' && /gd-9002, gd-9003/.test(f.detail)));
  assert.ok(r.findings.some((f) => f.kind === 'minor_with_co_links_only' && f.id === 'pl-co-only'));
  assert.ok(r.candidate.links.some((l) => l.guardian_id === 'gd-9001' && l.player_id === 'pl-co-only' && l.role === 'co'));
  assert.ok(r.candidate.links.some((l) => l.guardian_id === 'gd-9003' && l.player_id === 'pl-9003' && l.role === 'primary'));
  assert.ok(r.candidate.links.some((l) => l.guardian_id === 'gd-9002' && l.player_id === 'pl-9003' && l.role === 'co'));
});

// ------------------------------------------------------------------ SQL
test('SQL: the candidate loads into the intended STRICT tables with foreign keys on — every row, every link, foreign_key_check empty, the unique e-mail index in force — and reads back byte-identical through the mapping', () => {
  const snap = consistentSnapshot();
  const r = validateCoreIdentity(snap, { now: NOW });
  const s = memDb();
  const counts = transaction(s, () => writeCandidate(s, r.candidate));
  assert.deepEqual(counts, { guardians: 3, players: 4, links: 4 });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 4);
  assert.equal(s.prepare("SELECT co_guardian_of FROM guardians WHERE id = 'gd-9002'").get().co_guardian_of, 'gd-9003');
  assert.equal(s.prepare("SELECT role FROM guardian_children WHERE guardian_id = 'gd-9002' AND player_id = 'pl-9002'").get().role, 'co');
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  // Read back: columns + facets → the same records, including childIds from the link rows in rowid order.
  const prow = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE id = ?`);
  for (const p of snap.players) sameShape(p, playerFromRow(prow.get(p.id)), `players ${p.id} through SQLite`);
  const grow = s.prepare(`SELECT ${GUARDIAN_COLUMNS.join(', ')} FROM guardians WHERE id = ?`);
  const kids = s.prepare('SELECT player_id FROM guardian_children WHERE guardian_id = ? ORDER BY rowid');
  for (const g of snap.guardians) sameShape(g, guardianFromRow(grow.get(g.id), kids.all(g.id).map((k) => k.player_id)), `guardians ${g.id} through SQLite`);
  // The constraints are real: a row that bypasses validation is refused by SQLite itself.
  assert.throws(() => s.prepare("INSERT INTO guardians (id, name, email) VALUES ('gd-dupmail', 'Dup', 'AMARA.SEED@example.com')").run(), /UNIQUE/);
  assert.throws(() => s.prepare("INSERT INTO players (id, name, birth_date, country, foot) VALUES ('pl-x', 'X', '2000-01-01', 'GB', 'both')").run(), /CHECK/);
  assert.throws(() => s.prepare("INSERT INTO players (id, name, birth_date, country, height_cm) VALUES ('pl-y', 'Y', '2000-01-01', 'GB', 'tall')").run(), /datatype mismatch|cannot store/i);
  assert.throws(() => s.prepare("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES ('gd-9003', 'pl-nobody', 'co')").run(), /FOREIGN KEY/);
  assert.throws(() => s.prepare("INSERT INTO guardians (id, name, email, facets_json) VALUES ('gd-badjson', 'B', 'b@example.com', '{not json')").run(), /CHECK/);
  s.close();
});

test('SQL: every player and guardian row of every fixture shape fits the table — no refused input is ever written, and a failing write inside a transaction leaves the candidate tables empty', () => {
  const s = memDb();
  for (const rec of [adultSignup(), childOf('gd-9003'), seededAdult(), { id: 'pl-min', name: 'Minimal', dob: '2003-01-01', country: 'FR' }]) {
    // The inserts themselves succeed (the row fits every CHECK and type); the deliberate throw afterwards rolls the transaction back.
    assert.throws(() => transaction(s, () => { s.prepare(`INSERT INTO guardians (id, name, email) VALUES ('gd-9003', 'G', 'g@example.com')`).run(); s.prepare(`INSERT INTO players (${PLAYER_COLUMNS.join(', ')}) VALUES (${PLAYER_COLUMNS.map((c) => `@${c}`).join(', ')})`).run(playerToRow(rec)); throw new Error('roll it back'); }), /^Error: roll it back$/);
  }
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  for (const rec of [guardianSignup(), coGuardianOf(seededGuardian()), seededGuardian(), { id: 'gd-bare', name: 'Bare', email: 'bare@example.com' }]) {
    const row = guardianToRow(rec); row.co_guardian_of = null;
    transaction(s, () => s.prepare(`INSERT INTO guardians (${GUARDIAN_COLUMNS.join(', ')}) VALUES (${GUARDIAN_COLUMNS.map((c) => `@${c}`).join(', ')})`).run(row));
  }
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 4);
  // writeCandidate refuses anything that is not a candidate (a report that is not complete has none).
  assert.throws(() => writeCandidate(s, null), /needs a candidate/);
  assert.throws(() => writeCandidate(s, validateCoreIdentity({ players: [{ id: 'pl-bad' }], guardians: [] }, { now: NOW }).candidate), /needs a candidate/);
  s.close();
});

test('SQL: the candidate DDL is the documented identity DDL plus facets_json on players and guardians, nothing else; it is not a registered migration', async () => {
  const docs = new DatabaseSync(':memory:');
  docs.exec(fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'sql', '01_identity.sql'), 'utf8'));
  const cand = memDb();
  const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
  for (const t of ['guardians', 'players', 'guardian_children']) {
    const expected = cols(docs, t); const actual = cols(cand, t);
    if (t !== 'guardian_children') {
      assert.equal(actual.at(-1), 'facets_json:TEXT:0:0:', `${t} ends with facets_json`);
      // players: facets_json sits before the table CHECK in the DDL but is the last column either way.
      assert.deepEqual(actual.slice(0, -1), expected, `${t} columns`);
    } else assert.deepEqual(actual, expected);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(t).map((r) => r.name);
    assert.deepEqual(idx(cand), idx(docs), `${t} indexes`);
    assert.match(cand.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/i);
  }
  const { DATA_MIGRATIONS } = await import('../repositories/index.mjs');
  assert.equal(DATA_MIGRATIONS.some((m) => /0005|core_identity_live/.test(m.id)), false, 'migration 0005 is not registered');
  assert.throws(() => createCandidateSchema(cand), /already exist/);
  docs.close(); cand.close();
});

// ------------------------------------------------------------------ the preflight command
test('preflight: run on a data directory it leaves the source byte-identical, applies no migration, starts no server, reads only the two blobs, and prints a deterministic report with the right exit code', () => {
  const dir = tempDir('preflight-src');
  const snap = consistentSnapshot();
  // A plain snapshot store (no data layer, no migrations): exactly a backup or a pre-S0 file.
  const store = openStore(dir);
  store.save({ savedAt: NOW, idCounter: 9100, db: { ...snap, orgs: [], users: [], sessions: [], requests: [{ id: 'req-1' }] } });
  store.sqlite.close();
  const file = path.join(dir, 'scoutbox.db');
  const before = sha256(fs.readFileSync(file));
  const walBefore = fs.existsSync(`${file}-wal`) ? sha256(fs.readFileSync(`${file}-wal`)) : null;
  const script = path.join(HERE, 'preflightCoreIdentity.mjs');
  const run = (...extra) => spawnSync(process.execPath, [script, dir, '--now', String(NOW), ...extra], { encoding: 'utf8' });
  const a = run('--json'); const b = run('--json');
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(a.stdout, b.stdout, 'two runs print the same report');
  const out = JSON.parse(a.stdout);
  assert.equal(out.status, 'complete'); assert.deepEqual(out.source.blobs, ['players', 'guardians']); assert.deepEqual(out.source.migrationsRecorded, []);
  assert.equal(out.source.alreadyCutOver, false); assert.deepEqual(out.candidate, { guardians: 3, players: 4, links: 4 }); assert.equal(out.authorises, AUTHORISES_NOTHING);
  for (const secret of ['example.com', 'scrypt$', 'K7Q2ZP', 'Parent One']) assert.equal(a.stdout.includes(secret), false, `${secret} is not printed`);
  assert.equal(sha256(fs.readFileSync(file)), before, 'the source file is byte-identical');
  // A read-only open of a WAL-mode file makes SQLite create its -wal/-shm side files when they are missing; they hold
  // nothing (no frame was written). What matters is that no content was written anywhere: an empty log, or the one that
  // was there before, and a main file that did not change.
  const walAfter = fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`) : null;
  assert.ok(walAfter === null || walAfter.length === 0 || sha256(walAfter) === walBefore, 'no write-ahead-log frame was written');
  const ro = new DatabaseSync(file, { readOnly: true });
  assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('data_migrations', 'guardians', 'players', 'guardian_children', 'org_users')").get().n, 0, 'no migration ran against the source');
  ro.close();
  const text = run();
  assert.equal(text.status, 0); assert.match(text.stdout, /status: complete/); assert.match(text.stdout, /not written anywhere/); assert.match(text.stdout, /does not approve/);
  // Invalid and blocked sources exit 2 and 3 and never print a candidate.
  const blockedDir = tempDir('preflight-blocked');
  const s2 = openStore(blockedDir); const blocked = consistentSnapshot(); blocked.players.push(childOf(null, 'pl-legacy', '2013-01-01'));
  s2.save({ savedAt: NOW, idCounter: 1, db: { ...blocked, orgs: [], users: [], sessions: [] } }); s2.sqlite.close();
  const rb = spawnSync(process.execPath, [script, blockedDir, '--now', String(NOW)], { encoding: 'utf8' });
  assert.equal(rb.status, 3, rb.stdout); assert.match(rb.stdout, /decision required pl-legacy: legacy_minor_without_guardian_link/); assert.match(rb.stdout, /candidate: none/);
  const invalidJson = path.join(tempDir('preflight-json'), 'snapshot.json');
  fs.writeFileSync(invalidJson, JSON.stringify({ db: { players: [{ ...adultSignup(), foot: 'both' }], guardians: [] } }));
  const ri = spawnSync(process.execPath, [script, invalidJson, '--now', String(NOW), '--json'], { encoding: 'utf8' });
  assert.equal(ri.status, 2); const oi = JSON.parse(ri.stdout); assert.equal(oi.status, 'invalid'); assert.equal(oi.source.kind, 'json'); assert.equal(oi.candidate, null);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'nowhere')], { encoding: 'utf8' }).status, 4);
  // The command's module graph never reaches the server, the data layer's attach or the migration runner.
  const src = fs.readFileSync(script, 'utf8');
  for (const forbidden of ['server.mjs', 'attachDataLayer', 'runDataMigrations', '.listen(']) assert.equal(src.includes(forbidden), false, `${forbidden} is not used by the preflight`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(blockedDir, { recursive: true, force: true }); fs.rmSync(path.dirname(invalidJson), { recursive: true, force: true });
});

test('preflight: a file that already records the live cutover is reported invalid rather than re-validated as blobs', () => {
  const dir = tempDir('preflight-cut');
  const store = openStore(dir);
  store.save({ savedAt: NOW, idCounter: 1, db: { players: [], guardians: [], orgs: [], users: [], sessions: [] } });
  store.sqlite.exec("CREATE TABLE data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO data_migrations VALUES ('0005_core_identity_live', 1)");
  store.sqlite.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'preflightCoreIdentity.mjs'), dir, '--json', '--now', String(NOW)], { encoding: 'utf8' });
  assert.equal(r.status, 2); const out = JSON.parse(r.stdout);
  assert.equal(out.source.alreadyCutOver, true); assert.match(out.refusals[0].reason, /already recorded/); assert.equal(out.candidate, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mapping: the migrated key sets name exactly the columns the schema owns (a drift between the spec and the DDL fails here)', () => {
  const s = memDb();
  const playerCols = new Set(s.prepare('PRAGMA table_info(players)').all().map((c) => c.name));
  for (const c of PLAYER_COLUMNS) assert.ok(playerCols.has(c), `players.${c}`);
  assert.equal(playerCols.size, PLAYER_COLUMNS.length);
  const guardianCols = new Set(s.prepare('PRAGMA table_info(guardians)').all().map((c) => c.name));
  for (const c of GUARDIAN_COLUMNS) assert.ok(guardianCols.has(c), `guardians.${c}`);
  assert.equal(guardianCols.size, GUARDIAN_COLUMNS.length);
  assert.ok(PLAYER_MIGRATED_KEYS.has('dob') && PLAYER_MIGRATED_KEYS.has('medical') && !PLAYER_MIGRATED_KEYS.has('media'));
  s.close();
});

console.log(`\n${passed} core-identity mapping checks passed`);
