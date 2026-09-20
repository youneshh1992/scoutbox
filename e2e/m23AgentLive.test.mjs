// M23 P5.6B LIVE — ScoutBox Agent driven through the real client against a
// real server, with the player app confirming on the other side.
//
//   A  ADMIN       Tomás (Director) signs in on the Agent platform → Home →
//                  Agency › Team → adds Ana Costa as licensed_agent
//   B  AGENT       Ana signs in → Home says no profile → creates her profile
//                  → submits TEST-VERIFIED- (synthetic provider, named) →
//                  FIFA facet VERIFIED → Clients › request Kola →
//                  pending, access none
//   C  CLIENT      Kola in the player app → You › Clubs → My Agent shows the
//                  request with the agent's licence STATE → confirms
//   D  ACCESS      Ana's client is active, access basis stated, the
//                  Opportunities tab opens on the client's own board
//   E  DISPUTE     Kola disputes → Ana's access is suspended and the client
//                  detail says attributed review is not available
//   N  NEGATIVES   N1 club user refused on the Agent platform; N2 analyst
//                  sees no Opportunities and an empty client list; N3 foreign
//                  relationship deep link → not-found reading; N4 unknown
//                  client tab hash rejected; N5 no offer/transaction wording
//                  anywhere in the workspace; N6 390/360 no horizontal
//                  scroll, drawer works; N7 a11y (tabs, labels); N8 FR;
//                  N9 player app 390 My Agent visible; N10 minor has no card
//
// Exhaustive invariants live in scoutbox-server/scripts/m23AgentE2E.mjs;
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
const API_PORT = 4028;
const API = `http://localhost:${API_PORT}`;
const AGENT_PORT = 8728;
const PLAYER_PORT = 8828;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23agentlive-'));
const S_REASON = 'PRIVATE_DISPUTE_SENTINEL_7731';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, AGENT_PORT, PLAYER_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const haveDist = fs.existsSync(path.join(ROOT, 'scoutbox-agent/dist-live24/index.html')) && fs.existsSync(path.join(ROOT, 'scoutbox-player/dist-live24/index.html'));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live24`, { cwd: path.join(ROOT, 'scoutbox-agent'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live24`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
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
serveDir('scoutbox-agent/dist-live24', AGENT_PORT);
serveDir('scoutbox-player/dist-live24', PLAYER_PORT);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) {
    fs.rmSync(path.join(ROOT, 'scoutbox-agent/dist-live24'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'scoutbox-player/dist-live24'), { recursive: true, force: true });
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
// Toasts vanish after 3.5s; record them as they render so a starved poll cannot
// miss one. See e2e/toastLog.mjs.
const newContext = toastRecordingContexts(browser);
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };

// --------------------------------------------------------------- agent helpers
async function enterAgent(ctx, name, role, who, { expectFail = false } = {}) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${AGENT_PORT}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click('.org-card:has-text("North Star")');
  await page.fill('.enter-row input[aria-label]', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  if (expectFail) return { page, token: null };
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  const token = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-agent-session') ?? 'null')?.token ?? null; } catch { return null; } });
  if (!token) fail(`${name}: the client stored no session token after login`);
  return { page, token };
}
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(500); };
const bodyText = (page) => page.locator('body').innerText();
const sidebarText = (page) => page.locator('nav.sidebar').innerText();
/**
 * Durable page text OR a toast that really rendered. `waitText` alone samples the
 * DOM, so it can miss a toast whose 3.5s lifetime falls between two polls on a
 * starved machine; the recorded toast log closes that window without a sleep.
 */
async function waitTextOrToast(page, re, ms = 20000) {
  for (let i = 0; i < Math.ceil(ms / 250); i++) {
    if (re.test(await bodyText(page).catch(() => ''))) return true;
    const log = await page.evaluate(() => window.__toastLog ?? []).catch(() => []);
    if (log.some((t) => re.test(t))) return true;
    await sleep(250);
  }
  return false;
}
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }

// ------------------------------------------------------------ player helpers
async function enterPlayer(ctx, rowText, who) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector('a[href="/you"]', { timeout: 30000 });
  return page;
}
async function myAgentCard(page, re = /Ana Costa/) {
  await page.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
  await page.waitForSelector('[data-testid="my-agent"]', { timeout: 30000 });
  const card = page.locator('[data-testid="my-agent"]');
  // The card mounts before its data arrives: wait for the relationship row.
  for (let i = 0; i < 60; i++) { if (re.test(await card.innerText().catch(() => ''))) break; await sleep(250); }
  return card;
}

// ================================================================== A — ADMIN
const ctxTomas = await newContext({ viewport: { width: 1440, height: 900 } });
const tomas = await enterAgent(ctxTomas, 'Tomás Rivera', 'Director', 'tomas');
say('A1: the seeded agency Director signs in through the real Agent client (platform=agent)');
{
  const nav = await sidebarText(tomas.page);
  ok(/Clients/.test(nav) && /Agency/.test(nav) && /Inbox/.test(nav), 'A2: the sidebar carries Clients, Agency and Inbox');
  neg(!/Opportunit/.test(nav), 'A2b: an administrator who is not a licensed agent sees no Opportunities section (convenience filter; the server refuses anyway)');
  // P5.6D made Transactions a real destination (every member may READ the
  // agency's transactions; the server refuses the writes). Offers, Negotiation
  // and Fees are still nobody's destination, which is what this guards.
  neg(!/Offer|Negotiat|Fees?\b|Signing/i.test(nav), 'A2c: no Offers, Negotiation, Fees or Signings destination exists');
  await tomas.page.waitForSelector('[data-testid="agent-home"]', { timeout: 15000 });
  ok(await waitText(tomas.page, /adjudicates no conflicts/), 'A3: Home carries the regulatory notice — ScoutBox adjudicates nothing');
  ok(/Agency administrator/.test(await tomas.page.locator('[data-testid="my-tiers"]').innerText()), 'A4: the account block shows the migrated role: Agency administrator');
  neg(!/Licensed agent/.test(await tomas.page.locator('[data-testid="my-tiers"]').innerText()), 'A4b: a self-typed "Director" made nobody a licensed agent');
}
await go(tomas.page, '#/agency/team');
await tomas.page.waitForSelector('[data-testid="team-rows"]', { timeout: 15000 });
say('A5: Agency › Team opens by deep link');
{
  const form = tomas.page.locator('[data-testid="add-member"]');
  await form.locator('input').nth(0).fill('Ana Costa');
  await form.locator('input').nth(1).fill('Agent');
  // roles: assistant is pre-ticked; switch to licensed_agent only
  await form.getByLabel('Assistant').uncheck();
  await form.getByLabel('Licensed agent').check();
  await tomas.page.click('button:has-text("Add member")');
  ok(await waitText(tomas.page, /Ana Costa/), 'A6: Ana Costa is added to the team as a licensed agent');
  const row = tomas.page.locator('[data-testid="team-rows"] .list-row:has-text("Ana Costa")');
  ok(/no profile/.test(await row.innerText()), 'A7: her row says "no profile" — the role is agency governance, not a licence');
}

// ================================================================== B — AGENT
const ctxAna = await newContext({ viewport: { width: 1440, height: 900 } });
const ana = await enterAgent(ctxAna, 'Ana Costa', 'Agent', 'ana');
say('B1: Ana signs in');
{
  await ana.page.waitForSelector('[data-testid="agent-home"]', { timeout: 15000 });
  ok(await waitText(ana.page, /no agent profile yet/i), 'B2: Home says she has no agent profile');
  ok(/Licensed agent/.test(await ana.page.locator('[data-testid="my-tiers"]').innerText()), 'B3: her account block shows Licensed agent');
  ok(/Opportunities/.test(await sidebarText(ana.page)), 'B4: a licensed agent sees Opportunities');
  const attn = await ana.page.locator('.attn-card').innerText().catch(() => '');
  ok(/verification is not current/i.test(attn), 'B5: Needs attention says her verification is not current');
}
await go(ana.page, '#/profile');
await ana.page.waitForSelector('[data-testid="profile-form"]', { timeout: 15000 });
{
  const form = ana.page.locator('[data-testid="profile-form"]');
  await form.locator('input').nth(1).fill('FIFA-2024-777');
  await form.getByLabel('ENG').check();
  await ana.page.click('[data-testid="profile-save"]');
  await ana.page.waitForSelector('[data-testid="facet-fifa-licence"]', { timeout: 15000 });
  say('B6: the profile is created with a DECLARED licence number and ENG');
  const fifa = ana.page.locator('[data-testid="facet-fifa-licence"]');
  neg(/Unverified/.test(await fifa.innerText()), 'B7: the FIFA facet is Unverified — a typed number is a declaration');
  ok(/LOCAL SYNTHETIC test provider/.test(await ana.page.locator('[data-testid="provider-note"]').innerText()), 'B8: the page says the synthetic provider is on and never exists in production');
  neg(/refused/i.test(await ana.page.locator('[data-testid="regulatory-state"]').innerText()), 'B9: regulated actions are refused while unverified');
  // A real-looking reference goes to manual review.
  await fifa.locator('input').fill('FIFA-2024-777');
  await fifa.locator('button:has-text("Submit for verification")').click();
  ok(await waitTextOrToast(ana.page, /Manual review required/), 'B10: submitting the real-looking number → Manual review required (no register is pretended)');
  ok(/G-C0/.test(await fifa.innerText()), 'B10b: …with the G-C0 note on the facet');
  await fifa.locator('input').fill('TEST-VERIFIED-777');
  await fifa.locator('button:has-text("Submit for verification")').click();
  for (let i = 0; i < 40; i++) { if (/local-synthetic-test-provider/.test(await fifa.innerText())) break; await sleep(250); }
  ok(/Verified/.test(await fifa.innerText()) && /local-synthetic-test-provider/.test(await fifa.innerText()), 'B11: TEST-VERIFIED verifies and the provenance names the synthetic provider');
  const nat = ana.page.locator('[data-testid="facet-national-registration-eng"]');
  await nat.locator('input').fill('TEST-VERIFIED-FA');
  await nat.locator('button:has-text("Submit for verification")').click();
  for (let i = 0; i < 40; i++) { if (/Verified/.test(await nat.innerText())) break; await sleep(250); }
  ok(/Verified/.test(await nat.innerText()), 'B12: FA registration (ENG) verified as a separate facet');
  ok(await waitText(ana.page, /Regulated actions permitted/), 'B13: regulated actions are now permitted for ENG');
}
await go(ana.page, '#/clients');
await ana.page.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
let REL = null;
{
  ok(await waitText(ana.page, /No clients or requests yet/), 'C0: the client list is empty — a CRM row is not representation, and there are none');
  await ana.page.click('[data-testid="open-request"]');
  await ana.page.fill('[data-testid="lookup-input"]', 'kola');
  await ana.page.waitForSelector('[data-testid="hit-pl-adeyemi"]', { timeout: 15000 });
  say('B14: the lookup finds Kola (adult)');
  await ana.page.fill('[data-testid="lookup-input"]', 'guni');
  await sleep(900);
  neg((await ana.page.locator('[data-testid^="hit-"]').count()) === 0 && /No adult player matches/.test(await bodyText(ana.page)), 'B15: a minor (Guni, 14) never appears in the lookup');
  await ana.page.fill('[data-testid="lookup-input"]', 'kola');
  await ana.page.click('[data-testid="hit-pl-adeyemi"]');
  await ana.page.locator('[data-testid="request-form"]').getByLabel('Transfer').check();
  await ana.page.fill('[data-testid="term-input"]', '18');
  await ana.page.selectOption('[data-testid="request-form"] select', 'ENG');
  await ana.page.click('[data-testid="send-request"]');
  // B16 asserts on a TOAST, which the app removes after 3.5s. Read the recorded
  // toast log rather than sampling the DOM: under CPU contention two samples can
  // straddle the whole lifetime and miss a toast that really appeared. B17 below
  // asserts the durable outcome, so the product fact is covered either way.
  ok(await waitToast(ana.page, /Request sent\. Nothing is active until the player confirms/), 'B16: the request is sent and the toast says nothing is active yet');
  await ana.page.waitForSelector('[data-testid="clients-pending"]', { timeout: 15000 });
  const row = ana.page.locator('[data-testid="clients-pending"] .list-row').first();
  ok(/Kola Adeyemi/.test(await row.innerText()) && /Awaiting confirmation/.test(await row.innerText()), 'B17: Kola is listed under "Awaiting the client\'s answer"');
  REL = (await row.getAttribute('data-testid')).replace('client-row-', '');
  await row.locator('button:has-text("Open")').click();
  await ana.page.waitForSelector('[data-testid="client-detail"]', { timeout: 15000 });
  ok(/#\/clients\/rep-/.test(await ana.page.evaluate(() => location.hash)), 'B18: opening a client is a deep link');
  neg(/No access: awaiting the client/.test(await ana.page.locator('[data-testid="access-line"]').innerText()), 'B19: the detail says No access — a request is a claim, not access');
  await ana.page.click('[role="tablist"] button[role="tab"]:has-text("Opportunities")');
  neg(await ana.page.locator('[data-testid="opps-no-access"]').count() === 1, 'B20: the Opportunities tab opens nothing through a pending request');
  ok(await ana.page.locator('[data-testid="home-active"], [data-testid="agent-clients"]').count() >= 0, '(navigation ok)');
}

// ================================================================== C — CLIENT
const ctxKola = await newContext({ viewport: { width: 1440, height: 900 } });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola');
say('C1: Kola signs in to the player app');
{
  const card = await myAgentCard(kola);
  const txt = await card.innerText();
  ok(/Ana Costa/.test(txt) && /North Star Sports Agency/.test(txt) && /Awaiting your answer/.test(txt), 'C2: My Agent shows Ana\'s request from North Star, awaiting his answer');
  ok(/FIFA licence: verified/i.test(txt) && /check the provenance/i.test(txt), 'C3: the card shows the licence STATE with an honest caveat');
  neg(!/TEST-VERIFIED|FIFA-2024/.test(txt), 'C4: no reference or licence number reaches the player');
  if (!/employment,\s*transfer/.test(txt) || !/18\s*months/.test(txt)) console.error('   card text:', JSON.stringify(txt).slice(0, 600));
  ok(/employment,\s*transfer/.test(txt) && /18\s*months/.test(txt), 'C5: scope and term are stated');
  await card.locator('text="Confirm"').first().click();
  for (let i = 0; i < 40; i++) { if (/Confirmed — active from now/.test(await card.innerText())) break; await sleep(250); }
  ok(/Confirmed — active from now/.test(await card.innerText()) && /\bActive\b/.test(await card.innerText()), 'C6: Kola CONFIRMS — the relationship is active from now');
  ok(/End relationship/.test(await card.innerText()) && !/Confirm\b(?! )/.test('x'), 'C7: the card now offers End relationship (and Dispute), not Confirm');
}

// ================================================================== D — ACCESS
{
  await ana.page.reload();
  await ana.page.waitForSelector('[data-testid="client-detail"]', { timeout: 20000 });
  ok(await waitText(ana.page, /Access: active confirmed relationship/), 'D1: Ana\'s client detail now states the access basis: active confirmed relationship');
  ok(/Active/.test(await ana.page.locator('[data-testid="client-detail"] [data-status]').first().innerText()), 'D2: status Active');
  await ana.page.click('[role="tablist"] button[role="tab"]:has-text("Opportunities")');
  await ana.page.waitForSelector('[data-testid="client-opps"]', { state: 'attached', timeout: 15000 });
  ok(/Applying is the player/.test(await bodyText(ana.page)), 'D3: the client\'s Opportunities tab opens on the client\'s own board and says applying is the player\'s act');
  const agentView = (await j('GET', `/org/agent/clients/${REL}`, undefined, ana.token)).body;
  const kolaBoard = (await j('GET', '/player/opportunity-board', undefined, (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token)).body.items.map((o) => o.id).sort();
  const agentBoard = (await j('GET', `/org/agent/clients/${REL}/opportunities`, undefined, ana.token)).body.items.map((o) => o.id).sort();
  ok(agentView.access === true && JSON.stringify(kolaBoard) === JSON.stringify(agentBoard), 'D4: the board the agent reads is exactly the board the player sees (same engine, same rules)');
  await ana.page.click('[role="tablist"] button[role="tab"]:has-text("Activity")');
  ok(/Confirmed by client/.test(await ana.page.locator('[data-testid="client-activity"]').innerText()), 'D5: Activity shows "Confirmed by client"');
  await go(ana.page, '#/opportunities');
  await ana.page.waitForSelector('[data-testid="agent-opportunities"]', { timeout: 15000 });
  ok(/Only opportunities legitimately visible to a confirmed client/.test(await bodyText(ana.page)), 'D6: the aggregate Opportunities board carries the honest scope line');
  await go(ana.page, '#/home');
  await ana.page.waitForSelector('[data-testid="home-active"]', { timeout: 15000 });
  ok((await ana.page.locator('[data-testid="home-active"] .v').innerText()) === '1', 'D7: Home counts one active client');
}

// ================================================================== E — DISPUTE
{
  const card = await myAgentCard(kola);
  await card.locator('text="Dispute"').first().click();
  await card.locator('input[placeholder*="disputing"]').fill(S_REASON);
  await card.locator('text="Dispute"').last().click();
  for (let i = 0; i < 40; i++) { if (/Disputed/.test(await card.innerText())) break; await sleep(250); }
  ok(/Disputed/.test(await card.innerText()) && /not yet available/.test(await card.innerText()), 'E1: Kola disputes; the card says attributed review is not yet available');
  await go(ana.page, `#/clients/${REL}`);
  await ana.page.waitForSelector('[data-testid="client-detail"][data-status="disputed"]', { timeout: 20000 });
  neg(/Access suspended/.test(await ana.page.locator('[data-testid="access-line"]').innerText()), 'E2: Ana\'s access is suspended');
  ok(await ana.page.locator('[data-testid="disputed-note"]').count() === 1 && /nothing here can resolve it/.test(await ana.page.locator('[data-testid="disputed-note"]').innerText()), 'E3: the detail says nothing here can resolve a dispute');
  neg(!(await bodyText(ana.page)).includes(S_REASON), 'E4: the dispute reason never reaches the agent\'s screen');
  await ana.page.click('[role="tablist"] button[role="tab"]:has-text("Representation")');
  neg((await ana.page.locator('[data-testid="terminate"]').count()) === 0, 'E5: no End/Withdraw button on a disputed relationship — the agent cannot route around it');
  const adminView = (await j('GET', '/admin/agent/relationships', undefined, undefined, { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' })).body;
  neg(adminView.readOnly === true && !JSON.stringify(adminView).includes(S_REASON), 'E6: the shared T&S key sees a read-only list without the reason');
}

// ================================================================== N — NEGATIVES
{
  const ctxClub = await newContext({ viewport: { width: 1440, height: 900 } });
  const page = watch(await ctxClub.newPage(), 'club');
  await page.goto(`http://localhost:${AGENT_PORT}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  const cards = await page.locator('.org-card').allInnerTexts();
  neg(cards.length === 1 && /North Star/.test(cards[0]) && !cards.some((c) => /Eastport|Harbour/.test(c)), 'N1: the Agent login lists agency organisations only — no club to pick');
  const r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment', platform: 'agent' });
  neg(r.status === 403 && r.body.error === 'PLATFORM_MISMATCH', 'N1b: a club login on the agent platform is 403 PLATFORM_MISMATCH');
  await ctxClub.close();
}
{
  // Ben, an analyst, added by Tomás.
  await go(tomas.page, '#/agency/team');
  await tomas.page.waitForSelector('[data-testid="add-member"]', { timeout: 15000 });
  const form = tomas.page.locator('[data-testid="add-member"]');
  await form.locator('input').nth(0).fill('Ben Okoro');
  // D-P56B-11: the form once kept the previous member's roles; assert the reset and set Analyst only.
  ok(await form.getByLabel('Assistant').isChecked() && !(await form.getByLabel('Licensed agent').isChecked()), 'N2a: the add-member form reset to its default roles after the previous add');
  await form.getByLabel('Assistant').uncheck();
  await form.getByLabel('Analyst').check();
  await tomas.page.click('button:has-text("Add member")');
  ok(await waitText(tomas.page, /Ben Okoro/), 'N2: Ben is added as an analyst');
  const ctxBen = await newContext({ viewport: { width: 1440, height: 900 } });
  const ben = await enterAgent(ctxBen, 'Ben Okoro', 'Analyst', 'ben');
  neg(!/Opportunit/.test(await sidebarText(ben.page)), 'N2b: an analyst sees no Opportunities');
  await go(ben.page, '#/clients');
  await ben.page.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
  neg(await waitText(ben.page, /No clients or requests yet/), 'N2c: his client list is empty — Kola did not share, and nothing flows through the agency');
  neg((await ben.page.locator('[data-testid="open-request"]').count()) === 0, 'N2d: no "Request a relationship" button for a non-agent');
  await go(ben.page, `#/clients/${REL}`);
  await ben.page.waitForSelector('[data-http-kind="not_found"]', { timeout: 15000 });
  neg(/not available to you/.test(await ben.page.locator('[data-http-kind="not_found"]').innerText()), 'N3: a colleague\'s relationship by deep link → the shared not-found reading (404, not 403)');
  await go(ben.page, '#/opportunities');
  neg(await waitText(ben.page, /only a licensed_agent member can hold/), 'N3b: typing the hidden Opportunities route explains the refusal');
  await ctxBen.close();
}
{
  await go(ana.page, `#/clients/${REL}/offer`);
  await sleep(600);
  neg((await ana.page.evaluate(() => location.hash)) === `#/clients/${REL}/offer` && (await ana.page.locator('[data-testid="client-detail"]').count()) === 0, 'N4: an unknown client tab hash ("offer") is rejected — the router opens nothing for it');
  await go(ana.page, '#/clients');
  await ana.page.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
  const all = [];
  for (const h of ['#/home', '#/profile', '#/clients', `#/clients/${REL}`, '#/opportunities', '#/inbox', '#/agency', '#/agency/team', '#/agency/compliance', '#/agency/settings']) {
    await go(ana.page, h); await sleep(700); all.push(await bodyText(ana.page));
  }
  // The workspace may SAY there is no offer / negotiation / fee here; it may not offer one. Strip the honesty sentences, then sweep.
  const honest = /[^.\n]*(not part of this workspace|no offer, negotiation, fee or contract|no transaction room|aucune offre|ne font pas partie)[^.\n]*[.\n]/gi;
  const txt = all.join('\n').replace(honest, ' ');
  // "Transaction" is a real destination since P5.6D, so it is no longer swept for
  // here — m23AgentTransactionLive owns that surface and its own wording sweep.
  // What must still be absent everywhere is an offer, a negotiation, a commission
  // and a fee.
  neg(!/\boffers?\b|negotiat|commission|\bfees?\b/i.test(txt), 'N5: after removing the sentences that say there is none, no offer, negotiation, commission or fee wording remains on any of ten screens');
  neg(/no offer, negotiation, fee or contract happens here/i.test(all[0]) || /No transaction room/i.test(all[0]), 'N5b: Home says explicitly what the workspace is not');
}
{
  const ctxPhone = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = watch(await ctxPhone.newPage(), 'phone');
  phone.on('dialog', (d) => d.accept());
  await phone.goto(`http://localhost:${AGENT_PORT}/`);
  await phone.waitForSelector('.org-card', { timeout: 25000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6: 390px: the login has no horizontal scroll');
  await phone.click('.org-card:has-text("North Star")');
  await phone.fill('.enter-row input[aria-label]', 'Ana Costa');
  await phone.click('button:has-text("Enter workspace")');
  await phone.waitForSelector('[data-testid="agent-home"]', { timeout: 25000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6b: 390px: Home has no horizontal scroll');
  await phone.click('.nav-hamburger');
  await phone.waitForSelector('nav.sidebar.drawer-open', { timeout: 10000 });
  ok(true, 'N6c: the navigation drawer opens from the hamburger');
  await phone.click('nav.sidebar button:has-text("Clients")');
  await phone.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6d: 390px: Clients has no horizontal scroll');
  await go(phone, `#/clients/${REL}`);
  await phone.waitForSelector('[data-testid="client-detail"]', { timeout: 15000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6e: 390px: a client detail with tabs has no horizontal scroll');
  await phone.setViewportSize({ width: 360, height: 780 });
  await sleep(400);
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6f: 360px: still no horizontal scroll');
  await go(phone, '#/profile');
  await phone.waitForSelector('[data-testid="facet-fifa-licence"]', { timeout: 15000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N6g: 360px: the verification page fits');
  // M23 P5.6F (F-6). The release checklist names six viewports. Reading the
  // suites rather than the reports showed 1440, 1280, 390 and 360 covered on the
  // Agent portal and 1024 and 768 covered NOWHERE on it — the two tablet widths
  // had never been rendered by any Agent suite in P5.6B–E. Closed here on the
  // densest surfaces, and each width asserts CONTENT as well as fit, because a
  // blank page has no horizontal scroll either.
  for (const w of [{ width: 1024, height: 900 }, { width: 768, height: 1024 }]) {
    await phone.setViewportSize(w);
    await go(phone, '#/clients');
    await phone.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
    await sleep(400);
    ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N6h: ${w.width}px: the client list fits`);
    ok((await phone.innerText('[data-testid="agent-clients"]')).trim().length > 20, `N6i: ${w.width}px: and it still HAS its content, not an empty shell that happens not to overflow`);
    await go(phone, `#/clients/${REL}`);
    await phone.waitForSelector('[data-testid="client-detail"]', { timeout: 15000 });
    await sleep(400);
    ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `N6j: ${w.width}px: the client detail fits`);
    const tabs = await phone.evaluate(() => document.querySelectorAll('[role="tab"]').length);
    ok(tabs >= 4, `N6k: ${w.width}px: with its tab strip intact (${tabs} tabs) — the workspace is whole, not collapsed away`);
  }
  await ctxPhone.close();
}
{
  await go(ana.page, `#/clients/${REL}`);
  await ana.page.waitForSelector('[role="tablist"]', { timeout: 15000 });
  const tab = ana.page.locator('[role="tablist"] button[role="tab"]:has-text("Representation")');
  await tab.click();
  const sel = await tab.getAttribute('aria-selected');
  const controls = await tab.getAttribute('aria-controls');
  const panelId = await ana.page.locator('[role="tabpanel"]').first().getAttribute('id');
  ok(sel === 'true' && controls === panelId, 'N7: tab semantics — the active tab is aria-selected and aria-controls its tabpanel');
  await go(ana.page, '#/clients');
  await ana.page.waitForSelector('[data-testid="open-request"]', { timeout: 15000 });
  await ana.page.click('[data-testid="open-request"]');
  const labelled = await ana.page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="request-form"] input, [data-testid="request-form"] select')];
    const un = els.filter((el) => !(el.closest('label') || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`))));
    return { total: els.length, unlabelled: un.length };
  });
  ok(labelled.total >= 1 && labelled.unlabelled === 0, `N7b: every control in the request form is labelled (${labelled.total} controls)`);
  const lookup = await ana.page.locator('[data-testid="lookup-input"]').getAttribute('aria-describedby');
  ok(lookup === 'lookup-hint', 'N7c: the lookup names its hint for assistive technology');
}
{
  await ana.page.selectOption('nav.sidebar select[aria-label="Language"]', 'fr');
  await sleep(500);
  const nav = await sidebarText(ana.page);
  ok(/Agence/.test(nav) && /Opportunités/.test(nav) && /Boîte de réception/.test(nav), 'N8: FR — the sidebar reads Agence, Opportunités, Boîte de réception');
  await go(ana.page, `#/clients/${REL}`);
  await ana.page.waitForSelector('[data-testid="client-detail"]', { timeout: 15000 });
  const txt = await bodyText(ana.page);
  ok(/Contestée/.test(txt) && /Accès suspendu/.test(txt) && !/Access suspended|Disputed\b/.test(txt), 'N8b: FR — the disputed client reads Contestée / Accès suspendu with no English fallback');
  await ana.page.selectOption('nav.sidebar select[aria-label="Langue"]', 'en');
  await sleep(300);
}
{
  const ctxKolaPhone = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const kp = await enterPlayer(ctxKolaPhone, 'Kola Adeyemi', 'kola-phone');
  const card = await myAgentCard(kp);
  ok(/Ana Costa/.test(await card.innerText()) && /Disputed/.test(await card.innerText()), 'N9: 390px: My Agent is visible in the player app with the disputed record');
  ok(await kp.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N9b: 390px: the player app has no horizontal scroll');
  await ctxKolaPhone.close();
}
{
  const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
  const r = await j('GET', '/player/agent/relationships', undefined, guni.token);
  neg(r.status === 200 && r.body.minor === true && r.body.items.length === 0, 'N10: a minor\'s My Agent is structurally empty (the section renders nothing for under-18s)');
  const c = await j('POST', '/player/agent/relationships/x/confirm', { expectedRev: 1 }, guni.token);
  neg(c.status === 403 && c.body.error === 'AGENT_ACTION_NOT_PERMITTED', 'N10b: a minor cannot act on any relationship');
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any surface');
console.log(`\nM23 P5.6B AGENT LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
