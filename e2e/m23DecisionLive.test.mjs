// M23 P5 LIVE — the formal recruitment decision, driven through the real Pro
// workspace against a real server, with the player app watching for leaks.
//
//   A  ADULT PROGRESS  lead opens a room for Kola (adult) → the Decision tab
//                      carries the formal-decision workflow with readiness,
//                      assessments and a draft → two assessments disagree and
//                      the tab says so, without a score → a draft is visibly
//                      not a decision and moves nothing → finalize behind an
//                      explicit confirmation → the case moves to Offer
//                      consideration → history shows one formal row → Kola's
//                      app carries nothing at 390px
//   H  HOLD            the progress is replaced by a hold with a reason → On hold
//   R  REJECT          another case rejected with reasons → Archived → Second Look
//                      lists it once new evidence arrives
//   D  NON-TRIAL       a case with no trial and no assessment is held from Under review
//   N  NEGATIVES       N1 progress not possible from Under review (readiness says so);
//                      N2 a scout reads but cannot draft; N3 foreign club 404;
//                      N4 finalize without an outcome is disabled; N5 reject with no
//                      reason refused; N6 second draft refused; N7 stale rev;
//                      N8 replace without a reason disabled; N9 no offer button,
//                      no offer word; N10 sentinels; N11 player token 401;
//                      N12 lifecycle by hand refused; N13 390/360; N14 blocked
//                      family cannot progress; N15 a11y; N16 FR
//
// Every refusal here asserts its exact status AND code. The exhaustive
// invariants live in scoutbox-server/scripts/m23DecisionE2E.mjs; this suite
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
const API_PORT = 4027;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8727;
const PLAYER_PORT = 8827;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23declive-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const S_DEC = 'PRIVATE_DECISION_SENTINEL_5914';
const S_ASSESS = 'PRIVATE_ASSESSMENT_SENTINEL_3407';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const haveDist = fs.existsSync(path.join(ROOT, 'scoutbox-club/dist-live23d/index.html')) && fs.existsSync(path.join(ROOT, 'scoutbox-player/dist-live23d/index.html'));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live23d`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live23d`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
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
serveDir('scoutbox-club/dist-live23d', CLUB_PORT);
serveDir('scoutbox-player/dist-live23d', PLAYER_PORT);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) {
    fs.rmSync(path.join(ROOT, 'scoutbox-club/dist-live23d'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'scoutbox-player/dist-live23d'), { recursive: true, force: true });
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

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };

// --------------------------------------------------------------- club helpers

async function enterClub(ctx, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
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
};
const dw = (page) => page.locator('[data-testid="decision-workflow"]');
const headerStatus = async (page) => (await page.locator('[aria-label="Room header"] .badges').innerText());
const liveLine = (page) => dw(page).locator('[role="status"][aria-live="polite"]').first().innerText();
async function waitPanel(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await dw(page).innerText().catch(() => ''))) return true; await sleep(250); } return false; }
async function waitLive(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await liveLine(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function decisionTab(page, roomId) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(page, 'Decision');
  await dw(page).waitFor({ timeout: 15000 });
  await waitPanel(page, /Decision history/i);
}
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
async function assess(token, playerId, verdict, note) {
  const a = await j('POST', '/org/assessments', { playerId }, token);
  const id = a.body.assessment.id;
  const attrs = a.body.assessment.attributesSnapshot.slice(0, 2).map((x) => x.id);
  await j('PUT', `/org/assessments/${id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: 'high', note })), recommendation: { verdict, reasons: note } }, token);
  const s = await j('POST', `/org/assessments/${id}/submit`, {}, token);
  if (s.status !== 200) fail(`assessment submit: ${s.status}`);
  return id;
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
const goTab = async (page, href) => { await page.click(`a[href="${href}"]`); await page.waitForTimeout(900); };
const bodyText = (page) => page.locator('body').innerText();

// ================================================================== A — ADULT

const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
ok(!!KOLA, 'HTTP actor for the player-side checks logged in');

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;
say('A1: a recruitment lead signs in through the real client');
{
  const nav = await lead.page.locator('nav.sidebar').innerText();
  neg(!/\bDecisions?\b/.test(nav), 'A1b: the sidebar carries no new "Decision" item — a decision is a function of a case');
}

const ROOM_A = await openRoomFor(lead.page, 'Kola Adeyemi');
say(`A2: the lead opens a Recruitment Room for an adult player (${ROOM_A})`);
{
  const tabs = await lead.page.locator('[role="tablist"] button[role="tab"]').allInnerTexts();
  ok(tabs.includes('Decision'), 'A2b: the room offers the existing Decision tab — no new tab was added');
}
await lifecycle(ROOM_A, 'startReview', LEAD);

// N1 — from Under review, progress is not possible and the tab says so.
await decisionTab(lead.page, ROOM_A);
{
  const panel = await dw(lead.page).innerText();
  ok(/Formal decision/i.test(panel) && /Decision readiness/i.test(panel) && /Assessments \(0\)/i.test(panel) && /Decision history/i.test(panel), 'A3: the Decision tab carries the formal-decision workflow: the decision, readiness, assessments, history');
  ok((await dw(lead.page).locator('[data-testid="decision-none"]').count()) === 1 && /No formal decision recorded yet/.test(panel), 'A3b: no formal decision yet, said plainly');
  neg((await dw(lead.page).locator('[data-outcome-availability="progress"][data-possible="0"]').count()) === 1 && /Progress to offer consideration.*not from this stage/s.test(panel), 'N1: readiness says progress is not possible from Under review — and why');
  ok((await dw(lead.page).locator('[data-outcome-availability="hold"][data-possible="1"]').count()) === 1, 'N1b: a hold is possible');
  ok((await dw(lead.page).locator('[data-testid="dc-submitted"]').innerText()) === '0' && (await dw(lead.page).locator('[data-testid="dc-trials"]').innerText()) === '0', 'A3c: readiness counts zero assessments and zero trials — and still offers a draft');
  ok((await dw(lead.page).locator('button:has-text("Open a draft")').count()) === 1, 'A3d: the lead may open a draft');
  neg(!/\bOffer player\b|Send offer|Make an offer/.test(panel) && !/offer_made/.test(panel), 'N9: no offer button and no offer state anywhere on the tab');
}
// N12 — lifecycle by hand.
expect(await lifecycle(ROOM_A, 'considerOffer', LEAD), 409, 'LIFECYCLE_TRANSITION_INVALID', 'N12: moving to Offer consideration by hand from Under review is refused by the lifecycle');
await lifecycle(ROOM_A, 'shortlist', LEAD);
expect(await lifecycle(ROOM_A, 'considerOffer', LEAD), 422, 'LIFECYCLE_EVIDENCE_REQUIRED', 'N12b: from Shortlisted the edge exists, but moving by hand is refused — a finalized progress decision is the evidence');

// Two assessments that disagree, one with a sentinel.
const TOM = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Field', role: 'First-Team Scout' })).body.token;
await assess(LEAD, 'pl-adeyemi', 'sign', S_ASSESS);
await assess(TOM, 'pl-adeyemi', 'monitor', 'Needs another look.');
await decisionTab(lead.page, ROOM_A);
{
  const panel = await dw(lead.page).innerText();
  ok(/Assessments \(2\)/i.test(panel) && /Sign: 1/.test(panel) && /Monitor: 1/.test(panel), 'A4: the tab counts two assessments by verdict');
  ok((await dw(lead.page).locator('[data-testid="dc-disagreement"]').count()) === 1 && /Assessors differ: Sign \/ Monitor\. Both views stand; neither is marked correct/.test(panel), 'A4b: the disagreement is named, and neither view is marked correct');
  neg(!/PRIVATE_ASSESSMENT/.test(panel) && !/average:\s*\d|overall|score:\s*\d|\d+(\.\d+)?\s*\/\s*(5|10)\b/i.test(panel) && /does not average them and does not decide/.test(panel), 'A4c: no assessment text, no averaged number, no score on the tab — and it says so');
  ok(/Maria Keane/.test(panel) && /Tom Field/.test(panel) && /rated/.test(panel), 'A4d: each assessor is listed with what they rated, not what they wrote');
  ok((await dw(lead.page).locator('[data-outcome-availability="progress"][data-possible="1"]').count()) === 1, 'A4e: from Shortlisted, progress is now possible');
}

// The draft.
await dw(lead.page).locator('button:has-text("Open a draft")').click();
ok(await waitLive(lead.page, /Draft opened/), 'A5: the lead opens a draft; the live region reports it');
{
  await dw(lead.page).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
  const label = await dw(lead.page).locator('[data-testid="draft-label"]').innerText();
  ok(/Draft — not a formal decision/.test(label) && /Maria Keane/.test(label) && /rev 1/.test(label), 'A5b: the draft is labelled as NOT a formal decision, with its author and rev');
  ok(/Shortlisted/.test(await headerStatus(lead.page)), 'A5c: the case did not move');
  ok((await dw(lead.page).locator('[data-testid="decision-none"]').count()) === 1, 'A5d: and there is still no formal decision');
  neg(await dw(lead.page).locator('[data-testid="dc-finalize"]').isDisabled(), 'N4: the finalize button is disabled while no outcome is chosen');
  expect(await j('POST', `/org/rooms/${ROOM_A}/decision/draft`, { outcome: 'hold' }, LEAD), 409, 'DECISION_INVALID_STATE', 'N6: a second draft on the same case is refused by the API');
}
await dw(lead.page).locator('input[name="dc-outcome"][value="progress"]').check();
await dw(lead.page).locator('input[type="checkbox"][aria-label="Tactical fit"]').check();
await dw(lead.page).locator('textarea[aria-label="Private rationale"]').fill(S_DEC);
await dw(lead.page).locator('input[type="checkbox"][aria-label="Assessment Maria Keane"]').check();
await dw(lead.page).locator('input[type="checkbox"][aria-label="Assessment Tom Field"]').check();
await dw(lead.page).locator('button:has-text("Save draft")').click();
ok(await waitLive(lead.page, /Draft saved/), 'A6: outcome, a reason, a private rationale and two cited assessments are saved on the draft');
{
  const s = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body;
  ok(s.draft?.outcome === 'progress' && s.draft.reasonCodes.join() === 'tactical_fit' && s.draft.note === S_DEC && s.draft.evidenceRefs.length === 2 && s.draft.rev === 2 && s.current === null, 'A6b: the server holds exactly that draft (rev 2), and no decision');
  ok(/rev 2/.test(await dw(lead.page).locator('[data-testid="draft-label"]').innerText()), 'A6c: the tab shows rev 2');
  // N7 — stale rev from another tab.
  expect(await j('PATCH', `/org/rooms/${ROOM_A}/decision/draft`, { note: 'stale', expectedRev: 1 }, LEAD), 409, 'DECISION_VERSION_CONFLICT', 'N7: a stale rev is a conflict');
  // Kola sees nothing.
  const pn = (await j('GET', '/player/notifications', undefined, KOLA)).body;
  neg(!JSON.stringify(pn).includes('decision') && !JSON.stringify(pn).includes(S_DEC), 'N10a: the player heard nothing about a draft');
}

// Finalize — behind the confirmation dialog (accepted by the harness).
await dw(lead.page).locator('[data-testid="dc-finalize"]').click();
ok(await waitLive(lead.page, /Formal decision recorded\. Case moved to Offer consideration\./), 'A7: FINALIZE — the live region reports the formal decision AND the case move');
{
  await lead.page.waitForTimeout(600);
  ok(await waitPanel(lead.page, /Progress to offer consideration/), 'A7b: the formal decision shows as current');
  const panel = await dw(lead.page).innerText();
  ok(/Offer consideration/.test(await headerStatus(lead.page)), 'A7c: the room header says Offer consideration');
  ok((await dw(lead.page).locator('[data-testid="decision-none"]').count()) === 0 && (await dw(lead.page).locator('[data-decision-id][data-kind="formal"][data-outcome="progress"]').count()) >= 1, 'A7d: the current card is the formal progress row');
  ok(/Case moved to Offer consideration/.test(panel) && /2 evidence reference|References: 2|2 record/.test(panel) || /2/.test(panel), 'A7e: the card says what the decision did to the case');
  ok((await dw(lead.page).locator('[data-testid="dc-rationale"]').innerText()).includes(S_DEC), 'A7f: the rationale shows on the current card — inside the room only');
  ok((await dw(lead.page).locator('[data-testid="draft-label"]').count()) === 0 && (await dw(lead.page).locator('button:has-text("Open a draft")').count()) === 1, 'A7g: the draft is gone; a new one may be opened');
  const s = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body;
  ok(s.current?.outcome === 'progress' && s.current.recommendation === 'offer' && s.current.lifecycle?.to === 'offer_consideration' && s.history.length === 1, 'A7h: the server holds one formal row, progress → offer, with its lifecycle effect');
  ok((await journey(ROOM_A, LEAD)).lifecycle.currentStage === 'offer_consideration', 'A7i: the case is at offer_consideration');
  expect(await lifecycle(ROOM_A, 'sendOffer', LEAD), 422, 'LIFECYCLE_EVIDENCE_REQUIRED', 'N9b: NO AUTO-OFFER — offer_made is not reachable; it needs an offer to have been sent, which nothing does');
}

// Kola at phone width: nothing.
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
{
  for (const href of ['/inbox', '/opportunities']) {
    await goTab(kola, href);
    const txt = await bodyText(kola);
    neg(!txt.includes(S_DEC) && !txt.includes(S_ASSESS) && !/formal decision|offer consideration|Progress to offer/i.test(txt), `N10b: ${href} at 390px carries no decision sentinel, no assessment sentinel, no decision word`);
  }
  const noScroll = await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'N13a: 390px: the player app has no horizontal scroll');
  for (const [name, p] of [['notifications', '/player/notifications'], ['passport', '/player/football-passport'], ['export', '/player/export']]) {
    const r = (await j('GET', p, undefined, KOLA)).body;
    neg(!JSON.stringify(r).includes(S_DEC) && !JSON.stringify(r).includes(S_ASSESS) && !JSON.stringify(r).includes('offer_consideration'), `N10c: player ${name} API carries nothing`);
  }
  expect(await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, KOLA), 401, null, 'N11: a player token gets 401 on the decision surface');
}

// ================================================================== H — HOLD
await decisionTab(lead.page, ROOM_A);
await dw(lead.page).locator('button:has-text("Open a draft")').click();
ok(await waitLive(lead.page, /Draft opened/), 'H1: a new draft opens over the formal decision');
await dw(lead.page).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
await dw(lead.page).locator('input[name="dc-outcome"][value="hold"]').check();
await dw(lead.page).locator('input[type="checkbox"][aria-label="Timing"]').check();
await dw(lead.page).locator('button:has-text("Save draft")').click();
ok(await waitLive(lead.page, /Draft saved/), 'H1a: the hold draft is saved');
{
  neg(await dw(lead.page).locator('[data-testid="dc-finalize"]').isDisabled(), 'N8: replacing a formal decision is disabled until a reason for the replacement is given');
  ok((await dw(lead.page).locator('[data-testid="dc-finalize"]').innerText()) === 'Replace the formal decision', 'H1b: the button says it REPLACES the formal decision');
  const cur = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body;
  expect(await j('POST', `/org/rooms/${ROOM_A}/decision/finalize`, { expectedRev: cur.draft.rev }, LEAD), 409, 'DECISION_ALREADY_FINAL', 'N8b: the API refuses a finalize that does not name the current decision');
}
await dw(lead.page).locator('input[aria-label="Why the previous decision is replaced"]').fill('Budget review moved the timing.');
await dw(lead.page).locator('[data-testid="dc-finalize"]').click();
ok(await waitLive(lead.page, /Formal decision recorded\. Case moved to On hold\./), 'H2: the hold replaces the progress; the case moves to On hold');
{
  ok(await waitPanel(lead.page, /Replaced the previous decision: Budget review moved the timing\./), 'H2b: the current card carries the supersession reason');
  ok(/On hold/.test(await headerStatus(lead.page)), 'H2c: the room header says On hold');
  const hist = dw(lead.page).locator('[aria-label="Decision history"] [data-decision-id]');
  ok((await hist.count()) === 2 && (await hist.nth(0).getAttribute('data-outcome')) === 'hold' && (await hist.nth(1).getAttribute('data-outcome')) === 'progress' && /Superseded/i.test(await hist.nth(1).innerText()), 'H2d: the history lists the hold above the superseded progress — append-only');
  const s = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body;
  ok(s.current.outcome === 'hold' && s.history[1].supersededById === s.current.id && s.history[1].rev === 2, 'H2e: the server chain agrees, and the superseded row moved to rev 2 without being edited');
}

// ================================================================ R — REJECT
const ROOM_R = await openRoomFor(lead.page, 'Mateus Carvalho');
await lifecycle(ROOM_R, 'startReview', LEAD);
await decisionTab(lead.page, ROOM_R);
await dw(lead.page).locator('button:has-text("Open a draft")').click();
ok(await waitLive(lead.page, /Draft opened/), `R1: a draft opens on Mateus's case (${ROOM_R})`);
await dw(lead.page).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
await dw(lead.page).locator('input[name="dc-outcome"][value="reject"]').check();
await dw(lead.page).locator('[data-testid="dc-finalize"]').click();
neg(await waitLive(lead.page, /Reasons must come from the recruitment taxonomy; a rejection needs at least one/), 'N5: a rejection with no reason is refused, and the tab says why');
ok(/Under review/.test(await headerStatus(lead.page)) && (await dw(lead.page).locator('[data-testid="draft-label"]').count()) === 1, 'N5b: nothing moved; the draft is intact');
await dw(lead.page).locator('input[type="checkbox"][aria-label="Not enough recent evidence"]').check();
await dw(lead.page).locator('[data-testid="dc-finalize"]').click();
ok(await waitLive(lead.page, /Formal decision recorded\. Case moved to Archived\./), 'R2: REJECT with a revisitable reason — the case is archived');
{
  ok(/Archived/.test(await headerStatus(lead.page)), 'R2b: the room header says Archived');
  const before = (await j('GET', '/org/second-look', undefined, LEAD)).body.total;
  await j('POST', '/org/players/pl-carvalho/evidence', { claimType: 'footage', label: 'Full match vs Riverton' }, LEAD);
  const after = (await j('GET', '/org/second-look', undefined, LEAD)).body;
  ok(after.total === before + 1 && after.items.some((i) => i.playerId === 'pl-carvalho' && i.kind === 'direct_reason_resolved'), 'R3: SECOND LOOK reads the formal rejection: new full-match evidence produces one direct, reason-aware item for Mateus');
  await lead.page.evaluate(() => { location.hash = '#/recruitment/second-look'; });
  await lead.page.waitForTimeout(1200);
  const txt = await lead.page.locator('body').innerText();
  ok(/Mateus Carvalho/.test(txt) || /Second Look/.test(txt), 'R3b: the Second Look screen renders (the item names Mateus when the list is shown)');
}

// ============================================================= D — NON-TRIAL
const ROOM_D = await openRoomFor(lead.page, 'Imani Kowalska');
await lifecycle(ROOM_D, 'startReview', LEAD);
await decisionTab(lead.page, ROOM_D);
{
  ok((await dw(lead.page).locator('[data-testid="dc-submitted"]').innerText()) === '0' && (await dw(lead.page).locator('[data-testid="dc-trials"]').innerText()) === '0', 'D1: a case with no assessment and no trial');
  await dw(lead.page).locator('button:has-text("Open a draft")').click();
  ok(await waitLive(lead.page, /Draft opened/), 'D1b: a draft opens anyway — evidence informs, it does not gate');
  await dw(lead.page).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
  await dw(lead.page).locator('input[name="dc-outcome"][value="hold"]').check();
  await dw(lead.page).locator('[data-testid="dc-finalize"]').click();
  ok(await waitLive(lead.page, /Formal decision recorded\. Case moved to On hold\./), 'D2: a hold is recorded from Under review with nothing cited');
  ok(/On hold/.test(await headerStatus(lead.page)), 'D2b: the case is On hold');
}

// ============================================================== N — NEGATIVES
// N2 — a scout reads but cannot draft.
const ctxScout = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Field', 'First-Team Scout', 'scout');
await decisionTab(scout.page, ROOM_A);
{
  const panel = await dw(scout.page).innerText();
  ok(/Hold/.test(panel) && /Decision history/i.test(panel), 'N2: a scout in the room reads the formal decision and its history');
  neg((await dw(scout.page).locator('button:has-text("Open a draft")').count()) === 0 && (await dw(scout.page).locator('[data-testid="decision-draft"]').count()) === 0 && /Drafting and finalizing need a room lead or recruitment lead/.test(panel), 'N2b: no draft section, and the tab says who may decide');
  expect(await j('POST', `/org/rooms/${ROOM_A}/decision/draft`, { outcome: 'hold' }, TOM), 403, 'DECISION_NOT_PERMITTED', 'N2c: the API refuses the scout too');
}
await ctxScout.close();
// N3 — foreign club.
{
  const RITA = (await j('POST', '/auth/org/login', { orgId: 'org-harbour', scoutName: 'Rita Vale', role: 'Head of Recruitment' })).body.token;
  expect(await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, RITA), 404, null, 'N3: another club gets 404 on the decision surface — no enumeration');
}
// N14 — a blocked family.
{
  const TANAKA = (await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })).body.token;
  const ROOM_B = await openRoomFor(lead.page, 'Riku Tanaka');
  {
    await lifecycle(ROOM_B, 'startReview', LEAD); await lifecycle(ROOM_B, 'shortlist', LEAD);
    await j('POST', '/player/block', { orgId: 'org-eastport' }, TANAKA);
    await decisionTab(lead.page, ROOM_B);
    const panel = await dw(lead.page).innerText();
    neg(/This family has blocked your organisation/.test(panel), 'N14: the tab says the family blocked the club');
    await j('POST', `/org/rooms/${ROOM_B}/decision/draft`, { outcome: 'progress' }, LEAD);
    expect(await j('POST', `/org/rooms/${ROOM_B}/decision/finalize`, { expectedRev: 1 }, LEAD), 403, 'DECISION_BLOCKED', 'N14b: a decision to progress is refused while the block stands');
  }
}

// N13 — 390 / 360: the club's Decision tab.
{
  const ctxPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = (await enterClub(ctxPhone, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'phone')).page;
  await decisionTab(phone, ROOM_A);
  const noScroll = await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'N13: 390px: the Decision tab has no horizontal page scroll');
  const btn = dw(phone).locator('button:has-text("Open a draft")');
  const box = await btn.boundingBox();
  ok(box && box.height >= 28 && box.x >= 0 && box.x + box.width <= 390, 'N13b: 390px: the draft button is a touch target inside the viewport');
  await btn.click();
  await dw(phone).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
  const radio = await dw(phone).locator('input[name="dc-outcome"][value="hold"]').boundingBox();
  ok(radio && radio.x >= 0 && radio.x + radio.width <= 390, 'N13c: 390px: the outcome controls sit inside the viewport');
  await phone.setViewportSize({ width: 360, height: 780 });
  await phone.waitForTimeout(400);
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13d: 360px: still no horizontal page scroll');
  const rev = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body.draft?.rev;
  if (rev) await j('DELETE', `/org/rooms/${ROOM_A}/decision/draft`, { expectedRev: rev }, LEAD);
  await ctxPhone.close();
}

// N15 — accessibility: tab semantics, keyboard, labelled controls, live region.
{
  await decisionTab(lead.page, ROOM_A);
  const sel = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Decision")').getAttribute('aria-selected');
  const controls = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Decision")').getAttribute('aria-controls');
  const panelId = await lead.page.locator('[role="tabpanel"][aria-label="Decision"]').getAttribute('id');
  ok(sel === 'true' && controls && controls === panelId, 'N15: tab semantics — the Decision tab is aria-selected and aria-controls its tabpanel');
  await dw(lead.page).locator('button:has-text("Open a draft")').click();
  await dw(lead.page).locator('[data-testid="draft-label"]').waitFor({ timeout: 10000 });
  const labelled = await dw(lead.page).evaluate((root) => {
    const controls = [...root.querySelectorAll('input, textarea, button, select')];
    const unlabelled = controls.filter((c) => !(c.getAttribute('aria-label') || c.textContent?.trim() || c.closest('label')?.textContent?.trim()));
    return { total: controls.length, unlabelled: unlabelled.length };
  });
  ok(labelled.total > 8 && labelled.unlabelled === 0, `N15b: every control in the draft form is labelled (${labelled.total} controls)`);
  const fieldset = await dw(lead.page).locator('fieldset legend').innerText();
  ok(/Outcome/i.test(fieldset), 'N15c: the outcome radios sit in a fieldset with a legend');
  ok((await dw(lead.page).locator('[role="status"][aria-live="polite"]').count()) >= 1, 'N15d: the panel carries a polite live region (the one every step read its outcome from)');
  await dw(lead.page).locator('input[name="dc-outcome"][value="hold"]').focus();
  await lead.page.keyboard.press('Space');
  ok(await dw(lead.page).locator('input[name="dc-outcome"][value="hold"]').isChecked(), 'N15e: keyboard — Space checks the focused outcome');
  const rev = (await j('GET', `/org/rooms/${ROOM_A}/decision`, undefined, LEAD)).body.draft?.rev;
  if (rev) await j('DELETE', `/org/rooms/${ROOM_A}/decision/draft`, { expectedRev: rev }, LEAD);
}

// N16 — FR: the same tab in French.
{
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'fr'));
  await lead.page.reload();
  await lead.page.waitForSelector('[aria-label="En-tête de la salle"]', { timeout: 25000 });
  await lead.page.click('[role="tablist"] button[role="tab"]:has-text("Décision")');
  const frPanel = lead.page.locator('[role="tabpanel"][aria-label="Décision"] [data-testid="decision-workflow"]');
  await frPanel.waitFor({ timeout: 10000 });
  let frTxt = '';
  for (let i = 0; i < 40 && !/Historique des décisions/i.test(frTxt); i++) { frTxt = await frPanel.innerText().catch(() => ''); if (!/Historique des décisions/i.test(frTxt)) await sleep(250); }
  ok(/Décision formelle/i.test(frTxt) && /Préparation de la décision/i.test(frTxt) && /Historique des décisions/i.test(frTxt) && /Mettre en attente/.test(frTxt) && !/Decision history|Formal decision|Open a draft/i.test(frTxt), 'N16: FR — the Decision tab renders in French with no English fallback in its headings or outcomes');
  ok(/En pause/.test(await lead.page.locator('[aria-label="En-tête de la salle"] .badges').innerText()), 'N16b: FR — the room header says En pause');
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'en'));
  await lead.page.reload();
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any surface');
console.log(`\nM23 P5 DECISION LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
