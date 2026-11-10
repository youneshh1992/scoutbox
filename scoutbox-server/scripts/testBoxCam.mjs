// Box Cam, the At-Home Combine and the production CV results (repositories/boxCam.mjs, migration 0031): the STRICT
// tables and the two seeded ScoutBox challenges, the columns' and keys' refusals (a plain nonce is never stored; a CV
// result cannot claim Combine Verified; a session cites only its own player's records), records read back whole with
// their derived parts, recordBatch, the named acts and the states they move from, the routes' queries, units of work
// and fixtures. Temporary databases only; nothing touches
// DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  BOX_CAM_MIGRATION as MIGRATION,
  BOX_CAM_TABLES as TABLES,
  BOX_CAM_COLLECTIONS as COLLECTIONS,
  EXPERIMENTAL_NOTE,
  hashNonce,
  nonceMatches,
} from '../repositories/boxCam.mjs';
import { typeObservation } from '../domains/development/boxcam/shared.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const PID = 'pl-1';
const NONCE = 'plain-nonce-from-the-response';
/** POST /player/box-cam/sessions (domains/development/boxcam/sessions.mjs). */
const session = (over = {}) => ({
  id: 'boxs-1',
  playerId: PID,
  drillId: 'box-touches',
  drillVersion: 1,
  assignmentId: null,
  challengeEntryId: null,
  target: { type: 'repetitions', value: 100 },
  nonceHash: hashNonce(NONCE),
  livenessChallenge: 'show_ball',
  provider: 'local_test',
  providerVersion: 1,
  status: 'setup_required',
  createdAt: NOW,
  expiresAt: NOW + 7_200_000,
  startedAt: null,
  endedAt: null,
  livenessPassedAt: null,
  lastSeq: 0,
  batches: 0,
  captureContext: null,
  sessionDurationMs: null,
  verifiedActiveMs: null,
  verifiedReps: null,
  setsCompleted: null,
  targetCompleted: null,
  quality: null,
  interruptionsCount: null,
  verificationState: null,
  verificationReasons: [],
  resultHash: null,
  finalizedAt: null,
  note: null,
  clipMediaId: null,
  previousVerificationState: null,
  invalidatedAt: null,
  integrityEvents: [],
  cvProviderSessionId: null,
  ...over,
});
const finished = (over = {}) =>
  session({
    status: 'verified',
    startedAt: NOW,
    endedAt: NOW + 60_000,
    livenessPassedAt: NOW,
    sessionDurationMs: 60_000,
    verifiedActiveMs: 55_000,
    verifiedReps: 120,
    setsCompleted: null,
    targetCompleted: true,
    quality: 'good',
    interruptionsCount: 0,
    verificationState: 'verified',
    verificationReasons: [],
    resultHash: 'a'.repeat(64),
    finalizedAt: NOW + 60_000,
    ...over,
  });
/** POST /org/box-cam/assignments. */
const assignment = (over = {}) => ({
  id: 'boxa-1',
  playerId: PID,
  orgId: ORG.id,
  orgName: ORG.name,
  assignedBy: { userId: SCOUT.userId, name: SCOUT.name, role: null, orgVerifiedAtAssignment: true, at: NOW },
  drillId: 'box-touches',
  drillVersion: 1,
  target: { type: 'repetitions', value: 200 },
  frequencyPerWeek: 3,
  dueDate: '2026-12-01',
  instructions: 'Both feet.',
  objectiveId: null,
  state: 'assigned',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
/** POST /org/box-cam/challenges. */
const orgChallenge = (over = {}) => ({
  id: 'boxc-1',
  title: 'Club touches',
  publisher: { kind: 'org', orgId: ORG.id, orgName: ORG.name, byName: SCOUT.name },
  drillId: 'box-touches',
  metric: 'reps',
  targetTotal: 500,
  startsAt: NOW,
  endsAt: NOW + 14 * 86_400_000,
  adultOnly: false,
  cap: 2,
  status: 'active',
  createdAt: NOW,
  ...over,
});
/** POST /player/combine/attempts. */
const attempt = (over = {}) => ({
  id: 'catt-1',
  playerId: PID,
  protocolId: 'combine-box-touch-60',
  protocolVersion: 1,
  boxSessionId: 'boxs-1',
  attemptNumber: 1,
  mode: 'verified',
  captureContext: 'at_home',
  requestId: null,
  metricType: 'count',
  metricUnit: 'touches',
  direction: 'higher',
  measurementAlgorithmVersion: 1,
  provider: 'local_test',
  providerVersion: 1,
  calibrationResult: { required: [], passed: true, checks: ['geometry_ready_check'], at: NOW },
  measuredValue: null,
  measurementState: null,
  combineState: 'ready',
  reasons: [],
  startedAt: null,
  completedAt: null,
  resultHash: null,
  createdAt: NOW,
  ...over,
});
/** The provider's canonical result (domains/development/boxcam/cv/provider.mjs #buildResult), a refusal. */
const cvResult = (over = {}) => ({
  sessionId: 'boxs-1',
  providerSessionId: 'pcv_abc',
  protocolId: 'combine-box-touch-60',
  providerId: 'production_cv',
  providerVersion: 1,
  engineVersion: 2,
  cvPolicyVersion: 1,
  outcome: 'refused',
  refusalReason: 'ball_not_detected',
  refusalDetail: 'no frames were analysed',
  observationQuality: {
    sufficient: false,
    state: 'insufficient',
    aggregateConfidence: 0,
    coverage: 0,
    reasons: [{ code: 'low_ball_continuity', value: 0.1, threshold: 0.6 }],
    secondaryDiagnostics: ['observation_discontinuity'],
  },
  derived: { personPresent: true, ballPresent: false, touchCount: null, juggleCount: null, activeDurationMs: 0 },
  experimental: { exactCount: null, status: 'experimental_unvalidated', note: EXPERIMENTAL_NOTE },
  integrity: {
    ok: true,
    framesAccepted: 10,
    framesRejected: 0,
    framesDroppedByServer: 0,
    duplicatesRejected: 0,
    outOfOrderRejected: 0,
    clientClockAnomalies: 0,
    framesAnalysed: 10,
    duplicateFrames: 0,
    effectiveFps: 12.5,
    maxBallGapMs: null,
    nonceBound: true,
    serverTimeline: true,
  },
  trace: [{ atMs: 120, confidence: 0.9 }],
  traceTruncated: false,
  serverStartedAt: NOW,
  serverEndedAt: NOW + 5000,
  serverDurationMs: 5000,
  combineVerified: false,
  combineVerifiedBlockedBy: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
  ...over,
});

function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.boxCam, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
function seeded(label) {
  const dir = tempDir(label);
  saveFixture(dir);
  const s = serverOpen(dir);
  s.unit(() => {
    s.repo.assignments.create(assignment());
    s.repo.sessions.create(session({ assignmentId: 'boxa-1' }));
  });
  return { s, dir };
}

// ------------------------------------------------------------- schema
test('[schema] 0031 is registered after 0030 and creates the STRICT tables (no JSON column) with the two ScoutBox challenges only', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0030_development') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s12b-empty');
  const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json/i, `${t} has no JSON column`);
    if (t !== 'box_challenges')
      assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  const seeds = s.prepare('SELECT id, publisher_kind, metric FROM box_challenges ORDER BY id').all();
  assert.deepEqual(
    seeds.map((r) => [r.id, r.publisher_kind]),
    [
      ['boxc-scoutbox-1000-touch', 'scoutbox'],
      ['boxc-scoutbox-first-touch', 'scoutbox'],
    ],
  );
  assert.ok(
    !s.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%session_events%'").get(),
    'no boxSessionEvents table',
  );
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- writes
test('[writes] junk is refused by the columns and keys, naming the record and field; nothing is written', () => {
  const { s, dir } = seeded('s12b-junk');
  const create = (kind, r) => () => s.repo[kind].create(r);
  refused(
    create('sessions', session({ id: 'boxs-2', nonceHash: NONCE.padEnd(64, 'x') })),
    /BOX_CAM_INPUT_INVALID: box_sessions boxs-2 row: CHECK/,
    'a plain nonce is not a hash',
  );
  refused(
    create('sessions', { ...session({ id: 'boxs-2' }), nonce: NONCE }),
    /box_sessions boxs-2 nonce: is not stored as written/,
  );
  refused(
    create('sessions', finished({ id: 'boxs-2', status: 'partially_verified' })),
    /boxs-2 row: CHECK/,
    'a finished status is its verification state',
  );
  refused(
    create('sessions', finished({ id: 'boxs-2', verificationState: 'invalidated', status: 'invalidated' })),
    /boxs-2 row: CHECK/,
    'an invalidation keeps the state it set aside',
  );
  refused(
    create('sessions', finished({ id: 'boxs-2', verificationReasons: ['not a code!'] })),
    /boxs-2 verificationReasons\[0\]: CHECK/,
  );
  refused(
    create('sessions', session({ id: 'boxs-2', playerId: 'pl-2', assignmentId: 'boxa-1' })),
    /boxs-2 row: FOREIGN KEY/,
    "another player's assignment",
  );
  refused(
    create('sessions', session({ id: 'boxs-2', obs: { active: [{ fromMs: 0 }] } })),
    /boxs-2 obs\.active\[0\]: CHECK/,
    'an interval needs both ends',
  );
  refused(
    create('challenges', orgChallenge({ publisher: { kind: 'scoutbox', orgName: 'X' } })),
    /box_challenges boxc-1 row: CHECK/,
  );
  refused(create('challenges', orgChallenge({ endsAt: NOW })), /boxc-1 row: CHECK/);
  refused(create('assignments', assignment({ id: 'boxa-2', dueDate: '1 Dec' })), /boxa-2 row: CHECK/);
  refused(create('assignments', assignment({ id: 'boxa-2', frequencyPerWeek: 0 })), /boxa-2 row: CHECK/);
  refused(
    create('assignments', assignment({ id: 'boxa-2', target: { type: 'repetitions', value: '200' } })),
    /boxa-2 (row|target\.value)/,
  );
  refused(create('assignments', assignment({ id: 'boxa-2', state: 'superseded' })), /boxa-2 row: CHECK/);
  refused(
    create('attempts', attempt({ calibrationResult: { passed: true, checks: [1], at: NOW } })),
    /catt-1 calibrationResult\.checks/,
  );
  refused(create('attempts', attempt({ playerId: 'pl-2' })), /catt-1 row: FOREIGN KEY/, "another player's session");
  refused(
    create('disputes', {
      id: 'boxd-1',
      sessionId: 'boxs-1',
      playerId: 'pl-2',
      by: { kind: 'player', id: 'pl-2' },
      reason: 'x',
      status: 'open',
      resolution: null,
      createdAt: NOW,
    }),
    /boxd-1 row: FOREIGN KEY/,
  );
  refused(() => s.repo.cvResults.record(cvResult({ combineVerified: true })), /pcv_abc row: CHECK/);
  refused(() => s.repo.cvResults.record(cvResult({ refusalReason: null })), /pcv_abc row: CHECK/);
  refused(
    () => s.repo.cvResults.record(cvResult({ trace: [{ atMs: 1, confidence: 0.5, frame: 'x' }] })),
    /pcv_abc trace\[0\]\.frame: is not stored as written/,
  );
  assert.deepEqual(
    s.repo.sessions.forPlayer(PID).map((x) => x.id),
    ['boxs-1'],
    'a refused create wrote nothing',
  );
  assert.equal(s.repo.cvResults.latestForSession('boxs-1'), null);
  s.close();
  rm(dir);
});

test('[writes] the events route refuses an observation the engine cannot read', () => {
  assert.match(typeObservation({ kind: 'active', fromMs: 0 }, 'o').reason, /fromMs/, 'an interval needs both ends');
  assert.match(typeObservation({ kind: 'rep' }, 'o').reason, /atMs/);
  assert.match(typeObservation({ kind: 'active', fromMs: 0, toMs: 10, quality: 'great' }, 'o').reason, /quality/);
  assert.match(typeObservation({ kind: 'rep', atMs: 1, confidence: 2 }, 'o').reason, /confidence/);
  assert.match(typeObservation({ kind: 'rep', atMs: '1' }, 'o').reason, /atMs must be a number/);
  assert.ok(typeObservation({ kind: 'rep', atMs: 1, confidence: 0.5 }, 'o').ok);
});

// ------------------------------------------------------------- records
test('[records] a session is created and read back whole; the nonce matches only by its hash', () => {
  const { s, dir } = seeded('s12b-session');
  const got = s.repo.sessions.byId('boxs-1');
  assert.deepEqual(plain(got), plain({ ...session({ assignmentId: 'boxa-1' }) }));
  assert.ok(Object.isFrozen(got));
  assert.ok(nonceMatches(got, NONCE));
  assert.ok(!nonceMatches(got, 'other'));
  assert.ok(!nonceMatches(got, undefined));
  const row = s.store.sqlite.prepare('SELECT * FROM box_sessions WHERE id = ?').get('boxs-1');
  assert.ok(!Object.values(row).includes(NONCE), 'the plain nonce is stored nowhere');
  refused(
    () => s.repo.sessions.create(session({ id: 'boxs-2', assignmentId: 'boxa-nope' })),
    /box_sessions boxs-2 row: FOREIGN KEY/,
  );
  s.close();
  rm(dir);
});

test('[records] recordBatch appends observations in order, closes the open pause and advances the sequence', () => {
  const { s, dir } = seeded('s12b-obs');
  refused(
    () => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 1, observations: [] }),
    /lastSeq must grow while recording/,
    'a batch only while recording',
  );
  s.repo.sessions.start('boxs-1', { at: NOW });
  s.repo.sessions.recordBatch('boxs-1', {
    lastSeq: 3,
    observations: [
      { kind: 'active', fromMs: 0, toMs: 1000, quality: 'good', atMs: null, confidence: null },
      { kind: 'pause', fromMs: 1000, toMs: null, atMs: null, quality: null, confidence: null },
      { kind: 'resume', atMs: 1500 },
      { kind: 'rep', atMs: 400, confidence: 0.9, fromMs: null, toMs: null, quality: null },
    ],
  });
  const obs = s.repo.sessions.observationsOf('boxs-1');
  assert.deepEqual(obs.active, [{ fromMs: 0, toMs: 1000, quality: 'good' }]);
  assert.deepEqual(obs.pauses, [{ fromMs: 1000, toMs: 1500 }]);
  assert.deepEqual(obs.reps, [{ atMs: 400, confidence: 0.9 }]);
  const after = s.repo.sessions.byId('boxs-1');
  assert.equal(after.lastSeq, 3);
  assert.equal(after.batches, 1);
  refused(
    () => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 3, observations: [] }),
    /BOX_CAM_STATE_CONFLICT: box_sessions boxs-1: lastSeq must grow/,
  );
  refused(
    () => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 9, observations: [{ kind: 'rep' }] }),
    /observations\[0\]: CHECK/,
  );
  refused(
    () => s.repo.sessions.recordBatch('boxs-1', { lastSeq: 9, observations: [{ kind: 'rep', atMs: 1, extra: 1 }] }),
    /observations\[0\]: carries field\(s\).*extra/,
  );
  assert.equal(s.repo.sessions.byId('boxs-1').lastSeq, 3, 'a refused batch changes nothing');
  s.close();
  rm(dir);
});

test('[acts] a session moves only from the state each act names; the integrity history is only inserted', () => {
  const { s, dir } = seeded('s12b-acts');
  const S = s.repo.sessions;
  refused(
    () => S.finish('boxs-1', { status: 'verified', verificationState: 'verified' }),
    /BOX_CAM_STATE_CONFLICT: box_sessions boxs-1 is not recording/,
  );
  refused(() => S.setNote('boxs-1', { note: 'x' }), /is not finished/);
  S.start('boxs-1', { at: NOW });
  refused(() => S.start('boxs-1', { at: NOW }), /is not waiting to start/);
  refused(() => S.expire('boxs-1'), /is not waiting to start/);
  S.bindCvSession('boxs-1', { providerSessionId: 'pcv_1' });
  refused(
    () => S.finish('boxs-1', { status: 'verified', verificationState: 'verified', nonceHash: hashNonce('x') }),
    /nonceHash is not a field this act sets/,
  );
  const result = {
    status: 'verified',
    endedAt: NOW + 60_000,
    sessionDurationMs: 60_000,
    verifiedActiveMs: 55_000,
    verifiedReps: 120,
    setsCompleted: null,
    targetCompleted: true,
    quality: 'good',
    interruptionsCount: 0,
    verificationState: 'verified',
    verificationReasons: ['REP_COUNT_NOT_CONFIGURED'],
    resultHash: 'a'.repeat(64),
    finalizedAt: NOW + 60_000,
  };
  S.finish('boxs-1', result);
  assert.deepEqual(
    plain(S.byId('boxs-1')),
    plain(
      finished({
        assignmentId: 'boxa-1',
        cvProviderSessionId: 'pcv_1',
        verificationReasons: ['REP_COUNT_NOT_CONFIGURED'],
      }),
    ),
  );
  refused(() => S.finish('boxs-1', result), /is not recording/, 'a result is worked out once');
  refused(() => S.cancel('boxs-1'), /is already finished/);
  refused(() => S.restore('boxs-1', { at: NOW }), /is not invalidated/);
  S.setNote('boxs-1', { note: 'Good session' });
  S.invalidate('boxs-1', { at: NOW + 1, disputeId: null, outcome: 'invalidated' });
  refused(() => S.invalidate('boxs-1', { at: NOW + 1, outcome: 'invalidated' }), /has no result to invalidate/);
  assert.equal(S.byId('boxs-1').previousVerificationState, 'verified');
  S.restore('boxs-1', { at: NOW + 2 });
  const back = S.byId('boxs-1');
  assert.equal(back.status, 'verified');
  assert.equal(back.verificationState, 'verified');
  assert.equal(back.previousVerificationState, null);
  assert.equal(back.note, 'Good session');
  assert.deepEqual(plain(back.integrityEvents), [
    { type: 'invalidated', at: NOW + 1, outcome: 'invalidated' },
    { type: 'restored', at: NOW + 2, to: 'verified' },
  ]);
  refused(() => S.start('boxs-404', { at: NOW }), /BOX_CAM_NOT_FOUND/);
  s.close();
  rm(dir);
});

test('[acts] assignments, entries, disputes, requests and attempts move only from the state each act names', () => {
  const { s, dir } = seeded('s12b-acts2');
  const A = s.repo.assignments;
  A.accept('boxa-1', { at: NOW + 1 });
  refused(() => A.accept('boxa-1', { at: NOW + 2 }), /is not waiting to be accepted/);
  refused(() => A.progress('boxa-1', { state: 'assigned', at: NOW }), /BOX_CAM_INPUT_INVALID/);
  assert.equal(A.progress('boxa-1', { state: 'in_progress', at: NOW + 3 }).updatedAt, NOW + 3);
  A.cancel('boxa-1', { at: NOW + 4 });
  refused(() => A.cancel('boxa-1', { at: NOW + 5 }), /already cancelled/);
  refused(() => A.progress('boxa-1', { state: 'completed', at: NOW + 5 }), /is cancelled/);
  s.repo.challenges.create(orgChallenge());
  s.repo.entries.create({
    id: 'boxe-1',
    challengeId: 'boxc-1',
    playerId: PID,
    status: 'active',
    progress: 0,
    joinedAt: NOW,
    joinedBy: { kind: 'player', id: PID },
    completedAt: null,
  });
  s.repo.entries.progress('boxe-1', { progress: 200 });
  assert.equal(s.repo.entries.progress('boxe-1', { progress: 500, completedAt: NOW }).status, 'completed');
  refused(
    () => s.repo.entries.progress('boxe-1', { progress: 600 }),
    /is not active/,
    'a completed entry stays completed',
  );
  s.repo.disputes.create({
    id: 'boxd-1',
    sessionId: 'boxs-1',
    playerId: PID,
    by: { kind: 'player', id: PID, name: 'Kola' },
    reason: 'Wrong count',
    status: 'open',
    resolution: null,
    createdAt: NOW,
  });
  assert.deepEqual(plain(s.repo.disputes.resolve('boxd-1', { outcome: 'stands', reason: 'ok', at: NOW }).resolution), {
    outcome: 'stands',
    reason: 'ok',
    at: NOW,
  });
  refused(() => s.repo.disputes.resolve('boxd-1', { outcome: 'stands', reason: 'again', at: NOW }), /already resolved/);
  const R = s.repo.requests;
  R.create({
    id: 'creq-1',
    orgId: ORG.id,
    orgName: ORG.name,
    requestedBy: { userId: SCOUT.userId, name: SCOUT.name, role: null, at: NOW },
    playerId: PID,
    title: null,
    protocolIds: ['combine-box-touch-60'],
    deadline: null,
    instructions: null,
    state: 'requested',
    createdAt: NOW,
    completedAt: null,
  });
  R.complete('creq-1', { at: NOW });
  refused(() => R.complete('creq-1', { at: NOW }), /is not open/);
  refused(() => R.cancel('creq-1'), /already completed/);
  const T = s.repo.attempts;
  T.create(attempt({ calibrationResult: null }));
  assert.deepEqual(
    plain(T.calibrate('catt-1', { passed: true, checks: ['geometry_ready_check'], at: NOW }).calibrationResult),
    { required: [], passed: true, checks: ['geometry_ready_check'], at: NOW },
  );
  T.markStarted('catt-1', { startedAt: NOW });
  const done = T.measure('catt-1', {
    measuredValue: 42,
    measurementState: 'measured',
    combineState: 'combine_verified',
    reasons: ['A_REASON'],
    completedAt: NOW + 1,
    resultHash: 'b'.repeat(64),
  });
  assert.deepEqual(
    [done.combineState, done.measuredValue, done.startedAt, done.reasons],
    ['combine_verified', 42, NOW, ['A_REASON']],
  );
  refused(() => T.cancel('catt-1', { at: NOW }), /already finished; a cancellation is refused/);
  refused(
    () => T.measure('catt-1', { combineState: 'ready', boxSessionId: 'boxs-9' }),
    /boxSessionId is not a field this act sets/,
  );
  s.close();
  rm(dir);
});

test('[records] challenges, entries, prefs, requests, attempts and CV results round-trip; derived parts worked out on read', () => {
  const { s, dir } = seeded('s12b-all');
  assert.deepEqual(plain(s.repo.prefs.forPlayer(PID)), {
    playerId: PID,
    shareDevelopmentActivity: 'private',
    retainClips: false,
    updatedAt: null,
    updatedBy: null,
  });
  assert.equal(
    s.store.sqlite.prepare('SELECT count(*) AS n FROM box_cam_prefs').get().n,
    0,
    'reading the defaults writes no row',
  );
  s.repo.prefs.save({
    playerId: PID,
    shareDevelopmentActivity: 'recruitment',
    retainClips: true,
    updatedAt: NOW,
    updatedBy: { kind: 'player', id: PID },
  });
  assert.ok(s.repo.prefs.sharesForRecruitment(PID));
  s.repo.challenges.create(orgChallenge());
  assert.deepEqual(plain(s.repo.challenges.byId('boxc-1')), orgChallenge());
  assert.deepEqual(plain(s.repo.challenges.byId('boxc-scoutbox-1000-touch').publisher), { kind: 'scoutbox' });
  assert.equal(s.repo.challenges.open(NOW).length, 3);
  s.repo.entries.create({
    id: 'boxe-1',
    challengeId: 'boxc-1',
    playerId: PID,
    status: 'active',
    progress: 0,
    joinedAt: NOW,
    joinedBy: { kind: 'player', id: PID },
    completedAt: null,
  });
  refused(
    () =>
      s.repo.entries.create({
        id: 'boxe-2',
        challengeId: 'boxc-1',
        playerId: PID,
        status: 'active',
        progress: 0,
        joinedAt: NOW,
        joinedBy: { kind: 'player', id: PID },
        completedAt: null,
      }),
    /already joined/,
  );
  assert.equal(s.repo.challenges.participants(['boxc-1']).get('boxc-1'), 1);
  s.repo.requests.create({
    id: 'creq-1',
    orgId: ORG.id,
    orgName: ORG.name,
    requestedBy: { userId: SCOUT.userId, name: SCOUT.name, role: null, at: NOW },
    playerId: PID,
    title: null,
    protocolIds: ['combine-box-touch-60', 'combine-box-juggle'],
    deadline: '2026-12-01',
    instructions: null,
    state: 'requested',
    createdAt: NOW,
    completedAt: null,
  });
  assert.deepEqual(s.repo.requests.byId('creq-1').protocolIds, ['combine-box-touch-60', 'combine-box-juggle']);
  assert.ok(s.repo.requests.activeBetween(ORG.id, PID));
  s.repo.attempts.create(attempt({ requestId: 'creq-1' }));
  assert.deepEqual(plain(s.repo.attempts.bySession('boxs-1').calibrationResult), {
    required: [],
    passed: true,
    checks: ['geometry_ready_check'],
    at: NOW,
  });
  refused(() => s.repo.attempts.create(attempt({ id: 'catt-2' })), /already bound/);
  s.repo.attempts.measure('catt-1', {
    combineState: 'partially_measured',
    measurementState: 'practice',
    reasons: ['PRACTICE_ATTEMPT'],
    completedAt: NOW,
  });
  assert.equal(s.repo.attempts.count(PID, 'combine-box-touch-60', { mode: 'verified', since: NOW }), 1);
  s.repo.cvResults.record(cvResult());
  assert.deepEqual(plain(s.repo.cvResults.byProviderSession('pcv_abc')), cvResult());
  assert.deepEqual(plain(s.repo.cvResults.latestForSession('boxs-1')), cvResult());
  refused(() => s.repo.cvResults.record(cvResult()), /already exists/);
  s.close();
  rm(dir);
});

test('[queries] the dispute queue pages oldest first; a rolled-back unit leaves nothing', () => {
  const { s, dir } = seeded('s12b-queue');
  s.unit(() => {
    for (let i = 1; i <= 3; i++)
      s.repo.disputes.create({
        id: `boxd-${i}`,
        sessionId: 'boxs-1',
        playerId: PID,
        by: { kind: 'player', id: PID, name: 'Kola' },
        reason: 'Wrong count',
        status: 'open',
        resolution: null,
        createdAt: NOW + i,
      });
  });
  const first = s.repo.disputes.queue({ limit: 2 });
  assert.deepEqual(
    first.map((d) => d.id),
    ['boxd-1', 'boxd-2'],
  );
  assert.deepEqual(
    s.repo.disputes.queue({ after: [first[1].createdAt, first[1].id], limit: 2 }).map((d) => d.id),
    ['boxd-3'],
  );
  s.repo.disputes.resolve('boxd-1', { outcome: 'stands', reason: 'ok', at: NOW });
  assert.deepEqual(
    s.repo.disputes.queue().map((d) => d.id),
    ['boxd-2', 'boxd-3'],
  );
  assert.equal(s.repo.disputes.queue({ all: true }).length, 3);
  refused(
    () =>
      s.unit(() => {
        s.repo.assignments.create(assignment({ id: 'boxa-2' }));
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(s.repo.assignments.byId('boxa-2'), null);
  s.close();
  rm(dir);
});

test('[layer] a fixture written through the repository is checked by the columns, refuses a missing reference (nothing written), and the records read back as written', () => {
  const { s, dir } = seeded('s12b-fix');
  s.repo.sessions.start('boxs-1', { at: NOW });
  s.repo.sessions.recordBatch('boxs-1', {
    lastSeq: 1,
    observations: [{ kind: 'presence', fromMs: 0, toMs: 10, quality: 'good', atMs: null, confidence: null }],
  });
  s.close();
  const read = readRecords(dir);
  assert.deepEqual(read.boxSessions[0].obs.presence, [{ fromMs: 0, toMs: 10, quality: 'good' }]);
  assert.equal(read.boxChallenges.length, 2);
  const write = (db) => writeFixture(dir, db, { now: NOW });
  refused(
    () => write({ boxSessions: [session({ id: 'boxs-2', nonceHash: 'plain' })] }),
    /BOX_CAM_INPUT_INVALID: box_sessions boxs-2 row: CHECK/,
  );
  refused(
    () => write({ boxSessions: [session({ id: 'boxs-3' })], combineAttempts: [attempt({ boxSessionId: 'boxs-404' })] }),
    /BOX_CAM_INPUT_INVALID: combine_attempts catt-1 row: FOREIGN KEY/,
  );
  assert.deepEqual(
    readRecords(dir).boxSessions.map((x) => x.id),
    ['boxs-1'],
    'a refused fixture wrote nothing',
  );
  write({ combineAttempts: [attempt()] });
  const again = readRecords(dir);
  assert.equal(again.combineAttempts[0].id, 'catt-1');
  assert.deepEqual(
    again.boxSessions[0].obs.presence,
    [{ fromMs: 0, toMs: 10, quality: 'good' }],
    'the stored session keeps its observations',
  );
  rm(dir);
});

console.log(`${passed} Box Cam checks passed`);
