// M23 P6 LIVE — the canonical Offer, driven through the real Pro workspace,
// the real player app, the real agent app and the guardian screen against a
// real server.
//
//   A  CLUB ISSUES     lead opens a room for Kola (adult) → the case reaches
//                      Offer consideration through P5 → the Offer tab shows
//                      no Offer and says drafting is possible → a DRAFT is
//                      opened and edited (terms, expiry, message, an internal
//                      note sentinel) → issued behind an explicit confirmation
//                      → the case moves to Offer made → history shows Issued
//   B  PLAYER ACCEPTS  Kola at 390px sees the exact revision, its expiry and
//                      the message — never the note — and accepts behind a
//                      second explicit step that says it is not a signing →
//                      "Offer accepted — signing pending"; nothing says signed
//   C  CLUB READS      the Offer tab shows Accepted — signing pending, the
//                      response row, no issue/withdraw control
//   D  DECLINE         a second case (Kim): issued → declined with a reason at
//                      360px → the club reads the decline and the reason
//   E  AGENT           Ana (licensed, Kola's agent) sees nothing until Kola
//                      shares from his app → then the Offers tab under the
//                      client shows terms and state, read-only; Bea (same
//                      agency) sees no such client; no accept control anywhere
//   F  GUARDIAN/MINOR  Guni's case at Offer consideration: the Offer tab names
//                      MINOR_PATHWAY_CLOSED and the Issue button is disabled;
//                      Amara's guardian screen lists no Offer
//   N  NEGATIVES       a scout reads but cannot draft; a foreign club 404;
//                      lifecycle by hand refused; widths 1440/1280/1024/768/390/360;
//                      a11y; FR; sentinel sweeps across every page
//
// Every refusal here asserts its exact status AND code. The exhaustive
// invariants live in scoutbox-server/scripts/m23OfferE2E.mjs; this suite proves
// the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4028;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8728;
const PLAYER_PORT = 8828;
const AGENT_PORT = 8928;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23offerlive-'));
const S_NOTE = 'PRIVATE_OFFER_NOTE_SENTINEL_7731';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_5914';
const S_MSG = 'RECIPIENT_MESSAGE_VISIBLE_4402';
const DAY = 86_400_000;

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

for (const port of [API_PORT, CLUB_PORT, PLAYER_PORT, AGENT_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live23o';
const bundles = [['scoutbox-club', CLUB_PORT], ['scoutbox-player', PLAYER_PORT], ['scoutbox-agent', AGENT_PORT]];
const haveDist = bundles.every(([app]) => fs.existsSync(path.join(ROOT, app, DIST, 'index.html')));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  for (const [app] of bundles) {
    if (app === 'scoutbox-player') execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else execSync(`VITE_API_URL=${API} npx vite build --outDir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
  }
}

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1' },
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
for (const [app, port] of bundles) serveDir(`${app}/${DIST}`, port);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) for (const [app] of bundles) fs.rmSync(path.join(ROOT, app, DIST), { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
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
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
/** The player app keeps inactive tab screens mounted but hidden, so a section is read through its own locator, never the body. */
async function waitIn(loc, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await loc.innerText().catch(() => ''))) return true; await sleep(250); } return false; }

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
const ow = (page) => page.locator('[data-testid="offer-workflow"]');
const headerStatus = async (page) => (await page.locator('[aria-label="Room header"] .badges').innerText());
const liveLine = (page) => ow(page).locator('[role="status"][aria-live="polite"]').first().innerText();
async function waitPanel(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await ow(page).innerText().catch(() => ''))) return true; await sleep(250); } return false; }
async function waitLive(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await liveLine(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function offerTab(page, roomId) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(page, 'Offer');
  await ow(page).waitFor({ timeout: 15000 });
  await waitPanel(page, /Offer readiness/i);
}
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
/** The P5 path with no trial (HTTP): shortlist → draft progress → finalize → offer_consideration. */
async function toConsideration(RID, token) {
  if ((await journey(RID, token)).lifecycle.currentStage === 'watching') await lifecycle(RID, 'startReview', token);
  if ((await journey(RID, token)).lifecycle.currentStage === 'under_review') await lifecycle(RID, 'shortlist', token);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: `live-${RID}` }, token);
  if (fin.status !== 201) fail(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
}
const localInput = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

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

// ------------------------------------------------------------- agent helpers

async function enterAgent(ctx, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${AGENT_PORT}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click('.org-card:has-text("North Star")');
  await page.fill('.enter-row input[aria-label]', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}
const go = async (page, hash) => {
  await page.evaluate((h) => { if (location.hash === h) location.hash = '#/home'; }, hash);
  await sleep(200);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(600);
};

// ------------------------------------------------------------------ fixture
// A licensed agent representing Kola (HTTP), so the agent app has a real client.
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const anaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-ENG', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const conf = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, KOLA);
ok(!!REL && conf.status === 200, 'fixture: Ana represents Kola (employment), client-confirmed');

// ================================================================== A — CLUB ISSUES

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;
const ROOM_A = await openRoomFor(lead.page, 'Kola Adeyemi');
ok(/^case-/.test(ROOM_A), `A1: the lead opened a room for Kola (${ROOM_A})`);
await offerTab(lead.page, ROOM_A);
{
  const txt = await ow(lead.page).innerText();
  ok((await ow(lead.page).locator('[data-testid="offer-none"]').count()) === 1 && /No Offer on this case/.test(txt), 'A2: the Offer tab of a fresh case: no Offer');
  const avail = ow(lead.page).locator('[data-testid="offer-draft-availability"]');
  ok((await avail.getAttribute('data-possible')) === '0' && /not at Offer consideration|finalized decision/i.test(await avail.innerText()), 'A2b: readiness says why drafting is not possible yet (case state, decision) — and there is no draft button');
  neg((await ow(lead.page).locator('[data-testid="offer-start"]').count()) === 0, 'A2c: NO AUTO-OFFER and no draft button before the decision exists');
}
await toConsideration(ROOM_A, LEAD);
await offerTab(lead.page, ROOM_A);
{
  ok(/Offer consideration/.test(await headerStatus(lead.page)), 'A3: the case reached Offer consideration through P5');
  neg((await ow(lead.page).locator('[data-testid="offer-none"]').count()) === 1, 'A3b: and STILL no Offer exists — the decision created none');
  const avail = ow(lead.page).locator('[data-testid="offer-draft-availability"]');
  ok((await avail.getAttribute('data-possible')) === '1', 'A3c: readiness now says drafting is possible');
  await ow(lead.page).locator('[data-testid="offer-start"]').click();
  ok(await waitLive(lead.page, /Offer draft opened. Nothing has been sent/), 'A4: the lead drafts an Offer — an explicit act — and the live region says nothing was sent');
  await ow(lead.page).locator('[data-testid="offer-draft-label"]').waitFor({ timeout: 10000 });
  ok(/Draft — not issued, not seen by the player/.test(await ow(lead.page).locator('[data-testid="offer-draft-label"]').innerText()), 'A4b: the draft is labelled as not issued and not seen by the player');
  ok(/○ Draft — not issued/.test(await ow(lead.page).locator('[data-testid="offer-status"]').innerText()), 'A4c: the status pill carries a glyph and the word Draft (text + state, not colour)');
  ok(/Offer consideration/.test(await headerStatus(lead.page)), 'A4d: a draft moved nothing');
  await ow(lead.page).locator('input[aria-label="Role"]').fill('Central midfielder');
  await ow(lead.page).locator('input[aria-label="Squad"]').fill('Under-23s');
  await ow(lead.page).locator('input[aria-label="Start day"]').fill('2027-07-01');
  await ow(lead.page).locator('input[aria-label="End day"]').fill('2029-06-30');
  await ow(lead.page).locator('input[aria-label="Offer expires"]').fill(localInput(Date.now() + 10 * DAY));
  await ow(lead.page).locator('textarea[aria-label="Conditions"]').fill('Subject to a medical.');
  await ow(lead.page).locator('textarea[aria-label="Message to the player"]').fill(S_MSG);
  await ow(lead.page).locator('[data-testid="offer-internal-note"]').fill(S_NOTE);
  await ow(lead.page).locator('[data-testid="offer-save"]').click();
  ok(await waitLive(lead.page, /Draft saved/), 'A5: the draft is saved');
  const s = (await j('GET', `/org/rooms/${ROOM_A}/offers`, undefined, LEAD)).body;
  ok(s.offers.length === 1 && s.offers[0].status === 'DRAFT' && s.offers[0].currentRevision.terms.role === 'Central midfielder' && s.offers[0].currentRevision.internalNote === S_NOTE && s.offers[0].currentRevision.recipientMessage === S_MSG, 'A5b: the server holds one DRAFT with exactly what was typed');
  neg((await j('GET', '/player/offers', undefined, KOLA)).body.items.length === 0, 'A5c: Kola\'s Offers are empty — a draft is invisible');
  const issueBtn = ow(lead.page).locator('[data-testid="offer-issue"]');
  ok((await issueBtn.count()) === 1 && !(await issueBtn.isDisabled()), 'A6: the Issue button is enabled (nothing blocks)');
  await issueBtn.click();
  ok(await waitLive(lead.page, /Offer issued. Case moved to Offer made/), 'A7: ISSUE behind the confirmation — the live region says the case moved to Offer made');
  ok(/Offer made/.test(await headerStatus(lead.page)), 'A7b: the room header says Offer made');
  ok(/➤ Issued — awaiting response/.test(await ow(lead.page).locator('[data-testid="offer-status"]').innerText()), 'A7c: the status pill reads Issued — awaiting response');
  ok(/Awaiting the player’s answer/.test(await ow(lead.page).locator('[data-testid="offer-awaiting"]').innerText()), 'A7d: the tab says who must respond');
  neg((await ow(lead.page).locator('[data-testid="offer-draft"]').count()) === 0 && (await ow(lead.page).locator('[data-testid="offer-issue"]').count()) === 0, 'A7e: the editor is gone — issued terms are immutable');
  const hist = await ow(lead.page).locator('[data-testid="offer-history"]').innerText();
  ok(/Issued/.test(hist) && /Draft opened/.test(hist) && /Draft edited/.test(hist), 'A7f: history: draft opened, edited, issued');
  ok(/🔒 PRIVATE_OFFER_NOTE_SENTINEL_7731/.test(await ow(lead.page).locator('[data-testid="offer-revisions"]').innerText()), 'A7g: the club reads its own internal note on the revision');
  ok((await ow(lead.page).locator('[data-testid="offer-withdraw"]').count()) === 1 && (await ow(lead.page).locator('[data-testid="offer-revise"]').count()) === 1, 'A7h: withdraw and new-revision controls are offered to the lead');
  expect(await lifecycle(ROOM_A, 'recordOfferAccepted', LEAD), 422, 'LIFECYCLE_EVIDENCE_REQUIRED', 'N12: the club naming recordOfferAccepted by hand is refused — only the recipient\'s answer is evidence');
}

// ================================================================== B — PLAYER ACCEPTS

const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
{
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="offer-section"]');
  await sec.waitFor({ timeout: 20000 });
  ok(await waitIn(sec, /Offers/i), 'B1: Kola\'s Opportunities carries the Offers section at 390px');
  const txt = await sec.innerText();
  ok(/Eastport FC/.test(txt) && /Awaiting your answer/.test(txt) && /Revision 1/.test(txt) && /Central midfielder/.test(txt) && /Under-23s/.test(txt) && /2027-07-01/.test(txt) && /Expires/.test(txt), 'B2: the exact revision: club, revision 1, terms, expiry');
  ok(txt.includes(S_MSG), 'B2b: the club\'s message reaches the player');
  neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC) && !/internal note|decision/i.test(txt), 'B2c: the internal note and the decision never reach the player');
  ok(await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13a: 390px: no horizontal scroll');
  const offerId = (await j('GET', '/player/offers', undefined, KOLA)).body.items[0].id;
  neg((await sec.locator(`[data-testid="offer-confirm-${offerId}"]`).count()) === 0, 'B3: nothing is accepted by one tap: no confirmation box is open');
  await sec.locator(`[data-testid="offer-accept-${offerId}"]`).click();
  await sec.locator(`[data-testid="offer-confirm-${offerId}"]`).waitFor({ timeout: 10000 });
  const warn = await sec.locator(`[data-testid="offer-confirm-${offerId}"]`).innerText();
  ok(/accepting revision 1 exactly as written/i.test(warn) && /not a signature/i.test(warn), 'B4: the second step says what accepting is — and that it is not a signature');
  await sec.locator(`[data-testid="offer-cancel-${offerId}"]`).click();
  neg((await sec.locator(`[data-testid="offer-confirm-${offerId}"]`).count()) === 0 && (await j('GET', '/player/offers', undefined, KOLA)).body.items[0].status === 'ISSUED', 'B4b: Not now — nothing happened');
  await sec.locator(`[data-testid="offer-accept-${offerId}"]`).click();
  await sec.locator(`[data-testid="offer-confirm-accept-${offerId}"]`).waitFor({ timeout: 10000 });
  await sec.locator(`[data-testid="offer-confirm-accept-${offerId}"]`).click();
  ok(await waitIn(sec, /Offer accepted\. The club has been told\. Nothing has been signed/), 'B5: ACCEPT — the message says the club was told and nothing was signed');
  await sec.locator(`[data-testid="offer-signing-pending-${offerId}"]`).waitFor({ timeout: 10000 });
  const after = await sec.innerText();
  ok(/✓ Accepted — signing pending/.test(after) && /signature|signing/i.test(after), 'B5b: the pill reads Accepted — signing pending');
  neg(!/player signed|you signed|you have signed|contract signed|signed contract|signed the contract|now signed/i.test(after), 'B5c: nothing claims a signing happened');
  const o = (await j('GET', '/player/offers', undefined, KOLA)).body.items[0];
  ok(o.status === 'ACCEPTED' && o.responses.length === 1 && o.responses[0].actorType === 'player' && (await journey(ROOM_A, LEAD)).lifecycle.currentStage === 'offer_accepted', 'B5d: the server: ACCEPTED, one response by the player, the case at offer_accepted');
  neg((await journey(ROOM_A, LEAD)).outcome.signing === null, 'B5e: and no signing exists');
  neg((await sec.locator(`[data-testid="offer-accept-${offerId}"]`).count()) === 0, 'B5f: the accept control is gone');
}

// ================================================================== C — CLUB READS

await offerTab(lead.page, ROOM_A);
{
  ok(/✓ Offer accepted — signing pending/.test(await ow(lead.page).locator('[data-testid="offer-status"]').innerText()), 'C1: the club reads Offer accepted — signing pending');
  ok(/signing not completed/i.test(await ow(lead.page).locator('[data-testid="offer-accepted-note"]').innerText()), 'C1b: and the note says signing is not completed');
  ok(/Accepted in ScoutBox/.test(await headerStatus(lead.page)), 'C1c: the room header says Accepted in ScoutBox');
  ok(/✓ Accepted · player/.test(await ow(lead.page).locator('[data-testid="offer-response"]').innerText()), 'C2: the response row: accepted, by the player');
  neg((await ow(lead.page).locator('[data-testid="offer-withdraw"]').count()) === 0 && (await ow(lead.page).locator('[data-testid="offer-revise"]').count()) === 0 && (await ow(lead.page).locator('[data-testid="offer-issue"]').count()) === 0, 'C3: no withdraw, revise or issue control on an accepted Offer');
  neg(!/sign now|record signing|Player signed/i.test(await ow(lead.page).innerText()), 'C4: no signing control on the Offer tab');
  ok(/First opened by the recipient/.test(await ow(lead.page).innerText()), 'C5: the club sees when the recipient first opened it — a receipt, not a status');
}

// ================================================================== D — DECLINE

const ROOM_D = await openRoomFor(lead.page, 'Mateus Carvalho');
ok(/^case-/.test(ROOM_D ?? ''), `D1: a room for Mateus (${ROOM_D})`);
await toConsideration(ROOM_D, LEAD);
const MAT = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body.token;
{
  await offerTab(lead.page, ROOM_D);
  await ow(lead.page).locator('[data-testid="offer-start"]').click();
  await ow(lead.page).locator('[data-testid="offer-draft-label"]').waitFor({ timeout: 10000 });
  await ow(lead.page).locator('input[aria-label="Role"]').fill('Winger');
  await ow(lead.page).locator('input[aria-label="Start day"]').fill('2027-07-01');
  await ow(lead.page).locator('input[aria-label="Offer expires"]').fill(localInput(Date.now() + 5 * DAY));
  await ow(lead.page).locator('[data-testid="offer-issue"]').click();
  ok(await waitLive(lead.page, /Offer issued/), 'D2: issued to Mateus straight from the editor (the on-screen draft is saved first)');
  const ctxMat = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const mat = await enterPlayer(ctxMat, 'Mateus Carvalho', 'mateus', 'text=Your visibility right now');
  await goTab(mat, '/opportunities');
  const sec = mat.locator('[data-testid="offer-section"]');
  await sec.waitFor({ timeout: 15000 });
  ok(await mat.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13b: 360px: the player app has no horizontal scroll');
  const oid = (await j('GET', '/player/offers', undefined, MAT)).body.items[0].id;
  await sec.locator(`[data-testid="offer-decline-${oid}"]`).click();
  await sec.locator(`[data-testid="offer-confirm-${oid}"]`).waitFor({ timeout: 10000 });
  await sec.locator('input[aria-label="Reason (optional, the club reads it)"]').fill('Staying at my club this season.');
  await sec.locator(`[data-testid="offer-confirm-decline-${oid}"]`).click();
  ok(await waitIn(sec, /Offer declined\. The club has been told/), 'D3: Mateus declines at 360px with a reason, behind the second step');
  ok((await journey(ROOM_D, LEAD)).lifecycle.currentStage === 'offer_declined', 'D3b: the case is at offer_declined');
  await offerTab(lead.page, ROOM_D);
  ok(/✕ Declined by the recipient/.test(await ow(lead.page).locator('[data-testid="offer-status"]').innerText()) && /Staying at my club this season/.test(await ow(lead.page).locator('[data-testid="offer-response"]').innerText()), 'D4: the club reads the decline and the reason the player chose to give');
  ok(/Offer declined by player/.test(await headerStatus(lead.page)), 'D4b: the header says Offer declined by player');
  await ctxMat.close();
}

// ================================================================== E — AGENT

const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana');
{
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /No Offer has been shared with you by this client/), 'E1: Ana\'s Offers tab for Kola shows nothing — the issued Offer was not shared');
  neg(!(await bodyText(ana)).includes('Central midfielder'), 'E1b: no term leaks before the share');
  // Kola shares from his app.
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="offer-section"]');
  await sec.waitFor({ timeout: 15000 });
  const offerId = (await j('GET', '/player/offers', undefined, KOLA)).body.items[0].id;
  await sec.locator(`[data-testid="offer-share-${offerId}"]`).click();
  ok(await waitIn(sec, /Shared with your agent \(read-only\)/), 'E2: Kola shares the Offer with his agent — his own act, read-only');
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /Central midfielder/), 'E3: Ana now reads the shared Offer');
  const txt = await ana.locator('[data-testid="client-offers"]').innerText();
  ok(/Offer accepted — signing pending/.test(txt) && /Revision 2|Revision 1/.test(txt) && /Eastport FC/.test(txt), 'E3b: terms, revision and state, and the words signing pending');
  neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC) && !/accept|decline/i.test(await ana.locator('[data-testid="client-offers"] button').allInnerTexts().then((x) => x.join(' '))), 'E4: no note, no decision, and no accept/decline control in the agent\'s projection');
  ok(/own act/.test(await bodyText(ana)), 'E4b: the page says the answer is the client\'s own act');
  const bea = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
  expect(await j('GET', `/org/agent/clients/${REL}/offers`, undefined, bea.token), 404, 'REPRESENTATION_NOT_FOUND', 'E5: Bea (same agency) gets NOT FOUND on the relationship — nothing says an Offer exists');
  expect(await j('POST', `/org/agent/clients/${REL}/offers/${offerId}/accept`, { revisionId: 'x' }, anaApi.token), 404, null, 'E6: there is no route through which an agent accepts for a client');
}

// ================================================================== F — GUARDIAN / MINOR

{
  const ROOM_G = (await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, LEAD)).body?.room?.roomId;
  await toConsideration(ROOM_G, LEAD);
  await offerTab(lead.page, ROOM_G);
  await ow(lead.page).locator('[data-testid="offer-start"]').click();
  await ow(lead.page).locator('[data-testid="offer-draft-label"]').waitFor({ timeout: 10000 });
  const avail = ow(lead.page).locator('[data-testid="offer-issue-availability"]');
  ok((await avail.getAttribute('data-possible')) === '0' && /under the age of majority/i.test(await avail.innerText()), 'F1: for a minor the readiness names the closed pathway before anyone tries');
  ok(await ow(lead.page).locator('[data-testid="offer-issue"]').isDisabled(), 'F1b: the Issue button is disabled');
  const s = (await j('GET', `/org/rooms/${ROOM_G}/offers`, undefined, LEAD)).body;
  // Complete the draft through the API (content is validated before the recipient, §50), then force the issue.
  const completed = await j('PATCH', `/org/offers/${s.offers[0].id}/draft`, { terms: { role: 'Winger', startDate: '2027-07-01' }, expiresAt: Date.now() + 5 * DAY, expectedRev: s.offers[0].rev }, LEAD);
  expect(await j('POST', `/org/offers/${s.offers[0].id}/issue`, { expectedRev: completed.body.offer.rev, clientKey: 'live-g' }, LEAD), 422, 'OFFER_RECIPIENT_INVALID', 'F1c: and forcing the request gets the same answer — visibility of a button is not authorization');
  const ctxAmara = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const amara = await enterPlayer(ctxAmara, 'Amara Adebayo', 'amara', 'text=Guardian');
  const gsec = amara.locator('[data-testid="offer-section"]');
  await gsec.waitFor({ timeout: 20000 });
  ok(await waitIn(gsec, /Offers addressed to you as the guardian/), 'F2: Amara\'s guardian screen carries the Offers section with the guardian wording');
  const txt = await gsec.innerText();
  neg(/No Offers right now/.test(txt) && !/Winger|Central midfielder|Eastport FC/.test(txt), 'F2b: and lists no Offer — none was issued to a minor');
  const AMARA = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
  expect(await j('GET', `/guardian/offers/${s.offers[0].id}`, undefined, AMARA), 404, 'OFFER_NOT_FOUND', 'F3: a draft addressed to nobody is NOT FOUND to the guardian');
  await ctxAmara.close();
}

// ================================================================== N — NEGATIVES

const ctxScout = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Field', 'First-Team Scout', 'scout');
{
  await offerTab(scout.page, ROOM_A);
  const txt = await ow(scout.page).innerText();
  ok(/Offer accepted — signing pending/.test(txt) && /Drafting, issuing and withdrawing sit with the room lead/.test(txt), 'N2: a scout reads the Offer (club memory) and is told the act is not theirs');
  neg((await ow(scout.page).locator('[data-testid="offer-start"]').count()) === 0 && (await ow(scout.page).locator('[data-testid="offer-issue"]').count()) === 0 && (await ow(scout.page).locator('[data-testid="offer-withdraw"]').count()) === 0, 'N2b: no draft, issue or withdraw control for a scout');
  ok(await scout.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13c: 1024px: no horizontal scroll');
  expect(await j('POST', `/org/rooms/${ROOM_D}/offers`, { terms: { role: 'x' } }, scout.token), 403, 'OFFER_NOT_PERMITTED', 'N2c: and the server refuses a scout\'s draft');
  const rita = (await j('POST', '/auth/org/login', { orgId: 'org-harbour', scoutName: 'Rita Vale', role: 'Head of Recruitment' })).body;
  expect(await j('GET', `/org/rooms/${ROOM_A}/offers`, undefined, rita.token), 404, 'ROOM_NOT_FOUND', 'N3: a foreign club gets the case\'s own 404 on the Offer surface');
  expect(await j('GET', `/org/rooms/${ROOM_A}/offers`, undefined, KOLA), 401, null, 'N11: a player token gets 401 on the club\'s Offer surface');
  await ctxScout.close();
}

// Widths: the club Offer tab at 1440 / 1280 / 768 / 390 / 360.
for (const width of [1440, 1280, 768, 390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`)).page;
  await offerTab(p, ROOM_A);
  ok(await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N13: ${width}px: the Offer tab has no horizontal page scroll`);
  const pill = await ow(p).locator('[data-testid="offer-status"]').boundingBox();
  ok(pill && pill.x >= 0 && pill.x + pill.width <= width + 1, `N13: ${width}px: the status pill sits inside the viewport`);
  await ctx.close();
}

// N15 — accessibility on the editor (a fresh case for Okafor).
{
  const ROOM_N = (await j('POST', '/org/rooms', { playerId: 'pl-okafor', sourceContext: 'search' }, LEAD)).body?.room?.roomId;
  await toConsideration(ROOM_N, LEAD);
  await offerTab(lead.page, ROOM_N);
  const sel = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Offer")').getAttribute('aria-selected');
  const controls = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Offer")').getAttribute('aria-controls');
  const panelId = await lead.page.locator('[role="tabpanel"][aria-label="Offer"]').getAttribute('id');
  ok(sel === 'true' && controls && controls === panelId, 'N15: tab semantics — the Offer tab is aria-selected and aria-controls its tabpanel');
  await ow(lead.page).locator('[data-testid="offer-start"]').click();
  await ow(lead.page).locator('[data-testid="offer-draft-label"]').waitFor({ timeout: 10000 });
  const labelled = await ow(lead.page).evaluate((root) => {
    const controls = [...root.querySelectorAll('input, textarea, button, select')];
    const unlabelled = controls.filter((c) => !(c.getAttribute('aria-label') || c.textContent?.trim() || c.closest('label')?.textContent?.trim()));
    return { total: controls.length, unlabelled: unlabelled.length };
  });
  ok(labelled.total > 8 && labelled.unlabelled === 0, `N15b: every control in the draft editor is labelled (${labelled.total} controls)`);
  ok((await ow(lead.page).locator('input[aria-required="true"]').count()) === 2, 'N15c: the two fields required to issue are marked aria-required');
  ok((await ow(lead.page).locator('[data-testid="offer-issue"]').getAttribute('aria-describedby')) === 'of-issue-note', 'N15d: the Issue button is described by the sentence that says what issuing does');
  ok((await ow(lead.page).locator('[role="status"][aria-live="polite"]').count()) >= 1, 'N15e: the panel carries a polite live region');
  await ow(lead.page).locator('input[aria-label="Role"]').focus();
  await lead.page.keyboard.type('Keeper');
  ok((await ow(lead.page).locator('input[aria-label="Role"]').inputValue()) === 'Keeper', 'N15f: keyboard — the editor takes typed input on a focused field');
  // FR
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'fr'));
  await lead.page.reload();
  await lead.page.waitForSelector('[aria-label="En-tête de la salle"]', { timeout: 25000 });
  await lead.page.click('[role="tablist"] button[role="tab"]:has-text("Offre")');
  const frPanel = lead.page.locator('[role="tabpanel"][aria-label="Offre"] [data-testid="offer-workflow"]');
  await frPanel.waitFor({ timeout: 10000 });
  let frTxt = '';
  for (let i = 0; i < 40 && !/Préparation de l’Offre/i.test(frTxt); i++) { frTxt = await frPanel.innerText().catch(() => ''); if (!/Préparation de l’Offre/i.test(frTxt)) await sleep(250); }
  ok(/Préparation de l’Offre/i.test(frTxt) && /Brouillon — non émis/.test(frTxt) && /Émettre l’Offre/.test(frTxt) && /Révisions/i.test(frTxt) && !/Offer readiness|Issue Offer|Draft — not issued|An Offer is the club|not a signing, not a registration/i.test(frTxt), 'N16: FR — the Offer tab renders in French with no English fallback in its headings, controls or honest line');
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'en'));
  await lead.page.reload();
}

// Sentinel sweep: every page a recipient or agent can reach, and their APIs.
{
  const pages = [['kola', kola.locator('[data-testid="offer-section"]')], ['ana', ana.locator('body')]];
  for (const [who, p] of pages) {
    const txt = await p.innerText();
    neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC), `N10: ${who}\'s page carries no internal note and no decision rationale`);
  }
  for (const [name, p, tok] of [['player offers', '/player/offers', KOLA], ['player notifications', '/player/notifications', KOLA], ['agent offers', `/org/agent/clients/${REL}/offers`, anaApi.token], ['agent notifications', '/org/notifications', anaApi.token]]) {
    const r = (await j('GET', p, undefined, tok)).body;
    neg(!JSON.stringify(r).includes(S_NOTE) && !JSON.stringify(r).includes(S_DEC), `N10b: ${name} API carries nothing private`);
  }
}

ok(errors.length === 0, `no page errors in any app (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nM23 P6 OFFER LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
cleanup();
process.exit(0);
