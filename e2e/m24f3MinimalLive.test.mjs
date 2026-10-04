// M24F.3 — the one-line rule on the Player's root screens, in a real browser:
//   Passport root (verified status, club, availability, evidence in one word,
//   a four-row timeline), Trust Score root (score, band, "Evidence confidence
//   only", "View breakdown"), the Timeline rows (provenance only when opened),
//   the Opportunity board (one-line rows, details behind "View details"),
//   Opportunity fit (one line + "Check fit", reasons behind "Why"), the club
//   request detail (Accept / Decline visible, message behind "View full
//   message") and the Inbox list — at 390 / 430 / 1024: fewer visible
//   characters than the M24F.2 roots, every details control present and
//   working, no horizontal overflow, zero page errors.
// The Passport / Trust / board / fit screens run on the demo bundle (fixed
// data, so the numbers are stable); the request and the Inbox run live
// against scoutbox-server, seeded over the public API.
// Own ports (API 4066, shared with m24f3InboxLive). KEEP_DIST=1 reuses
// dist-live24f3 and dist-live24f3-demo. Run from e2e/: node m24f3MinimalLive.test.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4066; const API = `http://localhost:${API_PORT}`;
const PORTS = { live: 8886, demo: 8887 };
const DIST = 'dist-live24f3';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24f3min-'));
const KEEP = process.env.KEEP_DIST === '1';
// M24F.2 roots at 390px, measured by the same crawler before M24F.3 (visible characters)
const BEFORE = { passport: 2730, inbox: 1272, board: 5892, fit: 6159 };
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, ...Object.values(PORTS)]) { try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch { /* free */ } }
const bundles = [[`${DIST}`, PORTS.live, `EXPO_PUBLIC_API_URL=${API}`], [`${DIST}-demo`, PORTS.demo, 'EXPO_PUBLIC_DEMO=1']];
for (const [dist, , env] of bundles) {
  if (KEEP && fs.existsSync(path.join(ROOT, 'scoutbox-player', dist, 'index.html'))) { console.log(`reusing ${dist} (KEEP_DIST=1)`); continue; }
  console.log(`building ${dist}…`); execSync(`${env} npx expo export --clear --platform web --output-dir ${dist}`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
}
const serverProc = spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const statics = bundles.map(([dist, port]) => {
  const root = path.join(ROOT, 'scoutbox-player', dist);
  return http.createServer((req, res) => {
    let f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(port);
});
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);
const j = async (method, p, body, token) => { const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => ({})) }; };

// ------------------------------------------------------------ seed: a contact request for Kola
const LEAD = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body.token;
const SECRET = 'Bring your boots; parking is behind the main stand';
let seeded = false;
if (LEAD) {
  const made = (await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, LEAD)).body.room; const room = made ? { id: made.roomId } : null;
  const rev = async () => (await j('GET', `/org/rooms/${room.id}`, undefined, LEAD)).body.room?.rev;
  if (!room) console.log('  ! no room');
  await j('POST', `/org/rooms/${room.id}/status`, { status: 'under_review', expectedRev: await rev() }, LEAD);
  await j('POST', `/org/rooms/${room.id}/status`, { status: 'contact_planned', expectedRev: await rev() }, LEAD);
  const d = (await j('POST', `/org/rooms/${room.id}/contacts`, { body: `Hello Kola — a conversation about our U21s. ${SECRET}.` }, LEAD)).body.contact;
  if (d) seeded = (await j('POST', `/org/rooms/${room.id}/contacts/${d.id}/send`, { expectedRev: d.rev }, LEAD)).status < 300;
}
ok(seeded, 'seed: Eastport sent Kola a contact request over the API');

// ------------------------------------------------------------ browser
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctxFor = (w, h) => browser.newContext({ viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); return page; };
async function enter(page, port) {
  await page.goto(`http://localhost:${port}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await page.locator('[data-testid="demo-identities"] >> text=Enter').nth(0).click(); await page.waitForSelector('text=Your visibility right now', { timeout: 30000 }); await sleep(500);
}
// visible characters of the active screen (inactive tab screens are aria-hidden)
const CHARS = `(() => { const root = document.querySelector('[data-testid="mobile-viewport"]') ?? document.body; const hidden = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { if (e.getAttribute('aria-hidden') === 'true' || getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return true; } return false; }; const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n = 0, t; while ((t = tw.nextNode())) { const s = t.textContent.replace(/\\s+/g, ' ').trim(); if (s && t.parentElement && !hidden(t.parentElement)) n += s.length; } return n; })()`;
const OVERFLOW = `(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth)`;
const chars = (page) => page.evaluate(CHARS);
const vp = (page) => page.locator('[data-testid="mobile-viewport"]');
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const tab = async (page, name) => { await page.getByRole('tab', { name, exact: true }).first().click(); await sleep(600); };

for (const [w, h] of [[390, 844], [430, 932], [1024, 768]]) {
  const tag = `demo ${w}px`;
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), tag);
  await enter(page, PORTS.demo);

  // Passport
  await page.click('a[href^="/football"]'); await sleep(1200);
  const root = page.locator('[data-testid="passport-root"]');
  ok((await root.count()) === 1, `${tag} Passport: the root renders`);
  const c0 = await chars(page);
  ok(w !== 390 || c0 < BEFORE.passport * 0.6, `${tag} Passport: ${c0} visible characters (M24F.2 root: ${BEFORE.passport})`);
  const rootText = await txt(root);
  ok(/Verified|Pending|Unverified/.test(rootText) && (await root.locator('[data-testid="passport-club"]').count()) === 1 && (await root.locator('[data-testid="passport-availability"]').count()) === 1 && (await root.locator('[data-testid="passport-evidence"]').count()) === 1, `${tag} Passport root: status, club, availability, evidence`);
  ok(!/Where is this from|disclaimer|projection over source records/i.test(rootText), `${tag} Passport root: no provenance prose, no disclaimer`);
  ok(!(await page.evaluate(OVERFLOW)), `${tag} Passport: no horizontal overflow`);
  const about = page.locator('[data-testid="passport-about"]');
  ok((await about.count()) === 1, `${tag} Passport: "About Passport" present`);
  const before = await chars(page); await about.click(); await sleep(400); const after = await chars(page);
  ok(after > before + 40, `${tag} Passport: About opens (${before} → ${after} characters)`);
  await about.click(); await sleep(300);
  // Timeline — M24F.4: one root row ("Timeline · n events") opens the preview
  ok((await page.locator('[data-testid^="passport-event-"]').count()) === 0, `${tag} Timeline: no event rows on the root`);
  await page.locator('[data-testid="passport-timeline"] > [role="button"]').first().click(); await sleep(400);
  const events = page.locator('[data-testid^="passport-event-"]');
  const n = await events.count();
  ok(n > 0 && n <= 4, `${tag} Timeline: ${n} rows in the preview (≤ 4)`);
  ok((await page.locator('[data-testid="passport-timeline-more"]').count()) === 1, `${tag} Timeline: "Show all" present`);
  if (n) {
    const row = events.first(); const t0 = await txt(row);
    ok(!/Verified by|supplied|Registry|Where is this from/i.test(t0), `${tag} Timeline row closed: date + label only`);
    await row.click(); await sleep(400); const t1 = await txt(row);
    ok(t1.length > t0.length + 10 && /Verified by|supplied|Registry|verified|Source/i.test(t1), `${tag} Timeline row open: the source and provenance appear`);
    await row.click(); await sleep(200);
  }
  // Trust
  const score = page.locator('[data-testid="trust-score"]');
  ok((await score.count()) === 1, `${tag} Trust: the score renders`);
  const trustCard = score.locator('xpath=ancestor::*[.//*[@data-testid="trust-why"]][1]');
  const trustRoot = await txt((await trustCard.count()) ? trustCard : vp(page));
  ok(/Evidence confidence only/.test(trustRoot) && /View breakdown/.test(trustRoot), `${tag} Trust root: "Evidence confidence only" and "View breakdown"`);
  ok(!/Policy v|policy version|v\d+\.\d+/i.test(trustRoot) && !/Strengths|Gaps/.test(trustRoot), `${tag} Trust root: no policy version, no strengths / gaps`);
  await page.locator('[data-testid="trust-why"]').click(); await sleep(500);
  ok((await page.locator('[data-testid="trust-breakdown"]').count()) === 1 && (await page.locator('[data-testid="trust-about"]').count()) === 1, `${tag} Trust: breakdown and About open behind "View breakdown"`);
  await page.locator('[data-testid="trust-about"]').click(); await sleep(400);
  ok(/Policy|policy/.test(await txt(vp(page))), `${tag} Trust: the policy version lives inside About`);

  // Opportunities: board + fit
  await page.click('a[href^="/opportunities"]'); await sleep(1200);
  const boardTab = page.getByRole('tab', { name: 'Board', exact: true });
  if (await boardTab.count()) { await boardTab.last().click(); await sleep(600); }
  const rows = page.locator('[data-testid^="board-view-"]');
  ok((await rows.count()) >= 1, `${tag} Board: ${await rows.count()} opportunity rows`);
  const c1 = await chars(page);
  ok(w !== 390 || c1 < BEFORE.board * 0.6, `${tag} Board: ${c1} visible characters (M24F.2: ${BEFORE.board})`);
  if (await rows.count()) {
    const r0 = rows.first(); const hintH = await r0.evaluate((el) => { const lines = [...el.querySelectorAll('div')].filter((d) => d.children.length === 0 && d.textContent.includes('·')); return lines.length ? Math.round(lines[lines.length - 1].getBoundingClientRect().height) : 0; });
    ok(hintH > 0 && hintH <= 40, `${tag} Board row: the preview is at most two lines (${hintH}px)`);
    const t0 = await txt(r0);
    ok(!/Requirements/.test(t0) && !/Apply/.test(t0), `${tag} Board row closed: title, club · date · distance · state — no description`);
    await r0.click(); await sleep(400);
    const t1 = await txt(r0);
    ok(t1.length > t0.length + 20 && /Apply|Applied|Open day|Withdrawn|Accepted|Declined/.test(t1), `${tag} Board row open: description, requirements where stated, the action (${t1.length - t0.length} more characters)`);
    await r0.click(); await sleep(200);
  }
  ok(!(await page.evaluate(OVERFLOW)), `${tag} Opportunities: no horizontal overflow`);
  const fit = page.locator('[data-testid="fit"]');
  if (!(await fit.count())) { const ov = page.getByRole('tab', { name: 'Overview', exact: true }); if (await ov.count()) { await ov.last().click(); await sleep(600); } }
  ok((await fit.count()) === 1, `${tag} Fit: the section renders`);
  const f0 = await txt(fit);
  ok(/Check fit/.test(f0) && !/Why/.test(f0) && f0.length < 400, `${tag} Fit root: one line and "Check fit" (${f0.length} characters)`);
  const check = page.locator('[data-testid^="fit-check-"]').first();
  if (await check.count()) {
    await check.click(); await sleep(900);
    const res = page.locator('[data-testid^="fit-result-"]').first();
    ok((await res.count()) === 1, `${tag} Fit: a result appears`);
    const why = page.locator('[data-testid^="fit-why-"]').first();
    ok((await why.count()) === 1, `${tag} Fit: reasons sit behind "Why"`);
    const r0 = await txt(res); await why.click(); await sleep(400); const r1 = await txt(res.locator('xpath=..'));
    ok(r1.length > r0.length, `${tag} Fit: "Why" opens the reasons`);
  }
  await ctx.close();
}

// ------------------------------------------------------------ live: the Inbox and the club request
for (const [w, h] of [[390, 844], [1024, 768]]) {
  const tag = `live ${w}px`;
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), tag);
  await enter(page, PORTS.live);
  await page.click('a[href^="/inbox"]'); await page.waitForSelector('[role="tablist"]', { timeout: 15000 }); await sleep(900);
  const c = await chars(page);
  ok(w !== 390 || c < BEFORE.inbox, `${tag} Inbox: ${c} visible characters (M24F.2: ${BEFORE.inbox})`);
  ok(!(await page.evaluate(OVERFLOW)), `${tag} Inbox: no horizontal overflow`);
  const list = await txt(vp(page));
  ok(!list.includes(SECRET), `${tag} Inbox: the message body is not on the list`);
  const row = page.locator('[data-testid^="inbox-request-"]').first();
  ok((await row.count()) >= 1, `${tag} Inbox: the request row is there`);
  if (await row.count()) {
    const hgt = await row.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    ok(hgt <= 96, `${tag} Inbox: the row is compact (${hgt}px)`);
    await row.click(); await sleep(700);
    const detail = page.locator('[data-testid^="request-detail-"]');
    const d0 = await txt(detail);
    ok(/Accept/.test(d0) && /Decline/.test(d0) && /View full message/.test(d0) && !d0.includes(SECRET), `${tag} Request: Accept / Decline visible; the message behind "View full message"`);
    await detail.locator('[data-testid^="req-details-"]').first().click(); await sleep(400);
    ok((await txt(detail)).includes(SECRET), `${tag} Request: the full message opens`);
    ok(!/Policy|provenance|ledger/i.test(await txt(detail)), `${tag} Request: no policy prose`);
  }
  // the detail is page state: leave it through its own back control (the Messages tab keeps where you were)
  const back = page.locator('[data-testid="detail-back"], [aria-label="Back"], [aria-label*="ack to"]').first(); if (await back.count()) { await back.click(); await sleep(600); }
  const safety = page.locator('[data-testid="inbox-safety"]');
  const st = (await safety.count()) ? await txt(safety) : '(absent)';
  ok(/You control who can contact you/.test(st) && st.length < 80, `${tag} Inbox: the safeguarding line is one sentence (${st.slice(0, 60)})`);
  await ctx.close();
}

ok(errors.length === 0, `zero page errors (${errors.length})${errors.length ? ` — ${errors.slice(0, 2).join(' | ')}` : ''}`);
console.log(`\nm24f3MinimalLive: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
await browser.close(); serverProc.kill(); statics.forEach((s) => s.close());
process.exit(failures.length ? 1 : 0);
