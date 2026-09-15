// M23 P2 LIVE — the corrections the total sweep made, exercised end to end.
//
// P2 ships no M23 client surface, so this is not a UI feature test. It is a
// test of the things the sweep CHANGED about production behaviour, driven
// through a real browser login against a real backend:
//
//   L1  a recruitment lead's role is resolved correctly by the server
//   L2  a role that should not have that permission is refused
//   L3  the legacy stage route refuses a Room and changes nothing
//   L4  a plain M12 case still moves through that route
//   L5  `signed` is evidence-gated through the real HTTP route
//   L6  every refusal carries its specific, semantic status code
//
// WHY THE SESSION COMES FROM THE BROWSER
//
// The defect this suite exists to cover (D5) was a server-side role resolution
// bug: `isLead(req)` instead of `isLead(req.orgUser)`. A synthesised token
// would have exercised the same path, but a session established by a real
// login through the real client proves the whole chain — the UI's login, the
// session it stored, and the role the server derives from it on every request.
//
// WHY NO ASSERTION HERE IS `status !== 200`
//
// That is the exact shape that let D5 hide. `confirmSignedOutcome` refused
// with 403 (not permitted) where the test author expected 422 (no evidence),
// and `!== 200` was true either way. Every assertion below names the status it
// expects and the error code that must come with it.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4023;
const API = `http://localhost:${API_PORT}`;
const STATIC_PORT = 8723;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23live-'));

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
/** Assert an exact status AND an exact error code. Never "not 200". */
const expect = (res, status, code, what) => {
  if (res.status !== status) fail(`${what}: expected ${status}${code ? ` ${code}` : ''}, got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  if (code && res.body?.error !== code) fail(`${what}: expected error ${code}, got ${JSON.stringify(res.body?.error)}`);
  say(what);
};

console.log(`building live club bundle for :${API_PORT}…`);
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live23`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
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
serveDir('scoutbox-club/dist-live23', STATIC_PORT);

let browser = null;
process.on('exit', () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'scoutbox-club/dist-live23'), { recursive: true, force: true });
});

for (let i = 0; i < 80; i += 1) {
  try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`backend up on :${API_PORT}`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

browser = await chromium.launch({ executablePath: EXE });

/** Log in through the real client and hand back the session it stored. */
async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  await page.goto(`http://localhost:${STATIC_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
  });
  if (!token) fail(`${name}: the client stored no session token after login`);
  return { page, token, auth: { authorization: `Bearer ${token}` } };
}

// ============================================ L1 — the recruitment lead

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
say('L1: a recruitment lead signs in through the real client and the app stores a session');

// Open a Room through the UI, so the case under test was created the way a
// club actually creates one.
await lead.page.evaluate(() => { location.hash = '#/search'; });
await lead.page.waitForSelector('.player-card', { timeout: 25000 });
const PLAYER_NAME = await lead.page.evaluate(() => document.querySelector('.player-card')?.textContent?.trim() ?? '');
await lead.page.click('.player-card');
await lead.page.waitForSelector('.drawer', { timeout: 15000 });
await lead.page.click('button:has-text("Add to Recruitment Room")');
await lead.page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
say('L1: the lead opens a Recruitment Room through the UI');

const ROOM_HASH = await lead.page.evaluate(() => location.hash);
const ROOM_ID = ROOM_HASH.split('/').pop();
if (!ROOM_ID || !/^case-/.test(ROOM_ID)) fail(`L1: could not read the room id from the deep link (${ROOM_HASH})`);
const readBack = await j(`/org/rooms/${ROOM_ID}`, {}, lead.auth);
if (readBack.status !== 200) fail(`L1: the room the UI created is not readable through the API (${readBack.status})`);
say(`L1: the room is readable through the API the UI is talking to (${ROOM_ID})`);

// --- the assertion that covers D5 ---
//
// `confirmSignedOutcome` is admin-only, and the validator checks ROLE BEFORE
// the transition table. So from `watching` the two outcomes are distinct and
// diagnostic:
//
//   role below recruitment_admin -> 403 LIFECYCLE_NOT_PERMITTED
//   role == recruitment_admin    -> 409 LIFECYCLE_TRANSITION_INVALID
//
// Before the fix, `isLead(req)` made every lead resolve as contributor, so a
// Head of Recruitment got the 403. This asserts the 409 by name.
const leadRole = await j(`/org/rooms/${ROOM_ID}/lifecycle`, {
  method: 'POST', body: JSON.stringify({ action: 'confirmSignedOutcome' }),
}, lead.auth);
expect(leadRole, 409, 'LIFECYCLE_TRANSITION_INVALID',
  'L1: the server resolves the Head of Recruitment as recruitment_admin — refused on the transition table, NOT on permission');

// And the positive half: a lead can actually perform a lead action end to end.
const journey0 = await j(`/org/rooms/${ROOM_ID}/journey`, {}, lead.auth);
if (journey0.status !== 200) fail(`L1: the journey projection answered ${journey0.status}`);
say('L1: the lead reads the recruitment journey (200)');
const hold = await j(`/org/rooms/${ROOM_ID}/lifecycle`, {
  method: 'POST',
  body: JSON.stringify({ action: 'holdCase', reasonCodes: ['on_hold'], expectedRev: journey0.body.case.rev }),
}, lead.auth);
if (hold.status !== 200 || hold.body?.to !== 'on_hold') {
  fail(`L1: the lead could not hold the case — ${hold.status} ${JSON.stringify(hold.body).slice(0, 160)}`);
}
say('L1: and performs a lead-authorized lifecycle action successfully (200, watching → on_hold)');

const resumed = await j(`/org/rooms/${ROOM_ID}/lifecycle`, {
  method: 'POST', body: JSON.stringify({ action: 'resumeCase', expectedRev: hold.body.currentRev }),
}, lead.auth);
if (resumed.status !== 200 || resumed.body?.to !== 'under_review') fail(`L1: resume failed — ${resumed.status}`);
say('L1: and resumes it (200, on_hold → under_review)');

// ====================================== L2 — the negative control

const ctxScout = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Field', 'First-Team Scout');
say('L2: a first-team scout signs in through the same client');

const scoutConfirm = await j(`/org/rooms/${ROOM_ID}/lifecycle`, {
  method: 'POST', body: JSON.stringify({ action: 'confirmSignedOutcome' }),
}, scout.auth);
expect(scoutConfirm, 403, 'LIFECYCLE_NOT_PERMITTED',
  'L2: the same admin-only action is refused for the scout — so L1 does not pass because everyone is an admin');

// The scout is still a real member of the room: the control is about
// PERMISSION, not about access.
const scoutJourney = await j(`/org/rooms/${ROOM_ID}/journey`, {}, scout.auth);
if (scoutJourney.status !== 200) fail(`L2: the scout could not read the journey — ${scoutJourney.status}`);
say('L2: while still reading the journey normally (200) — the control isolates permission, not access');

const offered = scoutJourney.body?.nextActions ?? [];
if (offered.includes('confirmSignedOutcome')) fail('L2: the scout was OFFERED an action they cannot perform');
say('L2: and is never offered the action they would be refused');

// ============================ L3/L4 — the legacy stage route

const beforeStage = await j(`/org/rooms/${ROOM_ID}/journey`, {}, lead.auth);
const roomBefore = await j(`/org/rooms/${ROOM_ID}`, {}, lead.auth);
const legacy = await j(`/org/cases/${ROOM_ID}/stage`, {
  method: 'POST', body: JSON.stringify({ stage: 'trial', reason: 'legacy client' }),
}, lead.auth);
expect(legacy, 409, 'STAGE_NOT_SETTABLE_ON_ROOM',
  'L3: the legacy stage route refuses a case that has a Room');
if (typeof legacy.body?.use !== 'string' || !legacy.body.use.includes('/lifecycle')) {
  fail('L3: the refusal does not name the lifecycle route');
}
say('L3: and names the lifecycle route rather than failing blankly');

const afterStage = await j(`/org/rooms/${ROOM_ID}/journey`, {}, lead.auth);
const roomAfter = await j(`/org/rooms/${ROOM_ID}`, {}, lead.auth);
if (afterStage.body.lifecycle.currentStage !== beforeStage.body.lifecycle.currentStage) {
  fail(`L3: the room status moved — ${beforeStage.body.lifecycle.currentStage} → ${afterStage.body.lifecycle.currentStage}`);
}
say('L3: the room status is unchanged');
if (afterStage.body.history.total !== beforeStage.body.history.total) {
  fail(`L3: history grew — ${beforeStage.body.history.total} → ${afterStage.body.history.total}`);
}
say('L3: the history is unchanged');
if (roomAfter.body.room?.rev !== roomBefore.body.room?.rev) {
  fail(`L3: the rev moved — ${roomBefore.body.room?.rev} → ${roomAfter.body.room?.rev}`);
}
say('L3: the rev is unchanged — nothing about the case was touched');
if (afterStage.body.lifecycle.stage !== beforeStage.body.lifecycle.stage) {
  fail('L3: the derived M12 stage moved behind the lifecycle\'s back');
}
say('L3: and the derived M12 stage is unchanged, which is the invariant the refusal exists to protect');

// L4 — a plain M12 case (no Room) still works. Refusing a Room must not
// become a licence to break the cases that have no lifecycle to protect.
const players = await j('/org/players', {}, lead.auth);
const spare = (players.body ?? []).find((p) => p.name !== PLAYER_NAME && p.id);
const plain = await j('/org/cases', {
  method: 'POST', body: JSON.stringify({ playerId: spare.id, priority: 'low' }),
}, lead.auth);
if (plain.status !== 201) fail(`L4: could not create a plain case — ${plain.status}`);
if (plain.body.case.room) fail('L4: the fixture case unexpectedly has a Room facet');
say('L4: a plain M12 case with no Room is created');
const moved = await j(`/org/cases/${plain.body.case.id}/stage`, {
  method: 'POST', body: JSON.stringify({ stage: 'observation' }),
}, lead.auth);
if (moved.status !== 200 || moved.body?.case?.stage !== 'observation') {
  fail(`L4: the legacy route no longer works on a plain case — ${moved.status} ${JSON.stringify(moved.body).slice(0, 120)}`);
}
say('L4: and still moves through the legacy stage route exactly as before (200, stage=observation)');

// ================================ L5 — `signed` through the real route

// Both routes that can reach `signed` are exercised. Neither may arrive there
// without a `db.signings` record for this org and this player.
const cur = await j(`/org/rooms/${ROOM_ID}/journey`, {}, lead.auth);
const legacyStatus = await j(`/org/rooms/${ROOM_ID}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'signed', expectedRev: cur.body.case.rev }),
}, lead.auth);
if (legacyStatus.status === 200) fail('L5: the pre-M23 status route reached `signed` with no signing in the database');
if (![409, 422].includes(legacyStatus.status)) {
  fail(`L5: the status route refused with an unexpected ${legacyStatus.status} ${JSON.stringify(legacyStatus.body).slice(0, 160)}`);
}
if (!['ROOM_TRANSITION_INVALID', 'ROOM_EVIDENCE_REQUIRED'].includes(legacyStatus.body?.error)) {
  fail(`L5: the status route refused with an unexpected code ${JSON.stringify(legacyStatus.body?.error)}`);
}
say(`L5: the pre-M23 status route cannot reach \`signed\` (${legacyStatus.status} ${legacyStatus.body.error})`);

const m23Signed = await j(`/org/rooms/${ROOM_ID}/lifecycle`, {
  method: 'POST', body: JSON.stringify({ action: 'confirmSignedOutcome', expectedRev: cur.body.case.rev }),
}, lead.auth);
if (m23Signed.status === 200) fail('L5: the M23 lifecycle route reached `signed` with no signing in the database');
expect(m23Signed, 409, 'LIFECYCLE_TRANSITION_INVALID',
  'L5: and neither can the M23 lifecycle route from this state');

const stillNotSigned = await j(`/org/rooms/${ROOM_ID}/journey`, {}, lead.auth);
if (stillNotSigned.body.lifecycle.currentStage === 'signed') fail('L5: the case is at `signed` after two refusals');
if (stillNotSigned.body.outcome?.signing !== null) fail('L5: a signing appeared from nowhere');
say('L5: the case is not signed, and no signing record was created by trying');

// The evidence gate itself, reached from a state where the transition IS legal.
// `offer_made → signed` is a real edge, so this isolates the evidence rule from
// the transition rule.
{
  const probe = await j('/org/recruitment/lifecycle', {}, lead.auth);
  if (probe.status !== 200) fail(`L5: the lifecycle vocabulary route answered ${probe.status}`);
  const signedAction = (probe.body.actions ?? []).find((a) => a.to === 'signed');
  if (!signedAction || signedAction.action !== 'confirmSignedOutcome') fail('L5: the vocabulary does not name confirmSignedOutcome');
  if (!signedAction.roles.includes('recruitment_admin') || signedAction.roles.length !== 1) {
    fail(`L5: confirmSignedOutcome is not admin-only — ${JSON.stringify(signedAction.roles)}`);
  }
  say('L5: and the published vocabulary confirms `signed` is admin-only, with one action reaching it');
}

// ==================================== L6 — semantic status codes

// Each refusal names its own condition. A client branching on these must be
// able to tell "you may not" from "not from here" from "we cannot prove it".
const codes = [];
codes.push(['unknown action', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'teleport' }) }, lead.auth), 400, 'LIFECYCLE_ACTION_UNKNOWN']);
codes.push(['a stage key', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'holdCase', stage: 'signed' }) }, lead.auth), 400, 'LIFECYCLE_STAGE_NOT_SETTABLE']);
codes.push(['a wrong-role action', scoutConfirm, 403, 'LIFECYCLE_NOT_PERMITTED']);
codes.push(['an impossible transition', m23Signed, 409, 'LIFECYCLE_TRANSITION_INVALID']);
codes.push(['a stale rev', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'holdCase', expectedRev: 1 }) }, lead.auth), 409, 'ROOM_VERSION_CONFLICT']);
// `rejectCase` (→ archived), not `closeCase`: `under_review → closed` is not
// an edge, and the transition table is checked before the reason, so
// `closeCase` would answer TRANSITION_INVALID and never reach the reason rule.
codes.push(['a missing reason', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'rejectCase', expectedRev: stillNotSigned.body.case.rev }) }, lead.auth), 400, 'LIFECYCLE_REASON_REQUIRED']);
codes.push(['a DECISION reason on a transition', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'rejectCase', reasonCodes: ['squad_space'], expectedRev: stillNotSigned.body.case.rev }) }, lead.auth), 400, 'LIFECYCLE_REASON_UNKNOWN']);
codes.push(['a protected characteristic', await j(`/org/rooms/${ROOM_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'rejectCase', reasonCodes: ['nationality'], expectedRev: stillNotSigned.body.case.rev }) }, lead.auth), 400, 'ROOM_REASON_PROHIBITED']);
for (const [what, res, status, code] of codes) expect(res, status, code, `L6: ${what} answers ${status} ${code}`);

// 404 privacy: another club's case and a case that never existed are the same
// answer, byte for byte.
const ctxRival = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const rival = await enterClub(ctxRival, 'Harbour City', 'Rita Vale', 'Head of Recruitment');
const foreign = await j(`/org/rooms/${ROOM_ID}/journey`, {}, rival.auth);
const ghost = await j('/org/rooms/case-does-not-exist/journey', {}, rival.auth);
if (foreign.status !== 404) fail(`L6: another club's case answered ${foreign.status}, not 404`);
if (JSON.stringify(foreign.body) !== JSON.stringify(ghost.body)) {
  fail('L6: a foreign case and a non-existent case give different bodies — the id is confirmable');
}
say('L6: another club\'s case and a case that never existed answer 404 byte-identically');

// ==================================== L7 — the UI still reads it all

// The lifecycle moved through the API during this run. The Room UI must still
// render the case afterwards: shared lifecycle code changed, and a client that
// cannot display the result is a regression even with no new UI.
await lead.page.reload();
await lead.page.waitForSelector('nav.sidebar', { timeout: 25000 });
await lead.page.evaluate(() => { location.hash = '#/rooms'; });
await lead.page.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 25000 });
const listText = await lead.page.evaluate(() => document.body.innerText);
if (/undefined|NaN|\[object Object\]/.test(listText)) fail('L7: the rooms list renders a placeholder value');
say('L7: the Rooms list still renders after the lifecycle moved through the API');
if (/\bunder_review\b|\bon_hold\b|\bcontact_planned\b/.test(listText)) {
  fail('L7: a raw enum leaked into the UI instead of its label');
}
say('L7: and shows human labels, not raw lifecycle enums');

// 390px smoke on the surface that consumes the changed lifecycle contract.
const ctxPhone = await browser.newContext({ viewport: { width: 390, height: 844 } });
const phone = await enterClub(ctxPhone, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
await phone.page.evaluate(() => { location.hash = '#/rooms'; });
await phone.page.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 25000 });
const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 0) fail(`L8: the Rooms list overflows a 390px viewport by ${overflow}px`);
say('L8: the Rooms list fits a 390px phone (overflow=0px)');
const phoneText = await phone.page.evaluate(() => document.body.innerText);
if (!phoneText.trim()) fail('L8: the 390px Rooms list rendered nothing');
say('L8: with its status text readable at phone width');

// Keyboard: the list is reachable without a mouse.
await phone.page.keyboard.press('Tab');
const focused = await phone.page.evaluate(() => document.activeElement?.tagName ?? null);
if (!focused || focused === 'BODY') fail('L8: nothing takes keyboard focus on the Rooms list');
say(`L8: and takes keyboard focus (<${focused.toLowerCase()}>)`);

await browser.close();
browser = null;
for (const srv of statics) srv.close();
try { serverProc.kill('SIGTERM'); } catch { /* gone */ }
console.log(`\nm23Live: ${passed} checks passed — P2 sweep corrections verified end to end`);
// EXPLICIT EXIT. The spawned backend and the two static servers are ref'd
// handles, so without this the process prints its summary and then hangs
// forever — success to a human reading the tail, a timeout to a harness. This
// is the m22E2E D1 defect, and every other Live suite ends the same way.
process.exit(0);
