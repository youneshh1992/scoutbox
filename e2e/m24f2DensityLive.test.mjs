// M24F.2 — live density / categorisation / brand journeys in a real browser
// against the real bundles and a live scoutbox-server:
//   P  the Player's You › Clubs (four categories) and You › Account (four
//      categories): the tabs work, every category reaches its content, deep
//      links / back / forward / refresh behave, the roots are shorter than
//      the M24F.1 roots, no horizontal overflow;
//   G  the Grassroots entry (photograph on the introduction, no diagonal,
//      the centre-circle motif, no bullet points), the LIGHT workspace
//      (navy sidebar, cool canvas, the Home's hierarchy), the DARK workspace
//      unchanged against the frozen M24E fixture;
//   A  the Agent's active navigation in gold at both themes, not colour-only;
//   W  the ScoutBox™ lock-up: the TM raised over the square, tight, labelled
//      "trademark", on the Player, Grassroots and Agent at 390 / 640×360 /
//      1024 / 1440.
// Zero page errors. Shares its bundles with m24fVisualLive (same API port,
// same dist folder): KEEP_DIST=1 reuses them. Never run two live suites at once.
//
// Run from e2e/: node m24f2DensityLive.test.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4064;
const API = `http://localhost:${API_PORT}`;
const PORTS = { grassroots: 8802, agent: 8803, agentDemo: 8805, player: 8884, playerDemo: 8885 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24f2-'));
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24fv';
const VIEWS = [[390, 844], [640, 360], [1024, 700], [1440, 900]];
let passed = 0; const errors = []; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) { try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch { /* free */ } }
const bundles = [['scoutbox-grassroots', PORTS.grassroots, DIST], ['scoutbox-agent', PORTS.agent, DIST], ['scoutbox-agent', PORTS.agentDemo, `${DIST}-demo`], ['scoutbox-player', PORTS.player, DIST], ['scoutbox-player', PORTS.playerDemo, `${DIST}-demo`]];
if (KEEP && bundles.every(([app, , dist]) => fs.existsSync(path.join(ROOT, app, dist, 'index.html')))) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  for (const [app, , dist] of bundles) {
    if (app === 'scoutbox-player' && dist.endsWith('-demo')) execSync(`EXPO_PUBLIC_DEMO=1 npx expo export --clear --platform web --output-dir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else if (app === 'scoutbox-player') execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else if (dist.endsWith('-demo')) execSync(`VITE_DEMO=1 npx vite build --outDir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else execSync(`VITE_API_URL=${API} npx vite build --outDir ${dist}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
  }
}
const serverProc = spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
  const s = http.createServer((req, res) => {
    let f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(port);
  statics.push(s);
}
for (const [app, port, dist] of bundles) serveDir(`${app}/${dist}`, port);
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctxFor = (w, h, store = {}) => browser.newContext({ viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}), storageState: { cookies: [], origins: Object.entries(store).map(([origin, kv]) => ({ origin, localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })) })) } });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); return page; };
const origin = (port) => `http://localhost:${port}`;
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'e2e/fixtures/m24e-grassroots-dark-tokens.json'), 'utf8'));

// the scroll container that holds the Player's page (the MobileViewport column scrolls, not the document)
const SCROLL_H = `(() => { const a = document.querySelector('[role="tablist"] [role="tab"]') ?? document.body; let e = a; while (e && e !== document.documentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e.scrollHeight; e = e.parentElement; } return document.scrollingElement.scrollHeight; })()`;
const OVERFLOW = `(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth)`;
// the ™ lock-up geometry inside a scope (portals: .wordmark + .tm siblings)
const TM = (scope) => `(() => { const s = document.querySelector(${JSON.stringify(scope)}); if (!s) return null; const wm = s.querySelector('.wordmark'); const tm = s.querySelector('.tm'); if (!wm || !tm) return { missing: true }; const w = wm.getBoundingClientRect(), t = tm.getBoundingClientRect(); const cs = getComputedStyle(tm); return { gap: Math.round((t.left - w.right) * 10) / 10, raised: t.top < w.top + w.height / 2, size: parseFloat(cs.fontSize), label: tm.getAttribute('aria-label'), text: wm.textContent.trim(), tmText: tm.textContent.trim(), visible: t.width > 0 && t.height > 0 }; })()`;
function checkTm(tag, g) {
  ok(!!g && !g.missing && g.visible, `${tag}: the wordmark and its ™ are rendered`);
  if (!g || g.missing) return;
  ok(g.text === 'ScoutBox' && g.tmText === 'TM' && g.label === 'trademark', `${tag}: the brand reads "ScoutBox" and the mark is announced as "trademark"`);
  ok(g.gap >= -9 && g.gap <= 2, `${tag}: the ™ sits over the square, tight to the final "x" (offset ${g.gap}px from the word's edge, square included)`);
  ok(g.raised && g.size <= 10, `${tag}: the ™ is raised (upper half) and small (${g.size}px)`);
}

async function enter(ctx, port, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`${origin(port)}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
  if (org) { await page.waitForSelector('.org-card', { timeout: 25000 }); await page.click(`.org-card:has-text("${org}")`); }
  if (name) await page.fill('.enter-row input', name);
  if (role) await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button.primary'); await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(500);
  return page;
}

// ================================================================== P — the Player
console.log('\n— P: the Player — You › Clubs and You › Account —');
async function playerIn(page, port = PORTS.player) {
  await page.goto(`${origin(port)}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('[data-testid="demo-identities"] >> text=Enter').first().click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(500);
}
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
for (const [w, h] of VIEWS) {
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), `player ${w}x${h}`);
  const tag = `Player ${w}×${h}`;
  await playerIn(page);
  // the ™ on the Player header (Wordmark.tsx): the mark column sits 2px after the word
  const pw = await page.evaluate(() => { const m = document.querySelector('[data-testid="wordmark-mark"]'); if (!m) return null; const t = m.previousElementSibling; if (!t) return { missing: true }; const mr = m.getBoundingClientRect(), tr = t.getBoundingClientRect(); const tm = m.firstElementChild; const tmr = tm.getBoundingClientRect(); return { gap: Math.round((mr.left - tr.right) * 10) / 10, raised: tmr.top < tr.top + tr.height / 2, size: parseFloat(getComputedStyle(tm).fontSize), textSize: parseFloat(getComputedStyle(t).fontSize), label: tm.getAttribute('aria-label') ?? m.getAttribute('aria-label'), text: t.textContent.trim(), tmText: tm.textContent.trim() }; });
  ok(!!pw && !pw.missing, `${tag}: the Wordmark renders its mark column`);
  if (pw && !pw.missing) {
    ok(pw.text === 'ScoutBox' && pw.tmText === 'TM' && pw.label === 'trademark', `${tag}: "ScoutBox" + a mark announced as "trademark"`);
    ok(pw.gap >= 0 && pw.gap <= 6, `${tag}: the mark column starts ${pw.gap}px after the word (2–6px)`);
    ok(pw.raised && pw.size <= Math.max(10, pw.textSize * 0.32), `${tag}: the TM is raised and small (${pw.size}px on a ${pw.textSize}px word)`);
  }
  await page.click('a[href^="/you"]'); await sleep(700);
  await page.getByRole('tab', { name: /^Clubs$/ }).first().click(); await sleep(900);
  const clubs = await page.evaluate(() => { const pageEl = document.querySelector('[data-testid="clubs-page"]'); const tabs = pageEl ? [...pageEl.querySelectorAll('[role="tablist"] [role="tab"]')] : []; return { page: !!pageEl, names: tabs.map((t) => t.textContent.trim()), selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, minH: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)), current: !!document.querySelector('[data-testid="clubs-current"]') }; });
  ok(clubs.page && clubs.names.length === 4 && clubs.names.length <= 5, `${tag} Clubs: ${clubs.names.length} categories (≤ 5): ${clubs.names.join(' / ')}`);
  ok(clubs.selected === 1 && clubs.minH >= 40 && clubs.current, `${tag} Clubs: one selected tab, ≥40px targets, Current is the default`);
  const rootH = await page.evaluate(SCROLL_H);
  ok(rootH <= 2700, `${tag} Clubs root: ${rootH}px of scroll (M24F.1 root was 4450px at 390)`);
  ok(!(await page.evaluate(OVERFLOW)), `${tag} Clubs: no horizontal overflow`);
  for (const [name, id] of [['Requests', 'clubs-requests'], ['Development', 'clubs-development'], ['History', 'clubs-history']]) {
    await page.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') }).first().click(); await sleep(700);
    const url = page.url();
    ok(await vis(page, `[data-testid="${id}"]`) && new RegExp(`section=${id.replace('clubs-', '')}`).test(url), `${tag} Clubs › ${name}: its content is reachable and the URL carries ?section= (${new URL(url).search})`);
    ok(!(await page.evaluate(OVERFLOW)), `${tag} Clubs › ${name}: no horizontal overflow`);
  }
  // back / forward move between sections
  await page.goBack(); await sleep(600);
  ok(await vis(page, '[data-testid="clubs-development"]'), `${tag} Clubs: browser back returns to Development`);
  await page.goForward(); await sleep(600);
  ok(await vis(page, '[data-testid="clubs-history"]'), `${tag} Clubs: browser forward returns to History`);
  // keyboard: Enter on a focused tab opens it and keeps focus
  await page.evaluate(() => { const t = [...document.querySelectorAll('[data-testid="clubs-page"] [role="tab"]')].find((x) => /Current/i.test(x.textContent)); t.focus(); });
  await page.keyboard.press('Enter'); await sleep(600);
  const kb = await page.evaluate(() => ({ current: !!document.querySelector('[data-testid="clubs-current"]'), focused: /Current/i.test(document.activeElement?.textContent ?? '') && document.activeElement.getAttribute('role') === 'tab' }));
  ok(kb.current && kb.focused, `${tag} Clubs: Enter on the focused Current tab opens it and keeps focus`);
  // deep link + refresh
  await page.goto(`${origin(PORTS.player)}/you?tab=clubs&section=development`); await page.waitForSelector('[data-testid="clubs-page"]', { timeout: 20000 }); await sleep(600);
  ok(await vis(page, '[data-testid="clubs-development"]'), `${tag}: /you?tab=clubs&section=development opens Development`);
  await page.reload(); await page.waitForSelector('[data-testid="clubs-page"]', { timeout: 20000 }); await sleep(600);
  ok(await vis(page, '[data-testid="clubs-development"]'), `${tag}: refresh keeps Development`);
  // Account
  await page.getByRole('tab', { name: /^Account$/ }).first().click(); await sleep(900);
  const acc = await page.evaluate(() => { const rows = ['profile', 'privacy', 'preferences', 'appearance'].map((k) => document.querySelector(`[data-testid="account-cat-${k}"]`)); return { root: !!document.querySelector('[data-testid="account-root"]'), rows: rows.filter(Boolean).length, singleLine: rows.filter(Boolean).every((r) => !/\n/.test(r.innerText.trim().replace(/Light or dark/, ''))), exits: ['sign-out', 'switch-account'].every((k) => { const e = document.querySelector(`[data-testid="${k}"]`); return e && e.getBoundingClientRect().height > 0; }), order: (() => { const list = document.querySelector('[data-testid="account-cat-appearance"]'); const exit = document.querySelector('[data-testid="switch-account"]'); return list && exit && list.getBoundingClientRect().top < exit.getBoundingClientRect().top; })() }; });
  ok(acc.root && acc.rows === 4, `${tag} Account: the root list of four categories`);
  ok(acc.singleLine, `${tag} Account: no sub-note under a category row`);
  ok(acc.exits && acc.order, `${tag} Account: Switch account and Sign out beneath the list`);
  const accH = await page.evaluate(SCROLL_H);
  ok(accH <= 1100, `${tag} Account root: ${accH}px of scroll (M24F.1 root was 1280px at 390)`);
  for (const k of ['profile', 'privacy', 'preferences', 'appearance']) {
    await page.click(`[data-testid="account-cat-${k}"]`); await sleep(700);
    ok(await vis(page, `[data-testid="account-section-${k}"]`) && new RegExp(`section=${k}`).test(page.url()), `${tag} Account › ${k}: opens with ?section=${k}`);
    ok(!(await page.evaluate(OVERFLOW)), `${tag} Account › ${k}: no horizontal overflow`);
    await page.click('[data-testid="account-back"]'); await sleep(500);
    ok(await vis(page, '[data-testid="account-root"]'), `${tag} Account › ${k}: the back control returns to the root`);
  }
  await page.goto(`${origin(PORTS.player)}/you?tab=account&section=privacy`); await page.waitForSelector('[data-testid="account-section-privacy"]', { timeout: 20000 }); await sleep(500);
  ok(await vis(page, '[data-testid="account-section-privacy"]') && await vis(page, '[data-testid="account-rules"]'), `${tag}: /you?tab=account&section=privacy opens Privacy with the safeguarding rules in reach`);
  await page.goBack(); await sleep(600);
  ok(await vis(page, '[data-testid="account-root"]'), `${tag} Account: browser back from a category returns to the root`);
  await ctx.close();
}
{
  // the demo carries club feedback: Development shows one sentence and the counts; "View details" holds the rest
  const ctx = await ctxFor(390, 844); const page = watch(await ctx.newPage(), 'player demo development');
  await playerIn(page, PORTS.playerDemo);
  await page.goto(`${origin(PORTS.playerDemo)}/you?tab=clubs&section=development`); await page.waitForSelector('[data-testid="clubs-development"]', { timeout: 20000 }); await sleep(600);
  const before = await page.evaluate(() => document.querySelector('[data-testid="clubs-development"]').innerText.length);
  const details = page.locator('[data-testid^="clubs-dev-details-"]').first();
  ok(await details.count() > 0, 'Player demo Clubs › Development: a "View details" disclosure per club');
  await details.click(); await sleep(500);
  const after = await page.evaluate(() => ({ len: document.querySelector('[data-testid="clubs-development"]').innerText.length, primaries: [...document.querySelectorAll('[data-testid="clubs-development"] [role="button"]')].filter((b) => /rgb\(0, 230, 118\)|rgb\(51, 238, 124\)/.test(getComputedStyle(b).backgroundColor)).length }));
  ok(after.len > before && after.primaries >= 1, `Player demo Clubs › Development: "View details" reveals the feedback texts and Log progress is the one primary inside (${after.primaries})`);
  await ctx.close();
}

// ================================================================== G — Grassroots
console.log('\n— G: the Grassroots entry and workspace —');
for (const [w, h] of VIEWS) {
  const ctx = await ctxFor(w, h, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': 'light' } });
  const page = watch(await ctx.newPage(), `grassroots entry ${w}x${h}`);
  await page.goto(`${origin(PORTS.grassroots)}/`); await page.waitForSelector('.org-card', { timeout: 25000 }); await sleep(400);
  const r = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); const promo = document.querySelector('.auth-promo'); const bg = cs(promo).backgroundImage; return { photo: /url\(/.test(bg), circle: /radial-gradient/.test(bg), diagonal: /repeating-linear-gradient/.test(bg) || /linear-gradient\((?!180deg)\s*\d+deg/.test(bg), points: document.querySelectorAll('.auth-points li').length, notes: document.querySelectorAll('.auth-promo .auth-note').length, h2: document.querySelector('.auth-promo h2')?.textContent.trim(), summary: !!document.querySelector('.auth-summary'), img: document.querySelectorAll('.auth-promo img').length, labelled: !!promo.getAttribute('aria-labelledby'), formImage: cs(document.querySelector('.auth-form')).backgroundImage }; });
  const tag = `Grassroots entry ${w}×${h}`;
  ok(r.photo && !r.diagonal, `${tag}: the grass photograph on the introduction, no diagonal line`);
  ok(r.circle, `${tag}: the subtle centre-circle motif is drawn over the photograph`);
  ok(r.points === 0 && r.notes === 0 && r.h2 === 'Your club. Your community. Your next player.' && r.summary, `${tag}: the headline and one sentence — no bullet points, no demo notice`);
  ok(r.img === 0 && r.labelled && r.formImage === 'none', `${tag}: the motif is decorative CSS (no img), the panel is named by its headline, the form carries no image`);
  ok(!(await page.evaluate(OVERFLOW)), `${tag}: no horizontal overflow`);
  checkTm(`${tag} ™`, await page.evaluate(TM('.auth-form h1')));
  await ctx.close();
}
for (const [w, h] of [[390, 844], [1024, 700], [1440, 900]]) {
  const ctx = await ctxFor(w, h, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': 'light' } });
  const page = await enter(ctx, PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', `grassroots light ${w}`);
  await page.waitForSelector('[data-testid="grass-home"]', { timeout: 15000 }); await sleep(600);
  const tag = `Grassroots light ${w}px`;
  const r = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); const content = document.querySelector('.content'); const sb = document.querySelector('nav.sidebar'); const sbVisible = sb && sb.getBoundingClientRect().width > 0 && sb.getBoundingClientRect().left >= 0 && cs(sb).display !== 'none'; const primaries = [...content.querySelectorAll('button.primary')].filter((b) => b.getBoundingClientRect().height > 0); const order = ['home-welcome', 'home-primary', 'home-summary', 'home-progress', 'home-activity', 'home-quick'].map((k) => document.querySelector(`[data-testid="${k}"]`)?.getBoundingClientRect().top ?? null); return { content: cs(content).backgroundColor, image: cs(content).backgroundImage, sidebar: sbVisible ? cs(sb).backgroundColor : null, sbVisible, ink: cs(content).color, primaries: primaries.length, primaryText: primaries[0]?.textContent.trim(), order, percent: /\d+\s?%/.test(document.querySelector('[data-testid="home-progress"]')?.innerText ?? ''), progressRows: document.querySelectorAll('[data-testid="home-progress"] .home-row').length, activityRows: document.querySelectorAll('[data-testid="home-activity"] .home-row').length, quick: document.querySelectorAll('[data-testid="home-quick"] button').length, active: sbVisible ? (() => { const a = sb.querySelector('button.active'); return a ? { color: cs(a).color, shadow: cs(a).boxShadow } : null; })() : null, signOut: sbVisible ? cs(sb.querySelector('[data-testid="sign-out"]')).color : null, overflow: document.documentElement.scrollWidth > innerWidth }; });
  ok(r.content === 'rgb(247, 249, 252)' && r.image === 'none' && r.ink === 'rgb(11, 28, 45)', `${tag}: the cool canvas, no pitch lines and no photograph, navy ink (${r.content})`);
  if (r.sbVisible) {
    ok(r.sidebar === 'rgb(6, 56, 86)', `${tag}: the navy sidebar (${r.sidebar})`);
    ok(!!r.active && r.active.color === 'rgb(255, 255, 255)' && /inset/.test(r.active.shadow), `${tag}: the active destination is white on the green wash with an inset bar (not colour-only)`);
    ok(r.signOut === 'rgb(255, 180, 168)', `${tag}: Sign out is a readable red on navy (${r.signOut})`);
    checkTm(`${tag} sidebar ™`, await page.evaluate(TM('nav.sidebar .brand')));
  }
  ok(r.primaries === 1 && r.primaryText, `${tag} Home: exactly one primary action — "${r.primaryText}"`);
  ok(r.order.every((t) => t !== null) && r.order.every((t, i) => i === 0 || t > r.order[i - 1]), `${tag} Home: welcome → primary → summary → progress → activity → quick actions, in that order`);
  ok(!r.percent && r.progressRows >= 4, `${tag} Home: Club progress is ${r.progressRows} honest facts, no percentage`);
  ok(r.activityRows <= 8 && r.quick === 4, `${tag} Home: ≤ 8 compact activity rows (${r.activityRows}), 4 quick actions`);
  ok(!r.overflow, `${tag}: no horizontal overflow`);
  // the Home's progress row navigates
  await page.click('[data-testid="home-progress"] .home-row >> nth=0'); await sleep(700);
  ok(/#\/verification/.test(page.url()) || !(await vis(page, '[data-testid="grass-home"]')), `${tag} Home: a progress row opens its destination`);
  await ctx.close();
}
{
  const ctx = await ctxFor(1440, 900, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': 'dark' } });
  const page = await enter(ctx, PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', 'grassroots dark');
  const r = await page.evaluate((names) => { const cs = getComputedStyle(document.documentElement); const tokens = {}; for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) tokens[n] = v; } const el = (s) => { const e = document.querySelector(s); return e ? { bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color } : null; }; return { theme: document.documentElement.getAttribute('data-theme'), tokens, computed: { content: el('.content'), sidebar: el('nav.sidebar'), topbar: el('.topbar'), body: el('body'), navActive: el('nav.sidebar button.active, nav.sidebar .nav-section.active') }, image: getComputedStyle(document.querySelector('.content')).backgroundImage }; }, Object.keys(frozen.tokens));
  const diff = Object.keys(frozen.tokens).filter((k) => frozen.tokens[k] !== r.tokens[k]);
  ok(r.theme === 'dark' && diff.length === 0, `Grassroots dark: the ${Object.keys(frozen.tokens).length} frozen M24E tokens are unchanged${diff.length ? ` (${diff.join(', ')})` : ''}`);
  ok(['content', 'sidebar', 'topbar', 'body', 'navActive'].every((k) => JSON.stringify(frozen.computed[k]) === JSON.stringify(r.computed[k])), 'Grassroots dark: the workspace, sidebar, top bar, body and active navigation render the M24E colours');
  ok(/repeating-linear-gradient/.test(r.image) && !/url\(/.test(r.image), 'Grassroots dark: the M24E grain stays, no photograph');
  await ctx.close();
}

// ================================================================== A — the Agent in gold
console.log('\n— A: the Agent active navigation —');
const GOLD = { dark: { text: 'rgb(208, 181, 123)', bar: 'rgb(199, 169, 107)' }, light: { text: 'rgb(122, 90, 28)', bar: 'rgb(166, 124, 46)' } };
for (const theme of ['dark', 'light']) {
  const ctx = await ctxFor(1440, 900, { [origin(PORTS.agent)]: { 'sb-theme:agent': theme } });
  const page = await enter(ctx, PORTS.agent, null, 'Ana Costa', null, `agent ${theme}`);
  const tag = `Agent ${theme}`;
  const read = () => page.evaluate(() => { const a = document.querySelector('nav.sidebar button.active'); if (!a) return null; const cs = getComputedStyle(a); const icon = a.querySelector('svg'); return { text: a.textContent.trim(), color: cs.color, bg: cs.backgroundColor, shadow: cs.boxShadow, icon: icon ? getComputedStyle(icon).color : null, current: a.getAttribute('aria-current') }; });
  const home = await read();
  ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, `${tag}: the ${theme} workspace`);
  ok(!!home && home.color === GOLD[theme].text && /inset/.test(home.shadow) && home.shadow.includes(GOLD[theme].bar), `${tag} Home: active text ${home?.color} (gold), inset bar in ${GOLD[theme].bar}`);
  ok(!!home && !/rgb\(0, 230, 118\)|rgb\(51, 238, 124\)/.test(`${home.color} ${home.bg} ${home.shadow} ${home.icon}`), `${tag} Home: no green on the active destination`);
  ok(!!home && (home.icon === GOLD[theme].bar || home.icon === GOLD[theme].text), `${tag} Home: the icon follows the gold (${home?.icon})`);
  for (const dest of ['Clients', 'Transactions', 'Inbox']) {
    const btn = page.locator(`nav.sidebar button:has-text("${dest}")`).first();
    if (await btn.count() === 0) continue;
    await btn.click(); await sleep(600);
    const r = await read();
    ok(!!r && new RegExp(dest).test(r.text) && r.color === GOLD[theme].text && /inset/.test(r.shadow), `${tag} ${dest}: active in gold with the inset bar`);
  }
  checkTm(`${tag} sidebar ™`, await page.evaluate(TM('nav.sidebar .brand')));
  await ctx.close();
}
for (const [w, h] of VIEWS) {
  const ctx = await ctxFor(w, h, { [origin(PORTS.agentDemo)]: { 'sb-theme:agent': 'dark' } });
  const page = watch(await ctx.newPage(), `agent entry ${w}x${h}`);
  await page.goto(`${origin(PORTS.agentDemo)}/`); await page.waitForSelector('.auth-card', { timeout: 25000 }); await sleep(300);
  checkTm(`Agent entry ${w}×${h} ™`, await page.evaluate(TM('.auth-form h1')));
  ok(!(await page.evaluate(OVERFLOW)), `Agent entry ${w}×${h}: no horizontal overflow`);
  await ctx.close();
}

await browser.close();
serverProc.kill('SIGTERM');
for (const s of statics) s.close();
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\nm24f2DensityLive: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}; page errors: ${errors.length}`);
if (errors.length) console.log(errors.join('\n'));
if (failures.length || errors.length) process.exit(1);
