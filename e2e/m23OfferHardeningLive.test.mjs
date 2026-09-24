// M23 P6.1 LIVE — the Offer under adversarial conditions, driven through the
// real Pro workspace, the real player app and the real agent app against a
// real server. The exhaustive invariants live in
// scoutbox-server/scripts/m23OfferHardeningE2E.mjs; this suite proves the real
// interfaces surface them honestly.
//
//   S1  STALE REV        the lead edits a draft the API changed underneath:
//                        Save is refused with the conflict sentence, nothing of
//                        the other change is overwritten, the panel reloads
//   S2  EXPIRED          an Offer issued (test clock) whose expiry is already
//                        in the past reads ⌛ Expired in the player app with no
//                        accept control; the API says OFFER_EXPIRED
//   S3  SUPERSEDED       Kola's app shows revision 1; the club issues revision
//                        2 through the API; the app shows revision 2 and lists
//                        revision 1 as replaced; accepting revision 1 is refused
//   S4  REVOKED AGENT    Ana reads a shared Offer; Kola ends the representation
//                        from the API; Ana's deep link shows no term and no
//                        Offer; Bea (same agency) on the same deep link: nothing
//   S5  WITHDRAWAL RACE  Svensson at 360px opens the accept confirmation; the
//                        club withdraws; the confirmation is answered with
//                        "The club withdrew this Offer." and the row re-reads
//                        Withdrawn; nothing was accepted
//   W   WIDTHS           1440/768 (club), 390/360 (player), no horizontal scroll
//   E   zero page errors in three apps
//
// Ports differ from every other live suite so batteries never collide.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4029;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8729;
const PLAYER_PORT = 8829;
const AGENT_PORT = 8929;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23offerhardlive-'));
const S_NOTE = 'PRIVATE_OFFER_NOTE_SENTINEL_H731';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_H914';
const S_MSG = 'RECIPIENT_MESSAGE_VISIBLE_H402';
const H = 3_600_000;
const DAY = 24 * H;

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
const DIST = 'dist-live23oh';
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
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const key = () => `hl-${Math.random().toString(36).slice(2, 10)}`;

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
/** The player app keeps inactive tab screens mounted but hidden, so a section is read through its own locator, never the body. */
async function waitIn(loc, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await loc.innerText().catch(() => ''))) return true; await sleep(250); } return false; }
const noHScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

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
const tab = async (page, name) => {
  await page.click(`[role="tablist"] button[role="tab"]:has-text("${name}")`);
  await page.waitForSelector(`[role="tabpanel"][aria-label="${name}"]`, { timeout: 10000 });
};
const ow = (page) => page.locator('[data-testid="offer-workflow"]');
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
/** A case at offer_consideration through P5 (HTTP): room → review → shortlist → finalized progress decision. */
async function caseFor(playerId, token) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.body?.room?.roomId ?? r.body?.existingRoomId;
  if (!RID) fail(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  if ((await journey(RID, token)).lifecycle.currentStage === 'watching') await lifecycle(RID, 'startReview', token);
  if ((await journey(RID, token)).lifecycle.currentStage === 'under_review') await lifecycle(RID, 'shortlist', token);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: `hl-${RID}` }, token);
  if (fin.status !== 201) fail(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
  return RID;
}
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
const surface = (RID, token) => j('GET', `/org/rooms/${RID}/offers`, undefined, token);
const getOffer = (id, token) => j('GET', `/org/offers/${id}`, undefined, token);
/** Issue an Offer at a given server instant (the test clock): expiry is validated against THAT instant. */
async function issueAt(RID, token, clock, expiresAt, message = S_MSG) {
  const c = await j('POST', `/org/rooms/${RID}/offers`, { terms: TERMS, expiresAt, internalNote: S_NOTE, recipientMessage: message, clientKey: key() }, token, at(clock));
  if (c.status !== 201) fail(`create ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const i = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, token, at(clock));
  if (i.status !== 200) fail(`issue ${i.status} ${JSON.stringify(i.body).slice(0, 200)}`);
  return { OID: c.body.offer.id, R: i.body.offer.currentRevisionId, rev: i.body.offer.rev };
}

// ------------------------------------------------------------ player helpers

async function enterPlayer(ctx, rowText, who, landing = 'text=Your visibility right now') {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector(landing, { timeout: 30000 });
  return page;
}
const goTab = async (page, href) => { await page.click(`a[href="${href}"]`); await page.waitForTimeout(900); };
async function offersSection(page) {
  await goTab(page, '/opportunities');
  const sec = page.locator('[data-testid="offer-section"]');
  await sec.waitFor({ timeout: 20000 });
  return sec;
}
/** The player app re-reads its Offers on a tab change; leaving and returning is a reload. */
async function refreshOffers(page) { await goTab(page, '/discover'); await goTab(page, '/opportunities'); return page.locator('[data-testid="offer-section"]'); }

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
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const MAT = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body.token;
const SVEN = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const anaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
const beaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
for (const a of [anaApi, beaApi]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-HL' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-HL-ENG', memberAssociation: 'ENG' }, a.token);
}
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const conf = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, KOLA);
ok(!!REL && conf.status === 200, 'fixture: Ana represents Kola (employment), client-confirmed');

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;

// ================================================================== S1 — STALE REV
const ROOM_K = await caseFor('pl-adeyemi', LEAD);
{
  await offerTab(lead.page, ROOM_K);
  await ow(lead.page).locator('[data-testid="offer-start"]').click();
  await ow(lead.page).locator('[data-testid="offer-draft-label"]').waitFor({ timeout: 10000 });
  const s0 = (await surface(ROOM_K, LEAD)).body.offers[0];
  ok(s0?.status === 'DRAFT', 'S1a: the lead opened a draft on screen');
  // A colleague (the API) changes the draft underneath the open editor.
  const other = await j('PATCH', `/org/offers/${s0.id}/draft`, { terms: { ...TERMS, role: 'Striker' }, expectedRev: s0.rev }, LEAD);
  ok(other.status === 200 && other.body.offer.rev === s0.rev + 1, 'S1b: the API edit landed first (rev moved)');
  await ow(lead.page).locator('input[aria-label="Role"]').fill('Central midfielder');
  await ow(lead.page).locator('[data-testid="offer-save"]').click();
  neg(await waitLive(lead.page, /Someone else changed this Offer while you were working on it/), 'S1c: Save on the stale rev is refused with the conflict sentence — the UI names the 409 honestly');
  const after = (await getOffer(s0.id, LEAD)).body.offer;
  neg(after.currentRevision.terms.role === 'Striker' && after.rev === s0.rev + 1, 'S1d: nothing of the colleague\'s change was overwritten; the rev is theirs');
  await offerTab(lead.page, ROOM_K);
  ok((await ow(lead.page).locator('input[aria-label="Role"]').inputValue()) === 'Striker', 'S1e: after reload the editor shows the colleague\'s value');
  ok(await noHScroll(lead.page), 'W: 1440px: no horizontal scroll on the club Offer tab');
  // Tidy: the draft becomes revision 1 issued to Kola through the UI's own Issue (S3 builds on it).
  await ow(lead.page).locator('input[aria-label="Role"]').fill('Central midfielder');
  await ow(lead.page).locator('input[aria-label="Squad"]').fill('Under-23s');
  await ow(lead.page).locator('input[aria-label="Start day"]').fill('2027-07-01');
  await ow(lead.page).locator('input[aria-label="Offer expires"]').fill((() => { const d = new Date(Date.now() + 10 * DAY); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; })());
  await ow(lead.page).locator('textarea[aria-label="Message to the player"]').fill(S_MSG);
  await ow(lead.page).locator('[data-testid="offer-issue"]').click();
  ok(await waitLive(lead.page, /Offer issued/), 'S1f: revision 1 issued to Kola from the editor');
}

// ================================================================== S2 — EXPIRED
const ROOM_M = await caseFor('pl-carvalho', LEAD);
const ctxMat = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
{
  // Issued three days ago (test clock) with a two-hour expiry: expired now by every real clock.
  const past = Date.now() - 3 * DAY;
  const X = await issueAt(ROOM_M, LEAD, past, past + 2 * H);
  const mat = await enterPlayer(ctxMat, 'Mateus Carvalho', 'mateus');
  const sec = await offersSection(mat);
  ok(await waitIn(sec, /Eastport FC/), 'S2a: Mateus\'s Offers section lists the club\'s Offer at 390px');
  const txt = await sec.innerText();
  neg(/⌛ Expired/.test(txt) && !/Awaiting your answer/.test(txt), 'S2b: it reads ⌛ Expired — derived at read time, no status was ever written');
  neg((await sec.locator(`[data-testid="offer-accept-${X.OID}"]`).count()) === 0 && (await sec.locator(`[data-testid="offer-decline-${X.OID}"]`).count()) === 0, 'S2c: no accept or decline control on an expired Offer');
  expect(await j('POST', `/player/offers/${X.OID}/accept`, { revisionId: X.R, clientKey: key() }, MAT), 409, 'OFFER_EXPIRED', 'S2d: forcing the request is refused OFFER_EXPIRED');
  ok(txt.includes(S_MSG) && !txt.includes(S_NOTE) && !txt.includes(S_DEC), 'S2e: the message is his to read; the note and the decision never are');
  ok(await noHScroll(mat), 'W: 390px: no horizontal scroll in the player app');
  neg(((await getOffer(X.OID, LEAD)).body.offer.currentRevision.storedStatus) === 'ISSUED', 'S2f: the stored status is still ISSUED (lazy expiry)');
}

// ================================================================== S3 — SUPERSEDED
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola');
let OID_K = null; let R1_K = null;
{
  const sec = await offersSection(kola);
  ok(await waitIn(sec, /Revision 1/), 'S3a: Kola\'s app shows revision 1, awaiting his answer');
  const o = (await j('GET', '/player/offers', undefined, KOLA)).body.items[0];
  OID_K = o.id; R1_K = o.currentRevisionId;
  // The club revises and issues revision 2 while his screen still shows revision 1.
  const cur = (await getOffer(OID_K, LEAD)).body.offer;
  const rv = await j('POST', `/org/offers/${OID_K}/revise`, { terms: { ...TERMS, squad: 'First team' }, expiresAt: Date.now() + 9 * DAY, recipientMessage: S_MSG, expectedRev: cur.rev, clientKey: key() }, LEAD);
  const i2 = await j('POST', `/org/offers/${OID_K}/issue`, { expectedRev: rv.body.offer.rev, clientKey: key() }, LEAD);
  ok(rv.status === 201 && i2.status === 200 && i2.body.offer.currentRevision.revisionNumber === 2, 'S3b: revision 2 issued through the API');
  // His stale screen: accepting revision 1 is refused by the server, the app names it.
  await sec.locator(`[data-testid="offer-accept-${OID_K}"]`).click();
  await sec.locator(`[data-testid="offer-confirm-accept-${OID_K}"]`).waitFor({ timeout: 10000 });
  await sec.locator(`[data-testid="offer-confirm-accept-${OID_K}"]`).click();
  neg(await waitIn(sec, /This revision was replaced by a newer one\. Answer the current revision/), 'S3c: the stale accept of revision 1 is refused and the app says the revision was replaced');
  expect(await j('POST', `/player/offers/${OID_K}/accept`, { revisionId: R1_K, clientKey: key() }, KOLA), 409, 'OFFER_SUPERSEDED', 'S3d: the API says OFFER_SUPERSEDED');
  const sec2 = await refreshOffers(kola);
  ok(await waitIn(sec2, /Revision 2/), 'S3e: after a reload the app shows revision 2');
  const txt = await sec2.innerText();
  ok(/First team/.test(txt) && /Revision 1 · ↻ Replaced by a newer revision/.test(txt), 'S3f: revision 2\'s terms, and revision 1 listed as replaced');
  neg(((await getOffer(OID_K, LEAD)).body.offer.responses.length) === 0, 'S3g: no response row was written by the refused attempt');
}

// ================================================================== S4 — REVOKED AGENT / SAME AGENCY
const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana');
{
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /No Offer has been shared with you by this client/), 'S4a: nothing shared yet');
  const sh = await j('POST', `/player/offers/${OID_K}/share-agent`, {}, KOLA);
  ok(sh.status === 200 && sh.body.offer.agentShared === true, 'S4b: Kola shares revision 2 with Ana (API)');
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /Central midfielder/), 'S4c: Ana reads the shared Offer on the deep link');
  // Kola ends the representation.
  const rel = ((await j('GET', '/player/agent/relationships', undefined, KOLA)).body?.items ?? []).find((a) => a.id === REL);
  const term = await j('POST', `/player/agent/relationships/${REL}/terminate`, { expectedRev: rel?.rev ?? conf.body.relationship.rev }, KOLA);
  ok(term.status === 200, `S4d: Kola ends the representation (${term.status})`);
  await ana.reload();
  await ana.waitForSelector('nav.sidebar', { timeout: 25000 });
  await go(ana, `#/clients/${REL}/offers`);
  await sleep(1500);
  const txt = await bodyText(ana);
  neg(!/Central midfielder|First team|Under-23s|Revision 2/.test(txt) && !txt.includes(S_MSG), 'S4e: the revoked agent\'s deep link shows no term, no revision, no message');
  neg(/not available to you|only through an active, client-confirmed relationship|No Offer has been shared/.test(txt), 'S4f: and says why in the app\'s own words — the link re-authorises live');
  expect(await j('GET', `/org/agent/clients/${REL}/offers`, undefined, anaApi.token), 403, 'REPRESENTATION_NOT_ACTIVE', 'S4g: the API behind it: 403 REPRESENTATION_NOT_ACTIVE');
  // Same agency, same deep link.
  const ctxBea = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bea = await enterAgent(ctxBea, 'Bea Agent', 'Agent', 'bea');
  await go(bea, `#/clients/${REL}/offers`);
  await sleep(1500);
  const btxt = await bodyText(bea);
  neg(!/Central midfielder|First team|Under-23s|Revision 2|Kola/.test(btxt) && !btxt.includes(S_MSG), 'S4h: Bea (same agency) on the same deep link: no term, no name, nothing says an Offer exists');
  expect(await j('GET', `/org/agent/clients/${REL}/offers`, undefined, beaApi.token), 404, 'REPRESENTATION_NOT_FOUND', 'S4i: her API answer is NOT FOUND on the relationship');
  ok(await noHScroll(ana), 'W: 1280px: no horizontal scroll in the agent app');
  await ctxBea.close();
}

// ================================================================== S5 — WITHDRAWAL RACE
const ROOM_C = await caseFor('pl-svensson', LEAD);
const ctxChi = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
{
  const X = await issueAt(ROOM_C, LEAD, Date.now(), Date.now() + 5 * DAY);
  const chi = await enterPlayer(ctxChi, 'Elias Svensson', 'svensson');
  const sec = await offersSection(chi);
  ok(await waitIn(sec, /Awaiting your answer/), 'S5a: Svensson at 360px sees the Offer awaiting his answer');
  ok(await noHScroll(chi), 'W: 360px: no horizontal scroll in the player app');
  await sec.locator(`[data-testid="offer-accept-${X.OID}"]`).click();
  await sec.locator(`[data-testid="offer-confirm-accept-${X.OID}"]`).waitFor({ timeout: 10000 });
  // The club withdraws while his confirmation is open.
  const w = await j('POST', `/org/offers/${X.OID}/withdraw`, { expectedRev: X.rev, reason: 'Budget changed.', clientKey: key() }, LEAD);
  ok(w.status === 200 && w.body.offer.status === 'WITHDRAWN', 'S5b: the club withdraws (API) while the confirmation is open');
  await sec.locator(`[data-testid="offer-confirm-accept-${X.OID}"]`).click();
  neg(await waitIn(sec, /The club withdrew this Offer/), 'S5c: his confirm is answered with "The club withdrew this Offer." — the loser is told which state won');
  neg(await waitIn(sec, /⊘ Withdrawn by the club/), 'S5d: the row re-reads ⊘ Withdrawn by the club');
  const o = (await getOffer(X.OID, LEAD)).body.offer;
  neg(o.status === 'WITHDRAWN' && o.responses.length === 0 && (await journey(ROOM_C, LEAD)).lifecycle.currentStage === 'offer_consideration', 'S5e: nothing was accepted: no response row, the case back at offer_consideration');
  neg((await sec.locator(`[data-testid="offer-accept-${X.OID}"]`).count()) === 0, 'S5f: the accept control is gone');
}

// ================================================================== W — club at 768
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 900 } });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'w768')).page;
  await offerTab(p, ROOM_K);
  ok(await noHScroll(p), 'W: 768px: no horizontal scroll on the club Offer tab');
  const pill = await ow(p).locator('[data-testid="offer-status"]').boundingBox();
  ok(pill && pill.x >= 0 && pill.x + pill.width <= 769, 'W: 768px: the status pill sits inside the viewport');
  ok(/➤ Issued — awaiting response/.test(await ow(p).locator('[data-testid="offer-status"]').innerText()), 'W: the club reads revision 2 as Issued — awaiting response');
  await ctx.close();
}

// Sentinel sweep across every recipient/agent page and API touched here.
{
  for (const [who, p] of [['kola', kola.locator('[data-testid="offer-section"]')], ['ana', ana.locator('body')]]) {
    const txt = await p.innerText();
    neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC), `N10: ${who}'s page carries no internal note and no decision rationale`);
  }
  for (const [name, p, tok] of [['player offers', '/player/offers', KOLA], ['player notifications', '/player/notifications', KOLA], ['agent notifications', '/org/notifications', anaApi.token]]) {
    const r = (await j('GET', p, undefined, tok)).body;
    neg(!JSON.stringify(r).includes(S_NOTE) && !JSON.stringify(r).includes(S_DEC), `N10b: ${name} API carries nothing private`);
  }
}

ok(errors.length === 0, `no page errors in any app (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nM23 P6.1 OFFER HARDENING LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
cleanup();
process.exit(0);
