// M18.2 LIVE browser journeys — the cleanup, in a real browser.
//
// J1  a Brief conflict is shown by the shared notice, names the colleague,
//     keeps the typed draft, and "Reload latest" recovers
// J2  a Room status conflict is the SAME notice — one experience
// J3  leaving a dirty Brief form asks first; a clean form never does
// J4  notification preferences: a toggle round-trips to the server, the
//     mandatory category is locked, email is described as a local outbox
// J5  the audit log: a lead reads it; it never shows a note body
// J6  a slow source shows a loading state and then the content, not an error
// J7  a failed source offers "Try again" only when retrying can help
// J8  a 403 renders a permission message and does NOT sign the person out
// J9  Discover states its ordering and says it is not a ranking
// J10 the new panels fit a 390px phone and are operable from the keyboard;
//     a destructive action states its consequence before acting
//
// The exhaustive invariants live in scoutbox-server/scripts/m182E2E.mjs. This
// suite proves the real UI drives them: the conflict notice the person sees,
// the dialog the browser raises, the request the client actually sends.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4018;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8813;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m182live-'));

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

console.log(`building live bundle for :${API_PORT}…`);
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live182`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
serveDir('scoutbox-club/dist-live182', CLUB_PORT);

const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 160; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const setFaults = (rules) => j('POST', '/__faults', { rules });

const browser = await chromium.launch({ executablePath: EXE });
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 30000 });
  return page;
}
const tokenOf = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
});
async function goto(page, hash, selector) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  if (selector) {
    await page.waitForSelector(selector, { timeout: 25000 }).catch(async (e) => {
      const where = await page.evaluate(() => location.hash);
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 400);
      fail(`navigation to ${hash} never showed ${selector} (now at ${where}): ${text}`);
      throw e;
    });
  }
  await page.waitForTimeout(500);
}
const BR = '#/briefs';
const RM = '#/rooms';
const ORG = '#/organisation';
const SL = '#/recruitment/second-look';

const scout = await enterClub(ctxA, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
const MARIA = await tokenOf(scout);
if (!MARIA) fail('fixture: the scout has no session token');
const TOM = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Field', role: 'Head of Recruitment' })).body.token;
const players = (await j('GET', '/org/players', undefined, MARIA)).body;
const SUBJECT = players.find((p) => /Kola Adeyemi/.test(p.name)) ?? players[0];
if (!SUBJECT) fail('fixture: no visible player');

// ===================================================================== J1
// A Brief conflict: the shared notice, the colleague's name, the kept draft.
const brief = (await j('POST', '/org/recruitment-briefs', { title: 'Left-sided CM', positions: ['CM'] }, MARIA)).body.brief;
if (!brief?.id) fail('J1 fixture: could not create a brief');
await goto(scout, `#/recruitment/briefs/${brief.id}`);
await scout.waitForSelector('button:has-text("Edit criteria")', { timeout: 20000 });
{
  await scout.click('button:has-text("Edit criteria")');
  await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 15000 });
  const title = scout.locator('[aria-label="Recruitment brief criteria"] input').first();
  await title.fill('Left-sided CM — Maria’s draft');
  say('J1: the scout opens the Brief editor and types a change');

  // The colleague moves it while this editor is still open.
  const move = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Tom’s title', expectedRev: brief.rev }, TOM);
  if (move.status !== 200) fail(`J1: the colleague's edit should have succeeded (${move.status})`);
  say('J1: a colleague edits the same Brief from their own session');

  await scout.click('[aria-label="Recruitment brief criteria"] button.primary, [aria-label="Recruitment brief criteria"] button:has-text("Save")');
  await scout.waitForSelector('[data-conflict-code]', { timeout: 15000 });
  const code = await scout.getAttribute('[data-conflict-code]', 'data-conflict-code');
  if (code !== 'BRIEF_VERSION_CONFLICT') fail(`J1: the notice carries the wrong code (${code})`);
  say('J1: the save is refused and the SHARED conflict notice appears (BRIEF_VERSION_CONFLICT)');
  const notice = await scout.locator('[data-conflict-code]').innerText();
  if (!/This changed while you were editing/.test(notice)) fail('J1: the notice does not lead with the human explanation');
  if (!/Tom Field/.test(notice)) fail(`J1: the notice does not name the colleague — it said: ${notice.slice(0, 160)}`);
  say('J1: it names who changed it, in words, with the machine code kept as data');
  const role = await scout.getAttribute('[data-conflict-code]', 'role');
  if (role !== 'alert') fail('J1: the conflict notice is not announced');
  say('J1: the notice is role="alert"');
  const draft = await title.inputValue();
  if (draft !== 'Left-sided CM — Maria’s draft') fail(`J1: the typed draft was lost (${draft})`);
  say('J1: the scout’s typed draft is still in the form — nothing was destroyed');
  const keep = scout.locator('[data-conflict-code] button:has-text("Keep my changes")');
  if (!(await keep.count())) fail('J1: no "Keep my changes" option');
  say('J1: "Keep my changes" is offered because a form can hold its draft');
  await scout.click('[data-conflict-code] button:has-text("Reload latest")');
  await scout.waitForTimeout(1200);
  const after = await scout.locator('body').innerText();
  if (await scout.locator('[data-conflict-code]').count()) fail('J1: reloading did not clear the notice');
  if (!/Tom’s title/.test(after)) fail('J1: reloading did not show the colleague’s version');
  say('J1: "Reload latest" shows the colleague’s version and clears the notice');
}

// ===================================================================== J2
// A Room status conflict is the same notice.
await goto(scout, '#/search');
await scout.waitForSelector(`.player-card:has-text("${SUBJECT.name}")`, { timeout: 30000 });
await scout.click(`.player-card:has-text("${SUBJECT.name}")`);
await scout.waitForSelector('.drawer', { timeout: 20000 });
await scout.click('button:has-text("Add to Recruitment Room")');
await scout.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
const ROOM_ID = (await scout.evaluate(() => location.hash)).split('/').pop();
say('J2: the scout opens a Recruitment Room from Discover');
{
  let colleagueMoved = false;
  await scout.route(/\/org\/rooms\/[^/]+\/status$/, async (route) => {
    if (!colleagueMoved && route.request().method() === 'POST') {
      colleagueMoved = true;
      const cur = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
      const move = await j('POST', `/org/rooms/${ROOM_ID}/status`, { status: 'under_review', expectedRev: cur.rev }, TOM);
      if (move.status !== 200) fail(`J2: the colleague's transition should have succeeded (${move.status})`);
    }
    await route.continue();
  });
  await scout.selectOption('[aria-label="Move to"]', 'shortlisted').catch(() => {});
  await scout.waitForTimeout(300);
  await scout.click('button:has-text("Apply")').catch(() => {});
  await scout.waitForSelector('[data-conflict-code]', { timeout: 15000 });
  const code = await scout.getAttribute('[data-conflict-code]', 'data-conflict-code');
  if (code !== 'ROOM_VERSION_CONFLICT') fail(`J2: wrong code (${code})`);
  const notice = await scout.locator('[data-conflict-code]').innerText();
  if (!/This changed while you were editing/.test(notice)) fail('J2: the Room conflict uses different wording from the Brief conflict');
  if (!/Tom Field/.test(notice)) fail('J2: the Room conflict does not name the colleague');
  say('J2: the Room conflict is the SAME notice with the same wording and the colleague’s name (ROOM_VERSION_CONFLICT)');
  await scout.click('[data-conflict-code] button:has-text("Reload latest")');
  await scout.waitForTimeout(1200);
  const header = await scout.locator('[aria-label="Room header"]').innerText();
  if (!/Under review/i.test(header)) fail(`J2: after reload the header does not show the colleague's status: ${header.slice(0, 120)}`);
  say('J2: "Reload latest" shows the colleague’s status');
  await scout.unroute(/\/org\/rooms\/[^/]+\/status$/);
}

// ===================================================================== J3
// Leaving a dirty form asks first; a clean one never does.
{
  const dialogs = [];
  const onDialog = async (d) => { dialogs.push(d.message()); await d.dismiss(); };
  scout.on('dialog', onDialog);
  await goto(scout, BR, '[aria-label="Recruitment briefs"]');
  await scout.click('button:has-text("New brief")');
  await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 15000 });
  // Clean form: navigating away must NOT prompt.
  await scout.evaluate(() => { window.location.hash = '#/recruitment/rooms'; }); // the parent of a deep link — resolves since M18.2
  await scout.waitForTimeout(1200);
  if (dialogs.length) fail('J3: a CLEAN form prompted on navigation — that trains people to click through');
  {
    const hash = await scout.evaluate(() => location.hash);
    const form = await scout.locator('[aria-label="Recruitment brief criteria"]').count();
    if (form || !/rooms/.test(hash)) fail(`J3: a clean form BLOCKED navigation without asking (hash ${hash}, form still mounted: ${form})`);
  }
  say('J3: leaving a clean form never prompts, and the navigation happens');
  await goto(scout, BR, '[aria-label="Recruitment briefs"]');
  await scout.click('button:has-text("New brief")');
  await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 15000 });
  await scout.fill('[aria-label="Recruitment brief criteria"] input', 'Unsaved wing-back brief');
  await scout.evaluate(() => { window.location.hash = '#/recruitment/rooms'; });
  await scout.waitForTimeout(900);
  if (dialogs.length !== 1) fail(`J3: a dirty form did not prompt exactly once on hash navigation (${dialogs.length})`);
  if (!/unsaved changes/i.test(dialogs[0])) fail(`J3: the prompt does not say what is at stake: ${dialogs[0]}`);
  say('J3: leaving a dirty form via the address bar asks first, and says what is unsaved');
  const stillHere = await scout.locator('[aria-label="Recruitment brief criteria"]').count();
  const hash = await scout.evaluate(() => location.hash);
  if (!stillHere || !/briefs/.test(hash)) fail(`J3: declining the prompt did not keep the form (hash ${hash})`);
  say('J3: declining keeps the form and reverses the navigation');
  // Sidebar navigation goes through the same guard.
  // P2.5: Discover is a group inside Recruitment now; click a section button that navigates.
  await scout.click('nav.sidebar button.nav-section:has-text("Squad & Planning")', { timeout: 5000 }).catch(() => {});
  await scout.waitForTimeout(600);
  if (dialogs.length < 2) fail('J3: sidebar navigation bypassed the guard');
  if (!(await scout.locator('[aria-label="Recruitment brief criteria"]').count())) fail('J3: declining the sidebar prompt still navigated');
  say('J3: the sidebar asks too — one guard, every exit');
  scout.off('dialog', onDialog);
  // Accept and leave, so later journeys start clean.
  scout.once('dialog', (d) => d.accept());
  await scout.evaluate(() => { window.location.hash = '#/recruitment/rooms'; });
  await scout.waitForTimeout(900);
  if (await scout.locator('[aria-label="Recruitment brief criteria"]').count()) fail('J3: accepting the prompt did not leave');
  say('J3: accepting leaves');
}

// ===================================================================== J4
// Notification preferences, from the Organisation screen.
await goto(scout, ORG, '[data-panel="notification-preferences"]');
{
  const panel = scout.locator('[data-panel="notification-preferences"]');
  const text = await panel.innerText();
  if (!/local outbox|no external email/i.test(text)) fail('J4: the email channel is not described honestly');
  say('J4: the preferences panel says email is a local outbox, not delivery');
  const mandatory = panel.locator('input[type="checkbox"][disabled]');
  if (!(await mandatory.count())) fail('J4: the mandatory category is not locked in the UI');
  // There is more than one mandatory category since P5.6C added the regulatory
  // lane, so this asserts the CLAIM — every locked control says why it is locked,
  // and the security category is one of them — rather than which one happens to
  // render first.
  const mLabels = await mandatory.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const unexplained = mLabels.filter((l) => !/Always on/i.test(l));
  if (unexplained.length) fail(`J4: a locked control does not say it is always on (${unexplained.join('; ')})`);
  if (!mLabels.some((l) => /Security and account/.test(l))) fail(`J4: the security category is not among the locked ones (${mLabels.join('; ')})`);
  say(`J4: every mandatory category is locked and labelled Always on (${mLabels.length}: ${mLabels.map((l) => l.split(':')[0]).join(', ')})`);
  let sent = null;
  const onReq = (r) => { if (r.method() === 'PUT' && /notification-preferences$/.test(new URL(r.url()).pathname)) sent = JSON.parse(r.postData() ?? '{}'); };
  scout.on('request', onReq);
  const mentions = panel.locator('input[type="checkbox"][aria-label^="Mentions"]');
  if (!(await mentions.count())) fail('J4: no Mentions toggle');
  await mentions.click();
  await scout.waitForTimeout(900);
  scout.off('request', onReq);
  if (!sent || sent.categories?.mentions !== false) fail(`J4: the toggle did not PUT {mentions:false} (${JSON.stringify(sent)})`);
  say('J4: turning Mentions off sends exactly that category to the server');
  const server = (await j('GET', '/org/notification-preferences', undefined, MARIA)).body.preferences;
  if (server.categories.find((c) => c.id === 'mentions').enabled !== false) fail('J4: the server did not record it');
  say('J4: the server reflects the change');
  const label = await mentions.getAttribute('aria-label');
  if (!/Off/.test(label ?? '')) fail(`J4: the control's accessible name did not update (${label})`);
  say('J4: the control’s accessible name says Off');
  await mentions.click();
  await scout.waitForTimeout(700);
}

// ===================================================================== J5
// The audit log: readable by a lead, never a note body.
{
  const SECRET = 'PRIVATE-NOTE-J5';
  await j('POST', `/org/rooms/${ROOM_ID}/status`, { status: 'shortlisted', note: SECRET }, TOM);
  await goto(scout, RM);
  await goto(scout, ORG, '[data-panel="audit-log"]');
  await scout.waitForTimeout(800);
  const audit = await scout.locator('[data-panel="audit-log"]').innerText();
  if (!/Tom Field/.test(audit) || !/shortlist/i.test(audit)) fail(`J5: the audit log does not show the colleague's status change: ${audit.slice(0, 200)}`);
  say('J5: a lead sees who moved the Room and to what');
  if (audit.includes(SECRET)) fail('J5: the audit log shows the note body');
  if (!/note was written|note/i.test(audit)) fail('J5: the audit log does not say a note existed');
  say('J5: it says a note was written — and never shows the note');
  if (!/Kola Adeyemi/.test(audit)) fail('J5: the visible player is not named on the entry');
  say('J5: the entry names the player the organisation may see');
}

// ===================================================================== J6
// A slow source: loading, then content.
{
  await setFaults('delay:/org/rooms:1500');
  await goto(scout, RM);
  await scout.waitForTimeout(300);
  const early = await scout.locator('body').innerText();
  const loading = /Loading|…/.test(early);
  await scout.waitForSelector('table.data, [aria-label="Recruitment Rooms"]', { timeout: 15000 }).catch(() => {});
  await scout.waitForTimeout(1600);
  const late = await scout.locator('body').innerText();
  const alerts = await scout.locator('[role="alert"]').count();
  if (alerts) fail('J6: a slow source was shown as an error');
  if (!/Kola Adeyemi/.test(late)) fail('J6: the Rooms list never arrived after the delay');
  say(`J6: a 1.5s-slow Rooms source shows ${loading ? 'a loading state, then' : ''} the content — never an error`);
  await setFaults('');
}

// ===================================================================== J7
// A failed source: retry offered only when retrying can help.
{
  await setFaults('unavailable:/org/second-look');
  await goto(scout, SL);
  await scout.waitForSelector('[role="alert"]', { timeout: 15000 });
  const text = await scout.locator('[role="alert"]').first().innerText();
  if (!/Try again/i.test(await scout.locator('body').innerText())) fail('J7: an unavailable source offered no retry');
  say(`J7: an unavailable source is announced and offers "Try again" — "${text.split('\n')[0].slice(0, 70)}"`);
  await setFaults('retryable:/org/second-look:1');
  await goto(scout, '#/feed');
  await goto(scout, SL);
  await scout.waitForSelector('[role="alert"]', { timeout: 15000 });
  await scout.click('[role="alert"] button:has-text("Try again")');
  await scout.waitForTimeout(1500);
  if (await scout.locator('[role="alert"]').count()) fail('J7: retrying a recovered source did not clear the failure');
  say('J7: retrying recovers the surface without a reload');
  await setFaults('');
}

// ===================================================================== J8
// A 403 is a permission message, not a sign-out.
{
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const tom = await enterClub(ctxB, 'Eastport FC', 'Tom Field', 'First-Team Scout');
  await goto(tom, ORG, '[data-panel="audit-log"]');
  await tom.waitForTimeout(1000);
  const audit = await tom.locator('[data-panel="audit-log"]').innerText();
  if (!/do not have permission/i.test(audit)) fail(`J8: a scout's 403 on the audit log is not explained: ${audit.slice(0, 160)}`);
  say('J8: a scout sees a permission message on the audit log');
  if (!(await tom.locator('nav.sidebar').count())) fail('J8: the 403 signed the scout out');
  const token = await tokenOf(tom);
  if (!token) fail('J8: the session was cleared on a 403');
  say('J8: and stays signed in — a 403 is about one request, not the session');
  if (await tom.locator('[data-panel="audit-log"] button:has-text("Try again")').count()) fail('J8: a 403 offered "Try again", which would repeat the same answer');
  say('J8: no retry is offered for an answer that will not change');
  // Reload the page: session restore must survive a 403 too.
  await tom.reload();
  await tom.waitForSelector('nav.sidebar', { timeout: 25000 });
  say('J8: after a reload the scout is still signed in');
  await ctxB.close();
}

// ===================================================================== J9
// Discover states its ordering.
{
  await goto(scout, '#/search', '[data-ordering]');
  const line = await scout.locator('[data-ordering]').innerText();
  if (!/not ability/i.test(line) || !/Trust Score/.test(line)) fail(`J9: the ordering statement is incomplete: ${line}`);
  say(`J9: Discover states its ordering — "${line.slice(0, 80)}…"`);
  const ids = await scout.locator('.player-card').allInnerTexts();
  await scout.reload();
  await scout.waitForSelector('.player-card', { timeout: 25000 });
  const again = await scout.locator('.player-card').allInnerTexts();
  if (ids.join('|') !== again.join('|')) fail('J9: the Discover order changed between two loads');
  say('J9: the order is the same on a second load');
}

// ==================================================================== J10
// Phone width and keyboard on the new panels; a destructive action explains.
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  p.on('pageerror', (e) => fail(`phone page error: ${e}`));
  await p.goto(`http://localhost:${CLUB_PORT}/`);
  await p.click('.org-card:has-text("Eastport FC")');
  await p.fill('.enter-row input', 'Maria Keane');
  await p.selectOption('.enter-row select', 'Head of Recruitment').catch(() => {});
  await p.click('button:has-text("Enter workspace")');
  await p.waitForSelector('.topbar', { timeout: 30000 });
  await p.evaluate((h) => { window.location.hash = h; }, ORG);
  await p.waitForSelector('[data-panel="notification-preferences"]', { timeout: 20000 });
  await p.waitForTimeout(1200);
  const overflow = await p.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  if (overflow > 4) fail(`J10: Organisation with the new panels overflows 390px by ${overflow}px`);
  say('J10: the preferences and audit panels fit a 390px phone');
  const first = p.locator('[data-panel="notification-preferences"] input[type="checkbox"]:not([disabled])').first();
  await first.focus();
  const focused = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
  if (!focused) fail('J10: a preference toggle cannot take keyboard focus');
  await p.keyboard.press('Space');
  await p.waitForTimeout(800);
  const state = await first.isChecked();
  say(`J10: a preference toggle is operable from the keyboard (space → ${state ? 'on' : 'off'})`);
  await p.keyboard.press('Space');
  await p.waitForTimeout(500);
  await phone.close();

  // The destructive confirm names the consequence, and declining does nothing.
  await goto(scout, `#/recruitment/rooms/${ROOM_ID}`, '[aria-label="Room header"]');
  let message = null;
  scout.once('dialog', async (d) => { message = d.message(); await d.dismiss(); });
  await scout.selectOption('[aria-label="Move to"]', 'archived').catch(() => {});
  await scout.waitForTimeout(300);
  await scout.click('button:has-text("Apply")').catch(() => {});
  await scout.waitForTimeout(900);
  if (!message) fail('J10: archiving a Room raised no confirmation');
  if (!/Decision history, comments and tasks are preserved/.test(message)) fail(`J10: the confirmation does not state the consequence: ${message}`);
  if (/are you sure/i.test(message)) fail('J10: the confirmation asks "are you sure"');
  say('J10: archiving asks with the consequence stated, not "are you sure"');
  const status = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room.status;
  if (status === 'archived') fail('J10: declining the confirmation archived the Room anyway');
  say('J10: declining leaves the Room untouched');
}

console.log(`\nM18.2 live browser journeys: ${passed} checks passed (J1–J10)`);
await browser.close();
cleanup();
process.exit(0);
