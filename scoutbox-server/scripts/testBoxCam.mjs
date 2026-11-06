// S12b — Box Cam, the At-Home Combine and the production CV results as typed tables with explicit writes
// (repositories/boxCam.mjs, migration 0031). What this suite proves: the migration creates the STRICT tables (no JSON
// column) and inserts the two ScoutBox challenges, nothing else; the typers refuse junk with the record and field named
// (a plain nonce, an unknown field, an observation without its timestamps or with an unknown quality, a challenge with
// an org name but no org, a malformed due date, a CV result claiming Combine Verified); records are created and read
// back whole, the derived parts (a calibration's required checks, the experimental note, default preferences) worked
// out on read; recordBatch appends observations in order and closes the open pause; an update keeps the fields that
// never change and only grows the integrity history; the queries answer what the routes need (the dispute queue pages);
// a rolled-back unit leaves nothing; the db.* names throw; and the snapshot write types, names a missing reference and
// reads back what it wrote. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  BOX_CAM_MIGRATION as MIGRATION, BOX_CAM_TABLES as TABLES, BOX_CAM_COLLECTIONS as COLLECTIONS, EXPERIMENTAL_NOTE,
  typeSession, typeObservation, typeChallenge, typeAssignment, typeCvResult, typeAttempt, hashNonce, nonceMatches,
} from '../repositories/boxCam.mjs';

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
const PID = 'pl-1';
const NONCE = 'plain-nonce-from-the-response';
/** POST /player/box-cam/sessions (domains/development/boxcam/sessions.mjs). */
const session = (over = {}) => ({
  id: 'boxs-1', playerId: PID, drillId: 'box-touches', drillVersion: 1, assignmentId: null, challengeEntryId: null,
  target: { type: 'repetitions', value: 100 }, nonceHash: hashNonce(NONCE), livenessChallenge: 'show_ball',
  provider: 'local_test', providerVersion: 1, status: 'setup_required', createdAt: NOW, expiresAt: NOW + 7_200_000,
  startedAt: null, endedAt: null, livenessPassedAt: null, lastSeq: 0, batches: 0, captureContext: null,
  sessionDurationMs: null, verifiedActiveMs: null, verifiedReps: null, setsCompleted: null, targetCompleted: null, quality: null,
  interruptionsCount: null, verificationState: null, verificationReasons: [], resultHash: null, finalizedAt: null, note: null,
  clipMediaId: null, previousVerificationState: null, invalidatedAt: null, integrityEvents: [], cvProviderSessionId: null, ...over,
});
const finished = (over = {}) => session({
  status: 'verified', startedAt: NOW, endedAt: NOW + 60_000, livenessPassedAt: NOW, sessionDurationMs: 60_000, verifiedActiveMs: 55_000,
  verifiedReps: 120, setsCompleted: null, targetCompleted: true, quality: 'good', interruptionsCount: 0, verificationState: 'verified',
  verificationReasons: [], resultHash: 'a'.repeat(64), finalizedAt: NOW + 60_000, ...over,
});
/** POST /org/box-cam/assignments. */
const assignment = (over = {}) => ({
  id: 'boxa-1', playerId: PID, orgId: ORG.id, orgName: ORG.name,
  assignedBy: { userId: SCOUT.userId, name: SCOUT.name, role: null, orgVerifiedAtAssignment: true, at: NOW },
  drillId: 'box-touches', drillVersion: 1, target: { type: 'repetitions', value: 200 }, frequencyPerWeek: 3, dueDate: '2026-12-01',
  instructions: 'Both feet.', objectiveId: null, state: 'assigned', createdAt: NOW, updatedAt: NOW, ...over,
});
/** POST /org/box-cam/challenges. */
const orgChallenge = (over = {}) => ({
  id: 'boxc-1', title: 'Club touches', publisher: { kind: 'org', orgId: ORG.id, orgName: ORG.name, byName: SCOUT.name },
  drillId: 'box-touches', metric: 'reps', targetTotal: 500, startsAt: NOW, endsAt: NOW + 14 * 86_400_000, adultOnly: false, cap: 2,
  status: 'active', createdAt: NOW, ...over,
});
/** POST /player/combine/attempts. */
const attempt = (over = {}) => ({
  id: 'catt-1', playerId: PID, protocolId: 'combine-box-touch-60', protocolVersion: 1, boxSessionId: 'boxs-1', attemptNumber: 1,
  mode: 'verified', captureContext: 'at_home', requestId: null, metricType: 'count', metricUnit: 'touches', direction: 'higher',
  measurementAlgorithmVersion: 1, provider: 'local_test', providerVersion: 1,
  calibrationResult: { required: [], passed: true, checks: ['geometry_ready_check'], at: NOW },
  measuredValue: null, measurementState: null, combineState: 'ready', reasons: [], startedAt: null, completedAt: null, resultHash: null, createdAt: NOW, ...over,
});
/** The provider's canonical result (domains/development/boxcam/cv/provider.mjs #buildResult), a refusal. */
const cvResult = (over = {}) => ({
  sessionId: 'boxs-1', providerSessionId: 'pcv_abc', protocolId: 'combine-box-touch-60', providerId: 'production_cv',
  providerVersion: 1, engineVersion: 2, cvPolicyVersion: 1, outcome: 'refused', refusalReason: 'ball_not_detected', refusalDetail: 'no frames were analysed',
  observationQuality: { sufficient: false, state: 'insufficient', aggregateConfidence: 0, coverage: 0, reasons: [{ code: 'low_ball_continuity', value: 0.1, threshold: 0.6 }], secondaryDiagnostics: ['observation_discontinuity'] },
  derived: { personPresent: true, ballPresent: false, touchCount: null, juggleCount: null, activeDurationMs: 0 },
  experimental: { exactCount: null, status: 'experimental_unvalidated', note: EXPERIMENTAL_NOTE },
  integrity: { ok: true, framesAccepted: 10, framesRejected: 0, framesDroppedByServer: 0, duplicatesRejected: 0, outOfOrderRejected: 0, clientClockAnomalies: 0, framesAnalysed: 10, duplicateFrames: 0, effectiveFps: 12.5, maxBallGapMs: null, nonceBound: true, serverTimeline: true },
  trace: [{ atMs: 120, confidence: 0.9 }], traceTruncated: false, serverStartedAt: NOW, serverEndedAt: NOW + 5000, serverDurationMs: 5000,
  combineVerified: false, combineVerifiedBlockedBy: 'REAL_WORLD_VALIDATION_NOT_COMPLETED', ...over,
});

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.boxCam, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}
function seeded(label) {
  const dir = tempDir(label); saveFixture(dir);
  const s = serverOpen(dir);
  s.unit(() => { s.repo.assignments.create(assignment()); s.repo.sessions.create(session({ assignmentId: 'boxa-1' })); });
  return { s, dir };
}

// ------------------------------------------------------------- schema
test('[schema] 0031 is registered after 0030 and creates the STRICT tables (no JSON column) with the two ScoutBox challenges only', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0030_development') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s12b-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json/i, `${t} has no JSON column`);
    if (t !== 'box_challenges') assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  const seeds = s.prepare("SELECT id, publisher_kind, metric FROM box_challenges ORDER BY id").all();
  assert.deepEqual(seeds.map((r) => [r.id, r.publisher_kind]), [['boxc-scoutbox-1000-touch', 'scoutbox'], ['boxc-scoutbox-first-touch', 'scoutbox']]);
  assert.ok(!s.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%session_events%'").get(), 'no boxSessionEvents table');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.match(typeSession(session({ nonceHash: NONCE.padEnd(64, 'x') })).reason, /nonceHash/, 'a plain nonce is not a hash');
  assert.match(typeSession({ ...session(), nonce: NONCE }).reason, /boxSessions boxs-1 carries field\(s\).*nonce/);
  assert.match(typeSession(finished({ status: 'partially_verified' })).reason, /status/, 'a finished status is its verification state');
  assert.match(typeSession(finished({ verificationState: 'invalidated', status: 'invalidated' })).reason, /previousVerificationState/);
  assert.match(typeSession(finished({ verificationReasons: ['not a code!'] })).reason, /verificationReasons\[0\]/);
  assert.match(typeObservation({ kind: 'active', fromMs: 0 }, 'o').reason, /fromMs/, 'an interval needs both ends');
  assert.match(typeObservation({ kind: 'rep' }, 'o').reason, /atMs/);
  assert.match(typeObservation({ kind: 'active', fromMs: 0, toMs: 10, quality: 'great' }, 'o').reason, /quality/);
  assert.match(typeObservation({ kind: 'rep', atMs: 1, confidence: 2 }, 'o').reason, /confidence/);
  assert.match(typeObservation({ kind: 'rep', atMs: '1' }, 'o').reason, /atMs must be a number/);
  assert.match(typeChallenge(orgChallenge({ publisher: { kind: 'scoutbox', orgName: 'X' } })).reason, /publisher/);
  assert.match(typeChallenge(orgChallenge({ endsAt: NOW })).reason, /endsAt/);
  assert.match(typeAssignment(assignment({ dueDate: '1 Dec' })).reason, /dueDate/);
  assert.match(typeAssignment(assignment({ frequencyPerWeek: 0 })).reason, /frequencyPerWeek/);
  assert.match(typeAssignment(assignment({ target: { type: 'repetitions', value: '200' } })).reason, /target\.value must be a finite number/);
  assert.match(typeAssignment(assignment({ state: 'superseded' })).reason, /state/);
  assert.match(typeAttempt(attempt({ calibrationResult: { passed: true, checks: [1], at: NOW } })).reason, /checks\[0\]/);
  assert.match(typeCvResult(cvResult({ combineVerified: true })).reason, /combineVerified/);
  assert.match(typeCvResult(cvResult({ refusalReason: null })).reason, /refusalReason/);
  assert.ok(typeCvResult(cvResult()).ok);
});

// ------------------------------------------------------------- records
test('[records] a session is created and read back whole; the nonce matches only by its hash', () => {
  const { s, dir } = seeded('s12b-session');
  const got = s.repo.sessions.byId('boxs-1');
  assert.deepEqual(plain(got), plain({ ...session({ assignmentId: 'boxa-1' }) }));
  assert.ok(Object.isFrozen(got));
  assert.ok(nonceMatches(got, NONCE)); assert.ok(!nonceMatches(got, 'other')); assert.ok(!nonceMatches(got, undefined));
  const row = s.store.sqlite.prepare('SELECT * FROM box_sessions WHERE id = ?').get('boxs-1');
  assert.ok(!Object.values(row).includes(NONCE), 'the plain nonce is stored nowhere');
  refused(() => s.repo.sessions.create(session({ id: 'boxs-2', assignmentId: 'boxa-nope' })), /assignmentId names no assignment/);
  s.close(); rm(dir);
});

test('[records] recordBatch appends observations in order, closes the open pause and advances the sequence', () => {
  const { s, dir } = seeded('s12b-obs');
  s.repo.sessions.recordBatch('boxs-1', { lastSeq: 3, observations: [
    { kind: 'active', fromMs: 0, toMs: 1000, quality: 'good', atMs: null, confidence: null }, { kind: 'pause', fromMs: 1000, toMs: null, atMs: null, quality: null, confidence: null },
    { kind: 'resume', atMs: 1500 }, { kind: 'rep', atMs: 400, confidence: 0.9, fromMs: null, toMs: null, quality: null },
  ] });
  const obs = s.repo.sessions.observationsOf('boxs-1');
  assert.deepEqual(obs.active, [{ fromMs: 0, toMs: 1000, quality: 'good' }]);
  assert.deepEqual(obs.pauses, [{ fromMs: 1000, toMs: 1500 }]);
  assert.deepEqual(obs.reps, [{ atMs: 400, confidence: 0.9 }]);
  const after = s.repo.sessions.byId('boxs-1');
  assert.equal(after.lastSeq, 3); assert.equal(after.batches, 1);
  refused(() => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 3, observations: [] }), /lastSeq must grow/);
  refused(() => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 9, observations: [{ kind: 'rep' }] }), /atMs/);
  assert.equal(s.repo.sessions.byId('boxs-1').lastSeq, 3, 'a refused batch changes nothing');
  s.close(); rm(dir);
});

test('[records] a session update keeps its identity and only grows the integrity history; an invalidation restores', () => {
  const { s, dir } = seeded('s12b-update');
  s.repo.sessions.update('boxs-1', (d) => Object.assign(d, finished({ assignmentId: 'boxa-1' })));
  refused(() => s.repo.sessions.update('boxs-1', (d) => { d.nonceHash = hashNonce('x'); }), /nonceHash cannot change/);
  refused(() => s.repo.sessions.update('boxs-1', (d) => { d.lastSeq = 99; }), /lastSeq cannot change/);
  s.repo.sessions.update('boxs-1', (d) => {
    d.previousVerificationState = d.verificationState; d.verificationState = 'invalidated'; d.status = 'invalidated'; d.invalidatedAt = NOW + 1;
    d.integrityEvents.push({ type: 'invalidated', at: NOW + 1, disputeId: null, outcome: 'invalidated' });
  });
  refused(() => s.repo.sessions.update('boxs-1', (d) => { d.integrityEvents = []; }), /only grows/);
  s.repo.sessions.update('boxs-1', (d) => {
    d.verificationState = d.previousVerificationState; d.status = d.verificationState; d.previousVerificationState = null; d.invalidatedAt = null;
    d.integrityEvents.push({ type: 'restored', at: NOW + 2, to: d.verificationState });
  });
  assert.deepEqual(plain(s.repo.sessions.byId('boxs-1').integrityEvents), [{ type: 'invalidated', at: NOW + 1, outcome: 'invalidated' }, { type: 'restored', at: NOW + 2, to: 'verified' }]);
  refused(() => s.repo.sessions.update('boxs-1', (d) => { s.repo.sessions.update('boxs-1', () => {}); return d; }), /already being updated/);
  s.close(); rm(dir);
});

test('[records] challenges, entries, prefs, requests, attempts and CV results round-trip; derived parts worked out on read', () => {
  const { s, dir } = seeded('s12b-all');
  assert.deepEqual(plain(s.repo.prefs.forPlayer(PID)), { playerId: PID, shareDevelopmentActivity: 'private', retainClips: false, updatedAt: null, updatedBy: null });
  assert.equal(s.store.sqlite.prepare('SELECT count(*) AS n FROM box_cam_prefs').get().n, 0, 'reading the defaults writes no row');
  s.repo.prefs.save({ playerId: PID, shareDevelopmentActivity: 'recruitment', retainClips: true, updatedAt: NOW, updatedBy: { kind: 'player', id: PID } });
  assert.ok(s.repo.prefs.sharesForRecruitment(PID));
  s.repo.challenges.create(orgChallenge());
  assert.deepEqual(plain(s.repo.challenges.byId('boxc-1')), orgChallenge());
  assert.deepEqual(plain(s.repo.challenges.byId('boxc-scoutbox-1000-touch').publisher), { kind: 'scoutbox' });
  assert.equal(s.repo.challenges.open(NOW).length, 3);
  s.repo.entries.create({ id: 'boxe-1', challengeId: 'boxc-1', playerId: PID, status: 'active', progress: 0, joinedAt: NOW, joinedBy: { kind: 'player', id: PID }, completedAt: null });
  refused(() => s.repo.entries.create({ id: 'boxe-2', challengeId: 'boxc-1', playerId: PID, status: 'active', progress: 0, joinedAt: NOW, joinedBy: { kind: 'player', id: PID }, completedAt: null }), /already joined/);
  assert.equal(s.repo.challenges.participants(['boxc-1']).get('boxc-1'), 1);
  s.repo.requests.create({ id: 'creq-1', orgId: ORG.id, orgName: ORG.name, requestedBy: { userId: SCOUT.userId, name: SCOUT.name, role: null, at: NOW }, playerId: PID, title: null, protocolIds: ['combine-box-touch-60', 'combine-box-juggle'], deadline: '2026-12-01', instructions: null, state: 'requested', createdAt: NOW, completedAt: null });
  assert.deepEqual(s.repo.requests.byId('creq-1').protocolIds, ['combine-box-touch-60', 'combine-box-juggle']);
  assert.ok(s.repo.requests.activeBetween(ORG.id, PID));
  s.repo.attempts.create(attempt({ requestId: 'creq-1' }));
  assert.deepEqual(plain(s.repo.attempts.bySession('boxs-1').calibrationResult), { required: [], passed: true, checks: ['geometry_ready_check'], at: NOW });
  refused(() => s.repo.attempts.create(attempt({ id: 'catt-2' })), /already bound/);
  s.repo.attempts.update('catt-1', (d) => { d.combineState = 'partially_measured'; d.measurementState = 'practice'; d.reasons = ['PRACTICE_ATTEMPT']; d.completedAt = NOW; });
  refused(() => s.repo.attempts.update('catt-1', (d) => { d.boxSessionId = 'boxs-9'; }), /boxSessionId cannot change/);
  assert.equal(s.repo.attempts.count(PID, 'combine-box-touch-60', { mode: 'verified', since: NOW }), 1);
  s.repo.cvResults.record(cvResult());
  assert.deepEqual(plain(s.repo.cvResults.byProviderSession('pcv_abc')), cvResult());
  assert.deepEqual(plain(s.repo.cvResults.latestForSession('boxs-1')), cvResult());
  refused(() => s.repo.cvResults.record(cvResult()), /already exists/);
  s.close(); rm(dir);
});

test('[queries] the dispute queue pages oldest first; a rolled-back unit leaves nothing', () => {
  const { s, dir } = seeded('s12b-queue');
  s.unit(() => {
    for (let i = 1; i <= 3; i++) s.repo.disputes.create({ id: `boxd-${i}`, sessionId: 'boxs-1', playerId: PID, by: { kind: 'player', id: PID, name: 'Kola' }, reason: 'Wrong count', status: 'open', resolution: null, createdAt: NOW + i });
  });
  const first = s.repo.disputes.queue({ limit: 2 });
  assert.deepEqual(first.map((d) => d.id), ['boxd-1', 'boxd-2']);
  assert.deepEqual(s.repo.disputes.queue({ after: [first[1].createdAt, first[1].id], limit: 2 }).map((d) => d.id), ['boxd-3']);
  s.repo.disputes.update('boxd-1', (d) => { d.status = 'resolved'; d.resolution = { outcome: 'stands', reason: 'ok', at: NOW }; });
  refused(() => s.repo.disputes.update('boxd-1', (d) => { d.resolution.reason = 'again'; }), /already resolved/);
  assert.deepEqual(s.repo.disputes.queue().map((d) => d.id), ['boxd-2', 'boxd-3']);
  assert.equal(s.repo.disputes.queue({ all: true }).length, 3);
  refused(() => s.unit(() => { s.repo.assignments.create(assignment({ id: 'boxa-2' })); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.assignments.byId('boxa-2'), null);
  s.close(); rm(dir);
});

test('[layer] the db.* names throw, and the snapshot write types, names a missing reference and reads back what it wrote', () => {
  const { s, dir } = seeded('s12b-snapshot');
  for (const n of [...COLLECTIONS, 'boxSessionEvents']) assert.throws(() => s.db[n], /boxCam repository/, n);
  s.repo.sessions.recordBatch('boxs-1', { lastSeq: 1, observations: [{ kind: 'presence', fromMs: 0, toMs: 10, quality: 'good', atMs: null, confidence: null }] });
  s.close();
  const store = openStore(dir); // snapshot mode (tools, fixtures, the persistence batteries)
  const read = readTableBacked(store.sqlite);
  assert.deepEqual(read.boxSessions[0].obs.presence, [{ fromMs: 0, toMs: 10, quality: 'good' }]);
  assert.equal(read.boxChallenges.length, 2);
  const save = (db) => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, ...db } });
  refused(() => save({ boxSessions: [...read.boxSessions, session({ id: 'boxs-2', nonceHash: 'plain' })] }), /BOX_CAM_IMPORT_BLOCKED.*nonceHash/);
  refused(() => save({ combineAttempts: [attempt({ boxSessionId: 'boxs-404' })] }), /BOX_CAM_REFERENCE_MISSING.*boxs-404/);
  save({ combineAttempts: [attempt()] });
  const again = readTableBacked(store.sqlite);
  assert.equal(again.combineAttempts[0].id, 'catt-1');
  assert.deepEqual(again.boxSessions[0].obs.presence, [{ fromMs: 0, toMs: 10, quality: 'good' }], 'a kept collection keeps its observations');
  store.sqlite.close(); rm(dir);
});

console.log(`${passed} Box Cam checks passed`);
