// Box Cam + Development Intelligence.
// Full HTTP journeys B1–B12 and the abuse catalogue. Well over 40% of checks
// are negative/edge/security cases. The pure-engine checks (active time, reps,
// states, streak, challenge progress) are in scripts/rules/development/boxCam.mjs.
//
// The test-only observation provider (local_test) is enabled via
// BOX_CAM_TEST_PROVIDER=1 — simulated observations are always labelled
// simulated and can never exist in production.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverCommand, serverDir } from '../support/server.mjs';
import { liveStream } from '../support/liveEvents.mjs';
import { readRows } from '../support/sqlRows.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m16-'));

let passed = 0;
let negatives = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
  TEST_LICENCE_REGISTRY: '1',
  BOX_CAM_TEST_PROVIDER: '1',
};
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
{
  const proc = spawn(...serverCommand(), { cwd: serverDir, env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      up = r.ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const MIN = 60_000;
// ==================================================== HTTP actors
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const ruth = await login('org-harbour', 'Ruth Vane', 'Scout'); // unverified club
const alex = await login('org-northstar', 'Alex Agent', 'Agent'); // agency
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots'); // verified grassroots, London
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body; // adult, Manchester
// Kola's own stream: how many times it heard their development evidence change, from a mark on.
const KOLA_STREAM = await liveStream(BASE, j, kola.token);
const evidencePings = async (from, atLeast) => {
  await KOLA_STREAM.waitFor(
    () =>
      KOLA_STREAM.frames()
        .slice(from)
        .filter((f) => f.event === 'player_development_evidence_changed' && f.playerId === 'pl-adeyemi').length >=
      atLeast,
    from,
    1500,
  );
  return KOLA_STREAM.frames()
    .slice(from)
    .filter((f) => f.event === 'player_development_evidence_changed' && f.playerId === 'pl-adeyemi').length;
};
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body; // minor, London
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(
  [maria, ruth, alex, dee, kola, guni, amara].every((a) => a?.token),
  'all actors logged in',
);

// helper: run a full simulated Box Session
async function runSession(
  token,
  { drillId, target, provider = 'local_test', assignmentId, challengeEntryId },
  events,
  { liveness = 'auto', completeBody = {} } = {},
) {
  const created = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId, target, provider, assignmentId, challengeEntryId },
    token,
  );
  if (created.status !== 201) return { created };
  const { session, nonce, livenessChallenge } = created.body;
  const started = await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/start`,
    { nonce, liveness: liveness === 'auto' ? livenessChallenge : liveness },
    token,
  );
  if (started.status !== 200) return { created, started, session, nonce };
  let ev;
  for (let i = 0; i < events.length; i += 180) {
    // respect the per-batch cap; multiple ordered batches
    ev = await j(
      'POST',
      `/player/box-cam/sessions/${session.id}/events`,
      { nonce, batch: events.slice(i, i + 180) },
      token,
    );
    if (ev.status !== 200) break;
  }
  // A complete naming a result is refused; the plain complete that follows derives it from the observations.
  const forged = Object.keys(completeBody).length
    ? await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce, ...completeBody }, token)
    : null;
  const done = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, token);
  return { created, started, ev, forged, done, session, nonce, livenessChallenge };
}

section('B1 — duration drill: observed active time, partial credit');
let b1SessionId;
{
  // Box Control, 20:00 target; 18:00 active inside a 21:00 window.
  const r = await runSession(kola.token, { drillId: 'box-control', target: { type: 'duration', value: 20 * MIN } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 21 * MIN, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 21 * MIN },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 18 * MIN, quality: 'good' },
  ]);
  ok(
    r.done.status === 200 && r.done.body.session.verificationState === 'partially_verified',
    'B1: 18/20 min → partially verified',
  );
  ok(r.done.body.session.verifiedActiveMs === 18 * MIN, 'B1: verified active time is 18:00');
  neg(
    r.done.body.session.verifiedActiveMs !== r.done.body.session.sessionDurationMs,
    'B1: verified active time is NOT the elapsed session duration',
  );
  ok(r.done.body.session.targetCompleted === false, 'B1: target not completed');
  ok(
    r.done.body.session.provenance === 'box_cam_observed' &&
      r.done.body.session.provenanceLabel === 'Captured by Box Cam',
    'B1: partial session carries box_cam_observed provenance',
  );
  b1SessionId = r.done.body.session.id;
}

section('B2 — repetition drill: verified reps complete the target');
{
  const reps = Array.from({ length: 103 }, (_, i) => ({ seq: 4 + i, type: 'rep', atMs: i * 400, confidence: 0.9 }));
  const r = await runSession(kola.token, { drillId: 'box-touches', target: { type: 'repetitions', value: 100 } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 44_000, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 44_000 },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 44_000, quality: 'good' },
    ...reps,
  ]);
  ok(
    r.done.status === 200 && r.done.body.session.verificationState === 'verified',
    'B2: 103/100 reps → Box Cam Verified',
  );
  ok(
    r.done.body.session.verifiedReps === 103 && r.done.body.session.targetCompleted === true,
    'B2: 103 verified reps, target completed',
  );
  ok(r.done.body.session.provenanceLabel === 'Box Cam Verified', 'B2: verified session labelled Box Cam Verified');
}

section('B3 — player leaves frame: only observed time counts');
{
  // Box Control target 20:00; player present/active only 12:14, then gone.
  const r = await runSession(kola.token, { drillId: 'box-control', target: { type: 'duration', value: 20 * MIN } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 734_000, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 734_000 },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 734_000, quality: 'good' },
    { seq: 4, type: 'camera_interrupted', fromMs: 734_000, toMs: 1_200_000 },
  ]);
  ok(r.done.body.session.verifiedActiveMs === 734_000, 'B3: exactly 12:14 observed');
  neg(r.done.body.session.targetCompleted === false, 'B3: leaving frame never lets elapsed time complete the target');
  ok(
    ['partially_verified', 'unable_to_verify'].includes(r.done.body.session.verificationState),
    'B3: partial/unable per thresholds',
  );
}

section('B4 — an uploaded video can never become Box Cam Verified');
{
  // Existing evidence upload keeps its own provenance; nothing about it
  // yields box_cam_observed. The only provenance-minting path is the live
  // session flow above.
  const up = await j('POST', '/player/evidence', { claimType: 'footage', label: 'Old highlights clip' }, kola.token);
  ok(up.status === 201, 'B4: ordinary evidence upload still works');
  neg(JSON.stringify(up.body).indexOf('box_cam') === -1, 'B4: uploaded media carries no Box Cam provenance');
  // No client field on complete can conjure verification without live events:
  const empty = await runSession(
    kola.token,
    { drillId: 'box-mobility', target: { type: 'duration', value: 10 * MIN } },
    [{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 100, quality: 'insufficient' }],
    { completeBody: { verifiedActiveMs: 9_999_999, verificationState: 'verified', provenance: 'box_cam_observed' } },
  );
  neg(
    empty.forged.status === 400 && empty.forged.body.problem === 'unknown_field',
    'B4/B9: a complete that names verified fields is refused',
  );
  neg(
    empty.done.body.session.verificationState === 'unable_to_verify' && empty.done.body.session.verifiedActiveMs === 0,
    'B4/B9: no observation, no verification',
  );
}

section('B5 — coach assignment: partial completion is recorded, not "failed"');
let assignmentId;
{
  const a = await j(
    'POST',
    '/org/box-cam/assignments',
    {
      playerId: 'pl-adeyemi',
      drillId: 'box-wall',
      target: { type: 'repetitions', value: 150 },
      frequencyPerWeek: 3,
      instructions: 'Both feet, two-touch.',
    },
    maria.token,
  );
  ok(a.status === 201 && a.body.assignment.state === 'assigned', 'B5: verified club assigns Box Wall 150');
  assignmentId = a.body.assignment.id;
  // Box Wall has no rep_count capability — verifies active time only; 147
  // "reps" the client claims are irrelevant, target completion is null.
  const r = await runSession(
    kola.token,
    { drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, assignmentId },
    [
      { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 8 * MIN, quality: 'good' },
      { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 8 * MIN },
      { seq: 3, type: 'active_interval', fromMs: 0, toMs: 8 * MIN, quality: 'good' },
      ...Array.from({ length: 147 }, (_, i) => ({ seq: 4 + i, type: 'rep', atMs: i * 3000 })),
    ],
  );
  neg(
    r.done.body.session.verifiedReps === null,
    'B5: Box Wall does not fabricate rep counts (capability honestly absent)',
  );
  ok(
    r.done.body.session.verificationReasons.includes('REP_COUNT_NOT_CONFIGURED'),
    'B5: result names the rep-count limitation',
  );
  const view = await j('GET', '/org/box-cam/assignments?playerId=pl-adeyemi', undefined, maria.token);
  const row = view.body.items.find((x) => x.id === assignmentId);
  neg(
    row.lastResult && row.lastResult.statusLabel === 'Target not yet completed',
    'B5: coach sees "Target not yet completed", never "failed"',
  );
  ok(
    view.body.note.includes('never captured or shared'),
    'B5: coach view states raw home footage is never captured/shared',
  );
}

let b6SessionId;
section('B6 — guardian + minor: club gets results, never home footage');
{
  const assign = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } },
    maria.token,
  );
  ok(assign.status === 201, 'B6: verified pro club assigns a visible minor via existing relationship');
  const gAssign = await j('GET', '/guardian/children/pl-guni/box-cam/assignments', undefined, amara.token);
  ok(
    gAssign.body.items.some((x) => x.id === assign.body.assignment.id),
    'B6: guardian sees the child assignment',
  );
  const gAccept = await j(
    'POST',
    `/guardian/children/pl-guni/box-cam/assignments/${assign.body.assignment.id}/accept`,
    {},
    amara.token,
  );
  ok(gAccept.status === 200, 'B6: guardian accepts on the child’s behalf');
  const r = await runSession(
    guni.token,
    { drillId: 'box-control', target: { type: 'duration', value: 10 * MIN }, assignmentId: assign.body.assignment.id },
    [
      { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 11 * MIN, quality: 'good' },
      { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 11 * MIN },
      { seq: 3, type: 'active_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
    ],
  );
  ok(r.done.body.session.verificationState === 'verified', 'B6: minor completes the assignment (Box Cam Verified)');
  b6SessionId = r.done.body.session.id;
  const coach = await j('GET', '/org/box-cam/assignments?playerId=pl-guni', undefined, maria.token);
  const row = coach.body.items.find((x) => x.id === assign.body.assignment.id);
  ok(row.lastResult && row.lastResult.verifiedActiveMs === 10 * MIN, 'B6: coach sees the result summary');
  neg(
    !('clipMediaId' in row) && !('obs' in row) && !JSON.stringify(row).includes('video'),
    'B6: coach result carries no raw footage / observation stream',
  );
  // Agency still walled from the minor entirely.
  const agencyAssign = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } },
    alex.token,
  );
  neg(
    agencyAssign.status === 403 && agencyAssign.body.error === 'AGENCY_NOT_ELIGIBLE',
    'B6: agency cannot assign Box Training at all',
  );
}

section('B7 — Box Challenge completion, no endorsement implication');
{
  const list = await j('GET', '/player/box-cam/challenges', undefined, kola.token);
  const touch = list.body.items.find((c) => c.title.includes('1,000 Touch'));
  ok(
    touch && touch.disclaimer.includes('does not mean the club has scouted'),
    'B7: challenge carries the no-endorsement disclaimer',
  );
  const join = await j('POST', `/player/box-cam/challenges/${touch.id}/join`, {}, kola.token);
  ok(join.status === 201, 'B7: adult joins the challenge');
  const entryId = join.body.challenge.entry.id;
  const beforeChallenge = KOLA_STREAM.frames().length;
  // 1000 touches across two sessions.
  for (const chunk of [520, 500]) {
    await runSession(
      kola.token,
      { drillId: 'box-touches', target: { type: 'repetitions', value: chunk }, challengeEntryId: entryId },
      [
        { seq: 1, type: 'presence_interval', fromMs: 0, toMs: chunk * 400 + 1000, quality: 'good' },
        { seq: 2, type: 'ball_interval', fromMs: 0, toMs: chunk * 400 + 1000 },
        { seq: 3, type: 'active_interval', fromMs: 0, toMs: chunk * 400 + 1000, quality: 'good' },
        ...Array.from({ length: chunk }, (_, i) => ({ seq: 4 + i, type: 'rep', atMs: i * 400, confidence: 0.9 })),
      ],
    );
  }
  const after = await j('GET', '/player/box-cam/challenges', undefined, kola.token);
  const done = after.body.items.find((c) => c.id === touch.id);
  ok(
    done.entry.status === 'completed' && done.entry.progress >= 1000,
    'B7: challenge completed from verified sessions',
  );
  ok(
    (await evidencePings(beforeChallenge, 3)) === 3,
    "LV1 Kola's stream hears their development evidence change for each session and for the completed challenge",
  );
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.timeline.some((e) => e.type === 'box_challenge_completed'),
    'B7: Passport gains a challenge milestone',
  );
  neg(
    !JSON.stringify(sp).match(/scouted|endorsed you|selected you/i),
    'B7: no scouting/endorsement implication anywhere',
  );
}

section('B8 — replay / duplicate terminal submission rejected');
{
  const created = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } },
    kola.token,
  );
  const { session, nonce, livenessChallenge } = created.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/events`,
    {
      nonce,
      batch: [
        { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 5 * MIN, quality: 'good' },
        { seq: 2, type: 'active_interval', fromMs: 0, toMs: 5 * MIN, quality: 'good' },
      ],
    },
    kola.token,
  );
  const beforeFirst = KOLA_STREAM.frames().length;
  const first = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, kola.token);
  ok(first.status === 200, 'B8: session completes once');
  ok((await evidencePings(beforeFirst, 1)) === 1, "LV2 and Kola's stream hears it once");
  const replay = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, kola.token);
  neg(replay.status === 409 && replay.body.error === 'ALREADY_FINALIZED', 'B8: duplicate terminal submission rejected');
  const lateEvents = await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/events`,
    { nonce, batch: [{ seq: 99, type: 'rep', atMs: 1000 }] },
    kola.token,
  );
  neg(lateEvents.status === 409, 'B8: events after completion rejected');
}

section('B9 — integrity: forged fields, sequence, timestamps, cross-session, other player');
{
  // sequence must be monotonic
  const c = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } },
    kola.token,
  );
  const { session, nonce, livenessChallenge } = c.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  const badSeq = await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/events`,
    {
      nonce,
      batch: [
        { seq: 5, type: 'active_interval', fromMs: 0, toMs: 1000 },
        { seq: 3, type: 'active_interval', fromMs: 1000, toMs: 2000 },
      ],
    },
    kola.token,
  );
  neg(badSeq.status === 409 && badSeq.body.error === 'SEQUENCE_INVALID', 'non-monotonic sequence rejected');
  const future = await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/events`,
    { nonce, batch: [{ seq: 1, type: 'active_interval', fromMs: 0, toMs: 999_999_999 }] },
    kola.token,
  );
  neg(future.status === 422 && future.body.error === 'TIMESTAMP_OUT_OF_RANGE', 'timestamp beyond bounds rejected');
  const wrongNonce = await j(
    'POST',
    `/player/box-cam/sessions/${session.id}/events`,
    { nonce: 'not-the-nonce', batch: [{ seq: 1, type: 'rep', atMs: 1 }] },
    kola.token,
  );
  neg(
    wrongNonce.status === 403 && wrongNonce.body.error === 'NONCE_INVALID',
    'wrong nonce rejected (events cannot target a session without its nonce)',
  );
  // another player cannot touch this session
  const other = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, guni.token);
  neg(other.status === 404, "another player's session is not found for them");
  // liveness
  const c2 = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } },
    kola.token,
  );
  const noLive = await j(
    'POST',
    `/player/box-cam/sessions/${c2.body.session.id}/start`,
    { nonce: c2.body.nonce },
    kola.token,
  );
  neg(noLive.status === 403 && noLive.body.error === 'LIVENESS_REQUIRED', 'missing liveness blocks the session start');
  const wrongLive = await j(
    'POST',
    `/player/box-cam/sessions/${c2.body.session.id}/start`,
    { nonce: c2.body.nonce, liveness: 'not_the_challenge' },
    kola.token,
  );
  neg(wrongLive.status === 403 && wrongLive.body.error === 'LIVENESS_MISMATCH', 'wrong liveness challenge rejected');
  // The production CV provider is real, so a session CAN be created against
  // it; what matters is that it still grants no Combine verification.
  const prod = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN }, provider: 'production_cv' },
    kola.token,
  );
  ok(prod.status === 201, 'production CV provider accepts a Box Cam session (it is real)');
  const protos = await j('GET', '/player/combine/protocols', undefined, kola.token);
  const touch60 = (protos.body?.protocols ?? []).find((p) => p.id === 'combine-box-touch-60');
  neg(
    !touch60 || touch60.measurementCapability === 'not_configured',
    'but Box Touch 60 measurement capability is still not_configured — CV cannot mint a Combine measurement',
  );
}

section('B10/B11 — club authorization: minors, radius, unverified, blocks, suspended');
{
  const unverified = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } },
    ruth.token,
  );
  neg(
    unverified.status === 403 && unverified.body.error === 'ORG_NOT_ELIGIBLE',
    'unverified club cannot assign Box Training',
  );
  const farGrassroots = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-adeyemi', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } },
    dee.token,
  );
  neg(
    farGrassroots.status === 403 && farGrassroots.body.error === 'NOT_VISIBLE',
    'grassroots 50 km radius holds for assignments (Manchester player invisible to London club)',
  );
  // block — a throwaway adult so the permanent block never pollutes other tests
  const bobSignup = await j('POST', '/auth/player/signup', {
    name: 'Boxer Bob',
    dob: '1996-04-04',
    country: 'GB',
    position: 'CM',
    password: 'longenough1',
  });
  const bob = bobSignup.body?.token
    ? bobSignup.body
    : (await j('POST', '/auth/player/login', { playerId: bobSignup.body.playerId })).body;
  const beforeBlock = await j(
    'POST',
    '/org/box-cam/assignments',
    {
      playerId: bob.playerId ?? bobSignup.body.playerId,
      drillId: 'box-control',
      target: { type: 'duration', value: 10 * MIN },
    },
    maria.token,
  );
  ok(beforeBlock.status === 201, 'verified club can assign a visible adult');
  await j('POST', '/player/block', { orgId: 'org-eastport' }, bob.token);
  const blocked = await j(
    'POST',
    '/org/box-cam/assignments',
    {
      playerId: bob.playerId ?? bobSignup.body.playerId,
      drillId: 'box-control',
      target: { type: 'duration', value: 10 * MIN },
    },
    maria.token,
  );
  neg(
    blocked.status === 403 && blocked.body.error === 'NOT_VISIBLE',
    'blocked org cannot assign once the player blocks it',
  );
  // suspended org
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, null, A);
  const susp = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } },
    maria.token,
  );
  neg(susp.status === 403 && susp.body.error === 'ORG_SUSPENDED', 'suspended organisation cannot assign');
  const suspChal = await j(
    'POST',
    '/org/box-cam/challenges',
    { title: 'X', drillId: 'box-touches', metric: 'reps', targetTotal: 100, days: 7 },
    maria.token,
  );
  neg(
    suspChal.status === 403 && suspChal.body.error === 'ORG_SUSPENDED',
    'suspended organisation cannot publish a challenge',
  );
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, null, A);
  // agency challenge
  const agChal = await j(
    'POST',
    '/org/box-cam/challenges',
    { title: 'Y', drillId: 'box-touches', metric: 'reps', targetTotal: 100, days: 7 },
    alex.token,
  );
  neg(agChal.status === 403 && agChal.body.error === 'AGENCY_NOT_ELIGIBLE', 'agency cannot publish a Box Challenge');
}

section('B12 — dispute → T&S invalidation → Passport drops it → restore');
{
  const before = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  const beforeSessions = before.developmentActivity.boxSessions;
  const disp = await j(
    'POST',
    `/player/box-cam/sessions/${b1SessionId}/dispute`,
    { reason: 'Box Cam missed my last few minutes.' },
    kola.token,
  );
  ok(disp.status === 201, 'B12: player files a dispute');
  const list = await j('GET', '/admin/box-cam/disputes', undefined, null, A);
  ok(
    list.body.items.some((d) => d.sessionId === b1SessionId),
    'B12: dispute reaches the T&S queue',
  );
  const dispId = list.body.items.find((d) => d.sessionId === b1SessionId).id;
  const resolve = await j(
    'POST',
    `/admin/box-cam/disputes/${dispId}/resolve`,
    { outcome: 'invalidated', reason: 'Provider gap confirmed.' },
    null,
    A,
  );
  ok(resolve.status === 200, 'B12: T&S invalidates the result');
  const after = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(
    after.developmentActivity.boxSessions < beforeSessions,
    'B12: invalidated session no longer counts in Passport development activity',
  );
  const restore = await j(
    'POST',
    `/admin/box-cam/sessions/${b1SessionId}/restore`,
    { reason: 'Reviewed again — original result was correct.' },
    null,
    A,
  );
  ok(
    restore.status === 200 && restore.body.session.verificationState === 'partially_verified',
    'B12: restore returns the original result (history preserved)',
  );
  // T&S cannot fabricate
  const badResolve = await j(
    'POST',
    `/admin/box-cam/disputes/${dispId}/resolve`,
    { outcome: 'verified', reason: 'x' },
    null,
    A,
  );
  neg(badResolve.status === 409 || badResolve.status === 400, 'B12: T&S cannot fabricate a verified outcome');
}

section('privacy matrix: the same session across viewers');
{
  const self = await j('GET', `/player/box-cam/sessions/${b1SessionId}`, undefined, kola.token);
  ok(
    self.status === 200 && typeof self.body.session.verifiedActiveMs === 'number',
    'SELF: full session detail (duration/state)',
  );
  const ts = await j('GET', `/admin/box-cam/sessions/${b1SessionId}`, undefined, null, A);
  ok(
    ts.status === 200 && ts.body.session.resultHash && typeof ts.body.session.lastSeq === 'number',
    'T&S: integrity metadata (result hash, sequence) visible',
  );
  neg(self.body.session.resultHash === undefined, 'SELF: integrity internals not exposed to the player');
  // Org / recruitment: private by default, aggregate only after opt-in.
  const orgBefore = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  neg(orgBefore.body.developmentActivity === null, 'PRO CLUB: no development activity shared by default');
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, kola.token);
  const orgAfter = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  ok(
    orgAfter.body.developmentActivity && typeof orgAfter.body.developmentActivity.verifiedActiveMs === 'number',
    'PRO CLUB: opted-in aggregate development activity visible',
  );
  neg(
    !('recent' in (orgAfter.body.developmentActivity ?? {})) &&
      JSON.stringify(orgAfter.body.developmentActivity).indexOf('resultHash') === -1,
    'PRO CLUB: aggregate only — no per-session detail, no integrity internals',
  );
  neg(
    orgAfter.body.developmentActivity.note.includes('not proof of player ability'),
    'PRO CLUB: development activity explicitly not proof of ability',
  );
  // no org route to a raw session
  const orgRaw = await j('GET', `/player/box-cam/sessions/${b1SessionId}`, undefined, maria.token);
  neg(
    orgRaw.status === 401 || orgRaw.status === 403 || orgRaw.status === 404,
    'PRO CLUB: no route to a raw Box Session',
  );
  // public
  const share = await j('POST', '/player/football-passport/shares', { mode: 'public' }, kola.token);
  const pub = await j('GET', share.body.url);
  neg(
    !pub.body.developmentActivity && !JSON.stringify(pub.body).match(/verifiedActiveMs|resultHash/),
    'PUBLIC: no Box Cam development detail in the public passport',
  );
  // guardian sees child session detail
  const gsess = await j('GET', '/guardian/children/pl-guni/box-cam/sessions', undefined, amara.token);
  ok(gsess.status === 200, 'GUARDIAN: child session detail available');
  const agencyRaw = await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token);
  neg(agencyRaw.status === 403, 'AGENCY: no passport (and thus no development activity) for a minor');
}

section('remaining abuse cases');
{
  // minor cannot mint/join without guardian; minor cannot change prefs
  const minorShare = await j('POST', `/player/box-cam/challenges/nope/join`, {}, guni.token);
  neg(
    minorShare.status === 403 && minorShare.body.error === 'GUARDIAN_MANAGED',
    'minor cannot join a challenge directly (guardian-managed)',
  );
  const minorPrefs = await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, guni.token);
  neg(minorPrefs.status === 403, 'minor cannot change Box Cam privacy (guardian-managed)');
  // guardian mismatch
  const wrongChild = await j('GET', '/guardian/children/pl-adeyemi/box-cam/sessions', undefined, amara.token);
  neg(wrongChild.status === 404, "guardian cannot read an unrelated adult's Box sessions");
  // stale assignment completed after cancellation
  const cancel = await j('POST', `/org/box-cam/assignments/${assignmentId}/cancel`, {}, maria.token);
  ok(cancel.status === 200, 'assignment cancelled');
  const afterCancel = await runSession(
    kola.token,
    { drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, assignmentId },
    [{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 60000, quality: 'good' }],
  );
  neg(
    afterCancel.created.status === 409 && afterCancel.created.body.error === 'ASSIGNMENT_CANCELLED',
    'cannot start a session against a cancelled assignment',
  );
  // multiple people pauses observation
  const multi = await runSession(
    kola.token,
    { drillId: 'box-footwork', target: { type: 'duration', value: 10 * MIN } },
    [
      { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
      { seq: 2, type: 'active_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
      { seq: 3, type: 'multi_person', fromMs: 4 * MIN, toMs: 6 * MIN },
    ],
  );
  neg(
    multi.done.body.session.verifiedActiveMs === 8 * MIN,
    'multiple participants pause verified time (no facial recognition, no guessing)',
  );
  // drill unknown
  const badDrill = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-nonsense', target: { type: 'duration', value: 60000 } },
    kola.token,
  );
  neg(badDrill.status === 404 && badDrill.body.error === 'DRILL_UNKNOWN', 'unknown drill rejected');
  // target metric unsupported for challenge
  const badMetric = await j(
    'POST',
    '/org/box-cam/challenges',
    { title: 'Z', drillId: 'box-wall', metric: 'reps', targetTotal: 100, days: 7 },
    maria.token,
  );
  neg(
    badMetric.status === 400 && badMetric.body.error === 'METRIC_NOT_SUPPORTED',
    'challenge cannot demand rep counts a drill cannot verify',
  );
}

section('junk refused naming the field, never coerced; lists that grow page by cursor');
{
  // Observation events the engine cannot read are refused.
  const c = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-touches', target: { type: 'repetitions', value: 50 }, provider: 'local_test' },
    kola.token,
  );
  ok(c.status === 201, 'a session is minted for the junk checks');
  const { session, nonce, livenessChallenge } = c.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  const ev = (batch) => j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch }, kola.token);
  const noEnd = await ev([{ seq: 1, type: 'active_interval', fromMs: 0 }]);
  neg(
    noEnd.status === 400 && noEnd.body.error === 'EVENT_INVALID' && noEnd.body.seq === 1,
    'an interval without toMs is refused naming the event',
  );
  const badQuality = await ev([{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 1000, quality: 'great' }]);
  neg(
    badQuality.status === 400 && /quality/.test(badQuality.body.message),
    'an unknown observation quality is refused (it read as good before)',
  );
  const stringAt = await ev([{ seq: 1, type: 'rep', atMs: '400' }]);
  neg(stringAt.status === 400 && /atMs/.test(stringAt.body.message), 'a timestamp written as text is refused');
  const badConf = await ev([{ seq: 1, type: 'rep', atMs: 400, confidence: 3 }]);
  neg(badConf.status === 400 && /confidence/.test(badConf.body.message), 'a confidence outside 0–1 is refused');
  const mixed = await ev([
    { seq: 1, type: 'rep', atMs: 400, confidence: 0.9 },
    { seq: 2, type: 'rep' },
  ]);
  neg(mixed.status === 400 && mixed.body.seq === 2, 'one bad event refuses the whole batch');
  const good = await ev([
    { seq: 1, type: 'rep', atMs: 400, confidence: 0.9 },
    { seq: 2, type: 'pause', atMs: 500 },
    { seq: 3, type: 'resume', atMs: 900 },
  ]);
  ok(
    good.status === 200 && good.body.lastSeq === 3,
    'the refused batches left the sequence where it was; a good batch lands',
  );
  const stringTarget = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-touches', target: { type: 'repetitions', value: '50' }, provider: 'local_test' },
    kola.token,
  );
  neg(
    stringTarget.status === 400 && stringTarget.body.error === 'TARGET_VALUE_INVALID',
    'a session target written as text is refused',
  );

  // Assignments: a frequency, a due date and a target value are refused when they are not what they say.
  const base = { playerId: 'pl-adeyemi', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } };
  const freq = await j('POST', '/org/box-cam/assignments', { ...base, frequencyPerWeek: 2.5 }, maria.token);
  neg(
    freq.status === 400 && freq.body.field === 'frequencyPerWeek',
    'a fractional weekly frequency is refused (it was coerced before)',
  );
  const due = await j('POST', '/org/box-cam/assignments', { ...base, dueDate: '2026-02-30' }, maria.token);
  neg(
    due.status === 400 && due.body.error === 'DATE_INVALID' && due.body.field === 'dueDate',
    'a due date that does not exist is refused (it was cut to ten characters and kept before)',
  );
  const tv = await j(
    'POST',
    '/org/box-cam/assignments',
    { ...base, target: { type: 'duration', value: '600000' } },
    maria.token,
  );
  neg(tv.status === 400 && tv.body.error === 'TARGET_INVALID', 'an assignment target written as text is refused');
  const neg0 = await j(
    'POST',
    '/org/box-cam/assignments',
    { ...base, target: { type: 'duration', value: 0 } },
    maria.token,
  );
  neg(neg0.status === 400 && neg0.body.error === 'TARGET_INVALID', 'a zero target is refused');
  const okDue = await j(
    'POST',
    '/org/box-cam/assignments',
    { ...base, dueDate: '2026-12-01', frequencyPerWeek: 2 },
    maria.token,
  );
  ok(
    okDue.status === 201 &&
      okDue.body.assignment.dueDate === '2026-12-01' &&
      okDue.body.assignment.frequencyPerWeek === 2,
    'a real due date and a whole frequency are stored as given',
  );

  // Challenges: days, cap, adultOnly and the total are refused, never clamped or dropped.
  const chal = { title: 'Junk', drillId: 'box-touches', metric: 'reps', targetTotal: 100, days: 7 };
  const days = await j('POST', '/org/box-cam/challenges', { ...chal, days: 90 }, maria.token);
  neg(
    days.status === 400 && days.body.field === 'days',
    'a challenge longer than 60 days is refused (it was clamped before)',
  );
  const cap = await j('POST', '/org/box-cam/challenges', { ...chal, cap: -3 }, maria.token);
  neg(cap.status === 400 && cap.body.field === 'cap', 'a negative cap is refused (it became unlimited before)');
  const adult = await j('POST', '/org/box-cam/challenges', { ...chal, adultOnly: 'yes' }, maria.token);
  neg(adult.status === 400 && adult.body.field === 'adultOnly', 'adultOnly must be true or false');
  const total = await j('POST', '/org/box-cam/challenges', { ...chal, targetTotal: 12.5 }, maria.token);
  neg(total.status === 400 && total.body.error === 'TARGET_INVALID', 'a fractional challenge total is refused');

  // Prefs: retainClips is a boolean.
  const prefs = await j('PATCH', '/player/box-cam/prefs', { retainClips: 'yes' }, kola.token);
  neg(
    prefs.status === 400 && prefs.body.field === 'retainClips',
    'retainClips must be true or false (anything truthy counted before)',
  );

  // Paging: the organisation's assignments and challenges, and the T&S dispute queue.
  const p1 = await j('GET', '/org/box-cam/assignments?limit=1', undefined, maria.token);
  ok(
    p1.status === 200 &&
      p1.body.items.length === 1 &&
      typeof p1.body.nextCursor === 'string' &&
      p1.body.summary.assigned >= 2,
    'the assignment list pages (the summary still counts them all)',
  );
  const p2 = await j('GET', `/org/box-cam/assignments?limit=1&cursor=${p1.body.nextCursor}`, undefined, maria.token);
  ok(
    p2.status === 200 && p2.body.items.length === 1 && p2.body.items[0].id !== p1.body.items[0].id,
    'the next page continues from the cursor',
  );
  neg(
    (await j('GET', '/org/box-cam/assignments?limit=0', undefined, maria.token)).status === 400,
    'a junk limit is refused',
  );
  neg(
    (await j('GET', '/org/box-cam/challenges?cursor=nope', undefined, maria.token)).status === 400,
    'a junk cursor is refused',
  );
  const q = await j('GET', '/admin/box-cam/disputes?all=1&limit=1', undefined, null, A);
  ok(q.status === 200 && Array.isArray(q.body.items) && 'nextCursor' in q.body, 'the dispute queue pages');

  // Each field as sent, or refused: nothing is cut, converted or ignored.
  let r = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-mobility', target: { type: 'duration', value: '300000' } },
    kola.token,
  );
  neg(r.status === 400 && r.body.error === 'TARGET_VALUE_INVALID', 'IN1 a session target written as text is refused');
  r = await j('POST', `/player/box-cam/sessions/${b1SessionId}/note`, { note: 'n'.repeat(301) }, kola.token);
  neg(
    r.status === 400 && r.body.field === 'note' && r.body.problem === 'too_long',
    'IN2 a note over 300 characters is refused, not cut',
  );
  r = await j('POST', `/player/box-cam/sessions/${b1SessionId}/dispute`, { reason: { text: 'wrong' } }, kola.token);
  neg(
    r.status === 400 && r.body.field === 'reason' && r.body.problem === 'not_text',
    'IN3 a dispute reason that is not text is refused',
  );
  r = await j(
    'POST',
    '/org/box-cam/challenges',
    { drillId: 'box-touches', metric: 'reps', targetTotal: 500, title: 't'.repeat(121) },
    maria.token,
  );
  neg(
    r.status === 400 && r.body.field === 'title' && r.body.problem === 'too_long',
    'IN4 a challenge title over 120 characters is refused, not cut',
  );
  r = await j(
    'POST',
    '/org/box-cam/assignments',
    {
      playerId: 'pl-adeyemi',
      drillId: 'box-mobility',
      target: { type: 'duration', value: 600000 },
      instructions: 'i'.repeat(301),
    },
    maria.token,
  );
  neg(
    r.status === 400 && r.body.field === 'instructions' && r.body.problem === 'too_long',
    'IN5 assignment instructions over 300 characters are refused, not cut',
  );
  r = await j('PATCH', '/player/box-cam/prefs', { retainClips: true, playerId: 'pl-guni' }, kola.token);
  neg(r.status === 400 && r.body.field === 'playerId', 'IN6 the privacy settings name no other player');
  r = await j('POST', '/admin/box-cam/sessions/boxs-none/restore', { reason: 'r'.repeat(301) }, null, A);
  neg(
    r.status === 400 && r.body.field === 'reason' && r.body.problem === 'too_long',
    'IN7 a restore reason over 300 characters is refused, not cut',
  );
  r = await j('GET', '/admin/box-cam/disputes?all=yes', undefined, null, A);
  neg(
    r.status === 400 && r.body.field === 'all' && r.body.allowed?.includes('1'),
    'IN8 the dispute queue filter is 0 or 1',
  );
}

section("the development plan, the club's drill list, and keeping a clip");
{
  // DP: a club's development objective, the Box Training set against it, and the recorded activity, in one read.
  const opened = await j(
    'POST',
    '/org/assessments',
    { playerId: 'pl-adeyemi', positionGroup: 'ATT', context: { fixture: 'Box Cam plan', viewing: 'live' } },
    maria.token,
  );
  const assessmentId = opened.body.assessment.id;
  await j(
    'PUT',
    `/org/assessments/${assessmentId}`,
    {
      ratings: [
        { attrId: 'finishing', notObserved: true },
        { attrId: 'movement', notObserved: true },
        { attrId: 'first_touch', rating: 3, confidence: 'medium' },
        { attrId: 'pressing', notObserved: true },
      ],
      recommendation: { verdict: 'monitor', reasons: 'One viewing.' },
    },
    maria.token,
  );
  const submitted = await j('POST', `/org/assessments/${assessmentId}/submit`, {}, maria.token);
  const published = await j(
    'POST',
    `/org/assessments/${assessmentId}/publish-feedback`,
    { text: 'Work on your first touch under pressure.' },
    maria.token,
  );
  const feedback = (await j('GET', '/player/feedback', undefined, kola.token)).body.items.find(
    (f) => f.id === assessmentId,
  );
  const objective = await j(
    'POST',
    '/player/objectives',
    { feedbackId: feedback?.id, objectives: [{ text: 'Cushion the first touch' }, { text: 'Open the body' }] },
    kola.token,
  );
  ok(
    submitted.status === 200 && published.status === 200 && objective.status === 201,
    'DP0 the player agrees an objective from feedback the club published',
  );
  const objectiveId = objective.body.objective.id;
  const set = await j(
    'POST',
    '/org/box-cam/assignments',
    { playerId: 'pl-adeyemi', drillId: 'box-touches', target: { type: 'duration', value: 5 * MIN }, objectiveId },
    maria.token,
  );
  ok(
    set.status === 201 && set.body.assignment.objectiveId === objectiveId,
    'DP0b the club sets Box Training against it',
  );
  const plan = await j('GET', '/player/box-cam/development-plan', undefined, kola.token);
  ok(
    JSON.stringify(Object.keys(plan.body)) === JSON.stringify(['objectives', 'assignments', 'activity', 'note']) &&
      plan.body.note.startsWith('Completing sessions never automatically marks'),
    'DP1 the plan: objectives, assignments, activity and a note that sessions close no objective',
  );
  const o = plan.body.objectives.find((x) => x.id === objectiveId);
  ok(
    o &&
      JSON.stringify(Object.keys(o)) ===
        JSON.stringify(['id', 'orgId', 'orgName', 'status', 'createdAt', 'objectives', 'assignments']) &&
      o.orgId === 'org-eastport' &&
      o.orgName === 'Eastport FC' &&
      JSON.stringify(o.objectives) === JSON.stringify(['Cushion the first touch', 'Open the body']) &&
      o.assignments.length === 1 &&
      o.assignments[0].id === set.body.assignment.id,
    "DP2 an objective names its club, its items' text, and the Box Training set against it",
  );
  const own = (await j('GET', '/player/box-cam/assignments', undefined, kola.token)).body.items;
  ok(
    JSON.stringify(plan.body.assignments) === JSON.stringify(own.filter((a) => a.state !== 'cancelled')) &&
      plan.body.assignments.some((a) => a.id === set.body.assignment.id) &&
      !plan.body.assignments.some((a) => a.id === assignmentId),
    "DP3 the plan's assignments are the player's own views, the cancelled one left out",
  );
  const passport = await j('GET', '/player/football-passport', undefined, kola.token);
  ok(
    JSON.stringify(plan.body.activity) === JSON.stringify(passport.body.developmentActivity) &&
      plan.body.activity.days === 30 &&
      plan.body.activity.boxSessions > 0,
    "DP4 the plan's activity is the last 30 days the Passport shows",
  );
  const guniPlan = await j('GET', '/player/box-cam/development-plan', undefined, guni.token);
  const childPlan = await j('GET', '/guardian/children/pl-guni/box-cam/development-plan', undefined, amara.token);
  ok(
    childPlan.status === 200 &&
      JSON.stringify(childPlan.body) === JSON.stringify(guniPlan.body) &&
      childPlan.body.assignments.length > 0,
    "DP5 a guardian reads the child's plan as the child does",
  );
  const unrelated = await j('GET', '/guardian/children/pl-adeyemi/box-cam/development-plan', undefined, amara.token);
  neg(unrelated.status === 404 && unrelated.body.error === 'CHILD_NOT_FOUND', "DP6 not another player's plan");
  neg(
    (await j('GET', '/player/box-cam/development-plan', undefined, maria.token)).status === 401,
    'DP7 a club has no route to the player plan',
  );

  // DL: the club's drill list is the player's, without the providers.
  const clubDrills = await j('GET', '/org/box-cam/drills', undefined, maria.token);
  const playerDrills = await j('GET', '/player/box-cam/drills', undefined, kola.token);
  ok(
    clubDrills.status === 200 &&
      JSON.stringify(Object.keys(clubDrills.body)) === JSON.stringify(['drills']) &&
      JSON.stringify(clubDrills.body.drills) === JSON.stringify(playerDrills.body.drills) &&
      clubDrills.body.drills.length > 0,
    "DL1 a club lists the player's drills, and nothing about the providers",
  );
  ok(
    JSON.stringify(Object.keys(clubDrills.body.drills[0])) ===
      JSON.stringify([
        'id',
        'version',
        'title',
        'category',
        'summary',
        'targetTypes',
        'verificationCapabilities',
        'repSupport',
        'repSupportNote',
        'setup',
        'safetyNotes',
        'restGuidance',
        'ageAppropriateness',
      ]),
    'DL2 a drill as a club reads it',
  );
  ok(
    (await j('GET', '/org/box-cam/drills', undefined, alex.token)).status === 200,
    'DL3 an agency can read the drill list too',
  );

  // KC: keeping a clip tags one of the player's own media as Box Cam captured; nothing is uploaded or made public.
  const kept = await runSession(kola.token, { drillId: 'box-control', target: { type: 'duration', value: 5 * MIN } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 6 * MIN, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 6 * MIN },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 5 * MIN, quality: 'good' },
  ]);
  const sid = kept.done.body.session.id;
  // A media link is signed afresh on every read, so it is compared without its signature.
  const media = async () =>
    (await j('GET', '/player/me', undefined, kola.token)).body.media.map((m) => ({
      ...m,
      url: m.url === null ? null : m.url.split('?')[0],
    }));
  const before = await media();
  const mid = before[0].id;
  const clip = (session, body, token = kola.token) =>
    j('POST', `/player/box-cam/sessions/${session}/clip`, body, token);
  let r = await clip(sid, { mediaId: 7 });
  neg(r.status === 400 && r.body.field === 'mediaId' && r.body.problem === 'not_text', 'KC1 the media id is text');
  r = await clip(sid, { mediaId: mid, sessionId: sid });
  neg(r.status === 400 && r.body.field === 'sessionId' && r.body.problem === 'unknown_field', 'KC2 nothing else');
  const open = await j(
    'POST',
    '/player/box-cam/sessions',
    { drillId: 'box-control', target: { type: 'duration', value: 5 * MIN }, provider: 'local_test' },
    kola.token,
  );
  r = await clip(open.body.session.id, { mediaId: mid });
  neg(r.status === 404 && r.body.error === 'SESSION_NOT_FOUND', 'KC3 an unfinished session keeps no clip');
  r = await clip('boxs-none', { mediaId: mid });
  neg(r.status === 404 && r.body.error === 'SESSION_NOT_FOUND', 'KC4 an unknown session');
  r = await clip(sid, { mediaId: mid }, guni.token);
  neg(r.status === 404 && r.body.error === 'SESSION_NOT_FOUND', "KC5 not another player's session");
  r = await clip(sid, { mediaId: 'media-none' });
  neg(r.status === 404 && r.body.error === 'MEDIA_NOT_FOUND', 'KC6 an unknown media item');
  r = await clip(sid, {});
  neg(r.status === 404 && r.body.error === 'MEDIA_NOT_FOUND', 'KC7 no media item named');
  r = await clip(b6SessionId, { mediaId: mid }, guni.token);
  neg(
    r.status === 403 && r.body.error === 'GUARDIAN_CONTROLLED' && r.body.message.includes('parent/guardian'),
    'KC8 a minor keeps no clip until the guardian allows it',
  );
  await j('PATCH', '/guardian/children/pl-guni/box-cam/prefs', { retainClips: true }, amara.token);
  r = await clip(b6SessionId, { mediaId: mid }, guni.token);
  neg(
    r.status === 404 && r.body.error === 'MEDIA_NOT_FOUND',
    "KC9 once allowed, a minor still can't name another player's media",
  );
  const unchanged = JSON.stringify(await media()) === JSON.stringify(before);
  r = await clip(sid, { mediaId: mid });
  ok(
    unchanged &&
      r.status === 200 &&
      JSON.stringify(Object.keys(r.body)) === JSON.stringify(['session', 'note']) &&
      JSON.stringify(r.body.session) ===
        JSON.stringify((await j('GET', `/player/box-cam/sessions/${sid}`, undefined, kola.token)).body.session) &&
      r.body.note.includes('never makes it public'),
    'KC10 kept: the session as the player reads it, and a note that keeping a clip never makes it public',
  );
  const after = await media();
  ok(
    JSON.stringify(after[0]) ===
      JSON.stringify({
        ...Object.fromEntries(Object.entries(before[0]).filter(([k]) => k !== 'tags')),
        capturedBy: 'box_cam',
        boxSessionId: sid,
        tags: before[0].tags,
      }) && JSON.stringify(after.slice(1)) === JSON.stringify(before.slice(1)),
    'KC11 the media item is marked Box Cam captured, by this session, and nothing else changes',
  );
  const R = readRows(DATA_DIR);
  const stored = R.row('box_sessions', { id: sid });
  const ledger = R.rows('ledger', { type: 'box_clip_saved', player_id: 'pl-adeyemi' });
  R.close();
  ok(stored.clip_media_id === mid, 'KC12 the session keeps the clip');
  ok(ledger.length === 1 && ledger[0].org_id === null, "KC13 keeping a clip is a row in the player's ledger");
}

section('metrics — privacy-safe counters, no PII');
{
  const m = await j('GET', '/admin/metrics', undefined, null, A);
  const b = m.body.boxCam;
  ok(
    b &&
      b.box_sessions_started > 0 &&
      b.box_sessions_completed > 0 &&
      b.box_sessions_verified > 0 &&
      b.box_challenge_completed > 0,
    'Box Cam counters populate',
  );
  neg(!JSON.stringify(b).match(/pl-|Kola|adeyemi/), 'metrics carry no player identifiers');
}

// rate limit LAST — deliberately exhausts the per-player session window
section('session creation rate limit');
{
  let hit429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await j(
      'POST',
      '/player/box-cam/sessions',
      { drillId: 'box-mobility', target: { type: 'duration', value: 60000 } },
      kola.token,
    );
    if (r.status === 429) {
      hit429 = true;
      break;
    }
  }
  neg(hit429, 'session creation is rate-limited against flooding');
}

const ratio = Math.round((negatives / passed) * 100);
console.log(
  `\ndevelopment/boxCam: ${passed} checks passed, ${negatives} negative/abuse checks (${ratio}% of all checks)${process.exitCode ? ' (WITH FAILURES)' : ''}`,
);
if (negatives * 10 < passed * 4) {
  console.error('✗ negative-test ratio below 40%');
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
