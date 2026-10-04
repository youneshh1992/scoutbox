// M24F.5 — final visual acceptance of the portals, in a real browser, on the demo
// bundles, at 1024 / 1280 / 1440: Grassroots Home, local radar (Open Days) and
// squad; Pro Nobody Missed and the Director Dashboard; the Agent home and a dense
// Agent screen; the Trust & Safety review queue; plus the Film Room and the
// Verification screens that the kept-screen review changed.
// Every screen: no horizontal overflow, Inter as the computed face (the wordmark
// and the Grassroots editorial face are the only others), zero emoji, no seconds.
// Per screen: Grassroots has the navy sidebar on a light canvas and no grass
// photograph inside the workspace; the radar read line has no border; squad names
// are unbordered; an open day reads as one quiet meta line; Nobody Missed shows
// one heading and its honesty line; the Dashboard root is at most four counts,
// funnel, time by stage, coverage, at most five attention lines, no paragraph,
// with filters, principle and detail one tap away; the Agent nav is gold; the
// Trust & Safety queue reads in words, never in SCREAMING_CODES; the Film Room
// caption sits under the clip. Zero page errors.
// Own port (8894). Run from e2e/ after buildDemos: node m24f5PortalVisualLive.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIST = process.env.DEMO_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'); const PORT = 8894;
const FILES = { club: 'scoutbox-club-demo.html', grassroots: 'scoutbox-grassroots-demo.html', agent: 'scoutbox-agent-demo.html', admin: 'scoutbox-admin-demo.html' };
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync(`fuser -k ${PORT}/tcp`, { stdio: 'ignore' }); } catch { /* free */ }
const server = http.createServer((q, r) => { const app = new URL(q.url, 'http://x').searchParams.get('app') || 'club'; r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(DIST, FILES[app])).pipe(r); }).listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const MEASURE = `(() => {
  const root = document.querySelector('.content') ?? document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const d = el.closest('details:not([open])'); return !d || el.closest('summary') !== null; };
  const leaves = [...root.querySelectorAll('p, li, span, div, td, th, small, b, strong, em, label, h1, h2, h3, h4, button, a')].filter((el) => vis(el) && el.children.length === 0 && el.textContent.trim());
  const paragraphs = leaves.map((el) => el.textContent.trim()).filter((t) => t.length > 140);
  let words = 0; { const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const s = n.textContent.replace(/\\s+/g, ' ').trim(); if (s && n.parentElement && vis(n.parentElement) && !['SCRIPT','STYLE','OPTION'].includes(n.parentElement.tagName)) words += s.split(' ').length; } }
  const fonts = {}; for (const el of leaves.slice(0, 500)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; }
  const text = root.innerText;
  const emoji = (text.match(/\\p{Extended_Pictographic}/gu) || []).filter((c) => !'✓✕○➤⊘◷↻✗›⌄▲▼⚠©®™'.includes(c)).length;
  const seconds = (text.match(/\\b\\d{1,2}:\\d{2}:\\d{2}\\b/g) || []).length;
  const overflow = document.documentElement.scrollWidth > innerWidth + 1;
  return { words, paragraphs: paragraphs.map((t) => t.slice(0, 80)), fonts, emoji, seconds, overflow };
})()`;
const interOnly = (m) => Object.keys(m.fonts).every((f) => /^Inter|Albert Sans|Fraunces|Instrument Serif|serif/i.test(f)) && /^Inter/.test(Object.entries(m.fonts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const allSides = (loc) => loc.evaluate((el) => { const cs = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].every((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none'); });
const base = async (tag, screen, p, budget, allowPara = 0) => {
  const m = await p.evaluate(MEASURE);
  ok(m.words <= budget, `${tag} ${screen}: ${m.words} words (budget ${budget})`);
  ok(m.paragraphs.length <= allowPara, `${tag} ${screen}: ${m.paragraphs.length} paragraph(s) over 140 characters (allowed ${allowPara})${m.paragraphs[0] ? ` ("${m.paragraphs[0]}…")` : ''}`);
  ok(!m.overflow, `${tag} ${screen}: no horizontal overflow`);
  ok(interOnly(m), `${tag} ${screen}: Inter computed (${Object.keys(m.fonts).join(', ')})`);
  ok(m.emoji === 0, `${tag} ${screen}: zero emoji`);
  ok(m.seconds === 0, `${tag} ${screen}: no seconds`);
  return m;
};
async function open(app, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${app} ${w}: ${e.message}`));
  await p.goto(`http://localhost:${PORT}/?app=${app}`); await Promise.race([p.waitForSelector('.auth-card', { timeout: 30000 }), p.waitForSelector('nav.sidebar', { timeout: 30000 })]);
  if (!(await p.locator('nav.sidebar').count())) {
    if (app === 'admin') { await p.fill('input[type="password"]', 'scoutbox-admin'); await p.click('button.primary'); }
    else if (app === 'agent') { await p.click('.org-card:has-text("North Star")'); await p.fill('.enter-row input[aria-label]', 'Ana Costa'); await p.click('button:has-text("Enter workspace")'); }
    else { await p.waitForSelector('.org-card'); await p.click('.org-card >> nth=0'); await p.fill('.enter-row input', app === 'club' ? 'Maria Keane' : 'Sam Tully'); await p.click('button.primary'); }
  }
  await p.waitForSelector('nav.sidebar', { timeout: 30000 }); await sleep(800);
  return { ctx, p };
}
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await sleep(1100); };
const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900]]) {
  const tag = `${w}px`;
  // ---------------------------------------------------------------- Grassroots
  {
    const { ctx, p } = await open('grassroots', w, h);
    await go(p, '#/feed');
    await base(`${tag} Grassroots`, 'Home', p, 260);
    const side = rgb(await p.locator('nav.sidebar').evaluate((el) => getComputedStyle(el).backgroundColor));
    const canvas = rgb(await p.locator('.content').evaluate((el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return getComputedStyle(document.body).backgroundColor; }));
    ok(lum(side) < 0.3 && side[2] > side[0], `${tag} Grassroots: navy sidebar (rgb ${side.join(',')})`);
    ok(lum(canvas) > 0.85, `${tag} Grassroots: light canvas (rgb ${canvas.join(',')})`);
    const grass = await p.evaluate(() => [...document.querySelectorAll('.content, .content *, main, body')].filter((el) => /url\(/.test(getComputedStyle(el).backgroundImage)).length);
    ok(grass === 0, `${tag} Grassroots: no grass photograph inside the workspace`);
    await go(p, '#/opendays');
    await base(`${tag} Grassroots`, 'Open Days', p, 220, 0);
    const read = p.locator('[data-testid="radar-read"]');
    ok((await read.count()) === 1 && !(await allSides(read)) && (await p.locator('[data-testid="radar"] input').count()) === 0, `${tag} radar: read line, no border, no input`);
    const editColor = await p.locator('[data-testid="radar-edit-link"]').evaluate((el) => getComputedStyle(el).color);
    const inkColor = await read.evaluate((el) => getComputedStyle(el).color);
    ok(editColor !== inkColor, `${tag} radar: Edit reads as a link (${editColor})`);
    const meta = p.locator('[data-testid^="openday-meta-"]');
    ok((await meta.count()) >= 1 && (await p.locator('.content .section h4 ~ .pill').count()) === 0, `${tag} Open Days: one quiet meta line per open day, no pill row`);
    ok(!/\b(u16|u18|open)\b ·/.test(await txt(meta.first())), `${tag} Open Days: age group in words, not a raw code`);
    ok(!/\d{4}-\d{2}-\d{2}/.test(await txt(p.locator('.content'))), `${tag} Open Days: no ISO dates`);
    await go(p, '#/squad');
    await base(`${tag} Grassroots`, 'Squad', p, 200, 1);
    const names = p.locator('.squad-row .squad-name');
    ok((await names.count()) >= 1 && !(await allSides(names.first())), `${tag} squad: names unbordered`);
    await ctx.close();
  }
  // ---------------------------------------------------------------- Pro
  {
    const { ctx, p } = await open('club', w, h);
    await go(p, '#/recruitment/nobody-missed');
    await base(`${tag} Pro`, 'Nobody Missed', p, 190, 1); // the one honesty sentence (Nobody Missed ≠ ranking) is the allowed paragraph
    const body = await txt(p.locator('.content'));
    ok(!/Not yet evaluated \(\d+\)/.test(body) && /Needs review · \d+/i.test(body), `${tag} Nobody Missed: one heading per group`);
    ok(/not a measure of scouting quality/.test(body) && (await p.locator('.nm-ring').count()) === 1, `${tag} Nobody Missed: coverage ring and its honesty line (not a ranking)`);
    await go(p, '#/recruitment/dashboard');
    const dm = await base(`${tag} Pro`, 'Director Dashboard', p, 160, 0);
    ok((await p.locator('[data-kpis] [data-kpi]').count()) <= 4, `${tag} Dashboard: at most four counts`);
    ok((await p.locator('[data-visual="funnel"] .dash-bar').count()) >= 1 && (await p.locator('[data-visual="time"]').count()) === 1 && (await p.locator('[data-visual="coverage"]').count()) === 1, `${tag} Dashboard: funnel, time by stage, coverage`);
    ok((await p.locator('[data-attention] li').count()) <= 5, `${tag} Dashboard: needs attention ≤ 5`);
    ok((await p.locator('[data-testid="dash-filters"]').count()) === 0 && (await p.locator('.dash-detail').count()) === 0 && (await p.locator('[data-principle]').count()) === 0, `${tag} Dashboard: filters, principle and detail are one tap away, not on the root`);
    ok((await p.locator('.content code, .content pre').count()) === 0, `${tag} Dashboard: no internal record names in code type`);
    ok(dm.words <= 160, `${tag} Dashboard: executive root (${dm.words} words)`);
    await p.locator('[data-testid="dash-detail-toggle"]').click(); await sleep(400);
    ok((await p.locator('[data-family]').count()) === 7, `${tag} Dashboard: "Show all figures" opens the seven families`);
    await go(p, '#/filmroom');
    const cap = p.locator('[data-testid="filmroom-caption"]');
    if (await cap.count()) {
      const [stage, c] = await Promise.all([p.locator('.filmroom-stage').boundingBox(), cap.boundingBox()]);
      ok(c.y >= stage.y + stage.height - 1, `${tag} Film Room: the caption sits under the clip`);
      const tags = await p.locator('.filmroom-tags').boundingBox();
      ok(!tags || tags.y >= stage.y + stage.height - 1, `${tag} Film Room: tags under the clip`);
    } else ok(false, `${tag} Film Room: caption present`);
    await go(p, '#/verification');
    await base(`${tag} Pro`, 'Verification', p, 200, 0);
    ok((await p.locator('[data-testid="verify-start-more"]').count()) === 1 && (await p.locator('input[aria-label^="Professional role"]').isVisible()) === false, `${tag} Verification: a verified administrator sees the start forms folded`);
    await ctx.close();
  }
  // ---------------------------------------------------------------- Agent
  {
    const { ctx, p } = await open('agent', w, h);
    await go(p, '#/home');
    await base(`${tag} Agent`, 'Home', p, 160, 0);
    const active = p.locator('nav.sidebar .active, nav.sidebar [aria-current="page"]').first();
    const c = rgb(await active.evaluate((el) => getComputedStyle(el).color));
    ok(c[0] > c[2] + 40 && c[1] > c[2], `${tag} Agent: gold navigation (rgb ${c.join(',')})`);
    ok(!/facet/i.test(await txt(p.locator('.content'))), `${tag} Agent Home: no "facet" jargon`);
    await go(p, '#/transactions');
    await base(`${tag} Agent`, 'Transactions', p, 260, 0);
    const stats = p.locator('.content .stats .stat');
    if (await stats.count() >= 2) { const [a, b] = [await stats.nth(0).boundingBox(), await stats.nth(1).boundingBox()]; ok(Math.abs(a.y - b.y) < 4, `${tag} Agent Transactions: counts in one row`); }
    await ctx.close();
  }
  // ---------------------------------------------------------------- Trust & Safety
  {
    const { ctx, p } = await open('admin', w, h);
    await p.locator('nav.sidebar button:has-text("Verification")').first().click(); await sleep(900);
    await base(`${tag} T&S`, 'Verification', p, 260, 0);
    const t = await txt(p.locator('.content'));
    ok(!/\b[A-Z]{3,}(_[A-Z]+)+\b/.test(t) && !/\w+=\w+/.test(t), `${tag} T&S Verification: reasons and checks in words, no machine codes`);
    ok(!/\bDns\b/.test(t), `${tag} T&S Verification: acronyms keep their capitals`);
    await p.locator('nav.sidebar button:has-text("Agents")').first().click(); await sleep(700);
    const sub = p.locator('nav.subnav button').filter({ hasText: 'Agent transactions' }); if (await sub.count()) { await sub.first().click(); await sleep(900); }
    await base(`${tag} T&S`, 'Agent transactions', p, 460, 0);
    ok(!/pending_review|\bPENDING\b|\b[A-Z]{3,}_[A-Z_]+\b/.test(await txt(p.locator('.content'))), `${tag} T&S Agent transactions: statuses in words`);
    await ctx.close();
  }
}

ok(errors.length === 0, `0 page errors (${errors.length ? errors.slice(0, 3).join(' | ') : 'clean'})`);
console.log(`\nm24f5PortalVisualLive: ${passed} passed, ${failures.length} failed`);
server.close(); await browser.close();
process.exit(failures.length ? 1 : 0);
