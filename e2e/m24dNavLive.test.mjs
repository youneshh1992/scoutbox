// M24D LIVE — the sidebar's collapse behaviour, driven through the real Pro
// and Grassroots interfaces against a real server.
//
//   C1  initial state      Home: nothing expanded; opening Recruitment shows
//                          its groups with ONE group open (Discover, 4 pages)
//   C2  active group       a deep link expands the group that holds the page
//                          (Evaluation › Assessments) and nothing else
//   C3  expand another     opening Intelligence folds Evaluation; the current
//                          page's group stays marked
//   C4  collapse           folding the open group leaves every group folded;
//                          the current section still says where you are
//   C5  deep link          Pipeline › Rooms by its pretty hash
//   C6  back / forward     the open group follows the history
//   C7  refresh            the open group survives a reload
//   C8  keyboard           a group heading is a button: Enter / Space toggle,
//                          aria-expanded and aria-controls are right
//   C9  phone drawer       the same accordion at 390px, ≥32px targets
//   C10 depth              section → group → page, never deeper
//   C11 the five rule      at 1440 / 1024 / 390 the sidebar never lists more
//                          than five pages, in Pro and in Grassroots
//   zero page errors

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4061;
const API = `http://localhost:${API_PORT}`;
const PORTS = { club: 8761, grassroots: 8762 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24dnav-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (c, m) => (c ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24dn';
const bundles = [['scoutbox-club', PORTS.club], ['scoutbox-grassroots', PORTS.grassroots]];
if (KEEP && bundles.every(([app]) => fs.existsSync(path.join(ROOT, app, DIST, 'index.html')))) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  for (const [app] of bundles) execSync(`VITE_API_URL=${API} npx vite build --outDir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
}
const serverProc = spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
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

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
async function enter(ctx, port, org, name, role, who) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${who}: ${e}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button.primary');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  await sleep(600);
  return page;
}
const goHash = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await sleep(350); };
const title = async (p) => (await p.locator('.topbar h1.page-title').innerText()).replace(/\s+/g, ' ').trim();
// The sidebar's state, read from the DOM the way a screen reader would.
const state = (p) => p.evaluate(() => {
  const sections = [...document.querySelectorAll('nav.sidebar .nav-sec')].map((s) => {
    const btn = s.querySelector('button.nav-section');
    const groups = [...s.querySelectorAll('.nav-group')].map((g) => {
      const h = g.querySelector('button.nav-group-label');
      return { label: g.getAttribute('aria-label'), open: h ? h.getAttribute('aria-expanded') === 'true' : null, hasActive: g.classList.contains('has-active'), controls: h?.getAttribute('aria-controls') ?? null, panelRendered: h ? !!document.getElementById(h.getAttribute('aria-controls') ?? '') : null, pages: [...g.querySelectorAll('.nav-child')].map((c) => c.textContent.trim()), tag: h?.tagName ?? null };
    });
    return { label: btn?.getAttribute('aria-label'), open: s.classList.contains('open'), active: btn?.classList.contains('active') ?? false, groups, visiblePages: s.querySelectorAll('.nav-child').length };
  });
  return { sections, visiblePages: document.querySelectorAll('nav.sidebar .nav-child').length, openSections: sections.filter((s) => s.open).length, active: document.querySelector('nav.sidebar .nav-child.active')?.textContent.trim() ?? null, depth: document.querySelectorAll('nav.sidebar .nav-group .nav-group').length };
});
const rec = (st) => st.sections.find((s) => s.label === 'Recruitment');
const openGroups = (sec) => sec.groups.filter((g) => g.open).map((g) => g.label);

// ================================================================== Pro
console.log('\n— Pro —');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p = await enter(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'pro');
{
  let st = await state(p);
  ok(st.visiblePages === 0 && st.openSections <= 1, `C1: on Home nothing lists pages (${st.visiblePages} visible, ${st.openSections} section open)`);
  await p.click('nav.sidebar button.nav-section:has-text("Recruitment")'); await sleep(400);
  st = await state(p);
  const r = rec(st);
  ok(r.open && r.groups.length === 7 && r.groups.every((g) => g.tag === 'BUTTON'), `C1: Recruitment opens with seven group headings, each a button (${r.groups.map((g) => g.label).join(' · ')})`);
  ok(openGroups(r).join() === 'Discover' && r.visiblePages === 4 && st.visiblePages === 4 && st.active === 'Players', `C1: Discover alone is open with its four pages, Players active (${st.visiblePages} visible pages)`);
  ok(r.groups.filter((g) => !g.open).every((g) => g.pages.length === 0 && !g.panelRendered), 'C1: a folded group renders no page and no panel (aria-controls names nothing that exists)');
  ok(r.groups.filter((g) => g.open).every((g) => g.panelRendered && g.controls), 'C1: the open group\'s heading controls a rendered panel');
}
{
  await goHash(p, '#/assessments');
  const st = await state(p); const r = rec(st);
  ok((await title(p)) === 'Recruitment / Assessments' && st.active === 'Assessments', 'C2: deep link lands on Assessments');
  ok(openGroups(r).join() === 'Evaluation' && r.groups.find((g) => g.label === 'Evaluation').hasActive && st.openSections === 1, 'C2: Evaluation is the one open group (marked as holding the current page) and Recruitment the one open section');
  ok(st.visiblePages === 4 && r.groups.find((g) => g.label === 'Evaluation').pages.join('|') === 'Assessments|Evidence & Video|Trials & Reports|Trial Days', `C2: Evaluation lists Assessments · Evidence & Video · Trials & Reports · Trial Days (${st.visiblePages} visible)`);
}
{
  await p.click('nav.sidebar .nav-group[aria-label="Intelligence"] > button.nav-group-label'); await sleep(250);
  let st = await state(p); let r = rec(st);
  ok(openGroups(r).join() === 'Intelligence' && !r.groups.find((g) => g.label === 'Evaluation').open, 'C3: opening Intelligence folds Evaluation — one group at a time');
  ok(r.groups.find((g) => g.label === 'Evaluation').hasActive && r.active && (await title(p)) === 'Recruitment / Assessments', 'C3: the current page is unchanged and its folded group stays marked as holding it');
  ok(r.groups.find((g) => g.label === 'Intelligence').pages.join('|') === 'Player Matching|Dynamic Watchlists|Second Look|Nobody Missed' && st.visiblePages === 4, 'C3: Intelligence lists its four pages');
  await p.click('nav.sidebar .nav-group[aria-label="Intelligence"] > button.nav-group-label'); await sleep(250);
  st = await state(p); r = rec(st);
  ok(openGroups(r).length === 0 && st.visiblePages === 0 && r.active && r.groups.find((g) => g.label === 'Evaluation').hasActive, 'C4: folding the open group leaves every group folded; Recruitment stays the active section and Evaluation stays marked');
  await p.click('nav.sidebar .nav-group[aria-label="Evaluation"] > button.nav-group-label'); await sleep(250);
  st = await state(p);
  ok(st.active === 'Assessments' && openGroups(rec(st)).join() === 'Evaluation', 'C4: reopening Evaluation shows Assessments active again');
}
{
  await goHash(p, '#/recruitment/rooms');
  let st = await state(p);
  ok((await title(p)) === 'Recruitment / Recruitment Rooms' && openGroups(rec(st)).join() === 'Pipeline' && st.active === 'Recruitment Rooms', 'C5: "#/recruitment/rooms" opens Pipeline with Rooms active');
  await goHash(p, '#/recruitment/matching');
  st = await state(p);
  ok(openGroups(rec(st)).join() === 'Intelligence' && st.active === 'Player Matching', 'C5: "#/recruitment/matching" opens Intelligence with Matching active');
  await p.goBack(); await sleep(400);
  st = await state(p);
  ok((await title(p)) === 'Recruitment / Recruitment Rooms' && openGroups(rec(st)).join() === 'Pipeline' && st.active === 'Recruitment Rooms', 'C6: Back → Rooms, Pipeline open');
  await p.goBack(); await sleep(400);
  st = await state(p);
  ok(st.active === 'Assessments' && openGroups(rec(st)).join() === 'Evaluation', 'C6: Back → Assessments, Evaluation open');
  await p.goForward(); await sleep(400); await p.goForward(); await sleep(400);
  st = await state(p);
  ok(st.active === 'Player Matching' && openGroups(rec(st)).join() === 'Intelligence', 'C6: Forward twice → Matching, Intelligence open');
  await p.reload(); await p.waitForSelector('nav.sidebar', { timeout: 20000 }); await sleep(700);
  st = await state(p);
  ok(st.active === 'Player Matching' && openGroups(rec(st)).join() === 'Intelligence' && st.openSections === 1 && st.visiblePages === 4, 'C7: refresh keeps Matching active, Intelligence the one open group, Recruitment the one open section');
}
{
  // Keyboard: focus the Outcomes heading, Enter opens, Space closes.
  const heading = p.locator('nav.sidebar .nav-group[aria-label="Outcomes"] > button.nav-group-label');
  await heading.focus();
  const focused = await p.evaluate(() => ({ tag: document.activeElement?.tagName, expanded: document.activeElement?.getAttribute('aria-expanded'), outline: getComputedStyle(document.activeElement).outlineStyle }));
  ok(focused.tag === 'BUTTON' && focused.expanded === 'false', 'C8: a group heading takes keyboard focus and announces aria-expanded=false');
  await p.keyboard.press('Enter'); await sleep(250);
  let st = await state(p);
  ok(openGroups(rec(st)).join() === 'Outcomes' && rec(st).groups.find((g) => g.label === 'Outcomes').pages.join() === 'Signings & Outcomes', 'C8: Enter opens the group (Intelligence folds); Outcomes lists Signings & Outcomes');
  const panel = await heading.getAttribute('aria-controls');
  ok(!!panel && (await p.locator(`#${panel} .nav-child`).count()) === 1, 'C8: aria-controls names the rendered page list');
  await p.keyboard.press('Space'); await sleep(250);
  st = await state(p);
  ok(openGroups(rec(st)).length === 0 && (await heading.getAttribute('aria-expanded')) === 'false', 'C8: Space folds it again');
  await p.keyboard.press('Tab');
  const next = await p.evaluate(() => document.activeElement?.textContent.trim());
  ok(next === 'Analytics', `C8: Tab moves to the next heading (${next})`);
  await p.keyboard.press('Enter'); await sleep(250);
  await p.keyboard.press('Tab');
  const page1 = await p.evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent.trim() }));
  ok(/nav-child/.test(page1.cls) && page1.text === 'Director Dashboard', `C8: Tab from an open heading enters its pages (${page1.text})`);
  await p.keyboard.press('Enter'); await sleep(400);
  ok((await title(p)) === 'Recruitment / Director Dashboard', 'C8: Enter on a page navigates');
  const tree = await state(p);
  ok(tree.depth === 0 && tree.sections.every((s) => s.groups.every((g) => g.pages.every((x) => x.length > 0))), 'C10: section → group → page is the whole depth — no group inside a group');
}
{
  // Phone drawer.
  await p.setViewportSize({ width: 390, height: 844 }); await sleep(400);
  await goHash(p, '#/feed');
  await p.click('button.nav-hamburger'); await sleep(350);
  await p.click('nav.sidebar button.nav-section:has-text("Recruitment")'); await sleep(350);
  let st = await state(p); let r = rec(st);
  ok((await p.locator('nav.sidebar.drawer-open').count()) === 1 && r.open && openGroups(r).join() === 'Discover' && st.visiblePages === 4, 'C9: in the drawer Recruitment expands with Discover open and four pages');
  const hb = await p.locator('nav.sidebar .nav-group[aria-label="Pipeline"] > button.nav-group-label').boundingBox();
  ok(hb && hb.height >= 32, `C9: a group heading is a ${Math.round(hb?.height ?? 0)}px tap target`);
  await p.click('nav.sidebar .nav-group[aria-label="Pipeline"] > button.nav-group-label'); await sleep(250);
  st = await state(p); r = rec(st);
  ok(openGroups(r).join() === 'Pipeline' && st.visiblePages === 4 && (await p.locator('nav.sidebar.drawer-open').count()) === 1, 'C9: tapping Pipeline opens it (Discover folds) and the drawer stays open');
  await p.click('nav.sidebar .nav-sec.open .nav-child:text-is("Player Requests")'); await sleep(400);
  ok((await p.locator('nav.sidebar.drawer-open').count()) === 0 && (await title(p)) === 'Recruitment / Player Requests', 'C9: tapping a page navigates and closes the drawer');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'C9: no horizontal overflow at 390px');
}
{
  // The five rule, three widths, every section a lead can open.
  const ALL = ['feed', 'search', 'rooms', 'briefs', 'assessments', 'matching', 'outcomes', 'dashboard', 'planner', 'network', 'organisation', 'imports'];
  for (const w of [1440, 1024, 390]) {
    await p.setViewportSize({ width: w, height: w < 500 ? 844 : 900 }); await sleep(300);
    let worst = 0;
    for (const id of ALL) {
      await goHash(p, `#/${id}`);
      if (w < 500) { await p.click('button.nav-hamburger').catch(() => {}); await sleep(250); }
      const st = await state(p);
      worst = Math.max(worst, st.visiblePages);
      if (st.visiblePages > 5) fail(`C11 ${w}px: ${id}: ${st.visiblePages} pages listed`);
      if (st.openSections > 1) fail(`C11 ${w}px: ${id}: ${st.openSections} sections open`);
      if (w < 500) { await p.keyboard.press('Escape'); await p.click('.nav-drawer-veil').catch(() => {}); await sleep(150); }
    }
    say(`C11 ${w}px: across ${ALL.length} pages the sidebar never lists more than five pages (max ${worst}) and never opens two sections`);
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  await goHash(p, '#/organisation');
  const st = await state(p);
  const org = st.sections.find((s) => s.label === 'Organisation');
  ok(org && org.groups.length === 2 && openGroups(org).join() === 'Administration' && org.visiblePages === 3, 'C11: Organisation (six pages for a lead) is Administration · Operations, three pages each, one open');
}
await ctx.close();

// ============================================================ Grassroots
console.log('\n— Grassroots —');
{
  const gctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const g = await enter(gctx, PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', 'grassroots').catch(async () => {
    const page = await gctx.newPage(); page.on('pageerror', (e) => errors.push(`grassroots: ${e}`));
    await page.goto(`http://localhost:${PORTS.grassroots}/`); await page.waitForSelector('.org-card', { timeout: 25000 });
    await page.locator('.org-card').first().click(); await page.fill('.enter-row input', 'Sam Tully'); await page.click('button.primary');
    await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(600); return page;
  });
  await goHash(g, '#/opendays');
  let st = await state(g); let r = rec(st);
  ok(r && r.groups.length === 8 && openGroups(r).join() === 'Outreach' && st.active === 'Open Days' && st.visiblePages === 3, `G1: Grassroots Recruitment has eight groups; a deep link to Open Days opens Outreach alone (${st.visiblePages} pages: ${r.groups.find((x) => x.label === 'Outreach').pages.join(' · ')})`);
  await g.click('nav.sidebar .nav-group[aria-label="Planning"] > button.nav-group-label'); await sleep(250);
  st = await state(g); r = rec(st);
  ok(openGroups(r).join() === 'Planning' && r.groups.find((x) => x.label === 'Planning').pages.join('|') === 'Coverage|Calibration' && r.groups.find((x) => x.label === 'Outreach').hasActive, 'G2: Planning opens (Coverage · Calibration), Outreach folds and stays marked');
  for (const id of ['feed', 'squad', 'search', 'rooms', 'trials', 'matching', 'ledger', 'network']) {
    await goHash(g, `#/${id}`);
    const s = await state(g);
    if (s.visiblePages > 5 || s.openSections > 1) fail(`G3: ${id}: ${s.visiblePages} pages, ${s.openSections} sections open`);
  }
  say('G3: across eight Grassroots pages the sidebar never lists more than five pages');
  await gctx.close();
}

ok(errors.length === 0, `no page errors in any context (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nm24dNavLive: ${passed} checks passed`);
process.exit(0);
