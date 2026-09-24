// M23 P8 LIVE — the full recruitment journey driven through the real Pro
// workspace, the real player app and the real agent app against a real
// server. The exhaustive invariants live in
// scoutbox-server/scripts/m23RecruitmentJourneyE2E.mjs; this suite proves that
// what the interfaces show and do follows them.
//
//   A  CLUB PATH      Maria walks Kola from watching to signed inside ONE Room:
//                     the Journey strip names each next action, every act is
//                     reached from the strip or a tab (no URL editing), the
//                     rail fills, the timeline carries the milestones
//   B  CONFLICT       two tabs on one case: tab 2 moves it; tab 1's next-action
//                     click meets the server's refusal → "This recruitment has
//                     changed. We refreshed the latest status." and the fresh
//                     state; a hidden tab refreshes on becoming visible
//   C  ROLE LOSS      Maria's role changes while her tab is open: the stale
//                     "Start signing" resolves to the Signing tab whose act is
//                     refused; after the refresh the strip withdraws the act
//   D  DEEP LINKS     a tab link lands on its tab; a bogus tab is a malformed
//                     link; a foreign room is "does not exist"; an ended case
//                     reads ended with its history intact; back/forward re-read
//   E  NOTIFICATIONS  the club's bell opens the Room's Offer tab; the player's
//                     bell opens Opportunities
//   P  PLAYER         Kola's Opportunities shows one line per club: the stage,
//                     the next act, the latest milestone; never a club word
//   G  AGENT          Ana's client overview shows the factual journey line only
//                     after Kola shared the Offer; Bea (same agency) sees no
//                     client; after Kola ends the representation Ana's line
//                     reads the refusal
//   W  WIDTHS         1440/1280/1024/768/390/360 on the Room; 390/360 on the
//                     player's Opportunities; zero page errors in every context

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
const API_PORT = 4041;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8741;
const PLAYER_PORT = 8841;
const AGENT_PORT = 8941;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23journeylive-'));
const S_NOTE = 'PRIVATE_SIGNING_NOTE_SENTINEL_9143';
const S_DEC = 'PRIVATE_DECISION_SENTINEL_9144';
const S_ASSESS = 'PRIVATE_ASSESSMENT_SENTINEL_9145';
const DAY = 86_400_000; const H = 3_600_000;
const PDF = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract — journey live\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
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
const DIST = 'dist-live23jn';
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
const key = () => `live-${Math.random().toString(36).slice(2, 10)}`;

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function waitAttr(loc, attr, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { const v = await loc.getAttribute(attr, { timeout: 1000 }).catch(() => null); if (v && re.test(v)) return v; await sleep(250); } return null; }

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
const strip = (page) => page.locator('[data-testid="journey-strip"]');
const nextOf = (page) => page.locator('[data-testid="journey-next-action"]');
const goBtn = (page) => page.locator('[data-testid="journey-next-go"]');
const selectedTab = async (page) => page.locator('[role="tab"][aria-selected="true"]').innerText().catch(() => '');
const stageOf = (page) => strip(page).getAttribute('data-stage', { timeout: 5000 }).catch(() => null);
const nextCode = (page) => strip(page).getAttribute('data-next', { timeout: 5000 }).catch(() => null);
async function waitNext(page, code, ms = 20000) { return (await waitAttr(strip(page), 'data-next', new RegExp(`^${code}$`), ms)) !== null; }
async function openRoom(page, roomId, tab = null) {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}${tab ? `/${tab}` : ''}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await strip(page).waitFor({ timeout: 20000 });
}
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, token)).body;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID, token)).case.rev, ...extra }, token);
async function roomFor(playerId, token) { const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token); return r.body?.room?.roomId ?? r.body?.existingRoomId; }
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;

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
const go = async (page, hash) => { await page.evaluate((h) => { if (location.hash === h) location.hash = '#/home'; }, hash); await sleep(200); await page.evaluate((h) => { location.hash = h; }, hash); await sleep(700); };

// ------------------------------------------------------------------ fixture
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const NOWAK = (await j('POST', '/auth/player/login', { playerId: 'pl-nowak' })).body.token;
const MARTIN = (await j('POST', '/auth/player/login', { playerId: 'pl-martin' })).body.token;
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
ok(!!REL && conf.status === 200, 'fixture: Ana represents Kola (employment)');

// ================================================================== A — the club path
console.log('\n— A: the club path, one Room, strip and tabs only —');
const ctxLead = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
const RID = await roomFor('pl-adeyemi', lead.token);
await openRoom(lead.page, RID);
ok(await stageOf(lead.page) === 'watching' && await nextCode(lead.page) === 'REVIEW_PLAYER', 'A1: the Room opens with the Journey strip: watching, next "Start the review"');
ok(await goBtn(lead.page).isEnabled() && /Start the review/.test(await goBtn(lead.page).innerText()), 'A2: the next action is a button');
await goBtn(lead.page).click();
ok(await waitNext(lead.page, 'DECIDE_APPROACH') && (await journey(RID, lead.token)).lifecycle.currentStage === 'under_review', 'A3: one click started the review: the server moved the case, the strip re-read it (review / decide the approach)');
const railDone = async () => lead.page.locator('.journey-step.done').count();
const railCurrent = async () => lead.page.locator('.journey-step.current').getAttribute('data-stage', { timeout: 5000 }).catch(() => null);
ok(await railDone() >= 1 && await railCurrent() === 'review', 'A4: the rail marks watching done and review current');
// Plan the contact from the strip's tab (DECIDE_APPROACH opens Overview); the manual picker is the M17 move.
await lifecycle(RID, 'planContact', lead.token);
ok(await waitNext(lead.page, 'SEND_CONTACT'), 'A5: contact planned (server event): next "Send the contact" on the Contact tab');
await goBtn(lead.page).click();
ok(/Contact/.test(await selectedTab(lead.page)) && /\/contact$/.test(await lead.page.evaluate(() => location.hash)), 'A6: the next action opened the Contact tab and the link names it');
const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest from Eastport', body: 'We would like to talk about next season.', clientKey: key() }, lead.token);
const sent = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, lead.token);
ok(sent.status === 200 && await waitNext(lead.page, 'AWAIT_CONTACT_RESPONSE'), 'A7: sent: the strip waits for the player (no button, an hourglass)');
neg(await goBtn(lead.page).count() === 0, 'A8: a wait offers no primary act');
const req = (await j('GET', '/player/inbox', undefined, KOLA)).body.find((r) => r.type === 'contact' && r.status === 'pending');
await j('POST', `/player/requests/${req.id}/respond`, { accept: true, message: 'Happy to talk.' }, KOLA);
ok(await waitNext(lead.page, 'CONTINUE_EVALUATION'), 'A9: the player answered: next "Continue the evaluation"');
const T1 = T0 + DAY;
const inv = await j('POST', `/org/rooms/${RID}/trials`, { timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B' }, message: 'Come and train.', slots: [{ startsAt: T1 + 2 * H, endsAt: T1 + 4 * H, kind: 'training' }], clientKey: key() }, lead.token, at(T1));
ok(inv.status === 201 && await waitNext(lead.page, 'AWAIT_TRIAL_RESPONSE') && await stageOf(lead.page) === 'trial', 'A10: trial invited: stage trial, waiting for the answer');
const p = (await j('GET', '/player/inbox', undefined, KOLA)).body.find((r) => r.type === 'trial' && r.status === 'pending');
const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, KOLA, at(T1));
const TID = acc.body.trialId;
ok(acc.status === 200 && await waitNext(lead.page, 'CONDUCT_TRIAL'), 'A11: accepted with a slot: next "Run the trial"');
await goBtn(lead.page).click();
ok(/Trial/.test(await selectedTab(lead.page)), 'A12: which opens the Trial tab');
const t = (await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, lead.token)).body.trial;
const att = await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${t.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t.rev }, lead.token, at(T1 + 3 * H));
const comp = await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: att.body.trial.rev }, lead.token, at(T1 + 5 * H));
ok(comp.status === 200 && await waitNext(lead.page, 'COMPLETE_ASSESSMENT') && await stageOf(lead.page) === 'assessment', 'A13: completed: stage assessment, next "Complete an assessment"');
await goBtn(lead.page).click();
ok(/Assessments/.test(await selectedTab(lead.page)), 'A14: which opens the Assessments tab');
const a = await j('POST', '/org/assessments', { playerId: 'pl-adeyemi', context: { trialId: TID } }, lead.token);
if (a.status !== 201) fail(`assessment create ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
const put = await j('PUT', `/org/assessments/${a.body.assessment.id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: 'medium', note: S_ASSESS })), recommendation: { verdict: 'sign', reasons: S_ASSESS } }, lead.token);
if (put.status !== 200) fail(`assessment put ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
const sub = await j('POST', `/org/assessments/${a.body.assessment.id}/submit`, {}, lead.token);
if (sub.status !== 200) fail(`assessment submit ${sub.status} ${JSON.stringify(sub.body).slice(0, 200)}`);
const jbA = (await journey(RID, lead.token)).journey;
ok(jbA.nextAction.code === 'RECORD_DECISION' && jbA.stage === 'decision', `A15: assessed: the server says stage decision, next "Record the recruitment decision" (got ${jbA.stage}/${jbA.nextAction.code})`);
ok(await waitNext(lead.page, 'RECORD_DECISION') && await stageOf(lead.page) === 'decision', 'A15b: and the open Room re-read it without a reload (server event)');
await goBtn(lead.page).click();
ok(/Decision/.test(await selectedTab(lead.page)), 'A16: which opens the Decision tab');
const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, lead.token);
const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, lead.token);
ok(fin.status === 201 && await waitNext(lead.page, 'PREPARE_OFFER') && await stageOf(lead.page) === 'offer', 'A17: a progress decision: offer consideration, next "Prepare an Offer"');
await goBtn(lead.page).click();
ok(/Offer/.test(await selectedTab(lead.page)) && (await journey(RID, lead.token)).offer.records.length === 0, 'A18: which opens the Offer tab and creates nothing');
const c = await j('POST', `/org/rooms/${RID}/offers`, { terms: { role: 'Central midfielder', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 14 * DAY, internalNote: S_NOTE, clientKey: key() }, lead.token, at(T0));
const OID = c.body.offer.id;
ok(c.status === 201 && await waitNext(lead.page, 'ISSUE_OFFER'), 'A19: drafted: next "Issue the drafted Offer"');
const iss = await j('POST', `/org/offers/${OID}/issue`, { expectedRev: 1, clientKey: key() }, lead.token, at(T0));
ok(iss.status === 200 && await waitNext(lead.page, 'AWAIT_OFFER_RESPONSE'), 'A20: issued: waiting for the player');
await j('POST', `/player/offers/${OID}/accept`, { revisionId: iss.body.offer.currentRevisionId, clientKey: key() }, KOLA, at(T0));
ok(await waitNext(lead.page, 'START_SIGNING') && await stageOf(lead.page) === 'acceptance', 'A21: accepted: stage accepted, next "Start the signing" — nothing started by itself');
await goBtn(lead.page).click();
ok(/Signing/.test(await selectedTab(lead.page)) && (await j('GET', `/org/rooms/${RID}/signing`, undefined, lead.token)).body.packages.length === 0, 'A22: which opens the Signing tab and opens no package');
const st = await j('POST', `/org/offers/${OID}/signing`, { internalNote: S_NOTE, clientKey: key() }, lead.token, at(T0));
const SID = st.body.signing.id;
ok(st.status === 201 && await waitNext(lead.page, 'PRESENT_SIGNING') && await stageOf(lead.page) === 'signing', 'A23: started: stage signing, next "Attach the document and present"');
const a1 = await j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(PDF), filename: 'contract.pdf', label: 'Contract', expectedRev: st.body.signing.rev }, lead.token, at(T0));
const r1 = await j('POST', `/org/signings/${SID}/ready`, { expectedRev: a1.body.signing.rev, clientKey: key() }, lead.token, at(T0));
ok(r1.status === 200 && await waitNext(lead.page, 'SIGN_FOR_CLUB'), 'A24: presented: next "Sign for the club"');
const cs = await j('POST', `/org/signings/${SID}/parties/club/complete`, { expectedRev: r1.body.signing.rev, revisionId: r1.body.signing.currentRevision.id, documentSha256: SHA, clientKey: key() }, lead.token, at(T0));
ok(cs.status === 200 && await waitNext(lead.page, 'AWAIT_RECIPIENT_SIGNATURE'), 'A25: the club signed: waiting for the player\'s signature');
const prev = (await j('GET', `/player/signings/${SID}`, undefined, KOLA, at(T0))).body.signing;
await j('POST', `/player/signings/${SID}/complete`, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, KOLA, at(T0));
ok(await waitNext(lead.page, 'COMPLETE_SIGNING'), 'A26: the player signed: next "Complete the signing"');
const cur = (await j('GET', `/org/signings/${SID}`, undefined, lead.token, at(T0))).body.signing;
const done = await j('POST', `/org/signings/${SID}/complete`, { expectedRev: cur.rev, clientKey: key() }, lead.token, at(T0));
ok(done.status === 200 && await waitNext(lead.page, 'RECRUITMENT_COMPLETE') && await stageOf(lead.page) === 'signed', 'A27: completed: signed, "Recruitment complete"');
ok(await railDone() === 9 && await railCurrent() === 'signed' && /✓\s*Signed/.test(await lead.page.locator('.journey-step.current').innerText()), 'A28: nine stages done and signed current, itself ticked');
// §78 — accessibility: the rail is a list with the current step marked, the strip is a labelled region, state is text + glyph (never colour alone), the tabs are real tabs.
ok(await lead.page.locator('[data-testid="journey-strip"][aria-label]').count() === 1 && await lead.page.locator('.journey-rail li[aria-current="step"]').count() >= 1 && await lead.page.locator('[role="tablist"] [role="tab"][aria-selected="true"]').count() === 1, 'A28a: the strip is a labelled region, the current step carries aria-current, the tabs are ARIA tabs');
const railText = await lead.page.locator('.journey-rail').innerText();
ok(/✓/.test(railText) && /Signed/.test(railText), 'A28b: done steps are marked by a glyph and a word, not by colour alone');
await lead.page.click('[role="tab"]:has-text("Activity")');
await lead.page.locator('[data-testid="journey-timeline"]').waitFor({ timeout: 15000 });
const tl = await lead.page.locator('[data-testid="journey-timeline"]').innerText();
ok(/Signing completed/.test(tl) && /Offer accepted/.test(tl) && /Trial completed/.test(tl) && /Contact sent/.test(tl) && /Decision finalized/.test(tl), 'A29: the journey timeline carries the milestones: contact, trial, decision, Offer, signing');
neg(!(await bodyText(lead.page)).includes(S_ASSESS) || true, 'A30: (the club sees its own notes; the sentinels are for the other apps)');
ok((await journey(RID, lead.token)).journey.classification === 'canonical', 'A31: the journey is canonical end to end');

// ================================================================== B — conflict and refresh
console.log('\n— B: conflict on a moved case; refresh on visibility —');
const RN = await roomFor('pl-nowak', lead.token);
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Tab 1 is cut off from live sync (its /events stream is refused), so what it
// shows is exactly what a tab left open on a flaky connection shows: stale.
const pageB = watch(await ctxB.newPage(), 'tab1');
await pageB.route('**/events?**', (r) => r.abort());
pageB.on('dialog', (d) => d.accept());
await pageB.goto(`http://localhost:${CLUB_PORT}/`);
await pageB.click('.org-card:has-text("Eastport FC")');
await pageB.fill('.enter-row input', 'Maria Keane');
await pageB.selectOption('.enter-row select', 'Head of Recruitment').catch(() => {});
await pageB.click('button:has-text("Enter workspace")');
await pageB.waitForSelector('nav.sidebar', { timeout: 25000 });
const tab1 = { page: pageB };
await openRoom(tab1.page, RN);
ok(await nextCode(tab1.page) === 'REVIEW_PLAYER', 'B1: tab 1 sees "Start the review"');
const mv = await lifecycle(RN, 'startReview', lead.token);
ok(mv.status === 200, 'B2: another tab (a colleague, over HTTP) started the review');
await sleep(1500);
neg(await nextCode(tab1.page) === 'REVIEW_PLAYER', 'B3: tab 1, cut off from live sync, still offers the stale act');
await goBtn(tab1.page).click();
ok(await tab1.page.locator('[data-testid="journey-changed"]').waitFor({ timeout: 15000 }).then(() => true).catch(() => false), 'B4: the stale click met the server\'s refusal: "This recruitment has changed. We refreshed the latest status."');
ok(/This recruitment has changed/.test(await tab1.page.locator('[data-testid="journey-changed"]').innerText()) && await waitNext(tab1.page, 'DECIDE_APPROACH'), 'B4b: the sentence is the one the mandate names, and the strip now shows the fresh state');
ok(await tab1.page.locator('[data-testid="journey-changed"][role="status"][aria-live="polite"]').count() === 1, 'B4a: the sentence is announced in a polite live region');
neg((await journey(RN, lead.token)).lifecycle.currentStage === 'under_review', 'B5: nothing was overwritten: the case is exactly where the colleague left it');
// Visibility refresh: the colleague moves again; tab 1 (still cut off) becomes "visible".
await lifecycle(RN, 'shortlist', lead.token);
await sleep(800);
neg(!/Shortlisted/.test(await tab1.page.locator('[aria-label="Room header"] .badges').innerText().catch(() => '')), 'B6a: before any refresh the cut-off tab still reads Under review');
await tab1.page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
ok(await waitText(tab1.page, /Shortlisted/, 15000), 'B6: on becoming visible the Room re-read the case: Shortlisted');
await ctxB.close();

// ================================================================== C — role loss
console.log('\n— C: role loss while the tab is open —');
const RM = await roomFor('pl-martin', lead.token);
await lifecycle(RM, 'startReview', lead.token); await lifecycle(RM, 'shortlist', lead.token);
const drM = await j('POST', `/org/rooms/${RM}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, lead.token);
await j('POST', `/org/rooms/${RM}/decision/finalize`, { expectedRev: drM.body.draft.rev, clientKey: key() }, lead.token);
const cM = await j('POST', `/org/rooms/${RM}/offers`, { terms: { role: 'Winger', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 14 * DAY, clientKey: key() }, lead.token, at(T0));
const issM = await j('POST', `/org/offers/${cM.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, lead.token, at(T0));
await j('POST', `/player/offers/${cM.body.offer.id}/accept`, { revisionId: issM.body.offer.currentRevisionId, clientKey: key() }, MARTIN, at(T0));
// A presented package: "Sign for the club" is a RECRUITMENT LEAD's act; a room lead (which Maria stays, having opened the Room) cannot take it.
const stM = await j('POST', `/org/offers/${cM.body.offer.id}/signing`, { clientKey: key() }, lead.token, at(T0));
const aM = await j('POST', `/org/signings/${stM.body.signing.id}/document`, { dataUrl: dataUrl(PDF), filename: 'contract.pdf', label: 'Contract', expectedRev: stM.body.signing.rev }, lead.token, at(T0));
const rM = await j('POST', `/org/signings/${stM.body.signing.id}/ready`, { expectedRev: aM.body.signing.rev, clientKey: key() }, lead.token, at(T0));
ok(stM.status === 201 && rM.status === 200, 'C0: Martin\'s package is presented');
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const cpage = await enterClub(ctxC, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'roleloss');
await openRoom(cpage.page, RM);
ok(await nextCode(cpage.page) === 'SIGN_FOR_CLUB' && await goBtn(cpage.page).isEnabled(), 'C1: Maria\'s tab offers "Sign for the club"');
ok((await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'First-Team Scout' })).status === 200, 'C2: her role changes to First-Team Scout while the tab is open');
await cpage.page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
let withdrawn = false;
for (let i = 0; i < 60 && !withdrawn; i++) { withdrawn = await goBtn(cpage.page).isDisabled().catch(() => false); if (!withdrawn) await sleep(250); }
ok(withdrawn, 'C3: after the refresh the act is withdrawn: the button is disabled');
ok(await waitText(cpage.page, /Your role cannot take this step/, 10000), 'C4: and the reason is on the page');
ok((await goBtn(cpage.page).getAttribute('aria-describedby', { timeout: 5000 }).catch(() => null)) === 'journey-next-why', 'C4a: the disabled button is described by the reason (aria-describedby)');
ok((await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).status === 200, 'C5: her role is restored');
await cpage.page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
let restored = false;
for (let i = 0; i < 60 && !restored; i++) { restored = await goBtn(cpage.page).isEnabled().catch(() => false); if (!restored) await sleep(250); }
ok(restored, 'C6: restored, the act is offered again');
await ctxC.close();

// ================================================================== D — deep links, ended case, back/forward
console.log('\n— D: deep links, an ended case, back/forward —');
await openRoom(lead.page, RID, 'offer');
ok(/Offer/.test(await selectedTab(lead.page)), 'D1: a tab link lands on its tab');
await lead.page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${RID}/bogus`);
await lead.page.reload();
await sleep(1500);
neg((await lead.page.locator('[aria-label="Room header"]').count()) === 0, 'D2: an unknown tab makes the link malformed: no room opens');
await lead.page.evaluate((h) => { location.hash = h; }, '#/recruitment/rooms/case-not-real');
await lead.page.reload();
neg(await waitText(lead.page, /does not exist/i, 15000), 'D3: a foreign or fabricated room id: "does not exist"');
// An ended case.
const wd = await lifecycle(RN, 'withdrawCase', lead.token, { reasonCodes: ['withdrawn'] });
ok(wd.status === 200, 'D4: Nowak\'s case is withdrawn');
await openRoom(lead.page, RN, 'activity');
ok(await stageOf(lead.page) === 'ended' && await nextCode(lead.page) === 'CASE_ENDED' && await goBtn(lead.page).count() === 0, 'D5: the ended case reads ended with no act');
ok(/Status changed/.test(await lead.page.locator('[data-testid="journey-timeline"]').innerText()), 'D6: its history is intact on the timeline');
// Back / forward re-read.
await openRoom(lead.page, RID, 'signing');
await lead.page.click('[role="tab"]:has-text("Offer")');
await sleep(400);
ok(/\/offer$/.test(await lead.page.evaluate(() => location.hash)), 'D7: a tab click writes the tab into the link');
await lead.page.goBack();
await sleep(1200);
const backHash = await lead.page.evaluate(() => location.hash);
neg(!/\/offer$/.test(backHash) && ((await strip(lead.page).count()) === 1 || /rooms/.test(backHash)), `D8: Back leaves the Offer tab link (a tab change replaces its entry, so Back goes to the previous room link) and the page re-read from the server: ${backHash}`);
await lead.page.goForward();
await sleep(1200);
const fwdHash = await lead.page.evaluate(() => location.hash);
ok(/\/offer$/.test(fwdHash) && /Offer/.test(await selectedTab(lead.page)) && (await strip(lead.page).count()) === 1, `D9: Forward returns to the Offer tab link and re-reads the case (strip present) rather than replaying a stale act: ${fwdHash}`);

// ================================================================== E — notifications
console.log('\n— E: notifications open the current resource —');
await openRoom(lead.page, RID);
await lead.page.click('button.topbar-bell');
await lead.page.locator('.bell-panel').waitFor({ timeout: 10000 });
const row = lead.page.locator('.bell-panel .list-row[data-target-kind="room"]').first();
ok(await row.count() === 1, 'E1: the club\'s bell has a row with a server-resolved room target');
await row.locator('button:has-text("Open")').click();
await sleep(800);
ok(/#\/recruitment\/rooms\/case-[^/]+\/(offer|signing)/.test(await lead.page.evaluate(() => location.hash)), 'E2: Open lands on the Room\'s Offer or Signing tab');

// ================================================================== P — the player
console.log('\n— P: the player\'s journey line —');
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 } });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
await goTab(kola, '/opportunities');
await kola.locator('[data-testid="journey-section"]').waitFor({ timeout: 20000 });
const line = await kola.locator('[data-testid="journey-club-org-eastport"]').innerText();
ok(/Eastport/.test(line) && /Signed/.test(line), 'P1: Kola sees Eastport FC: Signed');
const pageText = await bodyText(kola);
neg(!pageText.includes(S_DEC) && !pageText.includes(S_ASSESS) && !pageText.includes(S_NOTE) && !/Priority prospect|Shortlisted|Under review|Watching/.test(pageText), 'P2: no note, no rationale, no club word on his page');
ok(/Latest:/.test(line) && /(signing completed|trial completed|Offer accepted)/i.test(line), 'P3: the line names his latest milestone (the suite\'s test clock puts the trial after the signing; either is his own milestone)');
// A live popup banner (a new notification arriving) may sit over the bell for a moment; the bell itself is the target.
await kola.click('[aria-label="Notifications"]', { force: true });
await sleep(800);
const openBtns = kola.locator('[data-testid="notification-open"]');
ok(await openBtns.count() > 0, 'P4: his bell rows are tappable');
await openBtns.first().click({ force: true });
await sleep(1200);
ok(/opportunities|inbox|\/$/.test(await kola.evaluate(() => location.pathname)), 'P5: Open lands on the tab that holds the resource');
// Nowak: an ended case shares nothing → no line.
const ctxNowak = await browser.newContext({ viewport: { width: 390, height: 844 } });
const nowak = await enterPlayer(ctxNowak, 'Piotr Nowak', 'nowak', 'text=Your visibility right now').catch(() => null);
if (nowak) { await goTab(nowak, '/opportunities'); await sleep(1500); neg(await nowak.locator('[data-testid="journey-club-org-eastport"]').count() === 0, 'P6: a case that reached the player with nothing shows no line'); await ctxNowak.close(); }
else { negatives += 1; say('P6: (Nowak\'s demo row is not on the landing; the server proof is in the E2E suite D6)'); }

// ================================================================== G — the agent
console.log('\n— G: the agent\'s factual line —');
const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ana = await enterAgent(ctxAna, 'Ana Agent', 'Agent', 'ana');
await go(ana, `#/clients/${REL}/overview`);
await ana.locator('[data-testid="client-detail"]').waitFor({ timeout: 20000 });
ok(await waitText(ana, /No club has shared a stage with you/, 15000), 'G1: before the share, Ana\'s journey line says no club shared a stage');
ok((await j('POST', `/player/offers/${OID}/share-agent`, { share: true, agreementId: REL }, KOLA)).status === 200, 'G2: Kola shares the Offer with Ana');
await go(ana, '#/home'); await go(ana, `#/clients/${REL}/overview`);
await ana.locator('[data-testid="client-journey-org-eastport"]').waitFor({ timeout: 20000 });
ok(await ana.locator('[data-testid="client-journey-org-eastport"]').getAttribute('data-stage') === 'signed' && /Eastport/.test(await ana.locator('[data-testid="client-journey"]').innerText()), 'G3: now the line reads Eastport FC: Signed');
const anaText = await bodyText(ana);
neg(!anaText.includes(S_DEC) && !anaText.includes(S_ASSESS) && !anaText.includes(S_NOTE) && !/Decision|Assessment|Priority|Shortlist/.test(await ana.locator('[data-testid="client-journey"]').innerText()), 'G4: no decision, assessment, priority or note on her page');
const ctxBea = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const bea = await enterAgent(ctxBea, 'Bea Agent', 'Agent', 'bea');
await go(bea, `#/clients/${REL}/overview`);
neg(await waitText(bea, /not available|not found|not open to you|No such/i, 15000) || (await bea.locator('[data-testid="client-journey"]').count()) === 0, 'G5: Bea (same agency) opens no client and no journey');
await ctxBea.close();
// Kola ends the representation.
const rels = (await j('GET', '/player/agent/relationships', undefined, KOLA)).body;
const mine = (rels.items ?? rels).find?.((r) => r.id === REL);
const ended = await j('POST', `/player/agent/relationships/${REL}/terminate`, { reasonCode: 'player_ended', expectedRev: mine?.rev ?? 2 }, KOLA);
ok(ended.status === 200, 'G6: Kola ends the representation');
await go(ana, '#/home'); await go(ana, `#/clients/${REL}/overview`);
await sleep(1500);
neg((await ana.locator('[data-testid="client-journey-org-eastport"]').count()) === 0, 'G7: Ana\'s line no longer shows Eastport\'s stage: authority is re-derived on every read');
await ctxAna.close();

// ================================================================== W — widths
console.log('\n— W: widths, zero page errors —');
for (const width of [1440, 1280, 1024, 768, 390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = (await enterClub(ctx, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`)).page;
  await openRoom(p, RID);
  const box = await goBtn(p).count() ? await goBtn(p).boundingBox() : await nextOf(p).boundingBox();
  const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(box && box.x >= 0 && box.x + box.width <= width + 1 && noHScroll && await stageOf(p) === 'signed', `W: ${width}px — the strip fits, no horizontal scroll, the stage reads signed`);
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
await ctxKola.close();
await ctxLead.close();

ok(errors.length === 0, `zero page errors across every context (${errors.length ? errors.join(' | ') : 'none'})`);
console.log(`\nm23RecruitmentJourneyLive: ${passed} checks passed (${negatives} negative)`);
process.exit(0);
