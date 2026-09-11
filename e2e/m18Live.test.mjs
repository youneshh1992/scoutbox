// M18 LIVE browser journeys — Second Look + Nobody Missed against the real
// backend, separate browser contexts per actor so tenants are genuinely
// isolated.
//
// M1  archive for "not enough recent evidence", a full match arrives,
//     Second Look → Review Changes → Reopen Room
// M2  a club-side reason is never reported as resolved by player evidence
// M3  dismiss, reload, re-read: the same evidence never regenerates the item
// M4  a genuinely different later full match may surface it again
// M5  write a Brief, activate it, read coverage, add a candidate to a Room
// M6  a player with an active Room is not a Nobody Missed candidate
// M7  a previously evaluated player returns through Second Look, never
//     through Nobody Missed
// M8  a second organisation reaches none of the first one's M18 state
// M9  a block removes the player from every M18 projection on the next read
// M10 the grassroots ceilings and the visibility gates survive intact
//
// The exhaustive engine invariants, all 60 abuse cases and S1–S8 / N1–N8 live
// in scripts/m18E2E.mjs. This suite proves the real UI drives them, and that
// nothing here reopens a room, resolves a reason or ranks a player by itself.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4018;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m18live-'));

// Copy that would turn either system into a judgement of the club's decision
// or of the player.
const FORBIDDEN = /decision was wrong|should have signed|you were wrong|missed talent|talent score|player score|signing probability|probability of success|best available|should recruit/i;

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A backend left behind by a crashed earlier run would answer on this port and
// hand the suite a different run's rooms and decisions — which reads as a
// product bug rather than a dirty machine. Refuse to start instead.
const portFree = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(API_PORT, '127.0.0.1');
});
if (!portFree) {
  console.error(`✗ port ${API_PORT} is already in use — a stale backend is running. Kill it and re-run.`);
  process.exit(1);
}

console.log('building live bundles for :4018…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live18`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live18`, { cwd: path.join(ROOT, 'scoutbox-grassroots'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
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
serveDir('scoutbox-club/dist-live18', 8802);
serveDir('scoutbox-grassroots/dist-live18', 8803);
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

// The API is used for two things only: arranging the world outside this
// club's UI (evidence arriving, a player blocking an org) and checking the
// server's own truth behind an assertion the UI makes.
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
const ctxRival = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const ctxGrass = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

async function enterClub(ctx, base, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  await page.goto(base);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}
// Pro and Grassroots keep their sessions under their own storage keys.
const tokenOf = (page, key = 'scoutbox-club-session') => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem(k) ?? 'null')?.token ?? null; } catch { return null; }
}, key);
async function goto(page, hash, selector) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  if (selector) await page.waitForSelector(selector, { timeout: 20000 });
  await page.waitForTimeout(500);
}
const SL = '#/recruitment/second-look';
const NM = '#/recruitment/nobody-missed';

const scout = await enterClub(ctxA, 'http://localhost:8802/', 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
const MARIA = await tokenOf(scout);
const players = (await j('GET', '/org/players', undefined, MARIA)).body;
const ALONSO = players.find((p) => /Kola Adeyemi/.test(p.name));
if (!ALONSO) fail('fixture: the seeded discovery player is missing');

// ===================================================================== M1
// The whole point of Second Look, driven end to end through the UI.
await goto(scout, '#/search');
await scout.waitForSelector(`.player-card:has-text("${ALONSO.name}")`, { timeout: 25000 });
await scout.click(`.player-card:has-text("${ALONSO.name}")`);
await scout.waitForSelector('.drawer', { timeout: 15000 });
await scout.click('button:has-text("Add to Recruitment Room")');
await scout.waitForSelector('[aria-label="Room header"]', { timeout: 20000 });
const ROOM_HASH = await scout.evaluate(() => location.hash);
const ROOM_ID = ROOM_HASH.split('/').pop();
say('M1: the scout opens a Recruitment Room from Discover');

await scout.selectOption('[aria-label="Move to"]', 'under_review');
await scout.click('button:has-text("Apply")');
await scout.waitForTimeout(700);
await scout.selectOption('[aria-label="Move to"]', 'archived');
await scout.waitForTimeout(400);
await scout.check('input[type="checkbox"][aria-label="Not enough recent evidence"]');
await scout.click('button:has-text("Apply")');
await scout.waitForTimeout(1000);
{
  const badges = await scout.locator('[aria-label="Room header"] .badges').innerText();
  if (!/Archived/i.test(badges)) fail('M1: the room did not archive with its structured reason');
  say('M1: the room is archived for "not enough recent evidence"');
}

// Nothing has changed yet, so there is nothing to look at again.
await goto(scout, SL, '[aria-label="Second Look items"]');
{
  const body = await scout.locator('body').innerText();
  if (!/Worth Another Look \(0\)/.test(body)) fail('M1: an item existed before any change arrived');
  say('M1: with no new evidence the queue is empty');
  if (!/does not judge that decision/i.test(body)) fail('M1: the queue does not carry its disclaimer');
  say('M1: the queue states it does not judge the decision');
}

// A full match arrives from outside this club's workflow.
await j('POST', `/org/players/${ALONSO.id}/evidence`, { claimType: 'footage', label: 'Full match vs Riverton' }, MARIA);
await goto(scout, '#/home');
await goto(scout, SL, `[aria-label="Second Look item: ${ALONSO.name}"]`);
{
  const card = scout.locator(`[aria-label="Second Look item: ${ALONSO.name}"]`);
  const cards = await card.count();
  if (cards !== 1) fail(`M1: one change produced ${cards} cards for one player`);
  say('M1: one change, one item — not one alert per historical room');
  const text = await card.innerText();
  if (!/Worth Another Look/.test(await scout.locator('body').innerText())) fail('M1: the Worth Another Look tab is missing');
  if (!/Not enough recent evidence/.test(text)) fail('M1: the card does not state the reason recorded at the time');
  say('M1: the item names the reason this club recorded, not a verdict on it');
  if (!/relates to the reason recorded/i.test(text)) fail('M1: the card does not explain the relationship to the reason');
  say('M1: the card explains how the change relates to that reason');
  if (FORBIDDEN.test(text)) fail(`M1: prohibited language on the Second Look card`);
  say('M1: nothing on the card says the decision was wrong or scores the player');
  const room = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
  if (room.status !== 'archived') fail(`M1: reading Second Look changed the room to ${room.status}`);
  say('M1: reading the queue did not reopen the room — it is still archived');
}

await scout.click(`[aria-label="Second Look item: ${ALONSO.name}"] button:has-text("Review changes")`);
await scout.waitForSelector('[aria-label="Comparison with your previous review"]', { timeout: 15000 });
{
  const cmp = await scout.locator('[aria-label="Comparison with your previous review"]').innerText();
  if (!/At your previous review vs now/i.test(await scout.locator('body').innerText())) fail('M1: the comparison has no heading');
  if (!/Evidence items/.test(cmp)) fail('M1: the comparison shows no evidence row');
  say('M1: Review Changes shows the recorded before and after');
  if (FORBIDDEN.test(cmp)) fail('M1: prohibited language in the comparison');
  say('M1: the comparison judges nothing');
}
await scout.click('button:has-text("Back to Second Look")');
await scout.waitForSelector('[aria-label="Second Look items"]', { timeout: 15000 });

// The reopen is a click, never an inference.
await scout.click(`[aria-label="Second Look item: ${ALONSO.name}"] button:has-text("Reopen room")`);
await scout.waitForSelector('[aria-label="Reopen this room"]', { timeout: 10000 });
{
  const panel = await scout.locator('[aria-label="Reopen this room"]').innerText();
  if (!/only ever reopens because you clicked/i.test(panel)) fail('M1: the reopen panel does not state that nothing reopens by itself');
  say('M1: the reopen panel states ScoutBox never reopens a room for you');
}
await scout.click('[aria-label="Reopen this room"] button:has-text("Reopen room")');
await scout.waitForTimeout(1400);
{
  const room = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
  if (room.status !== 'under_review') fail(`M1: the room did not reopen (status ${room.status})`);
  if (room.sourceContext !== 'second_look') fail(`M1: the reopen recorded source ${room.sourceContext}`);
  say('M1: the room reopens through M17 and records second_look as the source');
  const history = (await j('GET', `/org/rooms/${ROOM_ID}/decisions`, undefined, MARIA)).body.history ?? [];
  if (!history.some((d) => (d.reasonCodes ?? []).includes('insufficient_recent_evidence'))) fail('M1: the original archive decision was lost');
  say('M1: the archived decision still stands in the room’s history');
  const acts = (await j('GET', `/org/rooms/${ROOM_ID}/activity`, undefined, MARIA)).body.items ?? [];
  if (!acts.some((a) => a.type === 'room_reopened')) fail('M1: the reopen is not on the room timeline');
  say('M1: the reopen is on the room activity timeline');
}

// ===================================================================== M2
// A second player, archived for BOTH an evidence reason and a club-side one.
const OTHER = players.find((p) => p.id !== ALONSO.id && p.name);
const roomB = (await j('POST', '/org/rooms', { playerId: OTHER.id }, MARIA)).body.room;
await j('POST', `/org/rooms/${roomB.roomId}/status`, { status: 'under_review' }, MARIA);
await j('POST', `/org/rooms/${roomB.roomId}/status`, { status: 'archived', reasonCodes: ['insufficient_recent_evidence', 'squad_space'] }, MARIA);
await j('POST', `/org/players/${OTHER.id}/evidence`, { claimType: 'footage', label: 'Full match vs Eastfield' }, MARIA);
await goto(scout, '#/home');
await goto(scout, SL, `[aria-label="Second Look item: ${OTHER.name}"]`);
{
  const card = await scout.locator(`[aria-label="Second Look item: ${OTHER.name}"]`).innerText();
  if (!/Reasons that still stand/.test(card)) fail('M2: the club-side reason is not reported as still standing');
  if (!/Squad space/i.test(card)) fail('M2: squad space is missing from the reasons that still stand');
  say('M2: the club-side reason is printed as still standing, not as resolved');
  if (!/facts about your club/i.test(card)) fail('M2: the card does not explain why those reasons cannot be resolved');
  say('M2: the card explains that no player evidence can resolve them');
  if (/resolved|no longer applies|answered/i.test(card.replace(/Reasons that still stand[\s\S]*?(?=New since|$)/i, ''))) {
    fail('M2: the card claims a reason was resolved');
  }
  say('M2: nothing on the card claims a recorded reason was resolved');
}

// ===================================================================== M3
await scout.click(`[aria-label="Second Look item: ${OTHER.name}"] button:has-text("Dismiss")`);
await scout.waitForSelector('[aria-label="Dismiss this item"]', { timeout: 10000 });
await scout.selectOption('[aria-label="Dismiss this item"] select', 'change_not_material').catch(() => {});
await scout.click('[aria-label="Dismiss this item"] button:has-text("Dismiss item")');
await scout.waitForTimeout(1200);
{
  // A full reload, not a re-render: the dismissal has to be server state.
  await scout.goto(`http://localhost:8802/${SL}`);
  await scout.waitForSelector('[aria-label="Second Look items"]', { timeout: 25000 });
  await scout.waitForTimeout(800);
  const body = await scout.locator('body').innerText();
  if (new RegExp(`Second Look item: ${OTHER.name}`).test(await scout.locator('body').innerHTML())) {
    if (!/Dismissed \(1\)/.test(body)) fail('M3: the dismissed item is neither hidden nor in the Dismissed tab');
  }
  if (!/Dismissed \(1\)/.test(body)) fail('M3: the dismissal did not survive a reload');
  say('M3: the dismissal survives a full page reload');
  if (!/Worth Another Look \(0\)/.test(body)) fail('M3: the dismissed item is still in the open queue');
  say('M3: the dismissed item leaves the open queue');
}
{
  // Re-read the queue repeatedly, and read the two projections that carry the
  // SAME full match, and it must still not come back.
  for (let i = 0; i < 3; i++) {
    await goto(scout, '#/home');
    await goto(scout, SL, '[aria-label="Second Look items"]');
    const body = await scout.locator('body').innerText();
    if (!/Worth Another Look \(0\)/.test(body)) fail(`M3: re-read ${i + 1} regenerated the dismissed item`);
  }
  say('M3: three re-reads of the queue do not regenerate the item');
  await j('GET', `/org/players/${OTHER.id}/football-passport`, undefined, MARIA);
  await j('GET', `/org/players/${OTHER.id}/trust-profile`, undefined, MARIA);
  await goto(scout, '#/home');
  await goto(scout, SL, '[aria-label="Second Look items"]');
  if (!/Worth Another Look \(0\)/.test(await scout.locator('body').innerText())) {
    fail('M3: the Passport and Trust projections resurfaced the same evidence');
  }
  say('M3: the same evidence seen through the Passport and Trust does not resurface it');
  const dismissed = (await j('GET', '/org/second-look?status=dismissed', undefined, MARIA)).body;
  if (dismissed.total !== 1) fail('M3: the dismissed item is no longer listable');
  say('M3: the dismissed item remains listable in its own tab');
}

// ===================================================================== M4
await sleep(10);
await j('POST', `/org/players/${OTHER.id}/evidence`, { claimType: 'footage', label: 'Later full match vs Harbour' }, MARIA);
await goto(scout, '#/home');
await goto(scout, SL, '[aria-label="Second Look items"]');
{
  const body = await scout.locator('body').innerText();
  if (!/Worth Another Look \(1\)/.test(body)) fail('M4: a genuinely different later full match did not resurface the item');
  say('M4: genuinely different later evidence surfaces the item again');
  const card = await scout.locator(`[aria-label="Second Look item: ${OTHER.name}"]`).innerText();
  if (!/Full match vs Eastfield|Later full match vs Harbour|full match/i.test(card)) fail('M4: the card does not list what changed');
  const items = (await j('GET', '/org/second-look', undefined, MARIA)).body.items ?? [];
  const it = items.find((x) => x.playerId === OTHER.id);
  if (!it || it.changeCount !== 2) fail(`M4: both full matches did not group into one item (changeCount=${it?.changeCount})`);
  say('M4: both full matches group into ONE item, not two alerts');
}

// ===================================================================== M5
await goto(scout, '#/briefs', '[aria-label="Recruitment briefs"]');
{
  const body = await scout.locator('body').innerText();
  if (!/no hidden criteria/i.test(body)) fail('M5: the briefs screen does not state there are no hidden criteria');
  say('M5: the briefs screen states there are no hidden criteria, weights or ranking');
}
await scout.click('button:has-text("New brief")');
await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 10000 });
await scout.fill('[aria-label="Title"]', '2027 Defensive Midfielder');
for (const pos of ['CDM', 'CM']) {
  await scout.evaluate((code) => {
    const label = [...document.querySelectorAll('fieldset label')].find((l) => l.textContent.trim() === code);
    label?.querySelector('input')?.click();
  }, pos);
}
await scout.fill('[aria-label="Minimum age"]', '16');
await scout.fill('[aria-label="Maximum age"]', '30');
await scout.click('[aria-label="Recruitment brief criteria"] button:has-text("Create")');
await scout.waitForTimeout(1200);
{
  const body = await scout.locator('[aria-label="Recruitment briefs"]').innerText();
  if (!/2027 Defensive Midfielder/.test(body)) fail('M5: the brief was not created');
  if (!/Draft/.test(body) || !/v1/.test(body)) fail('M5: a new brief is not a draft at version 1');
  say('M5: the brief is written by the club and starts as a draft at v1');
}
await scout.click('button[aria-label="Open 2027 Defensive Midfielder"]');
await scout.waitForSelector('[aria-label="Recruitment brief"]', { timeout: 15000 });
{
  const hash = await scout.evaluate(() => location.hash);
  if (!/^#\/recruitment\/briefs\/[A-Za-z0-9_-]+$/.test(hash)) fail(`M5: the brief has no deep link (${hash})`);
  say('M5: the brief has its own deep link');
}
await scout.click('[aria-label="Recruitment brief"] button:has-text("Activate")');
await scout.waitForTimeout(1200);
const BRIEF_ID = (await scout.evaluate(() => location.hash)).split('/').pop();
{
  const brief = (await j('GET', `/org/recruitment-briefs/${BRIEF_ID}`, undefined, MARIA)).body.brief;
  if (brief.status !== 'active') fail(`M5: the brief did not activate (${brief.status})`);
  say('M5: the brief is active');
}

await goto(scout, NM, '[aria-label="Evaluation Coverage"]');
const readCoverage = async () => {
  const vals = await scout.locator('[aria-label="Evaluation Coverage"] .stat .v').allInnerTexts();
  return { eligible: Number(vals[0]), evaluated: Number(vals[1]), notYet: Number(vals[2]), percent: vals[3] };
};
let cov = await readCoverage();
{
  const panel = await scout.locator('[aria-label="Evaluation Coverage"]').innerText();
  if (!/Evaluation Coverage/.test(panel)) fail('M5: the coverage panel is not called Evaluation Coverage');
  if (/Scout Quality|Recruitment Quality|Scouting Score|Fairness Score/i.test(await scout.locator('body').innerText())) {
    fail('M5: coverage is renamed as a quality score somewhere on the page');
  }
  say('M5: it is Evaluation Coverage — never a scouting or quality score');
  if (!/not a measure of scouting quality/i.test(panel)) fail('M5: the coverage panel does not say what it is not');
  say('M5: the panel states it measures workflow coverage, not quality, talent or bias');
  if (!Number.isFinite(cov.eligible) || cov.eligible !== cov.evaluated + cov.notYet) {
    fail(`M5: coverage arithmetic does not hold (${cov.eligible} ≠ ${cov.evaluated} + ${cov.notYet})`);
  }
  say(`M5: coverage is arithmetic over a declared denominator (${cov.eligible} = ${cov.evaluated} + ${cov.notYet}, ${cov.percent})`);
}
const queue = (await j('GET', `/org/nobody-missed?briefId=${BRIEF_ID}`, undefined, MARIA)).body;
const CAND = queue.items?.[0];
if (!CAND) fail('M5: the fixture produced no Nobody Missed candidate');
{
  const card = await scout.locator(`[aria-label="Candidate: ${CAND.name}"]`).innerText();
  if (!/Why shown/.test(card)) fail('M5: the candidate cannot say why it is here');
  if (!/met/.test(card)) fail('M5: the candidate explanation has no met/not met reasons');
  say('M5: every candidate answers "why is this player here?" with the club’s own criteria');
  if (FORBIDDEN.test(card)) fail('M5: prohibited scoring language on a candidate card');
  const html = await scout.locator('[aria-label="Candidates under this brief"]').innerHTML();
  if (/matchScore|rankScore|"rank"|ranked #/i.test(html)) fail('M5: a hidden ranking score reached the candidate list');
  say('M5: no score, rank or weight appears anywhere in the candidate list');
  if (!/Ordering is a convenience/i.test(await scout.locator('body').innerText())) fail('M5: the ordering note is missing');
  say('M5: the ordering is stated to be a convenience, not a quality rank');
}

await scout.click(`[aria-label="Candidate: ${CAND.name}"] button:has-text("Add to room")`);
await scout.waitForSelector('[aria-label="Room header"]', { timeout: 20000 });
const CAND_ROOM = (await scout.evaluate(() => location.hash)).split('/').pop();
{
  const room = (await j('GET', `/org/rooms/${CAND_ROOM}`, undefined, MARIA)).body.room;
  if (room.sourceContext !== 'nobody_missed') fail(`M5: the room recorded source ${room.sourceContext}`);
  say('M5: Add to Room creates a canonical M17 Room with source nobody_missed');
}
await goto(scout, NM, '[aria-label="Evaluation Coverage"]');
{
  const after = await readCoverage();
  if (after.evaluated !== cov.evaluated + 1) fail(`M5: coverage did not update (${cov.evaluated} → ${after.evaluated})`);
  if (after.eligible !== cov.eligible) fail('M5: the denominator moved when a player entered the workflow');
  say(`M5: coverage updates — evaluated ${cov.evaluated} → ${after.evaluated} over the same denominator`);
  const html = await scout.locator('body').innerHTML();
  if (html.includes(`Candidate: ${CAND.name}`)) fail('M5: the candidate is still in the queue after entering a room');
  say('M5: the candidate leaves the queue immediately');
  cov = after;
}

// ===================================================================== M6
{
  const html = await scout.locator('body').innerHTML();
  if (html.includes(`Candidate: ${ALONSO.name}`)) fail('M6: a player with an open room is offered as never evaluated');
  say('M6: the player whose room this club reopened is not a Nobody Missed candidate');
}

// ===================================================================== M7
await goto(scout, `#/recruitment/rooms/${CAND_ROOM}`, '[aria-label="Room header"]');
await scout.selectOption('[aria-label="Move to"]', 'under_review');
await scout.click('button:has-text("Apply")');
await scout.waitForTimeout(700);
await scout.selectOption('[aria-label="Move to"]', 'archived');
await scout.waitForTimeout(400);
await scout.check('input[type="checkbox"][aria-label="Not enough recent evidence"]');
await scout.click('button:has-text("Apply")');
await scout.waitForTimeout(1100);
await goto(scout, NM, '[aria-label="Evaluation Coverage"]');
{
  const html = await scout.locator('body').innerHTML();
  if (html.includes(`Candidate: ${CAND.name}`)) fail('M7: an archived player fell straight back into Nobody Missed');
  say('M7: archiving does not push an evaluated player back into Nobody Missed');
  const after = await readCoverage();
  if (after.evaluated !== cov.evaluated) fail(`M7: the archive changed the evaluated count (${cov.evaluated} → ${after.evaluated})`);
  say('M7: they remain counted as evaluated — they were evaluated');
}
await j('POST', `/org/players/${CAND.playerId}/evidence`, { claimType: 'footage', label: 'Full match after the decision' }, MARIA);
await goto(scout, '#/home');
await goto(scout, SL, '[aria-label="Second Look items"]');
{
  const html = await scout.locator('body').innerHTML();
  if (!html.includes(`Second Look item: ${CAND.name}`)) fail('M7: later evidence for an evaluated player did not reach Second Look');
  say('M7: later relevant evidence reaches the club through Second Look instead');
  await goto(scout, NM, '[aria-label="Evaluation Coverage"]');
  if ((await scout.locator('body').innerHTML()).includes(`Candidate: ${CAND.name}`)) {
    fail('M7: the same player is claimed by both queues at once');
  }
  say('M7: the two queues never claim the same player at the same time');
}

// ===================================================================== M8
const rival = await enterClub(ctxRival, 'http://localhost:8802/', 'Harbour City FC', 'Rita Vale', 'Head of Recruitment');
const RITA = await tokenOf(rival);
{
  await goto(rival, SL, '[aria-label="Second Look items"]');
  const body = await rival.locator('body').innerText();
  if (new RegExp(`${ALONSO.name}|${OTHER.name}`).test(body)) fail('M8: the rival club sees another club’s Second Look items');
  if (!/Worth Another Look \(0\)/.test(body)) fail('M8: the rival club’s queue is not its own');
  say('M8: the rival club’s Second Look queue contains none of the first club’s items');

  await goto(rival, `#/recruitment/briefs/${BRIEF_ID}`);
  await rival.waitForTimeout(1500);
  if (/2027 Defensive Midfielder/.test(await rival.locator('body').innerText())) fail('M8: a deep link exposed another club’s brief');
  say('M8: a deep link to another club’s brief reveals nothing — not even that it exists');

  await goto(rival, NM);
  await rival.waitForTimeout(1200);
  if (/2027 Defensive Midfielder/.test(await rival.locator('body').innerText())) fail('M8: another club’s brief appears in the rival’s picker');
  say('M8: the rival club’s brief picker contains none of the first club’s briefs');

  const item = (await j('GET', '/org/second-look', undefined, MARIA)).body.items[0];
  const probes = [
    ['brief', `/org/recruitment-briefs/${BRIEF_ID}`],
    ['Second Look item', `/org/second-look/${item.id}`],
    ['coverage for that brief', `/org/nobody-missed?briefId=${BRIEF_ID}`],
    ['the room behind it', `/org/rooms/${ROOM_ID}`],
  ];
  for (const [what, url] of probes) {
    const r = await j('GET', url, undefined, RITA);
    if (r.status !== 404) fail(`M8: the rival club read the ${what} with ${r.status}`);
  }
  say('M8: brief, item, coverage and room all answer the rival club with the same 404');
  // The whole-organisation coverage endpoint answers every club — with its
  // OWN briefs. Naming a foreign brief in the query changes nothing.
  const cov2 = await j('GET', `/org/evaluation-coverage?briefId=${BRIEF_ID}`, undefined, RITA);
  if (cov2.status !== 200) fail(`M8: the rival club cannot read its own coverage (${cov2.status})`);
  if ((cov2.body.items ?? []).some((i) => i.briefId === BRIEF_ID || /2027 Defensive Midfielder/.test(i.title ?? ''))) {
    fail('M8: the rival club’s coverage includes another club’s brief');
  }
  say('M8: naming a foreign brief in the coverage query yields only the caller’s own briefs');
}

// ===================================================================== M9
{
  const before = (await j('GET', '/org/second-look', undefined, MARIA)).body;
  if (!before.items.some((i) => i.playerId === OTHER.id)) fail('M9: fixture — the player to block has no open item');
  const pl = (await j('POST', '/auth/player/login', { playerId: OTHER.id })).body;
  if (!pl?.token) fail('M9: could not sign in as the player to block');
  const blocked = await j('POST', '/player/block', { orgId: 'org-eastport' }, pl.token);
  if (![200, 201].includes(blocked.status)) fail(`M9: the block was refused (${blocked.status})`);

  await goto(scout, '#/home');
  await goto(scout, SL, '[aria-label="Second Look items"]');
  const html = await scout.locator('body').innerHTML();
  if (html.includes(`Second Look item: ${OTHER.name}`)) fail('M9: a blocked player is still in the Second Look queue');
  say('M9: a block removes the player from Second Look on the very next read');
  await goto(scout, NM, '[aria-label="Evaluation Coverage"]');
  if ((await scout.locator('body').innerHTML()).includes(`Candidate: ${OTHER.name}`)) {
    fail('M9: a blocked player is still a Nobody Missed candidate');
  }
  say('M9: the blocked player is gone from Nobody Missed too — nothing was cached');
}

// ==================================================================== M10
const dee = await enterClub(ctxGrass, 'http://localhost:8803/', 'Hackney Marsh', 'Dee Mensah', 'Manager');
const DEE = await tokenOf(dee, 'scoutbox-grassroots-session');
if (!DEE) fail('M10: the grassroots session token was not readable');
await goto(dee, '#/briefs', '[aria-label="Recruitment briefs"]');
await dee.click('button:has-text("New brief")');
await dee.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 10000 });
{
  const form = await dee.locator('[aria-label="Recruitment brief criteria"]').innerText();
  if (!/50 km and semi-pro/i.test(form)) fail('M10: the grassroots brief form does not state the standing ceilings');
  say('M10: the grassroots form states the 50 km and semi-pro ceilings');
  const levels = await dee.locator('[aria-label="Up to level"] option').allInnerTexts();
  if (levels.some((l) => /^pro$/i.test(l.trim()))) fail('M10: the grassroots form offers a professional level');
  say('M10: the grassroots form offers no professional level at all');
  const max = await dee.locator('[aria-label="Radius (km)"]').getAttribute('max');
  if (max !== '50') fail(`M10: the grassroots radius input is not capped (max=${max})`);
  say('M10: the grassroots radius input is capped at 50 km');
  if (/Standardized Combine requirement/i.test(form)) fail('M10: the grassroots brief offers the Pro-only Combine criterion');
  say('M10: the grassroots brief stays simpler — no standardized-Combine criterion');
}
await dee.fill('[aria-label="Title"]', 'Local defensive midfielder');
await dee.evaluate(() => {
  const label = [...document.querySelectorAll('fieldset label')].find((l) => l.textContent.trim() === 'CDM');
  label?.querySelector('input')?.click();
});
await dee.fill('[aria-label="Radius (km)"]', '500');
await dee.click('[aria-label="Recruitment brief criteria"] button:has-text("Create")');
await dee.waitForTimeout(1300);
{
  const briefs = (await j('GET', '/org/recruitment-briefs', undefined, DEE)).body.items ?? [];
  const gb = briefs.find((b) => /Local defensive midfielder/.test(b.title));
  if (!gb) fail('M10: the grassroots brief was not created');
  if (gb.criteria.radiusKm !== 50) fail(`M10: the grassroots brief kept a ${gb.criteria.radiusKm} km radius`);
  if (gb.criteria.maxLevel && gb.criteria.maxLevel !== 'semi_pro') fail(`M10: the grassroots brief reached ${gb.criteria.maxLevel}`);
  say('M10: a 500 km entry is held at the standing 50 km ceiling by the server, not by the form alone');

  await j('PATCH', `/org/recruitment-briefs/${gb.id}`, { status: 'active' }, DEE);
  await goto(dee, NM);
  await dee.waitForTimeout(1500);
  const q = (await j('GET', `/org/nobody-missed?briefId=${gb.id}`, undefined, DEE)).body;
  const visible = (await j('GET', '/org/players', undefined, DEE)).body.map((p) => p.id);
  const leaked = (q.items ?? []).filter((c) => !visible.includes(c.playerId));
  if (leaked.length) fail(`M10: ${leaked.length} candidate(s) were matched that this club cannot see`);
  say('M10: every grassroots candidate passed the visibility gates before matching');
  if ((q.items ?? []).some((c) => !c.reasons?.length)) fail('M10: a grassroots candidate cannot explain itself');
  say('M10: grassroots candidates carry the same per-criterion explanation');

  // A Brief is not an authorization bypass: a player this club cannot see can
  // never be added to a room through the queue.
  const hidden = players.find((p) => !visible.includes(p.id));
  if (hidden) {
    const r = await j('POST', '/org/nobody-missed/add-to-room', { briefId: gb.id, playerId: hidden.id }, DEE);
    if (![403, 404].includes(r.status)) fail(`M10: a hidden player was added to a grassroots room (${r.status})`);
    say('M10: a player outside this club’s visibility cannot be added to a room through the brief');
  } else {
    say('M10: every seeded player is visible to this grassroots club — no hidden-player case to drive');
  }
  const body = await dee.locator('body').innerText();
  if (FORBIDDEN.test(body)) fail('M10: prohibited language in the grassroots app');
  say('M10: the grassroots surfaces carry no score, rank or verdict either');
}

// ------------------------------------------ the player never sees any of it
{
  const pl = (await j('POST', '/auth/player/login', { playerId: ALONSO.id })).body;
  for (const url of ['/org/second-look', '/org/recruitment-briefs', `/org/nobody-missed?briefId=${BRIEF_ID}`]) {
    const r = await j('GET', url, undefined, pl.token);
    if (![401, 403].includes(r.status)) fail(`M18: a player token reached ${url} with ${r.status}`);
  }
  say('the player’s own token reaches none of the M18 APIs');
}

await browser.close();
console.log(`\nm18Live: ${passed} checks passed — Second Look and Nobody Missed journeys complete`);
process.exit(0);
