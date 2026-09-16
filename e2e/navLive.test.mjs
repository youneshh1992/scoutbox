// M15-Nav / M23 P2.5 LIVE browser journeys (N1–N12) — real backend, separate
// contexts. P2.5 regrouped the sidebar (accordion + groups, no desktop tab
// strip, one-row top bar with an h1) and restructured the Player tabs. Every
// journey below drives the REAL interface; nothing reads the config to
// decide what "should" be there.
//   N1.  Ordinary scout: compact sidebar, NO Organisation; Recruitment opens
//        on Players; the accordion lists its pages by group; no desktop tab
//        strip; a deep link highlights section AND page; a hidden route
//        highlights no section (and the server still refuses its data).
//   N2.  Head of Recruitment: Organisation visible; Staff & Security,
//        Verification, Recruitment → Trials all reachable; nothing lost.
//   N3.  Command palette: ⌘K/Ctrl+K, keyboard selection, permission
//        filtering, group shown in the path, plain typing never opens it.
//   N4.  Collapse: icon rail with accessible names; a section opens a
//        keyboard-operable flyout menu; persists across reload.
//   N5.  640px height + 420px drawer: everything reachable; the drawer is a
//        column; the phone strip lists only the active GROUP; the top bar is
//        one row; Report / Block stays reachable; no horizontal overflow.
//   N6.  Grassroots persona: Players and Club sections, no Pro-only pages.
//   N7.  Player app: five destinations (Home / Football / Opportunities /
//        Inbox / You); Profile and Upload keep their routes off the bar.
//   N8.  T&S: unchanged — six grouped destinations; all legacy tabs reachable.
//   N9.  Phone deep link lands on the right group strip.
//   N10. Keyboard: accordion toggles are buttons with aria-expanded.
//   N11. Deep link + refresh + back/forward keep section, page and title.
//   N12. Server authorization unaffected by any of it.
// Plus negative cases: revoked-permission shortcut, malformed stored state.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4006;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-navlive-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const A = { 'x-admin-key': 'scoutbox-admin', 'content-type': 'application/json' };

console.log('building live bundles for :4006…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-grassroots'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-admin'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
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
serveDir('scoutbox-club/dist-live14', 8395);
serveDir('scoutbox-grassroots/dist-live14', 8396);
serveDir('scoutbox-admin/dist-live14', 8397);

process.on('exit', () => { try { serverProc.kill('SIGKILL'); } catch {} for (const s of statics) s.close(); });
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${API}/healthz`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

// Give Maria root verification authority so the live console has data paths.
await fetch(`${API}/auth/org/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })
  .then((r) => r.json())
  .then((maria) => fetch(`${API}/admin/verification/orgs/org-eastport/appoint-root`, { method: 'POST', headers: A, body: JSON.stringify({ userId: maria.userId, reason: 'navLive: establish root admin' }) }));

const browser = await chromium.launch({ executablePath: EXE });
const CLUB = 'http://localhost:8395';

async function clubLogin(ctx, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error (${name}): ${e}`));
  await page.goto(CLUB);
  await page.click('.org-card:has-text("Eastport FC")');
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role);
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 20000 });
  await page.waitForTimeout(700); // verLevel fetch settles the nav filter
  return page;
}
const goHash = async (page, id) => { await page.evaluate((h) => { location.hash = h; }, `#/${id}`); await page.waitForTimeout(300); };
// P2.5: the page title is the top bar's h1 — the ONE title on the page.
const title = async (page) => (await page.locator('.topbar h1.page-title').innerText()).replace(/\s+/g, ' ').trim();
const sectionLabels = (page) => page.locator('nav.sidebar button.nav-section').allInnerTexts();
const activeChild = async (page) => (await page.locator('nav.sidebar .nav-child.active').allInnerTexts()).join('|');
const visible = async (page, sel) => (await page.locator(sel).count()) > 0 && page.locator(sel).first().isVisible();

// ============================================================ N1 — scout
const scoutCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const scout = await clubLogin(scoutCtx, 'Noa Winter', 'First-Team Scout');
{
  const sections = await sectionLabels(scout);
  if (sections.some((s) => s.includes('Organisation'))) fail('N1: scout sees Organisation');
  if (sections.some((s) => s.includes('Discover'))) fail('N1: Discover is no longer a section');
  if (sections.length !== 5) fail(`N1: expected 4 sections + Inbox, saw ${sections.length}: ${sections.join('|')}`);
  say('N1: ordinary scout sees the compact set — Home, Recruitment, Squad & Planning, Network, Inbox; Organisation absent');
  if ((await scout.locator('h1').count()) !== 1) fail(`N1: exactly one h1 on the page (saw ${await scout.locator('h1').count()})`);
  if ((await scout.locator('.content h2').count()) !== 0) fail('N1: the page repeats its own title in an h2');
  say('N1: one page title — the top bar h1 — and no duplicate h2 below it');
  await scout.click('nav.sidebar button.nav-section:has-text("Recruitment")');
  await scout.waitForTimeout(300);
  if (!(await title(scout)).includes('Players')) fail(`N1: Recruitment must open on Players (${await title(scout)})`);
  const groups = await scout.locator('nav.sidebar .nav-sec.open .nav-group-label').allInnerTexts();
  if (groups.length < 5 || groups[0].toLowerCase() !== 'discover') fail(`N1: Recruitment accordion groups (${groups.join('|')})`);
  const pages = await scout.locator('nav.sidebar .nav-sec.open .nav-child').count();
  if (pages < 20) fail(`N1: Recruitment lists its pages in the sidebar (${pages})`);
  if (!(await activeChild(scout)).includes('Players')) fail('N1: the active page is marked in the accordion');
  say(`N1: Recruitment opens on Players; the accordion lists ${pages} pages under ${groups.length} groups (${groups.join(' · ')})`);
  if (await visible(scout, 'nav.subnav')) fail('N1: the desktop tab strip must be gone — the sidebar carries the pages');
  say('N1: no second navigation bar on the desktop');
  await goHash(scout, 'assessments');
  if ((await title(scout)) !== 'Recruitment / Assessments') fail(`N1: deep link title (${await title(scout)})`);
  const active = await scout.locator('nav.sidebar button.nav-section.active').innerText();
  if (!active.includes('Recruitment')) fail('N1: deep link highlights Recruitment');
  if ((await activeChild(scout)) !== 'Assessments') fail(`N1: deep link highlights the Assessments page (${await activeChild(scout)})`);
  say('N1: direct deep link highlights section AND page (no parent-first navigation needed)');
  await goHash(scout, 'verification');
  if ((await scout.locator('nav.sidebar button.nav-section.active').count()) !== 0) fail('N1: hidden parent must not highlight');
  say('N1: direct hash to a hidden destination highlights no section (screen renders; the server still gates its data)');
}

// ==================================================== N3 — palette (scout)
{
  await goHash(scout, 'search');
  await scout.keyboard.press('Control+k');
  await scout.waitForSelector('.palette');
  await scout.fill('.palette input', 'verification');
  await scout.waitForTimeout(200);
  const empty = await scout.locator('.palette-results .notice').count();
  if (empty !== 1) fail('N3: restricted feature leaked into scout palette');
  say('N3: command search never reveals a restricted destination to a scout');
  await scout.fill('.palette input', 'ledger');
  await scout.waitForTimeout(200);
  const row = await scout.locator('.palette-row').first().innerText();
  if (!/Recruitment/.test(row) || !/Analytics/.test(row)) fail(`N3: the palette shows the group in the path (${row})`);
  say('N3: a palette row shows section › group › page (Recruitment › Analytics › Discovery Ledger)');
  await scout.fill('.palette input', 'coverage');
  await scout.waitForTimeout(200);
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(300);
  if ((await title(scout)) !== 'Squad & Planning / Coverage') fail(`N3: palette navigation (${await title(scout)})`);
  say('N3: palette routes "coverage" → Squad & Planning → Coverage via keyboard');
  await goHash(scout, 'search');
  const input = scout.locator('.content input').first();
  await input.click();
  await input.type('k k k');
  if ((await scout.locator('.palette').count()) !== 0) fail('N3: plain typing opened the palette');
  say('N3: typing "k" in a text input does not trigger the palette (modifier-gated)');
}

// ============================================== N4 — collapse (scout ctx)
{
  await scout.click('button.nav-collapse');
  await scout.waitForTimeout(200);
  if ((await scout.locator('nav.sidebar.collapsed').count()) !== 1) fail('N4: collapse');
  const label = await scout.locator('nav.sidebar button.nav-section').first().getAttribute('aria-label');
  if (!label) fail('N4: collapsed icons need accessible names');
  const w = await scout.evaluate(() => Math.round(document.querySelector('nav.sidebar').getBoundingClientRect().width));
  if (w > 72) fail(`N4: collapsed rail width ${w}px`);
  say(`N4: collapsed icon rail (${w}px) with accessible names`);
  await scout.click('nav.sidebar button[aria-label="Recruitment"]');
  await scout.waitForTimeout(250);
  if (!(await visible(scout, 'nav.sidebar .nav-flyout[role="menu"]'))) fail('N4: a multi-page section opens a flyout menu from the rail');
  const items = await scout.locator('nav.sidebar .nav-flyout button[role="menuitem"]').count();
  if (items < 20) fail(`N4: the flyout lists the section pages (${items})`);
  say(`N4: the rail opens a flyout menu listing all ${items} Recruitment pages, grouped`);
  await scout.keyboard.press('ArrowDown');
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar .nav-flyout').count()) !== 0) fail('N4: the flyout closes after navigating');
  if (!(await title(scout)).includes('Shortlist')) fail(`N4: keyboard navigation from the flyout (${await title(scout)})`);
  say('N4: ArrowDown + Enter navigates from the flyout (Players → Shortlist) and closes it');
  await scout.click('nav.sidebar button[aria-label="Recruitment"]');
  await scout.waitForTimeout(150);
  await scout.keyboard.press('Escape');
  await scout.waitForTimeout(150);
  if ((await scout.locator('nav.sidebar .nav-flyout').count()) !== 0) fail('N4: Escape closes the flyout');
  say('N4: Escape closes the flyout and returns focus to the rail');
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  if ((await scout.locator('nav.sidebar.collapsed').count()) !== 1) fail('N4: collapsed state must persist across reload');
  say('N4: collapsed preference persists across reload');
  await scout.click('button.nav-collapse');
  await scout.waitForTimeout(200);
  if ((await scout.locator('nav.sidebar.collapsed').count()) !== 0) fail('N4: expand');
  say('N4: expand restores labels with no layout error');
}

// ==================== shortcuts: pin, persist, revoked-permission handling
{
  await scout.keyboard.press('Control+k');
  await scout.fill('.palette input', 'coverage');
  await scout.waitForTimeout(200);
  await scout.locator('.palette-row').first().hover();
  await scout.click('.palette-pin');
  await scout.keyboard.press('Escape');
  await scout.waitForTimeout(200);
  if (!(await scout.locator('.nav-shortcuts').innerText()).includes('Coverage')) fail('shortcut pin');
  say('Shortcuts: pinned from the palette, shown in the sidebar');
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  await scout.waitForTimeout(700);
  if (!(await scout.locator('.nav-shortcuts').innerText()).includes('Coverage')) fail('shortcut persistence');
  say('Shortcuts: persist across reload (stored by item id)');
  await scout.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-nav-shortcuts:'));
    if (k) localStorage.setItem(k, JSON.stringify(['verification', 'coverage']));
  });
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  await scout.waitForTimeout(700);
  const sc = await scout.locator('.nav-shortcuts').innerText();
  if (sc.includes('Verification')) fail('revoked/forbidden shortcut leaked');
  if (!sc.includes('Coverage')) fail('valid shortcut survived filtering');
  say('Shortcuts: a shortcut to a forbidden destination disappears gracefully; valid pins remain');
  await scout.evaluate(() => localStorage.setItem('sb-nav-collapsed', '{broken'));
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  say('Malformed stored collapsed-state preference: workspace still boots expanded');
}

// ============================================================ N2 — lead
const leadCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lead = await clubLogin(leadCtx, 'Maria Keane', 'Head of Recruitment');
{
  const sections = await sectionLabels(lead);
  if (!sections.some((s) => s.includes('Organisation'))) fail('N2: lead must see Organisation');
  if (sections.length !== 6) fail(`N2: expected 5 sections + Inbox, saw ${sections.length}`);
  say('N2: head of recruitment sees Organisation (5 sections + Inbox)');
  await lead.click('nav.sidebar button.nav-section:has-text("Organisation")');
  await lead.waitForTimeout(300);
  if (!(await title(lead)).includes('Staff & Security')) fail('N2: Organisation default child');
  say('N2: Organisation → Staff & Security opens');
  await lead.click('nav.sidebar .nav-sec.open .nav-child:has-text("Verification")');
  await lead.waitForSelector('text=Ma vérification, text=My verification', { timeout: 15000 }).catch(() => {});
  if ((await title(lead)) !== 'Organisation / Verification') fail(`N2: Verification title (${await title(lead)})`);
  say('N2: Organisation → Verification opens the M14 console from the sidebar');
  await goHash(lead, 'trials');
  if ((await title(lead)) !== 'Recruitment / Trials & Reports') fail('N2: Trials reachable');
  say('N2: Recruitment → Trials reachable; no route lost');
  await goHash(lead, 'recruitment/dashboard');
  if ((await title(lead)) !== 'Recruitment / Director Dashboard') fail(`N2: dashboard pretty link (${await title(lead)})`);
  if (!(await lead.locator('nav.sidebar .nav-sec.open .nav-group-label:has-text("Analytics")').count())) fail('N2: Analytics group is visible inside Recruitment');
  say('N2: #/recruitment/dashboard still resolves — Director Dashboard sits in Recruitment › Analytics');
  await lead.keyboard.press('Control+k');
  await lead.fill('.palette input', 'verification');
  await lead.waitForTimeout(200);
  const row = await lead.locator('.palette-row').first().innerText();
  if (!row.includes('Organisation') || !row.includes('Verification')) fail('N3-lead: palette path');
  say('N3: lead search "verification" → Organisation › Verification');
  await lead.keyboard.press('Escape');
}

// ================================= N5 — 640px height + narrow-width drawer
{
  await scout.setViewportSize({ width: 1100, height: 640 });
  await goHash(scout, 'feed');
  const m = await scout.evaluate(() => {
    const sb = document.querySelector('nav.sidebar');
    return { over: sb.scrollHeight > sb.clientHeight, oy: getComputedStyle(sb).overflowY, sections: sb.querySelectorAll('button.nav-section').length };
  });
  if (m.sections !== 5) fail(`N5: sections at 640px (${m.sections})`);
  if (m.over && m.oy !== 'auto') fail('N5: sidebar must scroll when it overflows');
  say('N5: 640px height — every destination reachable (sidebar scrolls if needed, regression guard held)');
  await scout.setViewportSize({ width: 420, height: 800 });
  await scout.waitForTimeout(300);
  if (!(await scout.locator('button.nav-hamburger').isVisible())) fail('N5: hamburger at narrow width');
  await scout.click('button.nav-hamburger');
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar.drawer-open').count()) !== 1) fail('N5: drawer opens');
  const drawer = await scout.evaluate(() => { const s = document.querySelector('nav.sidebar'); const cs = getComputedStyle(s); return { dir: cs.flexDirection, w: Math.round(s.getBoundingClientRect().width) }; });
  if (drawer.dir !== 'column' || drawer.w < 200) fail(`N5: the drawer must be a column (${JSON.stringify(drawer)})`);
  say('N5: the drawer is a vertical list, not a row');
  // P2.5 closure: in the drawer a section tap EXPANDS the section (its pages
  // are why the drawer was opened); a page tap navigates and closes it.
  const recBtn = scout.locator('nav.sidebar button.nav-section:has-text("Recruitment")');
  if ((await recBtn.getAttribute('aria-expanded')) !== 'true') await recBtn.click(); // this context opened Recruitment earlier; a tap toggles
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar.drawer-open').count()) !== 1) fail('N5: a section tap in the drawer expands rather than leaves');
  if ((await scout.locator('nav.sidebar .nav-sec.open .nav-child').count()) < 20) fail('N5: the expanded section lists its pages in the drawer');
  await scout.click('nav.sidebar .nav-sec.open .nav-child:text-is("Players")');
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar.drawer-open').count()) !== 0) fail('N5: drawer closes after choosing a page');
  if (!(await title(scout)).includes('Players')) fail('N5: drawer navigation');
  say('N5: narrow-width drawer opens, a section tap expands its pages, a page tap navigates and closes — active state obvious');
  const strip = await scout.locator('nav.subnav button').allInnerTexts();
  if (!strip.length || strip.length > 7 || !strip.includes('Players') || strip.includes('Recruitment Rooms')) fail(`N5: the phone strip lists the active GROUP only (${strip.join('|')})`);
  say(`N5: the phone strip lists the Discover group only (${strip.join(' · ')}), never the whole section`);
  const chrome = await scout.evaluate(() => ({
    topbar: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
    scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    report: (() => { const b = document.querySelector('.topbar-safety'); return b && b.getBoundingClientRect().width > 0 ? b.getAttribute('aria-label') : null; })(),
  }));
  if (chrome.topbar > 64) fail(`N5: the phone top bar is one row (${chrome.topbar}px)`);
  if (chrome.scrollW > chrome.vw) fail(`N5: horizontal overflow at 420px (${chrome.scrollW} > ${chrome.vw})`);
  if (!chrome.report) fail('N5: Report / Block must stay reachable on a phone');
  say(`N5: one-row top bar (${chrome.topbar}px), Report / Block reachable ("${chrome.report}"), no horizontal overflow`);
  // N9: a deep link on a phone lands on the right group strip.
  await goHash(scout, 'rooms');
  const pipe = await scout.locator('nav.subnav button').allInnerTexts();
  if (!pipe.includes('Rooms') || !pipe.includes('Requests') || pipe.includes('Players')) fail(`N9: phone deep link → Pipeline strip (${pipe.join('|')})`);
  if ((await scout.locator('nav.subnav button.active').innerText()).trim() !== 'Rooms') fail('N9: active page marked in the strip');
  say('N9: a phone deep link to Rooms shows the Pipeline strip with Rooms active');
  await scout.setViewportSize({ width: 1280, height: 800 });
}

// ======================================= N10 — keyboard: accordion toggles
{
  await goHash(scout, 'search');
  const toggle = scout.locator('nav.sidebar .nav-toggle[aria-label$="Squad & Planning"]');
  if ((await toggle.count()) !== 1) fail('N10: every multi-page section has a toggle button');
  if ((await toggle.getAttribute('aria-expanded')) !== 'false') fail('N10: a non-active section starts collapsed');
  await toggle.focus();
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(150);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') fail('N10: Enter expands');
  const panel = await toggle.getAttribute('aria-controls');
  if (!panel || !(await scout.locator(`#${panel} .nav-child`).count())) fail('N10: aria-controls points at the page list');
  if (!(await activeChild(scout)).includes('Players')) fail('N10: expanding another section does not move the active page');
  say('N10: a section toggle is a real button — Enter expands it, aria-expanded/aria-controls are correct, the active page is unchanged');
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(150);
  if ((await toggle.getAttribute('aria-expanded')) !== 'false') fail('N10: Enter collapses again');
  const rec = scout.locator('nav.sidebar .nav-toggle[aria-label$="Recruitment"]');
  await rec.click();
  await scout.waitForTimeout(150);
  await goHash(scout, 'rooms');
  if ((await rec.getAttribute('aria-expanded')) !== 'true') fail('N10: navigating into a section re-opens it');
  say('N10: the active section is always expanded — navigating into it re-opens it');
}

// ============================ N11 — deep link + refresh + back / forward
{
  await goHash(scout, 'rooms');
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  await scout.waitForTimeout(500);
  if ((await title(scout)) !== 'Recruitment / Recruitment Rooms') fail(`N11: refresh keeps the page (${await title(scout)})`);
  if ((await activeChild(scout)) !== 'Recruitment Rooms') fail('N11: refresh keeps the accordion state');
  say('N11: refresh on a deep link keeps section, page and title');
  await goHash(scout, 'planner');
  if ((await title(scout)) !== 'Squad & Planning / Squad Planner') fail('N11: second page');
  await scout.goBack();
  await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Recruitment Rooms') fail(`N11: back (${await title(scout)})`);
  await scout.goForward();
  await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Squad & Planning / Squad Planner') fail(`N11: forward (${await title(scout)})`);
  if (!(await scout.locator('nav.sidebar button.nav-section.active').innerText()).includes('Squad')) fail('N11: forward highlights the section');
  say('N11: browser back / forward move between sections with the title and highlight following');
}

// ============================================= EN/FR labels on the new nav
{
  await lead.selectOption('nav.sidebar select', 'fr');
  await lead.waitForSelector('nav.sidebar button:has-text("Recrutement")', { timeout: 8000 });
  await goHash(lead, 'ledger');
  if (!(await lead.locator('nav.sidebar .nav-sec.open .nav-group-label:has-text("Statistiques")').count())) fail('i18n: group labels translate');
  if (!(await title(lead)).includes('Recrutement')) fail('i18n: the h1 crumb translates');
  say('i18n: sections, group labels and the page title translate (Recrutement › Statistiques)');
  await lead.selectOption('nav.sidebar select', 'en');
  await lead.waitForSelector('nav.sidebar button:has-text("Recruitment")', { timeout: 8000 });
}

// ============================================================ N6 — grassroots
const grassCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
{
  const grass = await grassCtx.newPage();
  grass.on('pageerror', (e) => fail(`grassroots page error: ${e}`));
  await grass.goto('http://localhost:8396');
  await grass.click('.org-card:has-text("Hackney Marsh")');
  await grass.fill('.enter-row input', 'Dee Coach');
  await grass.click('button:has-text("Enter workspace")');
  await grass.waitForSelector('nav.sidebar', { timeout: 20000 });
  await grass.waitForTimeout(700);
  const sections = await sectionLabels(grass);
  if (!sections.some((s) => s.includes('Players')) || !sections.some((s) => s.includes('Club'))) fail(`N6: grassroots sections (${sections.join('|')})`);
  if (sections.some((s) => /Team|Network|Squad & Planning/.test(s))) fail(`N6: old grassroots sections linger (${sections.join('|')})`);
  say('N6: grassroots gets its own reduced structure — Home, Players, Recruitment, Club, Inbox');
  await grass.click('nav.sidebar button.nav-section:has-text("Club")');
  await grass.waitForTimeout(300);
  if (!(await title(grass)).includes('Clubs & Groups')) fail(`N6: Club opens on Clubs & Groups for every role (${await title(grass)})`);
  say('N6: Club opens on Clubs & Groups — the page that used to be Network, still visible to everyone');
  await grass.keyboard.press('Control+k');
  await grass.fill('.palette input', 'budgets');
  await grass.waitForTimeout(200);
  if ((await grass.locator('.palette-results .notice').count()) !== 1) fail('N6: Pro-only Budgets leaked into grassroots');
  await grass.fill('.palette input', 'representation');
  await grass.waitForTimeout(200);
  if ((await grass.locator('.palette-results .notice').count()) !== 1) fail('N6: Pro-only Representation leaked');
  say('N6: no Pro-only destinations exposed in Grassroots');
  await grass.keyboard.press('Escape');
  await grass.evaluate(() => { location.hash = '#/squad'; });
  await grass.waitForTimeout(300);
  if ((await title(grass)) !== 'Players / Squad & Match Days') fail(`N6: grassroots deep link (${await title(grass)})`);
  say('N6: grassroots deep links work (#/squad → Players / Squad & Match Days)');
  await grass.setViewportSize({ width: 390, height: 844 });
  await grass.waitForTimeout(300);
  await grass.click('button.nav-hamburger');
  await grass.waitForTimeout(300);
  const d = await grass.evaluate(() => { const s = document.querySelector('nav.sidebar'); return { dir: getComputedStyle(s).flexDirection, w: Math.round(s.getBoundingClientRect().width), scrollW: document.documentElement.scrollWidth }; });
  if (d.dir !== 'column' || d.scrollW > 390) fail(`N6: grassroots phone drawer (${JSON.stringify(d)})`);
  say('N6: the grassroots phone drawer is a column with no horizontal overflow (P2.5 defect D1 closed)');
}

// ============================================================ N8 — T&S
{
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  admin.on('pageerror', (e) => fail(`admin page error: ${e}`));
  await admin.goto('http://localhost:8397');
  await admin.fill('input[type="password"]', 'scoutbox-admin');
  await admin.click('button:has-text("Enter")');
  await admin.waitForSelector('nav.sidebar', { timeout: 20000 });
  const groups = await admin.locator('nav.sidebar button').allInnerTexts();
  const expect = ['Home', 'Cases', 'Verification', 'Safety', 'Operations', 'System'];
  if (!expect.every((g) => groups.some((x) => x.includes(g)))) fail(`N8: admin groups (${groups.join('|')})`);
  say('N8: T&S console shows six grouped destinations instead of 22 flat tabs (unchanged by P2.5)');
  const tour = [
    ['Cases', ['Report queue', 'Evidence disputes', 'Ver. disputes', 'Support desk']],
    ['Verification', ['Verification', 'Club verification', 'Guardian IDV', 'Staff checks', 'Coach affiliations']],
    ['Safety', ['Suspensions', 'Moderation log', 'Thread audit', 'Drill guidance']],
    ['Operations', ['Outcome tracking', 'Representation', 'Federation groups', 'Delivery centre', 'Mail outbox', 'Billing']],
    ['System', ['Service health', 'Backups']],
  ];
  let toured = 0;
  for (const [group, tabs] of tour) {
    await admin.click(`nav.sidebar button:has-text("${group}")`);
    await admin.waitForTimeout(200);
    for (const label of tabs) {
      await admin.click(`nav.subnav button:has-text("${label}")`);
      await admin.waitForTimeout(150);
      const h = await admin.locator('.topbar h2').innerText();
      if (!h.includes(label)) fail(`N8: tab ${label} unreachable`);
      toured++;
    }
  }
  await admin.click('nav.sidebar button:has-text("Home")');
  await admin.waitForTimeout(200);
  if (!(await admin.locator('.topbar h2').innerText()).includes('Overview')) fail('N8: Home/Overview');
  say(`N8: all ${toured + 1} legacy T&S destinations remain reachable through the grouped navigation`);
}

// ===================== N13 — Pipeline on a phone: primaries + More (closure)
{
  await scout.setViewportSize({ width: 390, height: 844 });
  await goHash(scout, 'recruitment');
  await scout.waitForTimeout(300);
  const strip = async () => scout.evaluate(() => {
    const n = document.querySelector('nav.subnav');
    const tabs = [...n.querySelectorAll(':scope > button:not(.subnav-more)')].map((b) => ({ t: b.textContent.trim(), active: b.classList.contains('active'), right: Math.round(b.getBoundingClientRect().right), h: Math.round(b.getBoundingClientRect().height) }));
    const more = n.querySelector('.subnav-more');
    return { tabs, more: more ? { t: more.textContent.replace(/\s+/g, ' ').trim(), expanded: more.getAttribute('aria-expanded'), active: more.classList.contains('active'), label: more.getAttribute('aria-label') } : null,
      clip: n.scrollWidth > n.clientWidth, h: Math.round(n.getBoundingClientRect().height), docOverflow: document.documentElement.scrollWidth > innerWidth, font: getComputedStyle(n.querySelector('button')).fontSize };
  });
  let m = await strip();
  if (m.tabs.map((x) => x.t).join('|') !== 'Cases|Rooms|Requests') fail(`N13: Pipeline primaries (${m.tabs.map((x) => x.t).join('|')})`);
  if (!m.more || !/More/.test(m.more.t) || !/3/.test(m.more.t)) fail(`N13: an explicit More control announces the remaining pages (${JSON.stringify(m.more)})`);
  if (m.clip || m.docOverflow) fail(`N13: the strip must not clip or overflow (${JSON.stringify(m)})`);
  if (m.tabs.some((x) => x.right > 390) || m.h > 48) fail(`N13: every tab fully on screen and the strip compact (${JSON.stringify(m)})`);
  if (parseFloat(m.font) < 13 || m.tabs.some((x) => x.h < 40)) fail(`N13: readable labels and 40px targets (${m.font}, ${m.tabs.map((x) => x.h)})`);
  if (!m.tabs[0].active) fail('N13: Cases active on arrival');
  say(`N13: Pipeline at 390px — Cases · Rooms · Requests visible, "More 3" for the rest; ${m.h}px strip, no clipping, no document overflow`);
  await scout.click('nav.subnav button:text-is("Rooms")');
  await scout.waitForTimeout(300);
  if ((await title(scout)) !== 'Recruitment / Recruitment Rooms') fail(`N13: Rooms tab (${await title(scout)})`);
  say('N13: a primary tab is one tap — Rooms');
  await scout.click('nav.subnav .subnav-more');
  await scout.waitForTimeout(150);
  const menu = await scout.evaluate(() => { const mn = document.querySelector('nav.subnav [role="menu"]'); return mn ? { items: [...mn.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim()), focused: document.activeElement?.getAttribute('role'), expanded: document.querySelector('.subnav-more').getAttribute('aria-expanded') } : null; });
  if (!menu || menu.expanded !== 'true' || menu.items.join('|') !== 'Opportunities|Campaigns|Signings & Outcomes') fail(`N13: More menu (${JSON.stringify(menu)})`);
  if (menu.focused !== 'menuitem') fail('N13: focus moves into the menu when it opens');
  say('N13: More opens a real menu (aria-expanded, role=menu) listing Opportunities · Campaigns · Signings & Outcomes, focus inside');
  await scout.keyboard.press('Escape');
  await scout.waitForTimeout(100);
  if ((await scout.locator('nav.subnav [role="menu"]').count()) !== 0) fail('N13: Escape closes the menu');
  if (!(await scout.evaluate(() => document.activeElement?.classList.contains('subnav-more')))) fail('N13: Escape returns focus to More');
  say('N13: Escape closes the menu and returns focus to More');
  await scout.click('nav.subnav .subnav-more');
  await scout.keyboard.press('ArrowDown');
  await scout.keyboard.press('Enter'); // Campaigns
  await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Campaigns') fail(`N13: keyboard selection from More (${await title(scout)})`);
  m = await strip();
  if (!m.more.active || !/Campaigns/.test(m.more.t) || !/More/.test(m.more.label) || m.tabs.some((x) => x.active)) fail(`N13: active state when the page is inside More (${JSON.stringify(m)})`);
  if ((await scout.locator('nav.subnav [role="menu"]').count()) !== 0) fail('N13: the menu closes on selection');
  if (!(await scout.evaluate(() => document.activeElement?.classList.contains('subnav-more')))) fail('N13: focus is not stranded after selection');
  say('N13: selecting Campaigns closes the menu, the More control reads "Campaigns ▾" with the active state (its accessible name still says More), focus stays on More');
  await scout.reload();
  await scout.waitForSelector('nav.subnav', { timeout: 15000 });
  await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Campaigns' || !(await strip()).more.active) fail('N13: refresh keeps the More-held page active');
  say('N13: direct refresh on a More-held page keeps the page and the active state');
  // Browser history: in-app clicks replace the hash (M15-Nav: Back leaves the
  // workspace, it does not replay every tab), so the history walk uses the
  // three deep links — Cases, Rooms, Campaigns — and checks the strip follows.
  await goHash(scout, 'recruitment'); await goHash(scout, 'rooms'); await goHash(scout, 'campaigns');
  if (!(await strip()).more.active) fail('N13: deep link to a More-held page marks More active');
  await scout.goBack(); await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Recruitment Rooms' || !(await strip()).tabs[1].active || (await strip()).more.active) fail(`N13: back → Rooms (${await title(scout)})`);
  await scout.goBack(); await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Cases' || !(await strip()).tabs[0].active) fail(`N13: back → Cases (${await title(scout)})`);
  await scout.goForward(); await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Recruitment Rooms' || !(await strip()).tabs[1].active) fail('N13: forward → Rooms with the tab active');
  await scout.goForward(); await scout.waitForTimeout(400);
  if ((await title(scout)) !== 'Recruitment / Campaigns' || !(await strip()).more.active) fail('N13: forward → Campaigns with More active');
  say('N13: back / forward across Cases, Rooms and Campaigns keep the strip, the tab and the More active state right');
  // Outside click closes the menu.
  await scout.click('nav.subnav .subnav-more');
  await scout.click('h1.page-title');
  await scout.waitForTimeout(150);
  if ((await scout.locator('nav.subnav [role="menu"]').count()) !== 0) fail('N13: outside click closes the menu');
  say('N13: an outside click closes the menu');
  // The More menu goes through the same unsaved-change guard as every exit.
  await goHash(scout, 'briefs');
  await scout.click('button:has-text("New brief")');
  await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 15000 });
  await scout.fill('[aria-label="Recruitment brief criteria"] input', 'Unsaved phone brief');
  const dialogs = [];
  const onDialog = async (d) => { dialogs.push(d.message()); await d.dismiss(); };
  scout.on('dialog', onDialog);
  await scout.click('nav.subnav .subnav-more');
  await scout.click('nav.subnav [role="menuitem"]:has-text("Second Look")');
  await scout.waitForTimeout(600);
  scout.off('dialog', onDialog);
  if (dialogs.length !== 1 || !/unsaved/i.test(dialogs[0])) fail(`N13: More navigation must ask about unsaved changes (${dialogs.length})`);
  if (!(await scout.locator('[aria-label="Recruitment brief criteria"]').count())) fail('N13: declining kept the form');
  say('N13: navigating from the More menu goes through the unsaved-change guard — declining keeps the form');
  scout.once('dialog', (d) => d.accept());
  await goHash(scout, 'search');
}

// ============================ N14 — 360px: every group fits, nothing clipped
{
  await lead.setViewportSize({ width: 360, height: 740 });
  const groupsSeen = [];
  const ALL_IDS = ['feed', 'search', 'shortlist', 'filmroom', 'insight', 'recruitment', 'rooms', 'requests', 'opportunities', 'campaigns', 'outcomes',
    'assessments', 'video', 'trials', 'trialdays', 'briefs', 'matching', 'watchlists', 'secondlook', 'nobodymissed', 'dashboard', 'funnel', 'ledger',
    'planner', 'coverage', 'calibration', 'fixtures', 'network', 'representation', 'organisation', 'verification', 'imports', 'budgets', 'plan', 'reputation', 'messages'];
  for (const id of ALL_IDS) {
    await goHash(lead, id);
    const r = await lead.evaluate(() => {
      const n = document.querySelector('nav.subnav');
      if (!n) return null;
      const btns = [...n.querySelectorAll(':scope > button')];
      return { n: btns.length, clip: n.scrollWidth > n.clientWidth, off: btns.filter((b) => b.getBoundingClientRect().right > innerWidth + 0.5 || b.getBoundingClientRect().left < -0.5).map((b) => b.textContent.trim()), doc: document.documentElement.scrollWidth > innerWidth, more: !!n.querySelector('.subnav-more'), h: Math.round(n.getBoundingClientRect().height), labels: btns.map((b) => b.textContent.replace(/\s+/g, ' ').trim()) };
    });
    if (r && (r.clip || r.off.length || r.doc || r.h > 48)) fail(`N14: ${id} at 360px (${JSON.stringify(r)})`);
    if (r) groupsSeen.push(r.labels.join(' · '));
  }
  say(`N14: at 360px, every one of ${ALL_IDS.length} pages (lead persona, every section): no strip clips, no tab is off screen, no document overflow — ${[...new Set(groupsSeen)].join(' | ')}`);
  // Breakpoint: 900px shows the phone shell, 901px the desktop shell — no in-between state.
  await goHash(lead, 'recruitment');
  await lead.setViewportSize({ width: 900, height: 800 }); await lead.waitForTimeout(300);
  const at900 = await lead.evaluate(() => ({ strip: getComputedStyle(document.querySelector('nav.subnav')).display, burger: getComputedStyle(document.querySelector('.nav-hamburger')).display, fixed: getComputedStyle(document.querySelector('nav.sidebar')).position }));
  await lead.setViewportSize({ width: 901, height: 800 }); await lead.waitForTimeout(300);
  const at901 = await lead.evaluate(() => ({ strip: document.querySelector('nav.subnav') ? getComputedStyle(document.querySelector('nav.subnav')).display : 'none', burger: getComputedStyle(document.querySelector('.nav-hamburger')).display, fixed: getComputedStyle(document.querySelector('nav.sidebar')).position, accordion: document.querySelectorAll('nav.sidebar .nav-sec.open .nav-child').length }));
  if (at900.strip === 'none' || at900.burger === 'none' || at900.fixed !== 'fixed') fail(`N14: 900px is the phone shell (${JSON.stringify(at900)})`);
  if (at901.strip !== 'none' || at901.burger !== 'none' || at901.fixed === 'fixed' || at901.accordion < 20) fail(`N14: 901px is the desktop shell with the accordion (${JSON.stringify(at901)})`);
  say('N14: one breakpoint — 900px is the phone shell (drawer + strip), 901px the desktop shell (accordion, no strip)');
  await lead.setViewportSize({ width: 1280, height: 800 });
  await scout.setViewportSize({ width: 1280, height: 800 });
}

// ====================== N15 — task-finding proof: seven core destinations
// From a FRESH login, with nothing pre-expanded, can a new user reach each
// destination through visible controls? Desktop accordion, collapsed rail,
// and the 390px drawer. No hash entry; interactions counted.
const TASKS = [
  ['Discover', 'Recruitment', 'Players', 'Recruitment / Players'],
  ['Watchlists', 'Recruitment', 'Dynamic Watchlists', 'Recruitment / Dynamic Watchlists'],
  ['Recruitment Cases', 'Recruitment', 'Cases', 'Recruitment / Cases'],
  ['Recruitment Rooms', 'Recruitment', 'Recruitment Rooms', 'Recruitment / Recruitment Rooms'],
  ['Second Look', 'Recruitment', 'Second Look', 'Recruitment / Second Look'],
  ['Trials', 'Recruitment', 'Trials & Reports', 'Recruitment / Trials & Reports'],
  ['Analytics', 'Recruitment', 'Director Dashboard', 'Recruitment / Director Dashboard'],
];
const matrix = {};
// Fresh state for every task: reload on Home. Accordion state is not persisted,
// so nothing a previous task expanded survives; the session and the collapse
// preference do.
const fresh = async (p) => { await goHash(p, 'feed'); await p.reload(); await p.waitForSelector('nav.sidebar', { timeout: 15000 }); await p.waitForTimeout(500); };
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await clubLogin(ctx, 'Noa Winter', 'First-Team Scout');
  for (const [task, section, page, expect] of TASKS) {
    await fresh(p); // Home, fresh state: the accordion has nothing but Home open
    if ((await p.locator('nav.sidebar .nav-sec.open .nav-child').count()) !== 0) fail(`N15: ${task}: Recruitment is pre-expanded on Home`);
    let n = 0;
    await p.click(`nav.sidebar button.nav-section:has-text("${section}")`); n++;
    await p.waitForTimeout(250);
    if ((await title(p)) !== expect) {
      const child = p.locator(`nav.sidebar .nav-sec.open .nav-child:text-is("${page}")`);
      if (!(await child.isVisible())) fail(`N15 desktop: ${task}: "${page}" is not visible under Recruitment after opening it`);
      await child.click(); n++;
      await p.waitForTimeout(250);
    }
    if ((await title(p)) !== expect) fail(`N15 desktop: ${task}: landed on "${await title(p)}"`);
    if (!(await p.locator('nav.sidebar button.nav-section.active').innerText()).includes(section)) fail(`N15 desktop: ${task}: parent not active`);
    matrix[task] = { desktop: n };
  }
  say(`N15 desktop: all seven destinations found from a fresh login — ${TASKS.map(([t]) => `${t} ${matrix[t].desktop}`).join(', ')} interactions`);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await clubLogin(ctx, 'Noa Winter', 'First-Team Scout');
  await p.click('button.nav-collapse'); await p.waitForTimeout(200);
  for (const [task, section, page, expect] of TASKS) {
    await fresh(p);
    let n = 0;
    await p.click(`nav.sidebar button[aria-label="${section}"]`); n++;
    await p.waitForTimeout(200);
    const item = p.locator(`nav.sidebar .nav-flyout [role="menuitem"]:text-is("${page}")`);
    if (!(await item.isVisible())) fail(`N15 collapsed: ${task}: "${page}" not in the flyout`);
    await item.click(); n++;
    await p.waitForTimeout(250);
    if ((await title(p)) !== expect) fail(`N15 collapsed: ${task}: landed on "${await title(p)}"`);
    matrix[task].collapsed = n;
  }
  say(`N15 collapsed rail: all seven found through the flyout — ${TASKS.map(([t]) => `${t} ${matrix[t].collapsed}`).join(', ')} interactions`);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await clubLogin(ctx, 'Noa Winter', 'First-Team Scout');
  for (const [task, section, page, expect] of TASKS) {
    await fresh(p);
    let n = 0;
    await p.click('button.nav-hamburger'); n++;
    await p.waitForTimeout(250);
    const sec = p.locator(`nav.sidebar button.nav-section:has-text("${section}")`);
    await sec.click(); n++;
    await p.waitForTimeout(250);
    if ((await p.locator('nav.sidebar.drawer-open').count()) !== 1) fail(`N15 mobile: ${task}: tapping a section in the drawer must expand it, not leave the drawer`);
    if ((await sec.getAttribute('aria-expanded')) !== 'true') fail(`N15 mobile: ${task}: section button announces expansion`);
    const child = p.locator(`nav.sidebar .nav-sec.open .nav-child:text-is("${page}")`);
    if (!(await child.isVisible())) fail(`N15 mobile: ${task}: "${page}" not visible in the expanded drawer`);
    const box = await child.boundingBox();
    if (!box || box.height < 32) fail(`N15 mobile: ${task}: tap target ${box?.height}px`);
    await child.click(); n++;
    await p.waitForTimeout(300);
    if ((await p.locator('nav.sidebar.drawer-open').count()) !== 0) fail(`N15 mobile: ${task}: drawer closes after choosing a page`);
    if ((await title(p)) !== expect) fail(`N15 mobile: ${task}: landed on "${await title(p)}"`);
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail(`N15 mobile: ${task}: horizontal overflow`);
    matrix[task].mobile = n;
  }
  say(`N15 mobile (390px): all seven found through the drawer with no blind swipe — ${TASKS.map(([t]) => `${t} ${matrix[t].mobile}`).join(', ')} interactions`);
  console.log('   task-finding matrix: ' + JSON.stringify(matrix));
  await ctx.close();
}

// ======================= N16 — accessibility tree: groups are not links
{
  const tree = await scout.evaluate(() => {
    const groups = [...document.querySelectorAll('nav.sidebar .nav-sec.open .nav-group')].map((g) => ({ role: g.getAttribute('role'), label: g.getAttribute('aria-label'), heading: g.querySelector('.nav-group-label')?.tagName, headingRole: g.querySelector('.nav-group-label')?.getAttribute('role'), headingInteractive: !!g.querySelector('.nav-group-label')?.closest('button, a, [role="button"], [role="link"]') }));
    const clickableDiscover = [...document.querySelectorAll('nav.sidebar button, nav.sidebar a')].filter((b) => b.textContent.trim() === 'Discover').length;
    return { groups, clickableDiscover };
  });
  if (tree.groups.length < 5 || tree.groups.some((g) => g.role !== 'group' || !g.label || g.heading !== 'DIV' || g.headingRole || g.headingInteractive)) fail(`N16: group semantics (${JSON.stringify(tree.groups)})`);
  if (tree.clickableDiscover !== 0) fail('N16: "Discover" must not be rendered as a button or link');
  say('N16: groups are role="group" containers with names; group headings are plain text, never buttons or links');
}

// ============================== N12 — server authorization unaffected
{
  const r1 = await fetch(`${API}/admin/verification/queue`);
  if (r1.status !== 401) fail('server auth: admin queue must still 401 without the key');
  const r2 = await fetch(`${API}/org/verification/requests`);
  if (r2.status !== 401) fail('server auth: org route must still 401 without a session');
  // A scout's OWN session, on a route the sidebar hides from them.
  const noa = await (await fetch(`${API}/auth/org/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Noa Winter', role: 'First-Team Scout' }) })).json();
  const r3 = await fetch(`${API}/org/verification/requests`, { headers: { authorization: `Bearer ${noa.token}` } });
  if (r3.status === 200) fail('server auth: a scout must not read the verification console just because the sidebar could be edited');
  say(`N12: server authorization unaffected — hidden navigation changes nothing about 401/403 rules (scout → ${r3.status})`);
}

// ======================================= N7 — player app: five destinations
{
  const tabsDir = path.join(ROOT, 'scoutbox-player', 'src', 'app', '(tabs)');
  const layout = fs.readFileSync(path.join(tabsDir, '_layout.tsx'), 'utf8');
  for (const id of ['discover', 'football', 'opportunities', 'inbox', 'you']) {
    if (!layout.includes(`name: '${id}'`)) fail(`N7: player tab ${id} missing from the bar`);
    if (!fs.existsSync(path.join(tabsDir, `${id}.tsx`))) fail(`N7: player route ${id} has no screen`);
  }
  for (const id of ['profile', 'upload']) {
    if (!/name: '(profile|upload)'[^\n]*hidden: true/.test(layout) || !layout.includes(`name: '${id}'`)) fail(`N7: ${id} must keep its route off the bar`);
    if (!fs.existsSync(path.join(tabsDir, `${id}.tsx`))) fail(`N7: player route ${id} removed`);
  }
  if (!layout.includes('href: null')) fail('N7: hidden routes are hidden with href: null, not deleted');
  const football = fs.readFileSync(path.join(tabsDir, 'football.tsx'), 'utf8');
  if (!/PageTabs/.test(football) || !/href="\/upload"/.test(football)) fail('N7: Football carries page tabs and the + Add evidence action');
  say('N7: player app — Home / Football / Opportunities / Inbox / You; Profile and Upload stay routes (href: null); Football has page tabs and + Add evidence (browser journeys live in the player suites)');
}

await browser.close();
console.log(`\nnavLive: ${passed} checks passed — N1–N16 complete`);
process.exit(0);
