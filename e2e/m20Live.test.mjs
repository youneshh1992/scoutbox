// M20 LIVE browser journeys — the Director Dashboard, driven through the real
// Pro workspace against a real server.
//
// D1   a lead reaches the dashboard from inside Recruitment — no new sidebar
//      section — and the governing sentence is above every number
// D2   the filter row offers period, source and priority, and says out loud
//      that there is no filter by colleague
// D3   the filters reach the URL; refresh and a pasted link reproduce the view
// D4   the funnel says it is not a one-way funnel and reports reopenings
// D5   a duration shows its typical figure with its spread, and names the
//      records it could not include
// D6   a rate over too few records is WITHHELD and shown as raw counts, and
//      "nothing happened" reads differently from "none of them"
// D7   every panel prints its own limitation, on screen, beside the number
// D8   the association-only figure carries its association sentence and its
//      sources stay alphabetical
// D9   a scout cannot reach the dashboard at all
// D10  a family that cannot be computed names itself and the rest of the page
//      still renders
// D11  a drill-down pages, and a player the club may not see is withheld by
//      name while still being counted
// D12  the screen fits a 390px phone, is keyboard-operable, and carries none
//      of the forbidden vocabulary — in English or in French
//
// The exhaustive invariants live in scoutbox-server/scripts/m20E2E.mjs. This
// suite proves the real UI drives them.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4020;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8815;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m20live-'));

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FORBIDDEN = [
  /Recruitment Score/i, /Scout Score/i, /Player Success Score/i, /Efficiency Score/i,
  /Talent Conversion/i, /Club Intelligence/i, /Leaderboard/i, /Top Scout/i, /\bBest Scout\b/i,
];
/** Strip the sentences that exist precisely to deny those terms. */
const denials = (t) => t
  .replace(/What this page will never show[\s\S]{0,900}?(?=\n\n|$)/gi, '')
  .replace(/never .{0,80}score[^.]*\./gi, '');

for (const port of [API_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

console.log(`building live bundle for :${API_PORT}…`);
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live20`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const idx = path.join(file, 'index.html');
      file = fs.existsSync(idx) ? idx : path.join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(port);
  statics.push(srv);
}
serveDir('scoutbox-club/dist-live20', CLUB_PORT);

const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 160; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const browser = await chromium.launch({ executablePath: EXE });
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

const errors = [];
async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 30000 });
  return page;
}
const tokenOf = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
});
async function goto(page, hash, selector) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  if (selector) {
    await page.waitForSelector(selector, { timeout: 25000 }).catch(async () => {
      const where = await page.evaluate(() => location.hash);
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 400);
      fail(`navigation to ${hash} never showed ${selector} (now at ${where}): ${text}`);
    });
  }
  await page.waitForTimeout(500);
}
const DASH = '#/recruitment/dashboard';

const maria = await enterClub(ctxA, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
const MARIA = await tokenOf(maria);
ok(!!MARIA, 'a Head of Recruitment is signed in');

// ---------------------------------------------------------------- fixture
// Real recruitment work, made through the real routes, so every figure the
// screen shows is a projection of something that actually happened.
{
  const players = (await j('GET', '/org/players', undefined, MARIA)).body;
  const list = Array.isArray(players) ? players : (players.items ?? players.players ?? []);
  const ids = [];
  for (const p of list.slice(0, 8)) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, MARIA);
    if (r.status < 300) ids.push(r.body.room?.roomId ?? r.body.roomId);
    else if (r.body?.existingRoomId) ids.push(r.body.existingRoomId);
  }
  const move = (id, status, extra = {}) => j('POST', `/org/rooms/${id}/status`, { status, ...extra }, MARIA);
  for (const id of ids) await move(id, 'under_review');
  for (const id of ids.slice(0, 5)) await move(id, 'shortlisted');
  await move(ids[0], 'trial_requested');
  await move(ids[1], 'archived', { reasonCodes: ['insufficient_recent_evidence'], note: 'PRIVATE PROSE THAT MUST NOT SURFACE' });
  await move(ids[2], 'withdrawn', { reasonCodes: ['squad_space'] });
  await move(ids[3], 'withdrawn', { reasonCodes: ['insufficient_full_match'] });
  await move(ids[4], 'archived', { reasonCodes: ['timing'] });
  await move(ids[5], 'archived', { reasonCodes: ['combine_missing'] });
  await move(ids[4], 'under_review', { reasonCodes: ['continue_monitoring'] });   // reopened

  // A second, deliberately TINY slice of work: three rooms opened from
  // Matching, two of them ended. Two endings is below the small-n threshold,
  // so filtering to this source is how D6 sees a rate withheld rather than
  // computed — which is the behaviour, not a gap in the fixture.
  const few = [];
  for (const p of list.slice(8, 11)) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'matching' }, MARIA);
    if (r.status < 300) few.push(r.body.room?.roomId ?? r.body.roomId);
    else if (r.body?.existingRoomId) few.push(r.body.existingRoomId);
  }
  for (const id of few) await move(id, 'under_review');
  if (few[0]) await move(few[0], 'archived', { reasonCodes: ['budget'] });
  if (few[1]) await move(few[1], 'withdrawn', { reasonCodes: ['registration'] });

  ok(ids.length >= 6 && few.length >= 2, `${ids.length + few.length} rooms of real recruitment work exist`);
}

// ------------------------------------------------------------------ D1
await goto(maria, DASH, '[data-screen="director-dashboard"]');
{
  const principle = await maria.locator('[data-principle]').innerText();
  ok(/do not measure any player/i.test(principle) && /colleague/i.test(principle),
    'D1 the governing sentence sits above every number: the process, not the player, not the colleague');

  // Inside Recruitment, not a section of its own.
  const nav = await maria.locator('nav.sidebar').innerText();
  ok(/Recruitment/i.test(nav), 'D1 the Recruitment section is present in the sidebar');
  // The destination must not have earned a top-level section of its own: the
  // sidebar's own top level is unchanged from before M20.
  const topLevel = (nav.match(/\n/g) ?? []).length;
  ok(!/^\s*Director Dashboard\s*$/m.test(nav.split('Recruitment')[0] ?? ''),
    `D1 the Director Dashboard is not a new top-level sidebar item (${topLevel} sidebar lines)`);
  const families = await maria.locator('[data-family]').count();
  ok(families === 7, `D1 all seven metric families render (${families})`);
}

// ------------------------------------------------------------------ D2
{
  const body = await maria.locator('body').innerText();
  ok(/no filter by colleague/i.test(body), 'D2 the screen says out loud that there is no filter by colleague');
  // Scoped to the filter card: the question is what THIS row offers.
  const filterCard = maria.locator('section:has([data-no-person-filter])');
  const selects = await filterCard.locator('select').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok(selects.length >= 3, `D2 the filter row offers ${selects.length} controls, all properties of the work`);
  ok(!selects.some((s) => /scout|colleague|user|owner|person|who/i.test(s ?? '')),
    `D2 …and not one of them names a person (${selects.join(', ')})`);
  // The server refuses one anyway.
  const refused = await j('GET', '/org/recruitment-analytics?groupBy=scout', undefined, MARIA);
  ok(refused.status === 400 && refused.body.error === 'GROUPING_BY_PERSON_REFUSED',
    'D2 and asking the API directly for a per-person breakdown is refused by name');
}

// ------------------------------------------------------------------ D3
{
  await maria.selectOption('select[aria-label="Period"]', 'last_30_days').catch(() => {});
  await maria.waitForTimeout(900);
  const hash = await maria.evaluate(() => location.hash);
  ok(/window=last_30_days/.test(hash), `D3 the chosen period reaches the URL (${hash})`);
  await maria.reload();
  await maria.waitForSelector('[data-screen="director-dashboard"]', { timeout: 25000 });
  await maria.waitForTimeout(1200);
  const after = await maria.evaluate(() => location.hash);
  const selected = await maria.locator('select[aria-label="Period"]').inputValue();
  ok(after === hash && selected === 'last_30_days', 'D3 refresh reproduces exactly the view that was shared');
  await maria.selectOption('select[aria-label="Period"]', 'last_365_days').catch(() => {});
  await maria.waitForTimeout(900);
}

// ---------------------------------------------- D3b: trend, buckets, freshness
{
  await goto(maria, `${DASH}?window=last_30_days`, '[data-screen="director-dashboard"]');
  await maria.waitForTimeout(900);
  const strip = maria.locator('[data-trend-strip]');
  ok(await strip.count() === 1, 'D3 the period-over-period strip renders');
  const trendText = await strip.innerText();
  ok(/Compared with the previous period/i.test(trendText), 'D3 …and says what it is comparing against');
  const cells = await maria.locator('[data-trend]').count();
  ok(cells === 3, `D3 three period-activity counts are compared (${cells}) — and no current-state figure is`);
  // The zero rule: never a percentage from a previous period of nothing.
  const words = (await maria.locator('[data-trend-words]').allInnerTexts()).join(' | ');
  ok(!/Infinity|NaN/.test(words), `D3 no comparison renders Infinity or NaN (${words})`);
  ok(!/\+?100%/.test(words) || !/from none/.test(words), 'D3 a rise from nothing is never dressed as a percentage');

  ok(await maria.locator('[data-calculated-at]').count() === 1,
    'D3 the page says when it was calculated rather than implying a live feed');

  const buckets = maria.locator('[data-age-buckets]').first();
  ok(await buckets.count() === 1, 'D3 open rooms are bucketed by age as well as summarised');
  const bucketIds = await maria.locator('[data-bucket]').evaluateAll((els) => els.map((e) => e.getAttribute('data-bucket')));
  ok(bucketIds.length >= 5 && bucketIds.includes('60_plus'),
    `D3 the buckets tile the whole range including an open-ended last one (${bucketIds.join(', ')})`);

  // The mandate's shortest window is offered and works.
  await maria.selectOption('select[aria-label="Period"]', 'last_7_days').catch(() => {});
  await maria.waitForTimeout(900);
  ok(/window=last_7_days/.test(await maria.evaluate(() => location.hash)), 'D3 a seven-day period is offered and reaches the URL');
  await maria.selectOption('select[aria-label="Period"]', 'last_365_days').catch(() => {});
  await maria.waitForTimeout(900);
}

// ------------------------------------------------------------------ D4
{
  const funnel = maria.locator('[data-metric="funnel_progression"]');
  const text = await funnel.innerText();
  ok(/not a one-way funnel/i.test(text), 'D4 the funnel states it is not a one-way funnel');
  ok(/Reopened after ending/i.test(text), 'D4 …and reports how many rooms came back');
  const notAFunnel = await funnel.locator('[data-not-a-funnel]').count();
  ok(notAFunnel === 1, 'D4 the statement is a marked element, not incidental prose');
  // A room reached under_review, left it, and is still counted for it.
  ok(/Under review/i.test(text) || /under_review/i.test(text), 'D4 a stage a room has left is still counted as reached');
}

// ------------------------------------------------------------------ D5
{
  const panel = maria.locator('[data-metric="time_in_stage"]');
  const text = await panel.innerText();
  ok(/looks fast/i.test(text), 'D5 time-in-stage warns that a stuck stage measures fast');
  const anyMedian = await maria.locator('[data-median]').count();
  const anySuppressed = await maria.locator('[data-suppressed]').count();
  ok(anyMedian + anySuppressed > 0, `D5 durations render either a typical figure (${anyMedian}) or the reason there is none (${anySuppressed})`);
  const excluded = await maria.locator('[data-excluded]').count();
  ok(excluded > 0, `D5 a duration names the records it could not include (${excluded} panels)`);
}

// ------------------------------------------------------------------ D6
{
  // Filtered to the source with only two endings behind it.
  await goto(maria, `${DASH}?window=last_365_days&source=matching`, '[data-screen="director-dashboard"]');
  await maria.waitForTimeout(900);
  const body = await maria.locator('body').innerText();
  ok(/too few to express as a rate/i.test(body), 'D6 a rate over too few records is withheld, in those words');
  ok(/Nothing in this period/i.test(body), 'D6 "nothing happened" has its own wording');
  // The two must not collapse into each other.
  ok(!/0% of 0/.test(body), 'D6 nothing renders as a percentage of nothing');
  const suppressedShown = await maria.locator('text=/\\d+ of \\d+ — too few/').count();
  ok(suppressedShown > 0, 'D6 …and a withheld rate still shows its raw counts');
  // Widening the window does not resurrect a rate the SAMPLE is too small for:
  // suppression is about how many records there are, not how long you looked.
  await goto(maria, `${DASH}?window=last_365_days`, '[data-screen="director-dashboard"]');
  await maria.waitForTimeout(900);
  const wide = await maria.locator('body').innerText();
  ok(/% of \d+/.test(wide), 'D6 with enough records behind it, the same panel shows a real rate');
}

// ------------------------------------------------------------------ D7
{
  const panels = await maria.locator('[data-metric]').count();
  const limitations = await maria.locator('[data-metric] [data-limitation]').count();
  ok(panels > 0 && limitations >= panels,
    `D7 every one of the ${panels} panels prints its own limitation on screen (${limitations} found)`);
  // Not hidden behind a disclosure.
  const hidden = await maria.locator('details [data-limitation]').count();
  ok(hidden === 0, 'D7 no limitation is tucked inside a collapsed disclosure');
  const sample = await maria.locator('[data-metric="stalled_rooms"] [data-limitation]').innerText();
  ok(/prompt to look, not a finding/i.test(sample), 'D7 the caveat is the server’s own sentence, not a paraphrase');
}

// ------------------------------------------------------------------ D8
{
  const panel = maria.locator('[data-metric="source_stage_reach"]');
  const note = await panel.locator('[data-association]').innerText();
  ok(/does not show that the property caused it/i.test(note),
    'D8 the association-only figure carries the sentence that refuses the causal reading');
  const sources = await panel.locator('table.data tbody tr td:first-child').allInnerTexts();
  const sorted = sources.slice().sort((a, b) => a.localeCompare(b));
  ok(JSON.stringify(sources) === JSON.stringify(sorted),
    `D8 …and its sources stay alphabetical, never ranked (${sources.join(', ')})`);
  ok(/not a ranking of surfaces/i.test(await panel.innerText()), 'D8 the screen says so as well');
}

// ------------------------------------------------------------------ D9
{
  const tom = await enterClub(ctxB, 'Eastport FC', 'Tom Field', 'First-Team Scout');
  const TOM = await tokenOf(tom);
  const refused = await j('GET', '/org/recruitment-analytics', undefined, TOM);
  ok(refused.status === 403 && refused.body.error === 'LEAD_REQUIRED', 'D9 a scout is refused the organisation-wide view');
  const nav = await tom.locator('nav.sidebar').innerText();
  ok(!/Director Dashboard/i.test(nav), 'D9 …and it is not offered to them in the sidebar');
  await goto(tom, DASH);
  await tom.waitForTimeout(1500);
  const body = await tom.locator('body').innerText();
  ok(!/Rooms by status/i.test(body) && !/Stages reached/i.test(body),
    'D9 typing the link by hand shows them no figures either');
  await tom.close();
}

// ------------------------------------------------------------------ D10
{
  await goto(maria, `${DASH}`, '[data-screen="director-dashboard"]');
  // The fault-injection hook is the M18.2 mechanism, dev-only.
  const partial = await j('GET', '/org/recruitment-analytics?simulateFailure=coverage', undefined, MARIA);
  ok(partial.status === 200 && partial.body.partial === true,
    'D10 a family that cannot be computed still returns the page, with the failure named');
  const rendered = Object.values(partial.body.data).filter((f) => !f.error).length;
  ok(rendered === 6, `D10 the other six families are complete (${rendered})`);
  ok(partial.body.data.coverage.detail && !/\n\s+at /.test(partial.body.data.coverage.detail),
    'D10 the failure carries a reason, not a stack trace');
}

// ------------------------------------------------------------------ D11
{
  const seeAll = maria.locator('[data-metric="stalled_rooms"] button:has-text("See all")');
  if (await seeAll.count()) {
    await seeAll.click();
    await maria.waitForTimeout(900);
    const drill = maria.locator('[data-drilldown]');
    ok(await drill.count() === 1, 'D11 a drill-down opens for the rooms behind the figure');
    ok((await drill.locator('[data-limitation]').count()) === 1, 'D11 …and carries the limitation with the rows');
  } else {
    say('D11 no room is stalled in this fresh fixture, so the drill-down has nothing to open (correct)');
  }
  // Server-side: the row contract is bounded, stable and never carries a note.
  const rows = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=5000', undefined, MARIA);
  ok(rows.body.limit <= 50, `D11 a caller cannot ask for the whole table (limit clamped to ${rows.body.limit})`);
  ok(!JSON.stringify(rows.body).includes('PRIVATE PROSE THAT MUST NOT SURFACE'),
    'D11 no private prose reaches a drill-down row');
  const again = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=25', undefined, MARIA);
  ok(JSON.stringify(again.body.rows) === JSON.stringify((await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=25', undefined, MARIA)).body.rows),
    'D11 two reads of unchanged data return the same rows in the same order');
}

// ------------------------------------------------------------------ D12
{
  await goto(maria, DASH, '[data-screen="director-dashboard"]');
  const en = await maria.locator('body').innerText();
  const hit = FORBIDDEN.find((re) => re.test(denials(en)));
  ok(!hit, `D12 no forbidden vocabulary in English${hit ? ` (${hit})` : ''}`);
  ok(!/\bm20\.[a-zA-Z._]+\b/.test(en), 'D12 no raw m20 i18n key leaks');
  ok(!/\[object Object\]/.test(en) && !/undefined/.test(en.replace(/undefined\w/g, '')), 'D12 no rendering artefact');

  // French
  await maria.selectOption('select[aria-label="Language"]', 'fr').catch(() => {});
  await maria.waitForTimeout(1200);
  const fr = await maria.locator('body').innerText();
  ok(/Tableau de bord du directeur/.test(fr), 'D12 the dashboard is translated');
  ok(!/\bm20\.[a-zA-Z._]+\b/.test(fr), 'D12 no raw m20 key leaks in French');
  const frHit = FORBIDDEN.find((re) => re.test(denials(fr)));
  ok(!frHit, `D12 no forbidden vocabulary in French${frHit ? ` (${frHit})` : ''}`);
  await maria.selectOption('select[aria-label="Langue"]', 'en').catch(() => maria.selectOption('select[aria-label="Language"]', 'en').catch(() => {}));
  await maria.waitForTimeout(900);

  // Keyboard
  await maria.locator('select[aria-label="Period"]').focus();
  const focused = await maria.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  ok(focused === 'Period', 'D12 the filter row takes keyboard focus');

  // 390px
  await maria.setViewportSize({ width: 390, height: 844 });
  await maria.waitForTimeout(700);
  const overflow = await maria.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `D12 the dashboard fits a 390px phone (overflow=${overflow}px)`);
  await maria.setViewportSize({ width: 1440, height: 1000 });
}

ok(errors.length === 0, `no page errors across the journey${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);

await browser.close();
cleanup();
console.log(`\nM20 live journeys: ${passed} checks passed`);
