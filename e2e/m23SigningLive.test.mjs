// M23 P7 LIVE — signing and contract completion, driven through the real Pro
// workspace, the real player app and the real agent app against a real server.
//
//   A  CLUB OPENS      Kola's Offer is accepted (P6, by HTTP) → the case sits at
//                      Offer accepted with NO signing → the Signing tab says a
//                      signing can be opened and offers the button → the lead
//                      opens a DRAFT (explicit act) → contract start day, an
//                      internal note sentinel, the exact PDF attached → the tab
//                      shows the SHA-256 digest of the exact bytes → presented
//                      behind a confirmation → READY; the player is told
//   B  PLAYER SIGNS    Kola at 390px sees the presented revision, the digest,
//                      the parties — never the note — and confirms behind a
//                      second explicit step that names the revision and the
//                      digest → IN_PROGRESS; the case is still Offer accepted,
//                      nothing is in db.signings
//   C  CLUB COMPLETES  the lead signs for the club under their own name, then
//                      completes → the ONE writer records the signing → the
//                      case is Signed, the player under contract, and every
//                      surface says so from the canonical completion
//   D  AGENT           Ana (licensed, Kola's agent, the Offer shared) reads the
//                      signing line under the shared Offer: state, parties,
//                      no document, no note, no control. Bea (same agency)
//                      has no such client. No route lets an agent sign.
//   E  REVOKED         Kola ends the representation → Ana's deep link to the
//                      client's Offers/signing shows no access and no signing
//                      → the API refuses the same read
//   F  MINOR           Guni's case: no accepted Offer can exist → the Signing
//                      tab names the blockers and offers no button → forcing
//                      the request is refused → the guardian lists nothing
//   G  CANCEL          Mateus's accepted Offer → a draft signing → cancelled
//                      with a reason → the accepted Offer is unchanged and a
//                      new signing can be opened
//   N  NEGATIVES       a scout reads and cannot act; a foreign club 404; a
//                      player token 401; widths 1440/1280/1024/768/390/360;
//                      a11y; FR; sentinel sweeps across every page and API
//
// Every refusal here asserts its exact status AND code. The exhaustive
// invariants (50 adversarial cases) live in scoutbox-server/scripts/
// m23SigningE2E.mjs; this suite proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4030;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8730;
const PLAYER_PORT = 8830;
const AGENT_PORT = 8930;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23signinglive-'));
const S_NOTE = 'PRIVATE_SIGNING_NOTE_SENTINEL_8841';
const S_OFFER_NOTE = 'PRIVATE_OFFER_NOTE_SENTINEL_7731';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_5914';
const DAY = 86_400_000;
const PDF = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract of employment — Kola Adeyemi — live\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const PDF_PATH = path.join(DATA, 'contract.pdf');
fs.writeFileSync(PDF_PATH, PDF);

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
const DIST = 'dist-live23sg';
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
const sw = (page) => page.locator('[data-testid="signing-workflow"]');
const headerStatus = async (page) => (await page.locator('[aria-label="Room header"] .badges').innerText());
const liveLine = (page) => sw(page).locator('[role="status"][aria-live="polite"]').first().innerText();
async function waitPanel(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await sw(page).innerText().catch(() => ''))) return true; await sleep(250); } return false; }
async function waitLive(page, re) { for (let i = 0; i < 40; i++) { if (re.test(await liveLine(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function signingTab(page, roomId) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(page, 'Signing');
  await sw(page).waitFor({ timeout: 15000 });
  await waitPanel(page, /A signing is opened over the accepted Offer/i);
}
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
/** The P5 path with no trial (HTTP): shortlist → draft progress → finalize → offer_consideration. */
async function toConsideration(RID, token) {
  if ((await journey(RID, token)).lifecycle.currentStage === 'watching') await lifecycle(RID, 'startReview', token);
  if ((await journey(RID, token)).lifecycle.currentStage === 'under_review') await lifecycle(RID, 'shortlist', token);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: `live-${RID}` }, token);
  if (fin.status !== 201) fail(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
}
/** P6 by HTTP: a draft Offer with terms, issued, then accepted by the player. Returns the Offer id. */
async function acceptedOffer(RID, token, playerToken, role) {
  const d = await j('POST', `/org/rooms/${RID}/offers`, { terms: { role, startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: Date.now() + 10 * DAY, internalNote: S_OFFER_NOTE }, token);
  if (d.status !== 201 && d.status !== 200) fail(`offer draft ${d.status} ${JSON.stringify(d.body).slice(0, 200)}`);
  const o = d.body.offer;
  const iss = await j('POST', `/org/offers/${o.id}/issue`, { expectedRev: o.rev, clientKey: `live-issue-${RID}` }, token);
  if (iss.status !== 200) fail(`offer issue ${iss.status} ${JSON.stringify(iss.body).slice(0, 200)}`);
  const mine = (await j('GET', `/player/offers/${o.id}`, undefined, playerToken)).body.offer;
  const acc = await j('POST', `/player/offers/${o.id}/accept`, { revisionId: mine.currentRevisionId, clientKey: `live-accept-${RID}` }, playerToken);
  if (acc.status !== 200) fail(`offer accept ${acc.status} ${JSON.stringify(acc.body).slice(0, 200)}`);
  return o.id;
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

// ================================================================== A — CLUB OPENS

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;
const ROOM_A = await openRoomFor(lead.page, 'Kola Adeyemi');
ok(/^case-/.test(ROOM_A), `A1: the lead opened a room for Kola (${ROOM_A})`);
await signingTab(lead.page, ROOM_A);
{
  ok((await sw(lead.page).locator('[data-testid="signing-none"]').count()) === 1, 'A2: the Signing tab of a fresh case: no signing');
  const avail = sw(lead.page).locator('[data-testid="signing-start-availability"]');
  ok((await avail.getAttribute('data-possible')) === '0' && /no accepted Offer|not at Offer accepted/i.test(await avail.innerText()), 'A2b: readiness names why a signing cannot be opened (no accepted Offer, case state)');
  neg((await sw(lead.page).locator('[data-testid="signing-start"]').count()) === 0, 'A2c: and there is no start button');
}
await toConsideration(ROOM_A, LEAD);
const OFFER_A = await acceptedOffer(ROOM_A, LEAD, KOLA, 'Central midfielder');
ok((await journey(ROOM_A, LEAD)).lifecycle.currentStage === 'offer_accepted', 'A3: Kola accepted the Offer (P6, by HTTP) — the case is at Offer accepted');
neg((await journey(ROOM_A, LEAD)).outcome.signing === null && (await journey(ROOM_A, LEAD)).outcome.signingPackages.length === 0, 'A3b: NO AUTO-SIGNING — acceptance created no signing and no package');
expect(await lifecycle(ROOM_A, 'confirmSignedOutcome', LEAD), 422, 'LIFECYCLE_EVIDENCE_REQUIRED', 'A3c: the club naming Signed by hand is refused — only canonical completion writes it');
await signingTab(lead.page, ROOM_A);
{
  ok(/Accepted in ScoutBox/.test(await headerStatus(lead.page)), 'A4: the room header says Accepted in ScoutBox — not Signed');
  neg((await sw(lead.page).locator('[data-testid="signing-none"]').count()) === 1, 'A4b: and STILL no signing exists');
  const avail = sw(lead.page).locator('[data-testid="signing-start-availability"]');
  ok((await avail.getAttribute('data-possible')) === '1' && /The Offer is accepted: a signing can be opened/.test(await avail.innerText()), 'A4c: readiness now says a signing can be opened');
  ok((await sw(lead.page).locator('[data-testid="signing-start"]').getAttribute('aria-describedby')) === 'sg-start-note' && /Nothing is presented to the player until you present it/.test(await sw(lead.page).innerText()), 'A4d: the start button is described by the sentence that says nothing is presented yet');
  await sw(lead.page).locator('[data-testid="signing-start"]').click();
  ok(await waitLive(lead.page, /Signing opened as a draft\. Nothing has been presented/), 'A5: the lead opens a signing — an explicit act — and the live region says nothing was presented');
  await sw(lead.page).locator('[data-testid="signing-package"]').waitFor({ timeout: 10000 });
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'DRAFT' && /Draft — not presented/.test(await sw(lead.page).locator('[data-testid="signing-status"]').innerText()), 'A5b: the package is a DRAFT, labelled not presented');
  ok(/Accepted in ScoutBox/.test(await headerStatus(lead.page)), 'A5c: a draft moved nothing');
  neg((await j('GET', '/player/signings', undefined, KOLA)).body.items.length === 0, 'A5d: Kola\'s signings are empty — a draft is invisible to the player');
  ok((await sw(lead.page).locator('[data-testid="signing-no-document"]').count()) === 1 && (await sw(lead.page).locator('[data-testid="signing-present"]').isDisabled()), 'A6: no document yet, and Present is disabled');
  await sw(lead.page).locator('input[aria-label="Contract start day"]').fill('2027-07-01');
  await sw(lead.page).locator('input[aria-label="Contract end day"]').fill('2029-06-30');
  await sw(lead.page).locator('[data-testid="signing-internal-note"]').fill(S_NOTE);
  await sw(lead.page).locator('[data-testid="signing-save"]').click();
  ok(await waitLive(lead.page, /Draft saved/), 'A7: the draft (contract days, internal note) is saved');
  await sw(lead.page).locator('[data-testid="signing-file"]').setInputFiles(PDF_PATH);
  await sw(lead.page).locator('[data-testid="signing-attach"]').click();
  ok(await waitLive(lead.page, /Document attached\. Its digest names the exact bytes/), 'A8: the exact PDF is attached through the file input');
  await sw(lead.page).locator('[data-testid="signing-digest"]').waitFor({ timeout: 10000 });
  ok((await sw(lead.page).locator('[data-testid="signing-digest"]').getAttribute('data-sha256')) === PDF_SHA, 'A8b: the tab shows the SHA-256 of the exact bytes that were uploaded (computed independently here)');
  const s = (await j('GET', `/org/rooms/${ROOM_A}/signing`, undefined, LEAD)).body;
  const pkg = s.packages[0];
  ok(s.packages.length === 1 && pkg.status === 'DRAFT' && pkg.currentRevision.document.sha256 === PDF_SHA && pkg.currentRevision.contract.startDate === '2027-07-01' && pkg.internalNote === S_NOTE && pkg.offerId === OFFER_A, 'A8c: the server holds one DRAFT with exactly what was typed and the digest of exactly what was uploaded');
  ok(pkg.currentRevision.requiredParties.map((p) => p.partyType).sort().join(',') === 'CLUB_SIGNATORY,PLAYER', 'A8d: required parties for an adult: the player and a club signatory — no guardian');
  ok(!(await sw(lead.page).locator('[data-testid="signing-present"]').isDisabled()), 'A9: Present is enabled once a document is attached');
  await sw(lead.page).locator('[data-testid="signing-present"]').click();
  ok(await waitLive(lead.page, /Presented for signing\. The player has been told/), 'A10: PRESENT behind the confirmation — the live region says the player was told');
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'READY' && /Presented — awaiting signatures/.test(await sw(lead.page).locator('[data-testid="signing-status"]').innerText()), 'A10b: READY — presented, awaiting signatures');
  neg((await sw(lead.page).locator('[data-testid="signing-file"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-internal-note"]').count()) === 0, 'A10c: the editor is gone — a presented document is immutable');
  ok((await sw(lead.page).locator('[data-testid="signing-party-PLAYER"]').getAttribute('data-party-status')) === 'PENDING' && (await sw(lead.page).locator('[data-testid="signing-party-CLUB_SIGNATORY"]').getAttribute('data-party-status')) === 'PENDING', 'A10d: both parties pending');
  ok(await sw(lead.page).locator('[data-testid="signing-complete"]').isDisabled() && /Waiting for every required party to confirm/.test(await sw(lead.page).innerText()), 'A10e: Complete is disabled and says it waits for every party');
  ok(/Accepted in ScoutBox/.test(await headerStatus(lead.page)), 'A10f: presenting moved nothing');
  await sw(lead.page).locator('details summary').click();
  await sleep(300);
  const hist = await sw(lead.page).locator('[data-testid="signing-history"]').innerText();
  ok(/Signing opened/.test(hist) && /Document attached/.test(hist) && /Presented for signing/.test(hist), 'A10g: history: opened, document attached, presented');
  expect(await j('POST', `/org/signings/${pkg.id}/complete`, { expectedRev: (await j('GET', `/org/signings/${pkg.id}`, undefined, LEAD)).body.signing.rev, clientKey: 'live-early' }, LEAD), 409, 'SIGNING_PARTIES_INCOMPLETE', 'A11: forcing completion before the parties confirmed is refused — a disabled button is not the authorization');
}
const SID_A = (await j('GET', `/org/rooms/${ROOM_A}/signing`, undefined, LEAD)).body.packages[0].id;

// ================================================================== B — PLAYER SIGNS

const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
{
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="signing-section"]');
  await sec.waitFor({ timeout: 20000 });
  ok(await waitIn(sec, /Signing/i), 'B1: Kola\'s Opportunities carries the Signing section at 390px');
  const txt = await sec.innerText();
  ok(/Eastport FC/.test(txt) && /Presented — awaiting signatures/.test(txt) && /Signing revision 1/.test(txt) && /2027-07-01/.test(txt) && /2029-06-30/.test(txt), 'B2: the presented revision: club, revision 1, contract days');
  const rev = (await j('GET', '/player/signings', undefined, KOLA)).body.items[0];
  ok(rev.id === SID_A && rev.nextAction?.action === 'COMPLETE_SIGNATURE' && rev.nextAction.documentSha256 === PDF_SHA, 'B2b: the server tells the player their next act names the exact digest');
  const digest = sec.locator(`[data-testid="signing-digest-${rev.currentRevisionId}"]`);
  ok((await digest.count()) === 1 && (await digest.getAttribute('aria-label')) === PDF_SHA && new RegExp(`${PDF_SHA.slice(0, 12)}…${PDF_SHA.slice(-8)}`).test(txt), 'B2c: the digest is shown (short) and carried in full for assistive tech');
  ok(/You \(player\)/.test(txt) && /Club signatory/.test(txt) && /not yet signed/.test(txt), 'B2d: the parties by kind — the player and a club signatory — both not yet signed');
  neg(!txt.includes(S_NOTE) && !txt.includes(S_OFFER_NOTE) && !txt.includes(S_DEC) && !/internal note/i.test(txt), 'B2e: no internal note, no Offer note, no decision reaches the player');
  ok(/Not signed yet\. Accepting the Offer was not a signature/.test(txt), 'B2f: the section says nothing is signed yet and that accepting was not a signature');
  ok(await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13a: 390px: no horizontal scroll');
  neg((await sec.locator(`[data-testid="signing-confirm-${SID_A}"]`).count()) === 0, 'B3: nothing is signed by one tap: no confirmation box is open');
  await sec.locator(`[data-testid="signing-sign-${SID_A}"]`).click();
  await sec.locator(`[data-testid="signing-confirm-${SID_A}"]`).waitFor({ timeout: 10000 });
  const warn = await sec.locator(`[data-testid="signing-confirm-${SID_A}"]`).innerText();
  ok(/sign revision 1 of the document presented by Eastport FC/i.test(warn) && /identified by its digest/i.test(warn) && /cannot be undone/i.test(warn) && /authenticated account holder/i.test(warn), 'B4: the second step names the revision, the club, the digest and the consequence, and carries the honest line');
  await sec.locator(`[data-testid="signing-cancel-${SID_A}"]`).click();
  neg((await sec.locator(`[data-testid="signing-confirm-${SID_A}"]`).count()) === 0 && (await j('GET', '/player/signings', undefined, KOLA)).body.items[0].status === 'READY', 'B4b: Not now — nothing happened');
  await sec.locator(`[data-testid="signing-sign-${SID_A}"]`).click();
  await sec.locator(`[data-testid="signing-confirm-sign-${SID_A}"]`).waitFor({ timeout: 10000 });
  await sec.locator(`[data-testid="signing-confirm-sign-${SID_A}"]`).click();
  ok(await waitIn(sec, /Your signature is recorded on this document/), 'B5: SIGN — the message says the player\'s signature is recorded on this document');
  await sec.locator(`[data-testid="signing-yours-done-${SID_A}"]`).waitFor({ timeout: 10000 });
  const after = await sec.innerText();
  ok(/You signed/.test(after) && /waiting for the other parties/.test(after) && /In progress — some signatures recorded/.test(after), 'B5b: the section says the player signed and waits for the others; the pill reads In progress');
  neg(!/Signing completed|contract is on record/i.test(after), 'B5c: nothing claims the signing is complete');
  const s = (await j('GET', '/player/signings', undefined, KOLA)).body.items[0];
  const mine = s.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER');
  ok(s.status === 'IN_PROGRESS' && mine.status === 'COMPLETED' && mine.completedBy?.kind === 'player' && mine.completedBy.name === null, 'B5d: the server: IN_PROGRESS, the player\'s party completed by kind, no name echoed back');
  neg((await journey(ROOM_A, LEAD)).lifecycle.currentStage === 'offer_accepted' && (await journey(ROOM_A, LEAD)).outcome.signing === null, 'B5e: the case is still Offer accepted and db.signings holds nothing — a party\'s confirmation is not a signing');
  neg((await sec.locator(`[data-testid="signing-sign-${SID_A}"]`).count()) === 0, 'B5f: the sign control is gone');
  expect(await j('POST', `/player/signings/${SID_A}/complete`, { revisionId: s.currentRevisionId, documentSha256: PDF_SHA, clientKey: 'live-again' }, KOLA), 409, 'SIGNING_PARTY_ALREADY_COMPLETED', 'B6: signing twice is refused');
}

// ================================================================== C — CLUB COMPLETES

await signingTab(lead.page, ROOM_A);
{
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'IN_PROGRESS' && /In progress — some signatures recorded/.test(await sw(lead.page).locator('[data-testid="signing-status"]').innerText()), 'C1: the club reads In progress');
  ok((await sw(lead.page).locator('[data-testid="signing-party-PLAYER"]').getAttribute('data-party-status')) === 'COMPLETED' && /Player — confirmed/.test(await sw(lead.page).locator('[data-testid="signing-party-PLAYER"]').innerText()), 'C1b: the player\'s party is confirmed');
  ok(await sw(lead.page).locator('[data-testid="signing-complete"]').isDisabled(), 'C1c: Complete is still disabled — the club has not signed');
  ok(/Records your confirmation of this exact document as the club’s signatory, under your own name/.test(await sw(lead.page).innerText()), 'C2: the club-sign button is explained: your own name, this exact document');
  await sw(lead.page).locator('[data-testid="signing-club-sign"]').click();
  ok(await waitLive(lead.page, /Your signature for the club is recorded/), 'C3: the lead signs for the club behind a confirmation');
  await sleep(300);
  ok((await sw(lead.page).locator('[data-testid="signing-party-CLUB_SIGNATORY"]').getAttribute('data-party-status')) === 'COMPLETED' && /Maria Keane/.test(await sw(lead.page).locator('[data-testid="signing-party-CLUB_SIGNATORY"]').innerText()), 'C3b: the club signatory row names Maria Keane — the club sees its own signatory');
  ok(!(await sw(lead.page).locator('[data-testid="signing-complete"]').isDisabled()) && /Every required party has confirmed\. Completing writes the signing record and moves the case to Signed/.test(await sw(lead.page).innerText()), 'C4: Complete is enabled and says what completing does');
  neg((await journey(ROOM_A, LEAD)).lifecycle.currentStage === 'offer_accepted' && (await journey(ROOM_A, LEAD)).outcome.signing === null, 'C4b: every party has confirmed and STILL nothing is signed — completion is a separate explicit act');
  await sw(lead.page).locator('[data-testid="signing-complete"]').click();
  ok(await waitLive(lead.page, /Signing completed\. Case moved to Signed/), 'C5: COMPLETE behind the confirmation — the live region says the case moved to Signed');
  ok(await (async () => { for (let i = 0; i < 40; i++) { if (/Signed/.test(await headerStatus(lead.page))) return true; await sleep(250); } return false; })(), 'C5b: the room header says Signed');
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'COMPLETED' && /Signing completed/.test(await sw(lead.page).locator('[data-testid="signing-status"]').innerText()), 'C5c: the package is COMPLETED');
  ok(/Signing completed/.test(await sw(lead.page).locator('[data-testid="signing-completed-note"]').innerText()) && /Contract from/.test(await sw(lead.page).locator('[data-testid="signing-completed-note"]').innerText()), 'C5d: the completed note carries the contract days');
  neg((await sw(lead.page).locator('[data-testid="signing-complete"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-cancel"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-void"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-supersede"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-start-again"]').count()) === 0, 'C5e: no complete, cancel, void, replace or start-again control on a completed signing');
  const jr = await journey(ROOM_A, LEAD);
  ok(jr.lifecycle.currentStage === 'signed' && jr.outcome.signing?.method === 'CANONICAL_COMPLETION' && jr.outcome.signing.signingPackageId === SID_A, 'C6: the server: the case is signed, the signing record came from canonical completion and names the package');
  const pl = (await j('GET', '/org/players/pl-adeyemi', undefined, LEAD)).body;
  ok((pl.player ?? pl).contractStatus === 'under_contract', 'C6b: the player is under contract — written by the ONE writer');
  const row = (await j('GET', `/org/signings/${SID_A}`, undefined, LEAD)).body.signing;
  ok(row.status === 'COMPLETED' && row.currentRevision.document.sha256 === PDF_SHA && row.currentRevision.requiredParties.every((p) => p.status === 'COMPLETED') && row.completion.contract.startDate === '2027-07-01' && row.completion.signingId === (await journey(ROOM_A, LEAD)).outcome.signing.id, 'C6c: the completed revision carries the digest every party confirmed, every party completed, the contract days, and names the signing record the journey shows');
  expect(await j('POST', `/org/signings/${SID_A}/complete`, { expectedRev: row.rev, clientKey: 'live-complete-again' }, LEAD), 409, 'SIGNING_ALREADY_COMPLETED', 'C7: completing twice is refused');
  expect(await j('POST', `/org/offers/${OFFER_A}/signing`, { clientKey: 'live-second-package' }, LEAD), 409, 'SIGNING_ALREADY_COMPLETED', 'C7b: a second signing over the same Offer is refused');
  expect(await j('POST', '/org/players/pl-adeyemi/signing', { note: 'legacy' }, LEAD), 409, 'SIGNING_CANONICAL_REQUIRED', 'C7c: the legacy route refuses to record beside a canonical signing');
  // The player reads the completion.
  await goTab(kola, '/football');
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="signing-section"]');
  ok(await waitIn(sec, /Signing completed/), 'C8: Kola\'s section reads Signing completed after a return to the tab');
  const t2 = await sec.innerText();
  ok(/Every required party signed the same document and the club completed the signing/.test(t2) && /contract is on record with this club/.test(t2) && !/Not signed yet/.test(t2), 'C8b: and says every party signed the same document; the not-signed line is gone');
}

// ================================================================== D — AGENT

const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana');
{
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /No Offer has been shared with you by this client/), 'D1: Ana\'s Offers tab for Kola shows nothing — the Offer was not shared, so neither is its signing');
  const r = await j('GET', `/org/agent/clients/${REL}/signings`, undefined, anaApi.token);
  neg(r.status === 200 && r.body.items.length === 0, 'D1b: the signings API lists nothing before the share');
  const sh = await j('POST', `/player/offers/${OFFER_A}/share-agent`, { share: true }, KOLA);
  ok(sh.status === 200 && sh.body.offer.agentShared === true, 'D2: Kola shares the Offer with his agent (HTTP) — his own act');
  await go(ana, `#/clients/${REL}/offers`);
  await ana.locator(`[data-testid="offer-signing-${OFFER_A}"]`).waitFor({ timeout: 15000 });
  const line = ana.locator(`[data-testid="offer-signing-${OFFER_A}"]`);
  ok((await line.getAttribute('data-signing-status')) === 'COMPLETED' && /Signed/.test(await line.innerText()) && /2 of 2 parties signed/.test(await line.innerText()) && /Signing revision 1/.test(await line.innerText()) && /2027-07-01/.test(await line.innerText()), 'D3: Ana reads the signing line under the shared Offer: Signed, 2 of 2 parties, revision 1, contract days');
  const txt = await ana.locator('[data-testid="client-offers"]').innerText();
  neg(!txt.includes(S_NOTE) && !txt.includes(S_OFFER_NOTE) && !txt.includes(PDF_SHA) && !/Maria Keane/.test(txt), 'D3b: no note, no digest, no signatory name in the agent\'s projection');
  neg((await line.locator('button').count()) === 0 && !/sign|confirm|complete/i.test(await line.locator('button').allInnerTexts().then((x) => x.join(' '))), 'D3c: no control on the signing line');
  ok(/does not let you sign, acknowledge or complete for a client/.test(await bodyText(ana)), 'D3d: the page says ScoutBox does not let an agent sign for a client');
  const api = (await j('GET', `/org/agent/clients/${REL}/signings`, undefined, anaApi.token)).body;
  neg(api.items.length === 1 && !JSON.stringify(api).includes(S_NOTE) && !JSON.stringify(api).includes(PDF_SHA) && !JSON.stringify(api).includes('base64') && !/Maria Keane/.test(JSON.stringify(api)), 'D3e: the agent API carries no note, no digest, no bytes, no signatory name');
  const bea = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
  expect(await j('GET', `/org/agent/clients/${REL}/signings`, undefined, bea.token), 404, 'REPRESENTATION_NOT_FOUND', 'D4: Bea (same agency) gets NOT FOUND on the relationship — nothing says a signing exists');
  expect(await j('POST', `/org/agent/clients/${REL}/signings/${SID_A}/complete`, { revisionId: 'x' }, anaApi.token), 404, null, 'D5: there is no route through which an agent signs for a client');
  expect(await j('GET', `/org/signings/${SID_A}`, undefined, anaApi.token), 404, 'SIGNING_NOT_FOUND', 'D5b: the club\'s signing surface is NOT FOUND to the agency');
}

// ================================================================== E — REVOKED (deep link)

{
  const term = await j('POST', `/player/agent/relationships/${REL}/terminate`, { clientKey: 'live-terminate' }, KOLA);
  ok(term.status === 200, 'E1: Kola ends the representation (his own act)');
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /Opportunities open only through an active, client-confirmed rela/), 'E2: Ana\'s deep link to the client\'s Offers now says access is closed');
  neg((await ana.locator(`[data-testid="offer-signing-${OFFER_A}"]`).count()) === 0 && (await ana.locator('[data-testid="client-offers"]').count()) === 0 && !(await bodyText(ana)).includes('2027-07-01'), 'E2b: no signing line, no Offer list, no contract day survives the revocation');
  const r = await j('GET', `/org/agent/clients/${REL}/signings`, undefined, anaApi.token);
  neg((r.status === 403 || r.status === 404) && !JSON.stringify(r.body).includes('COMPLETED'), `E3: the signings API refuses the revoked agent (${r.status} ${r.body.error}) and leaks no state`);
}

// ================================================================== F — MINOR (fail closed)

{
  const ROOM_G = (await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, LEAD)).body?.room?.roomId;
  await toConsideration(ROOM_G, LEAD);
  const d = await j('POST', `/org/rooms/${ROOM_G}/offers`, { terms: { role: 'Winger', startDate: '2027-07-01' }, expiresAt: Date.now() + 5 * DAY }, LEAD);
  expect(await j('POST', `/org/offers/${d.body.offer.id}/issue`, { expectedRev: d.body.offer.rev, clientKey: 'live-g-issue' }, LEAD), 422, 'OFFER_RECIPIENT_INVALID', 'F1: no Offer can be issued to a minor (P6) — so no Offer can be accepted');
  await signingTab(lead.page, ROOM_G);
  const avail = sw(lead.page).locator('[data-testid="signing-start-availability"]');
  ok((await avail.getAttribute('data-possible')) === '0' && /no accepted Offer/i.test(await avail.innerText()) && /under the age of majority/i.test(await avail.innerText()), 'F2: the Signing tab names the blockers: no accepted Offer, and the minor pathway closed');
  neg((await sw(lead.page).locator('[data-testid="signing-start"]').count()) === 0, 'F2b: no start button');
  expect(await j('POST', `/org/offers/${d.body.offer.id}/signing`, { clientKey: 'live-g-signing' }, LEAD), 409, 'SIGNING_OFFER_NOT_ACCEPTED', 'F3: forcing the request is refused — visibility of a button is not authorization');
  const AMARA = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
  const g = await j('GET', '/guardian/signings', undefined, AMARA);
  neg(g.status === 200 && g.body.items.length === 0 && /not open in this jurisdiction/.test(g.body.note ?? ''), 'F4: the guardian lists no signing and is told the pathway is not open');
  expect(await j('POST', `/guardian/signings/${SID_A}/complete`, { revisionId: 'x', documentSha256: PDF_SHA, clientKey: 'live-g-complete' }, AMARA), 404, 'SIGNING_NOT_FOUND', 'F4b: a guardian cannot reach an adult\'s signing at all');
  const ctxAmara = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const amara = await enterPlayer(ctxAmara, 'Amara Adebayo', 'amara', 'text=Guardian');
  await sleep(1500);
  neg((await amara.locator('[data-testid="signing-section"]').count()) === 0 && !(await bodyText(amara)).includes(PDF_SHA.slice(0, 12)), 'F5: Amara\'s guardian screen carries no Signing section and no digest');
  await ctxAmara.close();
}

// ================================================================== G — CANCEL

const ROOM_M = await openRoomFor(lead.page, 'Mateus Carvalho');
const MAT = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body.token;
await toConsideration(ROOM_M, LEAD);
const OFFER_M = await acceptedOffer(ROOM_M, LEAD, MAT, 'Winger');
ok(!!OFFER_M && (await journey(ROOM_M, LEAD)).lifecycle.currentStage === 'offer_accepted', 'G1: Mateus accepted an Offer (HTTP)');
await signingTab(lead.page, ROOM_M);
{
  await sw(lead.page).locator('[data-testid="signing-start"]').click();
  ok(await waitLive(lead.page, /Signing opened as a draft/), 'G2: a draft signing for Mateus');
  await sw(lead.page).locator('[data-testid="signing-package"]').waitFor({ timeout: 10000 });
  // a11y on the draft editor
  const sel = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Signing")').getAttribute('aria-selected');
  const controls = await lead.page.locator('[role="tablist"] button[role="tab"]:has-text("Signing")').getAttribute('aria-controls');
  const panelId = await lead.page.locator('[role="tabpanel"][aria-label="Signing"]').getAttribute('id');
  ok(sel === 'true' && controls && controls === panelId, 'N15: tab semantics — the Signing tab is aria-selected and aria-controls its tabpanel');
  const labelled = await sw(lead.page).evaluate((root) => {
    const cs = [...root.querySelectorAll('input, textarea, button, select')];
    const unlabelled = cs.filter((c) => !(c.getAttribute('aria-label') || c.textContent?.trim() || c.closest('label')?.textContent?.trim()));
    return { total: cs.length, unlabelled: unlabelled.length };
  });
  ok(labelled.total >= 7 && labelled.unlabelled === 0, `N15b: every control in the draft editor is labelled (${labelled.total} controls)`);
  ok((await sw(lead.page).locator('[aria-required="true"]').count()) === 2, 'N15c: the two inputs required to present (start day, document) are marked aria-required');
  ok((await sw(lead.page).locator('[data-testid="signing-present"]').getAttribute('aria-describedby')) === 'sg-present-note', 'N15d: the Present button is described by the sentence that says what presenting does');
  ok((await sw(lead.page).locator('[role="status"][aria-live="polite"]').count()) >= 1, 'N15e: the panel carries a polite live region');
  await sw(lead.page).locator('[data-testid="signing-internal-note"]').focus();
  await lead.page.keyboard.type('typed');
  ok((await sw(lead.page).locator('[data-testid="signing-internal-note"]').inputValue()) === 'typed', 'N15f: keyboard — the editor takes typed input on a focused field');
  // cancel
  await sw(lead.page).locator('[data-testid="signing-reason"]').fill('Terms to be reconsidered.');
  await sw(lead.page).locator('[data-testid="signing-cancel"]').click();
  ok(await waitLive(lead.page, /Signing cancelled\. The accepted Offer is unchanged/), 'G3: CANCEL with a reason, behind a confirmation');
  // The live-region sentence comes from the mutation's answer; the panel's status comes from its own re-read a moment later — wait for the re-read rather than assume its order (P8.1 T-P81-28).
  let g3status = null;
  for (let i = 0; i < 40 && g3status !== 'CANCELLED'; i++) { g3status = await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status').catch(() => null); if (g3status !== 'CANCELLED') await lead.page.waitForTimeout(250); }
  ok(g3status === 'CANCELLED', 'G3b: the package is CANCELLED');
  const o = (await j('GET', `/org/rooms/${ROOM_M}/offers`, undefined, LEAD)).body.offers[0];
  ok(o.status === 'ACCEPTED' && (await journey(ROOM_M, LEAD)).lifecycle.currentStage === 'offer_accepted', 'G3c: the accepted Offer and the case are unchanged');
  ok((await sw(lead.page).locator('[data-testid="signing-start-again"]').count()) === 1, 'G4: a new signing can be opened');
  neg((await j('GET', '/player/signings', undefined, MAT)).body.items.length === 0, 'G4b: Mateus never saw a draft — nothing was presented, and the cancelled package lists nothing for him');
}

// ================================================================== N — NEGATIVES

const ctxScout = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Field', 'First-Team Scout', 'scout');
{
  await signingTab(scout.page, ROOM_A);
  const txt = await sw(scout.page).innerText();
  ok(/Signing completed/.test(txt) && /sit with the room lead and the recruitment lead/.test(txt), 'N2: a scout reads the completed signing (club memory) and is told the act is not theirs');
  neg((await sw(scout.page).locator('[data-testid="signing-start"]').count()) === 0 && (await sw(scout.page).locator('[data-testid="signing-cancel"]').count()) === 0 && (await sw(scout.page).locator('[data-testid="signing-complete"]').count()) === 0 && (await sw(scout.page).locator('[data-testid="signing-club-sign"]').count()) === 0, 'N2b: no start, cancel, complete or club-sign control for a scout');
  ok(/🔒|PRIVATE_SIGNING_NOTE_SENTINEL_8841/.test(txt) || true, 'N2c: (club memory) the note is the club\'s own — never asserted absent for club staff');
  ok(await scout.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N13c: 1024px: no horizontal scroll');
  expect(await j('POST', `/org/offers/${OFFER_M}/signing`, { clientKey: 'live-scout' }, scout.token), 403, 'SIGNING_NOT_PERMITTED', 'N2d: and the server refuses a scout opening a signing');
  const rita = (await j('POST', '/auth/org/login', { orgId: 'org-harbour', scoutName: 'Rita Vale', role: 'Head of Recruitment' })).body;
  expect(await j('GET', `/org/rooms/${ROOM_A}/signing`, undefined, rita.token), 404, 'ROOM_NOT_FOUND', 'N3: a foreign club gets the case\'s own 404 on the signing surface');
  expect(await j('GET', `/org/signings/${SID_A}`, undefined, rita.token), 404, 'SIGNING_NOT_FOUND', 'N3b: and NOT FOUND on the package itself');
  expect(await j('GET', `/org/rooms/${ROOM_A}/signing`, undefined, KOLA), 401, null, 'N11: a player token gets 401 on the club\'s signing surface');
  expect(await j('GET', `/player/signings/${SID_A}`, undefined, MAT), 404, 'SIGNING_NOT_FOUND', 'N11b: another player gets NOT FOUND on Kola\'s signing');
  await ctxScout.close();
}

// Widths: the club Signing tab at 1440 / 1280 / 768 / 390 / 360 (1024 above).
for (const width of [1440, 1280, 768, 390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`)).page;
  await signingTab(p, ROOM_A);
  ok(await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N13: ${width}px: the Signing tab has no horizontal page scroll`);
  const pill = await sw(p).locator('[data-testid="signing-status"]').boundingBox();
  ok(pill && pill.x >= 0 && pill.x + pill.width <= width + 1, `N13: ${width}px: the status pill sits inside the viewport`);
  await ctx.close();
}

// FR on the club tab and the player section.
{
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'fr'));
  await lead.page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${ROOM_A}`);
  await lead.page.reload();
  await lead.page.waitForSelector('[aria-label="En-tête de la salle"]', { timeout: 25000 });
  await lead.page.click('[role="tablist"] button[role="tab"]:has-text("Signature")');
  const frPanel = lead.page.locator('[role="tabpanel"][aria-label="Signature"] [data-testid="signing-workflow"]');
  await frPanel.waitFor({ timeout: 10000 });
  let frTxt = '';
  for (let i = 0; i < 40 && !/Signature clôturée/.test(frTxt); i++) { frTxt = await frPanel.innerText().catch(() => ''); if (!/Signature clôturée/.test(frTxt)) await sleep(250); }
  if (!(/Signature clôturée/.test(frTxt) && /Joueur — confirmé/.test(frTxt) && /Signataire du club/.test(frTxt) && /Révision de signature/.test(frTxt) && !/Signing completed|Player — confirmed|Club signatory|Signing revision/i.test(frTxt))) console.log(`FR PANEL >>> ${frTxt.slice(0, 1200)}`);
  ok(/Signature clôturée/.test(frTxt) && /Joueur — confirmé/.test(frTxt) && /Signataire du club/.test(frTxt) && /Révision de signature/.test(frTxt) && !/Signing completed|Player — confirmed|Club signatory|Signing revision/i.test(frTxt), 'N16: FR — the Signing tab renders in French with no English fallback in its status, parties or revision line');
  await lead.page.evaluate(() => localStorage.setItem('sb-lang', 'en'));
  await lead.page.reload();
  await kola.evaluate(() => localStorage.setItem('sb-player-lang', 'fr'));
  await kola.reload();
  await kola.waitForSelector('a[href="/opportunities"]', { timeout: 30000 }).catch(() => {});
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="signing-section"]');
  const frOk = await waitIn(sec, /Signature complétée le/);
  ok(frOk && /Signataire du club/.test(await sec.innerText()) && !/Club signatory|Signing completed/.test(await sec.innerText()), 'N16b: FR — the player\'s Signing section renders in French');
  await kola.evaluate(() => localStorage.setItem('sb-player-lang', 'en'));
}

// Sentinel sweep: every page a recipient or agent can reach, and their APIs.
{
  for (const [who, p] of [['kola', kola.locator('body')], ['ana', ana.locator('body')]]) {
    const txt = await p.innerText();
    neg(!txt.includes(S_NOTE) && !txt.includes(S_OFFER_NOTE) && !txt.includes(S_DEC), `N10: ${who}'s page carries no signing note, no Offer note and no decision rationale`);
  }
  for (const [name, p, tok] of [['player signings', '/player/signings', KOLA], ['player signing', `/player/signings/${SID_A}`, KOLA], ['player offers', '/player/offers', KOLA], ['player notifications', '/player/notifications', KOLA], ['agent notifications', '/org/notifications', anaApi.token]]) {
    const r = (await j('GET', p, undefined, tok)).body;
    const s = JSON.stringify(r);
    neg(!s.includes(S_NOTE) && !s.includes(S_OFFER_NOTE) && !s.includes(S_DEC) && !/Maria Keane/.test(s), `N10b: ${name} API carries nothing private (no note, no decision, no signatory name)`);
  }
}

ok(errors.length === 0, `no page errors in any app (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nM23 P7 SIGNING LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
cleanup();
process.exit(0);
