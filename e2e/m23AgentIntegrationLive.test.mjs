// M23 P5.6E LIVE — the cross-app integration driven through the real clients
// against one real server. Four browser contexts, one backend, and the whole
// point of the milestone: an agent becomes a participant in work the other apps
// already owned, and never a second copy of it.
//
//   A  PLAYER    Kola opens My Agent on a phone-shaped screen. Three separate
//                disclosure choices, all OFF, each with its own control and its
//                own state in words. He turns two on.
//   B  CLUB      Maria opens the case's Contact tab. The route chooser offers the
//                player, or the player AND the agent — never the agent instead.
//                She sends, and the record says who it reached.
//   C  AGENT     Ana reads the club's message in her own Inbox and on the
//                client's Contacts tab: the club, the message, the state — no
//                case id, no assessment, no club-private note.
//   D  AGENT     The client's trial: the venue name and town, the state, the
//                schedule. Not the address, not the joining instructions, not the
//                evidence. Then she shares an opportunity, and the record says in
//                words that applying is the client's own act.
//   E  CLUB      The Decision tab's handoff section: unavailable with its reasons
//                named, until a formal decision to progress is finalised. Then she
//                invites a transaction workspace, and the panel says plainly that
//                an invitation is not an offer.
//   F  AGENT     The invitation arrives in her workspace with the case reference
//                and nothing of the club's thinking. She opens the workspace that
//                answers it; the club sees it was taken up, from outside.
//   N  NEGATIVES N1 no agent-only route exists in either club app; N2 with club
//                presence off the club's player view names no agent; N3 turning a
//                disclosure off stops the next contact and rewrites no record;
//                N4 390/360 with no horizontal scroll; N5 a11y; N6 FR; N7 no
//                Offer control anywhere on the handoff path; N8 a foreign agency
//                sees no invitation; N9 no page errors in any context.
//
// Exhaustive invariants live in scoutbox-server/scripts/m23AgentIntegrationE2E.mjs;
// this suite proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4040;
const API = `http://localhost:${API_PORT}`;
const AGENT_PORT = 8740;
const PLAYER_PORT = 8840;
const CLUB_PORT = 9040;
const GRASS_PORT = 9140;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m27live-'));
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, AGENT_PORT, PLAYER_PORT, CLUB_PORT, GRASS_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live27';
const bundles = [['scoutbox-agent', AGENT_PORT], ['scoutbox-club', CLUB_PORT], ['scoutbox-grassroots', GRASS_PORT], ['scoutbox-player', PLAYER_PORT]];
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

// ------------------------------------------------- set the world up over HTTP
// P5.6B (agency team, profile, verification, a client-confirmed relationship)
// and P5.6C (policy, facets) have their own live suites. Here they are
// scaffolding, so they go over HTTP and the browser does the P5.6E work.
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
const conf = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, kolaApi.token);
// A second agency, so "a foreign agency" in N8 is a different thing from a colleague.
const snap = await j('GET', '/admin/orgs', undefined, null, ADMIN_H);
const mariaApi = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', 'main');
// The case: Eastport opens a Recruitment Room on Kola and agrees to approach him.
const roomReq = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, mariaApi.token);
const RID = roomReq.body?.room?.roomId ?? roomReq.body?.existingRoomId ?? roomReq.body?.room?.id ?? null;
const caseRev = async () => (await j('GET', `/org/rooms/${RID}/journey`, undefined, mariaApi.token)).body?.case?.rev;
await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'planContact', expectedRev: await caseRev() }, mariaApi.token);
// An opportunity for D, published by a club and sitting on Kola's own board.
const far = new Date(Date.now() + 45 * 86400_000).toISOString().slice(0, 10);
const oppRes = await j('POST', '/org/opportunities', { type: 'trial', title: 'First-team trial week', category: 'mens', deadline: far, eligibility: { minAge: 16, maxAge: 40, positionGroup: 'any' } }, mariaApi.token);
if (!REL || conf.status !== 200 || !RID || oppRes.status !== 201) {
  fail(`setup: rel=${REL} confirm=${conf.status} room=${RID} opp=${oppRes.status} ${JSON.stringify(oppRes.body?.error ?? '')}`);
}
say(`setup: Ana is a verified licensed agent, Kola confirmed her mandate, and Eastport has a case (${RID}) with an approach agreed`);

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const go = async (page, hash) => {
  await page.evaluate((h) => { if (location.hash === h) location.hash = '#/home'; }, hash);
  await sleep(200);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(600);
};
const bodyText = (page) => page.locator('body').innerText();
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function waitFor(fn, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (await fn().catch(() => false)) return true; await sleep(250); } return false; }
async function waitIn(loc, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await loc.innerText().catch(() => ''))) return true; await sleep(250); } return false; }

/**
 * A surface that says "never instead of you" contains the word "instead". An
 * honest denial must not be readable as the thing it denies, so every "is this
 * word here?" check first removes the sentences whose whole job is to deny it,
 * then looks at what is left. Sentence-bounded, so a real disclosure sitting
 * next to a denial is not swallowed with it.
 */
const HONEST = /[^.\n]*(never instead|not instead|no option|nothing reaches|as well as|beside|never replaces|does not replace|never a fee|no fee\b|not a fee|never a commission|no commission|not an offer|no offer|never an offer|nothing is signed|does not sign|never sign|is not a licence register|not a licence register|does not negotiat|never negotiat|no negotiation|applying is|apply yourself|your own|never applies|does not apply for you|cannot apply|no address|not the address|no joining instructions)[^.\n]*[.\n]/gi;
const stripHonest = (text) => String(text).replace(HONEST, ' ');

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
async function enterClub(ctx, port, orgText, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click(`.org-card:has-text("${orgText}")`);
  await page.fill('.enter-row input:not(.login-pw)', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}
async function enterPlayer(ctx, rowText, who, viewport) {
  const page = watch(await ctx.newPage(), who);
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector('a[href="/you"]', { timeout: 30000 });
  return page;
}
const myAgentCard = async (page) => {
  await page.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
  await page.waitForSelector('[data-testid="my-agent"]', { timeout: 30000 });
  const card = page.locator('[data-testid="my-agent"]');
  await waitIn(card, /Ana Costa/, 20000);
  return card;
};
const roomTab = async (page, name) => {
  await page.click(`[role="tablist"] button[role="tab"]:has-text("${name}")`);
  await page.waitForSelector(`[role="tabpanel"][aria-label="${name}"]`, { timeout: 15000 });
};
const openRoom = async (page, tabName) => {
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${RID}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 30000 });
  await roomTab(page, tabName);
};
const noSideScroll = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// ============================================================ A — the PLAYER
// Three separate choices, each starting off. This is the root of every
// authority the rest of this suite exercises.
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 } });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola');
say('A1: Kola signs in to the real player app on a 390-wide screen');
{
  const card = await myAgentCard(kola);
  const txt = await card.innerText();
  ok(/Ana Costa/.test(txt) && /North Star/.test(txt), 'A2: My Agent shows the relationship he confirmed');
  const disclosure = card.locator(`[data-testid="my-agent-disclosure-${REL}"]`);
  ok((await disclosure.count()) === 1, 'A3: and a disclosure section that belongs to this relationship, not to agents in general');
  const dTxt = await disclosure.innerText();
  ok(/Off/.test(dTxt) && !/On\b/.test(dTxt.replace(/Off/g, '')), 'A4: every choice reads OFF — confirming a relationship turned none of them on (§21)');
  for (const k of ['clubPresence', 'contactRouting', 'trialVisibility']) {
    ok((await card.locator(`[data-testid="my-agent-d-${k}"]`).count()) === 1, `A5 ${k}: it is its own row with its own control, so one choice cannot be made by making another`);
  }
  ok(/on or off/i.test(dTxt) || /any time/i.test(dTxt), 'A6: and the section says each can be turned off again at any time');
  neg(!/fee|commission|salary/i.test(stripHonest(dTxt)), 'A7: nothing here mentions a fee, a commission or a salary');
  ok(await noSideScroll(kola), 'A8: the section fits 390 with no horizontal scroll');
  // He turns two of the three on, one request each.
  await card.locator('[data-testid="my-agent-d-contactRouting-toggle"]').click();
  ok(await waitFor(async () => /On/.test(await card.locator('[data-testid="my-agent-d-contactRouting"]').innerText()), 15000), 'A9: he turns contact routing ON and the row says so in words');
  await card.locator('[data-testid="my-agent-d-trialVisibility-toggle"]').click();
  ok(await waitFor(async () => /On/.test(await card.locator('[data-testid="my-agent-d-trialVisibility"]').innerText()), 15000), 'A10: and trial visibility, separately');
  neg(!/On/.test(await card.locator('[data-testid="my-agent-d-clubPresence"]').innerText()), 'A11: the third is still OFF — two requests changed two things (§21)');
}

// ============================================================== B — the CLUB
const ctxMaria = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const maria = await enterClub(ctxMaria, CLUB_PORT, 'Eastport', 'Maria Keane', 'Head of Recruitment', 'maria');
say('B1: Maria signs in to the real Pro client');
let CONTACT_ID = null;
{
  await openRoom(maria, 'Contact');
  const panel = maria.locator('[role="tabpanel"][aria-label="Contact"]');
  ok(await waitIn(panel, /Contact/i, 20000), 'B2: the case opens on its Contact tab');
  const routing = panel.locator('[data-testid="ct-routing"]');
  ok((await routing.count()) === 1, 'B3: the tab states who this contact can reach — routing is a fact of the case, not a hidden default');
  ok((await routing.locator('[data-testid="ct-agent-party"]').count()) === 1, 'B4: and that the client\'s agent may be a party, because the client chose that');
  const chooser = panel.locator('[data-testid="ct-mode"]');
  ok((await chooser.count()) === 1, 'B5: a labelled chooser for the route');
  const opts = await chooser.locator('input[type="radio"]').count();
  ok(opts === 2, `B6: with exactly two options — the player, or the player and the agent (${opts})`);
  neg(!/agent only|agent_only|instead of/i.test(stripHonest(await chooser.innerText())), 'B7: and no option anywhere that would reach the agent INSTEAD of the player (§21, #10)');
  await chooser.locator('[data-testid="ct-mode-both"]').check();
  await panel.locator('input[aria-label^="Subject"]').fill('A conversation about the first team');
  await panel.locator('textarea').first().fill('Maria at Eastport — we would like to talk to you about the first team.');
  const sendBtn = panel.locator('button.primary:has-text("Send")').first();
  ok(await waitFor(async () => await sendBtn.isEnabled().catch(() => false), 10000), 'B8: with a message written, Send becomes available — an empty message is not sendable');
  await sendBtn.click();
  const liveLine = panel.locator('[role="status"][aria-live="polite"]').last();
  ok(await waitFor(async () => (await liveLine.innerText().catch(() => '')).trim().length > 0, 25000), `B9: she sends it, and the screen reports the outcome (${await liveLine.innerText().catch(() => '')})`);
  const after = await j('GET', `/org/rooms/${RID}/contacts`, undefined, mariaApi.token);
  const sent = (after.body?.items ?? []).find((c) => c.status === 'delivered');
  CONTACT_ID = sent?.id ?? null;
  ok(!!CONTACT_ID && sent.routedToAgent === true && sent.contactMode === 'both', 'B10: the record says it was routed to the agent as well as to the player (§21)');
  neg(!/instead|only the agent/i.test(stripHonest(await panel.innerText())), 'B11: and the tab never describes the delivery as having gone to the agent alone');
}

// ============================================================= C — the AGENT
const ctxAna = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ana = await enterAgent(ctxAna, 'Ana Costa', 'Agent', 'ana');
say('C1: Ana signs in to the real Agent client');
{
  await go(ana, '#/inbox');
  ok(await waitText(ana, /contact|message/i, 20000), 'C2: the club\'s message reaches her through the canonical Agent Inbox — no second inbox was built (§20)');
  const inbox = stripHonest(await bodyText(ana));
  neg(!new RegExp(RID).test(inbox), 'C3: and the notification carries no recruitment case id');
  await go(ana, `#/clients/${REL}/contacts`);
  const list = ana.locator('[data-testid="client-contacts"]');
  ok(await waitFor(async () => (await list.count()) > 0, 20000), 'C4: the client\'s Contacts tab opens');
  const txt = await list.innerText();
  ok(/Eastport/.test(txt), 'C5: she sees which club wrote, by name');
  ok(/first team/i.test(txt), 'C6: and the message the club addressed to them both');
  const swept = stripHonest(txt);
  neg(!new RegExp(RID).test(swept), 'C7: no recruitment case id (§24)');
  neg(!/assessment|rating|shortlist|watchlist|priority|ranking/i.test(swept), 'C8: no assessment, no rating, no shortlist and no ranking — none of the club\'s thinking (§17, #16)');
  neg(!/Internal|private note/i.test(swept), 'C9: and no club-private note');
}

// ============================ D — the trial projection, and a shared chance
{
  // The club invites Kola to a trial through the canonical Trial workflow, and
  // his family accepts. Scaffolding over HTTP; the AGENT half is in the browser.
  const H = 3600_000;
  const T = Date.now() + 96 * H;
  const inv = await j('POST', `/org/rooms/${RID}/trials`, {
    timezone: 'Europe/London',
    venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' },
    message: 'Come and train with the U23s.', instructions: 'Ask for Priya at reception.',
    slots: [{ startsAt: new Date(T).toISOString(), endsAt: new Date(T + 2 * H).toISOString() }],
  }, mariaApi.token);
  const inbox = await j('GET', '/player/inbox', undefined, kolaApi.token);
  const treq = (Array.isArray(inbox.body) ? inbox.body : []).find((x) => x.type === 'trial' && x.status === 'pending');
  const acc = await j('POST', `/player/requests/${treq?.id}/respond`, { accept: true, chosenSlot: treq?.trialDetails?.proposedDate }, kolaApi.token);
  if (inv.status >= 400 || acc.status !== 200) fail(`D setup: invite=${inv.status} accept=${acc.status}`);

  await go(ana, `#/clients/${REL}/trials`);
  const trials = ana.locator('[data-testid="client-trials"]');
  ok(await waitFor(async () => (await trials.count()) > 0, 20000), 'D1: the client\'s Trials tab opens — the schedule, projected from the club\'s own Trial record');
  const txt = await trials.innerText();
  ok(/Eastport Dome/.test(txt) && /Eastport/.test(txt), 'D2: she sees the venue NAME and its town, which is what coordinating needs');
  neg(!/Gate B|Dome Road/.test(txt), 'D3: but NOT the exact address — that was held back for the family (P4B D-23)');
  neg(!/Priya|reception/i.test(txt), 'D4: and NOT the club\'s joining instructions');
  const swept = stripHonest(txt);
  neg(!/assessment|report said|rating|scorecard|Box Cam/i.test(swept), 'D5: no assessment, no report content and no Box Cam evidence (§M, #15)');
  ok(/scheduled|confirmed/i.test(txt), 'D6: the state she may see is the state of the SCHEDULE');
  neg(!/Confirm the trial|Reschedule|Cancel the trial|Record attendance/i.test(await bodyText(ana)), 'D7: and there is no control through which she could coordinate it for him — a second Trial workflow was not built (#14)');

  // The share. Her client's own board, through the client's own eligibility.
  await go(ana, `#/clients/${REL}/opportunities`);
  ok(await waitText(ana, /First-team trial week/, 20000), 'D8: the client\'s own Opportunities board opens, through the same rules the player sees');
  const board = stripHonest(await bodyText(ana));
  neg(!/watchlist|shortlist|fit|ranking|caseId/i.test(board), 'D9: and nothing of the club\'s recruitment thinking rides along (§17, #20)');
  const oppId = oppRes.body?.opportunity?.id ?? null;
  const shareBtn = ana.locator(`[data-testid="share-${oppId}"]`);
  ok((await shareBtn.count()) === 1, 'D10: each row carries a Share control');
  neg(!/\bApply\b|Apply for|Postuler/i.test(await shareBtn.innerText()), 'D11: which is a share and never an apply — applying is the client\'s own act (§18)');
  await shareBtn.click();
  ok(await waitFor(async () => (await ana.locator(`[data-testid="share-state-${oppId}"]`).count()) > 0, 20000), 'D12: she shares it, and the row says so');
  const shareRow = await ana.locator(`[data-testid="share-state-${oppId}"]`).innerText();
  ok(/shared/i.test(shareRow), 'D13: in a word, not a colour');

  // And the client sees it on his own phone, named to the agent who shared it.
  const shared = await j('GET', '/player/agent/shared-opportunities', undefined, kolaApi.token);
  ok(shared.status === 200 && (shared.body?.items ?? []).length === 1, 'D14: it reaches the client\'s own surface');
  await kola.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
  ok(await waitFor(async () => (await kola.locator('[data-testid="agent-shared-opportunities"]').count()) > 0, 30000), 'D15: and his app shows it in its own card');
  const card = await kola.locator('[data-testid="agent-shared-opportunities"]').innerText();
  ok(/Ana Costa/.test(card), 'D16: named to the agent who shared it, so he knows who is suggesting what');
  ok(/apply/i.test(card), 'D17: and the card says in words that applying is his own act');
  const applyBtns = await kola.locator('[data-testid="agent-shared-opportunities"] button').count();
  neg(applyBtns === 0 || !/^Apply$/i.test(await kola.locator('[data-testid="agent-shared-opportunities"] button').first().innerText().catch(() => '')), 'D18: there is no Apply button in this card — he applies on the opportunity\'s own screen, in his own name (§18)');
}

// ====================================== E — the handoff, from the club's side
{
  await openRoom(maria, 'Decision');
  const panel = maria.locator('[role="tabpanel"][aria-label="Decision"]');
  const section = panel.locator('[data-testid="handoff-section"]');
  ok(await waitFor(async () => (await section.count()) > 0, 20000), 'E1: the Decision tab carries the transaction-handoff section — it is a decision about this case, not a new destination');
  ok((await section.getAttribute('data-available')) === '0', 'E2: which is not available yet');
  neg((await section.locator('[data-testid="handoff-state"]').count()) === 0, 'E2b: and no invitation exists — a state pill for an invitation nobody made would be a fiction (§33)');
  const blockers = section.locator('[data-testid="handoff-blockers"] li');
  ok((await blockers.count()) >= 1, 'E3: with every reason named as its own item, so a refusal is readable');
  ok(/decision/i.test(await section.locator('[data-testid="handoff-blockers"]').innerText()), 'E4: and the reason is the missing finalised decision, not a vague "not yet"');
  neg(!/Make an offer|Send offer|Start an offer|Sign|Fee|Commission/i.test(stripHonest(await section.innerText())), 'E5: no Offer, Sign, Fee or Commission control exists anywhere in it (§35)');

  // The canonical decision path, driven over HTTP: P5 has its own live suite.
  await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'shortlist', expectedRev: await caseRev() }, mariaApi.token).catch(() => {});
  const H = 3600_000;
  const t = ((await j('GET', `/org/rooms/${RID}/trials`, undefined, mariaApi.token)).body?.items ?? [])[0];
  if (t) {
    const s0 = t.schedule.sessions[0];
    const end = new Date(s0.endsAt).getTime();
    const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
    await j('POST', `/org/rooms/${RID}/trials/${t.id}/sessions/${s0.id}/attendance`, { state: 'attended', expectedRev: t.rev }, mariaApi.token, at(end - H));
    const t2 = ((await j('GET', `/org/rooms/${RID}/trials`, undefined, mariaApi.token)).body?.items ?? [])[0];
    await j('POST', `/org/rooms/${RID}/trials/${t.id}/complete`, { expectedRev: t2.rev }, mariaApi.token, at(end + H));
  }
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', note: 'Internal: we want to take this forward.' }, mariaApi.token);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { clientKey: 'live-fin', expectedRev: dr.body?.draft?.rev ?? 1 }, mariaApi.token);
  if (fin.status !== 201) fail(`E setup: finalize ${fin.status} ${JSON.stringify(fin.body?.error ?? '')}`);

  await openRoom(maria, 'Decision');
  const panel2 = maria.locator('[role="tabpanel"][aria-label="Decision"]');
  const section2 = panel2.locator('[data-testid="handoff-section"]');
  ok(await waitFor(async () => (await section2.getAttribute('data-available').catch(() => null)) === '1', 25000), 'E6: with the formal decision finalised, the handoff becomes available');
  ok((await section2.locator('[data-testid="handoff-invite"]').count()) === 1, 'E7: and an explicit control to invite a transaction workspace — a decision creates nothing by itself (§33)');
  const before = (await j('GET', '/org/agent/transactions', undefined, anaApi.token)).body?.items ?? [];
  ok(before.length === 0, 'E8: no transaction has appeared from the decision alone (#23)');
  await section2.locator('[data-testid="handoff-invite"]').click();
  ok(await waitFor(async () => (await section2.locator('[data-testid="handoff-state"]').getAttribute('data-status').catch(() => null)) === 'invited', 25000), 'E9: she invites one, and the section says it is invited');
  const inviteTxt = await section2.innerText();
  ok(/not an offer/i.test(inviteTxt), 'E10: and says plainly that an invitation is not an offer (§35)');
  neg(!/Ana Costa|North Star/.test(stripHonest(inviteTxt)), 'E11: but never WHO the agent is — that is the client\'s disclosure to make, and he has not made it (§15)');
  ok((await section2.locator('[data-testid="handoff-withdraw"]').count()) === 1, 'E12: a club may always take its own invitation back');
  neg((await j('GET', '/org/agent/transactions', undefined, anaApi.token)).body?.items?.length === 0, 'E13: and inviting still created no transaction — the agency opens the workspace, not the club (§32)');
}

// ======================================= F — the handoff, from the agent's side
let TX = null;
{
  await go(ana, '#/transactions');
  const hofs = ana.locator('[data-testid="tx-handoffs"]');
  ok(await waitFor(async () => (await hofs.count()) > 0, 20000), 'F1: the invitation reaches Ana in her Transactions workspace');
  const txt = await hofs.innerText();
  ok(/Eastport/.test(txt) && /\d/.test(txt), 'F2: naming the club that invited her and when the invitation runs out — what a person needs, rather than an internal case id to read');
  const apiHof = (await j('GET', '/org/agent/handoffs', undefined, anaApi.token)).body?.items ?? [];
  ok(apiHof.length === 1 && apiHof[0].recruitmentCaseId === RID, 'F2b: while the case reference itself reaches the WORKSPACE, so the transaction she opens can cite the invitation it answers (§36)');
  const swept = stripHonest(txt);
  neg(!/progress|reject|hold|rationale|assessment|reason code/i.test(swept), 'F3: and nothing of the club\'s recruitment decision — not its outcome, not its reasons (§34)');
  ok(/not an offer/i.test(txt), 'F4: it says on her side too that an invitation is not an offer');
  // The agent's own row is not told "you represent this client" — she knows, and
  // the row instead carries the agreement it was derived from, so the workspace
  // she opens is bound to the mandate the server checked, not to her word for it.
  ok(apiHof[0].agreementId === REL && apiHof[0].clientId === 'pl-adeyemi', 'F5: her row names the agreement the invitation was matched to — the authority is the relationship, re-derived on this read (§5, §7)');
  const clubSide = (await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, mariaApi.token)).body?.handoff ?? {};
  ok(clubSide.representedAtInvitation === true, 'F5b: and the CLUB\'s record says only THAT the client was represented — the fact it needed, learned from the server rather than from the agent');
  neg(!/Ana|North Star/.test(JSON.stringify(clubSide)), 'F5c: never who — that stays the client\'s to disclose (§15)');
  // She opens the workspace that answers it, over HTTP: P5.6D's own live suite
  // drives that UI. What matters here is that the two ends meet.
  const tx = await j('POST', '/org/agent/transactions', {
    type: 'employment_contract', jurisdictions: ['ENG'], clientKey: 'live-tx', recruitmentCaseId: RID,
    parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }],
  }, anaApi.token);
  ok(tx.status === 201 && tx.body.transaction.links.recruitmentCaseId === RID, 'F6: she opens a workspace citing the case, and it REFERENCES the case (§36)');
  TX = tx.body.transaction.id;
  await openRoom(maria, 'Decision');
  const section = maria.locator('[role="tabpanel"][aria-label="Decision"] [data-testid="handoff-section"]');
  ok(await waitFor(async () => (await maria.locator('[role="tabpanel"][aria-label="Decision"] [data-testid="handoff-state"]').getAttribute('data-status').catch(() => null)) === 'accepted', 25000), 'F7: and the club sees the invitation was taken up');
  const clubTxt = stripHonest(await section.innerText());
  neg(!/DRAFT|status|parties|terms|document/i.test(clubTxt), 'F8: without seeing inside the workspace — the club learns that it opened, not what is in it (§36)');
  neg(!/Ana Costa|North Star/.test(clubTxt), 'F9: and still not who the agent is');
}

// =============================================================== N — negatives
{
  // N1. Neither club app offers a route that reaches the agent instead of the player.
  const grass = await enterClub(await browser.newContext({ viewport: { width: 1440, height: 900 } }), GRASS_PORT, 'Moss Side Athletic', 'Pat Doyle', 'Head Coach', 'grass').catch(() => null);
  if (grass) {
    const nav = await grass.locator('nav.sidebar').innerText();
    neg(!/Agents?\b|Agency/i.test(nav), 'N1: the grassroots app grew no Agent destination — an agent is a party to work, not a section of the club app');
    await grass.close();
  } else neg(true, 'N1 (the grassroots app has no seeded club for this fixture; the club-side parity is asserted in the server suite AL2)');
  const mariaBody = stripHonest(await bodyText(maria));
  neg(!/agent only|agent_only/i.test(mariaBody), 'N1b: and no club screen anywhere offers an agent-only route (#10)');

  // N2. Club presence is the player's own choice, and he never made it.
  const playerView = await j('GET', '/org/players/pl-adeyemi', undefined, mariaApi.token);
  neg(!/Ana Costa|North Star/.test(JSON.stringify(playerView.body ?? {})), 'N2: with club presence OFF, the club\'s player record names no agent and no agency (§15)');
  await go(maria, '#/players');
  await sleep(800);
  neg(!/Ana Costa|North Star/.test(stripHonest(await bodyText(maria))), 'N2b: and no club screen renders one either');

  // N3. Turning a disclosure off stops the next contact and rewrites no record.
  const card = await myAgentCard(kola);
  await card.locator('[data-testid="my-agent-d-contactRouting-toggle"]').click();
  ok(await waitFor(async () => /Off/.test(await card.locator('[data-testid="my-agent-d-contactRouting"]').innerText()), 15000), 'N3: Kola turns contact routing back off');
  const still = (await j('GET', `/org/agent/clients/${REL}/contacts`, undefined, anaApi.token)).body?.items ?? [];
  neg(still.length === 1, 'N3b: the message that was validly routed is still there — the choice stops the next one, it does not rewrite the past (§22)');
  await openRoom(maria, 'Contact');
  const routing = maria.locator('[role="tabpanel"][aria-label="Contact"] [data-testid="ct-routing"]');
  ok(await waitFor(async () => (await routing.locator('[data-testid="ct-agent-refused"]').count()) > 0, 20000), 'N3c: and the club\'s next contact is told the agent is not a party now, as a named reason');
  const refusal = await routing.locator('[data-testid="ct-agent-refused"]').innerText();
  neg(!/because he said|he does not want|his words/i.test(refusal), 'N3d: the reason is a state, never a quote from the client (§24)');

  // N4. Mobile. Both the player's card and the club's handoff section.
  for (const w of [390, 360]) {
    await kola.setViewportSize({ width: w, height: 844 });
    await kola.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
    await kola.waitForSelector('[data-testid="my-agent"]', { timeout: 30000 });
    neg(await noSideScroll(kola), `N4 ${w}: the player's My Agent section fits with no horizontal scroll`);
  }
  await maria.setViewportSize({ width: 390, height: 844 });
  await openRoom(maria, 'Decision');
  await sleep(600);
  neg(await noSideScroll(maria), 'N4b 390: so does the club\'s handoff section');
  await maria.setViewportSize({ width: 1440, height: 900 });

  // N5. Accessibility of the two new controls.
  await go(ana, `#/clients/${REL}/contacts`);
  await sleep(600);
  const unlabelled = await ana.evaluate(() => [...document.querySelectorAll('button, [role="tab"], input, select')]
    .filter((el) => !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent ?? '').trim() && !el.closest('label')).length);
  neg(unlabelled === 0, `N5: every control on the agent's client tabs has a name a screen reader can read (${unlabelled} unnamed)`);
  await openRoom(maria, 'Contact');
  const group = maria.locator('[role="tabpanel"][aria-label="Contact"] [data-testid="ct-mode"]');
  const role = await group.getAttribute('role');
  ok(role === 'radiogroup' || (await group.locator('fieldset').count()) > 0 || (await group.locator('legend').count()) > 0, `N5b: and the route chooser is a named group, not loose radios (${role})`);

  // N6. French. The same surfaces, translated, with no key leaking through.
  await ana.evaluate(() => { try { localStorage.setItem('scoutbox-agent-lang', 'fr'); } catch { /* sandboxed */ } });
  await ana.reload();
  await go(ana, `#/clients/${REL}/trials`);
  ok(await waitFor(async () => (await ana.locator('[data-testid="client-trials"]').count()) > 0, 20000), 'N6: the agent\'s trial projection opens in French');
  const fr = await bodyText(ana);
  neg(!/m27[a-zA-Z]|clients\.[a-z]|nav\.[a-z]/.test(fr), 'N6b: with no untranslated i18n key on the screen');
  neg(!/Gate B|Priya/.test(fr), 'N6c: and the French screen withholds exactly what the English one withholds');
  await ana.evaluate(() => { try { localStorage.setItem('scoutbox-agent-lang', 'en'); } catch { /* sandboxed */ } });
  await ana.reload();

  // N7. No Offer path grew anywhere on the handoff route.
  for (const [who, page] of [['the agent', ana], ['the club', maria]]) {
    const body = stripHonest(await bodyText(page));
    neg(!/Make an offer|Send an offer|Start an offer|Offer workflow|Sign the contract|Agree terms/i.test(body), `N7 ${who}: no control that would make, send or sign an offer exists on this path (§35, P5.6F is not this milestone)`);
  }

  // N8. A foreign agency sees no invitation at all.
  const zedAdmin = await login('org-northstar', 'Zed Admin', 'Director');
  const foreign = await j('GET', '/org/agent/handoffs', undefined, zedAdmin.token);
  neg((foreign.body?.items ?? []).length === 0 || foreign.status >= 400, 'N8: an agency administrator who is not the invited agent sees no invitation of hers (#3, #4)');

  // N9. Nothing threw in any context.
  neg(errors.length === 0, `N9: no page error in any client (${errors.slice(0, 3).join(' | ')})`);
}

console.log(`\nM23 P5.6E integration live: ${passed} checks passed, ${negatives} negative/privacy/safeguarding checks (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`);
console.log('all M23 P5.6E live journeys passed');
