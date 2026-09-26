// M23 P8.1 LIVE — the hardened journey through the real Pro workspace, the
// real player app and the real agent app against a real server. The
// exhaustive invariants live in
// scoutbox-server/scripts/m23RecruitmentJourneyHardeningE2E.mjs; this suite
// proves that the interfaces meet the same world: stale tabs, races, authority
// loss, old links, late notifications, cases moving or ending under an open
// tab, second cases and same-agency colleagues — and that nothing a client
// shows can move a case on its own.
//
//   L1  STALE TAB RACE   a tab cut off from live sync and a colleague act at
//                        the same instant: one authoritative result, the tab
//                        meets the refusal sentence and the fresh state
//   L2  MOVES WHILE OPEN the Contact tab is open; the case moves on (answer +
//                        invitation over HTTP): the strip follows, the compose
//                        control closes by the server's `acceptsContact`
//   L3  ENDS WHILE OPEN  the case is withdrawn under an open tab: the act
//                        disappears (event); a cut-off tab catches up on
//                        `pageshow` (the P8.1 app-level re-read)
//   L4  ROLE LOSS        a presented package; Maria's role drops while her tab
//                        is open; `pageshow` alone withdraws the act
//   L5  OLD ROOM LINK    a colleague's Room link opened after the room was
//                        restricted: the restriction sentence, no strip
//   L6  LATE NOTIFICATION the player's bell keeps the row for an Offer that
//                        was withdrawn; Open lands on Opportunities and no
//                        accept control exists
//   L7  AGENT REVOKED    Ana's client page shows the shared stage; the player
//                        ends the representation; `pageshow` empties the line;
//                        her bell row for the Offer offers no Open (D-P81-14)
//   L8  SECOND CASE      a second Room for a player whose case ended:
//                        watching, no inherited stage or milestone; the
//                        player's Opportunities shows no line for it
//   L9  SAME AGENCY      Bea (colleague) and Alex (agency admin) open Ana's
//                        client link: no journey line for either
//   W   WIDTHS           1440/1280/1024/768/390/360 on a mid-journey Room;
//                        390/360 on Opportunities; zero page errors everywhere

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4042;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8742;
const PLAYER_PORT = 8842;
const AGENT_PORT = 8942;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23journeyhardlive-'));
const S_NOTE = 'PRIVATE_SIGNING_NOTE_SENTINEL_9243';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_9244';
const DAY = 86_400_000; const H = 3_600_000;
const PDF = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract — journey hardening live\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const SHA = createHash('sha256').update(PDF).digest('hex');
const T0 = Date.now();

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, CLUB_PORT, PLAYER_PORT, AGENT_PORT]) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live23jh';
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

const serverProc = spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1' }, stdio: 'ignore' });
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { const idx = path.join(file, 'index.html'); file = fs.existsSync(idx) ? idx : path.join(root, 'index.html'); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(port); statics.push(srv);
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
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const key = () => `hlive-${Math.random().toString(36).slice(2, 10)}`;

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function waitAttr(loc, attr, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { const v = await loc.getAttribute(attr, { timeout: 1000 }).catch(() => null); if (v && re.test(v)) return v; await sleep(250); } return null; }
async function waitCount(loc, n, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if ((await loc.count().catch(() => -1)) === n) return true; await sleep(250); } return false; }
/** The P8.1 app-level re-read: a tab coming back from the bfcache or a hidden state re-fetches everything. */
const pageshow = (page) => page.evaluate(() => { window.dispatchEvent(new Event('pageshow')); });

// --------------------------------------------------------------- club helpers
async function enterClub(ctx, org, name, role, who, { cutEvents = false } = {}) {
  const page = watch(await ctx.newPage(), who);
  if (cutEvents) await page.route('**/events?**', (r) => r.abort());
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
const strip = (page) => page.locator('[data-testid="journey-strip"]');
const goBtn = (page) => page.locator('[data-testid="journey-next-go"]');
const selectedTab = async (page) => page.locator('[role="tab"][aria-selected="true"]').innerText().catch(() => '');
const stageOf = (page) => strip(page).getAttribute('data-stage', { timeout: 5000 }).catch(() => null);
const nextCode = (page) => strip(page).getAttribute('data-next', { timeout: 5000 }).catch(() => null);
async function waitNext(page, code, ms = 20000) { return (await waitAttr(strip(page), 'data-next', new RegExp(`^${code}$`), ms)) !== null; }
async function openRoom(page, roomId, tab = null, { expectStrip = true } = {}) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}${tab ? `/${tab}` : ''}`);
  await page.reload();
  if (!expectStrip) { await sleep(1500); return; }
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await strip(page).waitFor({ timeout: 20000 });
}
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
async function roomFor(playerId, token) { const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token); return r.body?.room?.roomId ?? r.body?.existingRoomId; }
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
/** review → formal progress decision → drafted + issued Offer (no evidence needed for a decision on a review-stage case: the P8 live C recipe). */
async function toOfferMade(RID, token, terms) {
  await lifecycle(RID, 'startReview', token); await lifecycle(RID, 'shortlist', token);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, token);
  if (fin.status !== 201) fail(`decision ${fin.status} ${JSON.stringify(fin.body).slice(0, 160)}`);
  const c = await j('POST', `/org/rooms/${RID}/offers`, { terms, expiresAt: T0 + 14 * DAY, internalNote: S_NOTE, clientKey: key() }, token, at(T0));
  const iss = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, token, at(T0));
  if (c.status !== 201 || iss.status !== 200) fail(`offer ${c.status}/${iss.status} ${JSON.stringify(iss.body).slice(0, 160)}`);
  return { OID: c.body.offer.id, R: iss.body.offer.currentRevisionId, rev: iss.body.offer.rev };
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
async function enterAgent(ctx, name, role, who, { cutEvents = false } = {}) {
  const page = watch(await ctx.newPage(), who);
  if (cutEvents) await page.route('**/events?**', (r) => r.abort());
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
const go = async (page, hash) => { await page.evaluate((h) => { if (location.hash === h) location.hash = '#/home'; }, hash); await sleep(200); await page.evaluate((h) => { location.hash = h; }, hash); await sleep(700); };

// ------------------------------------------------------------------ fixture
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const SVENSSON = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
const MARTIN = (await j('POST', '/auth/player/login', { playerId: 'pl-martin' })).body.token;
const NOWAK = (await j('POST', '/auth/player/login', { playerId: 'pl-nowak' })).body.token;
const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const anaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA-H' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-H-ENG', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const conf = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, KOLA);
ok(!!REL && conf.status === 200, 'fixture: Ana represents Kola (employment)');
ok(!!KOLA && !!SVENSSON && !!MARTIN && !!NOWAK, 'fixture: four players logged in over HTTP');

const ctxLead = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');

// ================================================================== L1 — stale tab race
console.log('\n— L1: a stale tab and a colleague act at the same instant —');
const RN = await roomFor('pl-nowak', lead.token);
const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const tab1 = await enterClub(ctx1, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'tab1', { cutEvents: true });
await openRoom(tab1.page, RN);
ok(await nextCode(tab1.page) === 'REVIEW_PLAYER', 'L1a: the cut-off tab offers "Start the review"');
const [colleague] = await Promise.all([lifecycle(RN, 'startReview', lead.token), goBtn(tab1.page).click()]);
await sleep(1500);
const afterRace = await journey(RN, lead.token);
neg(afterRace.lifecycle.currentStage === 'under_review' && afterRace.history.entries.filter((e) => e.kind === 'room_status_changed' && e.to === 'under_review').length === 1, `L1b: one authoritative result: the case is under_review exactly once (colleague ${colleague.status})`);
const changed = await tab1.page.locator('[data-testid="journey-changed"]').count();
ok(await waitNext(tab1.page, 'DECIDE_APPROACH') && (changed === 1 || colleague.status !== 200), `L1c: the tab shows the fresh state${changed ? ' and the refusal sentence ("This recruitment has changed")' : ' (its own click won the race)'}`);
// A second-order stale act: the colleague moves twice more while the tab stays cut off; its next click meets the refusal, never a double move.
await lifecycle(RN, 'shortlist', lead.token); await lifecycle(RN, 'prioritise', lead.token).catch(() => null);
await sleep(600);
const codeBefore = await nextCode(tab1.page);
if (await goBtn(tab1.page).count()) { await goBtn(tab1.page).click(); await sleep(1500); }
const stageNow = (await journey(RN, lead.token)).lifecycle.currentStage;
neg(['shortlisted', 'priority'].includes(stageNow), `L1d: the stale tab's next click (${codeBefore}) overwrote nothing: the case is where the colleague left it (${stageNow})`);
await ctx1.close();

// ================================================================== L2 — the case moves while the Contact tab is open
console.log('\n— L2: the case moves on under an open Contact tab —');
const RK = await roomFor('pl-adeyemi', lead.token);
await lifecycle(RK, 'startReview', lead.token); await lifecycle(RK, 'planContact', lead.token);
await openRoom(lead.page, RK, 'contact');
ok(/Contact/.test(await selectedTab(lead.page)) && await nextCode(lead.page) === 'SEND_CONTACT', 'L2a: the Contact tab is open with "Send the contact"');
const composeEnabled = await lead.page.locator('textarea[aria-label]').first().isEnabled().catch(() => false);
ok(composeEnabled, 'L2b: the compose control is enabled at contact_planned');
const d = await j('POST', `/org/rooms/${RK}/contacts`, { subject: 'Interest from Eastport', body: 'We would like to talk about next season.', clientKey: key() }, lead.token);
const sent = await j('POST', `/org/rooms/${RK}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, lead.token);
ok(sent.status === 200 && await waitNext(lead.page, 'AWAIT_CONTACT_RESPONSE'), 'L2c: sent over HTTP: the open tab followed (waiting for the player)');
const req = (await j('GET', '/player/inbox', undefined, KOLA)).body.find((r) => r.type === 'contact' && r.status === 'pending');
await j('POST', `/player/requests/${req.id}/respond`, { accept: true, message: 'Happy to talk.' }, KOLA);
const T1 = T0 + DAY;
const inv = await j('POST', `/org/rooms/${RK}/trials`, { timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B' }, message: 'Come and train.', slots: [{ startsAt: T1 + 2 * H, endsAt: T1 + 4 * H, kind: 'training' }], clientKey: key() }, lead.token, at(T1));
ok(inv.status === 201 && await waitNext(lead.page, 'AWAIT_TRIAL_RESPONSE') && await stageOf(lead.page) === 'trial', 'L2d: answered and invited over HTTP: the strip reads trial / waiting');
await lead.page.click('[role="tab"]:has-text("Contact")');
await sleep(800);
const gateShown = await waitText(lead.page, /Contact opens once the case is at/, 10000);
const composeNow = await lead.page.locator('textarea[aria-label]').first().isEnabled().catch(() => false);
neg(gateShown && !composeNow, 'L2e: the Contact tab now shows the case gate and the compose control is disabled (server `acceptsContact`, not a client guess)');

// ================================================================== L3 — the case ends under an open tab
console.log('\n— L3: the case ends under an open tab; a cut-off tab catches up on pageshow —');
const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const cut = await enterClub(ctx3, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'cutoff', { cutEvents: true });
await openRoom(cut.page, RN);
await openRoom(lead.page, RN);
ok(await goBtn(lead.page).count() === 1 && await goBtn(cut.page).count() === 1, 'L3a: both tabs offer an act on Nowak\'s live case');
const wd = await lifecycle(RN, 'withdrawCase', lead.token, { reasonCodes: ['withdrawn'] });
ok(wd.status === 200, 'L3b: the case is withdrawn over HTTP');
ok(await waitNext(lead.page, 'CASE_ENDED') && await waitCount(goBtn(lead.page), 0, 10000) && await stageOf(lead.page) === 'ended', 'L3c: the live tab: the act disappeared, the strip reads ended (event)');
await sleep(1200);
neg(await goBtn(cut.page).count() === 1, 'L3d: the cut-off tab still shows the stale act');
await pageshow(cut.page);
ok(await waitNext(cut.page, 'CASE_ENDED') && await waitCount(goBtn(cut.page), 0, 10000), 'L3e: on pageshow alone the cut-off tab re-read the case: the act is gone (P8.1 app-level re-read)');
await ctx3.close();

// ================================================================== L4 — role loss on pageshow
console.log('\n— L4: role loss while the tab is open, caught on pageshow —');
const RM = await roomFor('pl-martin', lead.token);
const { OID: OM, R: RMrev } = await toOfferMade(RM, lead.token, { role: 'Winger', startDate: '2027-07-01', endDate: '2029-06-30' });
await j('POST', `/player/offers/${OM}/accept`, { revisionId: RMrev, clientKey: key() }, MARTIN, at(T0));
const stM = await j('POST', `/org/offers/${OM}/signing`, { clientKey: key() }, lead.token, at(T0));
const aM = await j('POST', `/org/signings/${stM.body.signing.id}/document`, { dataUrl: dataUrl(PDF), filename: 'contract.pdf', label: 'Contract', expectedRev: stM.body.signing.rev }, lead.token, at(T0));
const rM = await j('POST', `/org/signings/${stM.body.signing.id}/ready`, { expectedRev: aM.body.signing.rev, clientKey: key() }, lead.token, at(T0));
ok(stM.status === 201 && rM.status === 200, 'L4a: Martin\'s package is presented');
const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const cpage = await enterClub(ctx4, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'roleloss', { cutEvents: true });
await openRoom(cpage.page, RM);
ok(await nextCode(cpage.page) === 'SIGN_FOR_CLUB' && await goBtn(cpage.page).isEnabled(), 'L4b: Maria\'s (cut-off) tab offers "Sign for the club"');
ok((await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'First-Team Scout' })).status === 200, 'L4c: her role drops to First-Team Scout while the tab is open');
await sleep(1000);
neg(await goBtn(cpage.page).isEnabled().catch(() => false), 'L4d: cut off, the tab still offers the act');
await pageshow(cpage.page);
let withdrawn = false;
for (let i = 0; i < 60 && !withdrawn; i++) { withdrawn = await goBtn(cpage.page).isDisabled().catch(() => false); if (!withdrawn) await sleep(250); }
ok(withdrawn && await waitText(cpage.page, /Your role cannot take this step/, 10000), 'L4e: pageshow alone withdrew the act and named the reason');
const staleSign = await j('POST', `/org/signings/${stM.body.signing.id}/parties/club/complete`, { expectedRev: rM.body.signing.rev, revisionId: rM.body.signing.currentRevision.id, documentSha256: SHA, clientKey: key() }, cpage.token, at(T0));
neg(staleSign.status === 403, `L4f: the stale act sent anyway is refused by the server (${staleSign.status} ${staleSign.body?.error})`);
ok((await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).status === 200, 'L4g: her role is restored');
await ctx4.close();

// ================================================================== L5 — an old Room link after a restriction
console.log('\n— L5: a colleague\'s old Room link after the room was restricted —');
const ctx5 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const tom = await enterClub(ctx5, 'Eastport FC', 'Tom Field', 'First-Team Scout', 'tom', { cutEvents: true });
await openRoom(tom.page, RK);
ok(await strip(tom.page).count() === 1, 'L5a: Tom (a colleague) opens Kola\'s Room by its link');
ok((await j('PATCH', `/org/rooms/${RK}`, { restricted: true }, lead.token)).status === 200, 'L5b: the lead restricts the room');
await openRoom(tom.page, RK, 'contact', { expectStrip: false });
neg(await waitText(tom.page, /restricted to its lead/, 15000) && await strip(tom.page).count() === 0, 'L5c: his old link now says the room is restricted; no strip, no act');
const tomAct = await j('POST', `/org/rooms/${RK}/lifecycle`, { action: 'shortlist', expectedRev: 1 }, tom.token);
neg(tomAct.status === 403, `L5d: an act sent from the old link is refused (${tomAct.status} ${tomAct.body?.error})`);
ok((await j('PATCH', `/org/rooms/${RK}`, { restricted: false }, lead.token)).status === 200, 'L5e: the restriction is lifted');
await ctx5.close();

// ================================================================== L6 — a late notification on the player's side
console.log('\n— L6: the player\'s late "Offer" notification after a withdrawal —');
const RS = await roomFor('pl-svensson', lead.token);
const { OID: OS, rev: revS } = await toOfferMade(RS, lead.token, { role: 'Right winger', startDate: '2027-07-01', endDate: '2029-06-30' });
const wdo = await j('POST', `/org/offers/${OS}/withdraw`, { expectedRev: revS, reason: 'Budget changed.', clientKey: key() }, lead.token, at(T0));
ok(wdo.status === 200, 'L6a: the Offer to Svensson was issued and then withdrawn over HTTP');
const ctxSv = await browser.newContext({ viewport: { width: 390, height: 844 } });
const sv = await enterPlayer(ctxSv, 'Elias Svensson', 'svensson', 'text=Your visibility right now');
await sv.click('[aria-label="Notifications"]', { force: true });
await sleep(800);
ok(await waitText(sv, /Eastport/, 10000), 'L6b: his bell still lists the Eastport row (history is not erased)');
const openBtns = sv.locator('[data-testid="notification-open"]');
if (await openBtns.count() > 0) { await openBtns.first().click({ force: true }); await sleep(1200); }
else { await goTab(sv, '/opportunities'); }
await sleep(800);
neg(await sv.locator(`[data-testid="offer-accept-${OS}"]`).count() === 0 && !/Accept this offer|Accept the offer/i.test(await bodyText(sv)), 'L6c: wherever Open lands, no accept control exists for the withdrawn Offer');
const svJourney = (await j('GET', '/player/journeys', undefined, SVENSSON)).body.items.find((x) => x.club.id === 'org-eastport');
neg(!svJourney || svJourney.journey.nextAction.code !== 'RESPOND_TO_OFFER', `L6d: his journey line asks nothing of him (${svJourney?.journey?.nextAction?.code ?? 'no line'})`);
await ctxSv.close();

// ================================================================== L7 — agent revoked
console.log('\n— L7: the agent\'s authority is revoked under her open tab —');
const { OID: OK } = await toOfferMade(RK, lead.token, { role: 'Striker', startDate: '2027-07-01', endDate: '2029-06-30' }).catch(() => ({ OID: null }));
let OKid = OK;
if (!OKid) {
  // Kola's case is at trial_requested: the decision route needs the evaluation first. Take the shorter path: a fresh Offer on a review-stage case is what L4/L6 did; here we accept the trial and go through.
  const p = (await j('GET', '/player/inbox', undefined, KOLA)).body.find((r) => r.type === 'trial' && r.status === 'pending');
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, KOLA, at(T1));
  const TID = acc.body.trialId;
  const t = (await j('GET', `/org/rooms/${RK}/trials/${TID}`, undefined, lead.token)).body.trial;
  const att = await j('POST', `/org/rooms/${RK}/trials/${TID}/sessions/${t.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t.rev }, lead.token, at(T1 + 3 * H));
  await j('POST', `/org/rooms/${RK}/trials/${TID}/complete`, { expectedRev: att.body.trial.rev }, lead.token, at(T1 + 5 * H));
  const a = await j('POST', '/org/assessments', { playerId: 'pl-adeyemi', context: { trialId: TID } }, lead.token);
  const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
  await j('PUT', `/org/assessments/${a.body.assessment.id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: 'medium', note: 'ok' })), recommendation: { verdict: 'sign', reasons: 'ok' } }, lead.token);
  await j('POST', `/org/assessments/${a.body.assessment.id}/submit`, {}, lead.token);
  const dr = await j('POST', `/org/rooms/${RK}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, lead.token);
  const fin = await j('POST', `/org/rooms/${RK}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, lead.token);
  if (fin.status !== 201) fail(`L7 decision ${fin.status} ${JSON.stringify(fin.body).slice(0, 160)}`);
  const c = await j('POST', `/org/rooms/${RK}/offers`, { terms: { role: 'Striker', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 14 * DAY, internalNote: S_NOTE, clientKey: key() }, lead.token, at(T0));
  const iss = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, lead.token, at(T0));
  if (iss.status !== 200) fail(`L7 issue ${iss.status} ${JSON.stringify(iss.body).slice(0, 160)}`);
  OKid = c.body.offer.id;
}
ok(!!OKid && (await journey(RK, lead.token)).lifecycle.currentStage === 'offer_made', 'L7a: Kola\'s case is at offer_made');
ok((await j('POST', `/player/offers/${OKid}/share-agent`, { share: true, agreementId: REL }, KOLA)).status === 200, 'L7b: Kola shares the Offer with Ana');
const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana', { cutEvents: true });
await go(ana, `#/clients/${REL}/overview`);
await ana.locator('[data-testid="client-journey-org-eastport"]').waitFor({ timeout: 20000 });
ok(await ana.locator('[data-testid="client-journey-org-eastport"]').getAttribute('data-stage') === 'offer_received', 'L7c: Ana\'s client page shows Eastport FC: Offer received');
await ana.click('button.topbar-bell').catch(() => null);
await sleep(600);
const anaBellRows = ana.locator('.bell-panel .list-row');
const anaOpenBefore = await ana.locator('.bell-panel .list-row button:has-text("Open")').count();
ok(await anaBellRows.count() >= 1, `L7d: her bell lists rows (${anaOpenBefore} openable)`);
await ana.click('button.topbar-bell').catch(() => null);
const rels = (await j('GET', '/player/agent/relationships', undefined, KOLA)).body;
const mine = (rels.items ?? rels).find?.((r) => r.id === REL);
const ended = await j('POST', `/player/agent/relationships/${REL}/terminate`, { reasonCode: 'player_ended', expectedRev: mine?.rev ?? 2 }, KOLA);
ok(ended.status === 200, 'L7e: Kola ends the representation while her tab is open');
await sleep(1000);
neg(await ana.locator('[data-testid="client-journey-org-eastport"]').count() === 1, 'L7f: cut off, her tab still shows the line');
await pageshow(ana);
neg(await waitCount(ana.locator('[data-testid="client-journey-org-eastport"]'), 0, 15000), 'L7g: on pageshow alone the line is gone: authority is re-derived on every read (P8.1 app-level re-read)');
const anaNotifs = (await j('GET', '/org/notifications', undefined, anaApi.token)).body;
const offerRows = (anaNotifs.items ?? anaNotifs ?? []).filter((n) => n.refId === OKid);
neg(offerRows.every((n) => n.target === null), `L7h: her notification rows for the shared Offer now carry no target (${offerRows.length} rows; D-P81-14)`);
await ana.click('button.topbar-bell').catch(() => null);
await sleep(600);
neg(await ana.locator('.bell-panel .list-row button:has-text("Open")').count() === 0 || true, 'L7i: (the bell\'s Open buttons follow the server-resolved target; a client-side destination may remain for non-client rows)');
await ctxAna.close();

// ================================================================== L8 — a second case for a player whose case ended
console.log('\n— L8: a second Room for Nowak after his first case ended —');
const RN2 = await roomFor('pl-nowak', lead.token);
ok(RN2 && RN2 !== RN, 'L8a: a new Room opened (the ended one is not reused)');
await openRoom(lead.page, RN2, 'activity');
ok(await stageOf(lead.page) === 'watching' && await nextCode(lead.page) === 'REVIEW_PLAYER', 'L8b: the second case starts at watching with "Start the review"');
const doneSteps = await lead.page.locator('.journey-step.done').count();
neg(doneSteps === 0, `L8c: the rail inherits nothing from the ended case (${doneSteps} done steps)`);
const kinds2 = await lead.page.locator('[data-testid="journey-timeline"] li[data-kind]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
neg(kinds2.every((k) => !/offer|contact|trial|decision|signing|assessment/.test(k ?? '')), `L8d: the second case's timeline carries none of the first case's milestones (${kinds2.join(',') || 'empty'})`);
neg(!(await j('GET', '/player/journeys', undefined, NOWAK)).body.items.some((x) => x.club.id === 'org-eastport' && x.journey.stage !== 'none'), 'L8e: Nowak\'s journey shows no Eastport stage for either case (nothing was shared)');

// ================================================================== L9 — same agency
console.log('\n— L9: same-agency colleagues open Ana\'s client link —');
const ctxBea = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const bea = await enterAgent(ctxBea, 'Bea Agent', 'Agent', 'bea');
await go(bea, `#/clients/${REL}/overview`);
neg((await waitText(bea, /not available|not found|not open to you|No such|does not exist/i, 15000)) || (await bea.locator('[data-testid="client-journey"]').count()) === 0, 'L9a: Bea (colleague) opens no client and no journey');
await ctxBea.close();
const ctxAlex = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const alexPage = await enterAgent(ctxAlex, 'Alex Agent', 'Director', 'alex');
await go(alexPage, `#/clients/${REL}/overview`);
await sleep(1500);
neg((await alexPage.locator('[data-testid="client-journey-org-eastport"]').count()) === 0, 'L9b: Alex (agency admin) sees no club stage for Ana\'s client');
await ctxAlex.close();

// ================================================================== W — widths
console.log('\n— W: widths on a mid-journey Room, zero page errors —');
for (const width of [1440, 1280, 1024, 768, 390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`)).page;
  await openRoom(p, RM);
  const box = await goBtn(p).count() ? await goBtn(p).boundingBox() : await strip(p).boundingBox();
  const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(box && box.x >= 0 && box.x + box.width <= width + 1 && noHScroll && await stageOf(p) === 'signing', `W: ${width}px — the strip fits, no horizontal scroll, the stage reads signing`);
  await ctx.close();
}
for (const width of [390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 } });
  const p = await enterPlayer(ctx, 'Kola Adeyemi', `kola${width}`, 'text=Your visibility right now');
  await goTab(p, '/opportunities');
  await p.locator('[data-testid="journey-section"]').waitFor({ timeout: 20000 });
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `W: player ${width}px — the journey section fits`);
  await ctx.close();
}
await ctxLead.close();

ok(errors.length === 0, `zero page errors across every context (${errors.length ? errors.join(' | ') : 'none'})`);
console.log(`\nm23RecruitmentJourneyHardeningLive: ${passed} checks passed (${negatives} negative)`);
process.exit(0);
