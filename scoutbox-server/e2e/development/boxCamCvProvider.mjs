// Production CV provider, frame transport, integration.
//
// The suite requires a minimum of 60% negative/integrity/security checks
// (enforced in the report at the end), and that ratio is not decoration. The
// whole risk surface of the provider is "a pixel endpoint that accepts
// something it should not", so the suite is weighted toward what must be
// REFUSED.
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
import { ProductionCvProvider, PROVIDER_ERRORS, canTransition } from '../../domains/development/boxcam/cv/provider.mjs';
import {
  combineVerifiedProtocols,
  combineEligibility,
  NON_CAPABILITIES,
} from '../../domains/development/boxcam/cv/eligibility.mjs';
import { decodeFrame } from '../../domains/development/boxcam/cv/frames.mjs';
import { FRAME_LIMITS, FRAME_ENCODING } from '../../domains/development/boxcam/cv/policy.mjs';
import { pickPort } from '../../scripts/testPort.mjs';
import {
  sequence,
  jugglePath,
  touchPath,
  stationaryPath,
  rollPath,
  independentBouncePath,
  DEFAULT_PERSON,
} from '../../domains/development/boxcam/cv/scenes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = pickPort(4960, 200, [0]); // never a fetch-blocked port
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m22-'));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');

let passed = 0,
  negatives = 0;
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
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
  TEST_LICENCE_REGISTRY: '1',
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

async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);

  // Do not let the spawned server hold this process open. The exit hook above
  // is the only thing that stops the server, and it runs when the event loop
  // drains — but a ref'd child handle IS something on the loop, so the suite
  // would print a green summary and then hang forever: a pass to a human
  // reading the log, a timeout to a harness.
  //
  // unref() detaches the handle from the loop without detaching the process:
  // the child still dies in the exit hook, which can then actually run.
  proc.unref();

  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return proc;
    } catch {
      /* booting */
    }
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
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data };
}

// ---------------------------------------------------------------- actors
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;

/** A live, liveness-passed Box Cam session bound to production_cv. */
async function liveSession(token, drillId = 'box-touches') {
  const created = await j(
    'POST',
    '/player/box-cam/sessions',
    {
      drillId,
      target: { type: 'repetitions', value: 20 },
      provider: 'production_cv',
    },
    token,
  );
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

const begun = await j(
  'POST',
  `/player/box-cam/sessions/${live.session.id}/cv/begin`,
  { nonce: live.nonce, protocolId: 'combine-box-touch-60' },
  kola.token,
);
ok(begun.status === 201 && begun.body.providerSessionId, 'a provider session opens');
neg(
  begun.body.combineVerifiedEligible === false,
  'and declares combineVerifiedEligible:false before a single frame is sent',
);
const PSID = begun.body.providerSessionId;
const FRAMES_URL = `/player/box-cam/sessions/${live.session.id}/cv/frames`;

//  1. anonymous frame
{
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) });
  neg(r.status === 401 || r.status === 403, '1. an unauthenticated frame is rejected');
}
//  2. foreign user session
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) },
    guni.token,
  );
  neg(r.status === 404, '2. another player cannot submit frames to this session');
}
//  3. foreign Box Cam session
{
  const other = await liveSession(guni.token);
  const r = await j(
    'POST',
    `/player/box-cam/sessions/${other.session.id}/cv/frames`,
    { nonce: other.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) },
    guni.token,
  );
  neg(r.status === 404, '3. a provider session cannot be attached to a different Box Cam session');
}
//  4. wrong provider session
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: 'pcv_not_a_real_session', frames: goodFrames.slice(0, 1) },
    kola.token,
  );
  neg(r.status === 404, '4. an unknown provider session id is not found');
}
//  5. old nonce (a previous session's)
{
  const stale = await liveSession(kola.token);
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: stale.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1) },
    kola.token,
  );
  neg(r.status === 403 && r.body.error === PROVIDER_ERRORS.NONCE_INVALID, "5. another session's nonce is rejected");
}
//  6. wrong nonce
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: 'not-the-nonce', providerSessionId: PSID, frames: goodFrames.slice(0, 1) },
    kola.token,
  );
  neg(r.status === 403 && r.body.error === PROVIDER_ERRORS.NONCE_INVALID, '6. a forged nonce is rejected');
}
// Establish a legitimate high-water mark for the ordering cases.
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 4) },
    kola.token,
  );
  ok(r.status === 200 && r.body.accepted === 4, 'four legitimate frames are accepted');
}
//  7. duplicate sequence
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[2]] },
    kola.token,
  );
  neg(
    r.status === 409 && r.body.error === PROVIDER_ERRORS.DUPLICATE_FRAME,
    '7. a duplicate sequence is refused, never double-processed',
  );
}
//  8. out-of-order beyond the window
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 1 }] },
    kola.token,
  );
  neg(r.status === 409, '8. an out-of-order frame beyond the reorder window is refused');
}
//  9. oversized frame
{
  const big = {
    ...goodFrames[0],
    seq: 900,
    w: FRAME_LIMITS.maxWidth,
    h: FRAME_LIMITS.maxHeight,
    data: goodFrames[0].data,
  };
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [big] }, kola.token);
  neg(r.status >= 400, '9. a frame whose declared size does not match its payload is refused');
}
// 10. unsupported dimensions
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 901, w: 4000, h: 3000 }] },
    kola.token,
  );
  neg(
    r.status === 422 && r.body.error === PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS,
    '10. unsupported dimensions are refused by name',
  );
}
// 11. malformed payload
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ seq: 902 }] },
    kola.token,
  );
  neg(r.status >= 400 && r.status < 500, '11. a malformed frame envelope is refused without a server error');
}
// 12. unsupported encoding — the "is this a file upload" case
{
  const jpeg = { seq: 903, encoding: 'image/jpeg', w: 160, h: 120, data: 'iVBORw0KGgoAAAANSUhEUg==' };
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: [jpeg] }, kola.token);
  neg(
    r.status === 415 && r.body.error === PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT,
    '12. a JPEG is refused by name — this endpoint is not a file upload',
  );
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
  const many = Array.from({ length: FRAME_LIMITS.maxFramesPerBatch + 5 }, (_, i) => ({
    ...goodFrames[0],
    seq: 1000 + i,
  }));
  const r = await j('POST', FRAMES_URL, { nonce: live.nonce, providerSessionId: PSID, frames: many }, kola.token);
  neg(
    r.status === 429 && r.body.error === PROVIDER_ERRORS.QUEUE_OVERFLOW,
    `13/14. a batch above ${FRAME_LIMITS.maxFramesPerBatch} frames is refused rather than queued`,
  );
}
// 15b. §22/§A4 — a measurement the server derives is refused by name, on a batch or inside a frame
{
  const onBatch = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: goodFrames.slice(0, 1), repCount: 60 },
    kola.token,
  );
  neg(
    onBatch.status === 422 &&
      onBatch.body.error === PROVIDER_ERRORS.CLIENT_FIELD_REFUSED &&
      onBatch.body.fields?.includes('repCount'),
    '15b. a batch carrying its own rep count is refused with a 422 that names the field',
  );
  const inFrame = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 4000, verified: true }] },
    kola.token,
  );
  neg(
    inFrame.status === 422 && inFrame.body.fields?.includes('verified'),
    '15b. so is a frame envelope that claims to be verified',
  );
  for (const [route, body] of [
    ['cv/begin', { nonce: live.nonce, protocolId: 'combine-box-touch-60', confidence: 1 }],
    ['cv/cancel', { nonce: live.nonce, providerSessionId: PSID, accepted: true }],
  ]) {
    const r = await j('POST', `/player/box-cam/sessions/${live.session.id}/${route}`, body, kola.token);
    neg(
      r.status === 422 && r.body.error === PROVIDER_ERRORS.CLIENT_FIELD_REFUSED,
      `15b. ${route} refuses a derived field too, before touching the session`,
    );
  }
  const ready = await j(
    'POST',
    '/player/box-cam/cv/ready-check',
    { cameraPermission: 'granted', score: 99 },
    kola.token,
  );
  neg(ready.status === 422 && ready.body.fields?.includes('score'), '15b. and so does the Ready Check');
  // Each field as sent, or refused under the provider's codes.
  const textWidth = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 4001, w: '160' }] },
    kola.token,
  );
  neg(
    textWidth.status === 422 &&
      textWidth.body.error === PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS &&
      textWidth.body.field === 'frames[0].w',
    'IN1 a frame width written as text is refused, not read as a number',
  );
  const extra = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 4002, label: 'x' }] },
    kola.token,
  );
  neg(
    extra.status === 415 && extra.body.field === 'frames[0].label' && extra.body.problem === 'unknown_field',
    'IN2 a frame envelope carries only the frame',
  );
  const textWindow = await j(
    'POST',
    `/player/box-cam/sessions/${live.session.id}/cv/finalize`,
    { nonce: live.nonce, providerSessionId: PSID, protocolWindowMs: '60000' },
    kola.token,
  );
  neg(
    textWindow.status === 400 && textWindow.body.field === 'protocolWindowMs',
    'IN3 a protocol window written as text is refused, not read as a number',
  );
  const textFps = await j(
    'POST',
    '/player/box-cam/cv/ready-check',
    { cameraPermission: 'granted', fps: '30' },
    kola.token,
  );
  neg(
    textFps.status === 400 && textFps.body.field === 'fps',
    'IN4 a Ready Check frame rate written as text is refused',
  );
}
// 16. finalized session ingest
{
  const fin = await j(
    'POST',
    `/player/box-cam/sessions/${live.session.id}/cv/finalize`,
    { nonce: live.nonce, providerSessionId: PSID },
    kola.token,
  );
  ok(fin.status === 200, 'the session finalizes');
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [{ ...goodFrames[0], seq: 5000 }] },
    kola.token,
  );
  neg(r.status === 404 || r.status === 409, '16. a finalized session accepts no further frames');
}
// 7b. §7 — finalize is single-shot and returns the SAME result
{
  const a = await j(
    'POST',
    `/player/box-cam/sessions/${live.session.id}/cv/finalize`,
    { nonce: live.nonce, providerSessionId: PSID },
    kola.token,
  );
  neg(
    a.status === 200 && a.body.alreadyFinalized === true,
    '7b. a second finalize returns the stored result and mints nothing new',
  );
}
// 17. cancelled session ingest
{
  const s = await liveSession(kola.token);
  const b = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/begin`,
    { nonce: s.nonce, protocolId: 'combine-box-touch-60' },
    kola.token,
  );
  await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/cancel`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId },
    kola.token,
  );
  const r = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/frames`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: [goodFrames[0]] },
    kola.token,
  );
  neg(r.status === 404, '17. a cancelled session accepts no frames');
  const f = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId },
    kola.token,
  );
  neg(f.status >= 400 || f.body?.result == null, '17b. and a cancelled attempt mints no result');
}
// 18. reused old session id / 15. expired session
{
  const r = await j(
    'POST',
    FRAMES_URL,
    { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[0]] },
    kola.token,
  );
  neg(r.status === 404, '18. a released provider session id cannot be resurrected');
}
// 19. cross-player session / 20. cross-org leak
{
  const s = await liveSession(guni.token);
  const r = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/begin`,
    { nonce: s.nonce, protocolId: 'combine-box-touch-60' },
    kola.token,
  );
  neg(r.status === 404, "19. one player cannot open a provider session on another player's Box Cam session");
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const leak = await j(
    'POST',
    `/player/box-cam/sessions/${live.session.id}/cv/frames`,
    { nonce: live.nonce, providerSessionId: PSID, frames: [goodFrames[0]] },
    maria.token,
  );
  neg(
    leak.status === 401 || leak.status === 403 || leak.status === 404,
    "20. an organisation token cannot reach a player's frame endpoint",
  );
}
// §57 — unsupported protocol, no fallback
{
  const s = await liveSession(kola.token);
  const r = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/begin`,
    { nonce: s.nonce, protocolId: 'combine-agility-5-10-5' },
    kola.token,
  );
  neg(
    r.status === 422 && r.body.error === PROVIDER_ERRORS.UNSUPPORTED_PROTOCOL,
    '§57. an unsupported protocol is named, never approximated by a fallback',
  );
}
// §42 — liveness is required before a provider session opens
{
  const c = await j(
    'POST',
    '/player/box-cam/sessions',
    {
      drillId: 'box-touches',
      target: { type: 'repetitions', value: 20 },
      provider: 'production_cv',
    },
    kola.token,
  );
  const r = await j(
    'POST',
    `/player/box-cam/sessions/${c.body.session.id}/cv/begin`,
    { nonce: c.body.nonce, protocolId: 'combine-box-touch-60' },
    kola.token,
  );
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
  [
    'camera zoom pulse over a fixed relationship',
    { path: stationaryPath({ x: 0.567, y: 0.83 }), cameraScale: (t) => (Math.abs(t - 1200) < 200 ? 1.2 : 1) },
  ],
  ['step zoom held', { path: stationaryPath({ x: 0.567, y: 0.83 }), cameraScale: (t) => (t < 1200 ? 1 : 1.35) }],
  ['no ball present', { path: () => null }],
  [
    'no person present',
    { path: jugglePath({ contacts: 6 }), person: { x0: 0, y0: 0, x1: 0.001, y1: 0.001, luma: 130 } },
  ],
  [
    'multiple people',
    {
      path: stationaryPath({ x: 0.84, y: 0.88 }),
      extraPeople: (t) => [{ x0: 0.05 + 0.00012 * t, y0: 0.38, x1: 0.16 + 0.00012 * t, y1: 0.93, luma: 62 }],
    },
  ],
  [
    'multiple balls',
    {
      path: stationaryPath({ x: 0.1, y: 0.86 }),
      extraBalls: () => [{ x: 0.7, y: 0.86, rN: 0.031, luma: 238, blur: 0 }],
    },
  ],
  ['low light', { path: jugglePath({ contacts: 6 }), bgLuma: 12, ballLuma: 30 }],
  ['frozen sequence', { path: stationaryPath({ x: 0.567, y: 0.83 }), noise: 0 }],
  ['prolonged proximity', { path: stationaryPath({ x: 0.545, y: 0.91 }), durationMs: 6000 }],
  ['independent bounce away from the player', { path: independentBouncePath({ x: 0.15 }) }],
  ['ball rolling past, no contact', { path: rollPath({ x0: 0.05, x1: 0.95, y: 0.9, durationMs: 3000 }) }],
  [
    'tracking jitter',
    {
      path: (t) => ({ x: 0.567 + 0.004 * Math.sin(t / 60), y: 0.83 + 0.004 * Math.cos(t / 55) }),
      personAt: (t) => ({ ...P, x0: P.x0 + 0.004 * Math.sin(t / 61), x1: P.x1 + 0.004 * Math.sin(t / 61) }),
    },
  ],
];

let providerFalseTouches = 0;
for (const [label, opts] of adversarial) {
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({
    boxCamSessionId: `adv-${label}`,
    playerId: 'p',
    protocolId: 'combine-box-touch-60',
    nonce: 'n',
  });
  const raw = sequence({ w: 200, h: 150, fps: 15, durationMs: 3000, seed: 61, ...opts });
  let n = 0;
  for (const f of raw) {
    const d = decodeFrame(f);
    if (!d.ok) continue;
    n += 1;
    prov.ingestFrame({
      providerSessionId: b.providerSessionId,
      boxCamSessionId: `adv-${label}`,
      nonce: 'n',
      seq: n,
      frame: d.frame,
    });
  }
  const fin = prov.finalize({ providerSessionId: b.providerSessionId });
  const count = fin.ok ? (fin.result.derived.touchCount ?? 0) : 0;
  if (count > 0) providerFalseTouches += count;
  neg(
    count === 0,
    `§86. "${label}" produces no touch through the provider (${fin.ok ? fin.result.outcome : 'failed'})`,
  );
  neg(!fin.ok || fin.result.combineVerified === false, `      …and combineVerified stays false`);
  prov.disposeAll();
}
ok(providerFalseTouches === 0, '§86. the provider layer weakens nothing — zero false touches across the catalogue');

// =====================================================================
section('§87–§90 — provider crash, engine exception, overflow, restart');
// =====================================================================
{
  // §88 — an engine that throws fails the session safely and leaks no stack.
  const prov = new ProductionCvProvider({
    processFrame: () => {
      throw new Error('/srv/secret/path.mjs exploded');
    },
  });
  const b = prov.beginSession({
    boxCamSessionId: 'crash',
    playerId: 'p',
    protocolId: 'combine-box-touch-60',
    nonce: 'n',
  });
  const d = decodeFrame(goodFrames[0]);
  const r = prov.ingestFrame({
    providerSessionId: b.providerSessionId,
    boxCamSessionId: 'crash',
    nonce: 'n',
    seq: 1,
    frame: d.frame,
  });
  neg(
    r.ok === false && r.error === PROVIDER_ERRORS.ENGINE_FAILURE,
    '§88. an engine exception fails the session with a typed error',
  );
  neg(!JSON.stringify(r).includes('/srv/secret/path.mjs'), '§88. and no file path or stack reaches the caller');
  const fin = prov.finalize({ providerSessionId: b.providerSessionId });
  neg(fin.ok === false, '§87. no result is minted from a failed session');
  neg(prov.footprint().activeSessions === 0, '§87. and its resources are released');
  prov.disposeAll();
}
{
  // §89 — queue overflow is accounted for, not hidden.
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({
    boxCamSessionId: 'flood',
    playerId: 'p',
    protocolId: 'combine-box-touch-60',
    nonce: 'n',
  });
  const d = decodeFrame(goodFrames[0]);
  const ing = prov.ingestFrame({
    providerSessionId: b.providerSessionId,
    boxCamSessionId: 'flood',
    nonce: 'n',
    seq: 1,
    frame: d.frame,
  });
  ok(
    ing.ok === true && typeof ing.droppedByServer === 'number',
    '§89/§23. every ingest reports server-side drops so they can feed observation quality',
  );
  prov.disposeAll();
}
{
  // §6 — invalid transitions fail closed.
  neg(canTransition('accepted', 'running') === false, '§6. a terminal state cannot go back to running');
  neg(canTransition('created', 'accepted') === false, '§6. a session cannot jump straight to accepted');
  ok(
    canTransition('ready', 'running') === true && canTransition('finalizing', 'refused') === true,
    '§6. and the legal transitions are permitted',
  );
}

// =====================================================================
section('§37/§92 — no raw frame is persisted anywhere');
// =====================================================================
{
  // Run a real attempt over HTTP first so there is something to find.
  const s = await liveSession(kola.token);
  const b = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/begin`,
    { nonce: s.nonce, protocolId: 'combine-box-touch-60' },
    kola.token,
  );
  await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/frames`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: goodFrames },
    kola.token,
  );
  const fin = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId },
    kola.token,
  );
  ok(fin.status === 200, 'a full attempt completes over HTTP');

  await sleep(400);
  const sample = goodFrames[0].data.slice(0, 48);
  let scanned = 0,
    hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
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
  // Nothing the engine returns identifies a face, a body, a voice or a gait, or infers a feeling.
  const biometric = [
    'face',
    'embedding',
    'descriptor',
    'emotion',
    'affect',
    'speaker',
    'voice',
    'transcri',
    'gait',
    'biometric',
    'audio',
  ].filter((w) => new RegExp(`"[^"]*${w}[^"]*"\\s*:`, 'i').test(resultJson));
  neg(
    biometric.length === 0,
    `§91. the canonical result has no identity, biometric, emotion or audio field (${biometric.join(', ') || 'none'})`,
  );
  neg(!/"data"\s*:/.test(resultJson), '§35. the canonical result contains no frame payload field');
  neg(resultJson.length < 8000, `§36. and the result is bounded (${resultJson.length} bytes)`);
}

// =====================================================================
section('§91 — identity, biometric and audio absence, declared');
// =====================================================================
{
  neg(
    /prohibited/i.test(NON_CAPABILITIES.identity) && !!NON_CAPABILITIES.emotion && !!NON_CAPABILITIES.audio,
    '§91. identity, emotion and audio are declared as things the engine does not do: prohibited, not merely absent',
  );
}

// =====================================================================
section('§93 — rate limits on the expensive endpoints');
// =====================================================================
{
  // The policy is 120 per hour, so the loop has to exceed that to prove it:
  // a loop that never reaches the limit asserts nothing at all.
  let limitedAt = null;
  for (let i = 0; i < 140 && limitedAt == null; i++) {
    const r = await j('POST', '/player/box-cam/cv/ready-check', { protocolId: 'combine-box-touch-60' }, kola.token);
    if (r.status === 429) limitedAt = i;
  }
  neg(limitedAt != null, `§40/§93. the Ready Check endpoint is rate-limited (429 at call ${limitedAt})`);
  ok(
    limitedAt == null || limitedAt >= 100,
    '§93. and the limit is generous enough not to punish ordinary setup retries',
  );
  const after = await j('POST', '/player/box-cam/cv/ready-check', { protocolId: 'combine-box-touch-60' }, kola.token);
  neg(after.status !== 500, '§93. a rate-limited caller gets a clean refusal, never a server error');
}

// =====================================================================
section('§47/§48 — Ready Check separates observation from verification');
// =====================================================================
{
  const r = await j(
    'POST',
    '/player/box-cam/cv/ready-check',
    {
      protocolId: 'combine-box-touch-60',
      cameraPermission: 'granted',
      secureContext: true,
      frameWidth: 240,
      frameHeight: 180,
      fps: 24,
      personDetected: true,
      ballDetected: true,
      lightingOk: true,
    },
    guni.token,
  );
  ok(r.status === 200 && Array.isArray(r.body.checks), 'Ready Check returns structured checks');
  ok(
    r.body.checks.every((c) => c.id && c.state),
    '§49. every check carries an id and a state, never a sentence',
  );
  ok(r.body.observationReady === true, '§48. observation can be ready…');
  neg(r.body.combineVerificationAvailable === false, '§48. …while Combine verification is simultaneously unavailable');
  ok(r.body.combineDisabledReason?.code === 'REAL_WORLD_VALIDATION_NOT_COMPLETED', '§48. and the reason is named');

  const denied = await j(
    'POST',
    '/player/box-cam/cv/ready-check',
    {
      protocolId: 'combine-box-touch-60',
      cameraPermission: 'denied',
      secureContext: true,
      frameWidth: 240,
      frameHeight: 180,
      fps: 24,
    },
    guni.token,
  );
  neg(
    denied.body.observationReady === false &&
      denied.body.checks.find((c) => c.id === 'camera_permission')?.reasonCode === 'CAMERA_DENIED',
    '§50. a denied camera is reported as a named check failure',
  );
  const dark = await j(
    'POST',
    '/player/box-cam/cv/ready-check',
    {
      protocolId: 'combine-box-touch-60',
      cameraPermission: 'granted',
      secureContext: true,
      frameWidth: 240,
      frameHeight: 180,
      fps: 4,
    },
    guni.token,
  );
  neg(
    dark.body.checks.find((c) => c.id === 'capture_cadence')?.reasonCode === 'FRAME_RATE_TOO_LOW',
    '§50. a too-low frame rate is a named check failure',
  );
}

// =====================================================================
section('§58/§59 — the Combine blocker, over HTTP, end to end');
// =====================================================================
{
  const s = await liveSession(kola.token);
  const b = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/begin`,
    { nonce: s.nonce, protocolId: 'combine-box-touch-60' },
    kola.token,
  );
  await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/frames`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, frames: goodFrames },
    kola.token,
  );
  const fin = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId },
    kola.token,
  );

  ok(fin.status === 200, 'a live CV attempt finalizes over HTTP');
  neg(fin.body.result.combineVerified === false, '§59. the canonical result says combineVerified:false');
  neg(
    fin.body.combine.eligible === false && fin.body.combine.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    '§59. and the Combine view names real-world validation as the blocker',
  );
  neg(
    fin.body.result.experimental.status === 'experimental_unvalidated',
    '§32/§33. the exact count travels labelled experimental, never as a published measurement',
  );

  // §58 — the Combine attempt path refuses the same protocol.
  const attempt = await j(
    'POST',
    '/player/combine/attempts',
    { protocolId: 'combine-box-touch-60', provider: 'production_cv' },
    kola.token,
  );
  neg(
    attempt.status === 422 && attempt.body.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    '§58. a production_cv Combine attempt is refused as unvalidated',
  );
  neg(
    attempt.body.observationSupported === true,
    '§58. and the refusal distinguishes "cannot observe" from "observes but may not certify"',
  );

  // §107 — a client claiming its own count changes nothing: the claim is
  // refused by name (§22/§A4), and the stored result is the server's.
  const tampered = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId, verifiedReps: 176, combineVerified: true },
    kola.token,
  );
  neg(
    tampered.status === 422 &&
      tampered.body.error === PROVIDER_ERRORS.CLIENT_FIELD_REFUSED &&
      ['verifiedReps', 'combineVerified'].every((f) => tampered.body.fields.includes(f)),
    '§107/§22. a client-submitted count and combineVerified flag are refused by name',
  );
  const stored = await j(
    'POST',
    `/player/box-cam/sessions/${s.session.id}/cv/finalize`,
    { nonce: s.nonce, providerSessionId: b.body.providerSessionId },
    kola.token,
  );
  neg(
    stored.body.result?.derived?.touchCount !== 176 && stored.body.result?.combineVerified === false,
    '§107/§22. and the stored result carries none of them',
  );
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
  const { DATA_MIGRATIONS } = await import('../../repositories/index.mjs');
  const { BOX_CAM_MIGRATION } = await import('../../repositories/boxCam.mjs');
  const { openLayer } = await import('../../scripts/dataLayerFixture.mjs');
  const SCHEMA_VERSION = Number(
    DATA_MIGRATIONS.map((m) => m.id)
      .sort()
      .at(-1)
      .slice(0, 4),
  );

  ok(
    DATA_MIGRATIONS.filter((m) => m.id === BOX_CAM_MIGRATION).length === 1,
    `§116. the Box Cam migration (${BOX_CAM_MIGRATION}) is registered once`,
  );
  ok(SCHEMA_VERSION >= 31, `§116. the schema is at or beyond 0031 (now ${SCHEMA_VERSION})`);

  // §117/§118: the CV results are a typed table, created by data migration 0031 and owned by
  // repositories/boxCam.mjs — with no frame, pixel or video column — asserted on a real store.
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m22-table-'));
  {
    const store = openLayer(freshDir);
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    neg(
      !tables.some((t) => /frame|pixel/.test(t)),
      '§117. no migration creates a frame or pixel table (cvFrames does not exist)',
    );
    neg(!tables.includes('collections'), '§117. and there is no blob store to hide one in');
    const cols = store.sqlite
      .prepare('PRAGMA table_info(box_cam_cv_results)')
      .all()
      .map((c) => c.name);
    ok(
      cols.includes('provider_session_id') && cols.includes('session_id'),
      '§118. the results table exists on a fresh store, created by migration 0031',
    );
    neg(
      !cols.some((c) => /frame_bytes|pixel|video|blob|base64/.test(c)),
      '§118. and no column of it holds a frame, pixel, video or blob',
    );
    ok(store.sqlite.prepare('SELECT count(*) AS n FROM box_cam_cv_results').get().n === 0, '§118. and it starts empty');
    store.sqlite.close();
  }

  // §120 — restart idempotency.
  {
    const recorded = () => {
      const st = openLayer(freshDir);
      try {
        return st.sqlite
          .prepare('SELECT id, applied_at FROM data_migrations ORDER BY id')
          .all()
          .map((r) => `${r.id}@${r.applied_at}`)
          .join();
      } finally {
        st.sqlite.close();
      }
    };
    const first = recorded();
    neg(
      recorded() === first && first.split(',').length === DATA_MIGRATIONS.length,
      '§120. a second open runs no migration step',
    );
    const caps = (await j('GET', '/capabilities')).body;
    ok(
      caps.schema?.upToDate === true && caps.schema.version === SCHEMA_VERSION,
      '§120. the running server reports its schema up to date',
    );
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
  ok(
    caps.capabilities.production_cv.state === 'configured',
    '§121. a built-in provider with no external dependency reports configured, not pending setup',
  );
  const health = (await j('GET', '/healthz')).status;
  ok(health === 200, '§122. and the server is serving — a built-in provider cannot fail boot by being absent');
  neg(
    caps.capabilities.production_cv.combineVerificationAvailable === false,
    '§121. and being configured still does not make Combine verification available',
  );
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(
  `\ndevelopment/boxCamCvProvider: ${total} checks passed, ${negatives} negative/integrity/security checks (${ratio}% of all checks)`,
);
if (ratio < 60) {
  console.error(`\n✗ §99 requires at least 60% negative/integrity/security coverage; this run is ${ratio}%.`);
  process.exitCode = 1;
}
console.log('production Combine eligibility: NOT ELIGIBLE — real-world validation not completed');
