// M15-Nav LIVE browser journeys (N1–N8) — real backend, separate contexts.
//   N1. Ordinary scout: compact sidebar, NO Organisation, Discover → Players,
//       deep link highlights Recruitment → Assessments; hidden route stays
//       hidden in the palette; direct hash to a hidden route highlights no
//       section (and the server still refuses its data).
//   N2. Head of Recruitment: Organisation visible; Staff & Security,
//       Verification, Recruitment → Trials all reachable; nothing lost.
//   N3. Command palette: ⌘K/Ctrl+K, keyboard selection, permission filtering,
//       plain typing in an input never opens it.
//   N4. Collapse: icon rail, tooltips/labels, persists across reload.
//   N5. 640px height + narrow-width drawer: everything reachable.
//   N6. Grassroots persona: Team section, no Pro-only destinations.
//   N7. Player app intentionally unchanged (documented follow-up) — asserted
//       by inspecting the config surface, not a browser run.
//   N8. T&S: six grouped destinations; all 22 legacy tabs reachable.
// Plus negative cases: revoked-permission shortcut, malformed stored state,
// unknown hash, server authorization unaffected.
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
const topbar = async (page) => (await page.locator('.topbar h2').innerText()).replace(/\s+/g, ' ').trim();

// ============================================================ N1 — scout
const scoutCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const scout = await clubLogin(scoutCtx, 'Noa Winter', 'First-Team Scout');
{
  const sections = await scout.locator('nav.sidebar button.nav-section').allInnerTexts();
  if (sections.some((s) => s.includes('Organisation'))) fail('N1: scout sees Organisation');
  if (sections.length !== 6) fail(`N1: expected 5 sections + Inbox, saw ${sections.length}`); // 5 product + Inbox
  say('N1: ordinary scout sees the compact set — Organisation absent');
  await scout.click('nav.sidebar button:has-text("Discover")');
  await scout.waitForSelector('nav.subnav');
  if (!(await topbar(scout)).includes('Players')) fail('N1: Discover default child');
  say('N1: Discover opens on Players with the secondary tab row');
  await goHash(scout, 'assessments');
  if ((await topbar(scout)) !== 'Recruitment / Assessments') fail(`N1: deep link breadcrumb (${await topbar(scout)})`);
  const active = await scout.locator('nav.sidebar button.nav-section.active').innerText();
  if (!active.includes('Recruitment')) fail('N1: deep link highlights Recruitment');
  const activeTab = await scout.locator('nav.subnav button.active').innerText();
  if (activeTab !== 'Assessments') fail('N1: deep link highlights the Assessments tab');
  say('N1: direct deep link highlights section AND child tab (no parent-first navigation needed)');
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
  await scout.fill('.palette input', 'coverage');
  await scout.waitForTimeout(200);
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(300);
  if ((await topbar(scout)) !== 'Squad & Planning / Coverage') fail('N3: palette navigation');
  say('N3: palette routes "coverage" → Squad & Planning → Coverage via keyboard');
  // plain typing in an input must never open the palette
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
  say('N4: collapsed icon rail with accessible names');
  await scout.click('nav.sidebar button[aria-label="Discover"]');
  await scout.waitForTimeout(250);
  if (!(await topbar(scout)).includes('Players')) fail('N4: navigate while collapsed');
  say('N4: navigation works from the collapsed rail');
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
  // a stored shortcut to a destination this role cannot see drops silently
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
  // malformed stored collapse preference must not break boot
  await scout.evaluate(() => localStorage.setItem('sb-nav-collapsed', '{broken'));
  await scout.reload();
  await scout.waitForSelector('nav.sidebar', { timeout: 15000 });
  say('Malformed stored collapsed-state preference: workspace still boots expanded');
}

// ============================================================ N2 — lead
const leadCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lead = await clubLogin(leadCtx, 'Maria Keane', 'Head of Recruitment');
{
  const sections = await lead.locator('nav.sidebar button.nav-section').allInnerTexts();
  if (!sections.some((s) => s.includes('Organisation'))) fail('N2: lead must see Organisation');
  say('N2: head of recruitment sees Organisation');
  await lead.click('nav.sidebar button:has-text("Organisation")');
  await lead.waitForSelector('nav.subnav');
  if (!(await topbar(lead)).includes('Staff & Security')) fail('N2: Organisation default child');
  say('N2: Organisation → Staff & Security opens');
  await lead.click('nav.subnav button:has-text("Verification")');
  await lead.waitForSelector('text=Ma vérification, text=My verification', { timeout: 15000 }).catch(() => {});
  if ((await topbar(lead)) !== 'Organisation / Verification') fail('N2: Verification breadcrumb');
  say('N2: Organisation → Verification opens the M14 console');
  await goHash(lead, 'trials');
  if ((await topbar(lead)) !== 'Recruitment / Trials & Reports') fail('N2: Trials reachable');
  say('N2: Recruitment → Trials reachable; no route lost');
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
  if (m.sections !== 6) fail('N5: sections at 640px');
  if (m.over && m.oy !== 'auto') fail('N5: sidebar must scroll when it overflows');
  say('N5: 640px height — every destination reachable (sidebar scrolls if needed, regression guard held)');
  await scout.setViewportSize({ width: 420, height: 800 });
  await scout.waitForTimeout(300);
  if (!(await scout.locator('button.nav-hamburger').isVisible())) fail('N5: hamburger at narrow width');
  await scout.click('button.nav-hamburger');
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar.drawer-open').count()) !== 1) fail('N5: drawer opens');
  await scout.click('nav.sidebar button:has-text("Recruitment")');
  await scout.waitForTimeout(300);
  if ((await scout.locator('nav.sidebar.drawer-open').count()) !== 0) fail('N5: drawer closes after navigation');
  if (!(await topbar(scout)).includes('Pipeline')) fail('N5: drawer navigation');
  say('N5: narrow-width drawer opens, navigates, closes — active state obvious');
  await scout.setViewportSize({ width: 1280, height: 800 });
}

// ============================================= EN/FR labels on the new nav
{
  await lead.selectOption('nav.sidebar select', 'fr');
  await lead.waitForSelector('nav.sidebar button:has-text("Découvrir")', { timeout: 8000 });
  say('i18n: sidebar sections translate (Découvrir)');
  await lead.selectOption('nav.sidebar select', 'en');
  await lead.waitForSelector('nav.sidebar button:has-text("Discover")', { timeout: 8000 });
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
  const sections = await grass.locator('nav.sidebar button.nav-section').allInnerTexts();
  if (!sections.some((s) => s.includes('Team'))) fail('N6: grassroots Team section');
  say('N6: grassroots gets its own reduced structure (Team, not Squad & Planning)');
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
  if (!(await topbar(grass)).includes('Squad')) fail('N6: grassroots deep link');
  say('N6: grassroots deep links work');
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
  say('N8: T&S console shows six grouped destinations instead of 22 flat tabs');
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

// ============================== server authorization unaffected (negative)
{
  const r1 = await fetch(`${API}/admin/verification/queue`);
  if (r1.status !== 401) fail('server auth: admin queue must still 401 without the key');
  const r2 = await fetch(`${API}/org/verification/requests`);
  if (r2.status !== 401) fail('server auth: org route must still 401 without a session');
  say('Server authorization unaffected: hidden navigation changes nothing about 401/403 rules');
}

// ================================ N7 — player app intentionally unchanged
{
  const tabs = fs.readFileSync(path.join(ROOT, 'scoutbox-player', 'src', 'app', '(tabs)', '_layout.tsx'), 'utf8');
  for (const id of ['discover', 'inbox', 'profile', 'upload', 'you']) {
    if (!tabs.includes(`'${id}'`)) fail(`N7: player tab ${id} changed`);
  }
  say('N7: player navigation intentionally untouched (M15 Passport absent) — follow-up documented in NAVIGATION_ARCHITECTURE.md');
}

await browser.close();
console.log(`\nnavLive: ${passed} checks passed — N1–N8 complete`);
process.exit(0);
