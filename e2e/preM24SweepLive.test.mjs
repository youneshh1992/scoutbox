// PRE-M24 final defect sweep — LIVE regressions for the browser-side defects
// the sweep fixed (PRE_M24_DEFECT_REGISTER.md). Real server, real Club,
// Grassroots, Agent and Player bundles.
//
//   S1  sign-out revokes the session on the server (PM-4)
//   S2  a sign-out in another tab of the same browser ends this tab too (PM-3)
//   S3  a colleague removed mid-session is signed out on the next refresh
//       signal, and the event stream stops asking for tickets (PM-3)
//   S4  Grassroots and Agent: a server-side logout signs the open tab out (PM-3)
//   S5  Player: an ended session returns the app to onboarding instead of
//       staying "signed in" with every request refused (PM-5)
//   S6  Escape closes the notification panel and the phone drawer; focus
//       returns; the menu button says whether the drawer is open (PM-7)
//   S7  the Report & block and player drawers are labelled modal dialogs:
//       focus moves in, Escape closes, focus returns (PM-8); player cards are
//       keyboard controls (PM-14)
//   S8  an outdated Player link shows a translated ScoutBox not-found screen,
//       never the developer page and its sitemap (PM-6); /_sitemap itself no
//       longer lists the route files and SDK version (PM-13)
//   S9  a server with development logins disabled gets no demo identities on
//       the Player landing (PM-11)
//   S10 a date-only contract day reads the same in Los Angeles (§27)
//   S11 a history row with an unreadable timestamp (legacy or damaged data)
//       shows a dash, never "Invalid Date" (PM-12)
//   and zero page errors in every context.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4043;
const API = `http://localhost:${API_PORT}`;
const PORTS = { club: 8743, grassroots: 8744, player: 8843, agent: 8943 };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-prem24live-'));
const DAY = 86_400_000;
const T0 = Date.now();

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
const DIST = 'dist-livepm';
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

const startApi = () => spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1' }, stdio: 'ignore' });
let serverProc = startApi();
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
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

const apiUp = async () => { for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) return; } catch { /* booting */ } await sleep(250); } };
await apiUp();
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token, extra = {}) => {
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const key = () => `pm-${Math.random().toString(36).slice(2, 10)}`;

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
async function waitFor(fn, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (await fn().catch(() => false)) return true; await sleep(250); } return false; }

async function enterOrg(ctx, port, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${port}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button.primary:has-text("Enter"), button.primary:has-text("Entrer")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}
const tokenIn = (page, key) => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null')?.token ?? null; } catch { return null; } }, key);
const refreshSignal = (page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
async function enterPlayer(ctx, rowText, who) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PORTS.player}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  return page;
}

// ------------------------------------------------------------------ fixture: an issued Offer starting 2027-07-01
const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
const lifecycle = async (RID, action, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID)).case.rev, ...extra }, maria.token);
const RS = (await j('POST', '/org/rooms', { playerId: 'pl-svensson', sourceContext: 'search' }, maria.token)).body.room.roomId;
await lifecycle(RS, 'startReview'); await lifecycle(RS, 'shortlist');
const dr = await j('POST', `/org/rooms/${RS}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: 'n' }, maria.token);
await j('POST', `/org/rooms/${RS}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, maria.token);
const c = await j('POST', `/org/rooms/${RS}/offers`, { terms: { role: 'Winger', squad: 'U23', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 14 * DAY, clientKey: key() }, maria.token, at(T0));
const iss = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0));
ok(c.status === 201 && iss.status === 200, 'fixture: an Offer to Svensson starting 2027-07-01 is issued');

// ================================================================== S1–S3 Club sessions
console.log('\n— S1–S3: Club sessions —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const a = await enterOrg(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'club-a');
  const b = watch(await ctx.newPage(), 'club-b');
  await b.goto(`http://localhost:${PORTS.club}/#/recruitment/rooms/${RS}`); await b.waitForSelector('nav.sidebar', { timeout: 20000 });
  const tok = await tokenIn(a, 'scoutbox-club-session');
  await a.click('button:has-text("Switch org")');
  ok(await waitFor(async () => (await a.locator('nav.sidebar').count()) === 0), 'S1a Switch org returns the tab to the login screen');
  const after = await j('GET', '/org/notifications', undefined, tok);
  neg(!!tok && after.status === 401, `S1b the signed-out token is refused by the server (${after.status}) — sign-out revokes (PM-4)`);
  neg(await waitFor(async () => (await b.locator('nav.sidebar').count()) === 0, 10000), 'S2 the other tab of the same browser leaves the workspace too (PM-3)');
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tom = await enterOrg(ctx, PORTS.club, 'Eastport FC', 'Tom Field', 'First-Team Scout', 'tom');
  let tickets = 0; tom.on('request', (r) => { if (r.url().includes('/events/ticket')) tickets++; });
  const staff = (await j('GET', '/org/staff', undefined, maria.token)).body;
  const tomId = staff.find((u) => u.name === 'Tom Field')?.id;
  const rm = await j('POST', `/org/staff/${tomId}/remove`, {}, maria.token);
  await sleep(800); await refreshSignal(tom);
  neg(rm.status === 200 && await waitFor(async () => (await tom.locator('nav.sidebar').count()) === 0, 12000), 'S3a a colleague removed mid-session is returned to the login screen on the next refresh signal (PM-3)');
  const t0 = tickets; await sleep(12000);
  neg(tickets - t0 === 0, `S3b and no event-stream ticket is requested afterwards (${tickets - t0} in 12 s) — no retry storm`);
  await ctx.close();
}

// ================================================================== S4 Grassroots and Agent
console.log('\n— S4: Grassroots and Agent sessions —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const g = await enterOrg(ctx, PORTS.grassroots, 'Moss', 'Pat Doyle', 'Head Coach', 'pat');
  const tok = await tokenIn(g, 'scoutbox-grassroots-session');
  await j('POST', '/auth/logout', {}, tok);
  await refreshSignal(g);
  neg(await waitFor(async () => (await g.locator('nav.sidebar').count()) === 0, 12000), 'S4a Grassroots: a session ended on the server signs the open tab out (PM-3)');
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
  await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
  const a = await enterOrg(ctx, PORTS.agent, 'North Star', 'Ana Agent', 'Agent', 'ana');
  const tok = await tokenIn(a, 'scoutbox-agent-session');
  await j('POST', '/auth/logout', {}, tok);
  await refreshSignal(a);
  neg(await waitFor(async () => (await a.locator('nav.sidebar').count()) === 0, 12000), 'S4b Agent: a session ended on the server signs the open tab out');
  await ctx.close();
}

// ================================================================== S5 Player: an ended session
console.log('\n— S5: Player session —');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await enterPlayer(ctx, 'Kola Adeyemi', 'kola');
  const tok = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-player-tokens-v1') ?? '{}')['pl-adeyemi'] ?? null; } catch { return null; } });
  await j('POST', '/auth/logout', {}, tok);
  await p.reload();
  neg(await waitFor(async () => { const t = await p.locator('body').innerText(); return /Our promises to every player|Free for players/.test(t) && !/Your visibility right now/.test(t); }, 20000), 'S5a an ended Player session returns the app to onboarding on reload, not a signed-in shell whose every request fails (PM-5)');
  const q = await enterPlayer(ctx, 'Kola Adeyemi', 'kola2');
  const tok2 = await q.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-player-tokens-v1') ?? '{}')['pl-adeyemi'] ?? null; } catch { return null; } });
  await q.goto(`http://localhost:${PORTS.player}/you?tab=account`);
  const signOut = q.locator('text=/^Log out$/').last();
  await signOut.waitFor({ timeout: 20000 });
  await signOut.click();
  const gone = await waitFor(() => q.evaluate(() => { try { return !('pl-adeyemi' in JSON.parse(localStorage.getItem('scoutbox-player-tokens-v1') ?? '{}')); } catch { return false; } }), 8000);
  await sleep(800);
  const refused = (await j('GET', '/player/me', undefined, tok2)).status === 401;
  neg(!!tok2 && gone && refused, `S5b the Player's Log out forgets the token on the device and revokes it on the server (forgotten ${gone}, refused ${refused}) (PM-4)`);
  await ctx.close();
}

// ================================================================== S6–S7 dialogs
console.log('\n— S6–S7: Escape, focus and dialog roles —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await enterOrg(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'dialogs');
  await pg.locator('button.topbar-bell').focus(); await pg.keyboard.press('Enter'); await sleep(500);
  const open = await pg.locator('.bell-panel').count();
  await pg.keyboard.press('Escape'); await sleep(400);
  neg(open === 1 && (await pg.locator('.bell-panel').count()) === 0 && await pg.evaluate(() => document.activeElement?.classList?.contains('topbar-bell')), 'S6a Escape closes the notification panel and focus returns to the bell (PM-7)');
  await pg.setViewportSize({ width: 390, height: 800 }); await sleep(400);
  const burger = pg.locator('.nav-hamburger');
  ok((await burger.getAttribute('aria-expanded')) === 'false', 'S6b the menu button says the drawer is closed');
  await burger.focus(); await pg.keyboard.press('Enter'); await sleep(500);
  ok((await burger.getAttribute('aria-expanded')) === 'true' && (await pg.locator('nav.sidebar.drawer-open').count()) === 1, 'S6c open: aria-expanded is true');
  await pg.keyboard.press('Escape'); await sleep(500);
  neg((await pg.locator('nav.sidebar.drawer-open').count()) === 0 && await pg.evaluate(() => document.activeElement?.classList?.contains('nav-hamburger')), 'S6d Escape closes the drawer and focus returns to the menu button (PM-7)');
  await pg.setViewportSize({ width: 1280, height: 900 }); await sleep(300);
  const rb = pg.locator('button:has-text("Report / Block")').first();
  await rb.focus(); await pg.keyboard.press('Enter'); await sleep(600);
  const dlg = pg.locator('.drawer[role="dialog"][aria-modal="true"]');
  const inside = await pg.evaluate(() => !!document.activeElement?.closest('.drawer'));
  ok((await dlg.count()) === 1 && !!(await dlg.getAttribute('aria-label')) && inside, 'S7a Report & block opens as a labelled modal dialog with focus inside (PM-8)');
  await pg.keyboard.press('Escape'); await sleep(400);
  neg((await pg.locator('.drawer').count()) === 0 && await pg.evaluate(() => /Report/.test(document.activeElement?.textContent ?? '')), 'S7b Escape closes it and focus returns to its button (PM-8)');
  await pg.evaluate(() => { location.hash = '#/search'; });
  await pg.waitForSelector('.player-card', { timeout: 20000 });
  const firstCard = pg.locator('.player-card').first();
  neg((await firstCard.getAttribute('role')) === 'button' && (await firstCard.getAttribute('tabindex')) === '0', 'S7c a player card is a keyboard control (role=button, in the tab order) (PM-14)');
  await firstCard.focus(); await pg.keyboard.press('Enter'); await sleep(1200);
  const pd = pg.locator('.drawer[role="dialog"][aria-modal="true"]');
  neg((await pd.count()) === 1 && await pg.evaluate(() => !!document.activeElement?.closest('.drawer')), 'S7d Enter on a focused player card opens the player drawer as a modal dialog with focus inside (PM-14, PM-8)');
  await pg.keyboard.press('Escape'); await sleep(500);
  neg((await pg.locator('.drawer').count()) === 0 && await pg.evaluate(() => document.activeElement?.classList?.contains('player-card')), 'S7e Escape closes the player drawer and focus returns to the card (PM-8)');
  const box = firstCard.locator('input[type="checkbox"]').first();
  if (await box.count()) {
    await box.focus(); await pg.keyboard.press('Space'); await sleep(600);
    neg((await pg.locator('.drawer').count()) === 0 && await box.isChecked(), 'S7f Space on the compare checkbox inside a card ticks it and does not open the drawer');
    await pg.keyboard.press('Space'); await sleep(300);
  }
  await ctx.close();
}

// ================================================================== S8–S9 Player routes
console.log('\n— S8–S9: Player not-found and demo identities —');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = watch(await ctx.newPage(), 'nf');
  await pg.goto(`http://localhost:${PORTS.player}/opportunities/old-offer-link`); await sleep(2500);
  const txt = await pg.locator('body').innerText();
  neg(/This page does not exist/.test(txt) && !/Unmatched Route/.test(txt) && (await pg.locator('a[href="/_sitemap"]').count()) === 0, 'S8a an outdated link shows the ScoutBox not-found screen, no developer page, no sitemap link (PM-6)');
  await pg.click('[data-testid="not-found-home"]'); await sleep(2000);
  ok(!/This page does not exist/.test(await pg.locator('body').innerText()), 'S8b its button leads away from the not-found screen');
  await pg.goto(`http://localhost:${PORTS.player}/_sitemap`); await sleep(2500);
  const sm = await pg.locator('body').innerText();
  neg(/This page does not exist/.test(sm) && !/System Information|Expo SDK|_layout\.tsx|\+not-found/.test(sm), 'S8d /_sitemap no longer lists route files, SDK version and build mode — it shows the not-found screen (PM-13)');
  await ctx.close();
  const fr = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await fr.addInitScript(() => { try { localStorage.setItem('sb-player-lang', 'fr'); } catch { /* */ } });
  const fp = watch(await fr.newPage(), 'nf-fr');
  await fp.goto(`http://localhost:${PORTS.player}/nope`); await sleep(2500);
  ok(/Cette page n’existe pas/.test(await fp.locator('body').innerText()), 'S8c the not-found screen is translated');
  await fr.close();
  const prod = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pp = watch(await prod.newPage(), 'prod');
  await pp.route('**/health', async (route) => { const r = await route.fetch(); const b = await r.json(); await route.fulfill({ response: r, json: { ...b, devLogins: false } }); });
  await pp.goto(`http://localhost:${PORTS.player}/`);
  await pp.waitForSelector('text=Our promises to every player', { timeout: 40000 }); await sleep(1500);
  neg((await pp.locator('div', { hasText: 'Kola Adeyemi' }).filter({ has: pp.locator('text=Enter') }).count()) === 0, 'S9 a server that disables development logins gets no demo identities on the Player landing (PM-11)');
  await prod.close();
}

// ================================================================== S10 date-only in Los Angeles
console.log('\n— S10: a date-only day west of Greenwich —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'en-GB' });
  const pg = await enterOrg(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'tz');
  await pg.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${RS}/offer`); await pg.reload();
  await pg.waitForSelector('[aria-label="Room header"]', { timeout: 25000 }); await sleep(1500);
  const txt = await pg.locator('body').innerText();
  const tz = await pg.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  neg(tz === 'America/Los_Angeles' && /1 Jul 2027|2027-07-01/.test(txt) && !/30 Jun 2027|2027-06-30/.test(txt), 'S10 the Offer start day 2027-07-01 reads 1 July in Los Angeles, never 30 June (§27)');
  await ctx.close();
}

// ================================================================== S11 an unreadable timestamp
console.log('\n— S11: an unreadable timestamp in a history row —');
{
  serverProc.kill('SIGTERM');
  await new Promise((r) => serverProc.once('exit', r));
  const { openStore } = await import(path.join(ROOT, 'scoutbox-server/store.mjs'));
  const store = openStore(DATA); const snap = store.load();
  const room = snap.db.recruitmentCases.find((k) => k.id === RS);
  room.history.push({ id: 'hist-pm12', at: 'not-a-time', action: 'room_status_changed', by: { kind: 'org', id: 'legacy', name: 'Legacy import' }, detail: { from: 'watching', to: 'reviewing' } });
  store.save({ ...snap, db: snap.db });
  store.close?.();
  serverProc = startApi(); await apiUp();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await enterOrg(ctx, PORTS.club, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'stamp');
  for (const h of [`#/recruitment/rooms/${RS}`, `#/recruitment/rooms/${RS}/activity`, '#/organisation']) {
    await pg.evaluate((x) => { location.hash = x; }, h); await sleep(2200);
    const txt = await pg.locator('body').innerText();
    neg(!/Invalid Date|NaN/.test(txt) && txt.length > 200, `S11 ${h.replace(RS, '<room>')}: the damaged stamp never reads "Invalid Date" (PM-12)`);
  }
  await ctx.close();
}

ok(errors.length === 0, `zero page errors across every context (${errors.length ? errors.join(' | ') : 'none'})`);
console.log(`\npreM24SweepLive: ${passed} checks passed (${negatives} negative)`);
process.exit(0);
