// M23 P5.6D LIVE — the Agent Transaction Workspace driven through the real
// clients against a real server. Five browser contexts, one backend, four
// genuinely different parties plus the Trust & Safety read.
//
//   A  AGENT      Ana signs in → Transactions is a real destination → the list
//                 states what "ready" does and does not mean
//   B  CREATE     She opens an England transfer (Kola · Eastport engaging ·
//                 Harbour releasing) → DRAFT, nothing cleared, nobody confirmed,
//                 no offer readiness
//   C  BINDING    She records that she acts for Kola → accepted, because the
//                 client confirmed the relationship
//   D  PLAYER     Kola sees his side on his phone-shaped app: the clubs, the
//                 agency, the state — and confirms his own participation
//   E  ENGAGING   Maria, Eastport's recorded signatory, confirms the CLUB's
//                 participation and records a note kept to her own side
//   F  RELEASING  Dev, Harbour's signatory, does the same on the other side —
//                 and cannot see Eastport's private note, nor Eastport his
//   G  PROGRESS   Ana re-evaluates → compliance clear → she moves it to ACTIVE
//   H  DOCUMENTS  An AGENT_PRIVATE document is visible to her and to nobody else
//   I  TIMELINE   Each party's history is its own audience, not the audit
//   J  T&S        The console reads states, roles and counts — never a note's
//                 text, a document's label or a party's name
//   N  NEGATIVES  N1 no offer / negotiation / fee wording anywhere; N2 a foreign
//                 agency and a foreign club guessing the id get nothing; N3 the
//                 player's card carries no club-private note and no fee;
//                 N4 390/360 no horizontal scroll; N5 a11y; N6 FR; N7 a
//                 non-signatory club user reads but cannot confirm; N8 no offer
//                 tab, route or destination exists; N9 an archived transaction
//                 refuses a new write
//
// Exhaustive invariants live in scoutbox-server/scripts/m23AgentTransactionE2E.mjs;
// this suite proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { toastRecordingContexts, waitToast } from './toastLog.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4030;
const API = `http://localhost:${API_PORT}`;
const AGENT_PORT = 8730;
const PLAYER_PORT = 8830;
const ADMIN_PORT = 8930;
const CLUB_PORT = 9030;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m26live-'));
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, AGENT_PORT, PLAYER_PORT, ADMIN_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live26';
const bundles = [['scoutbox-agent', AGENT_PORT], ['scoutbox-admin', ADMIN_PORT], ['scoutbox-club', CLUB_PORT], ['scoutbox-player', PLAYER_PORT]];
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
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' },
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
for (const [app, port] of bundles) serveDir(path.join(app, DIST), port);

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
const ADMIN_H = { 'x-admin-key': ADMIN_KEY };
const key = () => `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------- setup the world over HTTP
// P5.6B (team, profile, verification, a confirmed relationship) and P5.6C
// (policy, facets) are proven in their own live suites; here they are
// scaffolding, so they go over HTTP and the browser does the P5.6D work.
const login = async (orgId, scoutName, role, platform = 'agent') => (await j('POST', '/auth/org/login', { orgId, scoutName, role, platform })).body;
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
const anaApi = await login('org-northstar', 'Ana Costa', 'Agent');
await j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const kolaApi = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, kolaApi.token);
// The releasing club has to be a VERIFIED organisation, because a recorded club
// signatory only exists inside one (M14). The seeded academy is not, so verify it.
const verifyHarbour = await j('POST', '/admin/clubs/org-harbour/verification', { verified: true, verifiedDomain: 'harbourcityfc.example', safeguardingContractSigned: true }, null, ADMIN_H);
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', 'main');
const devA = await login('org-harbour', 'Dev Ansah', 'Director of Football', 'main');
const a1 = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'P5.6D live: engaging club signatory' }, null, ADMIN_H);
const a2 = await j('POST', '/admin/verification/orgs/org-harbour/appoint-root', { userId: devA.userId, reason: 'P5.6D live: releasing club signatory' }, null, ADMIN_H);
// A second Eastport user with no verification authority, for N7.
const hal = await login('org-eastport', 'Hal Meyer', 'Coach', 'main');
if (verifyHarbour.status >= 400 || a1.status !== 201 || a2.status !== 201) fail(`setup: club signatories (${verifyHarbour.status}/${a1.status}/${a2.status} ${JSON.stringify(a1.body?.error ?? '')}${JSON.stringify(a2.body?.error ?? '')})`);
if (!REL || !anaApi?.token || !hal?.token) fail('setup failed');
say('setup: Ana is a verified licensed agent with a client-confirmed relationship; each club has its own recorded signatory');

browser = await chromium.launch({ executablePath: EXE });
// Toasts vanish after 3.5s; record them as they render so a starved poll cannot
// miss one. See e2e/toastLog.mjs.
const newContext = toastRecordingContexts(browser);
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
/**
 * Navigate by hash. Assigning the hash it already has fires no hashchange, so
 * the screen would keep the data it loaded before — which in a suite about
 * confirmations silently reads a stale view. Hop away first, so every `go` is a
 * real navigation and the screen refetches.
 */
const go = async (page, hash) => {
  await page.evaluate((h) => { if (location.hash === h) location.hash = '#/home'; }, hash);
  await sleep(200);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(600);
};
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function waitFor(fn, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (await fn().catch(() => false)) return true; await sleep(250); } return false; }

/**
 * A surface that says "and never a fee" contains the word "fee". An honest
 * denial must not be read as a feature, so every "is this word here?" check
 * removes the sentences whose whole job is to deny the thing, then looks at what
 * is left. Sentence-bounded, so it cannot swallow a real disclosure next to it.
 */
const HONEST = /[^.\n]*(never a fee|no fee\b|not a fee|never a commission|no commission|commission is not|never negotiat|does not negotiat|do not negotiat|not negotiat|no negotiation|no offer|not an offer|offer workflow|nothing is signed|does not sign|never sign|not sign anything|nothing here is an offer|nothing is an offer|never an offer|does not propose|private notes|no salary|not a salary|P6)[^.\n]*[.\n]/gi;
const stripHonest = (text) => String(text).replace(HONEST, ' ');

async function enterClub(ctx, orgText, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click(`.org-card:has-text("${orgText}")`);
  await page.fill('.enter-row input:not(.login-pw)', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  await go(page, '#/verification');
  await page.waitForSelector('[role="tablist"]', { timeout: 20000 });
  await page.click('button[role="tab"]:has-text("Transactions")');
  await page.waitForSelector('[data-testid="club-transactions"]', { timeout: 15000 });
  return page;
}

// ============================================================== A — the agent
const ctxAna = await newContext({ viewport: { width: 1440, height: 900 } });
const ana = watch(await ctxAna.newPage(), 'ana');
ana.on('dialog', (d) => d.accept());
{
  await ana.goto(`http://localhost:${AGENT_PORT}/`);
  await ana.waitForSelector('.org-card', { timeout: 25000 });
  await ana.click('.org-card:has-text("North Star")');
  await ana.fill('.enter-row input[aria-label]', 'Ana Costa');
  await ana.selectOption('.enter-row select', 'Agent').catch(() => {});
  await ana.click('button:has-text("Enter workspace")');
  await ana.waitForSelector('nav.sidebar', { timeout: 25000 });
  say('A1: Ana signs in through the real Agent client');
  const nav = await ana.locator('nav.sidebar').innerText();
  ok(/Transactions/.test(nav), 'A2: Transactions is a real destination in the sidebar (§42)');
  neg(!/Offers?\b|Negotiat|Signings?\b|Commission/i.test(nav), 'A2b: and no Offers, Negotiation, Signings or Commission destination came with it');
}
await go(ana, '#/transactions');
await ana.waitForSelector('[data-testid="transactions-screen"]', { timeout: 20000 });
say('A3: Transactions opens by deep link');
{
  const honest = await ana.locator('[data-testid="tx-list-honest"]').innerText();
  ok(/not/i.test(honest) && /(legal|valid|approv)/i.test(honest), 'A4: the list states what a ScoutBox state is not — no claim of legal validity or approval (§17/§77)');
  ok((await ana.locator('[data-testid="tx-counts"]').count()) === 1, 'A5: the list opens on counts, not on a guess about what needs attention');
  ok(await waitText(ana, /No transaction|none/i, 6000), 'A6: with nothing opened yet the list says so rather than rendering an empty table');
}

// ============================================================== B — create
let TX = null;
{
  await ana.click('[data-testid="tx-new"]');
  await ana.waitForSelector('[data-testid="tx-new-form"]', { timeout: 10000 });
  await ana.selectOption('[data-testid="tx-new-type"]', 'transfer');
  await ana.selectOption('[data-testid="tx-new-jurisdiction"]', 'ENG');
  await ana.selectOption('[data-testid="tx-new-player"]', { label: 'Kola Adeyemi' });
  await ana.selectOption('[data-testid="tx-new-engaging"]', { label: 'Eastport FC' });
  await ana.waitForSelector('[data-testid="tx-new-releasing"]', { timeout: 8000 });
  await ana.selectOption('[data-testid="tx-new-releasing"]', { label: 'Harbour City FC' });
  await ana.click('[data-testid="tx-new-submit"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="transaction-detail"]').count()) > 0, 20000), 'B1: opening a transfer opens its workspace');
  TX = await ana.locator('[data-testid="transaction-detail"]').getAttribute('data-tx');
  ok(/^atx-/.test(TX ?? ''), `B2: it has its own deep link (${TX})`);
  ok((await ana.locator('[data-testid="transaction-detail"]').getAttribute('data-status')) === 'DRAFT', 'B3: a new transaction is a DRAFT');
  const status = await ana.locator('[data-testid="tx-status"]').first().innerText();
  neg(/draft/i.test(status), 'B3b: the state reaches the screen as a WORD, not a colour (§84)');
  const compliance = await ana.locator('[data-testid="tx-compliance"]').first().innerText();
  neg(/not confirmed|parties/i.test(compliance) && !/clear/i.test(await ana.locator('[data-testid="tx-compliance-state"]').first().innerText()), 'B4: a DRAFT implies no clearance, and the reason names WHICH refusal it is (§13/§15)');
  await ana.click('[data-testid="tx-tab-compliance"]');
  await ana.waitForSelector('[data-testid="tx-offer-boundary"]', { timeout: 15000 });
  neg((await ana.locator('[data-testid="tx-offer-boundary"]').getAttribute('data-ready')) === '0', 'B5: offer readiness is false on a DRAFT (§53/§54)');
  neg(/not ready|pas pr/i.test(await ana.locator('[data-testid="tx-offer-ready"]').innerText()), 'B5b: …and the workspace says so in words, not only by a grey pill');
  neg((await ana.locator('[data-testid="tx-offer-blockers"] li').count()) > 0, 'B5c: …and names what is missing, so readiness is never a bare no');
  neg(!/Start an offer|Make an offer|Send offer|Sign the|Create offer/i.test(await bodyText(ana)), 'B5d: and there is no control anywhere that would start one — P5.6D computes readiness and stops (§54)');
  await ana.click('[data-testid="tx-tab-overview"]');
  await ana.waitForSelector('[data-testid="tx-panel-overview"]', { timeout: 10000 });
  await ana.click('[data-testid="tx-tab-parties"]');
  await ana.waitForSelector('[data-testid="tx-panel-parties"]', { timeout: 10000 });
  const parties = await ana.locator('[data-testid="tx-party"]').count();
  ok(parties === 3, `B6: all three parties are identified by role (${parties})`);
  const awaiting = await ana.locator('[data-testid="tx-awaiting"]').innerText();
  neg(/individual|person/i.test(awaiting) && /club/i.test(awaiting), 'B7: every party is awaiting its OWN confirmation — creating the transaction confirmed nobody (§14/§63)');
}

// ============================================================== C — binding
{
  await ana.click('[data-testid="tx-bind"][data-party-role="individual"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="tx-representation"][data-party-role="individual"]').getAttribute('data-rep-status', { timeout: 1500 })) === 'verified', 20000), 'C1: Ana records that she acts for Kola — accepted, because the client confirmed the relationship (§23/§24)');
  const reps = await ana.locator('[data-testid="tx-representations"]').innerText();
  neg(!/\bfee\b|commission|%/i.test(stripHonest(reps)), 'C1b: the binding names the party, basis and scope — never a fee (§56)');
}

// ============================================================== D — the player
const ctxKola = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = watch(await ctxKola.newPage(), 'kola');
{
  await kola.goto(`http://localhost:${PLAYER_PORT}/`);
  await kola.waitForSelector('text=Our promises to every player', { timeout: 45000 });
  const row = kola.locator('div', { hasText: 'Kola Adeyemi' }).filter({ has: kola.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await kola.waitForSelector('a[href="/you"]', { timeout: 30000 });
  await kola.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
  await kola.waitForSelector('[data-testid="agent-transactions"]', { timeout: 30000 });
  const card = kola.locator('[data-testid="agent-transactions"]');
  ok(await waitFor(async () => (await kola.locator(`[data-testid="agent-transaction-${TX}"]`).count()) > 0, 20000), 'D1: Kola sees his own side of the transaction on his phone');
  const text = await card.innerText();
  ok(/Eastport/.test(text) && /Harbour/.test(text), 'D2: …both clubs, named, because he is a party to a transaction between them');
  ok(/North Star/.test(text), 'D3: …the agency acting');
  neg(!/\bfee\b|commission|salary/i.test(stripHonest(text)), 'D4: no fee, commission or salary reaches the individual\'s card (§56)');
  neg(!/scouting|assessment|recruitment case|second look/i.test(text), 'D4b: and nothing of a club\'s private recruitment work (§46)');
  ok(/does not agree any terms|not agree|does not sign|not sign/i.test(text), 'D5: confirming says plainly what it does NOT do');
  ok(await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'D6: 390px: the individual\'s card fits with no horizontal scroll');
  await kola.locator(`[data-testid="agent-transaction-${TX}"] >> text=Confirm my participation`).last().click();
  ok(await waitFor(async () => /You confirmed on/i.test(await card.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'D7: he confirms his own participation, and the card records when');
}

// ============================================================== E — engaging club
const ctxMaria = await newContext({ viewport: { width: 1280, height: 900 } });
const mariaPage = await enterClub(ctxMaria, 'Eastport', 'Maria Keane', 'Head of Recruitment', 'maria');
{
  const lane = mariaPage.locator('[data-testid="club-transactions"]');
  ok(await waitFor(async () => (await mariaPage.locator(`[data-testid="club-tx-${TX}"]`).count()) > 0, 20000), 'E1: Eastport\'s signatory sees the transaction her club is a party to (§44)');
  const row = mariaPage.locator(`[data-testid="club-tx-${TX}"]`);
  const rowText = await row.innerText();
  ok(/Kola/.test(rowText), 'E2: …the individual, because her club is the engaging party to a transfer of him');
  ok(/club signing|signing/i.test(rowText), 'E3: …and which side she is on, named as the club signing (§45)');
  ok((await mariaPage.locator('[data-testid="tx-not-signatory"]').count()) === 0, 'E4: she is the recorded signatory, so she may answer for the club');
  neg(!/\bfee\b|commission|%/i.test(stripHonest(await lane.innerText())), 'E4b: no fee term reaches the club lane either');
  await row.locator(`[data-testid="tx-confirm-${TX}"]`).click();
  ok(await waitFor(async () => /Confirmed on/i.test(await mariaPage.locator(`[data-testid="club-tx-${TX}"]`).innerText({ timeout: 1500 }).catch(() => '')), 20000), 'E5: she confirms the CLUB\'s participation, attributed to her as its signatory (§64)');
  // A note kept to her own side.
  await mariaPage.click(`[data-testid="tx-toggle-${TX}"]`);
  await sleep(500);
  const opts = await mariaPage.locator(`[data-testid="tx-note-vis-${TX}"] option`).allInnerTexts();
  neg(opts.length > 0 && !opts.some((o) => /releasing|lib/i.test(o)), `E6: the visibilities she may choose are HER side's — no releasing-club class is offered (${opts.length})`);
  await mariaPage.selectOption(`[data-testid="tx-note-vis-${TX}"]`, 'ENGAGING_CLUB_PRIVATE');
  await mariaPage.fill(`[data-testid="tx-note-text-${TX}"]`, 'Eastport budget ceiling agreed internally.');
  await mariaPage.click(`[data-testid="tx-note-add-${TX}"]`);
  ok(await waitFor(async () => /budget ceiling/.test(await mariaPage.locator(`[data-testid="club-tx-${TX}"]`).innerText({ timeout: 1500 }).catch(() => '')), 20000), 'E7: she records a note kept to the engaging club');
}

// ============================================================== F — releasing club
const ctxDev = await newContext({ viewport: { width: 1280, height: 900 } });
const devPage = await enterClub(ctxDev, 'Harbour', 'Dev Ansah', 'Director of Football', 'dev');
{
  const row = devPage.locator(`[data-testid="club-tx-${TX}"]`);
  ok(await waitFor(async () => (await row.count()) > 0, 20000), 'F1: Harbour\'s signatory sees the same transaction from the other side');
  const rowText = await row.innerText();
  ok(/releasing|releases/i.test(rowText), 'F2: …named as the club releasing — a different party role, not the same view (§45)');
  neg(!/budget ceiling/.test(rowText), 'F3: Eastport\'s private note is not in the releasing club\'s row (§34 / #8)');
  await devPage.click(`[data-testid="tx-toggle-${TX}"]`);
  await sleep(500);
  neg(!/budget ceiling/.test(await devPage.locator(`[data-testid="club-tx-${TX}"]`).innerText()), 'F3b: nor anywhere in its expanded workspace');
  await devPage.locator(`[data-testid="tx-confirm-${TX}"]`).click();
  ok(await waitFor(async () => /Confirmed on/i.test(await devPage.locator(`[data-testid="club-tx-${TX}"]`).innerText({ timeout: 1500 }).catch(() => '')), 20000), 'F4: Harbour confirms its own participation');
  await devPage.selectOption(`[data-testid="tx-note-vis-${TX}"]`, 'RELEASING_CLUB_PRIVATE');
  await devPage.fill(`[data-testid="tx-note-text-${TX}"]`, 'Harbour will not release before the window closes.');
  await devPage.click(`[data-testid="tx-note-add-${TX}"]`);
  ok(await waitFor(async () => /window closes/.test(await devPage.locator(`[data-testid="club-tx-${TX}"]`).innerText({ timeout: 1500 }).catch(() => '')), 20000), 'F5: it records a note kept to the releasing club');
  // …and Eastport cannot read it.
  await mariaPage.reload();
  await mariaPage.waitForSelector('[role="tablist"]', { timeout: 20000 });
  await mariaPage.click('button[role="tab"]:has-text("Transactions")');
  await mariaPage.waitForSelector('[data-testid="club-transactions"]', { timeout: 15000 });
  await mariaPage.click(`[data-testid="tx-toggle-${TX}"]`);
  await sleep(600);
  neg(!/window closes/.test(await mariaPage.locator('[data-testid="club-transactions"]').innerText()), 'F6: the engaging club cannot read the releasing club\'s private note either — the boundary runs both ways (#7)');
}

// ============================================================== G — progress
{
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 20000 });
  await ana.click('[data-testid="tx-evaluate"]').catch(() => {});
  ok(await waitFor(async () => /clear/i.test(await ana.locator('[data-testid="tx-compliance-state"]').first().innerText({ timeout: 1500 }).catch(() => '')), 25000), 'G1: with every party confirmed and one representation, compliance is clear');
  const clear = await ana.locator('[data-testid="tx-compliance"]').first().innerText();
  neg(!/FIFA approved|legally valid|approved transfer/i.test(clear), 'G1b: "clear" never claims a governing body approved anything (§77)');
  ok(await waitFor(async () => (await ana.locator('[data-testid="tx-transition"][data-to="ACTIVE"]').count()) > 0, 15000), 'G2: only now does ACTIVE appear as an available transition');
  await ana.click('[data-testid="tx-transition"][data-to="ACTIVE"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="transaction-detail"]').getAttribute('data-status', { timeout: 1500 })) === 'ACTIVE', 20000), 'G3: she moves the workspace to ACTIVE');
  neg((await ana.locator('[data-testid="tx-transition"][data-to="ARCHIVED"]').count()) === 0, 'G3b: ARCHIVED is not offered from ACTIVE — the transition map is the server\'s, not a list of every state (§12)');
  const acts = await ana.locator('[data-testid="tx-actions"]').innerText();
  neg(!/offer|sign|negotiat/i.test(acts.replace(/[^.\n]*(no offer|not an offer|nothing is signed|does not sign|never negotiat|not negotiat)[^.\n]*[.\n]/gi, ' ')), 'G3c: and no action on an ACTIVE transaction is an offer, a signature or a negotiation (§18)');
}

// ============================================================== H — documents
{
  await ana.click('[data-testid="tx-tab-documents"]');
  await ana.waitForSelector('[data-testid="tx-panel-documents"]', { timeout: 10000 });
  await ana.selectOption('[data-testid="tx-doc-type"]', 'mandate');
  await ana.selectOption('[data-testid="tx-doc-visibility"]', 'AGENT_PRIVATE');
  await ana.fill('[data-testid="tx-doc-label"]', 'Ana working mandate note');
  await ana.click('[data-testid="tx-doc-add"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="tx-document"]').count()) > 0, 20000), 'H1: Ana records a document against the transaction, classified AGENT_PRIVATE (§32/§33)');
  const doc = await ana.locator('[data-testid="tx-document"]').first().innerText();
  ok(/Agent only|Agent/i.test(doc), 'H1b: the class is shown as a sentence about who can see it, not as an enum');
  await ana.locator('[data-testid="tx-doc-reference"]').first().click();
  ok(await waitFor(async () => (await ana.locator('[data-testid="tx-doc-reference-note"]').count()) > 0, 15000), 'H1c: asking for the document itself returns a reference into the canonical store, re-authorised on the spot (§31/§80)');
  const refNote = await ana.locator('[data-testid="tx-doc-reference-note"]').innerText();
  neg(/evidence vault|canonical evidence|placeholder/i.test(refNote) && !/https?:|blob:|data:/i.test(refNote), `H1d: …as a sentence about the canonical evidence store, never a URL the holder could keep (§80) — "${refNote.slice(0, 60)}…"`);
  // Nobody else sees it.
  await mariaPage.reload();
  await mariaPage.waitForSelector('[role="tablist"]', { timeout: 20000 });
  await mariaPage.click('button[role="tab"]:has-text("Transactions")');
  await mariaPage.click(`[data-testid="tx-toggle-${TX}"]`);
  await sleep(700);
  neg(!/working mandate/i.test(await mariaPage.locator('[data-testid="club-transactions"]').innerText()), 'H2: the engaging club cannot see the agent\'s private document (#10)');
  await kola.reload();
  await kola.waitForSelector('[data-testid="agent-transactions"]', { timeout: 30000 });
  neg(!/working mandate/i.test(await kola.locator('[data-testid="agent-transactions"]').innerText()), 'H3: nor can the individual (§48)');
}

// ============================================================== I — timeline
{
  await ana.click('[data-testid="tx-tab-timeline"]');
  await ana.waitForSelector('[data-testid="tx-panel-timeline"]', { timeout: 10000 });
  await waitFor(async () => (await ana.locator('[data-testid="tx-timeline-entry"]').count()) >= 4, 20000);
  const entries = await ana.locator('[data-testid="tx-timeline-entry"]').count();
  ok(entries >= 4, `I1: the agent's history carries what happened, in words (${entries} entries)`);
  const agentTimeline = await ana.locator('[data-testid="tx-panel-timeline"]').innerText();
  neg(!/budget ceiling|window closes/.test(agentTimeline), 'I1b: …and not the text of any club\'s private note — a timeline is an audience, not the audit (§39/§40)');
  const clubTl = await j('GET', `/org/transactions/${TX}/timeline`, undefined, maria.token);
  const agentTl = await j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, anaApi.token);
  neg(clubTl.body.items.length > 0 && clubTl.body.items.length < agentTl.body.items.length, `I2: the club's history is a SUBSET of the agent's — audience filtering, not the same feed (${clubTl.body.items.length} vs ${agentTl.body.items.length})`);
  neg(!JSON.stringify(clubTl.body).includes('AGENT_PRIVATE'), 'I2b: and no agent-private classification leaks into it');
}

// ============================================================== J — Trust & Safety
const ctxTs = await newContext({ viewport: { width: 1440, height: 900 } });
const ts = watch(await ctxTs.newPage(), 'trust-safety');
{
  await ts.goto(`http://localhost:${ADMIN_PORT}/`);
  await ts.waitForSelector('.login input[type="password"]', { timeout: 25000 });
  await ts.fill('.login input[type="password"]', ADMIN_KEY);
  await ts.click('button:has-text("Enter")');
  await ts.waitForSelector('nav.sidebar', { timeout: 25000 });
  await ts.click('nav.sidebar button:has-text("Agents")');
  await ts.waitForSelector('nav.subnav', { timeout: 15000 });
  await ts.click('nav.subnav button:has-text("Agent transactions")');
  await ts.waitForSelector('[data-testid="reviewer-signin"]', { timeout: 15000 });
  neg((await ts.locator('[data-testid="ts-transactions"]').count()) === 0, 'J1: the shared admin key alone renders no transaction read — the reviewer gate still applies (G-C0)');
  await ts.fill('[data-testid="reviewer-id"]', 'tsr-dev-reviewer');
  await ts.fill('[data-testid="reviewer-secret"]', 'dev-reviewer');
  await ts.click('[data-testid="reviewer-signin-go"]');
  ok(await waitFor(async () => (await ts.locator('[data-testid="ts-transactions"]').count()) > 0, 20000), 'J2: a named reviewer sees the transaction read');
  ok(await waitFor(async () => (await ts.locator(`[data-testid="ts-tx-${TX}"]`).count()) > 0, 20000), 'J3: the transaction is listed by id, type, jurisdiction and state');
  const row = await ts.locator(`[data-testid="ts-tx-${TX}"]`).innerText();
  ok(/individual/.test(row) && /engaging entity/.test(row) && /releasing entity/.test(row), 'J4: its parties are named by ROLE');
  neg(!/Kola|Adeyemi|Eastport FC|Harbour City FC|Maria|Dev Ansah/.test(row), 'J4b: …and by role ONLY — no person and no club is named to Trust & Safety here');
  neg(!/budget ceiling|window closes|working mandate/.test(await ts.locator('[data-testid="ts-transactions"]').innerText()), 'J5: no note text and no document label reaches the console — the contents are the parties\' (§40)');
  ok(/counts only/i.test(await ts.locator(`[data-testid="ts-tx-${TX}"]`).innerText()), 'J5b: the console says its document and note figures are counts only');
  const metrics = await ts.locator('[data-testid="tx-metrics"]').innerText();
  ok(/median/i.test(metrics) && /Process metrics/i.test(metrics), 'J6: the analytics are process metrics — durations and counts (§76)');
  neg(!/Ana|Kola|Eastport|Harbour|North Star/i.test(metrics), 'J6b: …and name no agent, club or player');
  neg(/is ranked|no agent, club or player/i.test(metrics), 'J6c: …and the panel says in as many words that nobody is ranked (§76)');
  neg((await ts.locator(`[data-testid="ts-tx-${TX}"] button`).count()) === 0, 'J7: there is no action on the row — Trust & Safety reads a transaction, it does not run one');
}

// ============================================================== N — negatives
{
  const screens = [];
  for (const [h, sel] of [['#/transactions', 'transactions-screen'], [`#/transactions/${TX}`, 'transaction-detail'], [`#/transactions/${TX}/compliance`, 'transaction-detail'], [`#/transactions/${TX}/messages`, 'transaction-detail']]) {
    await go(ana, h);
    // The hash decides which screen this is — going back to the list must leave
    // the detail behind, not keep it on screen (D12).
    ok(await waitFor(async () => (await ana.locator(`[data-testid="${sel}"]`).count()) > 0, 15000), `N0 ${h} renders its own screen, and only that one`);
    await sleep(500);
    screens.push(await bodyText(ana));
  }
  const txt = stripHonest(screens.join('\n'));
  neg(!/\boffers?\b|negotiat|commission|\bsalary\b|\bescrow\b/i.test(txt), 'N1: after removing the sentences that say there is none, no offer, negotiation, commission, salary or escrow wording remains on any transaction screen');
  neg(/no offer|not an offer|nothing has been signed/i.test(screens.slice(1).join('\n')), 'N1b: and the workspace says explicitly what it is not (§53)');
  // D14: the tab in the hash is the tab on screen, so screens[2] really was the
  // compliance tab and not whatever tab happened to be open before.
  await go(ana, `#/transactions/${TX}/documents`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  ok((await ana.locator('[data-testid="tx-panel-documents"]').count()) === 1, 'N1c: a tab deep link opens THAT tab (D14)');
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  ok((await ana.locator('[data-testid="tx-panel-overview"]').count()) === 1, 'N1d: …and the bare transaction link opens Overview, whichever tab was last used');
}
{
  const southgate = await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Zoe Bright', role: 'Agent', platform: 'agent' });
  const foreignAgent = await j('GET', `/org/agent/transactions/${TX}`, undefined, southgate.body?.token);
  const foreignClub = await j('GET', `/org/transactions/${TX}`, undefined, (await login('org-mossside', 'Nell Okafor', 'Secretary', 'grassroots')).token);
  const otherPlayer = (await j('POST', '/auth/player/login', { playerId: 'pl-okafor' })).body;
  const foreignPlayer = await j('GET', `/player/transactions/${TX}`, undefined, otherPlayer.token);
  neg(foreignClub.status === 404 && foreignClub.body.error === 'TRANSACTION_NOT_FOUND', `N2: a club that is not a party gets the uniform 404 for a real id (${foreignClub.status} ${foreignClub.body.error})`);
  neg(foreignPlayer.status === 404, `N2b: so does another individual (${foreignPlayer.status})`);
  neg(foreignAgent.status === 403 || foreignAgent.status === 404, `N2c: and an agency colleague with no licensed role gets no workspace either (${foreignAgent.status} ${foreignAgent.body.error ?? ''})`);
}
{
  const card = await kola.locator('[data-testid="agent-transactions"]').innerText();
  neg(!/budget ceiling|window closes/.test(card), 'N3: no club-private note reaches the individual\'s card (§47)');
  neg(!/Passport|medical|Box Cam/i.test(card), 'N3b: and being a party grants no blanket access to his own private records either');
}
{
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  for (const w of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await ana.setViewportSize(w);
    await sleep(500);
    ok(await ana.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N4: ${w.width}px: a transaction workspace has no horizontal scroll`);
    await go(ana, '#/transactions');
    await ana.waitForSelector('[data-testid="transactions-screen"]', { timeout: 15000 });
    ok(await ana.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N4b: ${w.width}px: so does the list`);
    await go(ana, `#/transactions/${TX}`);
    await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  }
  await ana.setViewportSize({ width: 1280, height: 900 });
  await sleep(400);
  ok(await ana.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N4c: 1280px: and no overflow at the narrower desktop width');
  await ana.setViewportSize({ width: 1440, height: 900 });
  await sleep(400);
  ok(await ana.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N4d: 1440px');
  const clubOverflow = await mariaPage.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(clubOverflow, 'N4e: the club projection does not overflow its console either (§85)');
}
{
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  const labels = await ana.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="transaction-detail"] select, [data-testid="transaction-detail"] input')];
    const un = els.filter((el) => !(el.closest('label') || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`))));
    return { total: els.length, unlabelled: un.length };
  });
  ok(labels.total >= 1 && labels.unlabelled === 0, `N5: every control on a transaction is labelled (${labels.total} controls)`);
  const tabs = await ana.evaluate(() => {
    const list = document.querySelector('[data-testid="tx-tabs"]');
    const btns = [...(list?.querySelectorAll('[role="tab"]') ?? [])];
    return { role: list?.getAttribute('role'), tabs: btns.length, selected: btns.filter((b) => b.getAttribute('aria-selected') === 'true').length, labelled: !!list?.getAttribute('aria-label') };
  });
  ok(tabs.role === 'tablist' && tabs.tabs === 6 && tabs.selected === 1 && tabs.labelled, `N5b: the six tabs are a labelled tablist with exactly one selected (${JSON.stringify(tabs)})`);
  const focusable = await ana.evaluate(() => [...document.querySelectorAll('[data-testid="transaction-detail"] button, [data-testid="transaction-detail"] select, [data-testid="transaction-detail"] input')].every((el) => el.tabIndex >= 0));
  ok(focusable, 'N5c: every control is reachable from the keyboard');
}
{
  await ana.selectOption('nav.sidebar select[aria-label="Language"]', 'fr');
  await sleep(700);
  const nav = await ana.locator('nav.sidebar').innerText();
  ok(/Transactions/.test(nav), 'N6: FR — the destination exists in French');
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  const txt = await bodyText(ana);
  ok(/En cours|Conformité|Parties|Documents|Historique/.test(txt), 'N6b: FR — the state, the tabs and the compliance wording are translated');
  neg(!/In progress|Compliance clear|awaiting confirmation/i.test(txt), 'N6c: FR — with no English fallback leaking through');
  await ana.selectOption('nav.sidebar select[aria-label="Langue"]', 'en');
  await sleep(500);
}
{
  const halPage = watch(await (await newContext({ viewport: { width: 1280, height: 900 } })).newPage(), 'hal');
  await halPage.goto(`http://localhost:${CLUB_PORT}/`);
  await halPage.waitForSelector('.org-card', { timeout: 25000 });
  await halPage.click('.org-card:has-text("Eastport")');
  await halPage.fill('.enter-row input:not(.login-pw)', 'Hal Meyer');
  await halPage.selectOption('.enter-row select', 'Coach').catch(() => {});
  await halPage.click('button:has-text("Enter workspace")');
  await halPage.waitForSelector('nav.sidebar', { timeout: 25000 });
  await go(halPage, '#/verification');
  await halPage.waitForSelector('[role="tablist"]', { timeout: 20000 });
  await halPage.click('button[role="tab"]:has-text("Transactions")');
  await halPage.waitForSelector('[data-testid="club-transactions"]', { timeout: 15000 });
  ok(await waitFor(async () => (await halPage.locator(`[data-testid="club-tx-${TX}"]`).count()) > 0, 20000), 'N7: a club user with no verification authority can READ the transaction his club is party to');
  neg((await halPage.locator('[data-testid="tx-not-signatory"]').count()) === 1, 'N7b: …and is told, in as many words, that binding the club needs its recorded administrator (§64)');
  const forced = await j('POST', `/org/transactions/${TX}/confirm`, { expectedRev: 99 }, hal.token);
  neg(forced.status === 403 || forced.status === 404, `N7c: and the server refuses him whatever the screen showed (${forced.status} ${forced.body.error ?? ''})`);
}
{
  neg((await ana.locator('[data-testid="tx-tab-offer"]').count()) === 0, 'N8: there is no Offer tab on a transaction');
  await go(ana, `#/transactions/${TX}/offer`);
  await sleep(700);
  neg((await ana.locator('[data-testid="transaction-detail"]').count()) === 0, 'N8b: an /offer deep link resolves to nothing — the hash cannot conjure a surface (§4)');
  const status = await j('POST', `/org/agent/transactions/${TX}/status`, { to: 'offer_made', clientKey: key(), expectedRev: 20 }, anaApi.token);
  neg(status.status === 400 || status.status === 409 || status.status === 422, `N8c: "offer_made" is not a state the server will accept (${status.status} ${status.body.error ?? ''})`);
}
{
  // Archive it, then prove the workspace is read-only for everyone including its owner.
  const now = await j('GET', `/org/agent/transactions/${TX}`, undefined, anaApi.token);
  const rev = now.body.transaction.rev;
  const cancel = await j('POST', `/org/agent/transactions/${TX}/status`, { to: 'CANCELLED', reasonCode: 'party_withdrew', clientKey: key(), expectedRev: rev }, anaApi.token);
  const arch = await j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ARCHIVED', clientKey: key(), expectedRev: cancel.body.transaction?.rev }, anaApi.token);
  ok(arch.status === 200 && arch.body.transaction.status === 'ARCHIVED', `N9: the workspace is cancelled with a reason and then archived (cancel ${cancel.status} ${cancel.body.error ?? ''} / archive ${arch.status} ${arch.body.error ?? ''})`);
  const keptTimeline = (await j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, anaApi.token)).body.items ?? [];
  neg(arch.body.transaction.parties.length === 3 && keptTimeline.length > 0, `N9b: cancelling and archiving preserved the parties and the history — nothing was deleted (${arch.body.transaction.parties.length} parties, ${keptTimeline.length} history entries) (§20/§22)`);
  const write = await j('POST', `/org/agent/transactions/${TX}/notes`, { visibility: 'AGENT_PRIVATE', text: 'after the fact', expectedRev: arch.body.transaction.rev }, anaApi.token);
  neg(write.status === 409 && write.body.error === 'TRANSACTION_ARCHIVED', `N9c: an archived transaction refuses a new write, for its owner too (#30, ${write.status} ${write.body.error})`);
  await go(ana, `#/transactions/${TX}`);
  await ana.waitForSelector('[data-testid="transaction-detail"]', { timeout: 15000 });
  ok(await waitFor(async () => (await ana.locator('[data-testid="tx-no-actions"]').count()) > 0, 15000), 'N9d: and the workspace offers no action at all');
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any of the five surfaces');
console.log(`\nM23 P5.6D TRANSACTION LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
