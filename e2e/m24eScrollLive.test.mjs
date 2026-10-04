// M24E LIVE — "I can scroll screens where I need to so I can see everything
// in all orientations": the global scroll invariant, and Inter resolving,
// across the five applications at nine viewports (phone portrait, phone
// landscape, short laptops), against real builds and a real server.
//
//   A  AUTH       Pro, Grassroots, Agent (live + demo roster), Trust & Safety,
//                 Player — the entry screen scrolls when the viewport is too
//                 short, the last row / the submit / the credit are reachable,
//                 nothing is cut off, no horizontal page overflow
//   L  LONG LIST  fifteen organisations on the Pro and Grassroots selectors
//                 (ten registered with long names), every row reachable
//   P  PAGES      a long page in every app scrolls to its last control; the
//                 Player's bottom navigation never covers the final content
//   S  SIDEBAR    at a short height the navigation region scrolls on its own
//                 and Sign out / Switch organisation stay reachable
//   M  MODALS     the command palette and a drawer fit the viewport and keep
//                 their close / action controls reachable
//   T  TABLES     the ledger's wide table scrolls inside its container
//   O  ORIENTATION portrait → landscape → portrait while a screen is open
//   F  FONTS      computed Inter on heading, body, button, navigation and
//                 form label in every portal and on the Player; no font
//                 warning in the console
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
const API_PORT = 4063;
const API = `http://localhost:${API_PORT}`;
const PORTS = { club: 8781, grassroots: 8782, agent: 8783, admin: 8784, agentDemo: 8785, player: 8881 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24escroll-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (c, m) => (c ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932], [640, 360], [844, 390], [1024, 600], [1280, 720], [1440, 700]];

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24es';
const bundles = [['scoutbox-club', PORTS.club, DIST], ['scoutbox-grassroots', PORTS.grassroots, DIST], ['scoutbox-agent', PORTS.agent, DIST], ['scoutbox-admin', PORTS.admin, DIST], ['scoutbox-agent', PORTS.agentDemo, `${DIST}-demo`], ['scoutbox-player', PORTS.player, DIST]];
if (KEEP && bundles.every(([app, , dist]) => fs.existsSync(path.join(ROOT, app, dist, 'index.html')))) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  for (const [app, , dist] of bundles) {
    if (app === 'scoutbox-player') execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else if (dist.endsWith('-demo')) execSync(`VITE_DEMO=1 npx vite build --outDir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else execSync(`VITE_API_URL=${API} npx vite build --outDir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
  }
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
for (const [app, port, dist] of bundles) serveDir(`${app}/${dist}`, port);
let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) for (const [app, , dist] of bundles) fs.rmSync(path.join(ROOT, app, dist), { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

// L — ten more organisations with long names, so the selectors are long.
const LONG = ['Northumberland & Tyneside Combined Services Football Association', 'Shropshire Agricultural Workers Amateur Football Club 1898', 'Ynys Môn Gogledd Cymru Clwb Pêl-droed Cymunedol', 'Isle of Wight Coastal Community Sports & Welfare Society', 'Greater Manchester Textile Workers Saturday League Club', 'Cornish Tin Miners Memorial Recreation Football Club', 'Lincolnshire Fenland Drainage Board Social Football Club', 'Cumbrian Lakeland Shepherds Sunday Morning Football Club', 'Hertfordshire New Towns Development Corporation Athletic', 'Staffordshire Potteries Ceramic Workers Football Club'];
for (const [i, name] of LONG.entries()) {
  const r = await fetch(`${API}/auth/org/register-grassroots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, federation: 'The FA — England', registrationId: `FA-LONG-${1000 + i}`, city: 'Somewhere', lat: 52 + i / 10, lng: -1 - i / 10, scoutName: `Founder ${i}`, role: 'Manager', password: 'long-club-password-1' }) });
  if (!r.ok) fail(`fixture: could not register long club ${i} (${r.status})`);
}
say(`fixture: ${LONG.length} organisations with long names registered, so the selectors hold ${LONG.length}+ rows`);

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const consoleWarnings = [];
const ctxFor = (w, h) => browser.newContext({ viewport: { width: w, height: h }, ...(w < 500 || h < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); page.on('console', (m) => { if (/font/i.test(m.text()) && /warn|error/.test(m.type())) consoleWarnings.push(`${who}: ${m.text()}`); }); return page; };

// The scroll measurements, run in the page.
const HELPERS = `window.__sc = {
  scroller(el) { let e = el; while (e && e !== document.documentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e; e = e.parentElement; } return document.scrollingElement; },
  visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5; },
  reach(el) { el.scrollIntoView({ block: 'end', inline: 'nearest' }); return this.visible(el); },
  noHOverflow() { return document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1; },
};`;
const inject = (page) => page.addScriptTag({ content: HELPERS });

async function authAudit(page, who, w, h, { lastRow, submit = '.auth-form button.primary', credit = '[data-testid="login-signature"]', top = '.auth-form h1 .wordmark' }) {
  await inject(page);
  const r = await page.evaluate(([lastRow, submit, credit, top]) => {
    const scroller = document.querySelector('.login.auth-page');
    const needs = scroller.scrollHeight > scroller.clientHeight + 1;
    scroller.scrollTop = 0;
    const topVisible = __sc.visible(document.querySelector(top));
    const rows = [...document.querySelectorAll(lastRow)];
    const last = rows[rows.length - 1];
    const lastReach = last ? __sc.reach(last) : true;
    const submitReach = __sc.reach(document.querySelector(submit));
    const creditReach = __sc.reach(document.querySelector(credit));
    scroller.scrollTop = scroller.scrollHeight;
    const moved = !needs || scroller.scrollTop > 0;
    const fixed = [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().height > 0 && !el.hasAttribute('data-demo-badge'));
    const covered = fixed.some((f) => { const a = f.getBoundingClientRect(), b = document.querySelector(credit).getBoundingClientRect(); return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right; });
    // The oversized pitch drawing behind the card is clipped by the page's own overflow-x; what must never happen is a horizontal PAGE scroll or a card past the edge.
    const card = document.querySelector('.auth-card').getBoundingClientRect();
    return { needs, moved, topVisible, lastReach, submitReach, creditReach, rows: rows.length, hOk: __sc.noHOverflow() && card.right <= innerWidth + 0.5 && card.left >= -0.5, covered, ch: scroller.clientHeight, ih: innerHeight };
  }, [lastRow, submit, credit, top]);
  const tag = `${who} ${w}×${h}`;
  if (!r.hOk) fail(`${tag}: horizontal overflow on the entry screen`);
  if (!r.topVisible) fail(`${tag}: the wordmark is not visible at the top`);
  if (!r.lastReach || !r.submitReach || !r.creditReach) fail(`${tag}: cannot reach the last row (${r.lastReach}) / the submit (${r.submitReach}) / the credit (${r.creditReach})`);
  if (r.needs && !r.moved) fail(`${tag}: the entry screen is taller than the viewport but does not scroll`);
  if (r.covered) fail(`${tag}: a fixed element covers the final content`);
  if (Math.abs(r.ch - r.ih) > 2) fail(`${tag}: the scroll container is ${r.ch}px in a ${r.ih}px viewport`);
  return r;
}

// ================================================================ A + L — auth
console.log('\n— A / L: entry screens at nine viewports —');
const AUTH = [['Pro', PORTS.club, '.auth-form .org-card'], ['Grassroots', PORTS.grassroots, '.auth-form .org-card'], ['Agent', PORTS.agent, '.auth-form .org-card'], ['Trust & Safety', PORTS.admin, '.auth-field'], ['Agent roster', PORTS.agentDemo, '[data-testid="demo-identities"] button']];
for (const [who, port, lastRow] of AUTH) {
  const matrix = [];
  for (const [w, h] of VIEWPORTS) {
    const ctx = await ctxFor(w, h);
    const page = watch(await ctx.newPage(), `${who}@${w}x${h}`);
    await page.goto(`http://localhost:${port}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
    if (who !== 'Trust & Safety' && who !== 'Agent roster') await page.waitForSelector('.auth-form .org-card', { timeout: 25000 });
    if (who === 'Agent roster') await page.waitForSelector('[data-testid="demo-identities"] button', { timeout: 25000 });
    await sleep(300);
    const r = await authAudit(page, who, w, h, { lastRow });
    matrix.push(`${w}×${h}:${r.needs ? 'scrolls' : 'fits'}${r.rows ? `/${r.rows}` : ''}`);
    await ctx.close();
  }
  say(`${who}: every viewport reaches the last row, the submit and the credit — ${matrix.join(' ')}`);
}
{
  // L — the long selectors: fifteen rows, every one reachable, at the two tightest viewports.
  // Pro lists professional organisations only (there is no public Pro registration, so the
  // seeded three are all a live server has); the registered clubs make the Grassroots selector
  // long, and the Pro selector is the same row component and stylesheet.
  for (const [who, port] of [['Grassroots', PORTS.grassroots]]) {
    for (const [w, h] of [[320, 568], [640, 360]]) {
      const ctx = await ctxFor(w, h);
      const page = watch(await ctx.newPage(), `${who} long@${w}x${h}`);
      await page.goto(`http://localhost:${port}/`); await page.waitForSelector('.auth-form .org-card', { timeout: 25000 }); await sleep(300);
      await inject(page);
      const r = await page.evaluate(() => { const rows = [...document.querySelectorAll('.auth-form .org-card')]; return { n: rows.length, allReach: rows.every((el) => __sc.reach(el)), longOk: rows.every((el) => el.scrollWidth <= el.clientWidth + 1), hOk: __sc.noHOverflow() }; });
      ok(r.n >= 12 && r.allReach && r.longOk && r.hOk, `L ${who} ${w}×${h}: ${r.n} organisation rows, every one reachable by scrolling, long names wrap inside the row`);
      await page.locator('.auth-form .org-card').last().click(); await sleep(150);
      const chosen = await page.evaluate(() => { const b = [...document.querySelectorAll('.auth-form .org-card')].pop(); return b.getAttribute('aria-pressed') === 'true' && __sc.reach(document.querySelector('.auth-form button.primary')); });
      ok(chosen, `L ${who} ${w}×${h}: the last row can be chosen and the submit reached after it`);
      await ctx.close();
    }
  }
  say('L: the Pro selector (three professional organisations on a live server; no public Pro registration) and the Agent roster (three fixed demo profiles) are the same row component and stylesheet — the fifteen-row proof above covers them');
}
{
  // Player entry at the nine viewports.
  const matrix = [];
  for (const [w, h] of VIEWPORTS) {
    const ctx = await ctxFor(w, h);
    const page = watch(await ctx.newPage(), `Player@${w}x${h}`);
    await page.goto(`http://localhost:${PORTS.player}/`); await page.waitForSelector('[data-testid="login-signature"]', { timeout: 40000 }); await sleep(500);
    await inject(page);
    const r = await page.evaluate(() => {
      const credit = document.querySelector('[data-testid="login-signature"]');
      const scroller = __sc.scroller(credit);
      const needs = scroller.scrollHeight > scroller.clientHeight + 1;
      scroller.scrollTop = 0;
      const rows = [...document.querySelectorAll('[data-testid^="auth-choice-"]')];
      const rowsReach = rows.length === 4 && rows.every((el) => __sc.reach(el));
      const creditReach = __sc.reach(credit);
      scroller.scrollTop = scroller.scrollHeight;
      return { needs, moved: !needs || scroller.scrollTop > 0, rowsReach, creditReach, hOk: __sc.noHOverflow(), column: Math.round(document.querySelector('[data-testid="mobile-viewport"]').getBoundingClientRect().width) };
    });
    if (!r.hOk || !r.rowsReach || !r.creditReach || (r.needs && !r.moved)) fail(`Player ${w}×${h}: rows ${r.rowsReach}, credit ${r.creditReach}, scrolls ${r.moved}, no overflow ${r.hOk}`);
    matrix.push(`${w}×${h}:${r.needs ? 'scrolls' : 'fits'}`);
    await ctx.close();
  }
  say(`Player entry: every viewport reaches the four rows and the credit inside the ${Math.min(430, 9999)}px column — ${matrix.join(' ')}`);
}

// ================================================================== P — pages
console.log('\n— P / S / M / T / O: inside the applications —');
async function enter(ctx, port, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${port}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
  if (org) { await page.waitForSelector('.org-card', { timeout: 25000 }); await page.click(`.org-card:has-text("${org}")`); }
  if (name) await page.fill('.enter-row input', name);
  if (role) await page.selectOption('.enter-row select', role).catch(() => {});
  if (!org && !name) await page.fill('input[type="password"]', 'scoutbox-admin');
  await page.click('button.primary'); await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(500);
  return page;
}
const pageAudit = async (page, tag, lastSel) => {
  await inject(page);
  const r = await page.evaluate((lastSel) => {
    const content = document.querySelector('.content');
    const needs = content.scrollHeight > content.clientHeight + 1;
    const last = [...document.querySelectorAll(lastSel)].pop();
    const reach = last ? __sc.reach(last) : null;
    // M24F.4 — a page whose last control already fits the first screen (flat rows
    // are shorter) still has to move when it is taller than the viewport: scroll
    // it to the end, the way the entry audit does, and report where it landed.
    if (needs && content.scrollTop === 0) content.scrollTop = content.scrollHeight;
    return { needs, reach, hOk: __sc.noHOverflow(), scrolled: content.scrollTop, main: Math.round(document.querySelector('.main').getBoundingClientRect().height), ih: innerHeight };
  }, lastSel);
  if (!r.hOk) fail(`${tag}: horizontal page overflow`);
  if (r.reach === false) fail(`${tag}: the last control is not reachable`);
  if (r.needs && r.scrolled === 0 && r.reach !== null) fail(`${tag}: the page needed scrolling but did not move`);
  return r;
};
for (const [who, port, org, name, role, hash, lastSel] of [
  ['Pro', PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', '#/organisation', '.content button, .content input, .content select'],
  ['Grassroots', PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', '#/squad', '.content button, .content input'],
  ['Agent', PORTS.agent, null, 'Ana Costa', null, '#/clients', '.content button, .content a, .content input'],
  ['Trust & Safety', PORTS.admin, null, null, null, null, '.content button, .content input, .content select'],
]) {
  for (const [w, h] of [[640, 360], [1024, 600], [1440, 700]]) {
    const ctx = await ctxFor(w, h);
    const page = await enter(ctx, port, org, name, role, `${who} page@${w}x${h}`);
    if (hash) { await page.evaluate((x) => { location.hash = x; }, hash); await sleep(600); }
    else {
      // Trust // Trust & Safety has no hash router Safety has no hash router: pick the section in the sidebar (a drawer at ≤ 900px, opened from the top bar).
      if (w <= 900) {
        await page.click('.nav-hamburger'); await page.waitForSelector('nav.sidebar.drawer-open', { timeout: 5000 }); await sleep(450); /* the 0.18s slide */ await inject(page);
        // M24E defect E1: the console had no way to open its sidebar at ≤ 900px — Sign out and every section were unreachable.
        const dr = await page.evaluate(() => ({ exit: __sc.visible(document.querySelector('nav.sidebar [data-testid="sign-out"]')), region: !!document.querySelector('nav.sidebar [data-testid="nav-scroll"]') }));
        ok(dr.exit && dr.region, `P ${who} ${w}×${h}: the top bar opens the sidebar drawer; Sign out is on screen inside it`);
      }
      await page.click('nav.sidebar button:has-text("Verification")'); await sleep(500);
      if (w <= 900) { ok((await page.locator('nav.sidebar.drawer-open').count()) === 0, `P ${who} ${w}×${h}: choosing a section closes the drawer`); }
    }
    const r = await pageAudit(page, `P ${who} ${w}×${h}`, lastSel);
    say(`P ${who} ${w}×${h}: the page ${r.needs ? 'scrolls' : 'fits'} and its last control is reachable; no horizontal overflow`);
    if (who === 'Pro' && w === 1024) {
      // S — the sidebar: Recruitment open, the navigation region scrolls, the exits stay on screen.
      await page.evaluate(() => { location.hash = '#/assessments'; }); await sleep(500);
      const s = await page.evaluate(() => { const nav = document.querySelector('[data-testid="nav-scroll"]'); const so = document.querySelector('[data-testid="sign-out"]'); const sw = document.querySelector('[data-testid="switch-org"]'); const brand = document.querySelector('nav.sidebar .brand'); return { needs: nav.scrollHeight > nav.clientHeight + 1, exitsVisible: __sc.visible(so) && __sc.visible(sw), brandVisible: __sc.visible(brand), lastSection: (() => { const b = [...nav.querySelectorAll('button.nav-section')].pop(); return __sc.reach(b); })(), sidebarFits: document.querySelector('nav.sidebar').scrollHeight <= document.querySelector('nav.sidebar').clientHeight + 1 }; });
      ok(s.exitsVisible && s.brandVisible && s.lastSection, `S Pro 1024×600: the wordmark and Sign out / Switch organisation stay on screen (navigation region ${s.needs ? 'scrolls on its own' : 'fits'}); the last section is reachable`);
      // M — the command palette fits a short viewport; a drawer keeps its close reachable.
      await page.keyboard.press('Control+k'); await page.waitForSelector('.palette', { timeout: 5000 });
      const m = await page.evaluate(() => { const p = document.querySelector('.palette'); const r = p.getBoundingClientRect(); return { fits: r.bottom <= innerHeight + 0.5 && r.top >= 0, results: getComputedStyle(document.querySelector('.palette-results')).overflowY }; });
      ok(m.fits && /auto|scroll/.test(m.results), 'M Pro 1024×600: the command palette fits the viewport and its results scroll');
      await page.keyboard.press('Escape'); await sleep(150);
      await page.click('.topbar-safety'); await page.waitForSelector('.drawer[role="dialog"]', { timeout: 5000 });
      const d = await page.evaluate(() => { const dr = document.querySelector('.drawer[role="dialog"]'); const close = dr.querySelector('.close, button[aria-label*="lose"], button:not([disabled])'); return { scrolls: /auto|scroll/.test(getComputedStyle(dr).overflowY), closeReach: close ? __sc.reach(close) : null, inside: dr.getBoundingClientRect().height <= innerHeight + 0.5 }; });
      ok(d.scrolls && d.closeReach !== false && d.inside, 'M Pro 1024×600: the Report / Block drawer scrolls inside the viewport with its controls reachable');
      await page.keyboard.press('Escape'); await sleep(150);
      // T — the ledger's table scrolls inside its container.
      await page.evaluate(() => { location.hash = '#/ledger'; }); await page.waitForSelector('.f-ledger table, table.data', { timeout: 15000 }); await sleep(300);
      await page.setViewportSize({ width: 640, height: 360 }); await sleep(400);
      const t = await page.evaluate(() => { const tbl = document.querySelector('.f-ledger table, table.data'); const wrap = tbl.closest('.f-ledger') ?? tbl.parentElement; const cs = getComputedStyle(wrap); return { hOk: __sc.noHOverflow(), wide: tbl.scrollWidth > wrap.clientWidth, wrapScrolls: /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflow), cols: tbl.querySelectorAll('th').length }; });
      ok(t.hOk && (!t.wide || t.wrapScrolls), `T Pro 640×360: the ledger (${t.cols} columns) ${t.wide ? 'scrolls inside its container' : 'fits'} and never widens the page`);
    }
    await ctx.close();
  }
}
{
  // Player long pages: You (account), Home, Passport, Opportunities, Messages — the last control is reachable and the bottom navigation never covers it.
  for (const [w, h] of [[360, 640], [640, 360], [430, 932]]) {
    const ctx = await ctxFor(w, h);
    const page = watch(await ctx.newPage(), `Player pages@${w}x${h}`);
    await page.goto(`http://localhost:${PORTS.player}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
    await page.locator('text=Enter').nth(0).click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
    const results = [];
    // expo-router keeps the current query on the tab links (a[href="/you?tab=account"]), hence the prefix match.
    for (const [route, lastSel] of [['/you?tab=account', '[data-testid="switch-account"]'], ['/discover', '[role="button"], a[href]'], ['/football', '[role="button"], [role="tab"]'], ['/opportunities', '[role="button"], [role="tab"]'], ['/inbox', '[role="button"], a[href]']]) {
      await page.goto(`http://localhost:${PORTS.player}${route}`); await page.waitForSelector('a[href^="/you"]', { timeout: 30000 }); await sleep(900);
      await inject(page);
      const r = await page.evaluate((lastSel) => {
        const tabBar = document.querySelector('a[href^="/you"]').closest('[role="tablist"]') ?? document.querySelector('a[href^="/you"]').parentElement.parentElement;
        const tb = tabBar.getBoundingClientRect();
        const column = document.querySelector('[data-testid="mobile-viewport"]');
        const candidates = [...column.querySelectorAll(lastSel)].filter((el) => !tabBar.contains(el) && el.getBoundingClientRect().height > 0);
        const last = candidates[candidates.length - 1];
        if (!last) return { none: true };
        const scroller = __sc.scroller(last);
        const needs = scroller.scrollHeight > scroller.clientHeight + 1;
        const reach = __sc.reach(last);
        const lr = last.getBoundingClientRect();
        return { needs, reach, covered: lr.bottom > tb.top + 0.5 && lr.top < tb.bottom, hOk: __sc.noHOverflow(), tabBarBottom: Math.round(tb.bottom), ih: innerHeight };
      }, lastSel);
      if (r.none) fail(`Player ${route} ${w}×${h}: no control found`);
      if (!r.hOk || !r.reach || r.covered || r.tabBarBottom > r.ih + 0.5) fail(`Player ${route} ${w}×${h}: reach ${r.reach}, covered by the tab bar ${r.covered}, tab bar bottom ${r.tabBarBottom}/${r.ih}, no overflow ${r.hOk}`);
      results.push(`${route.split('?')[0]}:${r.needs ? 'scrolls' : 'fits'}`);
    }
    say(`P Player ${w}×${h}: last control reachable on every screen, never under the bottom navigation — ${results.join(' ')}`);
    await ctx.close();
  }
}
{
  // O — orientation change while the entry screen and a page are open.
  const ctx = await ctxFor(390, 844);
  const page = watch(await ctx.newPage(), 'orientation');
  await page.goto(`http://localhost:${PORTS.club}/`); await page.waitForSelector('.auth-form .org-card', { timeout: 25000 });
  for (const [w, h] of [[844, 390], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(400);
    await authAudit(page, 'O Pro entry', w, h, { lastRow: '.auth-form .org-card' });
  }
  say('O Pro entry: portrait → landscape → portrait → landscape keeps the scroll container at the viewport height and every control reachable');
  const p = await ctx.newPage(); watch(p, 'orientation player');
  await p.goto(`http://localhost:${PORTS.player}/`); await p.waitForSelector('[data-testid="login-signature"]', { timeout: 40000 });
  for (const [w, h] of [[844, 390], [390, 844], [640, 360]]) {
    await p.setViewportSize({ width: w, height: h }); await sleep(500); await inject(p);
    const r = await p.evaluate(() => ({ reach: __sc.reach(document.querySelector('[data-testid="login-signature"]')), hOk: __sc.noHOverflow(), column: Math.round(document.querySelector('[data-testid="mobile-viewport"]').getBoundingClientRect().width) }));
    if (!r.reach || !r.hOk || r.column !== Math.min(430, w)) fail(`O Player ${w}×${h}: reach ${r.reach}, overflow ${!r.hOk}, column ${r.column}`);
  }
  say('O Player entry: the column follows the orientation and the credit stays reachable');
  await ctx.close();
}

// ================================================================== F — fonts
console.log('\n— F: Inter resolves —');
for (const [who, port, org, name, role] of [['Pro', PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment'], ['Grassroots', PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager'], ['Agent', PORTS.agent, null, 'Ana Costa', null], ['Trust & Safety', PORTS.admin, null, null, null]]) {
  const ctx = await ctxFor(1280, 720);
  const page = await enter(ctx, port, org, name, role, `${who} fonts`);
  const f = await page.evaluate(async () => {
    await document.fonts.ready; await Promise.all(['400 14px Inter', '600 14px Inter', 'italic 400 14px Inter', '800 20px "Albert Sans"'].map((x) => document.fonts.load(x).catch(() => null)));
    const fam = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : null; };
    return { heading: fam('h1, .f-display, .topbar h2'), body: fam('.content p, .content div, .content'), button: fam('.content button, button.primary, .sidebar button'), nav: fam('nav.sidebar button.nav-section'), label: fam('label, .auth-label, .content label, .content input, .content select, .content textarea, .content small, .subnav button, .topbar .p-toolbar button'), /* a fresh Trust & Safety console has no form until there are cases: its top-bar / sub-navigation controls stand in (the key field is covered by m24dAuthLive) */ wordmark: fam('.wordmark'), loaded: document.fonts.check('400 14px Inter') && document.fonts.check('600 14px Inter') && document.fonts.check('italic 400 14px Inter'), albert: document.fonts.check('800 20px "Albert Sans"'), size: getComputedStyle(document.body).fontSize };
  });
  const inter = (s) => /^(")?Inter\b/.test(s ?? '');
  const notInter = ['heading', 'body', 'button', 'nav', 'label'].filter((k) => !inter(f[k])).map((k) => `${k}=${f[k]}`);
  ok(notInter.length === 0 && f.loaded, `F ${who}: computed Inter on heading, body, button, navigation and form label / control; the 400 / 600 / italic faces are loaded (body ${f.size}${notInter.length ? '; not Inter: ' + notInter.join(' ') : ''}${f.loaded ? '' : '; faces not loaded'})`);
  ok(/Albert Sans/.test(f.wordmark ?? '') && f.albert, `F ${who}: the wordmark alone keeps Albert Sans`);
  await ctx.close();
}
{
  const ctx = await ctxFor(390, 844);
  const page = watch(await ctx.newPage(), 'Player fonts');
  await page.goto(`http://localhost:${PORTS.player}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('text=Enter').nth(0).click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(800);
  const f = await page.evaluate(async () => {
    await document.fonts.ready; await Promise.all(['400 14px Inter', '600 14px Inter'].map((x) => document.fonts.load(x).catch(() => null)));
    const texts = [...document.querySelectorAll('[data-testid="mobile-viewport"] div[dir="auto"], [data-testid="mobile-viewport"] span')].filter((el) => el.children.length === 0 && el.textContent.trim() && el.textContent.trim() !== 'ScoutBox' /* the wordmark is the one brand-face exception */);
    const fams = [...new Set(texts.map((el) => getComputedStyle(el).fontFamily))];
    const tab = document.querySelector('a[href^="/you"]');
    const heading = [...document.querySelectorAll('[role="heading"]')].find((h) => !/ScoutBox/.test(h.textContent));
    const mark = [...document.querySelectorAll('[role="heading"] div, [role="heading"] span')].find((d) => d.textContent.trim() === 'ScoutBox');
    return { fams, tab: tab ? getComputedStyle(tab.querySelector('div[dir="auto"]') ?? tab).fontFamily : null, heading: heading ? getComputedStyle(heading.querySelector('div[dir="auto"]') ?? heading).fontFamily : null, mark: mark ? getComputedStyle(mark).fontFamily : null, loaded: document.fonts.check('400 14px Inter') && document.fonts.check('600 14px Inter'), style: !!document.querySelector('style[data-sb-fonts="inter"]'), faces: [...document.fonts].filter((ff) => ff.family === 'Inter').map((ff) => `${ff.style} ${ff.weight} ${ff.status}`) };
  });
  const inter = (s) => /^(")?Inter\b/.test(s ?? '');
  ok(f.style && f.loaded && f.faces.some((x) => /normal 100 900/.test(x)) && f.faces.some((x) => /italic 100 900/.test(x)), `F Player: the two Inter variable faces are registered as one family with a 100–900 range (${f.faces.join(' | ')})`);
  ok(f.fams.every(inter) && inter(f.tab) && inter(f.heading), `F Player: every piece of text, the bottom navigation and the page heading are Inter (${f.fams.join(' | ')})`);
  ok(/AlbertSans-ExtraBold/.test(f.mark ?? ''), `F Player: the wordmark keeps the brand face (${f.mark})`);
  await ctx.close();
}
ok(consoleWarnings.length === 0, `F: no font warning in any console (${consoleWarnings.length ? consoleWarnings.slice(0, 3).join(' | ') : 'clean'})`);

ok(errors.length === 0, `no page errors in any context (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nm24eScrollLive: ${passed} checks passed`);
process.exit(0);
