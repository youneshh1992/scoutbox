// M24D LIVE — the entry screens of the five applications, responsive and
// accessible, against real builds (Pro, Grassroots, Agent and the Trust &
// Safety key screen from live builds; the Agent's demo roster from a demo
// build; the Player from a live Expo web export).
//
//   R  responsive at 320 / 360 / 390 / 430 / 768 / 1024 / 1280 / 1440:
//      no horizontal overflow, the card and the one primary action inside
//      the viewport, ≥40px targets, the desktop points hidden on a phone
//   A  accessibility: every field labelled, every button named, the
//      password reveal announces itself, an empty submission produces a
//      role=alert, Tab reaches the submit with a visible focus ring, roles
//      (form, tablist / tab, pressed rows), contrast ≥ 4.5:1 on every text
//   V  the visual reset: no pill, no emoji, no icon circle on any entry
//      screen; choices are rows; the Player's entry is Player · Parent ·
//      Guardian · Use an invitation code with one primary action per step
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
const API_PORT = 4062;
const API = `http://localhost:${API_PORT}`;
const PORTS = { club: 8771, grassroots: 8772, agent: 8773, admin: 8774, agentDemo: 8775, player: 8871 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24dauth-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (c, m) => (c ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440];

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24da';
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

browser = await chromium.launch({ executablePath: EXE });
const errors = [];

const ctxFor = (width) => browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, ...(width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });

// In-page audit helpers, injected once per page.
const HELPERS = `
  window.__sb = {
    lum(c) { const m = c.match(/[\\d.]+/g).map(Number); const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; },
    bg(el) { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c) && !/rgba\\([^)]*, 0(\\.\\d+)?\\)$/.test(c)) return c; e = e.parentElement; } return 'rgb(255, 255, 255)'; },
    contrast(el) { const fg = getComputedStyle(el).color; const bg = this.bg(el); const a = this.lum(fg), b = this.lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); },
    name(el) { return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || '').trim(); },
    labelled(el) { if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true; const l = el.closest('label'); if (l && l.textContent.trim()) return true; if (el.id && document.querySelector('label[for="' + el.id + '"]')) return true; return false; },
    inside(el) { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.width > 0 && r.height > 0; },
  };`;

async function portalAudit(page, app, width) {
  await page.addScriptTag({ content: HELPERS });
  const r = await page.evaluate(async (w) => {
    await document.fonts.ready; await Promise.all(['400 14px Inter', '600 14px Inter', 'italic 400 14px Inter'].map((f) => document.fonts.load(f).catch(() => null)));
    const q = (s) => [...document.querySelectorAll(s)];
    const visible = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).display !== 'none'; };
    const card = document.querySelector('.auth-card');
    const primaries = q('.auth-form button.primary').filter(visible);
    const fields = q('.auth-form input, .auth-form select, .auth-form textarea').filter(visible);
    const buttons = q('.auth-form button, .login-toolbar button').filter(visible);
    const texts = q('.auth-form .auth-label, .auth-form .auth-hint, .auth-form .auth-row-meta, .auth-form .auth-access, .auth-form .auth-note, .auth-form .org-name, .auth-form .auth-tab, .auth-form .auth-lead, .auth-promo h2, .auth-promo .auth-summary, .auth-promo li, .auth-form button.primary, .auth-form .auth-eye').filter(visible);
    const low = texts.map((el) => ({ t: el.textContent.trim().slice(0, 24), c: Math.round(__sb.contrast(el) * 10) / 10 })).filter((x) => x.c < 4.5);
    return {
      iw: innerWidth, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth,
      cardInside: !!card && __sb.inside(card), cardW: card && Math.round(card.getBoundingClientRect().width),
      primaries: primaries.length, primaryInside: primaries.every((b) => __sb.inside(b)), primaryH: Math.min(...primaries.map((b) => Math.round(b.getBoundingClientRect().height))),
      unlabelled: fields.filter((f) => !__sb.labelled(f)).map((f) => f.getAttribute('placeholder') || f.tagName),
      unnamed: buttons.filter((b) => !__sb.name(b)).length,
      pointsShown: q('.auth-points').some(visible), summary: !!document.querySelector('.auth-summary'), h2: q('.auth-promo h2').some(visible),
      pills: q('.login .pill').filter(visible).length, emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.querySelector('.login')?.innerText ?? ''),
      circles: q('.login *').filter((el) => visible(el) && /50%|999px/.test(getComputedStyle(el).borderRadius) && el.getBoundingClientRect().width > 20 && !/button|input/i.test(el.tagName) && !el.closest('[data-theme-toggle]')).length,
      form: !!document.querySelector('.auth-form form[aria-label]'), eye: q('.auth-eye').map((b) => ({ label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') })),
      rows: q('.auth-form button.org-card, .auth-form .auth-row').map((b) => { const r = b.getBoundingClientRect(); const n = b.querySelector('.org-name')?.getBoundingClientRect(); const a = b.querySelector('.auth-row-arrow')?.getBoundingClientRect(); return { tag: b.tagName, pressed: b.getAttribute('aria-pressed'), name: __sb.name(b), oneLine: !!n && !!a && a.left > n.right && Math.abs((a.top + a.bottom) / 2 - (r.top + r.bottom) / 2) < r.height / 2 && n.left - r.left < 8 }; }),
      tabs: q('[role="tablist"] [role="tab"]').map((t) => t.getAttribute('aria-selected')),
      low, toggle: !!document.querySelector('[data-theme-toggle], .p-theme-toggle, [role="switch"]'),
      authBg: getComputedStyle(document.querySelector('.auth-form')).backgroundColor, pageBg: getComputedStyle(document.querySelector('.login.auth-page')).backgroundColor,
      fonts: { label: getComputedStyle(document.querySelector('.auth-label') ?? document.body).fontFamily, button: getComputedStyle(document.querySelector('.auth-form button.primary')).fontFamily, headline: getComputedStyle(document.querySelector('.auth-promo h2')).fontFamily, wordmark: getComputedStyle(document.querySelector('.auth-form h1 .wordmark')).fontFamily, interLoaded: document.fonts.check('600 14px Inter') && document.fonts.check('italic 400 14px Inter') },
      signature: !!document.querySelector('[data-testid="login-signature"]'), wordmark: !!document.querySelector('.auth-form h1 .wordmark') && !!document.querySelector('.auth-form h1 .tm'),
      innerPad: card ? Math.round(parseFloat(getComputedStyle(document.querySelector('.auth-form')).paddingLeft)) : null,
    };
  }, width);
  const tag = `${app} ${width}px`;
  if (r.sw > r.iw || r.bw > r.iw) fail(`${tag}: horizontal overflow (${r.sw}/${r.bw} > ${r.iw})`);
  if (!r.cardInside) fail(`${tag}: the card leaves the viewport`);
  if (r.primaries < 1 || !r.primaryInside || r.primaryH < 40) fail(`${tag}: the primary action (${r.primaries}) must be visible, inside the viewport and ≥40px (${r.primaryH})`);
  if (r.unlabelled.length) fail(`${tag}: unlabelled fields: ${r.unlabelled.join(', ')}`);
  if (r.unnamed) fail(`${tag}: ${r.unnamed} button(s) without an accessible name`);
  // M24F.2 — the Grassroots introduction is the headline and one sentence only (no points at any width).
  const grass = /^Grassroots/.test(app);
  if (grass ? r.pointsShown : (width <= 720 ? r.pointsShown : !r.pointsShown)) fail(`${tag}: the introduction points are ${r.pointsShown ? 'shown' : 'hidden'} (${grass ? 'Grassroots has none' : 'phone hides them, desktop shows them'})`);
  if (!r.h2 || !r.summary) fail(`${tag}: the introduction keeps its headline and one sentence`);
  if (r.pills || r.emoji || r.circles) fail(`${tag}: pills ${r.pills}, emoji ${r.emoji}, icon circles ${r.circles} — the entry screen must have none`);
  if (!r.form || !r.signature || !r.wordmark) fail(`${tag}: roles / landmarks (form ${r.form}, signature ${r.signature}, wordmark+tm ${r.wordmark})`);
  // M24E — ONE fixed appearance on every entry screen: no theme control before sign-in.
  if (r.toggle) fail(`${tag}: an appearance toggle is rendered on the entry screen`);
  // M24E — Inter on the product text; the wordmark alone keeps the brand face.
  if (!/^(")?Inter\b/.test(r.fonts.label) || !/^(")?Inter\b/.test(r.fonts.button) || !/^(")?Inter\b/.test(r.fonts.headline) || !r.fonts.interLoaded) fail(`${tag}: Inter must resolve on labels, buttons and the headline (${JSON.stringify(r.fonts)})`);
  if (!/Albert Sans/.test(r.fonts.wordmark)) fail(`${tag}: the wordmark keeps Albert Sans (${r.fonts.wordmark})`);
  if (r.eye.some((e) => !e.label || !['true', 'false'].includes(e.pressed))) fail(`${tag}: the password reveal must carry aria-label and aria-pressed (${JSON.stringify(r.eye)})`);
  if (r.rows.some((x) => x.tag !== 'BUTTON' || !x.name || !x.oneLine)) fail(`${tag}: choice rows must be named buttons with the name at the left and the arrow at the right on one line (${JSON.stringify(r.rows)})`);
  if (r.tabs.length && !r.tabs.every((t) => t === 'true' || t === 'false')) fail(`${tag}: tabs must carry aria-selected`);
  if (r.low.length) fail(`${tag}: contrast below 4.5:1 — ${JSON.stringify(r.low)}`);
  if (width <= 430 && r.innerPad < 24) fail(`${tag}: form gutter ${r.innerPad}px (≥24 on a phone)`);
  return r;
}

async function keyboardAndErrors(page, app, { submitText, firstField, maxTabs = 8, disabledWhenEmpty = false }) {
  // Empty submission → role=alert (or a disabled submit where nothing can be submitted).
  if (disabledWhenEmpty) {
    const disabled = await page.locator('.auth-form button.primary').first().isDisabled();
    ok(disabled, `${app}: the submit is disabled until the key is entered`);
  } else {
    await page.click('.auth-form button.primary');
    await page.waitForSelector('.login [role="alert"]', { timeout: 5000 });
    const alert = (await page.locator('.login [role="alert"]').first().innerText()).trim();
    ok(alert.length > 0, `${app}: an empty submission produces a role=alert ("${alert.slice(0, 48)}")`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${app}: the error does not widen the page`);
  }
  // Tab from the first field reaches the submit with a visible focus ring
  // (a submit that is disabled while empty is enabled by typing first).
  await page.focus(firstField);
  if (disabledWhenEmpty) await page.keyboard.type('x');
  let focus = null;
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    focus = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { tag: el.tagName, text: el.textContent.trim(), outline: cs.outlineStyle, outlineWidth: cs.outlineWidth, cls: el.className }; });
    if (focus.tag === 'BUTTON' && /primary/.test(focus.cls)) break;
  }
  ok(focus && focus.tag === 'BUTTON' && /primary/.test(focus.cls), `${app}: Tab from the first field reaches the submit within ${maxTabs} presses`);
  ok(focus.outline !== 'none' && focus.outlineWidth !== '0px', `${app}: the focused submit shows a focus ring (${focus.outline} ${focus.outlineWidth})`);
  // The password reveal toggles the field type.
  const eye = page.locator('.auth-eye').first();
  if (await eye.count()) {
    const before = await page.locator('.auth-pw input').first().getAttribute('type');
    await eye.click();
    const after = await page.locator('.auth-pw input').first().getAttribute('type');
    ok(before === 'password' && after === 'text' && (await eye.getAttribute('aria-pressed')) === 'true', `${app}: show / hide reveals the password and announces aria-pressed`);
    await eye.click();
  }
}

// =============================================================== portals
const PORTAL = [
  ['Pro', PORTS.club, { submitText: 'Enter workspace', firstField: '.enter-row input' }],
  ['Grassroots', PORTS.grassroots, { submitText: 'Enter workspace', firstField: '.enter-row input' }],
  ['Agent', PORTS.agent, { submitText: 'Enter workspace', firstField: '.enter-row input' }],
  ['Trust & Safety', PORTS.admin, { submitText: 'Enter', firstField: 'input[type="password"]', disabledWhenEmpty: true, maxTabs: 3 }],
];
for (const [app, port, kb] of PORTAL) {
  console.log(`\n— ${app} —`);
  const summary = [];
  for (const width of WIDTHS) {
    const ctx = await ctxFor(width);
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${app}@${width}: ${e}`));
    await page.goto(`http://localhost:${port}/`); await page.waitForSelector('.auth-card', { timeout: 25000 }); await sleep(500);
    const r = await portalAudit(page, app, width);
    summary.push(`${width}:${r.cardW}`);
    if (width === 390 || width === 1280) await keyboardAndErrors(page, `${app} ${width}px`, kb);
    if (app === 'Grassroots' && width === 390) {
      await page.click('[data-testid="auth-tab-register"]'); await sleep(300);
      const reg = await portalAudit(page, `${app} register`, width);
      ok(reg.primaries === 1, `${app} 390px: the registration step has one primary action`);
    }
    if ((app === 'Pro' || app === 'Grassroots') && width === 1440) {
      await page.locator('.auth-form .org-card').first().click(); await sleep(150);
      const pressed = await page.evaluate(() => [...document.querySelectorAll('.auth-form .org-card')].map((b) => b.getAttribute('aria-pressed')));
      ok(pressed.filter((x) => x === 'true').length === 1 && pressed.length >= 2, `${app}: choosing an organisation row marks exactly one row aria-pressed (${pressed.join(',')})`);
    }
    await ctx.close();
  }
  say(`${app}: responsive and accessible at ${WIDTHS.length} widths (card ${summary.join(' ')})`);
}

// ================================== M24E — one fixed appearance, and the way out
console.log('\n— M24E: fixed entry appearance, sign out, switch organisation —');
const THEME_KEY = { Pro: 'sb-theme:pro', Grassroots: 'sb-theme:grass', Agent: 'sb-theme:agent', 'Trust & Safety': 'sb-theme:safety' };
for (const [app, port] of [['Pro', PORTS.club], ['Grassroots', PORTS.grassroots], ['Agent', PORTS.agent], ['Trust & Safety', PORTS.admin]]) {
  const ctx = await ctxFor(1280);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${app} fixed-mode: ${e}`));
  const seen = {};
  for (const saved of ['dark', 'light']) {
    await page.goto(`http://localhost:${port}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [THEME_KEY[app], saved]);
    await page.reload(); await page.waitForSelector('.auth-card', { timeout: 25000 }); await sleep(300);
    seen[saved] = await page.evaluate(() => ({ page: getComputedStyle(document.querySelector('.login.auth-page')).backgroundColor, form: getComputedStyle(document.querySelector('.auth-form')).backgroundColor, promo: getComputedStyle(document.querySelector('.auth-promo')).backgroundColor, ink: getComputedStyle(document.querySelector('.auth-label') ?? document.querySelector('.auth-form h1')).color, stamped: document.documentElement.getAttribute('data-theme') }));
  }
  ok(seen.dark.page === seen.light.page && seen.dark.form === seen.light.form && seen.dark.promo === seen.light.promo && seen.dark.ink === seen.light.ink, `${app}: the entry screen renders the same whether the saved workspace theme is dark or light (${seen.dark.page} / ${seen.dark.form} / ${seen.dark.promo})`);
  ok((await page.locator('[data-theme-toggle], .p-theme-toggle').count()) === 0, `${app}: no appearance control before sign-in`);
  await ctx.close();
}
{
  // Pro: theme persists inside, survives sign-out, and comes back after sign-in.
  const ctx = await ctxFor(1280);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`Pro exit: ${e}`));
  const enterPro = async () => { await page.waitForSelector('.org-card', { timeout: 25000 }); await page.click('.org-card:has-text("Eastport FC")'); await page.fill('.enter-row input', 'Maria Keane'); await page.selectOption('.enter-row select', 'Head of Recruitment'); await page.click('button.primary'); await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(500); };
  await page.goto(`http://localhost:${PORTS.club}/`); await page.evaluate(() => localStorage.removeItem('sb-theme:pro')); await enterPro();
  ok((await page.locator('[data-theme-toggle]').count()) === 1, 'Pro: the appearance toggle is still there once signed in');
  await page.click('[data-theme-toggle]'); await sleep(200);
  ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'Pro: toggled to dark inside the workspace');
  await page.reload(); await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(400);
  ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'Pro: dark persists across a reload');
  const exits = await page.evaluate(() => [...document.querySelectorAll('.p-account [data-exit]')].map((b) => ({ exit: b.getAttribute('data-exit'), name: b.getAttribute('aria-label') || b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), inside: b.getBoundingClientRect().bottom <= innerHeight + 0.5, green: /0, 230, 118/.test(getComputedStyle(b).backgroundColor) })));
  ok(exits.map((x) => x.exit).sort().join() === 'sign-out,switch-org' && exits.every((x) => x.name && x.inside && !x.green), `Pro: Sign out and Switch organisation sit in the account block, named, on screen, not a bright button (${exits.map((x) => x.name).join(' · ')})`);
  const token = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; } });
  await page.click('[data-testid="sign-out"]'); await page.waitForSelector('.auth-card', { timeout: 15000 }); await sleep(300);
  ok((await page.locator('nav.sidebar').count()) === 0 && (await page.locator('.auth-card').count()) === 1, 'Pro: Sign out lands on the entry screen');
  const refused = (await fetch(`${API}/org/notifications`, { headers: { authorization: `Bearer ${token}` } })).status;
  ok(!!token && refused === 401, `Pro: the signed-out token is refused by the server (${refused})`);
  const fixedAfter = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector('.auth-form')).backgroundColor, saved: localStorage.getItem('sb-theme:pro') }));
  ok(fixedAfter.bg === 'rgb(23, 59, 39)' && fixedAfter.saved === 'dark', `Pro: after sign-out the entry screen is the fixed appearance (${fixedAfter.bg}) while the saved dark preference is kept`);
  await page.goBack().catch(() => {}); await sleep(500);
  ok((await page.locator('nav.sidebar').count()) === 0, 'Pro: Back after sign-out shows no workspace');
  await page.goto(`http://localhost:${PORTS.club}/#/recruitment`); await sleep(800);
  ok((await page.locator('nav.sidebar').count()) === 0 && (await page.locator('.auth-card').count()) === 1, 'Pro: a protected deep link after sign-out stops at the entry screen');
  await enterPro();
  ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'Pro: signing back in restores the saved dark theme');
  await page.click('[data-testid="switch-org"]'); await page.waitForSelector('.auth-card', { timeout: 15000 });
  ok((await page.locator('.org-card').count()) >= 2 && (await page.locator('nav.sidebar').count()) === 0, 'Pro: Switch organisation returns to the organisation rows');
  await page.evaluate(() => localStorage.removeItem('sb-theme:pro'));
  await ctx.close();
}
{
  // Grassroots: Switch club; Agent: Switch profile; Trust & Safety: Sign out clears the key.
  const ctx = await ctxFor(1280);
  const g = await ctx.newPage(); g.on('pageerror', (e) => errors.push(`Grassroots exit: ${e}`));
  await g.goto(`http://localhost:${PORTS.grassroots}/`); await g.waitForSelector('.org-card', { timeout: 25000 }); await g.click('.org-card:has-text("Hackney Marsh")'); await g.fill('.enter-row input', 'Sam Tully'); await g.click('button.primary'); await g.waitForSelector('nav.sidebar', { timeout: 25000 });
  await g.click('[data-testid="switch-org"]'); await g.waitForSelector('.auth-card', { timeout: 15000 });
  ok((await g.locator('.org-card').count()) >= 2 && (await g.locator('[data-testid="auth-tab-signin"]').count()) === 1, 'Grassroots: Switch club returns to the club rows with Sign in / Register club');
  const a = await ctx.newPage(); a.on('pageerror', (e) => errors.push(`Agent exit: ${e}`));
  await a.goto(`http://localhost:${PORTS.agent}/`); await a.waitForSelector('.auth-card', { timeout: 25000 }); await a.fill('.enter-row input', 'Ana Costa'); await a.click('button.primary'); await a.waitForSelector('nav.sidebar', { timeout: 25000 });
  const atok = await a.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-agent-session') ?? 'null')?.token ?? null; } catch { return null; } });
  await a.click('[data-testid="switch-org"]'); await a.waitForSelector('.auth-card', { timeout: 15000 }); await sleep(300);
  const aref = atok ? (await fetch(`${API}/org/agent/clients`, { headers: { authorization: `Bearer ${atok}` } })).status : null;
  ok((await a.locator('nav.sidebar').count()) === 0 && (await a.locator('#agent-org-label').count()) === 1 && (aref === null || aref === 401), `Agent: Switch profile returns to the agency screen and the old token is refused (${aref})`);
  ok((await a.evaluate(() => getComputedStyle(document.querySelector('.auth-form')).backgroundColor)) === 'rgb(253, 250, 244)', 'Agent: the entry screen is the fixed LIGHT cream appearance (M24F)');
  const ts = await ctx.newPage(); ts.on('pageerror', (e) => errors.push(`T&S exit: ${e}`));
  await ts.goto(`http://localhost:${PORTS.admin}/`); await ts.waitForSelector('.auth-card', { timeout: 25000 }); await ts.fill('input[type="password"]', 'scoutbox-admin'); await ts.click('button.primary'); await ts.waitForSelector('nav.sidebar', { timeout: 25000 });
  await ts.click('[data-testid="sign-out"]'); await ts.waitForSelector('.auth-card', { timeout: 15000 });
  ok((await ts.locator('nav.sidebar').count()) === 0 && (await ts.inputValue('input[type="password"]')) === '', 'Trust & Safety: Sign out returns to the key screen with the key cleared');
  await ctx.close();
}

// ======================================================= Agent demo roster
console.log('\n— Agent (demo roster) —');
for (const width of [390, 1440]) {
  const ctx = await ctxFor(width);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`agent-demo@${width}: ${e}`));
  await page.goto(`http://localhost:${PORTS.agentDemo}/`); await page.waitForSelector('[data-testid="demo-identities"]', { timeout: 25000 }); await sleep(400);
  await portalAudit(page, 'Agent demo', width);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="demo-identities"] button')].map((b) => ({ name: b.querySelector('.org-name')?.textContent.trim(), meta: b.querySelector('.auth-row-meta')?.textContent.trim(), arrow: !!b.querySelector('.auth-row-arrow'), h: Math.round(b.getBoundingClientRect().height) })));
  ok(rows.length === 3 && rows.every((r) => r.name && r.meta && r.arrow && r.h >= 44), `Agent demo ${width}px: three profile rows — ${rows.map((r) => `${r.name} — ${r.meta}`).join(' · ')} — each ≥44px with an arrow`);
  ok(await page.evaluate(() => !!document.querySelector('.auth-agency-name') && !document.querySelector('.auth-form .pill')), `Agent demo ${width}px: the agency is named once in plain text; no badge`);
  await page.click('[data-testid="demo-as-licensed_agent"]'); await page.waitForSelector('nav.sidebar', { timeout: 20000 });
  say(`Agent demo ${width}px: a profile row signs in`);
  await ctx.close();
}

// ================================================================ Player
console.log('\n— Player —');
for (const width of [320, 360, 390, 430, 1024, 1440]) {
  const ctx = await ctxFor(width);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`player@${width}: ${e}`));
  await page.goto(`http://localhost:${PORTS.player}/`); await page.waitForSelector('[data-testid="auth-welcome"]', { timeout: 40000 }); await sleep(700);
  await page.addScriptTag({ content: HELPERS });
  const r = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const vp = document.querySelector('[data-testid="mobile-viewport"]')?.getBoundingClientRect();
    const panel = document.querySelector('[data-testid="auth-panel"]').getBoundingClientRect();
    const rows = q('[data-testid^="auth-choice-"]').map((b) => ({ id: b.getAttribute('data-testid'), name: __sb.name(b), h: Math.round(b.getBoundingClientRect().height), inside: __sb.inside(b) }));
    const texts = q('[data-testid="auth-panel"] div[dir], [data-testid="auth-panel"] span, [data-testid="auth-intro"] div[dir]').filter((el) => el.children.length === 0 && el.textContent.trim());
    const low = texts.map((el) => ({ t: el.textContent.trim().slice(0, 20), c: Math.round(__sb.contrast(el) * 10) / 10 })).filter((x) => x.c < 4.5);
    const buttons = q('[role="button"]').filter((b) => b.getBoundingClientRect().height > 0);
    return {
      iw: innerWidth, sw: document.documentElement.scrollWidth, column: vp ? Math.round(vp.width) : innerWidth, colLeft: vp ? Math.round(vp.left) : 0,
      panelLeft: Math.round(panel.left), panelRight: Math.round(innerWidth - panel.right),
      heading: !!q('[role="heading"]').find((h) => h.textContent.trim() === 'Create your ScoutBox account'), sentence: document.body.innerText.includes("Choose how you're joining ScoutBox."),
      rows, emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.body.innerText),
      circles: q('[data-testid="auth-screen"] *').filter((el) => /50%|999px/.test(getComputedStyle(el).borderRadius) && el.getBoundingClientRect().width > 20 && el.getBoundingClientRect().width === el.getBoundingClientRect().height && !el.closest('[role="switch"]')).length,
      tabs: q('[role="tab"]').map((t) => t.getAttribute('aria-selected')), unnamed: buttons.filter((b) => !__sb.name(b)).length,
      promises: document.body.innerText.includes('Our promises to every player'), subtle: document.body.innerText.includes('You never pay to be seen.'),
      low, wordmark: !!q('[role="heading"]').find((h) => /ScoutBox/.test(h.textContent)), signature: !!document.querySelector('[data-testid="login-signature"]'),
      bottomNav: !!document.querySelector('[role="tablist"] a[href="/discover"], a[href^="/you"]'),
    };
  });
  const tag = `Player ${width}px`;
  if (r.sw > r.iw) fail(`${tag}: horizontal overflow (${r.sw} > ${r.iw})`);
  if (r.column !== Math.min(430, width)) fail(`${tag}: the mobile column is ${r.column}px`);
  if (r.panelLeft - r.colLeft < 24 || r.panelRight < 24 && width <= 430) fail(`${tag}: horizontal padding ${r.panelLeft - r.colLeft}px (≥24)`);
  if (!r.heading || !r.sentence) fail(`${tag}: the entry step says "Create your ScoutBox account" and "Choose how you're joining ScoutBox."`);
  if (r.rows.map((x) => x.id).join() !== 'auth-choice-player,auth-choice-parent,auth-choice-guardian,auth-choice-code' || r.rows.some((x) => x.h < 44 || !x.inside || !x.name)) fail(`${tag}: rows Player · Parent · Guardian · Use an invitation code, each ≥44px and named (${JSON.stringify(r.rows)})`);
  if (r.emoji || r.circles) fail(`${tag}: emoji ${r.emoji}, icon circles ${r.circles}`);
  if (r.tabs.length < 2 || !r.tabs.every((t) => t === 'true' || t === 'false')) fail(`${tag}: Sign in / Sign up are tabs with aria-selected`);
  if (r.unnamed) fail(`${tag}: ${r.unnamed} control(s) without an accessible name`);
  if (!r.promises || !r.subtle || !r.wordmark || !r.signature) fail(`${tag}: promises, the subtle "never pay", the wordmark and the credit stay`);
  if (r.low.length) fail(`${tag}: contrast below 4.5:1 — ${JSON.stringify(r.low)}`);
  if (r.bottomNav) fail(`${tag}: no authenticated bottom navigation before sign-in`);
  // Sign in: one form, one primary action, validation, keyboard.
  await page.click('[data-testid="auth-tab-signin"]'); await sleep(400);
  const si = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const primaries = q('[data-testid="auth-signin"] [role="button"]').filter((b) => /^Sign in/.test(b.textContent.trim()) || /^Sign in/.test(b.getAttribute('aria-label') ?? ''));
    return { primaries: primaries.length, kinds: q('[data-testid^="auth-kind-"]').map((t) => t.getAttribute('aria-selected')), reveal: q('[aria-label="Show password"], [aria-label="Hide password"]').length, fields: q('input').filter((i) => i.getBoundingClientRect().height > 0).map((i) => i.getAttribute('aria-label')) };
  });
  ok(si.primaries === 1 && si.kinds.join() === 'true,false' && si.reveal === 1 && si.fields.every(Boolean), `${tag}: Sign in shows one form (Parent or guardian first), one primary action, labelled fields, one show / hide (${si.fields.join(', ')})`);
  await page.click('[data-testid="auth-signin-guardian"]'); await page.waitForSelector('[data-testid="auth-error"]', { timeout: 5000 });
  ok((await page.locator('[data-testid="auth-error"] [role="alert"]').count()) === 1, `${tag}: an empty sign-in produces a role=alert`);
  await page.click('[data-testid="auth-kind-player"]'); await sleep(250);
  const sp = await page.evaluate(() => [...document.querySelectorAll('[data-testid="auth-signin"] [role="button"]')].filter((b) => /^Sign in/.test(b.getAttribute('aria-label') ?? b.textContent)).length);
  ok(sp === 1 && (await page.locator('[data-testid="auth-signin-player"]').count()) === 1, `${tag}: switching to Player (18+) keeps one form and one primary action`);
  await page.focus('input[aria-label="Player id"]');
  let reached = false;
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'auth-signin-player')) { reached = true; break; } }
  ok(reached, `${tag}: Tab from the id field reaches the Sign in button within six presses`);
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' || cs.boxShadow !== 'none'; });
  ok(ring, `${tag}: the focused Sign in button shows a focus ring`);
  await ctx.close();
}
say('Player: responsive and accessible at 320 / 360 / 390 / 430 / 1024 / 1440');
{
  const ctx = await ctxFor(390);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`player exit: ${e}`));
  await page.goto(`http://localhost:${PORTS.player}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  ok((await page.locator('[role="switch"]').count()) === 0, 'Player: no appearance switch on the entry screen');
  const ff = await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('600 14px Inter').catch(() => null); const el = [...document.querySelectorAll('[data-testid="auth-welcome"] div')].find((d) => d.textContent.trim() === 'Player'); return { font: el ? getComputedStyle(el).fontFamily : null, loaded: document.fonts.check('600 14px Inter'), warned: false }; });
  ok(/Inter/.test(ff.font ?? '') && ff.loaded, `Player: Inter resolves on the entry rows (${ff.font})`);
  await page.locator('text=Enter').nth(0).click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  ok((await page.locator('[role="switch"]').count()) >= 1, 'Player: the appearance switch is there once signed in');
  await page.goto(`http://localhost:${PORTS.player}/you?tab=account`); await page.waitForSelector('[data-testid="sign-out"]', { timeout: 30000 });
  const exits = await page.evaluate(() => [...document.querySelectorAll('[data-testid="sign-out"], [data-testid="switch-account"]')].map((b) => ({ id: b.getAttribute('data-testid'), name: b.getAttribute('aria-label'), green: /0, 230, 118/.test(getComputedStyle(b).backgroundColor) })));
  ok(exits.length === 2 && exits.every((x) => x.name && !x.green), `Player: Sign out and Switch account on the account tab, named, not bright (${exits.map((x) => x.name).join(' · ')})`);
  await page.click('[data-testid="switch-account"]'); await page.waitForSelector('[data-testid="auth-signin"]', { timeout: 20000 });
  ok((await page.evaluate(() => localStorage.getItem('scoutbox-player-session'))) === null, 'Player: Switch account ends the identity and opens the entry screen on Sign in');
  await page.goto(`http://localhost:${PORTS.player}/you`); await page.waitForSelector('[data-testid="auth-screen"]', { timeout: 20000 });
  ok((await page.locator('a[href^="/you"]').count()) === 0, 'Player: a protected route after the exit stops at the entry screen');
  await ctx.close();
}


ok(errors.length === 0, `no page errors in any context (${errors.length ? errors.join(' | ') : 'clean'})`);
console.log(`\nm24dAuthLive: ${passed} checks passed`);
process.exit(0);
