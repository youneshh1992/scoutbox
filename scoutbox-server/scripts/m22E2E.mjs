// M22 acceptance suite — production CV provider, frame transport, integration.
//
// §99 requires a minimum of 60% negative/integrity/security checks, and that
// ratio is not decoration. The whole risk surface of this phase is "a pixel
// endpoint that accepts something it should not", so the suite is weighted
// toward what must be REFUSED.
//
// Structure:
//   §85  twenty frame-transport security cases, over real HTTP
//   §86  the CV adversarial catalogue, driven through the provider path
//   §87-§90  provider crash, engine exception, queue overflow, restart
//   §37/§92  raw-frame persistence scan
//   §91  identity/biometric/audio absence sweep
//   §93  rate limits
//   §58/§59  Combine integration, and the blocker end to end over HTTP

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionCvProvider, PROVIDER_ERRORS, canTransition } from '../m22/provider.mjs';
import { combineVerifiedProtocols, combineEligibility } from '../m22/eligibility.mjs';
import { decodeFrame } from '../m22/frames.mjs';
import { FRAME_LIMITS, FRAME_ENCODING } from '../m22/policy.mjs';
import {
  sequence, jugglePath, touchPath, stationaryPath, rollPath,
  independentBouncePath, DEFAULT_PERSON,
} from '../m22/scenes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4960 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m22-'));
const SERVER = path.join(HERE, '..', 'server.mjs');

let passed = 0, negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR,
  M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', TEST_LICENCE_REGISTRY: '1',
};
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return proc; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('server did not come up');
}
await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}

// ---------------------------------------------------------------- actors
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;

/** A live, liveness-passed Box Cam session bound to production_cv. */
async function liveSession(token, drillId = 'box-touches') {
  const created = await j('POST', '/player/box-cam/sessions', {
    drillId, target: { type: 'repetitions', value: 20 }, provider: 'production_cv',
  }, token);
  if (created.status !== 201) return { created };
  const { session, nonce, livenessChallenge } = created.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, token);
  return { session, nonce, created };
}

/** gray8 frame envelopes from a synthetic scene, ready to POST. */
function frameEnvelopes(opts, count = 8) {
  const raw = sequence({ w: 160, h: 120, fps: 12, durationMs: 2400, ...opts });
  return raw.slice(0, count).map((f, i) => ({ ...f, seq: i + 1 }));
}

const goodFrames = frameEnvelopes({ path: touchPath({ touches: 6 }), seed: 23 });

// =====================================================================
section('§85 — frame-transport security: twenty ways in, all closed');
// =====================================================================

const live = await liveSession(kola.token);
ok(live.session != null, 'a Box Cam session bound to production_cv starts and passes liveness');

const begun = await j('POST', `/player/box-cam/sessions/${live.session.id}/cv/begin`,
  { nonce: live.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
ok(begun.status === 201 && begun.body.providerSessionId, 'a provider session opens');
neg(begun.body.combineVerifiedEligible === false,
  'and declares combineVerifiedEligible:false before a single frame is sent');
const PSID = begun.body.providerSessionId;
const FRAMES_URL = `/player/box-cam/sessions/${live.session.id}/cv/frames`;

//  1. anonymous frame
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) });
  neg(r.status === 401 || r.status === 403, '1. an unauthenticated frame is rejected');
}
//  2. foreign user session
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) }, guni.token);
  neg(r.status === 404, '2. another player cannot submit frames to this session');
}
//  3. foreign Box Cam session
{
  const other = await liveSession(guni.token);
  const r = await j('POST', `/player/box-cam/sessions/${other.session.id}/cv/frames`,
    { nonce: other.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) }, guni.token);
  neg(r.status === 404, '3. a provider session cannot be attached to a different Box Cam session');
}
//  4. wrong provider session
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: 'pcv_not_a_real_session', frames: goodFrames.slice(0, 1) }, kola.token);
  neg(r.status === 404, '4. an unknown provider session id is not found');
}
//  5. old nonce (a previous session's)
{
  const stale = await liveSession(kola.token);
  const r = await j('POST', FRAMES_URL, { nonce: stale.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) }, kola.token);
  neg(r.status === 403 && r.body.error === PROVIDER_ERRORS.NONCE_INVALID, '5. another session\'s nonce is rejected');
}
//  6. wrong nonce
{
  const r = await j('POST', FRAMES_URL, { nonce: 'not-the-nonce', providerSessionId: PSID, frames: goodFrames.slice(0, 1) }, kola.token);
  neg(r.status === 403 && r.body.error === PROVIDER_ERRORS.NONCE_INVALID, '6. a forged nonce is rejected');
}
// Establish a legitimate high-water mark for the ordering cases.
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 4) }, kola.token);
  ok(r.status === 200 && r.body.accepted === 4, 'four legitimate frames are accepted');
}
//  7. duplicate sequence
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[2]] }, kola.token);
  neg(r.status === 409 && r.body.error === PROVIDER_ERRORS.DUPLICATE_FRAME, '7. a duplicate sequence is refused, never double-processed');
}
//  8. out-of-order beyond the window
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 1 }] }, kola.token);
  neg(r.status === 409, '8. an out-of-order frame beyond the reorder window is refused');
}
//  9. oversized frame
{
  const big = { ...goodFrames[0], seq: 900, w: FRAME_LIMITS.maxWidth, h: FRAME_LIMITS.maxHeight, data: goodFrames[0].data };
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [big] }, kola.token);
  neg(r.status >= 400, '9. a frame whose declared size does not match its payload is refused');
}
// 10. unsupported dimensions
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 901, w: 4000, h: 3000 }] }, kola.token);
  neg(r.status === 422 && r.body.error === PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS, '10. unsupported dimensions are refused by name');
}
// 11. malformed payload
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [{ seq: 902 }] }, kola.token);
  neg(r.status >= 400 && r.status < 500, '11. a malformed frame envelope is refused without a server error');
}
// 12. unsupported encoding — the "is this a file upload" case
{
  const jpeg = { seq: 903, encoding: 'image/jpeg', w: 160, h: 120, data: 'iVBORw0KGgoAAAANSUhEUg==' };
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [jpeg] }, kola.token);
  neg(r.status === 415 && r.body.error === PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT,
    '12. a JPEG is refused by name — this endpoint is not a file upload');
}
// 12b. §10 — a multipart body never reaches frame handling at all
{
  const r = await fetch(`${BASE}${FRAMES_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=x', Authorization: `Bearer ${kola.token}` },
    body: '--x\r\nContent-Disposition: form-data; name="f"; filename="a.mp4"\r\n\r\nvideo\r\n--x--',
  });
  neg(r.status >= 400, '12b. a multipart file upload is refused');
}
// 13. extreme ingest rate / 14. queue saturation — batch cap
{
  const many = Array.from({ length: FRAME_LIMITS.maxFramesPerBatch + 5 }, (_, i) => ({ ...goodFrames[0], seq: 1000 + i }));
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: many }, kola.token);
  neg(r.status === 429 && r.body.error === PROVIDER_ERRORS.QUEUE_OVERFLOW,
    `13/14. a batch above ${FRAME_LIMITS.maxFramesPerBatch} frames is refused rather than queued`);
}
// 16. finalized session ingest
{
  const fin = await j('POST', `/player/box-cam/sessions/${live.session.id}/cv/finalize`,
    { nonce: live.nonce, providerSessionId: PSID }, kola.token);
  ok(fin.status === 200, 'the session finalizes');
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 5000 }] }, kola.token);
  neg(r.status === 404 || r.status === 409, '16. a finalized session accepts no further frames');
}
// 7b. §7 — finalize is single-shot and returns the SAME result
{
  const a = await j('POST', `/player/box-cam/sessions/${live.session.id}/cv/finalize`, { nonce: live.nonce, providerSessionId: PSID }, kola.token);
  neg(a.status === 200 && a.body.alreadyFinalized === true,
    '7b. a second finalize returns the stored result and mints nothing new');
}
// 17. cancelled session ingest
{
  const s = await liveSession(kola.token);
  const b = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/begin`, { nonce: s.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/cancel`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId }, kola.token);
  const r = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/frames`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: [goodFrames[0]] }, kola.token);
  neg(r.status === 404, '17. a cancelled session accepts no frames');
  const f = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/finalize`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId }, kola.token);
  neg(f.status >= 400 || f.body?.result == null, '17b. and a cancelled attempt mints no result');
}
// 18. reused old session id / 15. expired session
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[0]] }, kola.token);
  neg(r.status === 404, '18. a released provider session id cannot be resurrected');
}
// 19. cross-player session / 20. cross-org leak
{
  const s = await liveSession(guni.token);
  const r = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/begin`, { nonce: s.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  neg(r.status === 404, '19. one player cannot open a provider session on another player\'s Box Cam session');
  const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const leak = await j('POST', `/player/box-cam/sessions/${live.session.id}/cv/frames`,
    { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[0]] }, maria.token);
  neg(leak.status === 401 || leak.status === 403 || leak.status === 404,
    '20. an organisation token cannot reach a player\'s frame endpoint');
}
// §57 — unsupported protocol, no fallback
{
  const s = await liveSession(kola.token);
  const r = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/begin`, { nonce: s.nonce, protocolId: 'combine-agility-5-10-5' }, kola.token);
  neg(r.status === 422 && r.body.error === PROVIDER_ERRORS.UNSUPPORTED_PROTOCOL,
    '§57. an unsupported protocol is named, never approximated by a fallback');
}
// §42 — liveness is required before a provider session opens
{
  const c = await j('POST', '/player/box-cam/sessions', {
    drillId: 'box-touches', target: { type: 'repetitions', value: 20 }, provider: 'production_cv',
  }, kola.token);
  const r = await j('POST', `/player/box-cam/sessions/${c.body.session.id}/cv/begin`,
    { nonce: c.body.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  neg(r.status >= 400, '§42. without liveness and a started session, no provider session opens');
}

// =====================================================================
section('§86 — the CV adversarial catalogue, through the provider path');
// =====================================================================
//
// The engine already refuses these; the question here is whether the PROVIDER
// layer can weaken that. It runs the same scenes through beginSession →
// ingestFrame → finalize and asserts the provider reports what the engine
// decided, unchanged.

const P = DEFAULT_PERSON;
const adversarial = [
  ['camera shake over a still ball', { path: stationaryPath({ x: 0.567, y: 0.83 }), cameraShakeN: 0.012 }],
  ['camera zoom pulse over a fixed relationship', { path: stationaryPath({ x: 0.567, y: 0.83 }), cameraScale: (t) => (Math.abs(t - 1200) < 200 ? 1.2 : 1) }],
  ['step zoom held', { path: stationaryPath({ x: 0.567, y: 0.83 }), cameraScale: (t) => (t < 1200 ? 1 : 1.35) }],
  ['no ball present', { path: () => null }],
  ['no person present', { path: jugglePath({ contacts: 6 }), person: { x0: 0, y0: 0, x1: 0.001, y1: 0.001, luma: 130 } }],
  ['multiple people', { path: stationaryPath({ x: 0.84, y: 0.88 }), extraPeople: (t) => [{ x0: 0.05 + 0.00012 * t, y0: 0.38, x1: 0.16 + 0.00012 * t, y1: 0.93, luma: 62 }] }],
  ['multiple balls', { path: stationaryPath({ x: 0.10, y: 0.86 }), extraBalls: () => [{ x: 0.7, y: 0.86, rN: 0.031, luma: 238, blur: 0 }] }],
  ['low light', { path: jugglePath({ contacts: 6 }), bgLuma: 12, ballLuma: 30 }],
  ['frozen sequence', { path: stationaryPath({ x: 0.567, y: 0.83 }), noise: 0 }],
  ['prolonged proximity', { path: stationaryPath({ x: 0.545, y: 0.91 }), durationMs: 6000 }],
  ['independent bounce away from the player', { path: independentBouncePath({ x: 0.15 }) }],
  ['ball rolling past, no contact', { path: rollPath({ x0: 0.05, x1: 0.95, y: 0.90, durationMs: 3000 }) }],
  ['tracking jitter', { path: (t) => ({ x: 0.567 + 0.004 * Math.sin(t / 60), y: 0.83 + 0.004 * Math.cos(t / 55) }), personAt: (t) => ({ ...P, x0: P.x0 + 0.004 * Math.sin(t / 61), x1: P.x1 + 0.004 * Math.sin(t / 61) }) }],
];

let providerFalseTouches = 0;
for (const [label, opts] of adversarial) {
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({ boxCamSessionId: `adv-${label}`, playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  const raw = sequence({ w: 200, h: 150, fps: 15, durationMs: 3000, seed: 61, ...opts });
  let n = 0;
  for (const f of raw) {
    const d = decodeFrame(f);
    if (!d.ok) continue;
    n += 1;
    prov.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: `adv-${label}`, nonce: 'n', seq: n, frame: d.frame });
  }
  const fin = prov.finalize({ providerSessionId: b.providerSessionId });
  const count = fin.ok ? (fin.result.derived.touchCount ?? 0) : 0;
  if (count > 0) providerFalseTouches += count;
  neg(count === 0, `§86. "${label}" produces no touch through the provider (${fin.ok ? fin.result.outcome : 'failed'})`);
  neg(!fin.ok || fin.result.combineVerified === false, `      …and combineVerified stays false`);
  prov.disposeAll();
}
ok(providerFalseTouches === 0, '§86. the provider layer weakens nothing — zero false touches across the catalogue');

// =====================================================================
section('§87–§90 — provider crash, engine exception, overflow, restart');
// =====================================================================
{
  // §88 — an engine that throws fails the session safely and leaks no stack.
  const prov = new ProductionCvProvider({ processFrame: () => { throw new Error('/srv/secret/path.mjs exploded'); } });
  const b = prov.beginSession({ boxCamSessionId: 'crash', playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  const d = decodeFrame(goodFrames[0]);
  const r = prov.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: 'crash', nonce: 'n', seq: 1, frame: d.frame });
  neg(r.ok === false && r.error === PROVIDER_ERRORS.ENGINE_FAILURE, '§88. an engine exception fails the session with a typed error');
  neg(!JSON.stringify(r).includes('/srv/secret/path.mjs'), '§88. and no file path or stack reaches the caller');
  const fin = prov.finalize({ providerSessionId: b.providerSessionId });
  neg(fin.ok === false, '§87. no result is minted from a failed session');
  neg(prov.footprint().activeSessions === 0, '§87. and its resources are released');
  prov.disposeAll();
}
{
  // §89 — queue overflow is accounted for, not hidden.
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({ boxCamSessionId: 'flood', playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  const d = decodeFrame(goodFrames[0]);
  const ing = prov.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: 'flood', nonce: 'n', seq: 1, frame: d.frame });
  ok(ing.ok === true && typeof ing.droppedByServer === 'number',
    '§89/§23. every ingest reports server-side drops so they can feed observation quality');
  prov.disposeAll();
}
{
  // §6 — invalid transitions fail closed.
  neg(canTransition('accepted', 'running') === false, '§6. a terminal state cannot go back to running');
  neg(canTransition('created', 'accepted') === false, '§6. a session cannot jump straight to accepted');
  ok(canTransition('ready', 'running') === true && canTransition('finalizing', 'refused') === true,
    '§6. and the legal transitions are permitted');
}

// =====================================================================
section('§37/§92 — no raw frame is persisted anywhere');
// =====================================================================
{
  // Run a real attempt over HTTP first so there is something to find.
  const s = await liveSession(kola.token);
  const b = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/begin`, { nonce: s.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/frames`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: goodFrames }, kola.token);
  const fin = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/finalize`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId }, kola.token);
  ok(fin.status === 200, 'a full attempt completes over HTTP');

  await sleep(400);
  const sample = goodFrames[0].data.slice(0, 48);
  let scanned = 0, hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (st.size > 64 * 1024 * 1024) continue;
      scanned += 1;
      const txt = readFileSync(full, 'latin1');
      if (txt.includes(sample)) hits.push(full);
      // A gray8 payload is long base64; anything of that shape in a store is
      // a finding regardless of whether it matches this specific frame.
      if (/"data"\s*:\s*"[A-Za-z0-9+/]{2000,}/.test(txt)) hits.push(`${full} (base64-shaped payload)`);
    }
  };
  walk(DATA_DIR);
  ok(scanned > 0, `the persistence directory was actually scanned (${scanned} files)`);
  neg(hits.length === 0, `§37/§92. no raw frame bytes appear in any persisted store (${hits.join(', ') || 'clean'})`);

  // And the canonical result itself carries no pixels.
  const resultJson = JSON.stringify(fin.body.result);
  neg(!/"data"\s*:/.test(resultJson), '§35. the canonical result contains no frame payload field');
  neg(resultJson.length < 8000, `§36. and the result is bounded (${resultJson.length} bytes)`);
}

// =====================================================================
section('§91 — identity, biometric and audio absence, swept in code');
// =====================================================================
{
  const forbidden = [
    'faceRecognition', 'faceEmbedding', 'facialRecognition', 'faceDescriptor',
    'emotion', 'affect', 'speakerId', 'voicePrint', 'transcription', 'transcribe',
    'gaitSignature', 'biometricTemplate',
  ];
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git') continue;
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.mjs')) files.push(full);
    }
  };
  walk(path.join(HERE, '..', 'm22'));
  const found = [];
  for (const f of files) {
    let txt = readFileSync(f, 'utf8');
    // The NON_CAPABILITIES map exists precisely to DECLARE these absences, so
    // scanning it finds the documentation and calls it a violation. Strip that
    // one block before scanning, then assert separately (below) that it is
    // still there — otherwise "no matches" could mean the declaration was
    // quietly deleted.
    txt = txt.replace(/export const NON_CAPABILITIES[\s\S]*?\n\}\);/, '');
    for (const word of forbidden) {
      // Identifier-like usage — a call, a property read, an assignment — not
      // the prose that documents the absence.
      const re = new RegExp(`(?:^|[^A-Za-z'"\`])${word}\\s*[(=.]|\\.${word}\\b`);
      if (re.test(txt)) found.push(`${path.basename(f)}:${word}`);
    }
  }
  neg(found.length === 0, `§91. no identity, biometric, emotion or audio symbol exists in m22 (${found.join(', ') || 'none'})`);
  ok(files.length > 10, `§91. and the sweep actually covered the module (${files.length} files)`);
  const elig = readFileSync(path.join(HERE, '..', 'm22', 'eligibility.mjs'), 'utf8');
  ok(/identity:.*[Pp]rohibited/.test(elig), '§91. the absence is documented as deliberate, not accidental');
}

// =====================================================================
section('§93 — rate limits on the expensive endpoints');
// =====================================================================
{
  // The policy is 120 per hour, so the loop has to exceed that to prove it —
  // an earlier cut stopped at 40 and "passed" only because it never reached
  // the limit, which would have asserted nothing at all.
  let limitedAt = null;
  for (let i = 0; i < 140 && limitedAt == null; i++) {
    const r = await j('POST', '/player/box-cam/cv/ready-check', { protocolId: 'combine-box-touch-60' }, kola.token);
    if (r.status === 429) limitedAt = i;
  }
  neg(limitedAt != null, `§40/§93. the Ready Check endpoint is rate-limited (429 at call ${limitedAt})`);
  ok(limitedAt == null || limitedAt >= 100, '§93. and the limit is generous enough not to punish ordinary setup retries');
  const after = await j('POST', '/player/box-cam/cv/ready-check', { protocolId: 'combine-box-touch-60' }, kola.token);
  neg(after.status !== 500, '§93. a rate-limited caller gets a clean refusal, never a server error');
}

// =====================================================================
section('§47/§48 — Ready Check separates observation from verification');
// =====================================================================
{
  const r = await j('POST', '/player/box-cam/cv/ready-check', {
    protocolId: 'combine-box-touch-60', cameraPermission: 'granted', secureContext: true,
    frameWidth: 240, frameHeight: 180, fps: 24, personDetected: true, ballDetected: true, lightingOk: true,
  }, guni.token);
  ok(r.status === 200 && Array.isArray(r.body.checks), 'Ready Check returns structured checks');
  ok(r.body.checks.every((c) => c.id && c.state), '§49. every check carries an id and a state, never a sentence');
  ok(r.body.observationReady === true, '§48. observation can be ready…');
  neg(r.body.combineVerificationAvailable === false, '§48. …while Combine verification is simultaneously unavailable');
  ok(r.body.combineDisabledReason?.code === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    '§48. and the reason is named');

  const denied = await j('POST', '/player/box-cam/cv/ready-check', {
    protocolId: 'combine-box-touch-60', cameraPermission: 'denied', secureContext: true,
    frameWidth: 240, frameHeight: 180, fps: 24,
  }, guni.token);
  neg(denied.body.observationReady === false
    && denied.body.checks.find((c) => c.id === 'camera_permission')?.reasonCode === 'CAMERA_DENIED',
    '§50. a denied camera is reported as a named check failure');
  const dark = await j('POST', '/player/box-cam/cv/ready-check', {
    protocolId: 'combine-box-touch-60', cameraPermission: 'granted', secureContext: true,
    frameWidth: 240, frameHeight: 180, fps: 4,
  }, guni.token);
  neg(dark.body.checks.find((c) => c.id === 'capture_cadence')?.reasonCode === 'FRAME_RATE_TOO_LOW',
    '§50. a too-low frame rate is a named check failure');
}

// =====================================================================
section('§58/§59 — the Combine blocker, over HTTP, end to end');
// =====================================================================
{
  const s = await liveSession(kola.token);
  const b = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/begin`, { nonce: s.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/frames`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: goodFrames }, kola.token);
  const fin = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/finalize`, { nonce: s.nonce, providerSessionId: b.body.providerSessionId }, kola.token);

  ok(fin.status === 200, 'a live CV attempt finalizes over HTTP');
  neg(fin.body.result.combineVerified === false, '§59. the canonical result says combineVerified:false');
  neg(fin.body.combine.eligible === false && fin.body.combine.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    '§59. and the Combine view names real-world validation as the blocker');
  neg(fin.body.result.experimental.status === 'experimental_unvalidated',
    '§32/§33. the exact count travels labelled experimental, never as a published measurement');

  // §58 — the M16.1 attempt path refuses the same protocol.
  const attempt = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-touch-60', provider: 'production_cv' }, kola.token);
  neg(attempt.status === 422 && attempt.body.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    '§58. a production_cv Combine attempt is refused as unvalidated');
  neg(attempt.body.observationSupported === true,
    '§58. and the refusal distinguishes "cannot observe" from "observes but may not certify"');

  // §107 — a client claiming its own count changes nothing.
  const tampered = await j('POST', `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, touchCount: 176, verifiedReps: 176, combineVerified: true }, kola.token);
  neg(tampered.body.result?.derived?.touchCount !== 176 && tampered.body.result?.combineVerified === false,
    '§107/§22. a client-submitted count and combineVerified flag are ignored entirely');
}

// =====================================================================
section('§2 — the release state, restated at the end');
// =====================================================================
{
  const caps = (await j('GET', '/capabilities')).body;
  const cv = caps.capabilities.production_cv;
  ok(cv.state === 'configured', 'the production CV provider is real and configured');
  neg(cv.realWorldValidation === 'not_completed', 'real-world validation is not completed');
  neg(cv.combineVerifiedProtocols.length === 0, 'and combineVerifiedProtocols is []');
  neg(combineVerifiedProtocols().length === 0, 'in-process, the same answer');
  for (const id of ['combine-box-touch-60', 'combine-box-juggle', 'combine-box-control-60']) {
    neg(combineEligibility(id).eligible === false, `§2. ${id} is not Combine-verified-capable`);
  }
}

// =====================================================================
section('§116–§122 — migration, clean boot, upgrade and restart');
// =====================================================================
{
  const { MIGRATIONS, SCHEMA_VERSION, runMigrations: migrate, schemaReport } = await import('../m182/migrations.mjs');

  const step = MIGRATIONS.find((m) => m.id === 'm220_001_box_cam_cv_results');
  ok(!!step, '§116. an M22 migration step exists');
  ok(SCHEMA_VERSION === 2200, `§116. the schema version moved to ${SCHEMA_VERSION}`);

  // §117 — the reuse audit, enforced rather than only written down.
  neg(!MIGRATIONS.some((m) => JSON.stringify(m.up.toString()).includes('cvFrames')),
    '§117. no migration creates a cvFrames store');
  const allUp = MIGRATIONS.map((m) => m.up.toString()).join('\n');
  neg(!/frame|pixel|video|blob/i.test(allUp.replace(/boxCamCvResults/g, '')),
    '§117. and no migration creates any frame, pixel, video or blob store');

  // §118 — a clean database gets the store from the MIGRATION, not the seed.
  {
    const fresh = {};
    migrate(fresh);
    ok(Array.isArray(fresh.boxCamCvResults),
      '§118. a clean database initialises boxCamCvResults independently of any demo seed');
    ok(fresh.schema.version === SCHEMA_VERSION, '§118. and lands on the current schema version');
    neg(fresh.cvFrames === undefined, '§118. and no frame store is created');
  }

  // §119 — an M21-era database upgrades without losing anything.
  {
    const m21db = {
      schema: { version: 2100, migrations: MIGRATIONS.filter((m) => m.id !== 'm220_001_box_cam_cv_results').map((m) => m.id) },
      boxSessions: [{ id: 'boxs-legacy', playerId: 'p' }],
      developmentPlans: [{ id: 'dp-legacy' }],
      combineAttempts: [{ id: 'catt-legacy' }],
    };
    const r = migrate(m21db);
    ok(m21db.schema.version === SCHEMA_VERSION, `§119. an M21 database upgrades 2100 → ${SCHEMA_VERSION}`);
    ok(r.ran.includes('m220_001_box_cam_cv_results'), '§119. running exactly the new step');
    ok(Array.isArray(m21db.boxCamCvResults) && m21db.boxCamCvResults.length === 0,
      '§119. the new store appears empty');
    ok(m21db.boxSessions.length === 1 && m21db.developmentPlans.length === 1 && m21db.combineAttempts.length === 1,
      '§119. and every prior record survives untouched');
  }

  // §120 — restart idempotency.
  {
    const db2 = {};
    migrate(db2);
    db2.boxCamCvResults.push({ providerSessionId: 'pcv_x', outcome: 'accepted' });
    const again = migrate(db2);
    neg(again.ran.length === 0, '§120. a second boot runs no migration step');
    ok(db2.boxCamCvResults.length === 1, '§120. and does not disturb the stored result');
    ok(schemaReport(db2).upToDate === true, '§120. the schema reports itself up to date');
  }
}

// =====================================================================
section('§121/§122 — boot mode is honest about what is built in');
// =====================================================================
{
  // The CV engine has no model file, no download and no configuration, so the
  // honest report is `configured` rather than a pretence that setup is
  // pending. §122: because it is built in, its absence cannot fail boot —
  // there is nothing to be absent. Core ScoutBox is up, which this whole
  // suite has been proving for ninety-odd checks.
  const caps = (await j('GET', '/capabilities')).body;
  ok(caps.capabilities.production_cv.state === 'configured',
    '§121. a built-in provider with no external dependency reports configured, not pending setup');
  const health = (await j('GET', '/healthz')).status;
  ok(health === 200, '§122. and the server is serving — a built-in provider cannot fail boot by being absent');
  neg(caps.capabilities.production_cv.combineVerificationAvailable === false,
    '§121. and being configured still does not make Combine verification available');
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM22 acceptance suite: ${total} checks passed, ${negatives} negative/integrity/security checks (${ratio}% of all checks)`);
if (ratio < 60) {
  console.error(`\n✗ §99 requires at least 60% negative/integrity/security coverage; this run is ${ratio}%.`);
  process.exitCode = 1;
}
console.log('production Combine eligibility: NOT ELIGIBLE — real-world validation not completed');
