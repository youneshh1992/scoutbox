// M24F.5 — capture the 50 screens M24F.4 kept with a reason. Usage (from e2e/, after buildDemos.mjs): node tools/captureKeptScreens.mjs <outdir> [club|grassroots|agent|admin|player]
//   optional env: DEMO_DIR (default e2e/dist), PORT, CHROMIUM_PATH
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath as __f2p } from 'node:url';
const __here = path.dirname(__f2p(import.meta.url));
const DEMO_DIR = process.env.DEMO_DIR || path.join(__here, '..', 'dist'); const PORT = Number(process.env.PORT || 8777);
const out = process.argv[2]; const only = process.argv[3]; fs.mkdirSync(out, { recursive: true });
const FILES = { player: 'scoutbox-player-demo.html', club: 'scoutbox-club-demo.html', grassroots: 'scoutbox-grassroots-demo.html', agent: 'scoutbox-agent-demo.html', admin: 'scoutbox-admin-demo.html' };
http.createServer((q, r) => { const app = new URL(q.url, 'http://x').searchParams.get('app') || 'player'; r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(DEMO_DIR, FILES[app])).pipe(r); }).listen(PORT);
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const index = [];
const HEIGHT = `(() => { const root = document.querySelector('[data-testid="mobile-viewport"]') ?? document.querySelector('.content') ?? document.body; let h = document.scrollingElement.scrollHeight; for (const e of [root, ...root.querySelectorAll('*')]) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1 && e.getBoundingClientRect().width > 200) h = Math.max(h, e.scrollHeight + e.getBoundingClientRect().top); } const words = root.innerText.split(/\\s+/).filter(Boolean).length; return { h, words }; })()`;
async function shot(p, name) { await sleep(700); const vp = p.viewportSize(); const { h, words } = await p.evaluate(HEIGHT); if (h > vp.height + 4) { await p.setViewportSize({ width: vp.width, height: Math.round(Math.min(h + 60, 4200)) }); await sleep(700); } await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: false }); await p.setViewportSize(vp); await sleep(300); index.push({ name, words, height: h }); console.log(name, words, h); }
async function portal(app) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${app}: ${e.message}`));
  await p.goto(`http://localhost:${PORT}/?app=${app}`); await Promise.race([p.waitForSelector('.auth-card', { timeout: 30000 }), p.waitForSelector('nav.sidebar', { timeout: 30000 })]);
  if (!(await p.locator('nav.sidebar').count())) {
    if (app === 'admin') { await p.fill('input[type="password"]', 'scoutbox-admin'); await p.click('button.primary'); }
    else if (app === 'agent') { await p.click('.org-card:has-text("North Star")'); await p.fill('.enter-row input[aria-label]', 'Ana Costa'); await p.click('button:has-text("Enter workspace")'); }
    else { await p.waitForSelector('.org-card'); await p.click('.org-card >> nth=0'); await p.fill('.enter-row input', app === 'club' ? 'Maria Keane' : 'Sam Tully'); await p.click('button.primary'); }
  }
  await p.waitForSelector('nav.sidebar', { timeout: 30000 }); await sleep(900); return { ctx, p };
}
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await sleep(1200); };
const tab = async (p, label) => { const t = p.locator('.content [role="tab"], .content nav.subnav button, .content .tabs > button').filter({ hasText: label }); if (!(await t.count())) return false; await t.first().click(); await sleep(900); return true; };
const PORTAL = [
  ['search'], ['filmroom'], ['rooms'], ['briefs'], ['recruitment/matching'], ['recruitment/watchlists'],
  ['recruitment/second-look'], ['recruitment/second-look', 'Evidence Changed'], ['recruitment/second-look', 'Reviewed'], ['recruitment/second-look', 'Dismissed'],
  ['recruitment/nobody-missed'], ['recruitment/dashboard'], ['organisation'], ['verification'], ['verification', 'Agent consents'], ['verification', 'Transactions'], ['verification', 'References'], ['imports'], ['plan'],
];
const GR = [['filmroom'], ['rooms'], ['opendays'], ['briefs'], ['recruitment/matching'], ['recruitment/watchlists'], ['recruitment/second-look'], ['recruitment/second-look', 'Evidence Changed'], ['recruitment/second-look', 'Reviewed'], ['recruitment/second-look', 'Dismissed'], ['recruitment/nobody-missed'], ['recruitment/dashboard'], ['organisation'], ['verification'], ['verification', 'References'], ['imports'], ['plan']];
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
for (const [app, list] of [['club', PORTAL], ['grassroots', GR], ['agent', [['profile'], ['compliance'], ['inbox']]]]) {
  if (only && only !== app) continue;
  const { ctx, p } = await portal(app);
  for (const [route, t] of list) { await go(p, '#/' + route); if (t && !(await tab(p, t))) { console.log('NO TAB', app, route, t); continue; } await shot(p, `${app}-${slug(route)}${t ? '-' + slug(t) : ''}`); }
  await ctx.close();
}
if (!only || only === 'admin') {
  const { ctx, p } = await portal('admin');
  for (const [g, s] of [['Evidence', 'Trust'], ['Verification', 'Verification'], ['Agents', 'Agent transactions']]) { await p.locator(`nav.sidebar button:has-text("${g}")`).first().click(); await sleep(700); const sub = p.locator('nav.subnav button').filter({ hasText: s }); if (await sub.count()) { await sub.first().click(); await sleep(900); } await shot(p, `admin-${slug(g)}-${slug(s)}`); }
  await ctx.close();
}
if (!only || only === 'player') {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`player: ${e.message}`));
  await p.goto(`http://localhost:${PORT}/?app=player`); await p.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await p.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await p.waitForSelector('[data-testid="home-joined"]', { timeout: 30000 }); await sleep(900);
  const ptab = async (label) => { const t = p.getByRole('tab', { name: label, exact: true }); if (!(await t.count())) return false; await t.last().click(); await sleep(800); return true; };
  await p.click('a[href^="/opportunities"]'); await sleep(1200); await shot(p, 'player-opportunities-overview');
  if (await ptab('Board')) await shot(p, 'player-opportunities-board');
  const trialCat = p.locator('[data-testid="cat-trial"]'); if (await trialCat.count()) { await trialCat.first().click(); await sleep(900); await shot(p, 'player-opportunities-trial'); }
  await p.click('a[href^="/you"]'); await sleep(1000); await ptab('Clubs');
  await shot(p, 'player-you-clubs-current');
  for (const s of ['Requests', 'History']) { if (await ptab(s)) await shot(p, `player-you-clubs-${s.toLowerCase()}`); }
  await ctx.close();
  const g = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const q = await g.newPage(); q.on('pageerror', (e) => errors.push(`guardian: ${e.message}`));
  await q.goto(`http://localhost:${PORT}/?app=player`); await q.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const gEnter = q.locator('[data-testid="demo-identities"] >> text=Enter'); const n = await gEnter.count(); await gEnter.nth(n - 1).click(); await sleep(3000); await shot(q, 'guardian-dashboard');
  await g.close();
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ index, errors }, null, 1));
console.log(JSON.stringify({ shots: index.length, errors })); await b.close(); process.exit(0);
