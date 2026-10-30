// S5 — player sub-records in their SQLite tables (docs/architecture/s5-player-subrecords.md):
// the item mapping for all twelve tables, the validator's refusals by field and
// index, migration 0007 on S4a-shaped files (import, verification, retirement,
// the trialReports reconciliation and every blocking case, repeat boot, a first
// installation, an intentionally empty domain), the repository's addItem /
// setItems / patchItem with a real store (standalone COMMIT failure, a caught
// failure inside a unit, a real COMMIT failure, retry), snapshot replacement
// under the child foreign keys, media ownership through player_media, the
// audience allowlists, and the copy-only rollback tool with its refusals and the
// re-upgrade round trip. Every database is a throwaway file with synthetic
// records. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { playerToRow, playerFromRow, PLAYER_COLUMNS } from '../repositories/identityMapping.mjs';
import {
  SUBRECORDS_DDL, SUBRECORD_TABLES, SUBRECORD_KEYS, PLAYER_SUBRECORDS_MIGRATION, validateSubrecordArray, validatePlayerRecordWithItems, prepareSubrecordStatements,
  writeChildRows, readChildren, readAllChildren, trialReportsFor, reconcileTrialReports, readPlayersWithChildren, subrecordsLive,
} from '../repositories/playerSubrecords.mjs';
import { createIdentityRepositories, IDENTITY_SNAPSHOT } from '../repositories/identity.mjs';
import { createMediaDeletionsQueue, liveMediaReferences, assertMediaQueueConsistent } from '../repositories/mediaDeletions.mjs';
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { rollbackOutboxPushCopy } from '../repositories/outboxPushRollback.mjs';
import { rollbackChannelsCopy } from '../repositories/channelsRollback.mjs';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';
import { rollbackPlayerErasureCopy } from '../repositories/playerErasureRollback.mjs';
import { rollbackRecruitmentCopy } from '../repositories/recruitmentRollback.mjs';
import { rollbackRecruitmentCasesCopy } from '../repositories/recruitmentCasesRollback.mjs';
import { rollbackToPreS8c as rollbackRecruitmentContactsOffersCopy } from '../repositories/rollbackChain.mjs'; // S8d: the S8d step-back then the S8c tool, as one link (a live file carries 0018)
import { readTrialsCollection, RECRUITMENT_TABLES } from '../repositories/recruitment.mjs';
import { RECRUITMENT_CASES_TABLES } from '../repositories/recruitmentCases.mjs';
import { SIGNINGS_FOLLOWUPS_TABLES } from '../repositories/signingsFollowUps.mjs';
import { rollbackCoreIdentityCopy } from '../repositories/coreIdentityRollback.mjs';
import { PLAYER_SUBRECORDS_CUTOVER_META, BLOCKED } from '../repositories/migrations/0007_player_subrecords.mjs';
import { orgPlayerView } from '../views/playerViews.mjs';
import { openStore } from '../store.mjs';
import { prepareLiveIdentitySchema } from './identityLiveTestSchema.mjs';
import {
  NOW, DAY, TTL, tempDir, clone, adult, child, seeded, gPrimary, gCo, gSignup, FIXTURE, ORGS, USERS, SESSIONS, EXTRA,
  s3File, freshFile, openRaw, migrate, applied, blob, dump, meta, sessionRows, filesDigest, failRunAt, identityDump,
} from './coreIdentityTestFixtures.mjs';
// S6b: a file this tree wrote carries 0013 too; the S7d tool refuses a later schema step, so the rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6b = (file) => { const s8c = tempDir('s8c-to-s8b'); rollbackRecruitmentContactsOffersCopy(file, s8c); /* S8c: the file carries 0017; its rollback (copy-only, the contacts and offers written back as blobs) goes first */ const s8b = tempDir('s8b-to-s8a'); rollbackRecruitmentCasesCopy(path.join(s8c, 'scoutbox.db'), s8b); /* then S8b: the file carries 0016; its rollback (copy-only, the cases and the four room collections written back as blobs) goes first */ const s8a = tempDir('s8a-to-s4br'); rollbackRecruitmentCopy(path.join(s8b, 'scoutbox.db'), s8a); /* then S8a (requests and trials written back as blobs) */ const s4br = tempDir('s4br-to-s6b'); rollbackPlayerErasureCopy(path.join(s8a, 'scoutbox.db'), s4br); /* then S4b-R */ const out = tempDir('s6b-to-s7d'); rollbackSafetyAuditCopy(path.join(s4br, 'scoutbox.db'), out); return path.join(out, 'scoutbox.db'); };

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
/** S6a: a live file carries 0008, which the S5 tool refuses outright (LATER_SCHEMA); the chain is the S6a rollback (copy-only, codes invalidated, everything else kept) and then the S5 tool on ITS output. Returns the S5-shaped copy's directory. */
const s5Copy = (dir) => { const s7c = tempDir('s7d-to-s7c'); rollbackChannelsCopy(preS6b(dbFile(dir)), s7c); /* S7d first: the live file carries 0012 */ const s7b = tempDir('s7c-to-s7b'); rollbackOutboxPushCopy(dbFile(s7c), s7b); const s7a = tempDir('s7b-to-s7a'); rollbackDispatchesCopy(dbFile(s7b), s7a); const s6a = tempDir('s7a-to-s6a'); rollbackNotificationsCopy(dbFile(s7a), s6a); const out = tempDir('s6a-to-s5'); rollbackOneTimeCodesCopy(dbFile(s6a), out); return out; }; // S7a: the live file carries 0009 too; the S7a rollback (copy-only, nothing lost) goes first
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const sameJson = (a, b, what) => assert.equal(JSON.stringify(b), JSON.stringify(a), `${what}: byte-identical JSON`);
const S4A_MIGRATIONS = DATA_MIGRATIONS.filter((m) => m.id < PLAYER_SUBRECORDS_MIGRATION); // 0001–0006: what an S4a-shaped file has applied (0008 is later than 0007 too)
const count = (s, t, where = '', ...p) => s.prepare(`SELECT COUNT(*) AS n FROM ${t} ${where}`).get(...p).n;

// ------------------------------------------------------------------ fixtures
const report = (id, playerId, filedAt, extra = {}) => ({ id, trialId: `tr-${id}`, playerId, orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', filedAt, acceleration: 7, sprintSpeedKmh: 31, distanceKm: 9.5, passCompletionPct: 80, duelSuccessPct: 55, coachRating: 8, notes: 'private club notes', strengthNote: null, focusNote: null, ...extra });
const trialOf = (rep) => ({ id: rep.trialId, requestId: `req-${rep.trialId}`, playerId: rep.playerId, orgId: rep.orgId, orgName: rep.orgName, status: 'reported', acceptedAt: NOW - 5 * DAY, report: rep });
/** S8a: the trials are rows of `trials` since migration 0015 and every trial names a request of `recruitment_requests` — the pre-P4B pair (the request carries no trialId key). */
const requestOf = (rep) => ({ id: `req-${rep.trialId}`, playerId: rep.playerId, playerName: 'Synthetic', orgId: rep.orgId, orgName: rep.orgName, orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false, userId: rep.userId, scoutName: rep.scoutName, scoutRole: 'Head of Recruitment', type: 'trial', message: 'Synthetic invitation.', trialDetails: { proposedDate: '2026-09-01', altSlots: [], venue: 'Old ground', notes: '' }, status: 'accepted', createdAt: NOW - 6 * DAY, respondedAt: NOW - 5 * DAY, respondedBy: 'player', routedTo: 'player', guardianId: null, contactChannel: null });
const recruitmentBlobs = () => ({ trials: trials(), requests: trials().map((t) => requestOf(t.report)) });
/** A trial filed after the cutover, through the recruitment repository (the former `db.trials.push`): its request first, then the trial. */
const addTrial = (t, rep) => { t.layer.recruitment.addRequest(requestOf(rep)); return t.layer.recruitment.addTrial(trialOf(rep)); };
/** A player with EVERY array populated, unknown item fields, prototype-named keys, nulls and legal duplicates (built from JSON, as a snapshot arrives). */
const rich = () => JSON.parse(JSON.stringify({
  id: 'pl-rich', name: 'Rich Record', dob: '2000-02-02', country: 'GB', city: 'Leeds', position: 'CM', foot: 'left', heightCm: 180, weightKg: 75,
  seasonHistory: [{ season: '2025/26', appearances: 12.5, goals: 3, assists: 1, extraStat: 'kept' }, { season: '2024/25', appearances: 20, goals: 0, assists: 0, paceKmh: 31.2 }],
  badges: ['Finisher', 'Captain', 'Finisher'],
  attendance: [
    { id: 'att-r1', fixture: 'Cup Final', venue: 'Hough End', date: '2026-06-01', gps: { lat: 53.43, lng: -2.26 }, deviceConfirmed: true, verified: true, note: { unknown: true } },
    { id: 'att-r2', fixture: 'Trial day · Eastport FC', venue: '', date: '2026-07-01', gps: null, verified: true, corroboratedBy: 'Eastport FC', trialId: 'tr-rep-1' },
  ],
  timeline: [{ year: '2019', event: 'Joined academy' }, { year: '2019', event: 'Joined academy' }],
  media: [
    { id: 'med-r1', title: 'Highlights', kind: 'video', uploadedAt: '2026-05-01T10:00:00.000Z', url: '/media/med-r1', views: 3, tags: { pace: 2, vision: 1 }, verifiedClip: 'att-r1', captions: null, sizeBytes: 1024, thumbnail: { w: 1 } },
    { id: 'med-r2', title: 'Older shape', kind: 'video', uploadedAt: '2026-04-01T10:00:00.000Z' },
    { id: 'med-r3', title: 'Box clip', kind: 'video', uploadedAt: '2026-04-02T10:00:00.000Z', url: null, views: 0, tags: {}, verifiedClip: null, captions: 'WEBVTT\n', capturedBy: 'box_cam', boxSessionId: 'bs-1' },
  ],
  trialReports: [report('rep-1', 'pl-rich', NOW - 4 * DAY), report('rep-2', 'pl-rich', NOW - 2 * DAY)],
  medical: { shared: true, records: [{ id: 'md-r1', type: 'injury', title: 'Hamstring', date: '2025-11-02', layoffWeeks: 3.5, cleared: null, constructor: 'own' }, { id: 'md-r2', type: 'note', title: 'Note', date: '2026-01-15', layoffWeeks: null, cleared: false }], conditionStatus: 'fully_fit', futureSub: 1 },
  identityVerified: true, academyPlus: false, guardianId: null, squadNumber: null, contractUntil: null, marketValueRange: null, agentName: null,
  availability: 'not_seeking', contractStatus: 'unknown', drills: ['drill-sprint-ladder', 'drill-passing-gates'],
  drillResults: [{ id: 'dr-r1', drillId: 'drill-sprint-ladder', drillName: 'Sprint ladder — 6×30m', metric: 'best 30m time', unit: 's', value: 4.2, verified: false, ts: NOW - 3 * DAY }, { id: 'dr-r2', drillId: 'drill-passing-gates', drillName: null, metric: 'gates hit of 20', unit: '/20', value: 14, verified: true, ts: NOW - DAY, __proto__: { x: 1 } }],
  activityLog: [NOW - 3 * DAY, NOW - DAY, NOW - DAY],
  externalIds: [{ provider: 'fa', externalId: 'FA-1', source: 'import:b1', by: 'Maria', at: NOW - 9 * DAY, claim: { name: 'Rich Record', dob: '2000-02-02', nested: { a: [1, 2] } } }],
  createdAt: NOW - 100 * DAY, password: null, level: 'amateur', location: null, stats: null,
  notificationPrefs: null, programme: { track: 'CM', startedAt: NOW - 20 * DAY, completed: [{ sessionId: 's1', ts: NOW - 19 * DAY }, { sessionId: 's1', ts: NOW - 12 * DAY }] }, firstTeamSeeker: false,
  unknownBag: { keep: true },
}));
/** Shape variants: an absent array, a null array, an empty array, a null composite remainder. */
const sparse = () => ({ ...adult(), id: 'pl-sparse', media: null, badges: [], medical: { shared: false, records: null, conditionStatus: 'unknown' }, programme: null, trialReports: null });
const noKeys = () => { const p = { ...adult(), id: 'pl-nokeys' }; for (const k of ['media', 'attendance', 'timeline', 'badges', 'drills', 'seasonHistory', 'trialReports']) delete p[k]; return p; };
const trials = () => rich().trialReports.map(trialOf);

/** A temporary database with the live identity schema (0005) and the S5 tables (0007) as the migration leaves them. */
function liveDb({ subrecords = true } = {}) {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id)), { now: NOW, context: { sessionTtlMs: TTL } });
  prepareLiveIdentitySchema(s, { initState: 'done', now: NOW, subrecords });
  return s;
}
const insertPlayerSql = `INSERT INTO players (${PLAYER_COLUMNS.join(', ')}) VALUES (${PLAYER_COLUMNS.map((c) => `@${c}`).join(', ')})`;
/** Write a record the S5 way (row without the arrays + child rows) and read it back through the S5 path. */
function roundTrip(s, rec, { trialReports } = {}) {
  const st = prepareSubrecordStatements(s);
  transaction(s, () => { s.prepare(insertPlayerSql).run(playerToRow(rec, { subrecords: 'tables' })); writeChildRows(st, rec); });
  const row = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE id = ?`).get(rec.id);
  return { row, back: playerFromRow(row, { children: readChildren(st, rec.id), trialReports }) };
}

// ------------------------------------------------------------------ the mapping
test('mapping: every array of a record with populated, empty, null and absent arrays round-trips byte for byte through the twelve tables — item key order, explicit nulls, unknown item fields, prototype-named keys, legal duplicates (a badge twice, two activities in one millisecond, a session completed twice), tag order, the gps composite, the split composites; facets_json keeps no array, only unknown fields and shape metadata', () => {
  const s = liveDb();
  for (const rec of [rich(), sparse(), noKeys(), adult(), seeded(), child('pl-c', null, '2001-01-01')]) {
    const expectedTrialReports = Array.isArray(rec.trialReports) ? rec.trialReports : undefined;
    const { row, back } = roundTrip(s, rec, { trialReports: expectedTrialReports ?? (rec.trialReports === null ? [] : undefined) });
    sameJson(rec, back, `players ${rec.id} through the S5 tables`);
    assert.deepEqual(Object.keys(back), Object.keys(rec), `${rec.id}: key order`);
    const facets = JSON.parse(row.facets_json);
    for (const key of ['media', 'attendance', 'timeline', 'badges', 'drills', 'drillResults', 'activityLog', 'externalIds', 'seasonHistory', 'trialReports']) assert.equal(key in facets, false, `${rec.id}: ${key} is not a facet`);
    assert.equal(facets.medical?.records, undefined); assert.equal(facets.programme?.completed, undefined);
  }
  const r = rich();
  assert.equal(count(s, 'player_badges', 'WHERE player_id = ?', 'pl-rich'), 3, 'the duplicate badge is a row of its own');
  assert.equal(count(s, 'player_activity_log', 'WHERE player_id = ?', 'pl-rich'), 3); assert.equal(count(s, 'player_programme_completions', 'WHERE player_id = ?', 'pl-rich'), 2);
  assert.deepEqual(s.prepare("SELECT tag, count FROM player_media_tags WHERE media_id = 'med-r1' ORDER BY position").all().map((t) => [t.tag, t.count]), [['pace', 2], ['vision', 1]]);
  assert.equal(JSON.parse(s.prepare("SELECT extra_json FROM player_media WHERE id = 'med-r1'").get().extra_json).thumbnail.w, 1, 'an unknown item field rides in extra_json');
  assert.equal(s.prepare("SELECT claim_json FROM player_external_ids WHERE player_id = 'pl-rich'").get().claim_json, JSON.stringify(r.externalIds[0].claim));
  assert.equal(s.prepare("SELECT layoff_weeks FROM player_medical_records WHERE id = 'md-r1'").get().layoff_weeks, 3.5, 'REAL: the route accepts any finite number');
  assert.equal(s.prepare("SELECT appearances FROM player_season_history WHERE player_id = 'pl-rich' AND season = '2025/26'").get().appearances, 12.5);
  const facetsSparse = JSON.parse(s.prepare("SELECT facets_json FROM players WHERE id = 'pl-sparse'").get().facets_json);
  assert.ok(facetsSparse.__meta.nulls.includes('media') && facetsSparse.__meta.nulls.includes('medical.records') && facetsSparse.__meta.nulls.includes('trialReports'), 'a null array is remembered as null');
  assert.ok(!facetsSparse.__meta.order.includes('drillResults'), 'an absent array stays absent');
  // A record read back through readAllChildren (the repository's load) agrees with the single-player read.
  const st = prepareSubrecordStatements(s); const all = readAllChildren(st);
  assert.equal(JSON.stringify(all.get('pl-rich')), JSON.stringify(readChildren(st, 'pl-rich')));
  // Prototypes untouched.
  assert.equal('x' in {}, false); assert.equal(Object.prototype.constructor, Object);
  s.close();
});

test('mapping: the legacy layouts decode — an S4a row whose facets hold the arrays under their own keys and one with the older __rest remainder both yield the same record, which the S5 writer then stores as rows; the derived trialReports is placed where the record had it, appended when reports exist for a record that never had the key, and never hidden by a null when a report exists', () => {
  const rec = rich();
  const s4aRow = playerToRow(rec); // the S4a layout: arrays inside facets_json
  const decoded = playerFromRow(s4aRow);
  sameJson(rec, decoded, 'S4a layout');
  const legacy = { ...s4aRow };
  const f = JSON.parse(legacy.facets_json); f.__rest = { medical: f.medical, programme: f.programme }; delete f.medical; delete f.programme; legacy.facets_json = JSON.stringify(f);
  sameJson(rec, playerFromRow(legacy), 'legacy __rest layout');
  const s = liveDb();
  const { back } = roundTrip(s, decoded, { trialReports: rec.trialReports });
  sameJson(rec, back, 'decoded then stored as rows');
  // Derived placement.
  const st = prepareSubrecordStatements(s);
  const rowRich = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE id = 'pl-rich'`).get();
  assert.deepEqual(Object.keys(playerFromRow(rowRich, { children: readChildren(st, 'pl-rich'), trialReports: [report('rep-9', 'pl-rich', NOW)] })).indexOf('trialReports'), Object.keys(rec).indexOf('trialReports'), 'where the record had it');
  const nk = noKeys(); roundTrip(s, nk);
  const rowNk = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE id = 'pl-nokeys'`).get();
  assert.equal('trialReports' in playerFromRow(rowNk, { children: readChildren(st, 'pl-nokeys'), trialReports: [] }), false, 'no key, no reports: absent');
  const gained = playerFromRow(rowNk, { children: readChildren(st, 'pl-nokeys'), trialReports: [report('rep-x', 'pl-nokeys', NOW)] });
  assert.equal(Object.keys(gained).at(-1), 'trialReports', 'no key, a report: appended, never hidden');
  const sp = sparse(); roundTrip(s, sp);
  const rowSp = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE id = 'pl-sparse'`).get();
  assert.equal(playerFromRow(rowSp, { children: readChildren(st, 'pl-sparse'), trialReports: [] }).trialReports, null, 'null stays null while no report exists');
  assert.equal(playerFromRow(rowSp, { children: readChildren(st, 'pl-sparse'), trialReports: [report('rep-y', 'pl-sparse', NOW)] }).trialReports.length, 1, 'a report is never hidden by a null');
  s.close();
});

test('validation: every unsupported item is refused with the field, the index and the reason — nothing coerced, nothing deduplicated: a clip without a title, an unsafe integer view count, a tag with count 0, a capturedBy the CHECK refuses, a gps with lat only, a non-text fixture, a 9-character medical date, a text drill value, a float activity timestamp, a numeric badge, a repeated season, a repeated drill, a repeated provider+externalId, a repeated clip id, a reserved item key', () => {
  const cases = [
    ['media', [{ id: 'm', kind: 'video' }], /media\[0\]\.title is absent/],
    ['media', [{ id: 'm', title: 't', views: 2 ** 53 }], /media\[0\]\.views is 9007199254740992, not a safe integer/],
    ['media', [{ id: 'm', title: 't', tags: { pace: 0 } }], /media\[0\]\.tags\.pace is 0, not a positive integer/],
    ['media', [{ id: 'm', title: 't', capturedBy: 'phone' }], /media\[0\]\.capturedBy is not one of box_cam/],
    ['media', [{ id: 'm', title: 't', uploadedAt: 1700000000000 }], /media\[0\]\.uploadedAt is a number, not text/],
    ['media', [{ id: 'm', title: 't' }, { id: 'm', title: 'u' }], /media\[1\] repeats id "m" \(first at \[0\]\)/],
    ['attendance', [{ id: 'a', fixture: 'f', date: '2026-01-01', gps: { lat: 1 } }], /attendance\[0\]\.gps has lat without lng/],
    ['attendance', [{ id: 'a', fixture: { bad: true }, date: '2026-01-01' }], /attendance\[0\]\.fixture is an object, not text/],
    ['attendance', [{ id: 'a', fixture: 'f' }], /attendance\[0\]\.date is absent/],
    ['medical.records', [{ id: 'r', type: 'note', title: 't', date: '2026-1-1' }], /medical\.records\[0\]\.date is not a 10-character date/],
    ['medical.records', [{ id: 'r', type: 'note', title: 't', cleared: 'yes' }], /medical\.records\[0\]\.cleared is a string, not a boolean/],
    ['drillResults', [{ id: 'd', drillId: 'x', metric: 'm', value: '4.2', ts: NOW }], /drillResults\[0\]\.value is a string, not a finite number/],
    ['activityLog', [NOW + 0.5], /activityLog\[0\] is .*not a safe integer/],
    ['badges', ['ok', 7], /badges\[1\] is a number, not text/],
    ['seasonHistory', [{ season: '2024/25' }, { season: '2024/25', goals: 1 }], /seasonHistory\[1\] repeats season "2024\/25"/],
    ['drills', ['a', 'b', 'a'], /drills\[2\] repeats "a" \(first at \[0\]\)/],
    ['externalIds', [{ provider: 'fa', externalId: '1', source: 's', at: NOW }, { provider: 'fa', externalId: '1', source: 't', at: NOW }], /externalIds\[1\] repeats provider\+externalId/],
    ['externalIds', [{ provider: 'fa', externalId: 1, source: 's', at: NOW }], /externalIds\[0\]\.externalId is a number, not text/],
    ['timeline', [{ year: 2019, event: 'x' }], /timeline\[0\]\.year is a number, not text/],
    ['programme.completed', [{ sessionId: 's1' }], /programme\.completed\[0\]\.ts is absent/],
    ['media', [{ id: 'm', title: 't', __meta: {} }], /media\[0\] carries the reserved field "__meta"/],
    ['media', 'not-an-array', /media is a string, not an array/],
  ];
  for (const [key, items, re] of cases) {
    const problems = validateSubrecordArray(key, items);
    assert.ok(problems.some((p) => re.test(p)), `${key}: expected ${re} in ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(validateSubrecordArray('media', null), []); assert.deepEqual(validateSubrecordArray('media', undefined), []);
  assert.deepEqual(validateSubrecordArray('badges', ['a', 'a']), [], 'a repeated badge is legal');
  assert.deepEqual(validateSubrecordArray('programme.completed', [{ sessionId: 's', ts: 1 }, { sessionId: 's', ts: 2 }]), [], 'a session completed twice is legal');
  const bad = rich(); bad.media[0].title = null;
  const v = validatePlayerRecordWithItems(bad);
  assert.equal(v.ok, false); assert.ok(v.problems.some((p) => /media\[0\]\.title is null/.test(p)));
  assert.deepEqual(validatePlayerRecordWithItems(rich()), { ok: true });
  // The refused value was never written anywhere (the validator is pure).
  assert.equal(bad.media[0].title, null);
});

test('trialReports: derived in filing order from the trials collection (the same objects, never copies; a trial without a report or of another player is ignored); the reconciliation names every discrepancy — a copy entry with no trial report, a content difference, a report the copy lacks, a different order, a null copy while a report exists — and is silent when they agree', () => {
  const r1 = report('rep-1', 'pl-x', NOW - 3 * DAY); const r2 = report('rep-2', 'pl-x', NOW - DAY); const other = report('rep-o', 'pl-y', NOW);
  const list = [trialOf(r2), { id: 'tr-none', playerId: 'pl-x', status: 'awaiting_report' }, trialOf(other), trialOf(r1), null, 'junk'];
  const derived = trialReportsFor(list, 'pl-x');
  assert.deepEqual(derived.map((r) => r.id), ['rep-1', 'rep-2']); assert.equal(derived[0], r1, 'the trial\'s own object');
  assert.deepEqual(trialReportsFor(null, 'pl-x'), []); assert.deepEqual(trialReportsFor(list, 'nobody'), []);
  assert.deepEqual(reconcileTrialReports([r1, r2], derived), []);
  assert.deepEqual(reconcileTrialReports([], []), []); assert.deepEqual(reconcileTrialReports(null, []), []); assert.deepEqual(reconcileTrialReports(undefined, []), []);
  assert.match(reconcileTrialReports([r1, report('rep-ghost', 'pl-x', NOW)], derived).join(';'), /trialReports\[1\] \(rep-ghost\) has no trial report/);
  assert.match(reconcileTrialReports([{ ...r1, coachRating: 3 }, r2], derived).join(';'), /trialReports\[0\] \(rep-1\) differs from the trial's report/);
  assert.match(reconcileTrialReports([r1], derived).join(';'), /trial report rep-2 names the player but the player's trialReports does not carry it/);
  assert.match(reconcileTrialReports([r2, r1], derived).join(';'), /different order than their filing order/);
  assert.match(reconcileTrialReports(null, derived).join(';'), /trialReports is null on the player but 2 trial report\(s\)/);
  assert.match(reconcileTrialReports('x', derived).join(';'), /not an array/);
});

// ------------------------------------------------------------------ migration 0007
/** An S4a-shaped file: an S3 file cut over by 0005 and 0006 only (the players still carry their arrays in facets_json). Returns the records as the S4a build served them. */
function s4aFile(dir, opts = {}) {
  s3File(dir, opts);
  const s = openRaw(dir);
  runDataMigrations(s, S4A_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } });
  const records = s.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`).all().map((r) => playerFromRow(r));
  s.close();
  return records;
}
const PLAYERS_WITH_TRIALS = () => [...FIXTURE().players, rich(), sparse(), noKeys()];

test('migration 0007 on an S4a file: creates the twelve tables, decodes every row through the established decoder, verifies the re-read record before retiring the arrays and the trialReports copy from facets_json, records counts only, and the records read back through the S5 path are byte-identical to what the S4a build served (the derived trial reports in place); sessions, staff, organisations and other blobs untouched; the step never runs twice', () => {
  const dir = tempDir('s5-mig');
  const before = s4aFile(dir, { players: PLAYERS_WITH_TRIALS(), extra: { ...EXTRA(), ...recruitmentBlobs() } });
  const s = openRaw(dir);
  const sessionsBefore = sessionRows(s); const others = dump(s, { except: ['players', 'collections', 'meta', 'data_migrations'] });
  for (const t of SUBRECORD_TABLES) assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), undefined);
  assert.equal(subrecordsLive(s), false);
  const result = migrate(s, { now: NOW });
  assert.deepEqual(result.ran, [PLAYER_SUBRECORDS_MIGRATION, '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']); assert.equal(subrecordsLive(s), true);
  for (const t of SUBRECORD_TABLES) assert.ok(s.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
  const record = JSON.parse(meta(s, PLAYER_SUBRECORDS_CUTOVER_META));
  assert.equal(record.players, 8); assert.equal(record.trialReportsCopiesDropped, 2); assert.equal(record.rows.player_media, 4, 'the seeded clip and the three rich ones'); assert.equal(record.rows.player_media_tags, 3); assert.equal(record.trialsBlobPresent, true);
  assert.ok(!/Rich Record|Hamstring|private club notes/.test(meta(s, PLAYER_SUBRECORDS_CUTOVER_META)), 'counts, never data');
  const st = prepareSubrecordStatements(s);
  const after = readPlayersWithChildren(s, st, { trials: readTrialsCollection(s) }).map((x) => x.record); // S8a: the trials are rows since 0015 (the same boot)
  assert.equal(after.length, before.length);
  before.forEach((rec, i) => { sameJson(rec, after[i], `players ${rec.id} after 0007`); assert.deepEqual(Object.keys(after[i]), Object.keys(rec)); });
  for (const row of s.prepare('SELECT id, facets_json FROM players').all()) {
    const f = JSON.parse(row.facets_json);
    for (const key of ['media', 'attendance', 'badges', 'trialReports', 'seasonHistory']) assert.equal(key in f, false, `${row.id}: ${key} retired from the facets`);
    assert.equal(f.medical?.records, undefined);
  }
  assert.equal(JSON.parse(s.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get().facets_json).medical.futureSub, 1, 'an unknown composite sub-key stays a facet');
  assert.deepEqual(sessionRows(s), sessionsBefore); assert.equal(dump(s, { except: ['players', 'collections', 'meta', 'data_migrations', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', ...SUBRECORD_TABLES, ...RECRUITMENT_TABLES, ...RECRUITMENT_CASES_TABLES, 'recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history', ...SIGNINGS_FOLLOWUPS_TABLES] }), others);
  assert.deepEqual(readTrialsCollection(s).map((t) => t.id), trials().map((t) => t.id), 'the trials are kept (rows of `trials` since 0015, imported by the same boot)');
  assert.deepEqual(migrate(s, { now: NOW + DAY }).ran, [], 'never twice');
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  s.close(); rm(dir);
});

test('migration 0007 blocks the whole step, leaves the file byte-identical and refuses again on the next boot — an item the table cannot hold (named by player, field and index), a trialReports copy entry without a trial, a copy whose content differs, a report the copy lacks, a different order, a trials collection that is not an array; the data resolved by hand then migrates', () => {
  // Each case is planted the way the S4a build could have stored it (its validator never inspected items): the row's facets_json or the trials blob edited after 0005 and 0006 ran.
  const cases = [
    ['bad item', (f) => { f.media[0].title = 7; }, null, /players pl-rich: media\[0\]\.title is a number, not text/],
    ['ghost report', (f) => { f.trialReports.push(report('rep-ghost', 'pl-rich', NOW)); }, null, /players pl-rich: trialReports\[2\] \(rep-ghost\) has no trial report/],
    ['content differs', (f) => { f.trialReports[0].coachRating = 1; }, null, /players pl-rich: trialReports\[0\] \(rep-1\) differs/],
    ['copy lacks', (f) => { f.trialReports.pop(); }, null, /trial report rep-2 names the player but the player's trialReports does not carry it/],
    ['order differs', (f) => { f.trialReports.reverse(); }, null, /different order than their filing order/],
    ['trials unreadable', null, '{"not":"a list"}', /the trials collection is not a JSON array/],
  ];
  for (const [label, mutateFacets, trialsText, re] of cases) {
    const dir = tempDir('s5-block');
    s4aFile(dir, { players: PLAYERS_WITH_TRIALS(), extra: { ...EXTRA(), ...recruitmentBlobs() } });
    const s = openRaw(dir);
    if (mutateFacets) { const f = JSON.parse(s.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get().facets_json); mutateFacets(f); s.prepare("UPDATE players SET facets_json = ? WHERE id = 'pl-rich'").run(JSON.stringify(f)); }
    if (trialsText) s.prepare("UPDATE collections SET value = ? WHERE name = 'trials'").run(trialsText);
    const before = dump(s);
    assert.throws(() => migrate(s, { now: NOW }), (err) => err.message.includes(BLOCKED) && re.test(err.message) && !/Hamstring|private club notes/.test(err.message), `${label}: refused with ids and reasons, never data`);
    assert.equal(dump(s), before, `${label}: byte-identical`); assert.equal(subrecordsLive(s), false); assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE name = 'player_media'").get(), undefined, `${label}: no table left behind`);
    assert.throws(() => migrate(s, { now: NOW + DAY }), (err) => re.test(err.message), `${label}: the next boot refuses the same way`);
    assert.equal(dump(s), before);
    s.close(); rm(dir);
  }
  // Resolved by hand on the S4a build: the arrays corrected in facets_json (as that build stores them) migrate.
  const dir = tempDir('s5-resolved');
  s4aFile(dir, { players: PLAYERS_WITH_TRIALS(), extra: { ...EXTRA(), ...recruitmentBlobs() } });
  let s = openRaw(dir);
  { const f0 = JSON.parse(s.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get().facets_json); f0.media[0].title = 7; s.prepare("UPDATE players SET facets_json = ? WHERE id = 'pl-rich'").run(JSON.stringify(f0)); }
  assert.throws(() => migrate(s, { now: NOW }), /BLOCKED/);
  const row = s.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get(); const f = JSON.parse(row.facets_json); f.media[0].title = 'Fixed by hand';
  s.prepare("UPDATE players SET facets_json = ? WHERE id = 'pl-rich'").run(JSON.stringify(f));
  assert.deepEqual(migrate(s, { now: NOW }).ran, [PLAYER_SUBRECORDS_MIGRATION, '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']);
  assert.equal(s.prepare("SELECT title FROM player_media WHERE id = 'med-r1'").get().title, 'Fixed by hand');
  s.close(); rm(dir);
});

test('migration 0007: a first installation creates the tables and imports nothing (the data layer then initialises the seed through the candidate writer, child rows included); an intentionally empty domain stays empty; a database between 0005 and 0007 is refused by the repositories until the same boot applies 0007; an injected failure after the rows leaves no trace and the next run migrates', () => {
  // First installation.
  const fresh = tempDir('s5-fresh'); freshFile(fresh);
  let s = openRaw(fresh); migrate(s, { now: NOW });
  assert.equal(meta(s, 'coreIdentityInit'), 'pending'); assert.equal(JSON.parse(meta(s, PLAYER_SUBRECORDS_CUTOVER_META)).players, 0);
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW, trialReports: (id) => trialReportsFor(trials(), id) });
  identity.initialize({ players: PLAYERS_WITH_TRIALS(), guardians: FIXTURE().guardians }, { now: NOW });
  assert.equal(count(s, 'player_media'), 4); assert.equal(count(s, 'player_badges'), 4);
  const richRec = rich(); sameJson(richRec, identity.players.byId('pl-rich'), 'initialised from the seed, arrays as rows, trial reports derived');
  s.close(); rm(fresh);
  // Intentionally empty.
  const empty = tempDir('s5-empty'); s3File(empty, { players: [], guardians: [], sessions: [] });
  s = openRaw(empty); migrate(s, { now: NOW }); assert.equal(meta(s, 'coreIdentityInit'), 'done'); assert.equal(count(s, 'players'), 0); assert.equal(count(s, 'player_media'), 0);
  const emptyIdentity = createIdentityRepositories({ sqlite: s, now: () => NOW }); emptyIdentity.attach(); assert.equal(emptyIdentity.players.count(), 0);
  s.close(); rm(empty);
  // Between 0005 and 0007: refused explicitly.
  const between = tempDir('s5-between'); s4aFile(between);
  s = openRaw(between);
  assert.throws(() => createIdentityRepositories({ sqlite: s, now: () => NOW }), /0007_player_subrecords is missing/);
  migrate(s, { now: NOW }); createIdentityRepositories({ sqlite: s, now: () => NOW }).attach();
  s.close(); rm(between);
  // Injected failure after the child rows: nothing committed, the next run migrates.
  const inj = tempDir('s5-inject'); s4aFile(inj, { players: PLAYERS_WITH_TRIALS(), extra: { ...EXTRA(), ...recruitmentBlobs() } });
  s = openRaw(inj); const before = dump(s);
  const probe = failRunAt(s, (sql) => /UPDATE players SET facets_json/.test(sql), 3, 'injected failure after the rows');
  assert.throws(() => migrate(s, { now: NOW }), /injected failure after the rows/); probe.restore();
  assert.equal(probe.fired, 1, 'the failure must actually have happened');
  assert.equal(dump(s), before, 'byte-identical: the tables, the rows and the first two facets rewrites are all gone');
  assert.deepEqual(migrate(s, { now: NOW }).ran, [PLAYER_SUBRECORDS_MIGRATION, '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']); assert.equal(count(s, 'player_media'), 4);
  s.close(); rm(inj);
});

// ------------------------------------------------------------------ the repository with a real store
const baseDb = (players, guardians, trialList = []) => ({ orgs: ORGS(), users: USERS(), sessions: [], players, guardians, trials: trialList, requests: trialList.map((x) => requestOf(x.report)), vouches: [{ id: 'vch-1', status: 'pending', history: [] }] });
function boot(dir, { players = [], guardians = [], trialList = [] } = {}) {
  const db = baseDb(clone(players), clone(guardians), clone(trialList));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  // S8a: the trials are rows of `trials` and the repository never imports from memory — the fixture's trials enter through it (the identity initialisation above reconciled the players' copies against the same in-memory list)
  for (const x of clone(trialList)) { layer.recruitment.addRequest(requestOf(x.report)); layer.recruitment.addTrial(x); }
  return wire({ store, layer, db });
}
function reopen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load(); const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  return wire({ store, layer, db });
}
function wire({ store, layer, db }) {
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  store.save(snapshot());
  const raw = (sql, ...p) => store.sqlite.prepare(sql).get(...p);
  const rows = (table, id) => store.sqlite.prepare(`SELECT * FROM ${table} WHERE player_id = ? ORDER BY position`).all(id).map((r) => ({ ...r }));
  const facets = (id) => JSON.parse(raw('SELECT facets_json FROM players WHERE id = ?', id).facets_json);
  return { store, layer, players: layer.players, db, snapshot, raw, rows, facets, unit: (fn) => store.unitOfWork(fn, { snapshot }), close: () => store.sqlite.close() };
}
function failNextCommit(t) {
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  const probe = { injected: false, restore: () => { t.store.sqlite.exec = exec; } };
  t.store.sqlite.exec = (sql) => { if (sql === 'COMMIT' && !probe.injected) { probe.injected = true; throw new Error('injected COMMIT failure'); } return exec(sql); };
  return probe;
}

test('repository: addItem / setItems / patchItem are the one write path — a row at once (a second connection reads it), memory updated in place (held references to the array and the item stay valid), the view read-only, the facets rewritten only when a key appears for the first time (an absent drillResults gains the key, remembered through a reopen), a clip\'s tags rewritten as rows, a season list replaced in sorted order; a refused item or an unknown key changes nothing; the derived trialReports follows the trials collection live', () => {
  const dir = tempDir('s5-repo');
  const t = boot(dir, { players: [adult(), rich(), noKeys()], guardians: [], trialList: trials() });
  const second = openRaw(dir);
  const p = t.players.byId('pl-adult'); const media = p.media; assert.deepEqual([...media], []);
  const item = { id: 'med-a1', title: 'First clip', kind: 'video', uploadedAt: '2026-10-01T00:00:00.000Z', url: null, views: 0, tags: {}, verifiedClip: null };
  const facetsBefore = t.raw("SELECT facets_json FROM players WHERE id = 'pl-adult'").facets_json;
  const view = t.players.addItem('pl-adult', 'media', item);
  assert.equal(p.media, media, 'same array object'); assert.equal(media.length, 1); assert.equal(view[0].title, 'First clip');
  assert.equal(second.prepare("SELECT title FROM player_media WHERE id = 'med-a1'").get().title, 'First clip', 'committed before the call returned');
  assert.equal(t.raw("SELECT facets_json FROM players WHERE id = 'pl-adult'").facets_json, facetsBefore, 'the key existed: the facets are untouched');
  assert.equal(t.players.uncommitted(), 0);
  assert.throws(() => { view.push({}); }, /addItem/); assert.throws(() => { view[0].views = 1; }, /addItem/); assert.throws(() => { p.media = []; }, /identity repositories/);
  // A key the record never had: created, and the shape metadata follows.
  assert.equal('drillResults' in t.players.byId('pl-nokeys'), false);
  t.players.addItem('pl-nokeys', 'drillResults', { id: 'dr-n1', drillId: 'd', metric: 'm', value: 1, verified: false, ts: NOW });
  assert.equal(t.players.byId('pl-nokeys').drillResults.length, 1); assert.ok(t.facets('pl-nokeys').__meta.order.includes('drillResults'), 'the facets record the new key');
  assert.equal(t.players.uncommitted(), 0, 'the facets were written in the same transaction');
  // patchItem: a clip's views and tags; the item keeps its identity.
  const clip = t.players.byId('pl-rich').media[0]; const richMedia = t.players.byId('pl-rich').media;
  t.players.patchItem('pl-rich', 'media', { id: 'med-r1' }, { views: 4, tags: { pace: 3, vision: 1, composure: 1 } });
  assert.equal(clip.views, 4); assert.deepEqual({ ...clip.tags }, { pace: 3, vision: 1, composure: 1 }); assert.equal(t.players.byId('pl-rich').media, richMedia);
  assert.deepEqual(second.prepare("SELECT tag, count FROM player_media_tags WHERE media_id = 'med-r1' ORDER BY position").all().map((r) => [r.tag, r.count]), [['pace', 3], ['vision', 1], ['composure', 1]]);
  assert.equal(second.prepare("SELECT views FROM player_media WHERE id = 'med-r1'").get().views, 4);
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi';
  t.players.patchItem('pl-rich', 'media', { id: 'med-r3' }, { captions: vtt });
  assert.equal(second.prepare("SELECT captions FROM player_media WHERE id = 'med-r3'").get().captions, vtt); assert.equal(t.players.byId('pl-rich').media[2].captions, vtt);
  // setItems: the season history replaced in sorted order; badges rewritten with a duplicate kept.
  t.players.setItems('pl-rich', 'seasonHistory', [{ season: '2026/27', appearances: 1, goals: 0, assists: 0 }, ...t.players.byId('pl-rich').seasonHistory.map((x) => ({ ...x }))]);
  assert.deepEqual(t.rows('player_season_history', 'pl-rich').map((r) => [r.position, r.season]), [[0, '2026/27'], [1, '2025/26'], [2, '2024/25']]);
  t.players.setItems('pl-rich', 'badges', ['A', 'A', 'B']); assert.deepEqual([...t.players.byId('pl-rich').badges], ['A', 'A', 'B']); assert.equal(count(second, 'player_badges', 'WHERE player_id = ?', 'pl-rich'), 3);
  t.players.setItems('pl-rich', 'programme.completed', []); assert.deepEqual([...t.players.byId('pl-rich').programme.completed], []); assert.equal(count(second, 'player_programme_completions', 'WHERE player_id = ?', 'pl-rich'), 0);
  // Refusals change nothing.
  const before = JSON.stringify(t.players.byId('pl-rich')); const rowsBefore = dump(second, { except: ['meta'] });
  assert.throws(() => t.players.addItem('pl-rich', 'media', { id: 'med-r1', title: 'dup' }), /adding to media of player pl-rich was refused: media\[3\] repeats id "med-r1"/);
  assert.throws(() => t.players.addItem('pl-rich', 'attendance', { id: 'a', fixture: 9, date: '2026-01-01' }), /attendance\[2\]\.fixture is a number, not text/);
  assert.throws(() => t.players.addItem('pl-rich', 'nonsense', {}), /"nonsense" is not a player sub-record/);
  assert.throws(() => t.players.addItem('pl-nobody', 'media', item), /does not exist/);
  assert.throws(() => t.players.patchItem('pl-rich', 'media', { id: 'nope' }, { views: 1 }), /0 item\(s\) of media/);
  assert.throws(() => t.players.patchItem('pl-rich', 'badges', { x: 1 }, {}), /plain values/);
  assert.throws(() => t.players.setItems('pl-rich', 'drills', 'x'), /needs an array/);
  assert.throws(() => t.players.addItem('pl-adult', 'programme.completed', { sessionId: 's', ts: 1 }), /programme is null, so programme\.completed cannot be written/);
  assert.throws(() => t.players.update('pl-rich', { media: [] }), /"media" is a player sub-record/);
  assert.throws(() => t.players.update('pl-rich', { trialReports: [] }), /derived from the trials collection/);
  assert.equal(JSON.stringify(t.players.byId('pl-rich')), before); assert.equal(dump(second, { except: ['meta'] }), rowsBefore);
  // Derived trial reports: live.
  assert.deepEqual(t.players.byId('pl-rich').trialReports.map((r) => r.id), ['rep-1', 'rep-2']);
  addTrial(t, report('rep-3', 'pl-rich', NOW));
  assert.deepEqual(t.players.byId('pl-rich').trialReports.map((r) => r.id), ['rep-1', 'rep-2', 'rep-3'], 'read from the trials at access');
  assert.ok(JSON.stringify({ ...t.players.byId('pl-rich') }).includes('"rep-3"'), 'a spread of the view carries it');
  assert.throws(() => { t.players.byId('pl-rich').trialReports.push({}); }, /derived from the trials collection/);
  assert.equal('trialReports' in t.players.byId('pl-nokeys'), false, 'a record without the key and without reports stays without it');
  t.store.save(t.snapshot()); // the trials are a blob collection: persisted by the save, like every other blob
  second.close(); t.close();
  const r = reopen(dir);
  assert.equal(r.players.byId('pl-adult').media[0].title, 'First clip'); assert.equal(r.players.byId('pl-nokeys').drillResults.length, 1); assert.equal(Object.keys(r.players.byId('pl-nokeys')).at(-1), 'drillResults');
  assert.deepEqual([...r.players.byId('pl-rich').badges], ['A', 'A', 'B']); assert.equal(r.players.byId('pl-rich').media[0].views, 4); assert.deepEqual(r.players.byId('pl-rich').trialReports.map((x) => x.id), ['rep-1', 'rep-2', 'rep-3']);
  r.close(); rm(dir);
});

test('repository: a standalone sub-record write whose COMMIT fails leaves SQL and memory as they were; inside a unit of work a caught failure after the row poisons the unit (nothing commits, memory restored); a real COMMIT failure of the unit takes the same path; retries land everything; players.insert writes a record\'s arrays as rows in its transaction and players.restore rewrites them; players.remove cascades every child row', () => {
  const dir = tempDir('s5-repo-fail');
  const t = boot(dir, { players: [adult(), rich()], guardians: [], trialList: trials() }); // rich() carries report copies: the trials must agree (review of 132eda2, finding 1)
  const p = t.players.byId('pl-rich'); const badges = p.badges; const before = JSON.stringify(p);
  // Standalone COMMIT failure.
  let probe = failNextCommit(t);
  assert.throws(() => t.players.addItem('pl-rich', 'badges', 'Late'), /injected COMMIT failure/); probe.restore(); assert.ok(probe.injected);
  assert.equal(JSON.stringify(p), before); assert.equal(p.badges, badges); assert.equal(count(t.store.sqlite, 'player_badges', 'WHERE player_id = ?', 'pl-rich'), 3); assert.equal(t.store.sqlite.isTransaction, false);
  probe = failNextCommit(t);
  assert.throws(() => t.players.patchItem('pl-rich', 'media', { id: 'med-r1' }, { views: 99 }), /injected COMMIT failure/); probe.restore();
  assert.equal(p.media[0].views, 3); assert.equal(t.raw("SELECT views FROM player_media WHERE id = 'med-r1'").views, 3);
  // Inside a unit: the row insert fails (a trigger), the caller catches it, the unit cannot commit.
  t.store.sqlite.exec("CREATE TRIGGER s5_fail BEFORE INSERT ON player_timeline BEGIN SELECT RAISE(ABORT, 'injected timeline failure'); END;");
  let inner = null; let outer = null; let published = 0;
  try {
    t.unit(() => {
      t.players.addItem('pl-rich', 'badges', 'InUnit'); t.db.vouches[0].status = 'in-unit';
      try { t.players.addItem('pl-rich', 'timeline', { year: '2026', event: 'x' }); } catch (e) { inner = e; }
      t.store.afterCommit(() => { published += 1; });
    });
  } catch (e) { outer = e; }
  assert.match(String(inner?.message), /injected timeline failure/); assert.ok(outer && /cannot commit/.test(outer.message)); assert.equal(published, 0);
  assert.deepEqual([...p.badges], ['Finisher', 'Captain', 'Finisher']); assert.equal(p.badges, badges, 'the same array, restored in place'); assert.equal(t.db.vouches[0].status, 'pending');
  assert.equal(count(t.store.sqlite, 'player_badges', 'WHERE player_id = ?', 'pl-rich'), 3); assert.equal(blob(t.store.sqlite, 'vouches')[0].status, 'pending');
  t.store.sqlite.exec('DROP TRIGGER s5_fail');
  // A real COMMIT failure of the unit (a deferred foreign key violated inside the transaction).
  outer = null;
  try { t.unit(() => { t.players.addItem('pl-rich', 'badges', 'AtCommit'); t.players.setItems('pl-rich', 'drills', []); t.store.failCommitOfOpenTransaction(); }); } catch (e) { outer = e; }
  assert.match(String(outer?.message), /FOREIGN KEY constraint failed/); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual([...p.badges], ['Finisher', 'Captain', 'Finisher']); assert.deepEqual([...p.drills], ['drill-sprint-ladder', 'drill-passing-gates']); assert.equal(count(t.store.sqlite, 'player_drills', 'WHERE player_id = ?', 'pl-rich'), 2);
  // Retry.
  t.unit(() => { t.players.addItem('pl-rich', 'badges', 'Retry'); t.players.addItem('pl-rich', 'timeline', { year: '2026', event: 'x' }); });
  assert.deepEqual([...p.badges], ['Finisher', 'Captain', 'Finisher', 'Retry']); assert.equal(count(t.store.sqlite, 'player_timeline', 'WHERE player_id = ?', 'pl-rich'), 3);
  // insert / restore / remove.
  const inserted = t.players.insert({ ...child('pl-kid', null, '2000-05-05'), media: [{ id: 'med-k1', title: 'Kid clip', kind: 'video' }], badges: ['New'] });
  assert.equal(inserted.media[0].title, 'Kid clip'); assert.equal(count(t.store.sqlite, 'player_media', 'WHERE player_id = ?', 'pl-kid'), 1); assert.equal(count(t.store.sqlite, 'player_badges', 'WHERE player_id = ?', 'pl-kid'), 1);
  const snap = clone(t.players.byId('pl-kid')); snap.badges = ['Restored', 'Twice']; snap.media = [];
  t.players.restore('pl-kid', snap);
  assert.deepEqual([...t.players.byId('pl-kid').badges], ['Restored', 'Twice']); assert.equal(count(t.store.sqlite, 'player_media', 'WHERE player_id = ?', 'pl-kid'), 0); assert.equal(count(t.store.sqlite, 'player_badges', 'WHERE player_id = ?', 'pl-kid'), 2);
  const richRows = SUBRECORD_TABLES.filter((x) => x !== 'player_media_tags').reduce((n, tbl) => n + count(t.store.sqlite, tbl, 'WHERE player_id = ?', 'pl-rich'), 0);
  assert.ok(richRows > 10);
  t.players.remove('pl-rich');
  assert.equal(SUBRECORD_TABLES.filter((x) => x !== 'player_media_tags').reduce((n, tbl) => n + count(t.store.sqlite, tbl, 'WHERE player_id = ?', 'pl-rich'), 0), 0, 'every child row cascaded');
  assert.equal(count(t.store.sqlite, 'player_media_tags', "WHERE media_id = 'med-r1'"), 0, 'the tag rows cascaded with the clips');
  assert.deepEqual(t.store.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  t.close(); rm(dir);
});

// ------------------------------------------------------------------ snapshot replacement
test('snapshot replacement under the child foreign keys: a whole-snapshot write (backup, restore, persistence suite) rewrites the player rows and every child row so the FINAL state holds exactly the snapshot\'s arrays — a changed array, a removed player, a new player with arrays, a record without an array key, with a null array, with an empty array; a partial snapshot leaves every table alone; a failure in the middle of the child rows rolls the whole save back, unrelated collections included; the store reads trialReports from the trials blob of the same file', () => {
  const dir = tempDir('s5-snap');
  const t = boot(dir, { players: [adult(), rich(), sparse(), noKeys()], guardians: [], trialList: trials() }); t.close();
  const store = openStore(dir); // snapshot mode
  let loaded = store.load();
  assert.equal(loaded.db.players.find((p) => p.id === 'pl-rich').trialReports.length, 2, 'derived from the trials blob of the file');
  assert.equal(JSON.stringify(loaded.db.players.find((p) => p.id === 'pl-rich')), JSON.stringify(rich()), 'the record as the server sees it');
  const db = { ...loaded.db };
  db.players = db.players.filter((p) => p.id !== 'pl-adult');
  db.players.find((p) => p.id === 'pl-rich').badges = ['Rewritten'];
  db.players.find((p) => p.id === 'pl-rich').media.splice(1, 1);
  db.players.push({ ...child('pl-new', null, '2001-01-01'), media: [{ id: 'med-new', title: 'New', kind: 'video' }], attendance: [{ id: 'att-new', fixture: 'F', date: '2026-01-01' }] });
  db.vouches.push({ id: 'vch-2', status: 'pending', history: [] });
  store.save({ savedAt: NOW + DAY, idCounter: 1500, db });
  const s = store.sqlite;
  assert.equal(count(s, 'players'), 4); assert.equal(count(s, 'player_media', "WHERE player_id = 'pl-rich'"), 2); assert.deepEqual(s.prepare("SELECT badge FROM player_badges WHERE player_id = 'pl-rich'").all().map((r) => r.badge), ['Rewritten']);
  assert.equal(count(s, 'player_media', "WHERE player_id = 'pl-new'"), 1); assert.equal(count(s, 'player_attendance', "WHERE player_id = 'pl-new'"), 1); assert.equal(count(s, 'player_media', "WHERE player_id = 'pl-adult'"), 0);
  assert.equal(count(s, 'player_media_tags', "WHERE media_id = 'med-r2'"), 0); assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  loaded = store.load();
  assert.equal(JSON.stringify(loaded.db.players.find((p) => p.id === 'pl-rich')), JSON.stringify(db.players.find((p) => p.id === 'pl-rich')), 'reads back as written');
  assert.equal(loaded.db.players.find((p) => p.id === 'pl-sparse').media, null); assert.deepEqual(loaded.db.players.find((p) => p.id === 'pl-sparse').badges, []); assert.equal('media' in loaded.db.players.find((p) => p.id === 'pl-nokeys'), false);
  // Partial snapshot: no players/guardians → tables untouched.
  const before = dump(s, { except: ['meta', 'collections'] });
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1500, db: { vouches: db.vouches } });
  assert.equal(dump(s, { except: ['meta', 'collections'] }), before);
  // Failure in the middle of the child rows: everything rolls back, the unrelated collection included.
  const db2 = { ...store.load().db }; db2.players.find((p) => p.id === 'pl-rich').badges = ['Lost']; db2.vouches[0].status = 'should-not-land';
  const probe = failRunAt(s, (sql) => /INSERT INTO player_media /.test(sql), 2, 'injected child-row failure');
  assert.throws(() => store.save({ savedAt: NOW + 3 * DAY, idCounter: 1500, db: db2 }), /injected child-row failure/); probe.restore(); assert.equal(probe.fired, 1);
  assert.equal(dump(s, { except: ['meta', 'collections'] }), before); assert.equal(blob(s, 'vouches')[0].status, 'pending'); assert.equal(s.isTransaction, false);
  // An item the table refuses: the whole save is refused with the player, field and index.
  const db3 = { ...store.load().db }; db3.players.find((p) => p.id === 'pl-rich').media[0].title = null;
  assert.throws(() => store.save({ savedAt: NOW + 4 * DAY, idCounter: 1500, db: db3 }), /players pl-rich: media\[0\]\.title is null/);
  assert.equal(dump(s, { except: ['meta', 'collections'] }), before);
  // The identity snapshot API before 0007 (an S4a-shaped file): arrays travel in the facets and the child tables are never touched.
  const s4a = tempDir('s5-snap-s4a'); s4aFile(s4a, { players: [rich()], guardians: [], extra: { ...EXTRA(), ...recruitmentBlobs() } });
  const old = openRaw(s4a);
  const read = IDENTITY_SNAPSHOT.read(old); assert.equal(read.players[0].media.length, 3);
  transaction(old, () => IDENTITY_SNAPSHOT.replace(old, { players: [{ ...rich(), badges: ['S4a'] }], guardians: [] }, { now: NOW }));
  assert.deepEqual(JSON.parse(old.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get().facets_json).badges, ['S4a']);
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'player_badges'").get(), undefined);
  old.close(); store.sqlite.close(); rm(dir, s4a);
});

// ------------------------------------------------------------------ media ownership
test('media ownership (the accepted S4a invariant) is judged on player_media once 0007 is recorded: every live clip row is a reference, the in-memory records count too, a queue entry naming a live clip is a conflict, the clip of a removed player is a legitimate removal; before 0007 the facets are read, so the same boot\'s 0006 import is judged correctly', () => {
  const dir = tempDir('s5-own');
  const t = boot(dir, { players: [rich(), adult()], guardians: [], trialList: trials() });
  const s = t.store.sqlite;
  const refs = liveMediaReferences(s);
  assert.deepEqual([...refs.keys()].sort(), ['med-r1', 'med-r2', 'med-r3']); assert.deepEqual(refs.get('med-r1'), ['pl-rich']);
  assert.deepEqual(liveMediaReferences(s, { records: [{ id: 'pl-mem', media: [{ id: 'med-mem' }] }] }).get('med-mem'), ['pl-mem']);
  const queue = t.layer.mediaDeletions;
  assert.throws(() => t.unit(() => { queue.enqueue(['med-r1'], { playerId: 'pl-adult', at: NOW }); assertMediaQueueConsistent(s, { label: 'a test' }); }), /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*med-r1 \(player pl-rich\)/);
  assert.equal(queue.count(), 0, 'rolled back');
  t.unit(() => { const ids = t.players.byId('pl-rich').media.map((m) => m.id); queue.enqueue(ids, { playerId: 'pl-rich', at: NOW }); t.players.remove('pl-rich'); });
  assert.equal(queue.count(), 3); assert.deepEqual(queue.conflicts(), [], 'the owner is gone with its rows: legitimate removals');
  assert.deepEqual([...liveMediaReferences(s).keys()], []);
  t.close();
  const s4a = tempDir('s5-own-s4a'); s4aFile(s4a, { players: [rich()], guardians: [] });
  const old = openRaw(s4a); assert.deepEqual([...liveMediaReferences(old).keys()].sort(), ['med-r1', 'med-r2', 'med-r3'], 'facets before 0007'); old.close();
  rm(dir, s4a);
});

test('audience allowlists are unchanged by the storage move: an organisation never receives medical records unless shared, never attendance GPS, activity, external ids or drill results, and only its own trial reports; the player\'s own record carries everything', () => {
  const p = rich(); p.medical.shared = false;
  const helpers = { visibleToOrg: () => true, isBlocked: () => false, isAdult: () => true, ageOn: () => 26, computeTrustScore: () => 50, publishedVouchesFor: () => [], haversineKm: () => 1 };
  const org = { id: 'org-pro', level: 'pro', location: null };
  const view = orgPlayerView(p, org, helpers);
  assert.deepEqual(view.medical.records, []); assert.equal(view.medical.conditionStatus, 'not_shared');
  assert.ok(view.attendance.every((a) => !('gps' in a))); assert.equal(view.attendance.length, 2);
  for (const k of ['activityLog', 'externalIds', 'drillResults', 'programme', 'dob']) assert.equal(k in view, false, k);
  assert.deepEqual(view.trialReports.map((r) => r.id), ['rep-1', 'rep-2']);
  assert.deepEqual(orgPlayerView(p, { id: 'org-other', level: 'pro', location: null }, helpers).trialReports, [], 'another club sees none of them');
  p.medical.shared = true; assert.equal(orgPlayerView(p, org, helpers).medical.records.length, 2);
});

// ------------------------------------------------------------------ the rollback tool
function liveWithHistory(dir) {
  const t = boot(dir, { players: [adult(), rich(), sparse(), noKeys()], guardians: [gSignup()], trialList: trials() });
  t.players.addItem('pl-adult', 'media', { id: 'med-post', title: 'Post-S5 clip', kind: 'video', uploadedAt: '2026-10-02T00:00:00.000Z', url: '/media/med-post', views: 1, tags: { pace: 1 }, verifiedClip: null });
  t.players.addItem('pl-rich', 'badges', 'PostS5'); t.players.patchItem('pl-rich', 'media', { id: 'med-r1' }, { views: 10 });
  t.players.addItem('pl-nokeys', 'timeline', { year: '2026', event: 'Gained a key' });
  t.players.remove('pl-sparse');
  addTrial(t, report('rep-3', 'pl-adult', NOW));
  t.players.byId('pl-rich').unknownBag.touched = true;
  const minted = t.layer.sessions.create('player', 'pl-adult').token;
  t.store.save(t.snapshot());
  const expected = { players: clone(t.db.players), live: identityDump(t.store.sqlite), sessions: sessionRows(t.store.sqlite), saveSeq: Number(meta(t.store.sqlite, 'saveSeq')), minted, rows: Object.fromEntries(SUBRECORD_TABLES.map((x) => [x, count(t.store.sqlite, x)])) };
  t.close();
  return expected;
}

test('rollback: the copy-only tool rebuilds the S4a representation — every array (post-S5 inserts, updates and removals included) back inside facets_json under its own key, trialReports rebuilt from the trials in filing order (a report filed after S5 included), the twelve tables dropped, the 0007 record and meta key gone, the revision advanced, sessions and every other collection untouched, the source byte-identical; the S4a decoder reads the copy as the records the S5 server served; the real migration brings the copy back to the live state row for row; the S4a→S3 tool refuses the S5 file and accepts the copy', () => {
  const src = tempDir('s5-rb-src'); const expected = liveWithHistory(src);
  const srcBefore = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  const out = tempDir('s5-rb-out');
  // S6a: the live file carries 0008, which this tool refuses outright; the S6a rollback (copy-only) goes first, and this tool runs on ITS output (two revisions advance).
  const result = rollbackPlayerSubrecordsCopy(dbFile(s5Copy(src)), out);
  assert.equal(filesDigest(src)['scoutbox.db'], srcBefore['scoutbox.db'], 'the source main file is byte-identical');
  { const sIn2 = openRaw(src); assert.equal(dump(sIn2), logicalBefore, 'the source content is unchanged'); sIn2.close(); }
  assert.equal(result.output, dbFile(out)); assert.equal(result.recordRemoved, true); assert.equal(result.players, 3); assert.equal(result.saveSeq, expected.saveSeq + 12); // S8d, S8c, S8b, S8a, S4b-R, S6b, S7d, S7c, S7b, S7a, S6a and this tool each advanced it once // S8a, S4b-R, S6b, S7d, S7c, S7b, S7a, S6a and this tool each advance the revision once assert.deepEqual(result.rows, expected.rows);
  assert.deepEqual(fs.readdirSync(out), ['scoutbox.db']);
  const o = openRaw(out);
  assert.deepEqual(applied(o), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions']);
  assert.equal(meta(o, PLAYER_SUBRECORDS_CUTOVER_META), undefined); for (const x of SUBRECORD_TABLES) assert.equal(o.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(x), undefined, `${x} dropped`);
  const decoded = o.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`).all().map((r) => playerFromRow(r));
  assert.equal(JSON.stringify(decoded), JSON.stringify(expected.players), 'the S4a decoder reads exactly what the S5 server served');
  const facets = JSON.parse(o.prepare("SELECT facets_json FROM players WHERE id = 'pl-rich'").get().facets_json);
  assert.deepEqual(facets.badges, ['Finisher', 'Captain', 'Finisher', 'PostS5']); assert.equal(facets.media[0].views, 10); assert.equal(facets.medical.records.length, 2); assert.deepEqual(facets.trialReports.map((r) => r.id), ['rep-1', 'rep-2']);
  assert.deepEqual(JSON.parse(o.prepare("SELECT facets_json FROM players WHERE id = 'pl-adult'").get().facets_json).trialReports.map((r) => r.id), ['rep-3'], 'a report filed after S5 is in the copy the S4a build reads');
  assert.equal(JSON.parse(o.prepare("SELECT facets_json FROM players WHERE id = 'pl-nokeys'").get().facets_json).timeline.length, 1);
  assert.equal(o.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-sparse'").get().n, 0, 'the removed player is not resurrected');
  assert.deepEqual(sessionRows(o), expected.sessions); assert.deepEqual(o.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(o.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(count(o, 'media_deletions'), 0, 'the queue table stays (both builds have it)');
  // Round trip: the real migration cuts the copy over again.
  assert.deepEqual(migrate(o, { now: NOW + DAY }).ran, [PLAYER_SUBRECORDS_MIGRATION, '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups'], 'the real migration brings the copy back (0008 follows, as the S6a copy had removed it)');
  assert.equal(identityDump(o), expected.live, 'players, guardians and links identical to the pre-rollback live state, facets included');
  for (const x of SUBRECORD_TABLES) assert.equal(count(o, x), expected.rows[x], `${x} rows back`);
  const identity = createIdentityRepositories({ sqlite: o, now: () => NOW, trialReports: (id) => trialReportsFor(readTrialsCollection(o), id) }); identity.attach();
  assert.equal(JSON.stringify(identity.players.view), JSON.stringify(expected.players));
  o.close();
  // The S4a→S3 tool: refuses the S5 file, accepts the S5 tool's output.
  const out2 = tempDir('s5-rb-out2'); const out3 = tempDir('s5-rb-out3');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(src), out2), (err) => err.code === 'LATER_SCHEMA' && /0007_player_subrecords/.test(err.message)); assert.deepEqual(fs.readdirSync(out2), []);
  rollbackPlayerSubrecordsCopy(dbFile(s5Copy(src)), out2);
  assert.equal(rollbackCoreIdentityCopy(dbFile(out2), out3).players, 3);
  const o3 = openRaw(out3); assert.equal(blob(o3, 'players').find((p) => p.id === 'pl-rich').badges.length, 4, 'the arrays travelled into the S3 blob'); o3.close();
  rm(src, out, out2, out3);
});

test('rollback refusals leave no output and never touch the source: a later schema step (exit 4), a file that never applied 0007 (exit 5), a non-empty output directory (exit 1), a recorded 0007 whose tables are missing (exit 10), a trials collection that is not an array while a player carries trialReports (exit 9), an injected COMMIT failure inside the tool; the CLI writes the copy and reports it', () => {
  const src = tempDir('s5-rf-src'); liveWithHistory(src);
  const before = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  const srcS5 = s5Copy(src); // S6a: the S5-shaped copy this tool works on (the live file carries 0008 and is refused as a later schema)
  const script = path.join(HERE, 'playerSubrecordsRollback.mjs');
  const run = (...a) => { try { execFileSync(process.execPath, [script, ...a], { stdio: 'pipe' }); return 0; } catch (err) { return err.status; } };
  const later = tempDir('s5-rf-later'); fs.copyFileSync(dbFile(srcS5), dbFile(later));
  { const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0008_future_step', 1)").run(); l.close(); }
  const out1 = tempDir('s5-rf-o1'); assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(later), out1), (err) => err.code === 'LATER_SCHEMA' && /0008_future_step/.test(err.message)); assert.deepEqual(fs.readdirSync(out1), []);
  const s4a = tempDir('s5-rf-s4a'); s4aFile(s4a);
  const out2 = tempDir('s5-rf-o2'); assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(s4a), out2), (err) => err.code === 'NOT_CUT_OVER'); assert.deepEqual(fs.readdirSync(out2), []);
  const out3 = tempDir('s5-rf-o3'); fs.writeFileSync(path.join(out3, 'keep.txt'), 'x');
  assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(src), out3), (err) => err.code === 'OUTPUT_NOT_EMPTY'); assert.deepEqual(fs.readdirSync(out3), ['keep.txt']);
  const odd = tempDir('s5-rf-odd'); fs.copyFileSync(dbFile(srcS5), dbFile(odd));
  { const od = openRaw(odd); od.exec('DROP TABLE player_media_tags; DROP TABLE player_media;'); od.close(); }
  const out4 = tempDir('s5-rf-o4'); assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(odd), out4), (err) => err.code === 'UNEXPECTED_SCHEMA' && /player_media/.test(err.message)); assert.deepEqual(fs.readdirSync(out4), []);
  const badTrials = tempDir('s5-rf-trials'); fs.copyFileSync(dbFile(srcS5), dbFile(badTrials));
  { const bt = openRaw(badTrials); bt.prepare("UPDATE collections SET value = '{\"not\":\"a list\"}' WHERE name = 'trials'").run(); bt.close(); }
  const out5 = tempDir('s5-rf-o5'); assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(badTrials), out5), (err) => err.code === 'TRIALS_UNREADABLE'); assert.deepEqual(fs.readdirSync(out5), []);
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the S5 rollback tool'); } return exec.call(this, sql); };
  const out6 = tempDir('s5-rf-o6');
  try { assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(srcS5), out6), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.equal(fired, 1); assert.deepEqual(fs.readdirSync(out6), []);
  assert.equal(filesDigest(src)['scoutbox.db'], before['scoutbox.db']); { const s2 = openRaw(src); assert.equal(dump(s2), logicalBefore); s2.close(); }
  assert.equal(run(later, path.join(tempDir('s5-rf-cli'), 'x')), 4); assert.equal(run(s4a, path.join(tempDir('s5-rf-cli2'), 'x')), 5); assert.equal(run(src, out3), 1); assert.equal(run(src), 1);
  assert.equal(run(odd, path.join(tempDir('s5-rf-cli3'), 'x')), 10); assert.equal(run(badTrials, path.join(tempDir('s5-rf-cli4'), 'x')), 9);
  const cliOut = path.join(tempDir('s5-rf-cli5'), 'copy');
  assert.equal(run(src, path.join(tempDir('s5-rf-cli6'), 'x')), 4, 'S6a: the CLI refuses the live file carrying 0008 (LATER_SCHEMA)');
  const json = JSON.parse(execFileSync(process.execPath, [script, srcS5, cliOut, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(json.players, 3); assert.equal(json.recordRemoved, true); assert.ok(fs.existsSync(path.join(cliOut, 'scoutbox.db')));
  rm(src, srcS5, later, s4a, odd, badTrials, out1, out2, out3, out4, out5, out6, path.dirname(cliOut));
});

// ------------------------------------------------------------------ review of 132eda2 (three findings, corrected failing-first)
test('review of 132eda2, finding 1: a snapshot save never discards a trialReports copy — a copy with no trial report of that id, one whose content differs, one in a different order, a duplicated entry, each refuses the WHOLE save (player and report ids named; the unrelated edit and the save revision rolled back) whether the snapshot supplies the trials or omits them (the retained trials judge); a trials collection that is not an array is refused while a copy exists; a consistent whole replacement, a trials-only write (the derived view changes), a record without the key (no claim) and a null (no claim) are accepted; an injected COMMIT failure of an accepted save rolls everything back and the retry lands; the same rule at insert, restore and initialize', () => {
  const dir = tempDir('s5-f1');
  const t = boot(dir, { players: [adult(), rich()], guardians: [], trialList: trials() }); t.close();
  const store = openStore(dir); const s = store.sqlite;
  const base = store.load();
  assert.deepEqual(base.db.players.map((p) => p.id), ['pl-adult', 'pl-rich']);
  let before = dump(s, { except: ['meta'] }); let seq = meta(s, 'saveSeq');
  const refused = (mutate, re, label) => {
    const snap = clone(base); mutate(snap.db);
    let err = null; try { store.save({ savedAt: NOW + DAY, idCounter: 1500, db: snap.db }); } catch (e) { err = e; }
    assert.ok(err, `${label}: the save must be refused`); assert.match(err.message, re, label);
    assert.equal(dump(s, { except: ['meta'] }), before, `${label}: nothing of the save was written (the unrelated edit included)`);
    assert.equal(meta(s, 'saveSeq'), seq, `${label}: the save revision did not advance`); assert.equal(s.isTransaction, false);
  };
  refused((db) => { db.trials = []; db.players[0].trialReports = [report('rep-x', 'pl-adult', NOW)]; db.players[0].name = 'Unrelated snapshot edit'; }, /players pl-adult: trialReports\[0\] \(rep-x\) has no trial report with that id/, 'a copy with no trial (the reviewer\'s case)');
  refused((db) => { db.players[1].trialReports[0].notes = 'edited copy'; }, /players pl-rich: trialReports\[0\] \(rep-1\) differs from the trial's report/, 'a copy whose content differs');
  refused((db) => { db.players[1].trialReports.reverse(); }, /players pl-rich: trialReports lists the same reports in a different order/, 'a copy in a different order');
  refused((db) => { db.players[1].trialReports.push(clone(db.players[1].trialReports[0])); }, /players pl-rich: trialReports\[2\] \(rep-1\) repeats/, 'a duplicated entry');
  refused((db) => { delete db.trials; db.players[1].trialReports = [db.players[1].trialReports[0]]; }, /players pl-rich: trial report rep-2 names the player but the player's trialReports does not carry it/, 'the trials omitted: the retained trials judge');
  refused((db) => { db.trials = { not: 'a list' }; }, /trials: the snapshot collection must be an array|trials collection .* is an object, not an array/, 'a trials collection that is not an array while a copy exists');
  // Accepted: a consistent whole replacement (the control), a trials-only write, a record without the key, a null.
  const rep3 = report('rep-3', 'pl-adult', NOW);
  { const snap = clone(base); snap.db.requests.push(requestOf(rep3)); snap.db.trials.push(trialOf(rep3)); snap.db.players[0].trialReports = [rep3]; snap.db.players[0].name = 'Renamed'; store.save({ savedAt: NOW + DAY, idCounter: 1500, db: snap.db }); }
  let loaded = store.load(); assert.equal(loaded.db.players[0].name, 'Renamed'); assert.deepEqual(loaded.db.players[0].trialReports.map((r) => r.id), ['rep-3']);
  const rep4 = report('rep-4', 'pl-adult', NOW + 1);
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1500, db: { requests: [...loaded.db.requests, requestOf(rep4)], trials: [...loaded.db.trials, trialOf(rep4)] } }); // S8a: the new trial's request travels with it
  loaded = store.load(); assert.deepEqual(loaded.db.players[0].trialReports.map((r) => r.id), ['rep-3', 'rep-4'], 'a trials-only write changes the derived view');
  { const snap = clone(loaded); delete snap.db.players[0].trialReports; store.save({ savedAt: NOW + 3 * DAY, idCounter: 1500, db: snap.db }); assert.deepEqual(store.load().db.players[0].trialReports.map((r) => r.id), ['rep-3', 'rep-4'], 'no key: no claim, the trials stand'); }
  { const snap = clone(loaded); snap.db.players[0].trialReports = null; store.save({ savedAt: NOW + 4 * DAY, idCounter: 1500, db: snap.db }); assert.deepEqual(store.load().db.players[0].trialReports.map((r) => r.id), ['rep-3', 'rep-4'], 'null: no claim; a derived list that exists is never hidden'); }
  // An injected COMMIT failure of an accepted save rolls everything back; the retry lands.
  before = dump(s, { except: ['meta'] }); seq = meta(s, 'saveSeq');
  const rep5 = report('rep-5', 'pl-rich', NOW + 2); const snap5 = clone(store.load()); snap5.db.requests.push(requestOf(rep5)); snap5.db.trials.push(trialOf(rep5)); snap5.db.players[1].trialReports.push(rep5);
  const exec = s.exec.bind(s); let fired = 0; s.exec = (sql) => { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure'); } return exec(sql); };
  try { assert.throws(() => store.save({ savedAt: NOW + 5 * DAY, idCounter: 1500, db: snap5.db }), /injected COMMIT failure/); } finally { s.exec = exec; }
  assert.equal(fired, 1); assert.equal(dump(s, { except: ['meta'] }), before); assert.equal(meta(s, 'saveSeq'), seq);
  store.save({ savedAt: NOW + 5 * DAY, idCounter: 1500, db: snap5.db }); assert.deepEqual(store.load().db.players[1].trialReports.map((r) => r.id), ['rep-1', 'rep-2', 'rep-5']);
  s.close();
  // The same rule at insert, restore and initialize.
  const r = reopen(dir);
  assert.throws(() => r.players.insert({ ...adult(), id: 'pl-ins', trialReports: [report('rep-z', 'pl-ins', NOW)] }), /pl-ins: trialReports\[0\] \(rep-z\) has no trial report/);
  assert.equal(count(r.store.sqlite, 'players', "WHERE id = 'pl-ins'"), 0);
  r.players.insert({ ...adult(), id: 'pl-ins' }); // trialReports: [] — the sign-up shape
  const snapRich = clone(r.players.byId('pl-rich')); snapRich.trialReports = snapRich.trialReports.slice(0, 1);
  assert.throws(() => r.players.restore('pl-rich', snapRich), /pl-rich: trial report rep-2 names the player/);
  assert.deepEqual(r.players.byId('pl-rich').trialReports.map((x) => x.id), ['rep-1', 'rep-2', 'rep-5']);
  r.players.restore('pl-rich', clone(r.players.byId('pl-rich'))); // an equal copy
  const noClaim = clone(r.players.byId('pl-rich')); delete noClaim.trialReports; r.players.restore('pl-rich', noClaim);
  assert.deepEqual(r.players.byId('pl-rich').trialReports.map((x) => x.id), ['rep-1', 'rep-2', 'rep-5'], 'no key on the restored record: the trials stand');
  r.close();
  const fresh = tempDir('s5-f1-init'); freshFile(fresh); const f = openRaw(fresh); migrate(f, { now: NOW });
  const list = trials(); const identity = createIdentityRepositories({ sqlite: f, now: () => NOW, trialReports: (id) => trialReportsFor(list, id) });
  assert.throws(() => identity.initialize({ players: [{ ...adult(), trialReports: [report('rep-q', 'pl-adult', NOW)] }], guardians: [] }, { now: NOW }), (e) => e.code === 'CORE_IDENTITY_CUTOVER_BLOCKED' && /pl-adult: trialReports\[0\] \(rep-q\) has no trial report/.test(e.message));
  assert.equal(meta(f, 'coreIdentityInit'), 'pending'); assert.equal(count(f, 'players'), 0);
  identity.initialize({ players: [adult(), rich()], guardians: [] }, { now: NOW }); assert.equal(count(f, 'players'), 2);
  f.close(); rm(dir, fresh);
});

test('review of 132eda2, finding 2: the derived trialReports follows the trials for EVERY accepted shape — a record whose key was absent, null or an empty array shows a newly filed report at once on the held view, on a fresh lookup, in a spread, in JSON (the backup\'s serialisation) and in the club view (its own club only); the empty-state shape is preserved (absent stays absent, null stays null, [] stays []) in memory, in the row\'s shape metadata, after a reopen and in the rollback copy; a unit of work that fails restores the shape; players.restore adopts the restored record\'s shape', () => {
  const dir = tempDir('s5-f2');
  const t = boot(dir, { players: [noKeys(), { ...adult(), id: 'pl-null', trialReports: null }, { ...adult(), id: 'pl-empty' }], guardians: [] });
  const ids = { absent: 'pl-nokeys', null: 'pl-null', empty: 'pl-empty' };
  const held = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, t.players.byId(id)]));
  assert.equal('trialReports' in held.absent, false); assert.equal(held.null.trialReports, null); assert.deepEqual([...held.empty.trialReports], []);
  for (const [k, id] of Object.entries(ids)) addTrial(t, report(`rep-${k}`, id, NOW));
  const helpers = { visibleToOrg: () => true, isBlocked: () => false, isAdult: () => true, ageOn: () => 26, computeTrustScore: () => 50, publishedVouchesFor: () => [], haversineKm: () => 1 };
  const org = { id: 'org-pro', level: 'pro', location: null };
  for (const [k, id] of Object.entries(ids)) {
    const v = held[k];
    assert.deepEqual(v.trialReports.map((r) => r.id), [`rep-${k}`], `${k}: the held view`);
    assert.deepEqual(t.players.byId(id).trialReports.map((r) => r.id), [`rep-${k}`], `${k}: a fresh lookup`);
    assert.equal('trialReports' in v, true, `${k}: the key is there once a report exists`);
    assert.ok(Object.keys(v).includes('trialReports') && Object.keys({ ...v }).includes('trialReports'), `${k}: enumerable (a spread carries it)`);
    assert.deepEqual(JSON.parse(JSON.stringify(v)).trialReports.map((r) => r.id), [`rep-${k}`], `${k}: the serialisation (a backup's)`);
    assert.deepEqual(orgPlayerView(v, org, helpers).trialReports.map((r) => r.id), [`rep-${k}`], `${k}: the club view`);
    assert.deepEqual(orgPlayerView(v, { id: 'org-other', level: 'pro', location: null }, helpers).trialReports, [], `${k}: another club sees none`);
    assert.throws(() => { v.trialReports.push({}); }, /derived from the trials collection/, `${k}: read-only`);
  }
  assert.equal(t.players.uncommitted(), 0, 'a report is not a facet change: nothing to flush');
  t.store.save(t.snapshot());
  const m = (id) => t.facets(id).__meta;
  assert.equal(m('pl-nokeys').order.includes('trialReports'), false, 'absent: the shape metadata still says absent'); assert.ok(m('pl-null').nulls.includes('trialReports'), 'null: still null'); assert.ok(m('pl-empty').order.includes('trialReports') && !m('pl-empty').nulls.includes('trialReports'), 'array: still an array');
  const read = IDENTITY_SNAPSHOT.read(t.store.sqlite);
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(read.players.find((p) => p.id === id).trialReports.map((r) => r.id), [`rep-${k}`], `${k}: the backup read`);
  t.close();
  let r = reopen(dir);
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(r.players.byId(id).trialReports.map((x) => x.id), [`rep-${k}`], `${k}: after a reopen`);
  // S8a: the trials are rows — removed by a whole-snapshot write (requests and trials emptied; the players, omitted, keep their derived views), then the repositories reopened
  r.close(); { const tool = openStore(dir); tool.load(); tool.save({ savedAt: NOW, idCounter: 1000, db: { requests: [], trials: [] } }); tool.sqlite.close(); } r = reopen(dir);
  assert.equal('trialReports' in r.players.byId('pl-nokeys'), false, 'absent: hidden again without reports'); assert.equal(JSON.stringify(r.players.byId('pl-nokeys')).includes('trialReports'), false); assert.equal(Object.keys({ ...r.players.byId('pl-nokeys') }).includes('trialReports'), false);
  assert.equal(r.players.byId('pl-null').trialReports, null); assert.ok(JSON.stringify(r.players.byId('pl-null')).includes('"trialReports":null'));
  assert.deepEqual([...r.players.byId('pl-empty').trialReports], []);
  r.store.save(r.snapshot()); r.close();
  const out = tempDir('s5-f2-rb'); rollbackPlayerSubrecordsCopy(dbFile(s5Copy(dir)), out); const o = openRaw(out);
  const fac = (id) => JSON.parse(o.prepare('SELECT facets_json FROM players WHERE id = ?').get(id).facets_json);
  assert.equal('trialReports' in fac('pl-nokeys'), false, 'the rollback copy: no key'); assert.ok('trialReports' in fac('pl-null') && fac('pl-null').trialReports === null, 'the rollback copy: null (the S4a layout keeps a null facet as null)'); assert.deepEqual(fac('pl-empty').trialReports, [], 'the rollback copy: []');
  o.close();
  r = reopen(dir);
  let err = null; try { r.unit(() => { r.players.restore('pl-nokeys', { ...clone(r.players.byId('pl-nokeys')), trialReports: [] }); r.store.failCommitOfOpenTransaction(); }); } catch (e) { err = e; }
  assert.equal(err?.unitOfWork, 'rolled_back'); assert.equal('trialReports' in r.players.byId('pl-nokeys'), false, 'the shape is restored with the record');
  r.players.restore('pl-nokeys', { ...clone(r.players.byId('pl-nokeys')), trialReports: [] }); assert.deepEqual([...r.players.byId('pl-nokeys').trialReports], [], 'restore adopts the [] shape');
  const noKey = clone(r.players.byId('pl-null')); delete noKey.trialReports; r.players.restore('pl-null', noKey); assert.equal('trialReports' in r.players.byId('pl-null'), false, 'restore adopts the absent shape');
  addTrial(r, report('rep-late', 'pl-null', NOW)); assert.deepEqual(r.players.byId('pl-null').trialReports.map((x) => x.id), ['rep-late'], 'the adopted shape follows the trials too');
  r.close(); rm(dir, out);
});

test('review of 132eda2, finding 3: a whole-null medical or programme update is refused while the player has records or completions (rows of the child table) — everything unchanged, the error naming the player, the rows and the explicit clearing operation; a scalar sub-key update keeps the rows and the held references; a failure inside a unit after the mutation and a real COMMIT failure leave the rows; the explicit clear (setItems to []) then null, a null composite without rows and the key appearing again are supported; export, reopen and rollback agree with the rows; a deliberately inconsistent file (a null composite over child rows, written outside the repositories) is refused by the export, the boot and the rollback tool — the source untouched, no output, exit 11', () => {
  const dir = tempDir('s5-f3');
  const t = boot(dir, { players: [adult(), rich()], guardians: [], trialList: trials() });
  t.players.addItem('pl-adult', 'medical.records', { id: 'md-a1', type: 'note', title: 'Synthetic note' });
  t.players.update('pl-adult', { programme: { track: 'CM', startedAt: NOW } }); t.players.addItem('pl-adult', 'programme.completed', { sessionId: 's1', ts: NOW });
  const p = t.players.byId('pl-adult'); const medical = p.medical; const records = p.medical.records;
  const before = JSON.stringify(p); const rowsBefore = dump(t.store.sqlite, { except: ['meta'] });
  assert.throws(() => t.players.update('pl-adult', { medical: null }), /medical of player pl-adult cannot be set to null while 1 medical\.records row\(s\) exist in player_medical_records.*setItems\(id, 'medical\.records', \[\]\)/);
  assert.throws(() => t.players.update('pl-adult', { programme: null }), /programme of player pl-adult cannot be set to null while 1 programme\.completed row\(s\) exist in player_programme_completions/);
  assert.equal(JSON.stringify(p), before); assert.equal(dump(t.store.sqlite, { except: ['meta'] }), rowsBefore); assert.equal(p.medical, medical); assert.equal(p.medical.records, records);
  t.players.update('pl-adult', { medical: { shared: true, conditionStatus: 'fully_fit' } }); assert.equal(p.medical, medical); assert.equal(records.length, 1); assert.equal(count(t.store.sqlite, 'player_medical_records', "WHERE player_id = 'pl-adult'"), 1);
  t.players.update('pl-adult', { programme: { track: 'ST' } }); assert.equal(p.programme.completed.length, 1); assert.equal(p.programme.startedAt, NOW);
  let err = null; try { t.unit(() => { t.players.update('pl-adult', { medical: { shared: false } }); t.players.addItem('pl-adult', 'medical.records', { id: 'md-a2', type: 'note', title: 'Second' }); t.store.failCommitOfOpenTransaction(); }); } catch (e) { err = e; }
  assert.equal(err?.unitOfWork, 'rolled_back'); assert.equal(p.medical.shared, true); assert.equal(records.length, 1); assert.equal(count(t.store.sqlite, 'player_medical_records', "WHERE player_id = 'pl-adult'"), 1);
  t.unit(() => { t.players.update('pl-adult', { medical: { shared: false } }); t.players.addItem('pl-adult', 'medical.records', { id: 'md-a2', type: 'note', title: 'Second' }); }); assert.equal(records.length, 2); assert.equal(p.medical.shared, false);
  t.players.setItems('pl-adult', 'medical.records', []); assert.equal(count(t.store.sqlite, 'player_medical_records', "WHERE player_id = 'pl-adult'"), 0);
  t.players.update('pl-adult', { medical: null }); assert.equal(p.medical, null); assert.ok(t.facets('pl-adult').__meta.nulls.includes('medical'));
  t.players.setItems('pl-adult', 'programme.completed', []); t.players.update('pl-adult', { programme: null }); assert.equal(p.programme, null);
  assert.throws(() => t.players.addItem('pl-adult', 'medical.records', { id: 'md-a3', type: 'note', title: 'x' }), /medical is null/);
  t.players.update('pl-adult', { medical: { shared: false, conditionStatus: 'unknown' } }); t.players.addItem('pl-adult', 'medical.records', { id: 'md-a3', type: 'note', title: 'Third' });
  assert.equal(p.medical.records.length, 1);
  t.store.save(t.snapshot());
  const exported = IDENTITY_SNAPSHOT.read(t.store.sqlite).players.find((x) => x.id === 'pl-adult'); assert.equal(exported.medical.records.length, 1); assert.equal(exported.programme, null);
  t.close();
  const r = reopen(dir); assert.equal(r.players.byId('pl-adult').medical.records[0].id, 'md-a3'); assert.equal(r.players.byId('pl-adult').programme, null); r.close();
  // A deliberately inconsistent file: pl-rich's row says medical is null while its two record rows stay.
  const bad = tempDir('s5-f3-bad'); fs.copyFileSync(dbFile(dir), dbFile(bad));
  { const b = openRaw(bad); const rec = IDENTITY_SNAPSHOT.read(b).players.find((x) => x.id === 'pl-rich'); const row = playerToRow({ ...rec, medical: null }, { subrecords: 'tables' });
    b.prepare('UPDATE players SET facets_json = @facets_json, medical_shared = @medical_shared, medical_condition_status = @medical_condition_status WHERE id = @id').run({ id: 'pl-rich', facets_json: row.facets_json, medical_shared: row.medical_shared, medical_condition_status: row.medical_condition_status });
    assert.equal(count(b, 'player_medical_records', "WHERE player_id = 'pl-rich'"), 2); b.close(); }
  const digest = filesDigest(bad);
  const inconsistent = (fn, label) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e, `${label}: must refuse`); assert.equal(e.code, 'INCONSISTENT_ROWS', `${label}: ${e.message}`); assert.match(e.message, /players pl-rich: medical is null .* 2 medical\.records row\(s\) .* player_medical_records/, label); };
  { const st = openStore(bad); inconsistent(() => st.load(), 'the snapshot store (a backup)'); st.sqlite.close(); }
  { const b = openRaw(bad); inconsistent(() => IDENTITY_SNAPSHOT.read(b), 'the identity snapshot read'); inconsistent(() => createIdentityRepositories({ sqlite: b, now: () => NOW }).attach(), 'the boot'); b.close(); }
  const badS5 = s5Copy(bad); // S6a: the S6a tool copies without decoding players, so the inconsistent file reaches this tool as an S5-shaped copy
  const out = tempDir('s5-f3-rb'); inconsistent(() => rollbackPlayerSubrecordsCopy(dbFile(badS5), out), 'the rollback tool'); assert.deepEqual(fs.readdirSync(out), [], 'no output');
  assert.equal(filesDigest(bad)['scoutbox.db'], digest['scoutbox.db'], 'the source is untouched');
  let status = 0; try { execFileSync(process.execPath, [path.join(HERE, 'playerSubrecordsRollback.mjs'), badS5, path.join(tempDir('s5-f3-cli'), 'x')], { stdio: 'pipe' }); } catch (e) { status = e.status; } assert.equal(status, 11);
  rm(dir, bad, out);
});

console.log(`\n${passed} player sub-record checks passed`);
