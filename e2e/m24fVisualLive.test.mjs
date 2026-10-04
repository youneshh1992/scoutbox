// M24F — live visual-quality journeys, in a real browser against the real
// bundles and a live scoutbox-server: the Grassroots entry (its M24E scheme —
// the blade-banded introduction, Inter, row hover, title-cased metadata), the
// Grassroots LIGHT workspace (M24E: #E5F5E9, turf grain, pitch markings — the
// M24F Sage palette was reverted at the Founder's direction), the Grassroots DARK workspace
// unchanged against the frozen M24E values, the Agent entry fixed LIGHT with
// the saved dark theme restored after sign-in, the Player's major routes and
// the guardian's requests in their M24F composition, and the de-boxed Pro /
// Trust & Safety dense screens. Widths 390, 430, 1024, 1440. Zero page errors.
//
// Run from e2e/: node m24fVisualLive.test.mjs   (KEEP_DIST=1 reuses bundles)
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
const PORTS = { club: 8791, grassroots: 8792, agent: 8793, admin: 8794, agentDemo: 8795, player: 8882, playerDemo: 8883 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24fvisual-'));
const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live24fv';
const WIDTHS = [390, 430, 1024, 1440];
let passed = 0; const errors = []; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const fail = (m) => ok(false, m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) {
  try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch { /* free */ }
}
const bundles = [['scoutbox-club', PORTS.club, DIST], ['scoutbox-grassroots', PORTS.grassroots, DIST], ['scoutbox-agent', PORTS.agent, DIST], ['scoutbox-admin', PORTS.admin, DIST], ['scoutbox-agent', PORTS.agentDemo, `${DIST}-demo`], ['scoutbox-player', PORTS.player, DIST], ['scoutbox-player', PORTS.playerDemo, `${DIST}-demo`]];
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
const ctxFor = (w, h = w < 500 ? 844 : w < 1200 ? 700 : 900, store = {}) => browser.newContext({ viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}), storageState: { cookies: [], origins: Object.entries(store).map(([origin, kv]) => ({ origin, localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })) })) } });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); return page; };
const origin = (port) => `http://localhost:${port}`;
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'e2e/fixtures/m24e-grassroots-dark-tokens.json'), 'utf8'));

async function enter(ctx, port, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`${origin(port)}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
  if (org) { await page.waitForSelector('.org-card', { timeout: 25000 }); await page.click(`.org-card:has-text("${org}")`); }
  if (name) await page.fill('.enter-row input', name);
  if (role) await page.selectOption('.enter-row select', role).catch(() => {});
  if (!org && !name) await page.fill('input[type="password"]', 'scoutbox-admin');
  await page.click('button.primary'); await page.waitForSelector('nav.sidebar', { timeout: 25000 }); await sleep(500);
  return page;
}

// ================================================================== G — the Grassroots entry
console.log('\n— G: the Grassroots entry —');
// the Pro entry is the shared M24C/M24E scheme (brand-green page, soft-green introduction, deep-green form); Grassroots must match it again
const proRef = await (async () => {
  const ctx = await ctxFor(1440); const page = watch(await ctx.newPage(), 'pro entry reference');
  await page.goto(`${origin(PORTS.club)}/`); await page.waitForSelector('.org-card', { timeout: 25000 });
  const r = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); return { formBg: cs(document.querySelector('.auth-form')).backgroundColor, pageBg: cs(document.querySelector('.login.auth-page')).backgroundColor, promoBg: cs(document.querySelector('.auth-promo')).backgroundColor, pitch: (() => { const b = cs(document.querySelector('.login.auth-page'), '::before'); return b.display === 'none' || b.content === 'none' || b.content === 'normal' ? 'none' : `${b.display}/${b.content}`; })() }; });
  await ctx.close(); return r;
})();
for (const w of WIDTHS) {
  for (const saved of ['light', 'dark']) {
    const ctx = await ctxFor(w, undefined, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': saved } });
    const page = watch(await ctx.newPage(), `grassroots entry ${w} ${saved}`);
    await page.goto(`${origin(PORTS.grassroots)}/`); await page.waitForSelector('.org-card', { timeout: 25000 });
    const r = await page.evaluate(async () => {
      await document.fonts.ready; await document.fonts.load('400 14px Inter').catch(() => null);
      const promo = document.querySelector('.auth-promo'); const form = document.querySelector('.auth-form'); const card = document.querySelector('.auth-card');
      const cs = (el) => getComputedStyle(el);
      const pr = promo.getBoundingClientRect(); const fr = form.getBoundingClientRect();
      return {
        photo: /url\(/.test(cs(promo).backgroundImage) || /url\(/.test(cs(form).backgroundImage) || /url\(/.test(cs(document.querySelector('.login.auth-page')).backgroundImage),
        blades: /repeating-linear-gradient/.test(cs(promo).backgroundImage),
        formHasImage: cs(form).backgroundImage !== 'none',
        formBg: cs(form).backgroundColor, pageBg: cs(document.querySelector('.login.auth-page')).backgroundColor, promoBg: cs(promo).backgroundColor,
        promoLeftOfForm: Math.round(pr.right) <= Math.round(fr.left) + 1, promoAboveForm: Math.round(pr.bottom) <= Math.round(fr.top) + 1,
        toggle: document.querySelectorAll('[data-theme-toggle], .p-theme-toggle, [role="switch"]').length,
        sub: cs(document.querySelector('.auth-form h1 .brand-sub')).fontFamily, subStyle: cs(document.querySelector('.auth-form h1 .brand-sub')).fontStyle,
        ui: cs(document.querySelector('.auth-label')).fontFamily,
        meta: [...document.querySelectorAll('.auth-row-meta')].map((m) => m.textContent.trim()),
        rowBg: cs(document.querySelector('.org-card')).backgroundColor, rowRadius: cs(document.querySelector('.org-card')).borderRadius,
        pitch: (() => { const b = cs(document.querySelector('.login.auth-page'), '::before'); return b.display === 'none' || b.content === 'none' || b.content === 'normal' ? 'none' : `${b.display}/${b.content}`; })(),
        cardW: Math.round(card.getBoundingClientRect().width),
        // the live bundle's computed ::before is not observable here (a known limitation); prove the pitch by the rules in force instead
        rules: (() => { const sel = []; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) if (r.selectorText) sel.push(r.selectorText); } catch {} } return sel; })(),
      };
    });
    r.pitchRule = r.rules.some((t) => /\.login\.auth-page::before/.test(t) && !/data-app="grass"/.test(t));
    r.pitchHidden = r.rules.some((t) => /data-app="grass"\] \.login\.auth-page::before/.test(t));
    const tag = `Grassroots entry ${w}px (${saved} saved)`;
    // The Founder's direction after M24F.2: the M24E green introduction again — no photograph anywhere.
    ok(!r.photo && !r.formHasImage, `${tag}: no photograph anywhere on the entry (restored)`);
    ok(r.blades, `${tag}: the introduction carries the M24E blade-of-grass bands`);
    ok(w >= 721 ? r.promoLeftOfForm : r.promoAboveForm, `${tag}: the introduction is ${w >= 721 ? 'the LEFT panel' : 'stacked above the form'}`);
    ok(r.formBg === proRef.formBg && r.pageBg === proRef.pageBg && r.promoBg === proRef.promoBg, `${tag}: the shared M24E entry scheme, same as Pro (${r.formBg} / ${r.pageBg} / ${r.promoBg})`);
    ok(r.formBg !== 'rgb(246, 248, 244)' && r.pageBg !== 'rgb(47, 59, 52)', `${tag}: the M24F Sage entry colours are gone`);
    ok(r.toggle === 0, `${tag}: no theme control`);
    ok(/^(")?Inter\b/.test(r.sub) && r.subStyle === 'normal', `${tag}: "Grassroots" is set in Inter, upright (${r.sub.split(',')[0]}) — the serif is reverted`);
    ok(/^(")?Inter\b/.test(r.ui), `${tag}: the form labels are Inter`);
    ok(r.meta.length >= 2 && r.meta.every((m) => /^Club · Grassroots · (Verified|Verification Pending)/.test(m)), `${tag}: metadata reads "Club · Grassroots · Verified / Verification Pending" (${r.meta[0]})`);
    ok(/rgba\(0, 0, 0, 0\)|transparent/.test(r.rowBg) && r.rowRadius === '0px', `${tag}: the club rows are a list, not grey boxes`);
    ok(r.pitchRule && !r.pitchHidden && r.pitch === proRef.pitch, `${tag}: the shared pitch motif rule is in force and no Grassroots rule hides it — the same motif as Pro (${r.pitch} / ${proRef.pitch})`);
    if (w >= 1024) {
      // hover is the text and the arrow, never a box
      const before = await page.evaluate(() => { const c = document.querySelector('.org-card'); return { name: getComputedStyle(c.querySelector('.org-name')).color, arrow: getComputedStyle(c.querySelector('.auth-row-arrow')).transform, bg: getComputedStyle(c).backgroundColor }; });
      await page.hover('.org-card >> nth=0'); await sleep(300);
      const after = await page.evaluate(() => { const c = document.querySelector('.org-card'); return { name: getComputedStyle(c.querySelector('.org-name')).color, arrow: getComputedStyle(c.querySelector('.auth-row-arrow')).transform, bg: getComputedStyle(c).backgroundColor }; });
      ok(after.name !== before.name && after.arrow !== before.arrow && after.bg === before.bg && /rgba\(0, 0, 0, 0\)|transparent/.test(after.bg), `${tag}: hover brightens the name and moves the arrow, the row stays unboxed`);
    }
    await ctx.close();
  }
}

// ================================================================== L / D — the Grassroots workspace
console.log('\n— L / D: the Grassroots workspace —');
for (const w of [390, 1024, 1440]) {
  const ctx = await ctxFor(w, undefined, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': 'light' } });
  const page = await enter(ctx, PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', `grassroots light ${w}`);
  const r = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const content = document.querySelector('.content');
    const rules = (() => { const sel = []; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) if (r.selectorText) sel.push(r.selectorText); } catch {} } return sel; })();
    return { markings: rules.some((t) => t === ':root[data-app="grass"] .content::before') && rules.some((t) => t === ':root[data-app="grass"] .content::after'), theme: document.documentElement.getAttribute('data-theme'), content: cs(content).backgroundColor, contentImage: cs(content).backgroundImage, before: cs(content, '::before').content, sidebar: cs(document.querySelector('nav.sidebar')).backgroundColor, ink: cs(document.querySelector('.content')).color, serif: cs(document.querySelector('nav.sidebar .brand-sub') ?? document.querySelector('.crumb')).fontFamily, grass: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /grassroots-auth-grass/.test(r.cssText) && !/auth-promo/.test(r.selectorText ?? '')); } catch { return false; } }) };
  });
  const tag = `Grassroots light ${w}px`;
  // M24F.2 — the light workspace follows the Founder's dashboard reference: cool canvas, navy sidebar, no pitch lines, no photograph.
  ok(r.content === 'rgb(247, 249, 252)' && r.sidebar === 'rgb(6, 56, 86)', `${tag}: the cool canvas and the navy sidebar (${r.content} / ${r.sidebar})`);
  ok(r.contentImage === 'none' && !r.markings, `${tag}: no turf grain and no pitch-marking rule behind the light workspace (${r.contentImage.slice(0, 40)})`);
  ok(r.ink === 'rgb(11, 28, 45)', `${tag}: the deep navy ink (${r.ink})`);
  ok(!r.grass, `${tag}: no stylesheet rule puts the photograph anywhere but the entry introduction`);
  if (w === 1440) ok(/^(")?Inter\b/.test(r.serif), `${tag}: the sidebar's "Grassroots" is Inter (serif reverted)`);
  // the Coaches page: an editorial page, not six boxes
  if (w === 390) await page.click('.nav-hamburger').catch(() => {});
  await page.evaluate(() => { location.hash = '#/coaches'; }); await sleep(900);
  if (w === 390) await page.keyboard.press('Escape').catch(() => {});
  await page.waitForSelector('[data-testid="coaches-page"]', { timeout: 10000 });
  if ((await page.locator('.ed-record').count()) === 0) {
    // a fresh live server has no affiliation yet: confirm one through the page's own form
    await page.fill('[data-testid="coaches-page"] input[aria-label="Coach name"]', 'Dee Mensah');
    await page.fill('[data-testid="coaches-page"] input[aria-label="Coach role"]', 'Head Coach');
    await page.fill('[data-testid="coaches-page"] input[aria-label="Conflict of interest declaration"]', 'none declared');
    await page.click('[data-testid="coaches-page"] button.primary'); await page.waitForSelector('.ed-record', { timeout: 10000 }); await sleep(300);
  }
  const c = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const rec = document.querySelector('.ed-record');
    return { page: !!document.querySelector('[data-testid="coaches-page"]'), records: document.querySelectorAll('.ed-record').length, boxes: document.querySelectorAll('[data-testid="coaches-page"] .filters, [data-testid="coaches-page"] .notice, [data-testid="coaches-page"] .list-row').length, recBg: rec ? cs(rec).backgroundColor : null, recBorder: rec ? cs(rec).borderTopWidth + '/' + cs(rec).borderLeftWidth : null, name: document.querySelector('.ed-record-name')?.textContent, since: document.querySelector('.ed-record-meta')?.textContent, state: document.querySelector('.ed-record-state .f-status')?.textContent, textActions: document.querySelectorAll('.ed-record-actions .f-textbtn').length, primary: document.querySelectorAll('[data-testid="coaches-page"] button.primary').length, headings: [...document.querySelectorAll('.ed-h')].map((h) => h.textContent) };
  });
  ok(c.page && c.records >= 1 && c.boxes === 0, `${tag} Coaches: the editorial page — ${c.records} affiliation record(s), 0 boxes`);
  ok(c.recBg === 'rgba(0, 0, 0, 0)' && c.recBorder === '0px/0px', `${tag} Coaches: a record is ruled, not boxed`);
  ok(c.name === 'Dee Mensah' && /Head Coach · Since [A-Z][a-z]{2} \d{4}/.test(c.since ?? '') && c.state === 'Confirmed' && c.textActions === 2, `${tag} Coaches: "Dee Mensah / Head Coach · Since Aug 2024 / Confirmed / End affiliation · Revoke"`);
  ok(c.primary === 1 && c.headings.join('|') === 'Coach affiliation|Squad invitations', `${tag} Coaches: one primary action; "Coach affiliation" and "Squad invitations"`);
  await ctx.close();
}
{
  const ctx = await ctxFor(1440, undefined, { [origin(PORTS.grassroots)]: { 'sb-theme:grass': 'dark' } });
  const page = await enter(ctx, PORTS.grassroots, 'Hackney Marsh', 'Sam Tully', 'Manager', 'grassroots dark');
  const r = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement); const tokens = {};
    for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) tokens[n] = v; }
    const el = (s) => { const e = document.querySelector(s); return e ? { bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color } : null; };
    return { theme: document.documentElement.getAttribute('data-theme'), tokens, computed: { content: el('.content'), sidebar: el('nav.sidebar'), topbar: el('.topbar'), body: el('body'), navActive: el('nav.sidebar button.active, nav.sidebar .nav-section.active') }, image: getComputedStyle(document.querySelector('.content')).backgroundImage };
  }, Object.keys(frozen.tokens));
  const diff = Object.keys(frozen.tokens).filter((k) => frozen.tokens[k] !== r.tokens[k]);
  ok(r.theme === 'dark' && diff.length === 0, `Grassroots dark: every one of the ${Object.keys(frozen.tokens).length} M24E tokens is unchanged${diff.length ? ` (changed: ${diff.map((k) => `${k} ${frozen.tokens[k]} → ${r.tokens[k]}`).join(', ')})` : ''}`);
  const same = ['content', 'sidebar', 'topbar', 'body', 'navActive'].every((k) => JSON.stringify(frozen.computed[k]) === JSON.stringify(r.computed[k]));
  ok(same, `Grassroots dark: the workspace, sidebar, top bar, body and active navigation render the M24E colours (${r.computed.content.bg} / ${r.computed.sidebar.bg})`);
  ok(!/url\(/.test(r.image) && /repeating-linear-gradient/.test(r.image), 'Grassroots dark: no photograph; the M24E grain stays');
  await ctx.close();
}

// ================================================================== A — the Agent entry, fixed light
console.log('\n— A: the Agent entry —');
for (const w of WIDTHS) {
  const ctx = await ctxFor(w, undefined, { [origin(PORTS.agentDemo)]: { 'sb-theme:agent': 'dark' }, [origin(PORTS.agent)]: { 'sb-theme:agent': 'dark' } });
  const page = watch(await ctx.newPage(), `agent entry ${w}`);
  await page.goto(`${origin(PORTS.agentDemo)}/`); await page.waitForSelector('.auth-card', { timeout: 25000 });
  const r = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); return { form: cs(document.querySelector('.auth-form')).backgroundColor, promo: cs(document.querySelector('.auth-promo')).backgroundColor, page: cs(document.querySelector('.login.auth-page')).backgroundColor, ink: cs(document.querySelector('.auth-form h1')).color, toggle: document.querySelectorAll('[data-theme-toggle], .p-theme-toggle, [role="switch"]').length, roster: document.querySelectorAll('[data-testid="demo-identities"] .org-card').length, submit: cs(document.querySelector('.auth-form button.primary')).backgroundColor, pitch: (() => { const b = cs(document.querySelector('.login.auth-page'), '::before'); return b.display === 'none' || b.content === 'none' || b.content === 'normal' ? 'none' : `${b.display}/${b.content}`; })(), rowBg: cs(document.querySelector('.org-card')).backgroundColor }; });
  const tag = `Agent entry ${w}px (dark saved)`;
  ok(r.form === 'rgb(253, 250, 244)' && r.promo === 'rgb(243, 238, 227)' && r.page === 'rgb(249, 246, 239)', `${tag}: the cream LIGHT entry (${r.form} / ${r.promo})`);
  ok(r.ink === 'rgb(48, 45, 37)', `${tag}: dark readable type`);
  ok(r.toggle === 0 && r.pitch === 'none', `${tag}: no theme control, no pitch motif (toggle ${r.toggle}, pitch ${r.pitch})`);
  ok(r.roster === 3 && /rgba\(0, 0, 0, 0\)|transparent/.test(r.rowBg), `${tag}: the three profile rows, unboxed`);
  ok(r.submit === 'rgb(48, 45, 37)', `${tag}: one dark primary action, the gold held back`);
  await ctx.close();
}
{
  // the saved dark theme comes back after sign-in (live Agent)
  const ctx = await ctxFor(1280, 720, { [origin(PORTS.agent)]: { 'sb-theme:agent': 'dark' } });
  const page = await enter(ctx, PORTS.agent, null, 'Ana Costa', null, 'agent restore');
  ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'Agent: the saved dark workspace is restored after signing in through the light entry');
  await ctx.close();
}

// ================================================================== P — the Player and the guardian
console.log('\n— P: the Player —');
async function playerIn(page, who, port = PORTS.player) {
  await page.goto(`${origin(port)}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const rows = page.locator('[data-testid="demo-identities"] >> text=Enter'); const n = await rows.count();
  await rows.nth(who === 'guardian' ? n - 1 : 0).click();
  await page.waitForSelector(who === 'guardian' ? '[data-testid="guardian-requests"]' : 'text=Your visibility right now', { timeout: 30000 }); await sleep(600);
}
for (const w of [390, 430]) {
  const ctx = await ctxFor(w, 1000); const page = watch(await ctx.newPage(), `player ${w}`);
  await playerIn(page, 'player');
  const tag = `Player ${w}px`;
  const home = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const name = document.querySelector('[data-testid="home-identity"] [role="heading"]');
    const prim = document.querySelector('[data-testid="home-primary"]');
    const primaries = [...document.querySelectorAll('[role="button"]')].filter((b) => /rgb\(0, 230, 118\)|rgb\(51, 238, 124\)/.test(cs(b).backgroundColor));
    const tabs = document.querySelectorAll('[role="tablist"] a[href], a[href^="/discover"], a[href^="/football"], a[href^="/opportunities"], a[href^="/inbox"], a[href^="/you"]');
    const boxes = [...document.querySelectorAll('[data-testid="mobile-viewport"] div')].filter((d) => { const s = cs(d); return s.borderTopWidth !== '0px' && s.borderRightWidth !== '0px' && s.borderBottomWidth !== '0px' && s.borderLeftWidth !== '0px' && parseFloat(s.borderRadius) >= 10 && d.getBoundingClientRect().width > 250; });
    return { name: name?.textContent, nameSize: name ? parseFloat(cs(name).fontSize) : 0, primary: !!prim, primaries: primaries.length, kicker: prim?.querySelector('div')?.textContent, journey: !!document.querySelector('[data-testid="home-journey"]'), activity: !!document.querySelector('[data-testid="home-activity"]'), visibility: !!document.querySelector('[data-testid="home-visibility"]'), tabLinks: new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href').split('?')[0]).filter((h) => /^\/(discover|football|opportunities|inbox|you)$/.test(h))).size, bigBoxes: boxes.length, gutter: Math.round(name.getBoundingClientRect().left) };
  });
  ok(home.name && home.nameSize >= 26, `${tag} Home: the player's name is the headline (${home.name}, ${home.nameSize}px)`);
  ok(home.primary && home.primaries === 1, `${tag} Home: exactly one bright primary action (${home.primaries}), under "${home.kicker}"`);
  ok(home.journey && home.activity && home.visibility, `${tag} Home: journey, activity stream and the visibility disclosure are there`);
  ok(home.tabLinks <= 5, `${tag}: ${home.tabLinks} bottom-navigation destinations (≤ 5)`);
  ok(home.bigBoxes === 0, `${tag} Home: no full-width bordered card (${home.bigBoxes})`);
  ok(home.gutter >= 20, `${tag} Home: real gutters (${home.gutter}px)`);
  // Explore, Football, Inbox, Account
  await page.click('a[href^="/opportunities"]'); await sleep(900);
  const ex = await page.evaluate(() => ({ current: !!document.querySelector('[data-testid="opp-current"]'), board: /Opportunity board/.test(document.body.innerText), lowerPills: [...document.querySelectorAll('[data-testid="mobile-viewport"] div')].filter((d) => d.children.length === 1 && d.firstElementChild.tagName === 'DIV' && /^[a-z]/.test(d.firstElementChild.textContent) && d.firstElementChild.textContent.length < 20 && getComputedStyle(d).borderRadius === '5px').length }));
  ok(ex.current && ex.board, `${tag} Explore: Current, then the opportunity board`);
  // the Inbox composition is read on the self-contained demo (two pending requests in its sample data)
  await page.goto(`${origin(PORTS.playerDemo)}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('[data-testid="demo-identities"] >> text=Enter').first().click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(400);
  await page.click('a[href^="/inbox"]'); await page.waitForSelector('[data-testid^="inbox-request-"]', { timeout: 15000 }); await page.locator('[data-testid^="inbox-request-"]').first().click(); await page.waitForSelector('[role="button"][aria-label^="Accept"]', { timeout: 15000 }); await sleep(400);
  const inbox = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); const declines = [...document.querySelectorAll('[role="button"]')].filter((b) => /^Decline$/.test(b.getAttribute('aria-label') ?? '')); return { declines: declines.length, declineBg: declines[0] ? cs(declines[0]).backgroundColor : null, accepts: [...document.querySelectorAll('[role="button"]')].filter((b) => /^Accept/.test(b.getAttribute('aria-label') ?? '')).length }; });
  ok(inbox.accepts >= 1 && inbox.declines >= 1 && /rgba\(0, 0, 0, 0\)|transparent/.test(inbox.declineBg ?? ''), `${tag} Inbox: Accept is the primary, Decline a text action (${inbox.accepts} accept, ${inbox.declines} decline, decline bg ${inbox.declineBg})`);
  await page.goto(`${origin(PORTS.player)}/`); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(400);
  await page.click('a[href^="/you"]'); await sleep(600); await page.getByRole('tab', { name: /^Account$/ }).click(); await sleep(700);
  const acc = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="account-cat-profile"], [data-testid="account-cat-privacy"], [data-testid="account-cat-preferences"], [data-testid="account-cat-appearance"]').length, exits: [document.querySelector('[data-testid="sign-out"]'), document.querySelector('[data-testid="switch-account"]')].every((e) => e && e.getBoundingClientRect().height > 0), names: [document.querySelector('[data-testid="sign-out"]')?.getAttribute('aria-label'), document.querySelector('[data-testid="switch-account"]')?.getAttribute('aria-label')] }));
  ok(acc.rows === 4 && acc.exits, `${tag} Account: the four category rows (Profile, Privacy, Preferences, Appearance) and the two exits (${acc.names.join(' · ')})`);
  await ctx.close();
}
{
  const ctx = await ctxFor(390, 1000); const page = watch(await ctx.newPage(), 'guardian');
  await playerIn(page, 'guardian', PORTS.playerDemo);
  const g = await page.evaluate(() => { const cs = (el) => getComputedStyle(el); const req = document.querySelector('[data-testid^="guardian-request-"]'); const accept = [...document.querySelectorAll('[role="button"]')].find((b) => /^Accept$/.test(b.getAttribute('aria-label') ?? '')); const decline = [...document.querySelectorAll('[role="button"]')].find((b) => /^Decline$/.test(b.getAttribute('aria-label') ?? '')); const details = document.querySelector('[data-testid^="req-details-"]'); return { digest: !!document.querySelector('[data-testid="guardian-digest"]'), req: !!req, kicker: req?.querySelector('div')?.textContent, accept: !!accept, acceptBg: accept ? cs(accept).backgroundColor : null, declineBg: decline ? cs(decline).backgroundColor : null, details: !!details, messageVisible: !!document.querySelector('[data-testid^="req-message-"]'), pills: [...document.querySelectorAll('[data-testid="mobile-viewport"] div')].filter((d) => cs(d).borderRadius === '5px' && d.getBoundingClientRect().height > 0 && d.getBoundingClientRect().top < 900).length }; });
  ok(g.req && /Trial invitation|Conversation request/.test(g.kicker ?? ''), `Guardian: the request opens with its kind and the club (${g.kicker}; digest ${g.digest ? 'shown as a sentence' : 'absent — the log is a disclosure'})`);
  ok(g.accept && /rgb\(0, 230, 118\)|rgb\(51, 238, 124\)/.test(g.acceptBg ?? '') && /rgba\(0, 0, 0, 0\)|transparent/.test(g.declineBg ?? ''), `Guardian: Accept is the one primary, Decline a text action (accept ${g.acceptBg}, decline ${g.declineBg})`);
  ok(g.details && !g.messageVisible, `Guardian: the club's words, the notes and the scout line sit behind "View full message" (M24F.3 one-line rule) (details ${g.details}, message visible ${g.messageVisible})`);
  const reqText = async () => page.evaluate(() => document.querySelector('[data-testid^="guardian-request-"]')?.innerText ?? '');
  const closedText = await reqText();
  ok(!/\d{1,2}:\d{2}/.test(closedText.replace(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/g, '')), 'Guardian: the timestamp of the request (the scout line) is not on the first screen');
  await page.click('[data-testid^="req-details-"] >> nth=0'); await sleep(400);
  const openText = await reqText();
  ok(openText.length > closedText.length && /\d{1,2}:\d{2}/.test(openText), 'Guardian: "View details" reveals the scout and the time of the request — nothing is lost');
  ok(g.pills <= 3, `Guardian: ${g.pills} pills on the first screen (no row of equal badges)`);
  await ctx.close();
}

// ================================================================== R — the de-boxed dense screens (Pro, Trust & Safety)
console.log('\n— R: dense screens —');
for (const [who, port, org, name, role, hash] of [['Pro', PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', '#/recruitment'], ['Trust & Safety', PORTS.admin, null, null, null, null]]) {
  for (const w of [1024, 1440]) {
    const ctx = await ctxFor(w, undefined, { [origin(port)]: { [who === 'Pro' ? 'sb-theme:pro' : 'sb-theme:safety']: 'light' } });
    const page = await enter(ctx, port, org, name, role, `${who} dense ${w}`);
    if (hash) { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(900); }
    const r = await page.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const rows = [...document.querySelectorAll('.content .list-row')];
      const notices = [...document.querySelectorAll('.content .notice:not(.block):not(.warn)')];
      const filters = [...document.querySelectorAll('.content .filters')];
      return { rows: rows.length, rowBoxed: rows.filter((r) => cs(r).borderRadius !== '0px' || cs(r).borderLeftWidth !== '0px').length, notices: notices.length, noticeBoxed: notices.filter((n) => cs(n).backgroundColor !== 'rgba(0, 0, 0, 0)').length, filters: filters.length, filterBoxed: filters.filter((f) => cs(f).borderLeftWidth !== '0px' || cs(f).backgroundColor !== 'rgba(0, 0, 0, 0)').length, lowerPills: [...document.querySelectorAll('.content .pill')].filter((p) => /^[a-z]/.test(p.textContent.trim())).map((p) => p.textContent.trim()) };
    });
    const tag = `${who} ${w}px`;
    ok(r.rowBoxed === 0, `${tag}: ${r.rows} list rows, none boxed`);
    ok(r.noticeBoxed === 0, `${tag}: ${r.notices} explanatory notes, none a tinted box`);
    ok(r.filterBoxed === 0, `${tag}: ${r.filters} filter bar(s), none a card`);
    ok(r.lowerPills.length === 0, `${tag}: status labels are title-cased (${r.lowerPills.slice(0, 4).join(', ') || 'all'})`);
    await ctx.close();
  }
}

ok(errors.length === 0, `no page errors in any context (${errors.length ? errors.slice(0, 3).join(' | ') : 'clean'})`);
console.log(`\nm24fVisualLive: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
await browser.close(); statics.forEach((s) => s.close()); serverProc.kill('SIGTERM'); fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
