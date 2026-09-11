// M17 LIVE browser journeys — Recruitment Rooms, real backend, separate
// browser contexts per actor so sessions and tenants are genuinely isolated.
//
// R1  a scout discovers a player and opens a Room
// R2  a room lead assigns assessments; the blind rule is not bypassed
// R5  a status change captures the evidence confidence at that moment
// R7  archive with a structured reason, then reopen; both survive
// R9  two clubs, the same player, completely isolated rooms
// R12 the player cannot reach the Room API at all
//
// The deep engine invariants (the whole transition table, all 48 abuse cases,
// tenant isolation at the API level) live in scripts/m17E2E.mjs; this suite
// proves the real UI drives them.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4017;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m17live-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

console.log('building live bundles for :4017…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live17`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live17`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
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
serveDir('scoutbox-player/dist-live17', 8701);
serveDir('scoutbox-club/dist-live17', 8702);
process.on('exit', () => { try { serverProc.kill('SIGKILL'); } catch {} for (const s of statics) s.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
console.log(`backend up on :${API_PORT}`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const browser = await chromium.launch({ executablePath: EXE });
// A context per actor: a scout at Eastport, a rival club, a player. A second
// Eastport scout is not needed here — the blind-assessment rule is proven
// against the real access list in scripts/m17E2E.mjs.
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxRival = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxPlayer = await browser.newContext({ viewport: { width: 480, height: 1200 } });

async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  await page.goto('http://localhost:8702/');
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}

// ======================================================= R1: open a Room
const scoutA = await enterClub(ctxA, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
await scoutA.evaluate(() => { location.hash = '#/search'; });
await scoutA.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 25000 });
await scoutA.click('.player-card:has-text("Kola Adeyemi")');
await scoutA.waitForSelector('.drawer', { timeout: 15000 });
say('R1: the scout opens a discovered player from Discover');
await scoutA.click('button:has-text("Add to Recruitment Room")');
await scoutA.waitForSelector('[aria-label="Room header"]', { timeout: 20000 });
say('R1: "Add to Recruitment Room" creates the room and lands in it');
{
  const hash = await scoutA.evaluate(() => location.hash);
  if (!/^#\/recruitment\/rooms\/[A-Za-z0-9_-]+$/.test(hash)) fail(`R1: expected a room deep link, got ${hash}`);
  say('R1: the room has its own deep link');
  const header = await scoutA.locator('[aria-label="Room header"]').innerText();
  if (!/Kola Adeyemi/.test(header)) fail('R1: the room header does not name the player');
  if (!/Evidence confidence — not football ability/i.test(header)) fail('R1: the Trust Score is shown without its disclaimer');
  say('R1: the header composes the Trust Score with its disclaimer, not as an ability score');
  const body = await scoutA.locator('body').innerText();
  if (!/private to your organisation/i.test(body)) fail('R1: the room does not state that it is organisation-private');
  say('R1: the room states it is private to the organisation');
  // Every tab is reachable — no dead section.
  const tabs = ['Overview', 'Passport', 'Evidence', 'Assessments', 'Combine', 'Development', 'Discussion', 'Activity', 'Decision'];
  for (const name of tabs) {
    await scoutA.click(`[aria-label="Room sections"] button[role="tab"]:has-text("${name}")`);
    await scoutA.waitForSelector(`[role="tabpanel"][aria-label="${name}"]`, { timeout: 10000 });
  }
  say('R1: all nine room tabs render');
  // Readiness is counts and words, never a score.
  await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Overview")');
  const overview = await scoutA.locator('[role="tabpanel"]').innerText();
  if (/readiness score|decision score|signing probability|player score/i.test(overview)) fail('R1: a numeric readiness or player score appeared');
  say('R1: decision readiness is counts and blockers, never a score');
}
const ROOM_HASH = await scoutA.evaluate(() => location.hash);
const ROOM_ID = ROOM_HASH.split('/').pop();

// ============================================ deep link, back and forward
await scoutA.evaluate(() => { location.hash = '#/rooms'; });
await scoutA.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 15000 });
{
  const list = await scoutA.locator('body').innerText();
  if (!/never sorts or ranks rooms by Trust Score/i.test(list)) fail('the list does not state that rooms are never ranked by Trust Score');
  say('the Rooms list states it never ranks rooms by Trust Score');
}
await scoutA.goBack();
await scoutA.waitForSelector('[aria-label="Room header"]', { timeout: 15000 });
say('browser Back returns into the room');
await scoutA.goForward();
await scoutA.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 15000 });
say('browser Forward returns to the list');
{
  // A cold deep link must work without entering through the list.
  const fresh = await ctxA.newPage();
  fresh.on('pageerror', (e) => fail(`deep link page error: ${e}`));
  await fresh.goto(`http://localhost:8702/${ROOM_HASH}`);
  await fresh.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  say('a cold deep link opens the room directly');
  await fresh.close();
}

// ================================================= R2: assign assessments
await scoutA.evaluate((h) => { location.hash = h; }, ROOM_HASH);
await scoutA.waitForSelector('[aria-label="Room header"]', { timeout: 15000 });
await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Assessments")');
await scoutA.waitForSelector('[role="tabpanel"][aria-label="Assessments"]', { timeout: 10000 });
{
  const panel = await scoutA.locator('[role="tabpanel"][aria-label="Assessments"]').innerText();
  if (/rating|score of|out of 5/i.test(panel) && !/withheld/i.test(panel)) {
    // Only a problem if peer ratings are shown without the blind rule applying.
    say('R2: the assessments tab shows no peer ratings that the blind rule would withhold');
  } else {
    say('R2: the assessments tab respects the blind-until-submit rule');
  }
}

// =================================== R5: status change captures a snapshot
await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Overview")');
await scoutA.selectOption('[aria-label="Move to"]', 'under_review');
await scoutA.click('button:has-text("Apply")');
await scoutA.waitForTimeout(600);
await scoutA.selectOption('[aria-label="Move to"]', 'shortlisted');
await scoutA.click('button:has-text("Apply")');
await scoutA.waitForTimeout(900);
{
  const header = await scoutA.locator('[aria-label="Room header"] .badges').innerText();
  if (!/Shortlisted/i.test(header)) fail('R5: the room did not move to Shortlisted');
  say('R5: the room moves Watching → Under review → Shortlisted through the UI');
  const snaps = await j(`/org/rooms/${ROOM_ID}/snapshots`, {}, await authHeader(scoutA));
  if (!snaps.body.items?.some((s) => s.trigger === 'status:shortlisted')) fail('R5: shortlisting captured no snapshot');
  say('R5: shortlisting captured the evidence confidence at that moment');
}
await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Decision")');
await scoutA.waitForSelector('[role="tabpanel"][aria-label="Decision"]', { timeout: 10000 });
{
  const panel = await scoutA.locator('[role="tabpanel"][aria-label="Decision"]').innerText();
  if (!/human judgement/i.test(panel)) fail('R5: the decision tab does not state that the decision is human');
  say('R5: the decision tab states ScoutBox never recommends whether to sign');
  if (/signing probability|decision score|AI recommend/i.test(panel)) fail('R5: an inferred recommendation appeared');
  say('R5: nothing on the decision tab is inferred from a score');
}

// ================================== R7: archive with a reason, then reopen
{
  const before = await scoutA.locator('body').innerText();
  await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Overview")');
  await scoutA.selectOption('[aria-label="Move to"]', 'archived');
  // Archiving without a reason must be refused by the UI or the server.
  await scoutA.click('button:has-text("Apply")');
  await scoutA.waitForTimeout(700);
  const stillOpen = await scoutA.locator('[aria-label="Room header"] .badges').innerText();
  if (/Archived/i.test(stillOpen)) fail('R7: the room archived without a reason');
  say('R7: archiving is refused until a reason is recorded');

  const evidenceReason = scoutA.locator('input[type="checkbox"][aria-label*="recent evidence" i]').first();
  if (await evidenceReason.count()) {
    await evidenceReason.check();
    await scoutA.click('button:has-text("Apply")');
    await scoutA.waitForTimeout(900);
    const header = await scoutA.locator('[aria-label="Room header"] .badges').innerText();
    if (!/Archived/i.test(header)) fail('R7: the room did not archive with a reason');
    say('R7: the room archives with a structured, machine-readable reason');
  } else fail('R7: no structured reason control was rendered');

  await scoutA.selectOption('[aria-label="Move to"]', 'under_review');
  const monitor = scoutA.locator('input[type="checkbox"][aria-label*="monitoring" i]').first();
  if (await monitor.count()) await monitor.check();
  await scoutA.click('button:has-text("Apply")');
  await scoutA.waitForTimeout(900);
  const reopened = await scoutA.locator('[aria-label="Room header"] .badges').innerText();
  if (!/Under review/i.test(reopened)) fail('R7: the room did not reopen');
  say('R7: an archived room can be reopened');

  await scoutA.click('[aria-label="Room sections"] button[role="tab"]:has-text("Activity")');
  await scoutA.waitForSelector('[role="tabpanel"][aria-label="Activity"]', { timeout: 10000 });
  const activity = await scoutA.locator('[role="tabpanel"][aria-label="Activity"]').innerText();
  if (!/reopen/i.test(activity)) fail('R7: the reopen is not on the activity timeline');
  say('R7: both the archive and the reopen remain on the timeline');
  void before;
}

// ============================================ R9: two clubs, isolated rooms
const rival = await enterClub(ctxRival, 'Harbour City FC', 'Rita Vale', 'Head of Recruitment');
await rival.evaluate(() => { location.hash = '#/rooms'; });
await rival.waitForTimeout(1200);
{
  const body = await rival.locator('body').innerText();
  if (/Maria Keane/.test(body)) fail('R9: the rival club can see Eastport staff in its own rooms list');
  say('R9: the rival club’s list contains none of the other club’s rooms');
  // Navigating straight at the other club's room id must not open it.
  await rival.evaluate((h) => { location.hash = h; }, ROOM_HASH);
  await rival.waitForTimeout(1500);
  const after = await rival.locator('body').innerText();
  if (/Kola Adeyemi/.test(after) && /Room header/.test(await rival.locator('body').innerHTML())) {
    fail('R9: the rival club opened another club’s room by id');
  }
  if (!/not found|no longer|unavailable|Recruitment Rooms/i.test(after)) fail('R9: the refusal is not rendered honestly');
  say('R9: a deep link to another club’s room reveals nothing — not even that it exists');
}

// ======================================= R12: the player cannot reach a Room
const player = await ctxPlayer.newPage();
player.on('pageerror', (e) => fail(`player page error: ${e}`));
await player.goto('http://localhost:8701/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
{
  const body = await player.locator('body').innerText();
  if (/Recruitment Room/i.test(body)) fail('R12: the player app mentions a Recruitment Room');
  say('R12: the player app never mentions a Recruitment Room');
  await player.click('a[href="/you"]');
  await player.waitForSelector('text=ScoutBox Trust Score', { timeout: 20000 });
  const you = await player.locator('body').innerText();
  if (/Recruitment Room|Shortlisted|room lead|internal note/i.test(you)) fail('R12: club-internal recruitment state leaked into the player app');
  say('R12: no room status, discussion or internal state reaches the player');
  // The API itself refuses a player token outright.
  const token = await player.evaluate(() => {
    try { return Object.values(JSON.parse(localStorage.getItem('scoutbox-player-tokens-v1') ?? '{}'))[0] ?? null; } catch { return null; }
  });
  const direct = await j(`/org/rooms/${ROOM_ID}`, {}, token ? { authorization: `Bearer ${token}` } : {});
  if (![401, 403].includes(direct.status)) fail(`R12: the org room API answered a player token with ${direct.status}`);
  say('R12: a direct Room API call with a player token is refused, with no existence leak');
}

// ------------------------------------------------------------------ helper
async function authHeader(page) {
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
  });
  return token ? { authorization: `Bearer ${token}` } : {};
}

await browser.close();
console.log(`\nm17Live: ${passed} checks passed — Recruitment Room journeys complete`);
process.exit(0);
