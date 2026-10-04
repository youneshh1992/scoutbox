// M24F.5 freeze — asset / font / console crawl of the FINAL demo bundles.
// Usage (from e2e/, after buildDemos.mjs + buildConnectedDemo.mjs):
//   node tools/assetCrawl.mjs            [CHROMIUM_PATH=…] [DEMO_DIR=…] [LAUNCHER_HTML=…] [CRAWL_OUT=…]
// Serves each bundle from a local server, records every request, response, failed
// request, console message and page error, walks the approved M24F.5 screens, and
// checks fonts (document.fonts status + computed face), images and background photos.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath as __f2p } from 'node:url';
const __here = path.dirname(__f2p(import.meta.url));
const DIST = process.env.DEMO_DIR || path.join(__here, '..', 'dist');
// The launcher page is a published artifact, not part of the repository; pass LAUNCHER_HTML to include it.
const LAUNCHER = process.env.LAUNCHER_HTML || '';
const FILES = { launcher: LAUNCHER, club: `${DIST}/scoutbox-club-demo.html`, grassroots: `${DIST}/scoutbox-grassroots-demo.html`, agent: `${DIST}/scoutbox-agent-demo.html`, admin: `${DIST}/scoutbox-admin-demo.html`, player: `${DIST}/scoutbox-player-demo.html`, connected: `${DIST}/scoutbox-connected-demo.html` };
const PORT = 8811;
const served = [];
http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'); const app = u.searchParams.get('app');
  if (u.pathname === '/' || u.pathname === '/index.html' || app) { const f = FILES[app || 'player']; served.push(`200 ${u.pathname}`); r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(f).pipe(r); return; }
  // Single-file bundles should request nothing else from the host. Record any such request as a miss.
  served.push(`404 ${u.pathname}`); r.writeHead(404); r.end();
}).listen(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = {};

const FONT_PROBE = `(() => {
  const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, status: f.status }));
  const inter = faces.filter((f) => /^Inter/.test(f.family));
  const failed = faces.filter((f) => f.status === 'error');
  const leaves = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim() && el.getBoundingClientRect().width > 0);
  const comp = {}; for (const el of leaves.slice(0, 600)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); comp[f] = (comp[f] || 0) + 1; }
  const top = Object.entries(comp).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const brokenImgs = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src').slice(0, 60));
  const photoBg = [...document.querySelectorAll('*')].map((el) => getComputedStyle(el).backgroundImage).filter((bg) => /url\\(/.test(bg) && !/data:image\\/svg/.test(bg)).map((s) => s.slice(0, 80));
  const emoji = (document.body.innerText.match(/\\p{Extended_Pictographic}/gu) || []).filter((c) => !'✓✕○➤⊘◷↻✗›⌄▲▼⚠©®™'.includes(c));
  return { emoji: emoji.join(''), interFaces: inter.length, interLoaded: inter.filter((f) => f.status === 'loaded').length, interErrors: inter.filter((f) => f.status === 'error').length, failedFaces: failed.map((f) => f.family + ' ' + f.weight), checkInter: document.fonts.check('16px Inter'), computed: comp, top, brokenImgs, photoBg };
})()`;

async function crawl(name, walk) {
  const ctx = await b.newContext({ viewport: name === 'player' || name === 'connected' ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const rec = { requests: [], failed: [], bad: [], external: [], console: [], pageErrors: [], probes: [], presence: {} };
  p.on('request', (r) => { const u = r.url(); rec.requests.push(u.slice(0, 120)); if (!/^(data|blob|about):/.test(u) && !u.startsWith(`http://localhost:${PORT}/`)) rec.external.push(u.slice(0, 120)); });
  p.on('requestfailed', (r) => { const u = r.url(); if (!/^(data|blob):/.test(u)) rec.failed.push(`${r.failure()?.errorText} ${u.slice(0, 100)}`); });
  p.on('response', (r) => { if (r.status() >= 400) rec.bad.push(`${r.status()} ${r.url().slice(0, 100)}`); });
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') rec.console.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => rec.pageErrors.push(e.message.slice(0, 160)));
  const probe = async (tag) => { await sleep(600); const r = await p.evaluate(FONT_PROBE); rec.probes.push({ tag, ...r }); };
  await walk(p, probe, rec);
  await ctx.close();
  results[name] = rec;
  const fontsBad = rec.probes.some((x) => x.interErrors > 0 || x.failedFaces.length);
  const nonInterTop = rec.probes.filter((x) => x.top && !/^Inter/.test(x.top)).map((x) => `${x.tag}:${x.top}`);
  console.log(`${name}: requests=${rec.requests.length} failed=${rec.failed.length} http>=400=${rec.bad.length} external=${rec.external.length} console=${rec.console.length} pageErrors=${rec.pageErrors.length} fontErrors=${fontsBad} nonInterTop=${nonInterTop.join(',') || 0} brokenImgs=${rec.probes.reduce((n, x) => n + x.brokenImgs.length, 0)} photoBg=${rec.probes.reduce((n, x) => n + x.photoBg.length, 0)} emoji=${rec.probes.map((x) => x.emoji).join('') || 0}`);
}
const go = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await sleep(1100); };
async function portalEnter(p, app) {
  await p.goto(`http://localhost:${PORT}/?app=${app}`); await Promise.race([p.waitForSelector('.auth-card', { timeout: 30000 }), p.waitForSelector('nav.sidebar', { timeout: 30000 })]);
}
async function portalSignIn(p, app) {
  if (await p.locator('nav.sidebar').count()) { await sleep(900); return; }
  if (app === 'admin') { await p.fill('input[type="password"]', 'scoutbox-admin'); await p.click('button.primary'); }
  else if (app === 'agent') { await p.click('.org-card:has-text("North Star")'); await p.fill('.enter-row input[aria-label]', 'Ana Costa'); await p.click('button:has-text("Enter workspace")'); }
  else { await p.waitForSelector('.org-card'); await p.click('.org-card >> nth=0'); await p.fill('.enter-row input', app === 'club' ? 'Maria Keane' : 'Sam Tully'); await p.click('button.primary'); }
  await p.waitForSelector('nav.sidebar', { timeout: 30000 }); await sleep(900);
}

if (LAUNCHER) await crawl('launcher', async (p, probe, rec) => { await p.goto(`http://localhost:${PORT}/?app=launcher`); await sleep(1500); await probe('launcher'); rec.presence.cards = await p.locator('a[href*="claude.ai/artifact"]').count(); });

await crawl('club', async (p, probe, rec) => {
  await portalEnter(p, 'club'); await probe('auth'); await portalSignIn(p, 'club'); await probe('home');
  await go(p, '#/recruitment/nobody-missed'); await probe('nobody-missed'); rec.presence.nobodyMissed = (await p.locator('.nm-ring').count()) === 1 && (await p.locator('.nm-row').count()) >= 1;
  await go(p, '#/recruitment/dashboard'); await probe('dashboard'); rec.presence.dashboard = (await p.locator('[data-kpis] [data-kpi]').count()) === 4 && (await p.locator('[data-visual="funnel"] .dash-bar').count()) >= 1 && (await p.locator('[data-visual="time"]').count()) === 1 && (await p.locator('[data-visual="coverage"]').count()) === 1 && (await p.locator('[data-attention] li').count()) <= 5;
  await go(p, '#/filmroom'); await sleep(800); await probe('filmroom');
});
await crawl('grassroots', async (p, probe, rec) => {
  await portalEnter(p, 'grassroots'); await probe('auth');
  rec.presence.authTurf = await p.evaluate(() => { const el = document.querySelector('.auth-promo'); return el ? getComputedStyle(el).backgroundImage.slice(0, 40) : 'none'; });
  await portalSignIn(p, 'grassroots'); await go(p, '#/feed'); await probe('home'); rec.presence.home = /Find players near you/.test(await p.locator('.content').innerText());
  await go(p, '#/opendays'); await probe('radar'); rec.presence.radar = (await p.locator('[data-testid="radar-read"]').count()) === 1 && (await p.locator('[data-testid="radar"] input').count()) === 0;
  await go(p, '#/squad'); await probe('squad'); rec.presence.squad = (await p.locator('.squad-row .squad-name').count()) >= 1;
});
await crawl('agent', async (p, probe, rec) => {
  await portalEnter(p, 'agent'); await probe('auth'); await portalSignIn(p, 'agent'); await go(p, '#/home'); await probe('home');
  const c = await p.locator('nav.sidebar .active, nav.sidebar [aria-current="page"]').first().evaluate((el) => getComputedStyle(el).color);
  rec.presence.activeNavColor = c; const [r, g, bl] = (c.match(/\d+/g) || []).map(Number); rec.presence.gold = r > bl + 40 && g > bl;
  await go(p, '#/transactions'); await probe('transactions'); await go(p, '#/compliance'); await probe('compliance');
});
await crawl('admin', async (p, probe, rec) => {
  await portalEnter(p, 'admin'); await probe('auth'); await portalSignIn(p, 'admin'); await probe('home');
  await p.locator('nav.sidebar button:has-text("Verification")').first().click(); await sleep(900); await probe('verification');
});
await crawl('player', async (p, probe, rec) => {
  await p.goto(`http://localhost:${PORT}/?app=player`); await p.waitForSelector('text=Our promises to every player', { timeout: 40000 }); await probe('auth');
  await p.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await p.waitForSelector('[data-testid="home-identity"]', { timeout: 30000 }); await sleep(900); await probe('home');
  const t0 = Date.now();
  const home = await p.locator('[data-testid="home-identity"]').innerText();
  rec.presence.home = !/Good (morning|afternoon|evening)|View (your )?Passport/.test(home) && /Joined [A-Z][a-z]+ \d{4}/.test(home);
  const tab = async (n) => { const t = p.getByRole('tab', { name: n, exact: true }); if (!(await t.count())) return false; await t.last().click(); await sleep(700); return true; };
  await p.click('a[href^="/football"]'); await sleep(1100);
  rec.presence.development = (await tab('Development')) && (await p.locator('[data-testid="dev-root"]').count()) === 1; await probe('development');
  rec.presence.boxcam = (await tab('Box Cam')) && (await p.locator('[data-testid="boxcam-start"]').count()) === 1; await probe('boxcam');
  rec.presence.combine = (await tab('Combine')) && (await p.locator('[data-testid^="combine-protocol-"]').count()) >= 3; await probe('combine');
  await p.click('a[href^="/you"]'); await sleep(1000); await tab('Profile');
  rec.presence.evidence = (await tab('Evidence')) && (await p.locator('[data-testid="evidence-latest-thumb"]').count()) === 1; await probe('evidence');
  await p.click('a[href^="/opportunities"]'); await sleep(1000); await p.locator('[data-testid="cat-offer"]').first().click(); await sleep(700); await tab('Offer');
  rec.presence.offer = /View terms/.test(await p.locator('[data-testid="offer-section"]').innerText()) && /Offer acceptance is not a signature\./.test(await p.locator('[data-testid="offer-section"]').innerText()); await probe('offer');
  const wait = 9500 - (Date.now() - t0); if (wait > 0) await sleep(wait);
  await p.click('a[href="/inbox"]'); await sleep(1300); rec.presence.inbox = (await p.locator('[data-testid^="inbox-request-"], [data-testid^="thread-"]').count()) >= 1; await probe('inbox');
});
await crawl('connected', async (p, probe, rec) => {
  await p.goto(`http://localhost:${PORT}/?app=connected`); await sleep(6000); await probe('host');
  rec.presence.frames = p.frames().length;
  for (const f of p.frames().slice(1)) { try { const t = await f.evaluate(() => document.fonts.check('16px Inter') + ' ' + getComputedStyle(document.body).fontFamily.split(',')[0]); rec.presence[`frame-${p.frames().indexOf(f)}`] = t; } catch { /* srcdoc not ready */ } }
});

fs.writeFileSync(process.env.CRAWL_OUT || path.join(process.cwd(), 'asset-crawl.json'), JSON.stringify({ served: [...new Set(served)], results }, null, 1));
console.log('host paths served:', [...new Set(served)].join(' | '));
for (const [k, v] of Object.entries(results)) console.log(k, 'presence', JSON.stringify(v.presence));
await b.close(); process.exit(0);
