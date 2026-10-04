// M24F.4 — the Player's roots in a real browser, on the demo bundle, at
// 320 / 360 / 390 / 430 and 640×360 (landscape): Home, Activity (collapsed on
// Home, the full page behind "View all activity"), Passport, Development,
// Box Cam, Combine, Evidence, Explore, Opportunity, Offer, Messages.
// For each: the word budget, no paragraph over 140 characters, no greeting /
// date / "View your Passport" / "Verified clubs can see you" in the Home
// header, the joined line only with a creation date, the Combine root names
// only, the Box Cam root session-led, the Evidence root media-led, the Offer
// root a document with Accept / Decline and "View terms", no horizontal
// overflow, Inter as the computed face, zero page errors.
// Own port (8889). KEEP_DIST=1 reuses dist-live24f4-demo. Run from e2e/:
// node m24f4PlayerMinimalLive.test.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8889; const DIST = 'dist-live24f4-demo';
const KEEP = process.env.KEEP_DIST === '1';
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync(`fuser -k ${PORT}/tcp`, { stdio: 'ignore' }); } catch { /* free */ }
if (!(KEEP && fs.existsSync(path.join(ROOT, 'scoutbox-player', DIST, 'index.html')))) {
  console.log(`building ${DIST}…`); execSync(`EXPO_PUBLIC_DEMO=1 npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const root = path.join(ROOT, 'scoutbox-player', DIST);
const server = http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(PORT);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); return page; };
const MEASURE = `(() => {
  const root = document.querySelector('[data-testid="mobile-viewport"]') ?? document.body;
  const hidden = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (e.getAttribute('aria-hidden') === 'true' || cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !hidden(el); };
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let words = 0, chars = 0; let n;
  while ((n = tw.nextNode())) { const s = n.textContent.replace(/\\s+/g, ' ').trim(); if (s && n.parentElement && vis(n.parentElement) && !['SCRIPT','STYLE','OPTION'].includes(n.parentElement.tagName)) { words += s.split(' ').length; chars += s.length; } }
  const leaves = [...root.querySelectorAll('div, span, p, a, button')].filter((el) => vis(el) && [...el.children].every((c) => c.tagName === 'SPAN' || c.tagName === 'BR'));
  const paragraphs = leaves.map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => t.length > 140);
  const fonts = {}; for (const el of leaves.slice(0, 300)) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; }
  const seconds = (root.innerText.match(/\\b\\d{1,2}:\\d{2}:\\d{2}\\b/g) || []).length;
  const overflow = document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1;
  return { words, chars, paragraphs: paragraphs.length, sample: paragraphs[0]?.slice(0, 90) ?? '', fonts, seconds, overflow };
})()`;
const measure = (page) => page.evaluate(MEASURE);
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const tab = async (page, name) => { const t = page.getByRole('tab', { name, exact: true }); const n = await t.count(); if (!n) return false; await t.nth(n - 1).click(); await sleep(500); return true; };
const interOnly = (m) => { const top = Object.entries(m.fonts).sort((a, b) => b[1] - a[1])[0]; return top && /^Inter/.test(top[0]) && Object.keys(m.fonts).every((f) => /^Inter|AlbertSans|monospace/.test(f)); };
const check = (tag, screen, m, budget, allowPara = 0) => {
  ok(m.words <= budget, `${tag} ${screen}: ${m.words} words (budget ${budget})`);
  ok(m.paragraphs <= allowPara, `${tag} ${screen}: ${m.paragraphs} paragraph(s) over 140 characters${m.sample ? ` ("${m.sample}…")` : ''}`);
  ok(!m.overflow, `${tag} ${screen}: no horizontal overflow`);
  ok(m.seconds === 0, `${tag} ${screen}: no seconds`);
  ok(interOnly(m), `${tag} ${screen}: Inter is the computed face (${Object.keys(m.fonts).join(', ')})`);
};

for (const [w, h] of [[320, 690], [360, 780], [390, 844], [430, 932], [640, 360]]) {
  const tag = `${w}×${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = watch(await ctx.newPage(), tag);
  await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await page.waitForSelector('[data-testid="home-identity"]', { timeout: 30000 }); await sleep(900);

  // ---------------------------------------------------------------- Home
  const home = await measure(page);
  check(tag, 'Home', home, 130);
  const header = await txt(page.locator('[data-testid="home-identity"]'));
  ok(!/Good (morning|afternoon|evening)|Bonjour|Bonsoir/.test(header), `${tag} Home header: no greeting`);
  ok(!/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day)?\b|\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{4}(?!.*Joined)/.test(header.replace(/Joined [A-Za-z]+ \d{4}/, '')), `${tag} Home header: no day / date line`);
  ok(!/View your Passport/.test(header) && !/Verified clubs can see you/.test(header), `${tag} Home header: no "View your Passport", no "Verified clubs can see you"`);
  ok(/Kola Adeyemi/.test(header) && /ST · Manchester/.test(header) && /Open to trials/.test(header), `${tag} Home header: name, football line, availability`);
  ok(/Joined [A-Za-z]+ \d{4}/.test(header), `${tag} Home header: "Joined <month year>" from the record's creation date`);
  ok((await page.locator('[data-testid="home-primary-cta"]').count()) <= 1 && (await page.locator('[data-testid="home-primary"]').count()) === 1, `${tag} Home: one current action`);
  ok((await page.locator('[data-testid="home-activity"]').count()) === 1 && (await page.locator('[data-testid="home-activity-all"]').count()) === 1, `${tag} Home: Recent section with "View all activity"`);
  const bodyHome = await txt(page.locator('[data-testid="mobile-viewport"]'));
  ok(!/Verified clubs can see you/.test(bodyHome), `${tag} Home: the visibility sentence is behind its row`);
  // ---------------------------------------------------------------- Activity
  await page.locator('[data-testid="home-activity-all"]').click(); await page.waitForSelector('[data-testid="activity-page"]', { timeout: 15000 }); await sleep(600);
  const act = await measure(page);
  check(tag, 'Activity', act, 140);
  ok((await page.locator('[data-testid="activity-row"]').count()) >= 1 && (await page.locator('[data-testid^="activity-group-"]').count()) >= 1, `${tag} Activity: rows grouped by period`);
  ok((await page.locator('table').count()) === 0, `${tag} Activity: no spreadsheet table`);
  const back = page.locator('[aria-label="Back"]').first(); if (await back.count()) { await back.click(); } else { await page.goBack(); } await sleep(500);

  // ---------------------------------------------------------------- Football
  await page.click('a[href^="/football"]'); await sleep(1100);
  if (await tab(page, 'Passport')) { const m = await measure(page); check(tag, 'Passport', m, 150);
    ok((await page.locator('[data-testid="passport-timeline"]').count()) === 1 && (await page.locator('[data-testid^="passport-event-"]').count()) === 0, `${tag} Passport: Timeline is a row; no event rows on the root`);
    ok(/Timeline.*\d+ events/.test(await txt(page.locator('[data-testid="passport-timeline"]'))), `${tag} Passport: the Timeline row carries its count`);
    await page.locator('[data-testid="passport-timeline"] > [role="button"]').first().click(); await sleep(400);
    ok((await page.locator('[data-testid^="passport-event-"]').count()) >= 1, `${tag} Passport: the Timeline row opens the events`);
  }
  if (await tab(page, 'Development')) { const m = await measure(page); check(tag, 'Development', m, 120);
    for (const id of ['dev-focus', 'dev-feedback', 'dev-progress', 'dev-history']) ok((await page.locator(`[data-testid="${id}"]`).count()) === 1, `${tag} Development: ${id} row`);
    ok((await page.locator('[data-testid="dev-root"]').count()) === 1, `${tag} Development: four rows, no feedback paragraph on the root`);
    await page.locator('[data-testid="dev-feedback"]').click(); await sleep(400);
    ok((await page.locator('[data-testid="dev-page-feedback"]').count()) === 1, `${tag} Development: Latest feedback opens its page`);
    await page.locator('[data-testid="dev-back"]').click(); await sleep(300);
  }
  if (await tab(page, 'Box Cam')) { const m = await measure(page); check(tag, 'Box Cam', m, 130);
    ok((await page.locator('[data-testid="boxcam-visual"]').count()) === 1 && (await page.locator('[data-testid="boxcam-latest"]').count()) === 1 && (await page.locator('[data-testid="boxcam-start"]').count()) === 1, `${tag} Box Cam: the visual, the latest session row, Start session`);
    ok((await page.locator('[data-testid="boxcam-recent"] [data-testid^="boxcam-session-"]').count()) <= 3, `${tag} Box Cam: at most three recent rows`);
    const body = await txt(page.locator('[data-testid="mobile-viewport"]'));
    ok(!/Set your phone down/.test(body) && /How Box Cam works/.test(body), `${tag} Box Cam: setup instructions sit behind "How Box Cam works"`);
    await page.locator('[data-testid="boxcam-how"] > [role="button"]').click(); await sleep(300);
    ok(/Set your phone down/.test(await txt(page.locator('[data-testid="mobile-viewport"]'))), `${tag} Box Cam: "How Box Cam works" opens the setup`);
    await page.locator('[data-testid="boxcam-how"] > [role="button"]').click(); await sleep(200);
  }
  if (await tab(page, 'Combine')) { const m = await measure(page); check(tag, 'Combine', m, 90);
    const rows = page.locator('[data-testid^="combine-protocol-"]'); const n = await rows.count();
    ok(n >= 3, `${tag} Combine: ${n} exercise rows`);
    const names = await rows.allInnerTexts();
    ok(names.every((t) => t.trim().split('\n').length === 1 && !/\d+ (s|cm|m|reps)\b|Verified|Not supported|Start/.test(t)), `${tag} Combine root: exercise names only`);
    await rows.first().click(); await sleep(400);
    ok((await page.locator('[data-testid="combine-detail"]').count()) === 1 && (await page.locator('[data-testid="combine-latest"]').count()) === 1 && (await page.locator('[data-testid="combine-status"]').count()) === 1, `${tag} Combine: the row opens latest result and status`);
    ok((await page.locator('[data-testid="combine-instructions"]').count()) === 1 && (await page.locator('[data-testid="combine-history"]').count()) === 1, `${tag} Combine: instructions and history behind rows`);
    await page.locator('[data-testid="combine-back"]').click(); await sleep(300);
  }

  // ---------------------------------------------------------------- Evidence
  await page.click('a[href^="/you"]'); await sleep(1000);
  if (await tab(page, 'Profile') && await tab(page, 'Evidence')) { const m = await measure(page); check(tag, 'Evidence', m, 120);
    ok((await page.locator('[data-testid="evidence-root"]').count()) === 1 && (await page.locator('[data-testid="evidence-latest-thumb"]').count()) === 1, `${tag} Evidence: the latest clip as a picture`);
    for (const id of ['evidence-video-row', 'evidence-combine-row', 'evidence-references-row', 'evidence-attendance-row']) ok(/\d/.test(await txt(page.locator(`[data-testid="${id}"]`))), `${tag} Evidence: ${id} with its count`);
    ok((await page.locator('video').count()) <= 1 && (await page.locator('[data-testid^="evidence-clip-"]').count()) === 0, `${tag} Evidence root: no clip list on the root`);
    await page.locator('[data-testid="evidence-video-row"]').click(); await sleep(400);
    ok((await page.locator('[data-testid="evidence-footage"]').count()) === 1, `${tag} Evidence: Video opens the clips`);
    await page.locator('[data-testid="evidence-back"]').click(); await sleep(300);
  }

  // ---------------------------------------------------------------- Explore / Opportunity / Offer
  await page.click('a[href^="/opportunities"]'); await sleep(1000);
  const explore = await measure(page); check(tag, 'Explore', explore, 200);
  const rows = page.locator('[data-testid^="board-view-"]');
  if (await rows.count()) { await rows.first().click(); await sleep(400); const m = await measure(page); check(tag, 'Opportunity', m, 260); await rows.first().click(); await sleep(200); }
  const cat = page.locator('[data-testid="cat-offer"]');
  if (await cat.count()) {
    await cat.click(); await sleep(700); const ot = page.getByRole('tab', { name: 'Offer', exact: true }); if (await ot.count()) { await ot.last().click(); await sleep(500); }
    const m = await measure(page); check(tag, 'Offer', m, 110);
    const sec = page.locator('[data-testid="offer-section"]');
    const t0 = await txt(sec);
    // M24F.5 — the status is its own line (no "Status" fact label); it carries the accessible label "Status: …".
    const hasStatus = (await sec.locator('[aria-label^="Status:"]').count()) >= 1;
    ok(/Eastport FC/.test(t0) && hasStatus && /Accept/.test(t0) && /Decline/.test(t0) && /View terms/.test(t0), `${tag} Offer: club, status, Accept / Decline, "View terms"`);
    ok(/Offer acceptance is not a signature\./.test(t0), `${tag} Offer: the one quiet line`);
    ok(!/Conditions:/.test(t0) && !/Message from the club/.test(t0) && !/Earlier revisions/.test(t0), `${tag} Offer root: no conditions, message or history on the root`);
    ok(!/\d{4}-\d{2}-\d{2}/.test(t0), `${tag} Offer root: dates read as days, not ISO`);
    await sec.locator('[data-testid^="offer-terms-"] > [role="button"]').first().click(); await sleep(400);
    ok((await txt(sec)).length > t0.length + 20, `${tag} Offer: "View terms" opens the detail`);
  }

  // ---------------------------------------------------------------- Messages
  await page.click('a[href^="/inbox"]'); await page.waitForSelector('[role="tablist"]', { timeout: 15000 }); await sleep(800);
  const inbox = await measure(page); check(tag, 'Messages', inbox, 140);
  ok((await page.locator('[data-testid^="row-accent-trial"]').count()) >= 1 || (await page.locator('[data-testid^="thread-"], [data-testid^="inbox-request-"]').count()) >= 1, `${tag} Messages: conversation-first rows (M24F.3 direction kept)`);
  await ctx.close();
}

ok(errors.length === 0, `no page errors (${errors.length ? errors.slice(0, 3).join(' | ') : 'clean'})`);
console.log(`\nm24f4PlayerMinimalLive: ${passed} passed, ${failures.length} failed`);
server.close(); await browser.close();
process.exit(failures.length ? 1 : 0);
