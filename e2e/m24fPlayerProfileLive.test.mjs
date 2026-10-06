// M24F.1 — the Player profile, live, in a real browser: the live Player
// bundle against a live scoutbox-server (Kola Adeyemi, seeded; a freshly
// signed-up player with a long name and a long city) and the self-contained
// demo bundle (Kola with a pending trial invitation — the current-action
// state). Widths 320×568, 360×640, 390×844, 430×932 and 640×360 landscape.
//
// Asserts: zero page errors; the header reads the server's own values (no
// fabricated data); four accessible section tabs (role, selection, keyboard,
// 44px targets); every section reachable with the bottom navigation never
// covering the last content; no horizontal overflow; deep links and
// back/forward; the long name wraps without overflow; the initials avatar
// when there is no photograph; the one current action and the calm
// no-action state; system UI on every profile text; no pictograph; and the
// Journey never carries a club's private words.
//
// Run from e2e/: node m24fPlayerProfileLive.test.mjs   (KEEP_DIST=1 reuses bundles)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4066;
const API = `http://localhost:${API_PORT}`;
const PORTS = { player: 8884, playerDemo: 8885 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24fprofile-'));
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24fp';
const SHOTS = process.env.SHOTS_DIR || null; // optional: write the after-captures named in the brief
const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932], [640, 360]];
let passed = 0; const errors = []; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch { /* free */ }
}
const bundles = [['scoutbox-player', PORTS.player, DIST], ['scoutbox-player', PORTS.playerDemo, `${DIST}-demo`]];
if (KEEP && bundles.every(([app, , dist]) => fs.existsSync(path.join(ROOT, app, dist, 'index.html')))) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building the Player bundles for :${API_PORT}…`);
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_DEMO=1 npx expo export --clear --platform web --output-dir ${DIST}-demo`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
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
const j = async (method, p, body, token) => { const r = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); let b = null; try { b = await r.json(); } catch { /* no body */ } return { status: r.status, body: b }; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const origin = (port) => `http://localhost:${port}`;
const ctxFor = (w, h) => browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('dialog', (d) => d.accept()); return page; };
async function enterSeeded(page, port, idx = 0) {
  await page.goto(`${origin(port)}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const rows = page.locator('text=Enter'); await rows.nth(idx).click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(400);
}
const openProfile = async (page) => { await page.click('a[href^="/you"]'); await page.waitForSelector('[data-testid="profile-header"]', { timeout: 30000 }); await sleep(500); };
const PRIVATE = /watchlist|priority|second look|decision rationale|rationale|internal note|recruitment room|private assessment|scouting opinion|shortlist(?!ed you)/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const helpers = () => `
  window.__pp = {
    scroller(el) { let e = el; while (e && e !== document.documentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e; e = e.parentElement; } return document.scrollingElement; },
    nav() { const a = document.querySelector('a[href^="/you"]'); return a ? (a.closest('[role="tablist"]') ?? a.parentElement.parentElement) : null; },
    noH() { return document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('[data-testid="profile-header"] *, [data-testid^="profile-section-"] *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5); },
  };`;

// the server's own values for the seeded player — the profile must read them, never invent
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const me = (await j('GET', '/player/me', undefined, kola.token)).body;
ok(me && me.name === 'Kola Adeyemi', `the live server serves the seeded player (${me?.name})`);
const AVAIL = { available_now: 'Open to trials', end_of_season: 'Available end of season', loan_open: 'Open to a loan', overseas_open: 'Open to a move abroad', not_seeking: 'Not looking' };

// ================================================================== 1 — every viewport, live, Kola (no current action on a fresh server)
console.log('\n— 1: the profile at every viewport (live) —');
for (const [w, h] of VIEWPORTS) {
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), `live ${w}×${h}`);
  await enterSeeded(page, PORTS.player); await openProfile(page);
  await page.evaluate(helpers());
  const tag = `live ${w}×${h}`;
  const hdr = await page.evaluate((avail) => {
    const cs = (el) => getComputedStyle(el);
    const q = (s) => document.querySelector(s);
    const name = q('[data-testid="profile-name"]'); const line = q('[data-testid="profile-line"]'); const av = q('[data-testid="profile-availability"]');
    const tabs = [...document.querySelectorAll('[data-testid="profile-tabs"] [role="tab"]')];
    return {
      name: name?.textContent, nameFont: cs(name).fontFamily, nameSize: parseFloat(cs(name).fontSize), nameWeight: cs(name).fontWeight, heading: name?.getAttribute('role') === 'heading' || /^H[1-6]$/.test(name?.tagName ?? ''),
      line: line?.textContent, lineFont: cs(line).fontFamily, avail: av?.textContent,
      verified: q('[data-testid="profile-verified"]')?.textContent, passportLink: !!q('[data-testid="profile-passport-link"]'),
      avatarInitials: q('[data-testid="profile-avatar"]')?.textContent, headerImgs: document.querySelectorAll('[data-testid="profile-header"] img').length,
      tabs: tabs.map((t) => ({ label: t.textContent.trim(), selected: t.getAttribute('aria-selected'), h: t.getBoundingClientRect().height, font: cs(t).fontFamily })),
      tablist: !!q('[data-testid="profile-tabs"] [role="tablist"]'),
      next: !!q('[data-testid="profile-next"]'), upToDate: !!q('[data-testid="profile-up-to-date"]'),
      essentials: [...document.querySelectorAll('[data-testid="profile-essentials"] > div')].map((r) => r.textContent),
      activityRows: document.querySelectorAll('[data-testid="profile-activity"] > div').length,
      cards: [...document.querySelectorAll('[data-testid="profile-section-overview"] div')].filter((d) => { const s = cs(d); return parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 && parseFloat(s.borderRightWidth) > 0 && d.getBoundingClientRect().width > innerWidth * 0.8; }).length,
      pills: [...document.querySelectorAll('[data-testid="profile-header"] div, [data-testid="profile-section-overview"] div')].filter((d) => cs(d).borderRadius === '5px' && d.getBoundingClientRect().height > 0 && d.getBoundingClientRect().height < 30).length,
      noH: window.__pp.noH(),
    };
  });
  ok(hdr.name === me.name && hdr.heading && hdr.nameSize >= 26 && Number(hdr.nameWeight) >= 700, `${tag}: the name is the heading, ${hdr.nameSize}px / ${hdr.nameWeight} (${hdr.name})`);
  ok(/^(")?-apple-system\b/.test(hdr.nameFont) && /^(")?-apple-system\b/.test(hdr.lineFont) && hdr.tabs.every((t) => /^(")?-apple-system\b/.test(t.font)), `${tag}: system UI on the name, the line and the tabs`);
  ok(hdr.line === `${me.position ?? 'Position not set'} · ${me.city || me.country}`, `${tag}: the summary line is the server's position and place (${hdr.line})`);
  ok(hdr.avail === AVAIL[me.availability], `${tag}: the availability word is the server's state (${hdr.avail})`);
  ok(/^(Verified|Not verified)/.test(hdr.verified ?? '') && (hdr.verified.startsWith('Verified') === !!me.identityVerified), `${tag}: verification as one word, matching the server (${hdr.verified})`);
  ok(hdr.passportLink, `${tag}: View Passport link`);
  ok(hdr.avatarInitials === 'KA' && hdr.headerImgs === 0, `${tag}: no photograph on file — the initials avatar, no image element (${hdr.avatarInitials})`);
  ok(hdr.tablist && hdr.tabs.map((t) => t.label).join('|') === 'Overview|Performance|Evidence|Journey' && hdr.tabs.filter((t) => t.selected === 'true').length === 1 && hdr.tabs.every((t) => t.h >= 44), `${tag}: four accessible section tabs, one selected, ≥44px (${hdr.tabs.map((t) => Math.round(t.h)).join('/')})`);
  ok(hdr.upToDate && !hdr.next, `${tag}: no current action on a fresh server — "You're up to date." (next ${hdr.next})`);
  ok(hdr.essentials.length >= 3 && hdr.essentials.length <= 5 && hdr.essentials.some((e) => e.startsWith('Age') && e.endsWith(String(me.age))), `${tag}: ${hdr.essentials.length} essentials, the age is the server's (${me.age})`);
  ok(hdr.activityRows <= 6, `${tag}: a short activity preview (${hdr.activityRows} rows incl. heading and link)`);
  ok(hdr.cards === 0, `${tag}: no full-width bordered card on the Overview without an action (${hdr.cards})`);
  ok(hdr.pills === 0, `${tag}: no pill on the header or the Overview (${hdr.pills})`);
  ok(hdr.noH, `${tag}: no horizontal overflow`);
  // each section: reachable to the end, the bottom navigation never covering the last content, no emoji, no private words
  for (const s of ['Overview', 'Performance', 'Evidence', 'Journey']) {
    await page.getByRole('tab', { name: s, exact: true }).click(); await sleep(700);
    const r = await page.evaluate((key) => {
      const sec = document.querySelector(`[data-testid="profile-section-${key}"]`);
      const sc = window.__pp.scroller(sec); sc.scrollTop = sc.scrollHeight; const nav = window.__pp.nav();
      const navTop = nav ? nav.getBoundingClientRect().top : innerHeight;
      const kids = [...sec.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().height > 0);
      const last = kids.length ? kids.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a)) : sec;
      const lb = last.getBoundingClientRect().bottom;
      const text = sec.innerText;
      return { visible: !!sec && sec.getBoundingClientRect().height > 0, lastBottom: lb, navTop, reach: lb <= navTop + 1 && lb >= 0, noH: window.__pp.noH(), text, selected: document.querySelector('[data-testid="profile-tabs"] [role="tab"][aria-selected="true"]')?.textContent.trim() };
    }, s.toLowerCase());
    ok(r.visible && r.selected === s, `${tag} ${s}: the section renders and its tab is selected`);
    ok(r.reach, `${tag} ${s}: the end of the section is reachable above the bottom navigation (last ${Math.round(r.lastBottom)} ≤ nav ${Math.round(r.navTop)})`);
    ok(r.noH, `${tag} ${s}: no horizontal overflow`);
    ok(!EMOJI.test(r.text), `${tag} ${s}: no pictograph`);
    ok(!PRIVATE.test(r.text), `${tag} ${s}: no club-private words`);
  }
  if (SHOTS && w === 390) { for (const s of ['Overview', 'Performance', 'Evidence', 'Journey']) { await page.getByRole('tab', { name: s, exact: true }).click(); await sleep(500); await page.evaluate(() => { const sec = document.querySelector('[data-testid^="profile-section-"]'); window.__pp.scroller(sec).scrollTop = 0; }); await page.screenshot({ path: path.join(SHOTS, `m24f1-after-live-${s.toLowerCase()}-390.png`) }); } }
  if (SHOTS && w === 390) { await page.getByRole('tab', { name: 'Overview', exact: true }).click(); await sleep(400); await page.screenshot({ path: path.join(SHOTS, 'm24f1-after-overview-no-action-390.png') }); }
  await ctx.close();
}

// ================================================================== 2 — keyboard, deep links, back / forward (live, 390)
console.log('\n— 2: keyboard, deep links, back / forward —');
{
  const ctx = await ctxFor(390, 844); const page = watch(await ctx.newPage(), 'nav 390');
  await enterSeeded(page, PORTS.player); await openProfile(page);
  await page.getByRole('tab', { name: 'Performance', exact: true }).focus(); await page.keyboard.press('Enter'); await sleep(500);
  ok(await page.evaluate(() => !!document.querySelector('[data-testid="profile-section-performance"]') && document.activeElement?.getAttribute('role') === 'tab'), 'keyboard: Enter on a focused tab opens its section and keeps focus on the tab');
  ok((await page.evaluate(() => { const t = document.activeElement; const cs = getComputedStyle(t); return cs.outlineStyle !== 'none' || cs.boxShadow !== 'none' || t.getAttribute('aria-selected') === 'true'; })), 'keyboard: the focused tab is visibly the selected one');
  ok(/section=performance/.test(page.url()), `the section is in the URL (${page.url().replace(/^.*\//, '/')})`);
  await page.goto(`${origin(PORTS.player)}/you?tab=profile&section=journey`); await page.waitForSelector('[data-testid="profile-section-journey"]', { timeout: 30000 });
  ok(true, 'deep link /you?tab=profile&section=journey opens the Journey section');
  await page.goto(`${origin(PORTS.player)}/profile?section=evidence`); await page.waitForSelector('[data-testid="profile-section-evidence"]', { timeout: 30000 });
  ok(await page.evaluate(() => !!document.querySelector('[data-testid="profile-section-evidence"]') && document.querySelector('[data-testid="profile-tabs"] [role="tab"][aria-selected="true"]')?.textContent.trim() === 'Evidence'), 'deep link /profile?section=evidence opens the profile route on Evidence');
  await page.goBack(); await sleep(800);
  ok(/section=journey/.test(page.url()) && await page.evaluate(() => !!document.querySelector('[data-testid="profile-section-journey"]')), `browser back returns to the previous profile location (${page.url().replace(/^.*\//, '/')})`);
  await page.goForward(); await sleep(800);
  ok(/section=evidence/.test(page.url()), 'browser forward returns to the Evidence deep link');
  await ctx.close();
}

// ================================================================== 3 — the current action (demo: Kola has a pending trial invitation)
console.log('\n— 3: the current action (demo) —');
for (const [w, h] of [[390, 844], [430, 932]]) {
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), `demo ${w}`);
  await page.goto(`${origin(PORTS.playerDemo)}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(400);
  await openProfile(page); await page.evaluate(helpers());
  // the demo's trial invitation lands a few seconds after sign-in (the delayed demo request); the profile re-reads the session and promotes it
  await page.waitForFunction(() => /Trial invitation/.test(document.querySelector('[data-testid="profile-next"]')?.innerText ?? ''), null, { timeout: 20000 }).catch(() => null);
  const r = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const next = document.querySelector('[data-testid="profile-next"]');
    const primaries = [...document.querySelectorAll('[data-testid="profile-section-overview"] [role="button"]')].filter((b) => cs(b).backgroundColor === 'rgb(0, 230, 118)' || cs(b).backgroundColor === 'rgb(51, 238, 124)');
    return { next: next?.innerText, cta: document.querySelector('[data-testid="profile-next-cta"]')?.getAttribute('aria-label'), primaries: primaries.length, upToDate: !!document.querySelector('[data-testid="profile-up-to-date"]') };
  });
  ok(!!r.next && /NEXT/i.test(r.next) && /Eastport FC/.test(r.next) && /Trial invitation/.test(r.next), `demo ${w}: ONE current action — the pending trial invitation from the seeded club (${r.next?.split('\n').slice(0, 3).join(' / ')})`);
  ok(r.primaries === 1 && r.cta === 'View invitation' && !r.upToDate, `demo ${w}: exactly one primary action on the Overview (${r.primaries}: ${r.cta})`);
  if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, `m24f1-after-overview-with-trial-${w}.png`) }); }
  await page.click('[data-testid="profile-next-cta"]'); await sleep(900);
  ok(/\/inbox/.test(page.url()), `demo ${w}: the action opens the invitation in the Inbox (${page.url().replace(/^.*\//, '/')})`);
  await ctx.close();
}

// ================================================================== 4 — a long name, a long city, no photograph (live sign-up)
console.log('\n— 4: a long name and a long place —');
{
  const LONG = 'Bartholomew Oluwaseun Adebayo-Fitzgerald-Montgomery';
  const CITY = 'Newcastle-under-Lyme-upon-the-Trent-Valley';
  const su = await j('POST', '/auth/player/signup', { name: LONG, dob: '2003-06-01', country: 'GB', position: 'ST', city: CITY, password: 'longenough1' });
  ok(su.status === 201 || su.status === 200, `a player with a long name signs up on the live server (${su.status})`);
  for (const [w, h] of [[320, 568], [390, 844]]) {
    const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), `long ${w}`);
    await page.goto(`${origin(PORTS.player)}/onboarding?mode=signin`); await page.waitForSelector('[data-testid="auth-kind-player"]', { timeout: 30000 });
    await page.click('[data-testid="auth-kind-player"]');
    await page.fill('input[placeholder="The id on your profile"]', su.body.playerId); await page.fill('input[placeholder="Your password"]', 'longenough1');
    await page.click('[data-testid="auth-signin-player"]'); await page.waitForSelector('a[href^="/you"]', { timeout: 30000 }); await sleep(500);
    await openProfile(page); await page.evaluate(helpers());
    const r = await page.evaluate(() => {
      const name = document.querySelector('[data-testid="profile-name"]'); const line = document.querySelector('[data-testid="profile-line"]');
      return { name: name.textContent, nameW: name.getBoundingClientRect().width, nameH: name.getBoundingClientRect().height, size: parseFloat(getComputedStyle(name).fontSize), line: line.textContent, lineRight: line.getBoundingClientRect().right, noH: window.__pp.noH(), initials: document.querySelector('[data-testid="profile-avatar"]')?.textContent, imgs: document.querySelectorAll('[data-testid="profile-header"] img').length };
    });
    ok(r.name === LONG && r.noH && r.nameW <= w - 40 && r.size >= 26, `long ${w}: the name wraps inside the gutters at full size (${Math.round(r.nameW)}px wide, ${Math.round(r.nameH)}px tall, ${r.size}px)`);
    ok(r.line.includes(CITY) && r.lineRight <= w + 0.5, `long ${w}: the long place wraps without overflow`);
    ok(r.initials === 'BO' && r.imgs === 0, `long ${w}: the initials avatar (${r.initials})`);
    await ctx.close();
  }
}

console.log(`\nm24fPlayerProfileLive: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}${errors.length ? `, ${errors.length} page errors` : ''}`);
if (errors.length) console.log(errors.join('\n'));
await browser.close(); statics.forEach((s) => s.close()); serverProc.kill('SIGTERM'); fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failures.length || errors.length ? 1 : 0);
