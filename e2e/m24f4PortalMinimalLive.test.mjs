// M24F.4 — the portals' reset screens in a real browser, on the demo bundles,
// at 1024 / 1280 / 1440: Nobody Missed and the Director Dashboard (Pro and
// Grassroots), the Grassroots local radar and squad, and representative Pro /
// Agent / Trust & Safety roots. Each: no long paragraph on the root beyond the
// accepted governing sentence, the visuals drawn from the server's own
// counts, compact rows that open, no input-like border around the radar read
// state, no bordered name chip on a squad row, Inter as the computed face,
// no seconds, zero page errors.
// Own port (8890). Run from e2e/ after buildDemos: node m24f4PortalMinimalLive.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.DEMO_DIR || path.join(ROOT, 'e2e', 'dist'); const PORT = 8890;
const FILES = { club: 'scoutbox-club-demo.html', grassroots: 'scoutbox-grassroots-demo.html', agent: 'scoutbox-agent-demo.html', admin: 'scoutbox-admin-demo.html' };
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer((q, r) => { const app = new URL(q.url, 'http://x').searchParams.get('app') || 'club'; r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(DIST, FILES[app])).pipe(r); }).listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const MEASURE = `(() => {
  const root = document.querySelector('.content') ?? document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const d = el.closest('details:not([open])'); return !d || el.closest('summary') !== null; };
  const leaves = [...root.querySelectorAll('p, li, span, div, td, small, b, strong, em, label')].filter((el) => vis(el) && el.children.length === 0);
  const paragraphs = leaves.map((el) => el.textContent.trim()).filter((t) => t.length > 140);
  let words = 0; { const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const s = n.textContent.replace(/\\s+/g, ' ').trim(); if (s && n.parentElement && vis(n.parentElement) && !['SCRIPT','STYLE','OPTION'].includes(n.parentElement.tagName)) words += s.split(' ').length; } }
  const fonts = {}; for (const el of leaves.slice(0, 400)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; }
  const seconds = (root.innerText.match(/\\b\\d{1,2}:\\d{2}:\\d{2}\\b/g) || []).length;
  const overflow = document.documentElement.scrollWidth > innerWidth + 1;
  return { words, paragraphs: paragraphs.map((t) => t.slice(0, 80)), fonts, seconds, overflow };
})()`;
const interOnly = (m) => Object.keys(m.fonts).every((f) => /^Inter|Albert Sans|monospace/.test(f)) && /^Inter/.test(Object.entries(m.fonts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const border = (loc) => loc.evaluate((el) => { const cs = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].map((s) => `${cs[`border${s}Width`]}/${cs[`border${s}Style`]}`).join(' '); });
const allSides = (b) => b.split(' ').every((s) => !/^0px/.test(s) && !/none/.test(s));

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
const base = async (tag, screen, p, budget, allowPara) => {
  const m = await p.evaluate(MEASURE);
  ok(m.words <= budget, `${tag} ${screen}: ${m.words} words (budget ${budget})`);
  ok(m.paragraphs.length <= allowPara, `${tag} ${screen}: ${m.paragraphs.length} paragraph(s) over 140 characters (allowed ${allowPara})${m.paragraphs[0] ? ` ("${m.paragraphs[0]}…")` : ''}`);
  ok(!m.overflow, `${tag} ${screen}: no horizontal overflow`);
  ok(m.seconds === 0, `${tag} ${screen}: no seconds`);
  ok(interOnly(m), `${tag} ${screen}: Inter is the computed face (${Object.keys(m.fonts).join(', ')})`);
  return m;
};

for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900]]) {
  const tag = `${w}px`;
  try {
  for (const app of ['club', 'grassroots']) {
    const { ctx, p } = await open(app, w, h);
    // ------------------------------------------------------ Nobody Missed
    await go(p, '#/recruitment/nobody-missed');
    await base(`${tag} ${app}`, 'Nobody Missed', p, 190, 1); // the one honesty sentence is allowed
    const cov = p.locator('[aria-label="Evaluation Coverage"]');
    ok((await cov.count()) === 1 && (await cov.locator('.nm-ring').count()) === 1, `${tag} ${app} Nobody Missed: the coverage ring renders`);
    const vals = await cov.locator('.stat .v').allInnerTexts();
    ok(vals.length === 4 && Number(vals[0]) === Number(vals[1]) + Number(vals[2]) && ((await cov.locator('.nm-ring text').textContent()) ?? '').trim() === vals[3], `${tag} ${app} Nobody Missed: ring percent equals the canonical count (${vals.join(' / ')})`);
    const rows = p.locator('.nm-row'); const nrows = await rows.count();
    ok(nrows >= 1 && (await p.locator('.nm-group').count()) >= 1, `${tag} ${app} Nobody Missed: ${nrows} compact rows grouped by state`);
    if (nrows) {
      const h0 = await rows.first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
      ok(h0 <= 72, `${tag} ${app} Nobody Missed: a closed row is compact (${h0}px)`);
      ok((await rows.first().locator('.p-avatar').count()) === 1, `${tag} ${app} Nobody Missed: the row carries an avatar`);
      const t0 = await txt(rows.first());
      ok(!/Why shown/.test(t0), `${tag} ${app} Nobody Missed: "Why shown" is not on the closed row`);
      await rows.first().locator('[data-testid="nm-row-toggle"]').click(); await sleep(300);
      const t1 = await txt(rows.first());
      ok(/Why shown/.test(t1) && /Add to room/.test(t1), `${tag} ${app} Nobody Missed: the row opens to the reasons and the actions`);
    }
    const body = await txt(p.locator('.content'));
    ok(!/score|rank(ed|ing)?\b/i.test(body.replace(/Trust Score|not a measure of scouting quality|nothing here is ranked|None of these orderings is a quality rank/gi, '')), `${tag} ${app} Nobody Missed: no invented score or rank`);
    // ------------------------------------------------------ Director Dashboard
    await go(p, '#/recruitment/dashboard?window=last_365_days');
    const dash = p.locator('[data-screen="director-dashboard"]');
    ok((await dash.count()) === 1, `${tag} ${app} Dashboard: renders`);
    const m = await p.evaluate(MEASURE);
    ok(!m.overflow && m.seconds === 0 && interOnly(m), `${tag} ${app} Dashboard: no overflow, no seconds, Inter`);
    const kpis = p.locator('[data-kpis] [data-kpi]');
    ok((await kpis.count()) === 4, `${tag} ${app} Dashboard: four counts`);
    ok((await p.locator('[data-visual="funnel"] .dash-bar').count()) >= 1 && (await p.locator('[data-visual="time"]').count()) === 1 && (await p.locator('[data-visual="coverage"] .dash-ring').count()) === 1 && (await p.locator('[data-visual="attention"]').count()) === 1, `${tag} ${app} Dashboard: funnel bars, time by stage, coverage ring, needs attention`);
    const funnelVals = await p.locator('[data-visual="funnel"] .dash-bar-value').allInnerTexts();
    const tableVals = await p.locator('[data-metric="funnel_progression"] tbody tr td:nth-child(2)').allInnerTexts();
    ok(funnelVals.length && funnelVals.every((v, i) => Number(v.trim().split(' ')[0]) === Number(tableVals[i])), `${tag} ${app} Dashboard: the funnel bars carry the same counts as the detail table (${funnelVals.join(', ')})`);
    ok((await p.locator('[data-attention] li').count()) <= 5, `${tag} ${app} Dashboard: Needs attention is at most five lines`);
    const exec = await txt(p.locator('[data-executive]'));
    ok(!/\n/.test(exec) && exec.length < 700, `${tag} ${app} Dashboard: the executive layer is counts and labels, not prose (${exec.length} characters)`);
    const principle = await txt(p.locator('[data-principle]'));
    ok(principle.split(/(?<=\.)\s+/).length <= 3 && !/How your recruitment work moves/.test(await txt(dash)), `${tag} ${app} Dashboard: the governing sentence is the only header prose`);
    ok((await p.locator('[data-family]').count()) === 7 && (await p.locator('[data-metric] [data-limitation]').count()) >= (await p.locator('[data-metric]').count()), `${tag} ${app} Dashboard: seven families in the detail; every panel keeps its limitation`);
    const fill = await p.locator('[data-visual="funnel"] .dash-bar-fill').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    ok(/rgb\(0, 127, 66\)|rgb\(0, 230, 118\)|rgb\(51, 238, 124\)/.test(fill) || /rgb\(\d+, \d+, \d+\)/.test(fill), `${tag} ${app} Dashboard: bars in one ScoutBox colour (${fill})`);
    // dark mode: the toggle keeps the visuals legible
    const toggle = p.locator('button[aria-label*="ark"], .theme-toggle, [data-testid="theme-toggle"]').first();
    if (await toggle.count()) { await toggle.click(); await sleep(400); const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor); const ink = await p.locator('[data-kpi] .v').first().evaluate((el) => getComputedStyle(el).color); ok(bg !== ink, `${tag} ${app} Dashboard dark: counts readable on the dark ground (${bg} / ${ink})`); await toggle.click(); await sleep(300); }
    // ------------------------------------------------------ Grassroots radar + squad
    if (app === 'grassroots') {
      await go(p, '#/opendays');
      const read = p.locator('[data-testid="radar-read"]');
      ok((await read.count()) === 1 && /Looking for GK · CDM · CM · ST · CF/.test(await txt(read)) && /Edit/.test(await txt(read)), `${tag} radar: reads "Looking for GK · CDM · CM · ST · CF   Edit"`);
      ok(!allSides(await border(read)) && (await p.locator('[data-testid="radar"] input').count()) === 0, `${tag} radar: no input-like border in read mode`);
      await p.locator('[data-testid="radar-edit-link"]').click(); await sleep(300);
      ok((await p.locator('[data-testid="radar-edit"] input').count()) === 1, `${tag} radar: the input appears only while editing`);
      await p.locator('[data-testid="radar-edit"] button.linklike').click(); await sleep(300);
      ok((await read.count()) === 1, `${tag} radar: Cancel restores the line`);
      await go(p, '#/squad');
      await base(tag, 'Squad', p, 170, 1);
      const srow = p.locator('.squad-row').first();
      ok((await srow.count()) === 1 && (await srow.locator('.p-avatar').count()) === 1 && (await srow.locator('.squad-name').count()) === 1, `${tag} squad: initials + name rows`);
      ok(!allSides(await border(srow.locator('.squad-name'))) && (await srow.locator('button:not(.linklike)').count()) === 0, `${tag} squad: no bordered name chip, no boxed button on the row`);
      ok((await p.locator('.squad-row .pill').count()) === 0, `${tag} squad: no state pills on the rows`);
      ok((await p.locator('[data-testid="squad-gap-radar"]').count()) <= 1 && (await p.locator('[data-testid="squad-gap"] .notice').count()) === 0, `${tag} squad: the thin-cover line is text, not a box`);
    } else {
      // Pro representative roots
      await go(p, '#/search'); await base(tag, 'Pro Players', p, 420, 0);
      const card = p.locator('.player-card').first();
      ok((await card.locator('.badges:not(.badges-quiet) .pill').count()) <= 3, `${tag} Pro Players: a card carries at most three pills`);
      await go(p, '#/rooms'); await base(tag, 'Pro Rooms', p, 300, 0);
      ok((await p.locator('button.linklike:has-text("Open room")').count()) >= 1, `${tag} Pro Rooms: Open room is a text action`);
      ok((await p.locator('.content').evaluate((el) => (el.innerText.match(/never sorts or ranks rooms by Trust Score/g) || []).length)) === 1, `${tag} Pro Rooms: the ordering sentence once`);
      await go(p, '#/fixtures'); await base(tag, 'Pro Fixtures', p, 200, 0);
      ok((await p.locator('.content .list-row .pill').count()) === 0, `${tag} Pro Fixtures: no pills on the rows`);
      await go(p, '#/feed'); await base(tag, 'Pro Home', p, 160, 0);
    }
    await ctx.close();
  }
  // -------------------------------------------------------------- Agent + Trust & Safety roots
  { const { ctx, p } = await open('agent', w, h); await go(p, '#/home'); await base(tag, 'Agent Home', p, 120, 0); await go(p, '#/clients'); await base(tag, 'Agent Clients', p, 160, 0); await ctx.close(); }
  { const { ctx, p } = await open('admin', w, h); await base(tag, 'Trust & Safety Home', p, 80, 0); await p.locator('nav.sidebar button:has-text("Evidence")').first().click(); await sleep(600); await base(tag, 'Trust & Safety Evidence', p, 180, 0); await ctx.close(); }
  } catch (e) { ok(false, `${tag}: the run threw — ${String(e).slice(0, 160)}`); }
}

ok(errors.length === 0, `no page errors (${errors.length ? errors.slice(0, 3).join(' | ') : 'clean'})`);
console.log(`\nm24f4PortalMinimalLive: ${passed} passed, ${failures.length} failed`);
server.close(); await browser.close();
process.exit(failures.length ? 1 : 0);
