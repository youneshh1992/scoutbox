// M16 acceptance suite — Box Cam + Development Intelligence.
// Pure-engine unit fixtures (active-time §102, reps §103, states, streak,
// challenge progress), then full HTTP journeys B1–B12 and the §99 abuse
// catalogue. Well over 40% of checks are negative/edge/security cases.
//
// The test-only observation provider (local_test) is enabled via
// BOX_CAM_TEST_PROVIDER=1 — simulated observations are always labelled
// simulated and can never exist in production.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifiedActiveMs, dedupeReps, targetCompleted, detectionQuality,
  deriveVerification, boxStreakWeeks, challengeProgress, mergeIntervals,
  subtractIntervals, intersectIntervals, normIntervals, resultHash,
} from '../m16/shared.mjs';
import { DRILLS, drillByIdVersion, providerFor, PROVIDERS } from '../m16/drills.mjs';

const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m16-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0;
let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', TEST_LICENCE_REGISTRY: '1', BOX_CAM_TEST_PROVIDER: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ }
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
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const MIN = 60_000;

// ============================================================ U1 active time
section('U1 — active-time engine (§102): observed active ≠ elapsed');
{
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 5 * MIN, 'plain active interval sums');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 5 * MIN }, { fromMs: 2 * MIN, toMs: 6 * MIN }], sessionDurationMs: 10 * MIN }) === 6 * MIN, 'overlapping intervals union (no double count)');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 5 * MIN }, { fromMs: 0, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 5 * MIN, 'duplicate interval counts once');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 1 * MIN, toMs: 2 * MIN }, { fromMs: 0, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 5 * MIN, 'nested interval absorbed');
  neg(verifiedActiveMs({ activeIntervals: [{ fromMs: 8 * MIN, toMs: 20 * MIN }], sessionDurationMs: 10 * MIN }) === 2 * MIN, 'interval clamped to session window — time outside the session never counts');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }], pauses: [{ fromMs: 3 * MIN, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 8 * MIN, 'paused period removed');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }], interruptions: [{ fromMs: 3 * MIN, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 8 * MIN, 'interruption removed');
  neg(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 10 * MIN, quality: 'insufficient' }], sessionDurationMs: 10 * MIN }) === 0, 'insufficient-quality observation never counts as active');
  ok(verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }], requiredIntervals: [{ fromMs: 0, toMs: 6 * MIN }], sessionDurationMs: 10 * MIN }) === 6 * MIN, 'ball-required drill: only active∩ball counts');
  // exact / boundary
  ok(targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN }, []) === true, 'exactly target = completed');
  neg(targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN - 1 }, []) === false, '1 ms below target is NOT completed');
  ok(targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN + 1 }, []) === true, '1 ms above target = completed');
  ok(JSON.stringify(mergeIntervals([{ fromMs: 0, toMs: 1 }, { fromMs: 1, toMs: 2 }])) === JSON.stringify([{ fromMs: 0, toMs: 2 }]), 'adjacent intervals merge');
  ok(intersectIntervals([{ fromMs: 0, toMs: 10 }], [{ fromMs: 5, toMs: 20 }])[0].toMs === 10, 'intersection clips');
  ok(subtractIntervals([{ fromMs: 0, toMs: 10 }], [{ fromMs: 4, toMs: 6 }]).length === 2, 'subtract splits an interval');
  ok(detectionQuality({ observedMs: 9 * MIN, sessionDurationMs: 10 * MIN }) === 'good' && detectionQuality({ observedMs: 3 * MIN, sessionDurationMs: 10 * MIN }) === 'degraded' && detectionQuality({ observedMs: 1 * MIN, sessionDurationMs: 10 * MIN }) === 'insufficient', 'quality bands');
}

// ============================================================ U2 reps
section('U2 — repetition engine (§103): honest dedupe');
{
  ok(dedupeReps([{ atMs: 0 }, { atMs: 300 }, { atMs: 600 }], { minGapMs: 250 }).length === 3, 'well-spaced reps counted');
  neg(dedupeReps([{ atMs: 0 }, { atMs: 100 }], { minGapMs: 250 }).length === 1, 'physically-impossible rapid duplicate collapsed');
  neg(dedupeReps([{ atMs: 1000, confidence: 0.9 }, { atMs: 1000, confidence: 0.8 }], { minGapMs: 250 }).length === 1, 'two detectors on the same instant count once');
  neg(dedupeReps([{ atMs: 500, confidence: 0.3 }], { minConfidence: 0.5 }).length === 0, 'low-confidence rep dropped');
  neg(dedupeReps([{ atMs: 99999 }], { sessionDurationMs: 5000 }).length === 0, 'rep outside the session window dropped');
  ok(dedupeReps([{ atMs: 600 }, { atMs: 0 }, { atMs: 300 }], { minGapMs: 250 }).length === 3, 'out-of-order reps sorted then counted');
  ok(targetCompleted({ type: 'repetitions', value: 100 }, { reps: 100 }, ['rep_count']) === true, '100/100 reps completed');
  neg(targetCompleted({ type: 'repetitions', value: 150 }, { reps: 149 }, ['rep_count']) === false, '149/150 is NOT completed (never rounded up)');
  neg(targetCompleted({ type: 'repetitions', value: 100 }, { reps: 100 }, []) === null, 'rep target on a drill without rep_count capability → null (not fabricated)');
}

// ================================================= U3 states / streak / challenge
section('U3 — verification states, streak, challenge progress');
{
  ok(deriveVerification({ livenessPassed: true, providerAvailable: true, activeMs: 20 * MIN, sessionDurationMs: 20 * MIN, completed: true, quality: 'good' }).state === 'verified', 'good + completed → verified');
  ok(deriveVerification({ livenessPassed: true, providerAvailable: true, activeMs: 13 * MIN, sessionDurationMs: 20 * MIN, completed: false, quality: 'good' }).state === 'partially_verified', 'observed work but target missed → partially_verified (never erased)');
  ok(deriveVerification({ livenessPassed: true, providerAvailable: true, activeMs: 0, sessionDurationMs: 20 * MIN, completed: false, quality: 'insufficient' }).state === 'unable_to_verify', 'no reliable observation → unable_to_verify');
  neg(deriveVerification({ livenessPassed: false, providerAvailable: true, activeMs: 20 * MIN, sessionDurationMs: 20 * MIN, completed: true, quality: 'good' }).state === 'completed_unverified', 'no liveness → never Box Cam Verified');
  neg(deriveVerification({ livenessPassed: true, providerAvailable: false, activeMs: 20 * MIN, sessionDurationMs: 20 * MIN, completed: true, quality: 'good' }).state === 'completed_unverified', 'provider unavailable → not verified');
  ok(deriveVerification({ cancelled: true }).state === 'cancelled', 'cancelled state');
  // streak: rest days never break it
  const wk = 7 * 86_400_000;
  const now = 100 * wk;
  const sess = (w) => ({ verificationState: 'verified', verifiedActiveMs: 10 * MIN, endedAt: w * wk });
  ok(boxStreakWeeks([sess(100), sess(99), sess(98)], now) === 3, 'consecutive training weeks build a streak');
  ok(boxStreakWeeks([sess(99), sess(98)], now) === 2, 'current week still in progress does not break the streak');
  neg(boxStreakWeeks([sess(100), sess(98)], now) === 1, 'an empty week ends the streak (only at week granularity — rest days never matter)');
  const chal = { drillId: 'box-touches', metric: 'reps', targetTotal: 1000, startsAt: 0, endsAt: now };
  const cs = challengeProgress(chal, [{ id: 's1', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 600, endedAt: wk }, { id: 's1', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 600, endedAt: wk }, { id: 's2', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 500, endedAt: 2 * wk }]);
  neg(cs.total === 1100 && cs.completed, 'duplicate session id counts once in challenge progress (replay-safe)');
  ok(providerFor('local_test', { testProviderEnabled: false }) === null && providerFor('local_test', { testProviderEnabled: true }) !== null, 'test provider hidden unless explicitly enabled');
  ok(PROVIDERS.production_cv.status === 'not_configured', 'production CV honestly not_configured');
  ok(drillByIdVersion('box-wall', 1).repSupport === 'not_configured' && !drillByIdVersion('box-wall', 1).verificationCapabilities.includes('rep_count'), 'Box Wall honestly declares rep counting not configured');
}

// ==================================================== HTTP actors
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const ruth = await login('org-harbour', 'Ruth Vane', 'Scout');       // unverified club
const alex = await login('org-northstar', 'Alex Agent', 'Agent');    // agency
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots'); // verified grassroots, London
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;  // adult, Manchester
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;     // minor, London
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, ruth, alex, dee, kola, guni, amara].every((a) => a?.token), 'all actors logged in');

// helper: run a full simulated Box Session
async function runSession(token, { drillId, target, provider = 'local_test', assignmentId, challengeEntryId }, events, { liveness = 'auto', completeBody = {} } = {}) {
  const created = await j('POST', '/player/box-cam/sessions', { drillId, target, provider, assignmentId, challengeEntryId }, token);
  if (created.status !== 201) return { created };
  const { session, nonce, livenessChallenge } = created.body;
  const started = await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: liveness === 'auto' ? livenessChallenge : liveness }, token);
  if (started.status !== 200) return { created, started, session, nonce };
  let ev;
  for (let i = 0; i < events.length; i += 180) { // respect the per-batch cap; multiple ordered batches
    ev = await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch: events.slice(i, i + 180) }, token);
    if (ev.status !== 200) break;
  }
  const done = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce, ...completeBody }, token);
  return { created, started, ev, done, session, nonce, livenessChallenge };
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
  ok(r.done.status === 200 && r.done.body.session.verificationState === 'partially_verified', 'B1: 18/20 min → partially verified');
  ok(r.done.body.session.verifiedActiveMs === 18 * MIN, 'B1: verified active time is 18:00');
  neg(r.done.body.session.verifiedActiveMs !== r.done.body.session.sessionDurationMs, 'B1: verified active time is NOT the elapsed session duration');
  ok(r.done.body.session.targetCompleted === false, 'B1: target not completed');
  ok(r.done.body.session.provenance === 'box_cam_observed' && r.done.body.session.provenanceLabel === 'Captured by Box Cam', 'B1: partial session carries box_cam_observed provenance');
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
  ok(r.done.status === 200 && r.done.body.session.verificationState === 'verified', 'B2: 103/100 reps → Box Cam Verified');
  ok(r.done.body.session.verifiedReps === 103 && r.done.body.session.targetCompleted === true, 'B2: 103 verified reps, target completed');
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
  ok(['partially_verified', 'unable_to_verify'].includes(r.done.body.session.verificationState), 'B3: partial/unable per thresholds');
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
  const empty = await runSession(kola.token, { drillId: 'box-mobility', target: { type: 'duration', value: 10 * MIN } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 100, quality: 'insufficient' },
  ], { completeBody: { verifiedActiveMs: 9_999_999, verificationState: 'verified', provenance: 'box_cam_observed' } });
  neg(empty.done.body.session.verificationState === 'unable_to_verify' && empty.done.body.session.verifiedActiveMs === 0, 'B4/B9: forged verified fields ignored — no observation, no verification');
}

section('B5 — coach assignment: partial completion is recorded, not "failed"');
let assignmentId;
{
  const a = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-adeyemi', drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, frequencyPerWeek: 3, instructions: 'Both feet, two-touch.' }, maria.token);
  ok(a.status === 201 && a.body.assignment.state === 'assigned', 'B5: verified club assigns Box Wall 150');
  assignmentId = a.body.assignment.id;
  // Box Wall has no rep_count capability — verifies active time only; 147
  // "reps" the client claims are irrelevant, target completion is null.
  const r = await runSession(kola.token, { drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, assignmentId }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 8 * MIN, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 8 * MIN },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 8 * MIN, quality: 'good' },
    ...Array.from({ length: 147 }, (_, i) => ({ seq: 4 + i, type: 'rep', atMs: i * 3000 })),
  ]);
  neg(r.done.body.session.verifiedReps === null, 'B5: Box Wall does not fabricate rep counts (capability honestly absent)');
  ok(r.done.body.session.verificationReasons.includes('REP_COUNT_NOT_CONFIGURED'), 'B5: result names the rep-count limitation');
  const view = await j('GET', '/org/box-cam/assignments?playerId=pl-adeyemi', undefined, maria.token);
  const row = view.body.items.find((x) => x.id === assignmentId);
  neg(row.lastResult && row.lastResult.statusLabel === 'Target not yet completed', 'B5: coach sees "Target not yet completed", never "failed"');
  ok(view.body.note.includes('never captured or shared'), 'B5: coach view states raw home footage is never captured/shared');
}

section('B6 — guardian + minor: club gets results, never home footage');
{
  const assign = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, maria.token);
  ok(assign.status === 201, 'B6: verified pro club assigns a visible minor via existing relationship');
  const gAssign = await j('GET', '/guardian/children/pl-guni/box-cam/assignments', undefined, amara.token);
  ok(gAssign.body.items.some((x) => x.id === assign.body.assignment.id), 'B6: guardian sees the child assignment');
  const gAccept = await j('POST', `/guardian/children/pl-guni/box-cam/assignments/${assign.body.assignment.id}/accept`, {}, amara.token);
  ok(gAccept.status === 200, 'B6: guardian accepts on the child’s behalf');
  const r = await runSession(guni.token, { drillId: 'box-control', target: { type: 'duration', value: 10 * MIN }, assignmentId: assign.body.assignment.id }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 11 * MIN, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 11 * MIN },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
  ]);
  ok(r.done.body.session.verificationState === 'verified', 'B6: minor completes the assignment (Box Cam Verified)');
  const coach = await j('GET', '/org/box-cam/assignments?playerId=pl-guni', undefined, maria.token);
  const row = coach.body.items.find((x) => x.id === assign.body.assignment.id);
  ok(row.lastResult && row.lastResult.verifiedActiveMs === 10 * MIN, 'B6: coach sees the result summary');
  neg(!('clipMediaId' in row) && !('obs' in row) && !JSON.stringify(row).includes('video'), 'B6: coach result carries no raw footage / observation stream');
  // Agency still walled from the minor entirely.
  const agencyAssign = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, alex.token);
  neg(agencyAssign.status === 403 && agencyAssign.body.error === 'AGENCY_NOT_ELIGIBLE', 'B6: agency cannot assign Box Training at all');
}

section('B7 — Box Challenge completion, no endorsement implication');
{
  const list = await j('GET', '/player/box-cam/challenges', undefined, kola.token);
  const touch = list.body.items.find((c) => c.title.includes('1,000 Touch'));
  ok(touch && touch.disclaimer.includes('does not mean the club has scouted'), 'B7: challenge carries the no-endorsement disclaimer');
  const join = await j('POST', `/player/box-cam/challenges/${touch.id}/join`, {}, kola.token);
  ok(join.status === 201, 'B7: adult joins the challenge');
  const entryId = join.body.challenge.entry.id;
  // 1000 touches across two sessions.
  for (const chunk of [520, 500]) {
    await runSession(kola.token, { drillId: 'box-touches', target: { type: 'repetitions', value: chunk }, challengeEntryId: entryId }, [
      { seq: 1, type: 'presence_interval', fromMs: 0, toMs: chunk * 400 + 1000, quality: 'good' },
      { seq: 2, type: 'ball_interval', fromMs: 0, toMs: chunk * 400 + 1000 },
      { seq: 3, type: 'active_interval', fromMs: 0, toMs: chunk * 400 + 1000, quality: 'good' },
      ...Array.from({ length: chunk }, (_, i) => ({ seq: 4 + i, type: 'rep', atMs: i * 400, confidence: 0.9 })),
    ]);
  }
  const after = await j('GET', '/player/box-cam/challenges', undefined, kola.token);
  const done = after.body.items.find((c) => c.id === touch.id);
  ok(done.entry.status === 'completed' && done.entry.progress >= 1000, 'B7: challenge completed from verified sessions');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.timeline.some((e) => e.type === 'box_challenge_completed'), 'B7: Passport gains a challenge milestone');
  neg(!JSON.stringify(sp).match(/scouted|endorsed you|selected you/i), 'B7: no scouting/endorsement implication anywhere');
}

section('B8 — replay / duplicate terminal submission rejected');
{
  const created = await j('POST', '/player/box-cam/sessions', { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } }, kola.token);
  const { session, nonce, livenessChallenge } = created.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch: [{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 5 * MIN, quality: 'good' }, { seq: 2, type: 'active_interval', fromMs: 0, toMs: 5 * MIN, quality: 'good' }] }, kola.token);
  const first = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, kola.token);
  ok(first.status === 200, 'B8: session completes once');
  const replay = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, kola.token);
  neg(replay.status === 409 && replay.body.error === 'ALREADY_FINALIZED', 'B8: duplicate terminal submission rejected');
  const lateEvents = await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch: [{ seq: 99, type: 'rep', atMs: 1000 }] }, kola.token);
  neg(lateEvents.status === 409, 'B8: events after completion rejected');
}

section('B9/§99 — integrity: forged fields, sequence, timestamps, cross-session, other player');
{
  // sequence must be monotonic
  const c = await j('POST', '/player/box-cam/sessions', { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } }, kola.token);
  const { session, nonce, livenessChallenge } = c.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  const badSeq = await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch: [{ seq: 5, type: 'active_interval', fromMs: 0, toMs: 1000 }, { seq: 3, type: 'active_interval', fromMs: 1000, toMs: 2000 }] }, kola.token);
  neg(badSeq.status === 409 && badSeq.body.error === 'SEQUENCE_INVALID', 'non-monotonic sequence rejected');
  const future = await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce, batch: [{ seq: 1, type: 'active_interval', fromMs: 0, toMs: 999_999_999 }] }, kola.token);
  neg(future.status === 422 && future.body.error === 'TIMESTAMP_OUT_OF_RANGE', 'timestamp beyond bounds rejected');
  const wrongNonce = await j('POST', `/player/box-cam/sessions/${session.id}/events`, { nonce: 'not-the-nonce', batch: [{ seq: 1, type: 'rep', atMs: 1 }] }, kola.token);
  neg(wrongNonce.status === 403 && wrongNonce.body.error === 'NONCE_INVALID', 'wrong nonce rejected (events cannot target a session without its nonce)');
  // another player cannot touch this session
  const other = await j('POST', `/player/box-cam/sessions/${session.id}/complete`, { nonce }, guni.token);
  neg(other.status === 404, "another player's session is not found for them");
  // liveness
  const c2 = await j('POST', '/player/box-cam/sessions', { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN } }, kola.token);
  const noLive = await j('POST', `/player/box-cam/sessions/${c2.body.session.id}/start`, { nonce: c2.body.nonce }, kola.token);
  neg(noLive.status === 403 && noLive.body.error === 'LIVENESS_REQUIRED', 'missing liveness blocks the session start');
  const wrongLive = await j('POST', `/player/box-cam/sessions/${c2.body.session.id}/start`, { nonce: c2.body.nonce, liveness: 'not_the_challenge' }, kola.token);
  neg(wrongLive.status === 403 && wrongLive.body.error === 'LIVENESS_MISMATCH', 'wrong liveness challenge rejected');
  // provider not configured
  const prod = await j('POST', '/player/box-cam/sessions', { drillId: 'box-mobility', target: { type: 'duration', value: 5 * MIN }, provider: 'production_cv' }, kola.token);
  neg(prod.status === 503 && prod.body.error === 'PROVIDER_NOT_CONFIGURED', 'production CV provider honestly refuses — never simulated');
}

section('B10/B11 — club authorization: minors, radius, unverified, blocks, suspended');
{
  const unverified = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, ruth.token);
  neg(unverified.status === 403 && unverified.body.error === 'ORG_NOT_ELIGIBLE', 'unverified club cannot assign Box Training');
  const farGrassroots = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-adeyemi', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, dee.token);
  neg(farGrassroots.status === 403 && farGrassroots.body.error === 'NOT_VISIBLE', 'grassroots 50 km radius holds for assignments (Manchester player invisible to London club)');
  // block — a throwaway adult so the permanent block never pollutes other tests
  const bobSignup = await j('POST', '/auth/player/signup', { name: 'Boxer Bob', dob: '1996-04-04', country: 'GB', position: 'CM', password: 'longenough1' });
  const bob = bobSignup.body?.token ? bobSignup.body : (await j('POST', '/auth/player/login', { playerId: bobSignup.body.playerId })).body;
  const beforeBlock = await j('POST', '/org/box-cam/assignments', { playerId: bob.playerId ?? bobSignup.body.playerId, drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, maria.token);
  ok(beforeBlock.status === 201, 'verified club can assign a visible adult');
  await j('POST', '/player/block', { orgId: 'org-eastport' }, bob.token);
  const blocked = await j('POST', '/org/box-cam/assignments', { playerId: bob.playerId ?? bobSignup.body.playerId, drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, maria.token);
  neg(blocked.status === 403 && blocked.body.error === 'NOT_VISIBLE', 'blocked org cannot assign once the player blocks it');
  // suspended org
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, null, A);
  const susp = await j('POST', '/org/box-cam/assignments', { playerId: 'pl-guni', drillId: 'box-control', target: { type: 'duration', value: 10 * MIN } }, maria.token);
  neg(susp.status === 403 && susp.body.error === 'ORG_SUSPENDED', 'suspended organisation cannot assign');
  const suspChal = await j('POST', '/org/box-cam/challenges', { title: 'X', drillId: 'box-touches', metric: 'reps', targetTotal: 100, days: 7 }, maria.token);
  neg(suspChal.status === 403 && suspChal.body.error === 'ORG_SUSPENDED', 'suspended organisation cannot publish a challenge');
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, null, A);
  // agency challenge
  const agChal = await j('POST', '/org/box-cam/challenges', { title: 'Y', drillId: 'box-touches', metric: 'reps', targetTotal: 100, days: 7 }, alex.token);
  neg(agChal.status === 403 && agChal.body.error === 'AGENCY_NOT_ELIGIBLE', 'agency cannot publish a Box Challenge');
}

section('B12 — dispute → T&S invalidation → Passport drops it → restore');
{
  const before = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  const beforeSessions = before.developmentActivity.boxSessions;
  const disp = await j('POST', `/player/box-cam/sessions/${b1SessionId}/dispute`, { reason: 'Box Cam missed my last few minutes.' }, kola.token);
  ok(disp.status === 201, 'B12: player files a dispute');
  const list = await j('GET', '/admin/box-cam/disputes', undefined, null, A);
  ok(list.body.items.some((d) => d.sessionId === b1SessionId), 'B12: dispute reaches the T&S queue');
  const dispId = list.body.items.find((d) => d.sessionId === b1SessionId).id;
  const resolve = await j('POST', `/admin/box-cam/disputes/${dispId}/resolve`, { outcome: 'invalidated', reason: 'Provider gap confirmed.' }, null, A);
  ok(resolve.status === 200, 'B12: T&S invalidates the result');
  const after = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(after.developmentActivity.boxSessions < beforeSessions, 'B12: invalidated session no longer counts in Passport development activity');
  const restore = await j('POST', `/admin/box-cam/sessions/${b1SessionId}/restore`, { reason: 'Reviewed again — original result was correct.' }, null, A);
  ok(restore.status === 200 && restore.body.session.verificationState === 'partially_verified', 'B12: restore returns the original result (history preserved)');
  // T&S cannot fabricate
  const badResolve = await j('POST', `/admin/box-cam/disputes/${dispId}/resolve`, { outcome: 'verified', reason: 'x' }, null, A);
  neg(badResolve.status === 409 || badResolve.status === 400, 'B12: T&S cannot fabricate a verified outcome');
}

section('§104 — privacy matrix: the same session across viewers');
{
  const self = await j('GET', `/player/box-cam/sessions/${b1SessionId}`, undefined, kola.token);
  ok(self.status === 200 && typeof self.body.session.verifiedActiveMs === 'number', 'SELF: full session detail (duration/state)');
  const ts = await j('GET', `/admin/box-cam/sessions/${b1SessionId}`, undefined, null, A);
  ok(ts.status === 200 && ts.body.session.resultHash && typeof ts.body.session.lastSeq === 'number', 'T&S: integrity metadata (result hash, sequence) visible');
  neg(self.body.session.resultHash === undefined, 'SELF: integrity internals not exposed to the player');
  // Org / recruitment: private by default, aggregate only after opt-in.
  const orgBefore = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  neg(orgBefore.body.developmentActivity === null, 'PRO CLUB: no development activity shared by default');
  await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, kola.token);
  const orgAfter = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  ok(orgAfter.body.developmentActivity && typeof orgAfter.body.developmentActivity.verifiedActiveMs === 'number', 'PRO CLUB: opted-in aggregate development activity visible');
  neg(!('recent' in (orgAfter.body.developmentActivity ?? {})) && JSON.stringify(orgAfter.body.developmentActivity).indexOf('resultHash') === -1, 'PRO CLUB: aggregate only — no per-session detail, no integrity internals');
  neg(orgAfter.body.developmentActivity.note.includes('not proof of player ability'), 'PRO CLUB: development activity explicitly not proof of ability');
  // no org route to a raw session
  const orgRaw = await j('GET', `/player/box-cam/sessions/${b1SessionId}`, undefined, maria.token);
  neg(orgRaw.status === 401 || orgRaw.status === 403 || orgRaw.status === 404, 'PRO CLUB: no route to a raw Box Session');
  // public
  const share = await j('POST', '/player/football-passport/shares', { mode: 'public' }, kola.token);
  const pub = await j('GET', share.body.url);
  neg(!pub.body.developmentActivity && !JSON.stringify(pub.body).match(/verifiedActiveMs|resultHash/), 'PUBLIC: no Box Cam development detail in the public passport');
  // guardian sees child session detail
  const gsess = await j('GET', '/guardian/children/pl-guni/box-cam/sessions', undefined, amara.token);
  ok(gsess.status === 200, 'GUARDIAN: child session detail available');
  const agencyRaw = await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token);
  neg(agencyRaw.status === 403, 'AGENCY: no passport (and thus no development activity) for a minor');
}

section('§99 — remaining abuse cases');
{
  // minor cannot mint/join without guardian; minor cannot change prefs
  const minorShare = await j('POST', `/player/box-cam/challenges/nope/join`, {}, guni.token);
  neg(minorShare.status === 403 && minorShare.body.error === 'GUARDIAN_MANAGED', 'minor cannot join a challenge directly (guardian-managed)');
  const minorPrefs = await j('PATCH', '/player/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, guni.token);
  neg(minorPrefs.status === 403, 'minor cannot change Box Cam privacy (guardian-managed)');
  // guardian mismatch
  const wrongChild = await j('GET', '/guardian/children/pl-adeyemi/box-cam/sessions', undefined, amara.token);
  neg(wrongChild.status === 404, "guardian cannot read an unrelated adult's Box sessions");
  // stale assignment completed after cancellation
  const cancel = await j('POST', `/org/box-cam/assignments/${assignmentId}/cancel`, {}, maria.token);
  ok(cancel.status === 200, 'assignment cancelled');
  const afterCancel = await runSession(kola.token, { drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, assignmentId }, [{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 60000, quality: 'good' }]);
  neg(afterCancel.created.status === 409 && afterCancel.created.body.error === 'ASSIGNMENT_CANCELLED', 'cannot start a session against a cancelled assignment');
  // multiple people pauses observation
  const multi = await runSession(kola.token, { drillId: 'box-footwork', target: { type: 'duration', value: 10 * MIN } }, [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
    { seq: 2, type: 'active_interval', fromMs: 0, toMs: 10 * MIN, quality: 'good' },
    { seq: 3, type: 'multi_person', fromMs: 4 * MIN, toMs: 6 * MIN },
  ]);
  neg(multi.done.body.session.verifiedActiveMs === 8 * MIN, 'multiple participants pause verified time (no facial recognition, no guessing)');
  // drill unknown
  const badDrill = await j('POST', '/player/box-cam/sessions', { drillId: 'box-nonsense', target: { type: 'duration', value: 60000 } }, kola.token);
  neg(badDrill.status === 404 && badDrill.body.error === 'DRILL_UNKNOWN', 'unknown drill rejected');
  // target metric unsupported for challenge
  const badMetric = await j('POST', '/org/box-cam/challenges', { title: 'Z', drillId: 'box-wall', metric: 'reps', targetTotal: 100, days: 7 }, maria.token);
  neg(badMetric.status === 400 && badMetric.body.error === 'METRIC_NOT_SUPPORTED', 'challenge cannot demand rep counts a drill cannot verify');
}

section('metrics — privacy-safe counters, no PII');
{
  const m = await j('GET', '/admin/metrics', undefined, null, A);
  const b = m.body.boxCam;
  ok(b && b.box_sessions_started > 0 && b.box_sessions_completed > 0 && b.box_sessions_verified > 0 && b.box_challenge_completed > 0, 'Box Cam counters populate');
  neg(!JSON.stringify(b).match(/pl-|Kola|adeyemi/), 'metrics carry no player identifiers');
}

// rate limit LAST — deliberately exhausts the per-player session window
section('§109 — session creation rate limit');
{
  let hit429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await j('POST', '/player/box-cam/sessions', { drillId: 'box-mobility', target: { type: 'duration', value: 60000 } }, kola.token);
    if (r.status === 429) { hit429 = true; break; }
  }
  neg(hit429, 'session creation is rate-limited against flooding');
}

const ratio = Math.round((negatives / passed) * 100);
console.log(`\nM16 acceptance suite: ${passed} checks passed, ${negatives} negative/abuse checks (${ratio}% of all checks)${process.exitCode ? ' (WITH FAILURES)' : ''}`);
if (negatives * 10 < passed * 4) { console.error('✗ negative-test ratio below 40%'); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
