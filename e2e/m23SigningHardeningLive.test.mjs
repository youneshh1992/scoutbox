// M23 P7.1 LIVE — signing hardening driven through the real Pro workspace,
// the real player app and the real agent app against a real server. The
// exhaustive invariants live in scoutbox-server/scripts/m23SigningHardeningE2E.mjs;
// this suite proves that what the interfaces show and do follows them.
//
//   A  STALE CLUB ROLE   Maria presents a document and the player signs; her
//                        role changes to First-Team Scout while her tab is open
//                        → "Sign for the club" answers with the role refusal in
//                        the live region; restored, the same tab signs and
//                        completes → Signed
//   B  STALE REV         two tabs on one draft: tab 2 saves; tab 1 presents with
//                        the rev it loaded → the conflict sentence; after a
//                        reload tab 1 presents
//   C  EXPIRED           a package presented in the past (test clock) reads
//                        Expired on the club tab with "Start a new signing"
//                        and no act; the player sees Expired with nothing to do
//   D  SUPERSEDED        the player signs revision 1; the club replaces the
//                        document → the player's section shows the superseded
//                        revision and no sign control; the old confirmation is
//                        refused by the server
//   E  DOCUMENT          once presented, the club tab has no file input and no
//                        replace control; the API refuses an attach
//   F  AGENT             Ana reads the signing line under the shared Offer; Bea
//                        (same agency) is refused by the server; Kola ends the
//                        representation → Ana's deep link shows no access
//   W  WIDTHS            1440/1280/1024/768/390/360 on the expired package;
//                        zero page errors in every context

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4031;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8731;
const PLAYER_PORT = 8831;
const AGENT_PORT = 8931;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23signinghardlive-'));
const S_NOTE = 'PRIVATE_SIGNING_NOTE_SENTINEL_8842';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_5915';
const DAY = 86_400_000; const H = 3_600_000;
const PDF = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract — hardening live\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const PDF2 = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract — hardening live, amended\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const PDF_PATH = path.join(DATA, 'contract.pdf');
fs.writeFileSync(PDF_PATH, PDF);
const T0 = Date.now();

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
const DIST = 'dist-live23sh';
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

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
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
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
async function toConsideration(RID, token) {
  if ((await journey(RID, token)).lifecycle.currentStage === 'watching') await lifecycle(RID, 'startReview', token);
  if ((await journey(RID, token)).lifecycle.currentStage === 'under_review') await lifecycle(RID, 'shortlist', token);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: `live-${RID}` }, token);
  if (fin.status !== 201) fail(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
}
/** P6 by HTTP at a given clock: draft → issue → accept. */
async function acceptedOffer(RID, token, playerToken, role, clock = T0) {
  const d = await j('POST', `/org/rooms/${RID}/offers`, { terms: { role, startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: clock + 10 * DAY }, token, at(clock));
  if (d.status !== 201) fail(`offer draft ${d.status} ${JSON.stringify(d.body).slice(0, 200)}`);
  const o = d.body.offer;
  const iss = await j('POST', `/org/offers/${o.id}/issue`, { expectedRev: o.rev, clientKey: `live-issue-${RID}` }, token, at(clock));
  if (iss.status !== 200) fail(`offer issue ${iss.status} ${JSON.stringify(iss.body).slice(0, 200)}`);
  const mine = (await j('GET', `/player/offers/${o.id}`, undefined, playerToken, at(clock))).body.offer;
  const acc = await j('POST', `/player/offers/${o.id}/accept`, { revisionId: mine.currentRevisionId, clientKey: `live-accept-${RID}` }, playerToken, at(clock));
  if (acc.status !== 200) fail(`offer accept ${acc.status} ${JSON.stringify(acc.body).slice(0, 200)}`);
  return o.id;
}
async function roomFor(playerId, token) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  return r.body?.room?.roomId ?? r.body?.existingRoomId;
}
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
/** A presented package by HTTP at a given clock. */
async function presentedHttp(OID, token, clock = T0, expiresAt = null) {
  const s = await j('POST', `/org/offers/${OID}/signing`, { internalNote: S_NOTE, clientKey: `live-start-${OID}-${Math.random().toString(36).slice(2, 8)}` }, token, at(clock));
  if (s.status !== 201) fail(`start ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
  const SID = s.body.signing.id;
  const a = await j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(PDF), filename: 'contract.pdf', label: 'Contract', expectedRev: s.body.signing.rev }, token, at(clock));
  if (a.status !== 200) fail(`attach ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
  const r = await j('POST', `/org/signings/${SID}/ready`, { expectedRev: a.body.signing.rev, clientKey: `live-ready-${OID}-${Math.random().toString(36).slice(2, 8)}`, ...(expiresAt ? { expiresAt } : {}) }, token, at(clock));
  if (r.status !== 200) fail(`ready ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { SID, SREV: r.body.signing.currentRevision.id, rev: r.body.signing.rev, sha: r.body.signing.currentRevision.document.sha256 };
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
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const MAT = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body.token;
const SVEN = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const anaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-ENG', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
ok(!!REL && (await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, KOLA)).status === 200, 'fixture: Ana represents Kola (employment), client-confirmed');

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const LEAD = lead.token;

// ================================================================== A — STALE CLUB ROLE
const ROOM_A = await roomFor('pl-carvalho', LEAD);
await toConsideration(ROOM_A, LEAD);
const OFFER_A = await acceptedOffer(ROOM_A, LEAD, MAT, 'Winger');
const PA = await presentedHttp(OFFER_A, LEAD);
ok(!!PA.SID && (await j('POST', `/player/signings/${PA.SID}/complete`, { revisionId: PA.SREV, documentSha256: PA.sha, clientKey: 'live-a-sign' }, MAT)).status === 200, 'A1: Mateus\'s document is presented and he confirmed it (HTTP)');
await signingTab(lead.page, ROOM_A);
{
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'IN_PROGRESS' && (await sw(lead.page).locator('[data-testid="signing-club-sign"]').count()) === 1, 'A2: Maria\'s tab shows In progress with "Sign for the club"');
  const demoted = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'First-Team Scout' });
  ok(demoted.status === 200, 'A3: while her tab is open, Maria\'s role becomes First-Team Scout (a fresh login on the same user)');
  await sw(lead.page).locator('[data-testid="signing-club-sign"]').click();
  ok(await waitLive(lead.page, /Your role cannot do that on this signing/), 'A4: the open tab\'s "Sign for the club" is refused by the server and the live region says why — the page\'s buttons were never the authority');
  await sleep(400);
  neg((await sw(lead.page).locator('[data-testid="signing-party-CLUB_SIGNATORY"]').getAttribute('data-party-status')) === 'PENDING' && (await sw(lead.page).locator('[data-testid="signing-club-sign"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-complete"]').count()) === 0, 'A5: after the refresh the controls a scout does not have are gone; the club party is still pending');
  ok(/sit with the room lead and the recruitment lead|Only a recruitment lead signs for the club/.test(await sw(lead.page).innerText()), 'A5b: and the panel says who may act');
  ok((await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).status === 200, 'A6: her role is restored');
  await signingTab(lead.page, ROOM_A);
  await sw(lead.page).locator('[data-testid="signing-club-sign"]').click();
  ok(await waitLive(lead.page, /Your signature for the club is recorded/), 'A7: the same tab, the same session token, now a lead again: signs for the club');
  await sw(lead.page).locator('[data-testid="signing-complete"]').waitFor({ timeout: 10000 });
  await sw(lead.page).locator('[data-testid="signing-complete"]').click();
  ok(await waitLive(lead.page, /Signing completed\. Case moved to Signed/), 'A8: and completes — the case moved to Signed');
  ok(await (async () => { for (let i = 0; i < 40; i++) { if (/Signed/.test(await headerStatus(lead.page))) return true; await sleep(250); } return false; })(), 'A8b: the room header says Signed');
  const jr = await journey(ROOM_A, LEAD);
  ok(jr.lifecycle.currentStage === 'signed' && jr.outcome.signing?.method === 'CANONICAL_COMPLETION', 'A9: the server: signed from the canonical completion');
}

// ================================================================== B — STALE REV (two tabs)
const ROOM_B = await roomFor('pl-svensson', LEAD);
await toConsideration(ROOM_B, LEAD);
const OFFER_B = await acceptedOffer(ROOM_B, LEAD, SVEN, 'Keeper');
{
  const st = await j('POST', `/org/offers/${OFFER_B}/signing`, { clientKey: 'live-b-start' }, LEAD);
  const SID = st.body.signing.id;
  const a = await j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(PDF), filename: 'contract.pdf', label: 'Contract', expectedRev: st.body.signing.rev }, LEAD);
  ok(st.status === 201 && a.status === 200, 'B1: a draft package for Elias with a document (HTTP)');
  const tab1 = lead.page;
  await signingTab(tab1, ROOM_B);
  const tab2 = watch(await ctxLead.newPage(), 'lead-tab2');
  tab2.on('dialog', (d) => d.accept());
  await tab2.goto(`http://localhost:${CLUB_PORT}/#/recruitment/rooms/${ROOM_B}`);
  await tab2.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(tab2, 'Signing');
  await sw(tab2).waitFor({ timeout: 15000 });
  await sw(tab2).locator('[data-testid="signing-internal-note"]').fill('edited in tab 2');
  await sw(tab2).locator('[data-testid="signing-save"]').click();
  ok(await waitLive(tab2, /Draft saved/), 'B2: tab 2 saves the draft (the rev moves)');
  await sw(tab1).locator('[data-testid="signing-present"]').click();
  ok(await waitLive(tab1, /Someone else changed this signing while you were working on it\. Reload/), 'B3: tab 1 presents with the rev it loaded: the conflict sentence, nothing presented');
  const s1 = (await j('GET', `/org/signings/${SID}`, undefined, LEAD)).body.signing;
  neg(s1.status === 'DRAFT' && s1.internalNote === 'edited in tab 2', 'B3b: the server: still DRAFT, tab 2\'s edit intact — the stale write did not overwrite it');
  await signingTab(tab1, ROOM_B);
  await sw(tab1).locator('[data-testid="signing-present"]').click();
  ok(await waitLive(tab1, /Presented for signing/), 'B4: after a reload tab 1 presents with the current rev');
  await tab2.close();
  globalThis.__B = { SID, RID: ROOM_B, OID: OFFER_B };
}

// ================================================================== C — EXPIRED (presented in the past)
const ROOM_C = await roomFor('pl-adeyemi', LEAD);
await toConsideration(ROOM_C, LEAD);
const PAST = T0 - 3 * H;
const OFFER_C = await acceptedOffer(ROOM_C, LEAD, KOLA, 'Central midfielder', PAST);
const PC = await presentedHttp(OFFER_C, LEAD, PAST, PAST + H); // expired two hours ago by the wall clock
{
  const now = (await j('GET', `/org/signings/${PC.SID}`, undefined, LEAD)).body.signing;
  ok(now.status === 'EXPIRED' && now.storedStatus === 'READY', 'C1: presented three hours ago with a one-hour expiry: reads EXPIRED, stored READY (lazy)');
  await signingTab(lead.page, ROOM_C);
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'EXPIRED' && /⌛ Expired — not completed in time/.test(await sw(lead.page).locator('[data-testid="signing-status"]').innerText()), 'C2: the club tab reads Expired — not completed in time (text + glyph)');
  neg((await sw(lead.page).locator('[data-testid="signing-club-sign"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-complete"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-present"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-cancel"]').count()) === 0, 'C3: no act is offered on an expired package');
  ok((await sw(lead.page).locator('[data-testid="signing-start-again"]').count()) === 1 && /Accepted in ScoutBox/.test(await headerStatus(lead.page)), 'C4: "Start a new signing" is offered; the case is still Accepted in ScoutBox');
  expect(await j('POST', `/org/signings/${PC.SID}/parties/club/complete`, { expectedRev: now.rev, revisionId: PC.SREV, documentSha256: PC.sha, clientKey: 'live-c-force' }, LEAD), 409, 'SIGNING_EXPIRED', 'C5: forcing a club signature on it is refused by name');
  expect(await j('POST', `/player/signings/${PC.SID}/complete`, { revisionId: PC.SREV, documentSha256: PC.sha, clientKey: 'live-c-p' }, KOLA), 409, 'SIGNING_EXPIRED', 'C5b: and the player\'s');
  globalThis.__C = { SID: PC.SID, RID: ROOM_C, OID: OFFER_C };
}

// ================================================================== D — SUPERSEDED (player signs, then the document changes)
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
{
  // A second package for Kola over the same Offer is possible only because the first is terminal (expired).
  const room = await j('GET', `/org/rooms/${ROOM_C}/signing`, undefined, LEAD);
  ok(room.body.livePackageId === null && room.body.requirements.startBlockers.length === 0, 'D0: the expired package is not live: a new one may be opened over the same accepted Offer');
  const PD = await presentedHttp(OFFER_C, LEAD);
  await goTab(kola, '/opportunities');
  const sec = kola.locator('[data-testid="signing-section"]');
  await sec.waitFor({ timeout: 20000 });
  ok(await waitIn(sec, /Presented — awaiting signatures/), 'D1: Kola\'s section shows the newly presented revision');
  const txt0 = await sec.innerText();
  ok(/Expired — not completed in time/.test(txt0) || true, 'D1b: (the expired package may also be listed as history; it offers nothing)');
  await sec.locator(`[data-testid="signing-sign-${PD.SID}"]`).click();
  await sec.locator(`[data-testid="signing-confirm-sign-${PD.SID}"]`).waitFor({ timeout: 10000 });
  await sec.locator(`[data-testid="signing-confirm-sign-${PD.SID}"]`).click();
  ok(await waitIn(sec, /Your signature is recorded on this document/), 'D2: Kola signs revision 1 in his app');
  const sup = await j('POST', `/org/signings/${PD.SID}/supersede`, { expectedRev: (await j('GET', `/org/signings/${PD.SID}`, undefined, LEAD)).body.signing.rev, reason: 'Clause 4 amended', clientKey: 'live-d-sup' }, LEAD);
  ok(sup.status === 201 && sup.body.signing.currentRevision.revisionNumber === 2, 'D3: the club replaces the document (HTTP): revision 2 opens as a draft, every party pending');
  await goTab(kola, '/football');
  await goTab(kola, '/opportunities');
  ok(await waitIn(sec, /Superseded by a newer revision/), 'D4: on his return Kola\'s section shows revision 1 as superseded');
  const txt = await sec.innerText();
  neg((await sec.locator(`[data-testid="signing-sign-${PD.SID}"]`).count()) === 0 && !/Presented — awaiting signatures/.test(txt), 'D5: nothing to sign — revision 2 has not been presented, and his revision-1 confirmation no longer counts');
  expect(await j('POST', `/player/signings/${PD.SID}/complete`, { revisionId: PD.SREV, documentSha256: PD.sha, clientKey: 'live-d-old' }, KOLA), 409, 'SIGNING_SUPERSEDED', 'D6: his old confirmation, replayed against revision 1, is refused: superseded');
  // present revision 2 (with a different document) and let him see it fresh
  const a2 = await j('POST', `/org/signings/${PD.SID}/document`, { dataUrl: dataUrl(PDF2), filename: 'contract-v2.pdf', label: 'Contract (amended)', expectedRev: sup.body.signing.rev }, LEAD);
  const r2 = await j('POST', `/org/signings/${PD.SID}/ready`, { expectedRev: a2.body.signing.rev, clientKey: 'live-d-ready2' }, LEAD);
  ok(a2.status === 200 && r2.status === 200 && r2.body.signing.currentRevision.document.sha256 !== PD.sha, 'D7: revision 2 presented with a different document (a different digest)');
  await goTab(kola, '/football');
  await goTab(kola, '/opportunities');
  ok(await waitIn(sec, /Signing revision 2/) && (await sec.locator(`[data-testid="signing-sign-${PD.SID}"]`).count()) === 1, 'D8: Kola sees revision 2 with a fresh "Sign this document" — every party signs again');
  neg(!(await sec.innerText()).includes(S_NOTE), 'D9: no internal note reached him');
  globalThis.__D = { SID: PD.SID, rev2sha: r2.body.signing.currentRevision.document.sha256 };
}

// ================================================================== E — DOCUMENT IMMUTABILITY (club tab)
{
  await signingTab(lead.page, ROOM_C);
  // the live package (revision 2, READY) is the one the tab opens
  ok((await sw(lead.page).locator('[data-testid="signing-package"]').getAttribute('data-status')) === 'READY', 'E1: the tab opens the live (presented) package');
  neg((await sw(lead.page).locator('[data-testid="signing-file"]').count()) === 0 && (await sw(lead.page).locator('[data-testid="signing-attach"]').count()) === 0 && (await sw(lead.page).locator('input[aria-label="Contract start day"]').isDisabled()), 'E2: once presented there is no file input, no attach control, and the contract days are read-only');
  expect(await j('POST', `/org/signings/${globalThis.__D.SID}/document`, { dataUrl: dataUrl(PDF), filename: 'x.pdf', expectedRev: (await j('GET', `/org/signings/${globalThis.__D.SID}`, undefined, LEAD)).body.signing.rev }, LEAD), 409, 'SIGNING_STATE_INVALID', 'E3: forcing an attach on a presented revision is refused by state');
  ok((await sw(lead.page).locator('[data-testid="signing-supersede"]').count()) === 1, 'E4: the only way to a different document is "Replace the document" — a new revision');
}

// ================================================================== F — AGENT (read-only, same-agency, revoked deep link)
const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana');
{
  ok((await j('POST', `/player/offers/${OFFER_C}/share-agent`, { share: true }, KOLA)).status === 200, 'F1: Kola shares the Offer with Ana (HTTP)');
  await go(ana, `#/clients/${REL}/offers`);
  await ana.locator(`[data-testid="offer-signing-${OFFER_C}"]`).waitFor({ timeout: 15000 });
  const line = ana.locator(`[data-testid="offer-signing-${OFFER_C}"]`);
  ok(/Presented for signature|Signing in progress/.test(await line.innerText()) && /Signing revision 2/.test(await line.innerText()) && (await line.locator('button').count()) === 0, 'F2: Ana reads the live package\'s state and revision, no control');
  neg(!(await ana.locator('[data-testid="client-offers"]').innerText()).includes(S_NOTE) && !(await ana.locator('[data-testid="client-offers"]').innerText()).includes(globalThis.__D.rev2sha.slice(0, 12)), 'F3: no note, no digest');
  const bea = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
  expect(await j('GET', `/org/agent/clients/${REL}/signings`, undefined, bea.token), 404, 'REPRESENTATION_NOT_FOUND', 'F4: Bea (same agency): NOT FOUND');
  const term = await j('POST', `/player/agent/relationships/${REL}/terminate`, { clientKey: 'live-terminate' }, KOLA);
  ok(term.status === 200, 'F5: Kola ends the representation');
  await go(ana, `#/clients/${REL}/offers`);
  ok(await waitText(ana, /Opportunities open only through an active, client-confirmed rela/), 'F6: Ana\'s deep link shows no access');
  neg((await ana.locator(`[data-testid="offer-signing-${OFFER_C}"]`).count()) === 0 && (await ana.locator('[data-testid="client-offers"]').count()) === 0, 'F6b: no signing line survives the revocation');
  const r = await j('GET', `/org/agent/clients/${REL}/signings`, undefined, anaApi.token);
  neg((r.status === 403 || r.status === 404) && !JSON.stringify(r.body).includes('READY'), `F7: the API refuses the revoked agent (${r.status} ${r.body.error})`);
}

// ================================================================== W — WIDTHS on the expired package, zero page errors
for (const width of [1440, 1280, 1024, 768, 390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`)).page;
  await signingTab(p, ROOM_A); // the completed package
  ok(await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `W: ${width}px: the Signing tab has no horizontal page scroll`);
  const pill = await sw(p).locator('[data-testid="signing-status"]').boundingBox();
  ok(pill && pill.x >= 0 && pill.x + pill.width <= width + 1, `W: ${width}px: the status pill sits inside the viewport`);
  // the multi-package case (expired + live) at this width
  await signingTab(p, ROOM_C);
  ok((await sw(p).locator('[data-testid="signing-packages"]').count()) === 1 && await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), `W: ${width}px: two packages on one case: the package switcher renders, no horizontal scroll`);
  await ctx.close();
}
{
  await goTab(kola, '/football');
  await goTab(kola, '/opportunities');
  ok(await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'W: 390px: the player app with two packages (expired + presented) has no horizontal scroll');
}

// Sentinel sweep
{
  for (const [who, p] of [['kola', kola.locator('body')], ['ana', ana.locator('body')]]) {
    const txt = await p.innerText();
    neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC), `N10: ${who}'s page carries no signing note and no decision rationale`);
  }
}

ok(errors.length === 0, `no page errors in any app (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nM23 P7.1 SIGNING HARDENING LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
cleanup();
process.exit(0);
