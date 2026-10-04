// M24F.4/M24F.5 — captures + density metrics for the high-priority screens (Player 390 + widths, portals).
// Usage (from e2e/, after buildDemos.mjs): node tools/captureScreens.mjs <outdir> <prefix> [player|portals|all]
//   optional env: DEMO_DIR (default e2e/dist), PORT, CHROMIUM_PATH
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath as __f2p } from 'node:url';
const __here = path.dirname(__f2p(import.meta.url));
const DEMO_DIR = process.env.DEMO_DIR || path.join(__here, '..', 'dist'); const PORT = Number(process.env.PORT || 8776);
const out = process.argv[2]; const prefix = process.argv[3]; const which = process.argv[4] || 'all'; fs.mkdirSync(out, { recursive: true });
const FILES = { player: 'scoutbox-player-demo.html', club: 'scoutbox-club-demo.html', grassroots: 'scoutbox-grassroots-demo.html', agent: 'scoutbox-agent-demo.html', admin: 'scoutbox-admin-demo.html' };
http.createServer((q, r) => { const app = new URL(q.url, 'http://x').searchParams.get('app') || 'player'; r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(DEMO_DIR, FILES[app])).pipe(r); }).listen(PORT);
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const metrics = {};
const MEASURE = `(() => {
  const root = document.querySelector('[data-testid="mobile-viewport"]') ?? document.querySelector('.content') ?? document.querySelector('main') ?? document.body;
  const hidden = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (e.getAttribute('aria-hidden') === 'true' || cs.display === 'none' || cs.visibility === 'hidden') return true; if (e.tagName === 'DETAILS' && !e.open && !el.closest('summary')) return true; } return false; };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !hidden(el); };
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let words = 0; let n; const runs = []; while ((n = tw.nextNode())) { const s = n.textContent.replace(/\\s+/g, ' ').trim(); if (s && n.parentElement && vis(n.parentElement) && !['SCRIPT','STYLE','OPTION'].includes(n.parentElement.tagName)) { words += s.split(' ').length; } }
  const leaves = [...root.querySelectorAll('*')].filter((el) => vis(el) && [...el.children].every((c) => c.tagName === 'SPAN' || c.tagName === 'B' || c.tagName === 'I' || c.tagName === 'BR' || c.tagName === 'CODE'));
  const paragraphs = leaves.map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => t.length > 140).length;
  const pageBg = getComputedStyle(document.body).backgroundColor;
  const all = [...root.querySelectorAll('div, section, article, li, p, span, button, a, td')].filter(vis);
  const cards = all.filter((el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.width > 180 && r.height > 56 && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== pageBg || parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderBottomWidth) > 0 && parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.borderRightWidth) > 0) && parseFloat(cs.borderTopLeftRadius) >= 8 && el.textContent.trim().length > 0; }).length;
  const bordered = all.filter((el) => { if (['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) return false; const cs = getComputedStyle(el); return ['borderTopWidth','borderBottomWidth','borderLeftWidth','borderRightWidth'].every((k) => parseFloat(cs[k]) > 0) && cs.borderTopStyle !== 'none' && el.textContent.trim().length > 0 && el.getBoundingClientRect().width > 40; }).length;
  let scroller = document.scrollingElement; for (const e of [root, ...root.querySelectorAll("*")]) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1 && e.getBoundingClientRect().width > 200 && e.scrollHeight > scroller.scrollHeight) scroller = e; }
  const fonts = {}; for (const el of leaves.slice(0, 400)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; }
  const pills = all.filter((el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.height < 34 && r.width < 200 && parseFloat(cs.borderTopLeftRadius) >= 10 && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0) && el.children.length <= 1 && el.textContent.trim().length > 0 && el.textContent.trim().length < 30; }).length;
  return { words, paragraphs, cards, pills, bordered, height: scroller.scrollHeight, fonts };
})()`;
async function shot(p, name, tag, full = true) { await sleep(500); const m = await p.evaluate(MEASURE); metrics[`${name}-${tag}`] = m; const vp = p.viewportSize(); if (full && m.height > vp.height + 4) { await p.setViewportSize({ width: vp.width, height: Math.min(m.height + 120, 6000) }); await sleep(700); await p.screenshot({ path: path.join(out, `${prefix}-${name}-${tag}.png`), fullPage: true }); await p.setViewportSize(vp); await sleep(400); } else { await p.screenshot({ path: path.join(out, `${prefix}-${name}-${tag}.png`), fullPage: full }); } console.log(name, tag, JSON.stringify(m)); }
const tab = async (p, label) => { const t = p.getByRole('tab', { name: label, exact: true }); const n = await t.count(); if (!n) return false; await t.nth(n - 1).click(); await sleep(700); return true; };


const enterKola = async (p) => { await p.goto(`http://localhost:${PORT}/?app=player`); await p.waitForSelector('text=Our promises to every player', { timeout: 40000 }); await p.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await p.waitForSelector('[data-testid="home-joined"]', { timeout: 30000 }); await sleep(900); };
const back = async (p) => { const b = p.locator('[data-testid="detail-back"], [data-testid="dev-back"], [data-testid="evidence-back"], [aria-label="Back"]').first(); if (await b.count()) { await b.click(); await sleep(500); } };
if (which === 'player' || which === 'all') {
  for (const [w, h] of [[320, 700], [430, 932], [640, 360]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`player ${w}: ${e.message}`));
    await enterKola(p); await shot(p, 'home', `${w}x${h}`, false); await ctx.close();
  }
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`player 390: ${e.message}`));
  await enterKola(p); const t0 = Date.now();
  await shot(p, 'home', 390); await shot(p, 'home-fold', 390, false);
  const act = p.locator('[data-testid="home-activity-all"]').first(); if (await act.count()) { await act.click(); await sleep(700); await shot(p, 'activity', 390); await back(p); }
  await p.click('a[href^="/football"]'); await sleep(1200); await shot(p, 'passport', 390);
  const trust = p.locator('[data-testid="trust-card"]').first(); if (await trust.count()) { await trust.scrollIntoViewIfNeeded(); await sleep(400); await trust.screenshot({ path: path.join(out, `${prefix}-trust-390.png`) }); metrics['trust-390'] = await trust.evaluate((el) => ({ words: el.innerText.split(/\s+/).filter(Boolean).length, text: el.innerText.slice(0, 300) })); console.log('trust', JSON.stringify(metrics['trust-390'])); }
  if (await tab(p, 'Development')) await shot(p, 'development', 390);
  if (await tab(p, 'Box Cam')) await shot(p, 'boxcam', 390);
  if (await tab(p, 'Combine')) await shot(p, 'combine', 390);
  await p.click('a[href^="/you"]'); await sleep(1000); if (await tab(p, 'Profile')) { if (await tab(p, 'Evidence')) await shot(p, 'evidence', 390); }
  await p.click('a[href^="/opportunities"]'); await sleep(1000);
  const offerCat = p.locator('[data-testid="cat-offer"]'); if (await offerCat.count()) { await offerCat.first().click(); await sleep(700); const ot = p.getByRole('tab', { name: 'Offer', exact: true }); if (await ot.count()) { await ot.last().click(); await sleep(600); } await shot(p, 'offer', 390); }
  const wait = 9500 - (Date.now() - t0); if (wait > 0) await sleep(wait);
  await p.click('a[href="/inbox"]'); await sleep(1200); await shot(p, 'inbox', 390);
  const req = p.locator('[data-testid^="inbox-request-"]').first(); if (await req.count()) { await req.click(); await sleep(900); await shot(p, 'trial', 390); }
  await ctx.close();
}
if (which === 'portals' || which === 'all') {
  async function portal(app, W, H) {
    const ctx = await b.newContext({ viewport: { width: W, height: H } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${app}: ${e.message}`));
    await p.goto(`http://localhost:${PORT}/?app=${app}`); await Promise.race([p.waitForSelector('.auth-card', { timeout: 30000 }), p.waitForSelector('nav.sidebar', { timeout: 30000 })]);
    if (!(await p.locator('nav.sidebar').count())) {
      if (app === 'admin') { await p.fill('input[type="password"]', 'scoutbox-admin'); await p.click('button.primary'); }
      else if (app === 'agent') { await p.click('.org-card:has-text("North Star")'); await p.fill('.enter-row input[aria-label]', 'Ana Costa'); await p.click('button:has-text("Enter workspace")'); }
      else { await p.waitForSelector('.org-card'); await p.click('.org-card >> nth=0'); await p.fill('.enter-row input', app === 'club' ? 'Maria Keane' : 'Sam Tully'); await p.click('button.primary'); }
    }
    await p.waitForSelector('nav.sidebar', { timeout: 30000 }); await sleep(900); return { ctx, p };
  }
  const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await sleep(1200); };
  { const g = await portal('grassroots', 1440, 900); await go(g.p, '#/feed'); await shot(g.p, 'grassroots-home', 1440, false); await shot(g.p, 'grassroots-home-full', 1440); await go(g.p, '#/opendays'); await shot(g.p, 'grassroots-radar', 1280, false); await go(g.p, '#/squad'); await shot(g.p, 'grassroots-squad', 1280, false); await g.ctx.close(); }
  { const c = await portal('club', 1280, 800); await go(c.p, '#/recruitment/nobody-missed'); await shot(c.p, 'nobody-missed', 1280); await c.ctx.close(); }
  for (const [W, H] of [[1440, 900], [1024, 768]]) { const c = await portal('club', W, H); await go(c.p, '#/recruitment/dashboard'); await sleep(600); await shot(c.p, 'director-dashboard', W); await shot(c.p, 'director-dashboard-fold', W, false); await c.ctx.close(); }
  { const a = await portal('agent', 1280, 800); await go(a.p, '#/home'); await shot(a.p, 'agent-home', 1280); await go(a.p, '#/clients'); await shot(a.p, 'agent-clients', 1280); await go(a.p, '#/transactions'); await shot(a.p, 'agent-transactions', 1280); await go(a.p, '#/compliance'); await shot(a.p, 'agent-compliance', 1280); await a.ctx.close(); }
  { const t = await portal('admin', 1280, 800); await shot(t.p, 'admin-home', 1280); const q = t.p.locator('nav.sidebar button:has-text("Verification")').first(); if (await q.count()) { await q.click(); await sleep(900); await shot(t.p, 'admin-verification', 1280); } const s = t.p.locator('nav.sidebar button:has-text("Safeguarding")').first(); if (await s.count()) { await s.click(); await sleep(900); await shot(t.p, 'admin-safeguarding', 1280); } await t.ctx.close(); }
}
fs.writeFileSync(path.join(out, `${prefix}-metrics.json`), JSON.stringify({ metrics, errors }, null, 1));
console.log(JSON.stringify({ errors })); await b.close(); process.exit(0);
