// M23 P4B LIVE — the Trial workflow, driven through the real Pro workspace
// and the real player app against a real server (test clock enabled so the
// "last session ended" gate can be proved without waiting for it).
//
//   A  ADULT      lead opens a room for Kola (adult) → the Trial tab is a
//                 page-local tab, not a nav item → gated until the case is
//                 under review → invitation with one slot already under way →
//                 Kola sees the slot with its time and zone in his Inbox at
//                 390px, accepts → the room shows Scheduled with the address
//                 only the club and the family hold → attendance recorded in
//                 the UI → completion through the gate → Kola's Opportunities
//                 show Completed and no judgement
//   M  MINOR      lead opens a room for Guni (13) → routing says guardian →
//                 Amara accepts at 390px → her Your trials carries the address
//                 → Guni's own device carries the outcome line and nothing
//                 else → a material reschedule asks Amara again → she confirms
//   N  NEGATIVES  N1 gate at watching; N2 contributor read-only; N3 foreign
//                 club 404; N4 no guardian route; N5 block after invitation;
//                 N6 attendance before start; N7 completion before attendance;
//                 N8 stale rev; N9 key collision; N10 sentinels; N11 evidence
//                 without consent; N12 child's device; N13 390px; N14 no
//                 lifecycle shortcut; N15 second invitation while pending
//
// Every refusal here asserts its exact status AND code. The exhaustive
// invariants live in scoutbox-server/scripts/m23TrialE2E.mjs; this suite
// proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4026;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8726;
const PLAYER_PORT = 8826;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23triallive-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const S_NOTE = 'PRIVATE_TRIAL_NOTE_SENTINEL_5284';
const S_ASSESS = 'PRIVATE_TRIAL_ASSESSMENT_SENTINEL_9481';
const H = 3_600_000; const MIN = 60_000;

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Assert an exact status AND an exact error code. Never "not 200". */
const expect = (res, status, code, what) => {
  if (res.status !== status) fail(`${what}: expected ${status}${code ? ` ${code}` : ''}, got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  if (code && res.body?.error !== code) fail(`${what}: expected error ${code}, got ${JSON.stringify(res.body?.error)}`);
  negatives++;
  say(what);
};

for (const port of [API_PORT, CLUB_PORT, PLAYER_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const haveDist = fs.existsSync(path.join(ROOT, 'scoutbox-club/dist-live23t/index.html')) && fs.existsSync(path.join(ROOT, 'scoutbox-player/dist-live23t/index.html'));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live23t`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live23t`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
}

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' },
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
serveDir('scoutbox-club/dist-live23t', CLUB_PORT);
serveDir('scoutbox-player/dist-live23t', PLAYER_PORT);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) {
    fs.rmSync(path.join(ROOT, 'scoutbox-club/dist-live23t'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'scoutbox-player/dist-live23t'), { recursive: true, force: true });
  }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 160; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token, extra = {}) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };

// --------------------------------------------------------------- club helpers

async function enterClub(ctx, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  const token = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; } });
  if (!token) fail(`${name}: the client stored no session token after login`);
  return { page, token };
}
async function openRoomFor(page, playerName) {
  await page.evaluate(() => { location.hash = '#/search'; });
  await page.waitForSelector('.player-card:not(.skeleton)', { timeout: 25000 });
  const card = page.locator(`.player-card:has-text("${playerName}")`).first();
  if (!(await card.count())) fail(`search shows no card for ${playerName}`);
  await card.click();
  await page.waitForSelector('.drawer', { timeout: 15000 });
  await page.click('button:has-text("Add to Recruitment Room")');
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  const hash = await page.evaluate(() => location.hash);
  const id = hash.split('/').pop();
  if (!/^case-/.test(id)) fail(`could not read the room id from the deep link (${hash})`);
  return id;
}
const tab = async (page, name) => {
  await page.click(`[role="tablist"] button[role="tab"]:has-text("${name}")`);
  await page.waitForSelector(`[role="tabpanel"][aria-label="${name}"]`, { timeout: 10000 });
  if (name === 'Trial') await page.locator('[role="tabpanel"][aria-label="Trial"] [aria-label="Trials"]').waitFor({ timeout: 15000 });
};
const trialPanel = (page) => page.locator('[role="tabpanel"][aria-label="Trial"]');
const headerStatus = async (page) => (await page.locator('[aria-label="Room header"] .badges').innerText());
const liveLine = (page) => trialPanel(page).locator('[role="status"][aria-live="polite"]').first().innerText();
async function waitPanel(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await trialPanel(page).innerText().catch(() => ''))) return true; await sleep(250); } return false; }
async function waitLive(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await liveLine(page).catch(() => ''))) return true; await sleep(250); } return false; }
const moveTo = async (page, status) => { await page.selectOption('[aria-label="Move to"]', status); await page.click('button:has-text("Apply")'); await page.waitForTimeout(800); };
async function trialTab(page, roomId) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(page, 'Trial');
}
/** `YYYY-MM-DDTHH:MM` in Europe/London for an instant — what the form types. */
const wall = (ms) => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
async function fillInvitation(page, { start, end, message, instructions = 'Ask for Priya at reception.' }) {
  const p = trialPanel(page);
  await p.locator('[aria-label="Organiser time zone"]').selectOption('Europe/London');
  await p.locator('[aria-label="Venue name"]').fill('Eastport Dome');
  await p.locator('[aria-label="Town"]').fill('Eastport');
  await p.locator('[aria-label="Exact address"]').fill('Gate B, Dome Road');
  await p.locator('[aria-label="Slot 1 Starts"]').fill(wall(start));
  await p.locator('[aria-label="Slot 1 Ends"]').fill(wall(end));
  await p.locator('[aria-label="Message the player or guardian will read"]').fill(message);
  await p.locator('[aria-label="Arrival instructions (shared after acceptance)"]').fill(instructions);
  await p.locator('button:has-text("Send invitation")').click();
}

// ------------------------------------------------------------ player helpers

async function enterPlayer(ctx, rowText, who, landing) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector(landing, { timeout: 30000 });
  return page;
}
async function reenter(page, rowText, landing) {
  await page.reload();
  await page.locator(landing).or(page.getByText('Our promises to every player')).first().waitFor({ timeout: 40000 });
  if (await page.locator('text=Our promises to every player').count()) {
    await page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last().locator('text=Enter').last().click();
    await page.waitForSelector(landing, { timeout: 30000 });
  }
}
const goTab = async (page, href) => { await page.click(`a[href="${href}"]`); await page.waitForTimeout(900); };
const bodyText = (page) => page.locator('body').innerText();

// ================================================================== A — ADULT

const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const AMARA = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
const GUNI = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body.token;
ok(KOLA && AMARA && GUNI, 'HTTP actors for the recipient-side checks logged in');

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;
say('A1: a recruitment lead signs in through the real client');
{
  const nav = await lead.page.locator('nav.sidebar').innerText();
  neg(!/\bTrial\b(?!s)/.test(nav.replace(/Trials & Reports|Trial Days/g, '')), 'A1b: the sidebar carries no new "Trial" item — a trial is a function of a case; Trials & Reports is the existing list');
}

const ROOM_A = await openRoomFor(lead.page, 'Kola Adeyemi');
say(`A2: the lead opens a Recruitment Room for an adult player (${ROOM_A})`);
{
  const tabs = await lead.page.locator('[role="tablist"] button[role="tab"]').allInnerTexts();
  ok(tabs.includes('Trial'), 'A2b: the room offers a page-local Trial tab');
  ok(tabs.indexOf('Trial') > tabs.indexOf('Contact') && tabs.indexOf('Trial') < tabs.indexOf('Activity'), 'A2c: it sits after Contact — first the conversation, then the trial');
}

// N1 — the gate at watching.
await tab(lead.page, 'Trial');
{
  const panel = await trialPanel(lead.page).innerText();
  neg(/A trial can be requested once the case is under review/.test(panel), 'N1: at Watching the tab says a trial cannot be requested yet — and from where it can');
  neg(await trialPanel(lead.page).locator('button:has-text("Send invitation")').isDisabled(), 'N1b: Send invitation is disabled');
  ok(/No trial yet\. A trial exists once an invitation is accepted/.test(panel), 'N1c: the list is honest about being empty');
  ok(/Invitation goes to the player \(adult\)/.test(panel), 'A3: the tab shows the SERVER-derived route: the adult player himself');
}
// N14 — no lifecycle shortcut.
{
  const jr = (await j('GET', `/org/rooms/${ROOM_A}/journey`, undefined, LEAD)).body;
  await j('POST', `/org/rooms/${ROOM_A}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, LEAD);
  expect(await j('POST', `/org/rooms/${ROOM_A}/lifecycle`, { action: 'planTrial', expectedRev: jr.case.rev + 1 }, LEAD), 422, 'LIFECYCLE_EVIDENCE_REQUIRED', 'N14: moving the case to Trial requested by hand is refused — no invitation, no evidence (422 LIFECYCLE_EVIDENCE_REQUIRED)');
}

await trialTab(lead.page, ROOM_A);
ok(/Under review/.test(await headerStatus(lead.page)), 'A4: the case is Under review (moved through the lifecycle API with the rev)');

// The invitation: one slot that started ten minutes ago and ends in fifty —
// allowed (a session under way), so attendance can be recorded today.
const T0 = Date.now();
const START = T0 - 10 * MIN; const END = T0 + 50 * MIN;
await fillInvitation(lead.page, { start: START, end: END, message: 'Come and train with the U23s — one session to start.' });
ok(await waitLive(lead.page, /Invitation sent\. Case moved to Trial requested\./), 'A5: the lead sends the invitation from the Trial tab; the live region reports it AND the case move');
{
  ok(await waitPanel(lead.page, /Invitation waiting for an answer/), 'A5b: the tab shows the pending invitation');
  const panel = await trialPanel(lead.page).innerText();
  ok(/Europe\/London/.test(panel) && /Eastport Dome/.test(panel), 'A5c: with its slot in the organiser zone and the venue');
  neg(/No trial yet/.test(panel), 'A5d: and still NO trial — an invitation is not a trial');
  ok(/Trial requested/.test(await headerStatus(lead.page)), 'A5e: the room header says Trial requested');
  neg(!(await trialPanel(lead.page).locator('form[aria-label="Invite to a trial"]').count()), 'N15: the compose form is gone while an invitation is pending');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials`, { timezone: 'Europe/London', venue: { name: 'X', town: 'Y' }, message: 'Again?', slots: [{ startsAt: T0 + 48 * H, endsAt: T0 + 50 * H }] }, LEAD), 409, 'TRIAL_ALREADY_INVITED', 'N15b: the API refuses a second invitation while one is pending (409 TRIAL_ALREADY_INVITED)');
}
const INV = (await j('GET', '/player/inbox', undefined, KOLA)).body.find((r) => r.type === 'trial' && r.status === 'pending');
ok(INV && INV.trialDetails?.slots?.length === 1, 'A6: the invitation is in the player\'s Inbox with its concrete slot');
neg(!JSON.stringify(INV).includes('Gate B') && !JSON.stringify(INV).includes('Ask for Priya'), 'A6b: the Inbox row carries neither the exact address nor the arrival instructions (shared after acceptance)');

// Kola at phone width.
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
await goTab(kola, '/inbox');
await kola.waitForSelector('text=one session to start', { timeout: 20000 });
{
  const txt = await bodyText(kola);
  ok(/Eastport FC/.test(txt) && /Maria Keane/.test(txt), 'A7: the player sees the invitation attributed to a named person at a named organisation');
  ok(/Europe\/London/.test(txt) && /Eastport Dome/.test(txt), 'A7b: the slot shows its time in the organiser zone and the venue name');
  neg(!/Gate B/.test(txt) && !/Ask for Priya/.test(txt), 'A7c: not the address, not the instructions');
  ok(/Pick the date that works — accepting it confirms the trial/.test(txt), 'A7d: and is asked to pick the date — accepting it confirms the trial');
  const noScroll = await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'A7e: 390px: no horizontal scroll');
  ok((await kola.locator('[data-testid^="trial-slot-"]').count()) === 1, 'A7f: exactly one slot chip');
}
await kola.locator('[data-testid^="trial-slot-"]').first().click();
await kola.getByText('Accept trial', { exact: true }).click();
await kola.waitForSelector('text=Trial accepted', { timeout: 20000 });
say('A8: the player accepts the slot');
{
  const t = (await j('GET', `/org/rooms/${ROOM_A}/trials`, undefined, LEAD)).body;
  ok(t.items.length === 1 && t.items[0].workflowState === 'scheduled' && t.items[0].schedule.confirmedAt > 0, 'A8b: one trial exists, scheduled, confirmed by the recipient');
  ok(t.invitation.status === 'accepted' && t.invitation.trialId === t.items[0].id, 'A8c: the invitation is accepted and points at the trial');
}
const TRIAL_A = (await j('GET', `/org/rooms/${ROOM_A}/trials`, undefined, LEAD)).body.items[0];
const SID_A = TRIAL_A.schedule.sessions[0].id;

// The player's Opportunities: the address and instructions arrive with acceptance.
await goTab(kola, '/opportunities');
await kola.waitForSelector('[data-testid="trial-workflow"]', { timeout: 20000 });
{
  const txt = await kola.locator('[data-testid="trial-workflow"]').innerText();
  ok(/Scheduled/.test(txt) && /Gate B, Dome Road/.test(txt) && /Ask for Priya/.test(txt), 'A9: Your trials shows Scheduled with the exact address and the instructions — shared once accepted');
  neg(!/assess|rating|recommend/i.test(txt), 'A9b: and nothing that reads as a judgement');
  ok(/Cancel this trial/.test(txt), 'A9c: the player may cancel — the trial is theirs to walk away from');
  neg(!/Confirm the schedule/.test(txt), 'A9d: nothing to confirm — accepting the slot already did');
}

// The lead records attendance in the UI (the session is under way).
await trialTab(lead.page, ROOM_A);
{
  const panel = await trialPanel(lead.page).innerText();
  ok(/\bScheduled\b/.test(panel) && /Gate B, Dome Road/.test(panel) && /Report owed/.test(panel), 'A10: the tab shows the trial Scheduled, with the address, and the mandatory report still owed');
  ok(/Trial scheduled/.test(await headerStatus(lead.page)), 'A10b: the room header says Trial scheduled — moved by the acceptance, through the writer');
  neg(/Not recorded/.test(panel), 'A10c: attendance is Not recorded — derived, never stored');
  const complete = trialPanel(lead.page).locator('button:has-text("Mark trial completed")');
  neg(await complete.isDisabled(), 'N7: Mark trial completed is disabled before attendance');
  neg(/no session has attendance recorded/.test(panel) && /the last session has not ended/.test(panel), 'N7b: and the screen says which requirements are missing');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/complete`, { expectedRev: TRIAL_A.rev }, LEAD), 409, 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET', 'N7c: the API refuses completion too (409 TRIAL_COMPLETION_REQUIREMENTS_NOT_MET)');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/attendance`, { state: 'attended', expectedRev: TRIAL_A.rev + 7 }, LEAD), 409, 'TRIAL_VERSION_CONFLICT', 'N8: a stale expectedRev is a 409 TRIAL_VERSION_CONFLICT');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/attendance`, { state: 'attended', expectedRev: '1' }, LEAD), 400, 'TRIAL_REV_REQUIRED', 'N8b: a string rev is refused, not coerced (400 TRIAL_REV_REQUIRED)');
}
await trialPanel(lead.page).locator('summary:has-text("Record attendance")').click();
await trialPanel(lead.page).locator(`[aria-label="Attendance ${SID_A}"]`).selectOption('attended');
await trialPanel(lead.page).locator(`[aria-label="Note (club-private) ${SID_A}"]`).fill(S_NOTE);
await trialPanel(lead.page).locator('button:has-text("Record")').first().click();
ok(await waitLive(lead.page, /Attendance recorded: Attended\./), 'A11: the lead records attendance for the session under way, with a club-private note');
{
  ok(await waitPanel(lead.page, /\bAttended\b/), 'A11b: the session row says Attended');
  const t = (await j('GET', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}`, undefined, LEAD)).body.trial;
  ok(t.attendanceHistory.length === 1 && t.attendanceHistory[0].note === S_NOTE && t.rev === TRIAL_A.rev + 1, 'A11c: one attendance record with the note, rev moved once');
}
// N9 — the same key with a different payload.
expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/attendance`, { state: 'no_show', expectedRev: TRIAL_A.rev + 1, clientKey: `tr-att-${TRIAL_A.id}-${SID_A}-${TRIAL_A.rev}` }, LEAD), 409, 'TRIAL_IDEMPOTENCY_CONFLICT', 'N9: reusing the UI\'s attendance key with a different payload is a 409 TRIAL_IDEMPOTENCY_CONFLICT');

// N10 — sentinels: the club note and an assessment note reach no family surface.
{
  const a = await j('POST', '/org/assessments', { playerId: 'pl-adeyemi', context: { trialId: TRIAL_A.id, trialSessionId: SID_A } }, LEAD);
  ok(a.status === 201, 'N10: an assessment is opened in the trial\'s context');
  const attr = a.body.assessment.attributesSnapshot[0].id;
  await j('PUT', `/org/assessments/${a.body.assessment.id}`, { ratings: [{ attrId: attr, rating: 2, note: S_ASSESS }], recommendation: { verdict: 'pass', reasons: S_ASSESS } }, LEAD);
  await reenter(kola, 'Kola Adeyemi', 'a[href="/inbox"]');
  await goTab(kola, '/opportunities');
  await kola.waitForSelector('[data-testid="trial-workflow"]', { timeout: 20000 });
  const txt = await bodyText(kola);
  neg(!txt.includes(S_NOTE) && !txt.includes(S_ASSESS), 'N10b: the player\'s Opportunities carry neither the attendance note nor the assessment sentinel');
  const surfaces = {
    'player trials': (await j('GET', '/player/trials', undefined, KOLA)).body,
    'player notifications': (await j('GET', '/player/notifications', undefined, KOLA)).body,
    'player passport': (await j('GET', '/player/football-passport', undefined, KOLA)).body,
    'guardian trials': (await j('GET', '/guardian/trials', undefined, AMARA)).body,
    'outbox': (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body,
    'journey': (await j('GET', `/org/rooms/${ROOM_A}/journey?limit=100`, undefined, LEAD)).body,
  };
  for (const [name, body] of Object.entries(surfaces)) neg(!JSON.stringify(body ?? {}).includes(S_NOTE) && !JSON.stringify(body ?? {}).includes(S_ASSESS), `N10c: ${name} carries no sentinel`);
  await trialTab(lead.page, ROOM_A);
  ok(await waitPanel(lead.page, /Assessments in this trial \(1\)/), 'N10d: the lead\'s tab lists the assessment as existing');
  const panel = await trialPanel(lead.page).innerText();
  neg(!panel.includes(S_ASSESS) && !/\bpass\b/.test(panel.split('Assessments in this trial')[1] ?? ''), 'N10e: and never its content or verdict');
}

// N11 — evidence without consent.
{
  const c = (await j('GET', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/evidence/candidates`, undefined, LEAD)).body;
  neg(c.consent === false && c.reason === 'EVIDENCE_CONSENT_REQUIRED' && c.items.length === 0, 'N11: without the player\'s sharing preference the club can cite nothing — the candidates list says why');
  await trialPanel(lead.page).locator('summary:has-text("Box Cam evidence")').click();
  const panel = await trialPanel(lead.page).innerText();
  neg(/has not shared Box Cam activity/.test(panel), 'N11b: the tab says so in words — a trial is not consent');
  // A real, finalised Box Cam session of Kola's: the consent gate is only
  // reached for a session that exists and is his. An unknown id is 404 by
  // design (the club cannot tell "not yours" from "does not exist").
  const bx = await j('POST', '/player/box-cam/sessions', { drillId: 'box-touches', target: { type: 'repetitions', value: 20 }, provider: 'production_cv' }, KOLA);
  ok(bx.status === 201, 'N11c-setup: Kola records a Box Cam session at home');
  await j('POST', `/player/box-cam/sessions/${bx.body.session.id}/start`, { nonce: bx.body.nonce, liveness: bx.body.livenessChallenge }, KOLA);
  await j('POST', `/player/box-cam/sessions/${bx.body.session.id}/complete`, { nonce: bx.body.nonce }, KOLA);
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/evidence`, { boxSessionId: bx.body.session.id, expectedRev: TRIAL_A.rev + 1 }, LEAD), 403, 'EVIDENCE_CONSENT_REQUIRED', 'N11c: linking his finalised session is refused 403 EVIDENCE_CONSENT_REQUIRED — a trial is not consent');
  // M23 P8.1 (D-P81-9): consent is decided BEFORE the session is looked up, so without consent a fabricated id gets the SAME refusal as a real session — the existence of footage is not enumerable through guesses (the club's own consent state is already on its candidates list, N11).
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/evidence`, { boxSessionId: 'bx-any', expectedRev: TRIAL_A.rev + 1 }, LEAD), 403, 'EVIDENCE_CONSENT_REQUIRED', 'N11d: an unknown session id is refused exactly like a real one without consent (403 EVIDENCE_CONSENT_REQUIRED) — whether footage exists is not enumerable through guesses (D-P81-9)');
}

// A12 — completion through the gate, once the session has ended (test clock).
{
  const t = (await j('GET', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}`, undefined, LEAD)).body.trial;
  const done = await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/complete`, { expectedRev: t.rev }, LEAD, at(END + 5 * MIN));
  ok(done.status === 200 && done.body.trial.workflowState === 'completed' && done.body.case.to === 'trial_completed', 'A12: once the last session has ended, completion is explicit and moves the case to Trial completed');
  await trialTab(lead.page, ROOM_A);
  const panel = await trialPanel(lead.page).innerText();
  ok(/\bCompleted\b/.test(panel) && /Trial completed/.test(await headerStatus(lead.page)), 'A12b: the tab and the header say Completed');
  neg(/Report owed/.test(panel), 'A12c: the mandatory report is still owed — completion is not the report');
  neg(!(await trialPanel(lead.page).locator('button:has-text("Mark trial completed")').count()), 'A12d: no further completion control');
  await reenter(kola, 'Kola Adeyemi', 'a[href="/inbox"]');
  await goTab(kola, '/opportunities');
  await kola.waitForSelector('[data-testid="trial-workflow"]', { timeout: 20000 });
  const txt = await kola.locator('[data-testid="trial-workflow"]').innerText();
  ok(/Completed/.test(txt) && /This is not an assessment/.test(txt), 'A12e: the player sees Completed and is told it is not an assessment');
  const pp = (await j('GET', '/player/football-passport', undefined, KOLA)).body;
  ok(pp.timeline.some((e) => e.type === 'trial_attended' && e.legacy === false), 'A12f: the Passport shows trial_attended keyed on the recorded attendance');
}

// ================================================================== M — MINOR

const ROOM_M = await openRoomFor(lead.page, 'Guni Adebayo');
say(`M1: the lead opens a Room for a 13-year-old (${ROOM_M})`);
{
  const jr = (await j('GET', `/org/rooms/${ROOM_M}/journey`, undefined, LEAD)).body;
  await j('POST', `/org/rooms/${ROOM_M}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, LEAD);
}
await trialTab(lead.page, ROOM_M);
ok(/Invitation goes to the parent or guardian — under-18, never the child/.test(await trialPanel(lead.page).innerText()), 'M2: the tab says the route is the guardian, never the child');
const M_START = T0 + 72 * H; const M_END = T0 + 74 * H;
await fillInvitation(lead.page, { start: M_START, end: M_END, message: 'We would like to invite Guni to a U14 training session.' });
ok(await waitLive(lead.page, /Invitation sent\. Case moved to Trial requested\./), 'M3: the lead sends; routed to the guardian');

const ctxAmara = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const amara = await enterPlayer(ctxAmara, 'Amara Adebayo', 'amara', 'text=Guardian');
await amara.waitForSelector('text=U14 training session', { timeout: 25000 });
{
  const txt = await bodyText(amara);
  ok(/U14 training session/.test(txt) && /Europe\/London/.test(txt), 'M4: the guardian sees the invitation with its slot and zone at 390px');
  neg(!/Gate B/.test(txt), 'M4b: not yet the address');
  ok((await amara.locator('[data-testid^="trial-slot-"]').count()) === 1, 'M4c: one slot chip');
}
await amara.locator('[data-testid^="trial-slot-"]').first().click();
await amara.getByText('Accept trial', { exact: true }).first().click();
await amara.waitForSelector('text=Trial accepted', { timeout: 20000 });
say('M5: the guardian accepts the slot');
{
  await amara.reload();
  await amara.waitForSelector('[data-testid="trial-workflow"]', { timeout: 30000 });
  const txt = await amara.locator('[data-testid="trial-workflow"]').innerText();
  ok(/Scheduled/.test(txt) && /Gate B, Dome Road/.test(txt) && /Guni/.test(txt), 'M6: her Your trials shows the child\'s trial Scheduled with the address');
}
const TRIAL_M = (await j('GET', `/org/rooms/${ROOM_M}/trials`, undefined, LEAD)).body.items[0];
ok(TRIAL_M.recipient.type === 'guardian' && TRIAL_M.recipient.minor === true, 'M6b: the trial\'s recipient is the guardian');

// N12 — the child's own device.
const ctxGuni = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const guni = await enterPlayer(ctxGuni, 'Guni Adebayo', 'guni', 'a[href="/inbox"]');
await goTab(guni, '/inbox');
{
  const txt = await bodyText(guni);
  ok(/guardian-managed/.test(txt) && /Eastport FC/.test(txt), 'N12: the child\'s Updates show a guardian-managed item from the club');
  neg(!/U14 training session/.test(txt) && !/Gate B/.test(txt) && !(await guni.locator('[data-testid^="trial-slot-"]').count()), 'N12b: never the message, the address or a slot to pick');
}
await goTab(guni, '/opportunities');
await guni.waitForSelector('[data-testid="trial-workflow"]', { timeout: 20000 });
{
  const txt = await guni.locator('[data-testid="trial-workflow"]').innerText();
  ok(/Scheduled/.test(txt) && /Managed by your parent or guardian/.test(txt), 'N12c: the child\'s Your trials is the outcome line: Scheduled, guardian-managed');
  neg(!/Gate B/.test(txt) && !/Ask for Priya/.test(txt) && !/Confirm the schedule/.test(txt) && !/Cancel this trial/.test(txt), 'N12d: no address, no instructions, no confirm, no cancel on the child\'s device');
  expect(await j('POST', `/player/trials/${TRIAL_M.id}/confirm-schedule`, {}, GUNI), 403, 'GUARDIAN_MANAGED', 'N12e: the child\'s device cannot confirm through the API either (403 GUARDIAN_MANAGED)');
}

// M7 — a material reschedule asks the guardian again; she confirms in the UI.
{
  const re = await j('POST', `/org/rooms/${ROOM_M}/trials/${TRIAL_M.id}/reschedule`, { timezone: 'Europe/London', expectedRev: TRIAL_M.rev, reason: 'Pitch booked elsewhere that morning.', sessions: [{ id: TRIAL_M.schedule.sessions[0].id, startsAt: M_START + 3 * H, endsAt: M_END + 3 * H, venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' } }] }, LEAD);
  ok(re.status === 200 && re.body.requiresConfirmation === true && re.body.trial.workflowState === 'accepted', 'M7: the club moves the session — material, so the confirmation is cleared and the trial is accepted-not-scheduled');
  const gn = (await j('GET', '/guardian/notifications', undefined, AMARA)).body;
  ok(gn.some((n) => n.type === 'trial_day' && /confirm/.test(n.text) && n.refId === TRIAL_M.id), 'M7b: the guardian is asked to confirm (trial_day, deep-linked to the trial)');
  neg(!(await j('GET', '/player/notifications', undefined, GUNI)).body.some((n) => n.type === 'trial_day'), 'M7c: the child received no trial_day notification');
  await amara.reload();
  await amara.waitForSelector('[data-testid="trial-workflow"]', { timeout: 30000 });
  const txt = await amara.locator('[data-testid="trial-workflow"]').innerText();
  ok(/The club proposed times — please confirm or decline/.test(txt) && /Confirm the schedule/.test(txt), 'M7d: her Your trials asks her to confirm or decline');
  await amara.getByText('Confirm the schedule', { exact: true }).first().click();
  await amara.waitForSelector('text=Schedule confirmed', { timeout: 20000 });
  say('M8: the guardian confirms the revised schedule');
  const t = (await j('GET', `/org/rooms/${ROOM_M}/trials/${TRIAL_M.id}`, undefined, LEAD)).body.trial;
  ok(t.workflowState === 'scheduled' && t.schedule.revision === 2 && t.schedule.confirmedAt > 0, 'M8b: revision 2 is confirmed; the trial is scheduled again');
  const jr = (await j('GET', `/org/rooms/${ROOM_M}/journey?limit=100`, undefined, LEAD)).body;
  ok(jr.history.entries.some((e) => e.kind === 'trial_rescheduled') && jr.history.entries.some((e) => e.kind === 'trial_schedule_confirmed'), 'M8c: the journey carries the revision and the confirmation as milestones');
}

// ============================================================== N — NEGATIVES

// N2 — a contributor: read-only tab, refused on write.
{
  const ctxScout = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Reilly', 'First-Team Scout', 'scout');
  await trialTab(scout.page, ROOM_A);
  const panel = await trialPanel(scout.page).innerText();
  neg(/Inviting, scheduling, attendance, completion and evidence need a room lead or recruitment lead/.test(panel), 'N2: a scout who is not the room lead is told the tab is read-only');
  neg(!(await trialPanel(scout.page).locator('form[aria-label="Invite to a trial"]').count()) && !(await trialPanel(scout.page).locator('summary:has-text("Record attendance")').count()), 'N2b: no compose form, no attendance controls');
  ok(/\bCompleted\b/.test(panel), 'N2c: but can read the trial — internal, same organisation');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/cancel`, { reason: 'x', expectedRev: 1 }, scout.token), 403, 'TRIAL_NOT_PERMITTED', 'N2d: the API refuses the write — 403 TRIAL_NOT_PERMITTED');
  await ctxScout.close();
}

// N3 — a foreign organisation: the concealing 404.
{
  const ctxRival = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rival = await enterClub(ctxRival, 'Harbour City FC', 'Rita Doyle', 'Head of Recruitment', 'rival');
  await rival.page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${ROOM_A}`);
  await rival.page.waitForTimeout(2000);
  neg(!/Gate B|one session to start|Kola Adeyemi/.test(await bodyText(rival.page)), 'N3: another club opening the deep link sees none of the trial');
  const foreign = await j('GET', `/org/rooms/${ROOM_A}/trials`, undefined, rival.token);
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/trials', undefined, rival.token);
  neg(foreign.status === 404 && ghost.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(ghost.body), 'N3b: the API answers the same 404 as for a case that never existed');
  await ctxRival.close();
}

// N4 — no valid guardian route: Tomasz (guardian Marek), IDV revoked.
{
  const ROOM_T = await openRoomFor(lead.page, 'Tomasz');
  const jr = (await j('GET', `/org/rooms/${ROOM_T}/journey`, undefined, LEAD)).body;
  await j('POST', `/org/rooms/${ROOM_T}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, LEAD);
  const revoke = await j('POST', '/admin/guardians/gd-marek/idv', { approved: false }, undefined, ADMIN);
  ok(revoke.status === 200 && revoke.body.idVerified === false, 'N4: Trust & Safety revokes the guardian\'s identity verification');
  await trialTab(lead.page, ROOM_T);
  const panel = await trialPanel(lead.page).innerText();
  neg(/no verified guardian route exists/.test(panel), 'N4b: the tab says the minor cannot be invited and why — no direct fallback offered');
  neg(await trialPanel(lead.page).locator('button:has-text("Send invitation")').isDisabled(), 'N4c: Send invitation is disabled');
  expect(await j('POST', `/org/rooms/${ROOM_T}/trials`, { timezone: 'Europe/London', venue: { name: 'X', town: 'Y' }, message: 'Hello', slots: [{ startsAt: T0 + 48 * H, endsAt: T0 + 50 * H }] }, LEAD), 422, 'TRIAL_GUARDIAN_REQUIRED', 'N4d: the API fails closed — 422 TRIAL_GUARDIAN_REQUIRED');
  neg((await j('GET', `/org/rooms/${ROOM_T}/journey`, undefined, LEAD)).body.lifecycle.currentStage === 'under_review', 'N4e: the case did not move');
  await j('POST', '/admin/guardians/gd-marek/idv', { approved: true }, undefined, ADMIN);
}

// N5 — a block placed after the invitation: accept refused, decline allowed; then the scheduled trial under a block.
{
  const ROOM_E = await openRoomFor(lead.page, 'Elias Svensson');
  const jr = (await j('GET', `/org/rooms/${ROOM_E}/journey`, undefined, LEAD)).body;
  await j('POST', `/org/rooms/${ROOM_E}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, LEAD);
  const inv = await j('POST', `/org/rooms/${ROOM_E}/trials`, { timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport' }, message: 'Elias — a session with the U21s?', slots: [{ startsAt: T0 + 96 * H, endsAt: T0 + 98 * H }] }, LEAD);
  ok(inv.status === 201, 'N5: an invitation goes to an adult');
  const ELIAS = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
  const req = (await j('GET', '/player/inbox', undefined, ELIAS)).body.find((r) => r.status === 'pending' && r.type === 'trial');
  ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, ELIAS)).status === 201, 'N5b: the player then blocks the organisation');
  expect(await j('POST', `/player/requests/${req.id}/respond`, { accept: true, chosenSlot: req.trialDetails.proposedDate }, ELIAS), 403, 'BLOCKED', 'N5c: accepting an invitation from a blocked organisation is refused 403 BLOCKED');
  const dec = await j('POST', `/player/requests/${req.id}/respond`, { accept: false }, ELIAS);
  ok(dec.status === 200 && dec.body.status === 'declined', 'N5d: declining it is allowed');
  await trialTab(lead.page, ROOM_E);
  const panel = await trialPanel(lead.page).innerText();
  neg(/Blocked by the player or guardian/.test(panel), 'N5e: the lead\'s tab now shows the block');
  expect(await j('POST', `/org/rooms/${ROOM_E}/trials`, { timezone: 'Europe/London', venue: { name: 'X', town: 'Y' }, message: 'Again?', slots: [{ startsAt: T0 + 200 * H, endsAt: T0 + 202 * H }] }, LEAD, at(T0 + 100 * H)), 403, 'TRIAL_BLOCKED', 'N5f: a new invitation is refused 403 TRIAL_BLOCKED');
  // The scheduled trial of Kola under a block: nothing but cancel.
  const blk = await j('POST', '/player/block', { orgId: 'org-eastport' }, KOLA);
  ok(blk.status === 201, 'N5g: Kola blocks the organisation after his completed trial');
  expect(await j('POST', `/org/rooms/${ROOM_A}/trials/${TRIAL_A.id}/sessions/${SID_A}/evidence`, { boxSessionId: 'x', expectedRev: 99 }, LEAD), 403, 'TRIAL_BLOCKED', 'N5h: linking evidence on his trial is refused 403 TRIAL_BLOCKED — before any validation');
  await trialTab(lead.page, ROOM_A);
  neg(/While the block stands you may only cancel/.test(await trialPanel(lead.page).innerText()) || /Blocked by the player or guardian/.test(await trialPanel(lead.page).innerText()), 'N5i: the tab says the block stands');
}

// N6 — attendance before a session starts.
{
  const t = (await j('GET', `/org/rooms/${ROOM_M}/trials/${TRIAL_M.id}`, undefined, LEAD)).body.trial;
  expect(await j('POST', `/org/rooms/${ROOM_M}/trials/${TRIAL_M.id}/sessions/${t.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t.rev }, LEAD), 409, 'TRIAL_INVALID_STATE', 'N6: attendance for a session three days away is refused (409 TRIAL_INVALID_STATE)');
  await trialTab(lead.page, ROOM_M);
  await trialPanel(lead.page).locator('summary:has-text("Record attendance")').click();
  const btn = trialPanel(lead.page).locator('button:has-text("Not started yet")').first();
  neg((await btn.count()) === 1 && await btn.isDisabled(), 'N6b: the UI control says Not started yet and is disabled');
}

// N13 — 390px: the club's Trial tab.
{
  const session = await lead.page.evaluate(() => localStorage.getItem('scoutbox-club-session'));
  const ctxPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctxPhone.addInitScript((s) => { localStorage.setItem('scoutbox-club-session', s); }, session);
  const phone = watch(await ctxPhone.newPage(), 'phone');
  await phone.goto(`http://localhost:${CLUB_PORT}/#/recruitment/rooms/${ROOM_M}`);
  await phone.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(phone, 'Trial');
  const noScroll = await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'N13: 390px: the Trial tab has no horizontal page scroll');
  await trialPanel(phone).locator('summary:has-text("Record attendance")').click();
  const btn = trialPanel(phone).locator('button:has-text("Not started yet")').first();
  const box = await btn.boundingBox();
  ok(box && box.height >= 28 && box.x >= 0 && box.x + box.width <= 390, 'N13b: 390px: the attendance control is a touch target inside the viewport');
  const labelled = await trialPanel(phone).locator(`[aria-label^="Attendance "]`).count();
  ok(labelled >= 1, 'N13c: the attendance select is labelled for assistive technology');
  await phone.setViewportSize({ width: 360, height: 780 });
  await phone.waitForTimeout(400);
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13d: 360px: still no horizontal page scroll');
  await ctxPhone.close();
}

// A13 — accessibility (§206): tab semantics, keyboard, focus, live mutation feedback.
{
  await trialTab(lead.page, ROOM_A);
  const sel = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Trial")').getAttribute('aria-selected');
  const controls = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Trial")').getAttribute('aria-controls');
  const panelId = await trialPanel(lead.page).getAttribute('id');
  ok(sel === 'true' && controls && controls === panelId, 'A13: tab semantics — the Trial tab is aria-selected and aria-controls its tabpanel');
  // Keyboard: focus the Contact tab, arrow/Tab to Trial, Enter activates it.
  await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Contact")').focus();
  await lead.page.keyboard.press('Tab');
  const focusedText = await lead.page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  ok(focusedText === 'Trial', `A13b: keyboard — Tab from Contact lands on the Trial tab (focused: "${focusedText}")`);
  await lead.page.keyboard.press('Enter');
  await lead.page.waitForTimeout(300);
  ok((await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Trial")').getAttribute('aria-selected')) === 'true', 'A13c: keyboard — Enter activates the tab');
  // The remaining tab buttons sit between the Trial tab and its panel in DOM
  // order; a few Tab presses reach the panel, and the first stop inside it
  // must be a labelled control.
  let inPanel = null;
  for (let i = 0; i < 6 && !inPanel?.inside; i++) {
    await lead.page.keyboard.press('Tab');
    inPanel = await lead.page.evaluate(() => {
      const a = document.activeElement; const p = a?.closest('[role="tabpanel"]');
      return { inside: !!p && p.getAttribute('aria-label') === 'Trial', tag: a?.tagName, labelled: !!(a?.getAttribute('aria-label') || a?.textContent?.trim()) };
    });
  }
  ok(!!inPanel?.inside && inPanel.labelled, `A13d: focus — Tab reaches the Trial panel and lands on a labelled control (${inPanel?.tag})`);
  ok((await trialPanel(lead.page).locator('[role="status"][aria-live="polite"]').count()) >= 1, 'A13e: live mutation feedback — the panel carries a polite live region (the one every A-step read its outcome from)');
}

// A14 — FR (§207): the same tab in French, the same invitation in French on the family side.
{
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'fr'));
  await lead.page.reload();
  await lead.page.waitForSelector('[aria-label="En-tête de la salle"]', { timeout: 25000 });
  await lead.page.click('[role="tablist"] button[role="tab"]:has-text("Essai")');
  const frPanel = lead.page.locator('[role="tabpanel"][aria-label="Essai"]');
  await frPanel.waitFor({ timeout: 10000 });
  let frTxt = '';
  for (let i = 0; i < 40 && !/Historique/.test(frTxt); i++) { frTxt = await frPanel.innerText().catch(() => ''); if (!/Historique/.test(frTxt)) await sleep(250); }
  ok(/Historique/.test(frTxt) && /Évaluations de cet essai/.test(frTxt) && !/\bHistory\b|Assessments in this trial|Record attendance/.test(frTxt), 'A14: FR — the Trial tab renders in French with no English fallback in its headings');
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'en'));
  await lead.page.reload();
  await kola.evaluate(() => localStorage.setItem('sb-player-lang', 'fr'));
  await reenter(kola, 'Kola Adeyemi', 'a[href="/inbox"]');
  await goTab(kola, '/opportunities');
  await kola.waitForSelector('[data-testid="trial-workflow"]', { timeout: 20000 });
  let frFam = '';
  for (let i = 0; i < 40 && !/vos essais/i.test(frFam); i++) { frFam = await bodyText(kola); if (!/vos essais/i.test(frFam)) await sleep(250); }
  ok(/vos essais/i.test(frFam) && /Séances/.test(frFam) && !/your trials/i.test(frFam), 'A14b: FR — the family Trial section renders in French (title, sessions, completion line)');
  await kola.evaluate(() => localStorage.setItem('sb-player-lang', 'en'));
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any surface');
console.log(`\nM23 P4B TRIAL LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
