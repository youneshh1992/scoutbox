// M24B LIVE — the recruitment case navigation, driven through the real Pro,
// Grassroots, Agent and Player interfaces against a real server.
//
//   R  ROOM (Pro)        every category, every subcategory renders its panel;
//                        at most five pages per category; exactly one current
//                        category and one selected page; deep links in both
//                        forms land on the page; Back/Forward re-read
//   G  ROOM (Grassroots) the simpler structure, every page; no Pro-only page
//   A  AGENT             every client category and page; every transaction
//                        category and page; no club-private page exists
//   P  PLAYER            every category and page at 390 and 360; no club
//                        word; a notification opens the category of its record
//   W  WIDTHS            360 / 390 / 768 / 1024 / 1280 / 1440: no overflow,
//                        the current category and page on screen, ≥44px
//                        targets on a phone, labels never below 13px
//   K  KEYBOARD          arrows move categories and pages, Enter/Space
//                        activate, focus is visible, tab → panel semantics
//   zero page errors in every context

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { openSub, roomTab, clientTab, txTab, playerCategory, playerSub, playerTabs } from './caseNavHelpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4057;
const API = `http://localhost:${API_PORT}`;
const PORTS = { club: 8757, grassroots: 8758, player: 8857, agent: 8957 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24casenav-'));
const S_DEC = 'PRIVATE_DECISION_SENTINEL_2461';
const S_NOTE = 'PRIVATE_ROOM_NOTE_SENTINEL_2462';
const CLUB_WORDS = /Watchlist|Priority prospect|Shortlisted|Under review|Decision rationale|Second Look|Discussion|Assessment/;

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24cn';
const bundles = [['scoutbox-club', PORTS.club], ['scoutbox-grassroots', PORTS.grassroots], ['scoutbox-player', PORTS.player], ['scoutbox-agent', PORTS.agent]];
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
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

const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const key = () => `live-${Math.random().toString(36).slice(2, 10)}`;

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const bodyText = (page) => page.locator('body').innerText();
const noHScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

async function enterPortal(ctx, port, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button.primary');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}
async function enterPlayer(ctx, rowText, who) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PORTS.player}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  return page;
}
const go = async (page, hash) => { await page.evaluate((h) => { if (location.hash === h) location.hash = '#/'; }, hash); await sleep(150); await page.evaluate((h) => { location.hash = h; }, hash); await sleep(700); };

/** Read the navigation as rendered: categories (with their pages) and what is current. */
async function navState(page, nav) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const cats = [...root.querySelectorAll('.casenav-cat')].map((b) => ({ id: b.dataset.cat, subs: (b.dataset.subs ?? '').split(' ').filter(Boolean), current: b.getAttribute('aria-current') === 'true' }));
    const tabs = [...root.querySelectorAll('[role="tablist"] [role="tab"]')].map((b) => ({ id: b.dataset.sub, selected: b.getAttribute('aria-selected') === 'true', controls: b.getAttribute('aria-controls'), id_: b.id }));
    const panel = document.querySelector('[role="tabpanel"]');
    return { cats, tabs, panel: panel ? { id: panel.id, labelledBy: panel.getAttribute('aria-labelledby'), label: panel.getAttribute('aria-label') } : null, catLabel: root.querySelector('nav')?.getAttribute('aria-label'), tabsLabel: root.querySelector('[role="tablist"]')?.getAttribute('aria-label') };
  }, nav);
}

/** Walk EVERY category and EVERY page of a case; assert the invariants on each. */
async function walkCase(page, nav, prefix, who, { expectCats, forbidden = [] } = {}) {
  const st0 = await navState(page, nav);
  if (!st0) fail(`${who}: no case navigation (${nav})`);
  if (expectCats) ok(st0.cats.map((c) => c.id).join(',') === expectCats.join(','), `${who}: categories ${st0.cats.map((c) => c.id).join(' · ')}`);
  ok(st0.cats.every((c) => c.subs.length >= 1 && c.subs.length <= 5), `${who}: every category holds 1–5 pages (${st0.cats.map((c) => c.subs.length).join('/')})`);
  const all = st0.cats.flatMap((c) => c.subs);
  for (const f of forbidden) if (all.includes(f)) fail(`${who}: private page "${f}" is present`);
  if (forbidden.length) { negatives++; say(`${who}: none of ${forbidden.join(', ')} exists in the navigation (absent, not hidden)`); }
  let visited = 0;
  for (const c of st0.cats) {
    for (const sub of c.subs) {
      await openSub(page, sub, { nav, prefix });
      const st = await navState(page, nav);
      const cur = st.cats.filter((x) => x.current);
      const sel = st.tabs.filter((x) => x.selected);
      if (cur.length !== 1 || cur[0].id !== c.id) fail(`${who} ${c.id}/${sub}: current category is ${cur.map((x) => x.id)}`);
      if (sel.length !== 1 || sel[0].id !== sub) fail(`${who} ${c.id}/${sub}: selected page is ${sel.map((x) => x.id)}`);
      if (st.tabs.length !== c.subs.length || st.tabs.length > 5) fail(`${who} ${c.id}: ${st.tabs.length} pages in the DOM for a category of ${c.subs.length}`);
      if (!st.panel || st.panel.id !== `${prefix}-panel-${sub}` || sel[0].controls !== st.panel.id || st.panel.labelledBy !== sel[0].id_) fail(`${who} ${c.id}/${sub}: tab → panel relation broken (${JSON.stringify(st.panel)})`);
      if (!st.panel.label) fail(`${who} ${c.id}/${sub}: the panel has no accessible name`);
      const txt = await page.locator(`#${prefix}-panel-${sub}`).innerText();
      if (/^\s*$/.test(txt)) fail(`${who} ${c.id}/${sub}: the panel is empty`);
      if (!st.catLabel || !st.tabsLabel) fail(`${who}: the category row or the page row has no accessible name`);
      visited++;
    }
  }
  say(`${who}: every category and every page rendered its panel with one current category and one selected page (${visited} pages)`);
  return st0;
}

// ------------------------------------------------------------------ fixture
const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const MARIA = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body.token;
const PAT = (await j('POST', '/auth/org/login', { orgId: 'org-mossside', scoutName: 'Pat Doyle', role: 'Head Coach', platform: 'grassroots' })).body.token;
const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
const anaApi = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-ENG', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const conf = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, KOLA);
ok(!!REL && conf.status === 200, 'fixture: Ana represents Kola (employment)');
const txc = await j('POST', '/org/agent/transactions', { type: 'transfer', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }], clientKey: key() }, anaApi.token);
const TX = txc.body?.transaction?.id ?? null;
ok(!!TX, `fixture: a transaction workspace exists for Kola (${txc.status})`);
const roomRes = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, MARIA);
const RID = roomRes.body?.room?.roomId ?? roomRes.body?.existingRoomId;
ok(!!RID, 'fixture: Maria has a Room for Kola');
// A private note and a decision sentinel the player and the agent must never read.
await j('POST', `/org/rooms/${RID}/comments`, { body: S_NOTE }, MARIA);
// A grassroots club may only open a Room for a player inside its radius; the first reachable seed player is used.
let GRID = null; let GPLAYER = null;
for (const pid of ['pl-svensson', 'pl-adeyemi', 'pl-nowak', 'pl-martin', 'pl-carvalho']) {
  const r = await j('POST', '/org/rooms', { playerId: pid, sourceContext: 'search' }, PAT);
  const id = r.body?.room?.roomId ?? r.body?.existingRoomId ?? null;
  if (id) { GRID = id; GPLAYER = pid; break; }
}
ok(!!GRID, `fixture: Pat (Grassroots) has a Room for ${GPLAYER}`);

// ================================================================== R — ROOM (Pro)
console.log('\n— R: the Pro Recruitment Room —');
const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterPortal(ctxLead, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'maria');
await go(lead, `#/recruitment/rooms/${RID}`);
await lead.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
await lead.waitForSelector('[data-casenav="room"]', { timeout: 15000 });
{
  const st = await navState(lead, '[data-casenav="room"]');
  ok(st.cats.filter((c) => c.current).length === 1 && st.cats[0].current && st.tabs.find((t) => t.selected)?.id === 'summary', 'R1: a Room opens on Overview › Summary, with exactly one current category');
  ok(await lead.locator('[data-testid="journey-strip"]').count() === 1, 'R2: the Journey strip stays above the navigation on every page — the lifecycle is the server\'s, the categories are the screen\'s');
  ok((await lead.locator('[data-testid="case-crumb"]').innerText()).includes('Summary'), 'R3: the breadcrumb names the category and the page');
}
await walkCase(lead, '[data-casenav="room"]', 'rm', 'R4 Pro Room', { expectCats: ['overview', 'player', 'evaluation', 'engagement', 'deal', 'history'] });
{
  // Deep links: category/sub, the legacy flat tab, a category alone; a bogus one rejects.
  await go(lead, `#/recruitment/rooms/${RID}/deal/offer`); await lead.reload(); await lead.waitForSelector('#rm-panel-offer', { timeout: 25000 });
  const st = await navState(lead, '[data-casenav="room"]');
  ok(st.cats.find((c) => c.current)?.id === 'deal' && st.tabs.find((t) => t.selected)?.id === 'offer', 'R5: "…/deal/offer" lands on Deal › Offer');
  await go(lead, `#/recruitment/rooms/${RID}/signing`); await lead.reload(); await lead.waitForSelector('#rm-panel-signing', { timeout: 25000 });
  ok((await navState(lead, '[data-casenav="room"]')).cats.find((c) => c.current)?.id === 'deal', 'R6: the legacy "…/signing" link (what a notification carries) still lands on Deal › Signing');
  await go(lead, `#/recruitment/rooms/${RID}/history`); await lead.reload(); await lead.waitForSelector('#rm-panel-timeline', { timeout: 25000 });
  ok(await lead.locator('[data-testid="journey-timeline"]').count() === 1, 'R7: "…/history" opens History › Timeline — the journey timeline, read from the server');
  await go(lead, `#/recruitment/rooms/${RID}/evaluation/offer`); await sleep(700);
  neg(await lead.locator('[aria-label="Room header"]').count() === 0, 'R8: a page under the wrong category is a malformed link and opens no Room');
  // History: the pages are read-only — no form, no primary action.
  await go(lead, `#/recruitment/rooms/${RID}`); await lead.reload(); await lead.waitForSelector('[data-casenav="room"]', { timeout: 25000 });
  for (const sub of ['timeline', 'past-decisions', 'past-trials', 'past-offers', 'past-signings']) {
    await roomTab(lead, sub);
    const forms = await lead.locator(`#rm-panel-${sub} input, #rm-panel-${sub} textarea, #rm-panel-${sub} select, #rm-panel-${sub} button.primary`).count();
    if (forms !== 0) fail(`R9: History › ${sub} carries ${forms} write controls`);
  }
  neg(true, 'R9: every History page is read-only — no input, no select, no primary action (it is never another writer)');
  // Back / forward: opening pushes, a page change replaces.
  await go(lead, '#/rooms'); await sleep(500);
  await go(lead, `#/recruitment/rooms/${RID}`); await lead.waitForSelector('[data-casenav="room"]', { timeout: 25000 });
  await roomTab(lead, 'contact'); await sleep(300);
  ok(/\/engagement\/contact$/.test(await lead.evaluate(() => location.hash)), 'R10: choosing a page writes category/page into the link');
  await lead.goBack(); await sleep(900);
  ok(/#\/rooms$/.test(await lead.evaluate(() => location.hash)), 'R11: Back leaves the Room (a page change replaced its entry rather than stacking one)');
  await lead.goForward(); await sleep(1200);
  await lead.waitForSelector('[data-casenav="room"]', { timeout: 25000 });
  ok(/\/engagement\/contact$/.test(await lead.evaluate(() => location.hash)) && (await navState(lead, '[data-casenav="room"]')).tabs.find((t) => t.selected)?.id === 'contact', 'R12: Forward returns to Engagement › Contact');
  // The journey's next action still opens the page it names (the server names a legacy tab).
  const jn = (await j('GET', `/org/rooms/${RID}/journey`, undefined, MARIA)).body;
  ok(!!jn?.journey?.nextAction?.tab, `R13: the server still names a flat tab for the next action (${jn?.journey?.nextAction?.tab}) — the client resolves it`);
}

// ================================================================== W — WIDTHS (Pro Room)
console.log('\n— W: widths on the Pro Room —');
for (const width of [1440, 1280, 1024, 768, 390, 360]) {
  const phone = width < 500;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const p = await enterPortal(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', `w${width}`);
  await go(p, `#/recruitment/rooms/${RID}/deal/signing`); await p.reload(); await p.waitForSelector('#rm-panel-signing', { timeout: 25000 });
  await sleep(400);
  ok(await noHScroll(p), `W ${width}: no horizontal page scroll with Deal › Signing open`);
  const m = await p.evaluate(() => {
    const cat = document.querySelector('.casenav-cat[aria-current="true"]'); const sub = document.querySelector('.casenav-sub[aria-selected="true"]');
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, right: b.right, h: b.height, w: b.width }; };
    const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
    const cats = [...document.querySelectorAll('.casenav-cat')]; const subs = [...document.querySelectorAll('.casenav-sub')];
    return { cat: r(cat), sub: r(sub), minCatH: Math.min(...cats.map((c) => c.getBoundingClientRect().height)), minSubH: Math.min(...subs.map((c) => c.getBoundingClientRect().height)), minFs: Math.min(...[...cats, ...subs].map(fs)), rowOverflow: document.querySelector('.casenav-cats').scrollWidth > document.querySelector('.casenav-cats').clientWidth + 2, inner: window.innerWidth };
  });
  ok(m.cat.x >= 0 && m.cat.right <= m.inner + 1 && m.sub.x >= 0 && m.sub.right <= m.inner + 1, `W ${width}: the current category and the current page are on screen`);
  ok(m.minFs >= 13, `W ${width}: no label below 13px (${m.minFs}px)`);
  if (phone) ok(m.minCatH >= 44 && m.minSubH >= 44, `W ${width}: every category and page target is at least 44px tall (${Math.round(m.minCatH)}/${Math.round(m.minSubH)})`);
  else ok(!m.rowOverflow, `W ${width}: the category row fits without scrolling`);
  if (phone) {
    // A category at the far end is reachable by scrolling the row, and scrolls into view when chosen.
    await roomTab(p, 'past-signings'); await sleep(400);
    const vis = await p.evaluate(() => { const c = document.querySelector('.casenav-cat[aria-current="true"]').getBoundingClientRect(); const s = document.querySelector('.casenav-sub[aria-selected="true"]').getBoundingClientRect(); return c.x >= -1 && c.right <= window.innerWidth + 1 && s.x >= -1 && s.right <= window.innerWidth + 1; });
    ok(vis && await noHScroll(p), `W ${width}: History › Previous signings (the last page of the last category) is on screen after choosing it, with no page overflow`);
  }
  await ctx.close();
}

// ================================================================== K — KEYBOARD (Pro Room)
console.log('\n— K: keyboard —');
{
  await go(lead, `#/recruitment/rooms/${RID}`); await lead.reload(); await lead.waitForSelector('[data-casenav="room"]', { timeout: 25000 });
  await lead.locator('.casenav-cat[data-cat="overview"]').focus();
  await lead.keyboard.press('ArrowRight'); await sleep(300);
  let st = await navState(lead, '[data-casenav="room"]');
  ok(st.cats.find((c) => c.current)?.id === 'player' && (await lead.evaluate(() => document.activeElement?.getAttribute('data-cat'))) === 'player', 'K1: ArrowRight on the category row moves to the next category and keeps focus on it');
  await lead.keyboard.press('End'); await sleep(300);
  ok((await navState(lead, '[data-casenav="room"]')).cats.find((c) => c.current)?.id === 'history', 'K2: End jumps to the last category');
  await lead.keyboard.press('Home'); await sleep(300);
  await lead.locator('.casenav-sub[data-sub="summary"]').focus();
  await lead.keyboard.press('ArrowRight'); await sleep(300);
  st = await navState(lead, '[data-casenav="room"]');
  ok(st.tabs.find((t) => t.selected)?.id === 'journey' && (await lead.evaluate(() => document.activeElement?.getAttribute('data-sub'))) === 'journey', 'K3: ArrowRight on the page row selects the next page and keeps focus on it');
  await lead.locator('.casenav-sub[data-sub="tasks"]').focus();
  await lead.keyboard.press('Enter'); await sleep(300);
  ok((await navState(lead, '[data-casenav="room"]')).tabs.find((t) => t.selected)?.id === 'tasks', 'K4: Enter activates a focused page');
  await lead.locator('.casenav-sub[data-sub="activity"]').focus();
  await lead.keyboard.press('Space'); await sleep(300);
  ok((await navState(lead, '[data-casenav="room"]')).tabs.find((t) => t.selected)?.id === 'activity', 'K5: Space activates a focused page');
  const ring = await lead.evaluate(() => { const el = document.activeElement; const s = getComputedStyle(el); return s.outlineStyle !== 'none' || s.boxShadow !== 'none'; });
  ok(ring, 'K6: the focused control shows a visible focus indication');
  await lead.locator('.casenav-cat[data-cat="overview"]').focus();
  await lead.keyboard.press('Tab'); await sleep(100);
  const after = await lead.evaluate(() => document.activeElement?.getAttribute('data-cat') ?? document.activeElement?.getAttribute('data-sub'));
  ok(after === 'player' || after === 'summary', `K7: Tab moves through the control in document order (landed on ${after})`);
}

// ================================================================== G — ROOM (Grassroots)
console.log('\n— G: the Grassroots Recruitment Room —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pat = await enterPortal(ctx, PORTS.grassroots, 'Moss Side Athletic', 'Pat Doyle', 'Head Coach', 'pat');
  await go(pat, `#/recruitment/rooms/${GRID}`); await pat.reload();
  await pat.waitForSelector('[data-casenav="room"]', { timeout: 25000 });
  await walkCase(pat, '[data-casenav="room"]', 'rm', 'G1 Grassroots Room', { expectCats: ['overview', 'player-review', 'recruitment', 'agreement', 'history'], forbidden: ['secondlook', 'past-decisions', 'past-signings'] });
  await go(pat, `#/recruitment/rooms/${GRID}/offer`); await pat.reload(); await pat.waitForSelector('#rm-panel-offer', { timeout: 25000 });
  ok((await navState(pat, '[data-casenav="room"]')).cats.find((c) => c.current)?.id === 'agreement', 'G2: the legacy "…/offer" link lands on Agreement › Offer');
  await pat.setViewportSize({ width: 360, height: 780 }); await sleep(400);
  ok(await noHScroll(pat), 'G3: 360px: no horizontal page scroll on the Grassroots Room');
  await ctx.close();
}

// ================================================================== A — AGENT
console.log('\n— A: the agent —');
const ctxAna = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ana = await enterPortal(ctxAna, PORTS.agent, 'North Star', 'Ana Agent', 'Agent', 'ana');
{
  await go(ana, `#/clients/${REL}`); await ana.waitForSelector('[data-casenav="client"]', { timeout: 25000 });
  await walkCase(ana, '[data-casenav="client"]', 'client', 'A1 client', { expectCats: ['overview', 'player', 'recruitment', 'transaction', 'history'], forbidden: ['assessments', 'decision', 'discussion', 'secondlook', 'evidence', 'passport', 'inbox', 'past-decisions'] });
  const txt = await bodyText(ana);
  neg(!txt.includes(S_NOTE) && !txt.includes(S_DEC) && !/Room discussion|Watchlist|Priority prospect/.test(txt), 'A2: no Room note, decision rationale, discussion, watchlist or priority word reaches the agent');
  await go(ana, `#/clients/${REL}/contacts`); await sleep(600);
  ok((await navState(ana, '[data-casenav="client"]')).tabs.find((t) => t.selected)?.id === 'contacts', 'A3: the legacy "…/contacts" link (a notification target) lands on Recruitment › Contact');
  await go(ana, `#/clients/${REL}/offers`); await sleep(600);
  ok((await navState(ana, '[data-casenav="client"]')).cats.find((c) => c.current)?.id === 'transaction', 'A4: "…/offers" lands on Transaction › Offer');
  await go(ana, `#/clients/${REL}/offer`); await sleep(600);
  neg((await ana.locator('[data-testid="client-detail"]').count()) === 0, 'A5: "…/offer" (not a page) is still rejected');
  if (TX) {
    await go(ana, `#/transactions/${TX}`); await ana.waitForSelector('[data-casenav="transaction"]', { timeout: 25000 });
    await walkCase(ana, '[data-casenav="transaction"]', 'tx', 'A6 transaction', { expectCats: ['workspace', 'records'], forbidden: ['offer', 'signing', 'fees'] });
    await go(ana, `#/transactions/${TX}/documents`); await sleep(600);
    ok((await navState(ana, '[data-casenav="transaction"]')).cats.find((c) => c.current)?.id === 'records' && (await ana.locator('[data-testid="tx-panel-documents"]').count()) === 1, 'A7: "…/documents" lands on Records › Documents');
    await go(ana, `#/transactions/${TX}/offer`); await sleep(600);
    neg((await ana.locator('[data-testid="transaction-detail"]').count()) === 0, 'A8: "…/offer" on a transaction is still rejected');
  }
  // Phone width: the client's navigation fits.
  await ana.setViewportSize({ width: 390, height: 844 }); await go(ana, `#/clients/${REL}`); await ana.waitForSelector('[data-casenav="client"]', { timeout: 25000 }); await sleep(400);
  ok(await noHScroll(ana), 'A9: 390px: the client detail has no horizontal page scroll');
  await clientTab(ana, 'past-signings'); await sleep(300);
  ok(await noHScroll(ana) && await ana.evaluate(() => { const c = document.querySelector('.casenav-cat[aria-current="true"]').getBoundingClientRect(); return c.x >= -1 && c.right <= window.innerWidth + 1; }), 'A10: 390px: the last category scrolls into view when chosen');
  await ana.setViewportSize({ width: 1280, height: 900 });
}

// ================================================================== P — PLAYER
console.log('\n— P: the player —');
for (const width of [390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 780 }, isMobile: true, hasTouch: true });
  const kola = await enterPlayer(ctx, 'Kola Adeyemi', `kola${width}`);
  await playerCategory(kola, 'journey');
  const cats = await kola.evaluate(() => [...document.querySelectorAll('[data-testid^="cat-"]')].map((e) => e.getAttribute('data-testid').slice(4)));
  ok(cats.join(',') === 'journey,contact,trial,offer,signing,board', `P1 ${width}: categories My journey · Club contact · Trial · Offer · Signing · Board`);
  const PAGES = { journey: ['Overview', 'Current stage', 'Tasks', 'Activity'], contact: ['Messages', 'Contact'], trial: ['Invitation', 'Schedule', 'Details'], offer: ['Offer', 'Documents', 'Response'], signing: ['Signing', 'Documents', 'Contract'], board: ['Open roles', 'Fit check', 'Squad invites', 'Follow-ups'] };
  let visited = 0;
  for (const cat of cats) {
    await playerCategory(kola, cat);
    const tabs = await playerTabs(kola).getByRole('tab').allInnerTexts();
    if (tabs.length > 5) fail(`P2 ${width}: ${cat} shows ${tabs.length} pages`);
    if (tabs.join(',') !== PAGES[cat].join(',')) fail(`P2 ${width}: ${cat} pages are ${tabs.join(',')}`);
    for (const label of PAGES[cat]) {
      await playerSub(kola, label);
      const selected = await playerTabs(kola).getByRole('tab', { selected: true }).allInnerTexts();
      if (selected.join() !== label) fail(`P2 ${width}: ${cat}/${label}: selected is ${selected}`);
      const catSel = await kola.evaluate((c) => document.querySelector(`[data-testid="cat-${c}"]`)?.getAttribute('aria-selected'), cat);
      if (catSel !== 'true') fail(`P2 ${width}: ${cat} is not marked selected`);
      const body = await bodyText(kola);
      if (CLUB_WORDS.test(body.replace(/Trial · Details|Current stage/g, ''))) fail(`P2 ${width}: ${cat}/${label} carries a club word`);
      if (body.includes(S_NOTE) || body.includes(S_DEC)) fail(`P2 ${width}: ${cat}/${label} carries a private sentinel`);
      if (!(await noHScroll(kola))) fail(`P2 ${width}: ${cat}/${label} overflows`);
      const onScreen = await kola.evaluate((c) => { const el = document.querySelector(`[data-testid="cat-${c}"]`); const b = el.getBoundingClientRect(); return b.x >= -1 && b.right <= window.innerWidth + 1; }, cat);
      if (!onScreen) fail(`P2 ${width}: ${cat} pill is off screen while current`);
      visited++;
    }
  }
  say(`P2 ${width}: every category and page rendered, the current pill on screen, no page overflow, no club-private word (${visited} pages)`);
  const targets = await kola.evaluate(() => { const els = [...document.querySelectorAll('[data-testid^="cat-"], [data-testid="case-categories"] + [role="tablist"] [role="tab"]')]; return Math.min(...els.map((e) => e.getBoundingClientRect().height)); });
  ok(targets >= 44, `P3 ${width}: category pills and page tabs are at least 44px tall (${Math.round(targets)}px)`);
  // Deep link with the query the notification bell writes.
  await kola.goto(`http://localhost:${PORTS.player}/opportunities?cat=signing&tab=signing-contract`);
  await kola.waitForSelector('[data-testid="case-panel-signing-contract"]', { timeout: 30000 });
  ok((await playerTabs(kola).getByRole('tab', { selected: true }).allInnerTexts()).join() === 'Contract', `P4 ${width}: "?cat=signing&tab=signing-contract" lands on Signing › Contract`);
  await ctx.close();
}

ok(errors.length === 0, `no page errors in any app (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nM24B CASE NAV LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
cleanup();
process.exit(0);
