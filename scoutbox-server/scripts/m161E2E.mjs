// M16.1 acceptance suite — At-Home Combine (measurement layer over Box Cam).
//
// Pure-engine fixtures (protocol registry, measurement derivation, personal
// best, comparison), then full HTTP journeys C1–C10 and the §76 abuse
// catalogue. Well over 40% of checks are negative/edge/security cases.
//
// The honesty gate is exercised directly: only metrics a real provider
// supports can be Combine Verified. In this environment the production web
// provider supports neither ball observation nor rep counting, so every
// first-library Combine is device-unsupported in production and is exercised
// via the gated, always-labelled test provider; future athletic protocols
// need capabilities NO provider has, so they can never be Combine Verified.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMBINE_PROTOCOLS, combineProtocol, latestCombineProtocol, measurementSupported,
  measurementCapability, measureAttempt, formatCombineValue, personalBest,
  combineResultHash, comparisonMatrix,
} from '../m16/combineShared.mjs';
import { PROVIDERS } from '../m16/drills.mjs';

const PORT = 4900 + Math.floor(Math.random() * 180);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m161-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0; let negatives = 0;
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
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const WINDOW = 60_000;

// ============================================================ Unit: registry
section('U1 — protocol registry + honesty gate (pure)');
{
  ok(COMBINE_PROTOCOLS.length >= 9, 'combine protocol library present');
  ok(COMBINE_PROTOCOLS.every((p) => p.id && p.version >= 1 && p.metricType && p.measurementAlgorithmVersion >= 1), 'every protocol is versioned with a metric + algorithm version');
  const webCaps = PROVIDERS.web_client.capabilities;
  const testCaps = PROVIDERS.local_test.capabilities;
  neg(measurementCapability(combineProtocol('combine-box-touch-60', 1), webCaps) === 'not_configured', 'Box Touch 60 (count) is NOT supported on the production web provider — honestly not_configured');
  neg(measurementCapability(combineProtocol('combine-box-control-60', 1), webCaps) === 'not_configured', 'Box Control 60 (ball duration) is NOT supported on web (no ball observation) — not_configured, not faked');
  ok(measurementSupported(combineProtocol('combine-box-touch-60', 1), testCaps), 'count protocol IS supported by the gated test provider (demo)');
  neg(measurementCapability(combineProtocol('combine-accel-10m', 1), testCaps) === 'not_configured', '10m sprint needs capabilities NO provider has — not_configured even under the test provider');
  neg(measurementCapability(combineProtocol('combine-broad-jump', 1), testCaps) === 'not_configured', 'broad jump distance needs spatial scale no provider has — never fabricated');
  ok(latestCombineProtocol('combine-box-touch-60').version === 1, 'latest protocol resolves');
}

section('U2 — measurement derivation (pure): server-only, no projection');
{
  const proto = combineProtocol('combine-box-touch-60', 1);
  const caps = PROVIDERS.local_test.capabilities;
  const full = { verificationState: 'partially_verified', sessionDurationMs: WINDOW, verifiedReps: 184, verifiedActiveMs: 60_000, quality: 'good' };
  const r1 = measureAttempt({ protocolDef: proto, session: full, calibrationPassed: true, providerCapabilities: caps, mode: 'verified' });
  ok(r1.combineState === 'combine_verified' && r1.measuredValue === 184, 'full 60s window + good quality → combine_verified 184 (drill target irrelevant)');
  const short = { verificationState: 'partially_verified', sessionDurationMs: 43_200, verifiedReps: 132, verifiedActiveMs: 43_200, quality: 'good' };
  const r2 = measureAttempt({ protocolDef: proto, session: short, calibrationPassed: true, providerCapabilities: caps, mode: 'verified' });
  neg(r2.combineState === 'partially_measured' && r2.measuredValue === 132 && r2.observedMs === 43_200, 'short window → partially_measured 132, observed 43.2s — measured, never projected to 184');
  const r3 = measureAttempt({ protocolDef: proto, session: full, calibrationPassed: true, providerCapabilities: PROVIDERS.web_client.capabilities, mode: 'verified' });
  neg(r3.combineState === 'measurement_unavailable', 'unsupported provider → measurement_unavailable, no value');
  const r4 = measureAttempt({ protocolDef: proto, session: { ...full, verificationState: 'unable_to_verify', verifiedReps: 0 }, calibrationPassed: true, providerCapabilities: caps, mode: 'verified' });
  neg(r4.combineState === 'measurement_unavailable', 'no reliable observation → measurement_unavailable');
  const r5 = measureAttempt({ protocolDef: proto, session: { ...full, verificationState: 'invalidated' }, calibrationPassed: true, providerCapabilities: caps, mode: 'verified' });
  neg(r5.combineState === 'invalidated', 'invalidated session → invalidated combine result');
  const r6 = measureAttempt({ protocolDef: proto, session: full, calibrationPassed: true, providerCapabilities: caps, mode: 'practice' });
  neg(r6.combineState !== 'combine_verified', 'practice attempt is never combine_verified');
  const dur = combineProtocol('combine-box-control-60', 1);
  const r7 = measureAttempt({ protocolDef: dur, session: { verificationState: 'partially_verified', sessionDurationMs: WINDOW, verifiedActiveMs: 57_400, quality: 'good' }, calibrationPassed: true, providerCapabilities: caps, mode: 'verified' });
  ok(r7.combineState === 'combine_verified' && r7.measuredValue === 57.4 && formatCombineValue(dur, r7.measuredValue) === '57.4', 'duration metric → 57.4s verified, tenths precision');
}

section('U3 — personal best + comparison (pure)');
{
  const attempts = [
    { measuredValue: 171, direction: 'higher', effectiveState: 'combine_verified' },
    { measuredValue: 184, direction: 'higher', effectiveState: 'combine_verified' },
    { measuredValue: 999, direction: 'higher', effectiveState: 'partially_measured' },
  ];
  ok(personalBest(attempts).measuredValue === 184, 'personal best ignores non-verified attempts');
  ok(personalBest([{ measuredValue: 6.9, direction: 'lower', effectiveState: 'combine_verified' }, { measuredValue: 6.8, direction: 'lower', effectiveState: 'combine_verified' }]).measuredValue === 6.8, 'lower-is-better direction respected');
  const m = comparisonMatrix({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], protocols: [combineProtocol('combine-box-touch-60', 1)], bestByPlayerProtocol: new Map([['a::combine-box-touch-60@1', { measuredValue: 184, completedAt: 1 }]]) });
  neg(m.rows[1].cells[0] === null, 'missing comparison cell is null, never 0');
  ok(!('overall' in m) && !('rank' in m), 'comparison produces no overall ranking');
}

// ---- actors
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');   // verified pro
const ruth = await login('org-harbour', 'Ruth Vane', 'Scout');                     // unverified club
const alex = await login('org-northstar', 'Alex Agent', 'Agent');                  // agency
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');// verified grassroots (London)
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;  // adult
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;     // minor, London
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, ruth, alex, dee, kola, guni, amara].every((a) => a?.token), 'all actors logged in');

// helper: run a full simulated Combine attempt end to end
async function runCombine(token, { protocolId, provider = 'local_test', mode = 'verified', requestId, calibrate }, buildEvents, { completeBody = {} } = {}) {
  const created = await j('POST', '/player/combine/attempts', { protocolId, provider, mode, requestId }, token);
  if (created.status !== 201) return { created };
  const { attempt, boxSession, nonce, livenessChallenge } = created.body;
  if (calibrate) await j('POST', `/player/combine/attempts/${attempt.id}/calibrate`, { checks: calibrate }, token);
  await j('POST', `/player/box-cam/sessions/${boxSession.id}/start`, { nonce, liveness: livenessChallenge }, token);
  const events = buildEvents();
  let ev;
  for (let i = 0; i < events.length; i += 180) { ev = await j('POST', `/player/box-cam/sessions/${boxSession.id}/events`, { nonce, batch: events.slice(i, i + 180) }, token); if (ev.status !== 200) break; }
  const done = await j('POST', `/player/combine/attempts/${attempt.id}/complete`, { nonce, ...completeBody }, token);
  return { created, attempt, boxSession, nonce, ev, done };
}
// event builders
const countEvents = (n, windowMs = WINDOW) => {
  const base = [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: windowMs, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: windowMs },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: windowMs, quality: 'good' },
  ];
  const gap = Math.max(200, Math.floor((windowMs - 500) / Math.max(n, 1)));
  for (let i = 0; i < n; i++) base.push({ seq: 4 + i, type: 'rep', atMs: 200 + i * gap, confidence: 0.92 });
  return base;
};
const countPartial = (n, observedMs) => {
  const base = [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: observedMs, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: observedMs },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: observedMs, quality: 'good' },
  ];
  const gap = Math.max(200, Math.floor((observedMs - 300) / Math.max(n, 1)));
  for (let i = 0; i < n; i++) base.push({ seq: 4 + i, type: 'rep', atMs: 150 + i * gap, confidence: 0.92 });
  return base;
};
const durationEvents = (activeMs, windowMs = WINDOW) => [
  { seq: 1, type: 'presence_interval', fromMs: 0, toMs: windowMs, quality: 'good' },
  { seq: 2, type: 'ball_interval', fromMs: 0, toMs: windowMs },
  { seq: 3, type: 'active_interval', fromMs: 0, toMs: activeMs, quality: 'good' },
];
const setEvents = (sets, windowMs) => {
  const base = [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: windowMs, quality: 'good' },
    { seq: 2, type: 'active_interval', fromMs: 0, toMs: windowMs, quality: 'good' },
  ];
  let seq = 3; const gap = Math.floor(windowMs / (sets + 1));
  for (let i = 0; i < sets; i++) base.push({ seq: seq++, type: 'set_completed', atMs: (i + 1) * gap });
  return base;
};

// ============================================================ C1
section('C1 — Box Touch 60: 184 verified, passport shows exactly 184');
let touchBest = null; let c1SessionId = null;
{
  const r = await runCombine(kola.token, { protocolId: 'combine-box-touch-60' }, () => countEvents(184));
  ok(r.done.status === 200 && r.done.body.attempt.combineState === 'combine_verified', 'C1: attempt is Combine Verified');
  ok(r.done.body.attempt.measuredValue === 184 && r.done.body.attempt.unit === 'touches', 'C1: measured value is 184 touches');
  ok(r.done.body.attempt.provenanceLabel === 'Combine Verified' && r.done.body.attempt.provenance === 'box_cam_observed', 'C1: provenance is Combine Verified / box_cam_observed');
  ok(Array.isArray(r.done.body.attempt.verificationExplained) && r.done.body.attempt.verificationExplained.length >= 6, 'C1: verification-details checklist present');
  ok(r.done.body.attempt.resultHash && r.done.body.attempt.resultHash.length === 64, 'C1: canonical result hash present');
  c1SessionId = r.boxSession.id;
  const card = await j('GET', '/player/combine/card', undefined, kola.token);
  ok(card.body.results.some((x) => x.protocolId === 'combine-box-touch-60' && x.display === '184'), 'C1: Combine Card shows Box Touch 60 = 184');
  const pp = await j('GET', '/player/football-passport', undefined, kola.token);
  ok(pp.body.combine && pp.body.combine.results.some((x) => x.protocolId === 'combine-box-touch-60' && x.measuredValue === 184), 'C1: Football Passport projects exactly 184 (never copied)');
  touchBest = 184;
}

// ============================================================ C2
section('C2 — client cannot forge the number or the state');
{
  const r = await runCombine(kola.token, { protocolId: 'combine-box-touch-60' }, () => countEvents(150),
    { completeBody: { measuredValue: 250, combineState: 'combine_verified', measurementState: 'measured', provenance: 'box_cam_observed', verifiedReps: 250 } });
  neg(r.done.body.attempt.measuredValue === 150, 'C2: forged measuredValue ignored — server-derived 150 stands');
  neg(r.done.body.attempt.measuredValue !== 250, 'C2: 250 never appears');
}

// ============================================================ C3
section('C3 — short window: measured, not verified, never projected');
{
  const r = await runCombine(kola.token, { protocolId: 'combine-box-touch-60' }, () => countPartial(132, 43_200));
  neg(r.done.body.attempt.combineState === 'partially_measured', 'C3: only 43.2s observed → partially_measured (not Combine Verified)');
  ok(r.done.body.attempt.measuredValue === 132, 'C3: records 132 observed, no projection to 184');
  neg(r.done.body.attempt.reasons.includes('MEASUREMENT_WINDOW_INCOMPLETE'), 'C3: reason states the window was incomplete');
}

// ============================================================ C4
section('C4 — practice never produces a Combine Verified result');
{
  const r = await runCombine(kola.token, { protocolId: 'combine-box-touch-60', mode: 'practice' }, () => countEvents(190));
  neg(r.done.body.attempt.combineState !== 'combine_verified', 'C4: practice attempt is not Combine Verified');
  ok(r.done.body.attempt.mode === 'practice', 'C4: attempt is labelled practice');
  const card = await j('GET', '/player/combine/card', undefined, kola.token);
  neg(!card.body.results.some((x) => x.protocolId === 'combine-box-touch-60' && x.display === '190'), 'C4: practice 190 does not enter the Combine Card / personal best');
}

// ============================================================ C9 (before C5 requests)
section('C9 — repeat verified test: personal best updates, history kept');
{
  const r1 = await runCombine(kola.token, { protocolId: 'combine-box-juggle' }, () => countEvents(171));
  ok(r1.done.body.attempt.combineState === 'combine_verified' && r1.done.body.attempt.measuredValue === 171, 'C9: first juggle attempt 171 verified');
  const r2 = await runCombine(kola.token, { protocolId: 'combine-box-juggle' }, () => countEvents(184));
  ok(r2.done.body.attempt.measuredValue === 184, 'C9: second juggle attempt 184 verified');
  const mc = await j('GET', '/player/combine', undefined, kola.token);
  const juggleBest = mc.body.verifiedResults.find((x) => x.protocolId === 'combine-box-juggle');
  ok(juggleBest && juggleBest.measuredValue === 184, 'C9: personal best is 184');
  const hist = await j('GET', '/player/combine/attempts', undefined, kola.token);
  ok(hist.body.items.filter((x) => x.protocolId === 'combine-box-juggle').length >= 2, 'C9: both attempts retained in history');
}

// ============================================================ C7
section('C7 — unsupported measurement stays unsupported (never estimated)');
{
  const web = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-touch-60', provider: 'web_client' }, kola.token);
  neg(web.status === 422 && web.body.error === 'MEASUREMENT_NOT_SUPPORTED', 'C7: count metric on the production web provider → 422 measurement not supported');
  const sprint = await j('POST', '/player/combine/attempts', { protocolId: 'combine-accel-10m', provider: 'local_test' }, kola.token);
  neg(sprint.status === 422 && sprint.body.error === 'MEASUREMENT_NOT_SUPPORTED', 'C7: 10m sprint unsupported even under the test provider — never faked');
  const sprintPractice = await j('POST', '/player/combine/attempts', { protocolId: 'combine-accel-10m', provider: 'local_test', mode: 'practice' }, kola.token);
  neg(sprintPractice.status === 400 || sprintPractice.status === 422, 'C7: sprint practice also refused (practice disabled for unsupported athletic protocols)');
}

// ============================================================ C5 + Club Combine
section('C5 — Club Combine request → player completes → club sees result');
let reqId = null;
{
  // Use two protocols Kola has not yet exhausted (touch-60 already used its
  // 3 verified attempts in C1–C3 — the honest per-protocol daily limit).
  const req = await j('POST', '/org/combine/requests', { title: 'Eastport Academy At-Home Combine', protocolIds: ['combine-box-control-60', 'combine-box-footwork'], playerId: 'pl-adeyemi', deadline: '2027-12-31' }, maria.token);
  ok(req.status === 201 && req.body.requests.length === 1, 'C5: verified club creates a Club Combine request');
  reqId = req.body.requests[0].id;
  const playerReqs = await j('GET', '/player/combine/requests', undefined, kola.token);
  ok(playerReqs.body.items.some((r) => r.id === reqId && r.requiredCount === 2), 'C5: player sees the 2-test request');
  // complete both required standardized protocols
  await runCombine(kola.token, { protocolId: 'combine-box-control-60', requestId: reqId }, () => durationEvents(59_000));
  await runCombine(kola.token, { protocolId: 'combine-box-footwork', requestId: reqId }, () => setEvents(5, 5 * WINDOW));
  const after = await j('GET', '/org/combine/requests', undefined, maria.token);
  const row = after.body.items.find((r) => r.id === reqId);
  ok(row && row.state === 'completed', 'C5: request completes when both standardized tests are Combine Verified');
  const results = await j('GET', '/org/combine/players/pl-adeyemi', undefined, maria.token);
  ok(results.body.shared && results.body.results.some((x) => x.protocolId === 'combine-box-control-60'), 'C5: requesting club sees the verified result card (results only)');
  neg(JSON.stringify(results.body).includes('videoUrl') === false && JSON.stringify(results.body).includes('dob') === false, 'C5: club result carries no raw video URL and no DOB');
}

// ============================================================ C10
section('C10 — club comparison: verified numbers, blanks not zeros, no ranking');
{
  // Guni (minor, visible to verified pro) completes one test; opt in via guardian
  await j('PATCH', '/guardian/children/pl-guni/box-cam/prefs', { shareDevelopmentActivity: 'recruitment' }, amara.token);
  await runCombine(guni.token, { protocolId: 'combine-box-touch-60' }, () => countEvents(150));
  const cmp = await j('GET', '/org/combine/compare?playerIds=pl-adeyemi,pl-guni&protocols=combine-box-touch-60,combine-box-control-60', undefined, maria.token);
  ok(cmp.body.rows.length >= 1, 'C10: comparison returns rows for visible players');
  const kolaRow = cmp.body.rows.find((r) => r.playerId === 'pl-adeyemi');
  ok(kolaRow && kolaRow.cells[0] && kolaRow.cells[0].verified, 'C10: Kola has a verified Box Touch 60 cell');
  const guniRow = cmp.body.rows.find((r) => r.playerId === 'pl-guni');
  neg(guniRow && guniRow.cells[1] === null, 'C10: Guni has no Box Control result → blank cell (not 0)');
  ok(!('overall' in cmp.body) && cmp.body.note.includes('does not rank'), 'C10: no overall ranking produced');
}

// ============================================================ C6
section('C6 — minor + guardian: club gets results, agency walled, no footage');
{
  const gReqs = await j('GET', '/guardian/children/pl-guni/combine/requests', undefined, amara.token);
  ok(gReqs.status === 200, 'C6: guardian can view the child\'s Combine requests');
  const gCombine = await j('GET', '/guardian/children/pl-guni/combine', undefined, amara.token);
  ok(gCombine.status === 200 && Array.isArray(gCombine.body.verifiedResults), 'C6: guardian views the child\'s My Combine');
  const agency = await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-guni' }, alex.token);
  neg(agency.status === 403 && agency.body.error === 'AGENCY_NOT_ELIGIBLE', 'C6: agency cannot request an At-Home Combine (agency/minor wall upheld)');
}

// ============================================================ C8
section('C8 — invalidation recalculates PB and Passport; restore brings it back');
{
  // Kola PB for Box Touch 60 is currently 184 (from C1). Invalidate that session.
  const dispute = await j('POST', `/player/box-cam/sessions/${c1SessionId}/dispute`, { reason: 'Box Cam miscounted my touches.' }, kola.token);
  ok(dispute.status === 201, 'C8: player disputes the underlying Box Cam session');
  const disputes = await j('GET', '/admin/box-cam/disputes', undefined, undefined, A);
  const d = disputes.body.items.find((x) => x.sessionId === c1SessionId);
  await j('POST', `/admin/box-cam/disputes/${d.id}/resolve`, { outcome: 'invalidated', reason: 'Provider miscount confirmed.' }, undefined, A);
  const mc = await j('GET', '/player/combine', undefined, kola.token);
  const best = mc.body.verifiedResults.find((x) => x.protocolId === 'combine-box-touch-60');
  neg(!best || best.measuredValue !== 184, 'C8: invalidated 184 no longer counts as the personal best');
  const pp = await j('GET', '/player/football-passport', undefined, kola.token);
  neg(!pp.body.combine.results.some((x) => x.protocolId === 'combine-box-touch-60' && x.measuredValue === 184), 'C8: Passport no longer shows the invalidated 184');
  // restore
  await j('POST', `/admin/box-cam/sessions/${c1SessionId}/restore`, { reason: 'Re-review overturned.' }, undefined, A);
  const mc2 = await j('GET', '/player/combine', undefined, kola.token);
  ok(mc2.body.verifiedResults.some((x) => x.protocolId === 'combine-box-touch-60' && x.measuredValue === 184), 'C8: restore brings the verified 184 back (history preserved)');
}

// ============================================================ §76 abuse catalogue
section('§76 — abuse / edge / security catalogue');
{
  // 1-3 forge value/state/provenance already covered in C2; re-assert state forge
  // (juggle — touch-60's daily verified attempts are exhausted by C1–C3)
  const forge = await runCombine(kola.token, { protocolId: 'combine-box-juggle' }, () => countEvents(120), { completeBody: { combineState: 'combine_verified', measuredValue: 999 } });
  neg(forge.done.body.attempt.measuredValue === 120, '1-3: forged value/state ignored (server-derived 120)');
  // 4 protocol spoof — unknown
  neg((await j('POST', '/player/combine/attempts', { protocolId: 'combine-make-believe' }, kola.token)).status === 404, '4: unknown protocol rejected');
  // 5/6 replay / prerecorded upload — no upload path to Combine Verified at all
  neg((await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-touch-60', boxSessionId: 'boxs-forged' }, kola.token)).body.attempt?.boxSessionId !== 'boxs-forged', '6: client cannot bind an arbitrary/forged Box Session');
  // 8 cross-player attempt access
  const kAtt = (await j('GET', '/player/combine/attempts', undefined, kola.token)).body.items[0];
  neg((await j('GET', `/player/combine/attempts/${kAtt.id}`, undefined, guni.token)).status === 404, '8: another player cannot read your Combine Attempt');
  // 12 stale nonce / wrong nonce on complete (guni — a fresh player for this protocol)
  {
    const c = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-control-60', provider: 'local_test' }, guni.token);
    await j('POST', `/player/box-cam/sessions/${c.body.boxSession.id}/start`, { nonce: c.body.nonce, liveness: c.body.livenessChallenge }, guni.token);
    neg((await j('POST', `/player/combine/attempts/${c.body.attempt.id}/complete`, { nonce: 'wrong-nonce' }, guni.token)).status === 403, '12: wrong nonce on complete → 403');
    // cancel to clean up
    await j('POST', `/player/combine/attempts/${c.body.attempt.id}/cancel`, {}, guni.token);
  }
  // 11 practice→verified upgrade impossible (practice attempts have their own id, never reclassified)
  const prac = await runCombine(kola.token, { protocolId: 'combine-box-control-60', mode: 'practice' }, () => durationEvents(59_000));
  neg(prac.done.body.attempt.combineState !== 'combine_verified', '11: practice attempt cannot become Combine Verified');
  // 13/14 unsupported metric / incomplete presented as verified — covered C7/C3; assert measurement_unavailable path
  neg((await j('POST', '/player/combine/attempts', { protocolId: 'combine-broad-jump', provider: 'local_test' }, kola.token)).status === 422, '13: distance metric unsupported → 422');
  // 16 duplicate terminal (complete twice) — control-60 (duration)
  {
    const r = await runCombine(kola.token, { protocolId: 'combine-box-control-60' }, () => durationEvents(58_000));
    const again = await j('POST', `/player/combine/attempts/${r.attempt.id}/complete`, { nonce: r.nonce }, kola.token);
    neg(again.status === 409, '16: completing an already-finalized attempt → 409');
  }
  // 17 attempt limit (4th verified attempt for a protocol in 24h)
  {
    // strength-60 fresh; do 3 verified then a 4th
    for (let i = 0; i < 3; i++) await runCombine(kola.token, { protocolId: 'combine-box-strength-60' }, () => countEvents(30 + i));
    const fourth = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-strength-60', provider: 'local_test', mode: 'verified' }, kola.token);
    neg(fourth.status === 429 && fourth.body.error === 'ATTEMPT_LIMIT_REACHED', '17: 4th verified attempt in the window → 429 attempt limit');
    const practiceStill = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-strength-60', provider: 'local_test', mode: 'practice' }, kola.token);
    ok(practiceStill.status === 201, '17: practice attempts remain available after the verified limit');
    await j('POST', `/player/combine/attempts/${practiceStill.body.attempt.id}/cancel`, {}, kola.token);
  }
  // 20/28/52 hidden result not leaked; missing ≠ zero
  const noShare = await j('GET', '/org/combine/players/pl-adeyemi', undefined, dee.token); // grassroots London — Kola visible? radius
  neg(noShare.status !== 200 || noShare.body.shared === false || noShare.body.results.length === 0, '20: org without recruitment opt-in or a request sees no Combine results');
  // 22/26 agency/minor + forged request to invisible player
  neg((await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-guni' }, alex.token)).status === 403, '22/26: agency request blocked (cannot reach a minor)');
  // 24 blocked club
  {
    await j('POST', '/guardian/block', { orgId: 'org-eastport', playerId: 'pl-guni', reason: 'test' }, amara.token);
    const blockedReq = await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-guni' }, maria.token);
    neg((blockedReq.body.requests?.length ?? 0) === 0, '24: request to a player who blocked the org creates nothing (skipped)');
  }
  // 25 suspended club
  {
    await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, undefined, A);
    const susp = await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-adeyemi' }, maria.token);
    neg(susp.status === 403, '25: suspended org cannot create a Club Combine');
    await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, undefined, A);
  }
  // 27 club cannot modify a standardized protocol (only protocolIds accepted; extra fields ignored)
  {
    const r = await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-adeyemi', protocolWindowMs: 9999, metricType: 'time', requiredCapabilities: [] }, maria.token);
    ok(r.status === 201, '27: club selects a standardized protocol');
    const proto = latestCombineProtocol('combine-box-touch-60');
    ok(proto.protocolWindowMs === 60_000 && proto.metricType === 'count', '27: the standardized protocol definition is unchanged by the request body');
  }
  // 30 result hash present and deterministic over inputs
  ok(combineResultHash({ id: 'x', playerId: 'p', protocolId: 'combine-box-touch-60', protocolVersion: 1, boxSessionId: 's', metricType: 'count', measuredValue: 184, provider: 'local_test', providerVersion: 1, measurementAlgorithmVersion: 1, completedAt: 1, combineState: 'combine_verified' }).length === 64, '30: canonical combine result hash produced');
  // unverified org cannot create a Club Combine
  neg((await j('POST', '/org/combine/requests', { protocolIds: ['combine-box-touch-60'], playerId: 'pl-adeyemi' }, ruth.token)).status === 403, 'extra: unverified club cannot create a Club Combine');
  // guardian-only privacy: agency cannot read minor combine via passport
  neg((await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token)).body?.combine == null, 'extra: agency passport view of a minor carries no Combine block');
}

// ============================================================ metrics
section('metrics — privacy-safe counters');
{
  const m = await j('GET', '/admin/metrics', undefined, undefined, A);
  const bc = m.body?.boxCam ?? m.body?.metrics?.boxCam ?? null;
  ok(bc && typeof bc.combine_attempt_started === 'number' && bc.combine_attempt_verified >= 1, 'combine metrics counters present and incremented');
  ok(JSON.stringify(bc).includes('pl-adeyemi') === false, 'metrics carry no player identifiers');
}

// ---------------------------------------------------------------- summary
await sleep(50);
const total = passed;
console.log(`\nM16.1 acceptance suite: ${total} checks passed, ${negatives} negative/abuse checks (${Math.round((negatives / total) * 100)}% of all checks)`);
if (negatives * 10 < total * 4) { fail(`negative coverage ${negatives}/${total} below the 40% floor`); }
if (process.exitCode) { console.error('\nSOME CHECKS FAILED'); } else { console.log('all M16.1 checks passed'); }
process.exit(process.exitCode || 0);
