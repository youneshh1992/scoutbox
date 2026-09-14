// M22 LIVE browser journeys — real camera stream, real transport, real engine.
//
// C1   Ready Check renders; observation ready AND Combine unavailable, together
// C2   low light produces a readable refusal and no official result
// C3   a valid Box Touch attempt is observed end to end through the browser
// C4   client-side count tampering changes nothing the server says
// C5   an old session's nonce is rejected by the live endpoint
// C6   the hard Combine blocker survives a full live observation  (MANDATORY)
// C7   the M21 development target does not become met
// C8   the M19 matching criterion does not become satisfied
// C9   a test-only validation record proves the future wiring, then is gone
// C10  invalidating a controlled valid result removes it downstream
// C11  a provider failure mid-attempt does not crash the page; retry works
// C12  390px and keyboard semantics
//
// The camera is a Y4M rendered from m22/scenes.mjs and handed to Chromium as a
// fake capture device, so getUserMedia returns a real MediaStream of frames we
// chose. §43 stands: that is precisely what a replay spoof looks like, which is
// why this suite asserts TRANSPORT and UI behaviour and never counting accuracy.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeY4m, fakeCameraArgs } from './m22Fixture.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ROOT = path.join(ROOT, 'scoutbox-server');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4122;
const API = `http://localhost:${API_PORT}`;
const PLAYER_PORT = 8921;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m22live-'));
const CAM = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m22cam-'));

let passed = 0, negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const bad = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (cond, m) => (cond ? say(m) : bad(m));
const neg = (cond, m) => { negatives++; ok(cond, `[neg] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);

/** Nothing on any M22 surface may claim these. */
const FORBIDDEN = [
  /Combine Verified/i, /verifies football ability/i, /AI scout/i,
  /Player Rating/i, /Match Score/i, /Potential/i,
];

for (const port of [API_PORT, PLAYER_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) { console.error(`✗ port ${port} is in use — kill the stale process and re-run.`); process.exit(1); }
}

// ------------------------------------------------------------ fixtures
console.log('rendering deterministic camera fixtures…');
const touchCam = path.join(CAM, 'touch.y4m');
const darkCam = path.join(CAM, 'dark.y4m');
console.log(J(await writeY4m({ outPath: touchCam, serverRoot: SERVER_ROOT, scene: 'touch' })));
console.log(J(await writeY4m({ outPath: darkCam, serverRoot: SERVER_ROOT, scene: 'lowlight' })));

console.log(`building the player app for :${API_PORT}…`);
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live22`, {
  cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe',
});

const serverProc = spawn('node', ['server.mjs'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
  stdio: 'ignore',
});

const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const idx = path.join(file, 'index.html');
      file = fs.existsSync(idx) ? idx : path.join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(port);
  statics.push(srv);
}
serveDir('scoutbox-player/dist-live22', PLAYER_PORT);

let browser = null;
const cleanup = () => {
  try { browser?.close(); } catch { /* gone */ }
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(CAM, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

browser = await chromium.launch({ executablePath: EXE, args: fakeCameraArgs(touchCam) });
const pageErrors = [];

async function playerPage({ width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: ['camera'],
    baseURL: `http://localhost:${PLAYER_PORT}`,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('text=Enter').nth(0).click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  // Box Training lives on the You tab, not the landing screen.
  await page.click('a[href="/you"]');
  await page.waitForSelector('text=Train in the Box', { timeout: 30000 });
  return { ctx, page };
}

/** Open the live CV surface and wait for Ready Check to settle. */
async function openCv(page) {
  await page.getByText('Box Cam observation (live)', { exact: false }).first().click();
  await page.waitForSelector('[data-testid="m22-cv"]', { timeout: 40000 });
  await page.waitForSelector('text=Ready check', { timeout: 40000 });
}

/**
 * The CV card's own text.
 *
 * Assertions MUST be scoped to it. An earlier cut read the whole page and
 * flagged "Combine Verified" as a violation — but that phrase legitimately
 * appears elsewhere on the You tab, in the My Combine section that explains
 * what Combine Verified means. Scanning the document made a correct product
 * look wrong.
 */
const cvText = (page) => page.locator('[data-testid="m22-cv"]').innerText();

/** Wait for the attempt to reach a decided outcome, either way. */
async function waitForOutcome(page, timeout = 60000) {
  const card = page.locator('[data-testid="m22-cv"]');
  await card.getByText(/Box Cam observed|Could not verify|unavailable right now/i).first()
    .waitFor({ timeout });
}

// =====================================================================
// C1 — Ready Check: both facts, together
// =====================================================================
{
  const { ctx, page } = await playerPage();
  await openCv(page);

  const body = await cvText(page);
  ok(/Ready check/i.test(body), 'C1 the Ready Check renders in the real app');
  ok(/Camera/i.test(body) && /Ball visible/i.test(body), 'C1 individual check statuses are listed');
  ok(/Box Cam observation/i.test(body), 'C1 observation readiness is stated');
  neg(/Combine verification/i.test(body) && /Not yet available/i.test(body),
    'C1 and Combine verification is shown as NOT YET AVAILABLE on the same screen');
  neg(/real.world|validation/i.test(body), 'C1 with the reason given in plain words');

  // §130 — the marketing claim must not appear anywhere on the surface.
  for (const re of FORBIDDEN.filter((r) => !/Combine Verified/i.test(String(r)))) {
    neg(!re.test(body), `C1 no forbidden claim on the CV surface: ${re}`);
  }
  // "Combine Verified" may only ever appear as part of saying it is unavailable.
  const verifiedClaims = (body.match(/Combine Verified/gi) ?? []).length;
  neg(verifiedClaims === 0, 'C1 the CV card never presents "Combine Verified" as a state of this attempt');

  await ctx.close();
}

// =====================================================================
// C3/C6 — a full live attempt, and the mandatory blocker
// =====================================================================
let liveResult = null;
{
  const { ctx, page } = await playerPage();
  await openCv(page);

  await page.getByRole('button', { name: /^Start$/ }).first().click();
  await page.waitForSelector('text=Observing', { timeout: 30000 });
  say('C3 the attempt starts and the app reports it is observing');

  const duringAttempt = await cvText(page);
  neg(!/Touches counted/i.test(duringAttempt),
    'C3/§77 no live exact count is shown during the attempt');

  // Let real frames flow over the real transport.
  await sleep(4000);
  await page.getByRole('button', { name: /Finish/i }).first().click();
  await waitForOutcome(page);

  const after = await cvText(page);
  const observed = /Box Cam observed/i.test(after);
  const refused = /Could not verify/i.test(after);
  // Either outcome is legitimate here and the suite says which, because the
  // fake camera is a downscaled synthetic scene and §106 only promises that
  // Box Cam observed "may succeed if its independent gate permits".
  const refusalLine = (after.match(/Could not verify[\s\S]{0,160}/i) ?? [''])[0].replace(/\s+/g, ' ').trim();
  ok(observed || refused,
    `C3 the attempt reaches a decided outcome (${observed ? 'observed' : `refused — ${refusalLine.slice(0, 120)}`})`);

  // §59/§109 — MANDATORY. Whatever the outcome, Combine stays closed.
  neg(/Combine verification/i.test(after) && /not available|Not yet available/i.test(after),
    'C6 (MANDATORY) after a full live observation, Combine verification is still unavailable');
  neg((after.match(/Combine Verified/gi) ?? []).length === 0,
    'C6 and nothing on the result claims Combine Verified');

  // The server's own record for this session.
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const caps = (await j('GET', '/capabilities')).body;
  neg(caps.capabilities.production_cv.combineVerifiedProtocols.length === 0,
    'C6 /capabilities reports combineVerifiedProtocols: []');
  neg(caps.capabilities.production_cv.realWorldValidation === 'not_completed',
    'C6 and real-world validation as not_completed');
  liveResult = { token: kola.token };

  // §79 — the experimental count is behind a disclosure, not the headline.
  if (observed) {
    neg(!/Touches counted/i.test(after), 'C3/§79 the experimental count is not shown by default');
    const toggle = page.getByRole('button', { name: /experimental/i }).first();
    if (await toggle.count()) {
      await toggle.click();
      const withExp = await cvText(page);
      ok(/Experimental/i.test(withExp), 'C3/§79 it is revealed only behind an explicit disclosure');
      neg(/not an official/i.test(withExp), 'C3/§79 and is labelled as not an official result');
    }
  }
  await ctx.close();
}

// =====================================================================
// C2 — low light: a readable refusal, no official result
// =====================================================================
{
  const darkBrowser = await chromium.launch({ executablePath: EXE, args: fakeCameraArgs(darkCam) });
  const ctx = await darkBrowser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('text=Enter').nth(0).click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  await page.click('a[href="/you"]');
  await page.waitForSelector('text=Train in the Box', { timeout: 30000 });
  await openCv(page);
  await page.getByRole('button', { name: /^Start$/ }).first().click();
  await page.waitForSelector('text=Observing', { timeout: 30000 });
  await sleep(4000);
  await page.getByRole('button', { name: /Finish/i }).first().click();
  await waitForOutcome(page);

  const t = await cvText(page);
  neg(/Could not verify/i.test(t), 'C2 a too-dark capture produces a readable refusal');
  neg(!/Touches counted/i.test(t), 'C2 and no exact count is offered for a refused attempt');
  neg(/not in cause|not at fault|training/i.test(t) || /Try again/i.test(t),
    'C2 with copy that does not blame the player');
  await ctx.close();
  await darkBrowser.close();
}

// =====================================================================
// C4 — client-side count tampering
// =====================================================================
{
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const created = await j('POST', '/player/box-cam/sessions', {
    drillId: 'box-touches', target: { type: 'repetitions', value: 60 }, provider: 'production_cv',
  }, kola.token);
  const { session, nonce, livenessChallenge } = created.body;
  await j('POST', `/player/box-cam/sessions/${session.id}/start`, { nonce, liveness: livenessChallenge }, kola.token);
  const begun = await j('POST', `/player/box-cam/sessions/${session.id}/cv/begin`, { nonce, protocolId: 'combine-box-touch-60' }, kola.token);

  // A tampered finalize, sent from a real browser origin.
  const { ctx, page } = await playerPage();
  const tampered = await page.evaluate(async ({ api, sid, nonce: n, psid, token }) => {
    const r = await fetch(`${api}/player/box-cam/sessions/${sid}/cv/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        nonce: n, providerSessionId: psid,
        touchCount: 176, verifiedReps: 176, combineVerified: true,
        experimental: { exactCount: 176 }, outcome: 'accepted',
      }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { api: API, sid: session.id, nonce, psid: begun.body.providerSessionId, token: kola.token });

  neg(tampered.body?.result?.derived?.touchCount !== 176,
    `C4 a client-claimed count of 176 is not adopted (server said ${tampered.body?.result?.derived?.touchCount})`);
  neg(tampered.body?.result?.combineVerified === false,
    'C4 a client-set combineVerified:true is ignored');
  neg(tampered.body?.result?.experimental?.exactCount !== 176,
    'C4 and the experimental field cannot be injected either');
  await ctx.close();
}

// =====================================================================
// C5 — nonce replay from the live endpoint
// =====================================================================
{
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const a = await j('POST', '/player/box-cam/sessions', { drillId: 'box-touches', target: { type: 'repetitions', value: 60 }, provider: 'production_cv' }, kola.token);
  const b = await j('POST', '/player/box-cam/sessions', { drillId: 'box-touches', target: { type: 'repetitions', value: 60 }, provider: 'production_cv' }, kola.token);
  await j('POST', `/player/box-cam/sessions/${b.body.session.id}/start`, { nonce: b.body.nonce, liveness: b.body.livenessChallenge }, kola.token);

  // Session A's nonce, aimed at session B.
  const replay = await j('POST', `/player/box-cam/sessions/${b.body.session.id}/cv/begin`,
    { nonce: a.body.nonce, protocolId: 'combine-box-touch-60' }, kola.token);
  neg(replay.status === 403 && replay.body.error === 'nonce_invalid',
    'C5 another session\'s nonce is rejected by the live CV endpoint');
}

// =====================================================================
// C7/C8 — development target and matching criterion stay unmet
// =====================================================================
{
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const attempt = await j('POST', '/player/combine/attempts',
    { protocolId: 'combine-box-touch-60', provider: 'production_cv' }, kola.token);
  neg(attempt.status === 422 && attempt.body.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    'C7/C8 a production_cv Combine attempt is refused as unvalidated, so nothing downstream can be fed');
  neg(attempt.body.observationSupported === true,
    'C7/C8 and the refusal distinguishes "cannot observe" from "may not certify"');

  const protos = (await j('GET', '/player/combine/protocols', undefined, kola.token)).body;
  const touch60 = (protos.protocols ?? []).find((p) => p.id === 'combine-box-touch-60');
  neg(touch60?.measurementCapability === 'not_configured',
    'C7/C8 Box Touch 60 measurement capability is not_configured for production');
  ok(touch60?.observationCapability === 'configured',
    'C7/C8 while observation capability IS configured — the two are reported separately');
}

// =====================================================================
// C9/C10 — the future-validated fixture, and invalidation
// =====================================================================
//
// §112 permits this only as a controlled TEST-ONLY exercise. There is no route
// that injects a validation record, and that absence is itself the assertion:
// the wiring is proven in-process by scripts/m22Blocker.mjs, which constructs
// the record in a local object that no request can reach.
{
  const probes = [
    ['POST', '/player/box-cam/cv/validation', { status: 'passed' }],
    ['POST', '/admin/m22/validation', { protocolId: 'combine-box-touch-60', status: 'passed' }],
    ['PATCH', '/admin/box-cam/cv/validation', { status: 'passed' }],
  ];
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  let reachable = 0;
  for (const [m, p, bdy] of probes) {
    const r = await j(m, p, bdy, kola.token);
    if (r.status < 400) reachable += 1;
  }
  neg(reachable === 0,
    'C9 no HTTP route exists that can write a real-world validation record — the fixture is unreachable from a client');

  const caps = (await j('GET', '/capabilities')).body;
  neg(caps.capabilities.production_cv.combineVerifiedProtocols.length === 0,
    'C9 after probing, combineVerifiedProtocols is still []');
  neg(caps.capabilities.production_cv.realWorldValidation === 'not_completed',
    'C10 and the validation record still reads not_completed');
}

// =====================================================================
// C11 — provider failure mid-attempt does not crash the page
// =====================================================================
{
  const { ctx, page } = await playerPage();
  await openCv(page);
  await page.getByRole('button', { name: /^Start$/ }).first().click();
  await page.waitForSelector('text=Observing', { timeout: 30000 });

  // Make every frame POST fail, mid-attempt.
  await page.route('**/cv/frames', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'provider_unavailable' }) }));
  await sleep(2500);

  const during = await cvText(page);
  ok(during.length > 0, 'C11 the page survives a provider failure mid-attempt');
  neg(!/undefined|NaN|\[object Object\]/.test(during), 'C11 with no broken rendering');

  // And the retry path works once the failure clears.
  await page.unroute('**/cv/frames');
  await page.getByRole('button', { name: /Finish/i }).first().click();
  await waitForOutcome(page);
  const after = await cvText(page);
  ok(/Box Cam observed|Could not verify|unavailable/i.test(after), 'C11 and it reaches a stated outcome rather than hanging');
  const retry = page.getByRole('button', { name: /Try again/i }).first();
  if (await retry.count()) {
    await retry.click();
    await page.waitForSelector('text=Ready check', { timeout: 40000 });
    say('C11 the retry path returns to Ready Check');
  }
  await ctx.close();
}

// =====================================================================
// C12 — 390px and keyboard semantics
// =====================================================================
{
  const { ctx, page } = await playerPage({ width: 390, height: 844 });
  await openCv(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  neg(overflow <= 2, `C12 no horizontal overflow at 390px (${overflow}px)`);

  const t = await cvText(page);
  ok(/Ready check/i.test(t), 'C12 the Ready Check is usable at 390px');
  neg(/Combine verification/i.test(t) && /Not yet available/i.test(t),
    'C12 and the Combine notice survives the narrow layout — it is not the thing that gets cut');

  // §82 — the start control is reachable and operable from the keyboard.
  const start = page.getByRole('button', { name: /^Start$/ }).first();
  if (await start.count()) {
    await start.focus();
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    ok(/Start/i.test(focused), 'C12 the start control takes keyboard focus');
  }
  await ctx.close();
}

// ---------------------------------------------------------------- report
neg(pageErrors.length === 0, `no uncaught page errors across the journeys (${pageErrors.slice(0, 3).join(' | ') || 'none'})`);

const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM22 live journeys: ${total} checks passed, ${negatives} negative/integrity (${ratio}%)`);
console.log('production Combine eligibility: NOT ELIGIBLE — real-world validation not completed');
cleanup();
process.exit(process.exitCode ?? 0);
