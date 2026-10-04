// M24F.5 — final visual acceptance of the Player, in a real browser, on the shipped
// demo bundle (e2e/dist/scoutbox-player-demo.html) at 320 / 360 / 390 / 430 and
// 640×360: Home, Activity, Development, Box Cam, Combine, Evidence, Passport,
// Trust Score, Messages, Trial and Offer.
// For each screen: a word budget, no paragraph over 140 characters on a root,
// no horizontal overflow, Inter as the computed face, zero emoji, no seconds.
// Per screen: Home has no greeting, day or date line, no "View your Passport" and
// no "Verified clubs can see you", and a "Joined" line from the record; Activity
// is a timeline (dot + date + event) grouped Today / This week / Earlier; the
// Development, Combine and Evidence roots are rows (Combine names only; Evidence
// LATEST + CATEGORIES with counts); the Trust Score is a minimal block; Messages is
// conversation-first; the Trial message carries an accent and a "Trial" label
// with no filled yellow card; the Offer is a document with "View terms" and
// "Offer acceptance is not a signature." under one rule. Zero page errors.
// Own port (8893). Run from e2e/ after buildDemos.mjs: node m24f5PlayerVisualLive.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, 'dist', 'scoutbox-player-demo.html');
const PORT = 8893;
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(BUNDLE)) { console.error('missing demo bundle — run node buildDemos.mjs'); process.exit(1); }
try { execSync(`fuser -k ${PORT}/tcp`, { stdio: 'ignore' }); } catch { /* free */ }
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(BUNDLE).pipe(r); }).listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const MEASURE = `(() => {
  const root = document.querySelector('[data-testid="mobile-viewport"]') ?? document.body;
  const hidden = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (e.getAttribute('aria-hidden') === 'true' || cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !hidden(el); };
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let words = 0; let n;
  while ((n = tw.nextNode())) { const s = n.textContent.replace(/\\s+/g, ' ').trim(); if (s && n.parentElement && vis(n.parentElement) && !['SCRIPT','STYLE','OPTION'].includes(n.parentElement.tagName)) words += s.split(' ').length; }
  const leaves = [...root.querySelectorAll('div, span, p, a, button')].filter((el) => vis(el) && el.textContent.trim() && [...el.children].every((c) => c.tagName === 'SPAN' || c.tagName === 'BR'));
  const paragraphs = leaves.map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => t.length > 140);
  const fonts = {}; for (const el of leaves.slice(0, 400)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; }
  const text = root.innerText;
  const emoji = (text.match(/\\p{Extended_Pictographic}/gu) || []).filter((c) => !'✓✕○➤⊘◷↻✗›⌄▲▼©®™'.includes(c)).length;
  const seconds = (text.match(/\\b\\d{1,2}:\\d{2}:\\d{2}\\b/g) || []).length;
  const overflow = document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1;
  return { words, paragraphs: paragraphs.length, sample: paragraphs[0]?.slice(0, 90) ?? '', fonts, emoji, seconds, overflow };
})()`;
const measure = (p) => p.evaluate(MEASURE);
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const tab = async (p, name) => { const t = p.getByRole('tab', { name, exact: true }); const n = await t.count(); if (!n) return false; await t.nth(n - 1).click(); await sleep(600); return true; };
// Inter everywhere; the wordmark (Albert Sans) is the one allowed exception.
const interOnly = (m) => Object.keys(m.fonts).every((f) => /^Inter|^AlbertSans|^Albert Sans/.test(f)) && /^Inter/.test(Object.entries(m.fonts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
const check = (tag, screen, m, budget, allowPara = 0) => {
  ok(m.words <= budget, `${tag} ${screen}: ${m.words} words (budget ${budget})`);
  ok(m.paragraphs <= allowPara, `${tag} ${screen}: ${m.paragraphs} paragraph(s) over 140 characters${m.sample ? ` ("${m.sample}…")` : ''}`);
  ok(!m.overflow, `${tag} ${screen}: no horizontal overflow`);
  ok(interOnly(m), `${tag} ${screen}: Inter computed (${Object.keys(m.fonts).join(', ')})`);
  ok(m.emoji === 0, `${tag} ${screen}: zero emoji`);
  ok(m.seconds === 0, `${tag} ${screen}: no seconds`);
};
const enter = async (p) => {
  await p.goto(`http://localhost:${PORT}/`); await p.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await p.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await p.waitForSelector('[data-testid="home-identity"]', { timeout: 30000 }); await sleep(900);
};

for (const [w, h] of [[320, 690], [360, 780], [390, 844], [430, 932], [640, 360]]) {
  const tag = `${w}×${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await enter(p); const t0 = Date.now();

  // Home
  check(tag, 'Home', await measure(p), 130);
  const header = await txt(p.locator('[data-testid="home-identity"]'));
  ok(!/Good (morning|afternoon|evening)|Welcome|Bonjour|Bonsoir/.test(header), `${tag} Home: no greeting`);
  ok(!/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(header) && !/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{4}\b/.test(header), `${tag} Home: no day or date line`);
  ok(!/View (your )?Passport|Verified clubs can see you/.test(header), `${tag} Home: no "View Passport", no verified sentence`);
  ok(/^Joined [A-Z][a-z]+ \d{4}$/.test((await p.locator('[data-testid="home-joined"]').innerText()).trim()), `${tag} Home: "Joined <Month Year>" from the record`);
  const recent = p.locator('[data-testid="home-recent-row"]');
  ok((await recent.count()) >= 1 && (await recent.count()) <= 3, `${tag} Home: Recent is a short timeline (${await recent.count()} items)`);

  // Activity
  await p.locator('[data-testid="home-activity-all"]').click(); await p.waitForSelector('[data-testid="activity-page"]', { timeout: 15000 }); await sleep(600);
  check(tag, 'Activity', await measure(p), 140);
  const groups = await p.locator('[data-testid^="activity-group-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('activity-group-', '')));
  ok(groups.length >= 1 && groups.every((g) => ['today', 'week', 'earlier'].includes(g)), `${tag} Activity: grouped Today / This week / Earlier (${groups.join(', ')})`);
  ok((await p.locator('[data-testid="activity-row"]').count()) >= 1 && (await p.locator('table').count()) === 0, `${tag} Activity: timeline rows, no table`);
  const back = p.locator('[aria-label="Back"]').first(); if (await back.count()) await back.click(); else await p.goBack(); await sleep(500);

  // Football: Passport + Trust, Development, Box Cam, Combine
  await p.click('a[href^="/football"]'); await sleep(1100);
  if (await tab(p, 'Passport')) {
    check(tag, 'Passport', await measure(p), 160);
    const trust = p.locator('[data-testid="trust-card"]').first();
    const tt = await txt(trust);
    ok(/\d+\s*\/100/.test(tt) && /Evidence confidence only/.test(tt) && /View breakdown/.test(tt) && tt.split(' ').length <= 24, `${tag} Trust Score: minimal block — score, band, "Evidence confidence only", View breakdown (${tt.split(' ').length} words)`);
    ok(!/talent|ability rating|best player/i.test(tt), `${tag} Trust Score: not a talent score`);
  }
  if (await tab(p, 'Development')) {
    check(tag, 'Development', await measure(p), 110);
    ok((await p.locator('[data-testid="dev-about"]').count()) === 1, `${tag} Development: one About row`);
  }
  if (await tab(p, 'Box Cam')) {
    check(tag, 'Box Cam', await measure(p), 130);
    ok((await p.locator('[data-testid="boxcam-start"]').count()) === 1, `${tag} Box Cam: one Start session action`);
    ok(!/assessment|scout grade/i.test(await txt(p.locator('[data-testid="mobile-viewport"]'))), `${tag} Box Cam: never called an assessment`);
  }
  if (await tab(p, 'Combine')) {
    check(tag, 'Combine', await measure(p), 90);
    const names = await p.locator('[data-testid^="combine-protocol-"]').allInnerTexts();
    ok(names.length >= 3 && names.every((t) => t.trim().split('\n').length === 1 && !/\d+ ?(s|cm|m|reps)\b|Verified|Start/.test(t)), `${tag} Combine: names only (${names.length} rows)`);
  }

  // Evidence
  await p.click('a[href^="/you"]'); await sleep(1000);
  if (await tab(p, 'Profile') && await tab(p, 'Evidence')) {
    check(tag, 'Evidence', await measure(p), 110);
    const ev = await txt(p.locator('[data-testid="evidence-root"]'));
    ok(/LATEST/i.test(ev) && /CATEGORIES/i.test(ev), `${tag} Evidence: LATEST and CATEGORIES labels`);
    ok((await p.locator('[data-testid="evidence-latest-thumb"]').count()) === 1, `${tag} Evidence: the latest clip as a picture`);
    for (const id of ['evidence-video-row', 'evidence-combine-row', 'evidence-references-row', 'evidence-attendance-row']) ok(/\d/.test(await txt(p.locator(`[data-testid="${id}"]`))), `${tag} Evidence: ${id.replace(/evidence-|-row/g, '')} with its count`);
    ok(!/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/.test(ev), `${tag} Evidence: day-month dates, no US format`);
  }

  // Offer
  await p.click('a[href^="/opportunities"]'); await sleep(1000);
  const cat = p.locator('[data-testid="cat-offer"]');
  if (await cat.count()) {
    await cat.first().click(); await sleep(700); await tab(p, 'Offer');
    check(tag, 'Offer', await measure(p), 110);
    const sec = p.locator('[data-testid="offer-section"]'); const o = await txt(sec);
    ok(/Eastport FC/.test(o) && /Accept/.test(o) && /Decline/.test(o) && /View terms/.test(o), `${tag} Offer: club, Accept / Decline, View terms`);
    ok(/Offer acceptance is not a signature\./.test(o), `${tag} Offer: "Offer acceptance is not a signature."`);
    ok(!/\d{4}-\d{2}-\d{2}/.test(o), `${tag} Offer: no ISO dates`);
    const rules = await sec.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    ok(rules === 0, `${tag} Offer: one rule under the tabs (the section adds none)`);
  } else ok(false, `${tag} Offer: category reachable`);

  // Messages + Trial (the demo inbox fills after a few seconds)
  const wait = 9500 - (Date.now() - t0); if (wait > 0) await sleep(wait);
  await p.click('a[href="/inbox"]'); await p.waitForSelector('[role="tablist"]', { timeout: 15000 }); await sleep(1200);
  check(tag, 'Messages', await measure(p), 140);
  ok((await p.locator('[data-testid^="inbox-request-"], [data-testid^="thread-"]').count()) >= 1, `${tag} Messages: conversation-first rows`);
  const req = p.locator('[data-testid^="inbox-request-"]').first();
  if (await req.count()) {
    await req.click(); await sleep(900);
    check(tag, 'Trial', await measure(p), 90);
    const card = p.locator('[data-testid="trial-card"]').first();
    ok((await card.count()) === 1 && /trial/i.test(await txt(card)), `${tag} Trial: accent card with a "Trial" label`);
    const st = await card.evaluate((el) => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, left: parseFloat(cs.borderLeftWidth) }; });
    ok((st.bg === 'rgba(0, 0, 0, 0)' || st.bg === 'transparent') && st.left >= 2, `${tag} Trial: an edge accent, no filled yellow card (${st.bg})`);
  } else ok(false, `${tag} Trial: request row present`);
  await ctx.close();
}

ok(errors.length === 0, `0 page errors (${errors.length ? errors.slice(0, 3).join(' | ') : 'clean'})`);
console.log(`\nm24f5PlayerVisualLive: ${passed} passed, ${failures.length} failed`);
server.close(); await browser.close();
process.exit(failures.length ? 1 : 0);
