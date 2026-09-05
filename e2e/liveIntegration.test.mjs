// LIVE integration E2E — the connected system, no demo bus, no shared
// localStorage. Each party runs in its OWN Playwright browser context against
// one real backend on an isolated database:
//   A. ScoutBox Pro ↔ adult player: request → accept → two-way messages,
//      numeric unread badges, read receipts — all pushed over authenticated SSE.
//   B. ScoutBox Grassroots ↔ eligible local adult: the same complete flow.
//   C. Pro club ↔ guardian of a minor: guardian-routed, child never a party.
//   D. Refresh keeps server truth; backend outage shows a recoverable error.
// Run: node liveIntegration.test.mjs   (builds live bundles first — ~2 min)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4001;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-live-'));
const say = (m) => console.log(m);

// ---- 1. build the LIVE bundles (explicitly pointed at the test backend)
const build = (dir, cmd) => execSync(cmd, { cwd: path.join(ROOT, dir), stdio: 'pipe', env: { ...process.env } });
say('building live bundles…');
build('scoutbox-club', `VITE_API_URL=${API} npx vite build --outDir dist-live`);
build('scoutbox-grassroots', `VITE_API_URL=${API} npx vite build --outDir dist-live`);
build('scoutbox-player', `EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live`);
say('live bundles built');

// ---- 2. isolated backend + static hosts (SPA fallback)
const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const idx = path.join(file, 'index.html');
      file = fs.existsSync(idx) ? idx : path.join(root, 'index.html'); // SPA fallback
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(port);
  statics.push(srv);
}
serveDir('scoutbox-player/dist-live', 8281);
serveDir('scoutbox-club/dist-live', 8282);
serveDir('scoutbox-grassroots/dist-live', 8283);

function cleanup() {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 250));
}
say(`backend up on :${API_PORT} (isolated db: ${DATA})`);

const browser = await chromium.launch({ executablePath: EXE });
// SEPARATE CONTEXTS: nothing is shared between the parties — no localStorage,
// no demo bus. Everything below travels through the backend.
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxPlayer = await browser.newContext({ viewport: { width: 420, height: 880 } });
const ctxGrass = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxGuardian = await browser.newContext({ viewport: { width: 420, height: 880 } });

// ---------- helpers
async function loginPortal(page, host, orgName, userName) {
  await page.goto(host);
  await page.click(`.org-card:has-text("${orgName}")`);
  await page.fill('.enter-row input', userName);
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('.topbar', { timeout: 20000 });
}
async function portalRequestContact(page, playerName, message, minor = false) {
  await page.click('nav.sidebar button:has-text("Search")');
  await page.waitForSelector('.player-card:not(.skeleton)', { timeout: 20000 });
  await page.click(`.player-card:has-text("${playerName}")`);
  await page.waitForSelector('.drawer h3', { timeout: 10000 });
  await page.click(`.drawer button:has-text("${minor ? 'Contact Guardian' : 'Request contact'}")`);
  await page.fill('.drawer input[placeholder^="Message to"]', message);
  await page.click('.drawer button:has-text("Send")');
  await page.click('.drawer button:has-text("Close")');
}
async function portalOpenThread(page, playerName) {
  await page.click('nav.sidebar button:has-text("Messages")');
  await page.click(`.list-row:has-text("${playerName}")`);
}
async function portalSend(page, text) {
  await page.fill('input[placeholder="Write a message (moderated — no personal contact details)"]', text);
  await page.keyboard.press('Enter');
}

// ================= A. ScoutBox Pro ↔ adult player =================
const club = await ctxClub.newPage();
await loginPortal(club, 'http://localhost:8282/', 'Eastport FC', 'Maria Keane');
say('A: Pro portal logged in (Eastport FC — separate context)');
await portalRequestContact(club, 'Kola Adeyemi', 'Our first-team coach would like a word.');
say('A: contact request sent through the real API');

const player = await ctxPlayer.newPage();
await player.goto('http://localhost:8281/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click(); // Kola (dev login, live server)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/inbox"]');
await player.waitForSelector('text=Eastport FC', { timeout: 15000 });
await player.click('text=Accept contact');
await player.waitForSelector('text=channel open', { timeout: 10000 });
say('A: player received the request in his own context and accepted');

// club → player message (arrives over the player's authenticated SSE stream)
await portalOpenThread(club, 'Kola Adeyemi');
await portalSend(club, 'Thursday 6pm at the training ground?');
await player.getByText('Open', { exact: true }).first().click();
await player.waitForSelector('text=Thursday 6pm at the training ground?', { timeout: 15000 });
say('A: club → player message delivered live');

// player → club reply; unread badge counts on the Pro sidebar
await player.fill('input[placeholder="Write a message (no personal contact details)"]', 'Works for me — see you there.');
await player.keyboard.press('Enter');
await club.waitForSelector('text=Works for me — see you there.', { timeout: 15000 });
say('A: player → club reply delivered live');

// a second thread's unread badge: send another player message while club is elsewhere
await club.click('nav.sidebar button:has-text("Search")'); // navigate away
await player.fill('input[placeholder="Write a message (no personal contact details)"]', 'One more thing — boots or trainers?');
await player.keyboard.press('Enter');
await club.waitForSelector('nav.sidebar .nav-badge', { timeout: 15000 });
const badge = await club.locator('nav.sidebar .nav-badge').innerText();
if (!/^\d+$/.test(badge) || Number(badge) < 1) { console.error(`✗ unread badge not numeric: ${badge}`); process.exit(1); }
say(`A: numeric unread badge on the Pro sidebar (${badge})`);
await portalOpenThread(club, 'Kola Adeyemi'); // opening reads the thread
await club.waitForSelector('text=boots or trainers', { timeout: 10000 });
await club.waitForSelector('nav.sidebar .nav-badge', { state: 'detached', timeout: 15000 });
say('A: opening the thread clears the badge (read state persisted per channel)');
// read receipt reaches the player
await player.waitForSelector('text=✓✓ read', { timeout: 15000 });
say('A: player sees the ✓✓ read receipt');

// ================= B. Grassroots ↔ eligible local adult =================
const grass = await ctxGrass.newPage();
await loginPortal(grass, 'http://localhost:8283/', 'Moss Side Athletic', 'Pat Doyle');
say('B: Grassroots portal logged in (Moss Side — separate context)');
await portalRequestContact(grass, 'Kola Adeyemi', 'First-team spot this season if you fancy it.');
await player.click('a[href="/inbox"]');
await player.waitForSelector('text=Moss Side Athletic', { timeout: 15000 });
await player.locator('text=Accept contact').first().click();
await player.waitForSelector('text=channel open', { timeout: 10000 });
await portalOpenThread(grass, 'Kola Adeyemi');
await portalSend(grass, 'Training is Tuesdays and Thursdays.');
// RN-web renders buttons as divs — use text locators, and pick the Moss
// thread (second in creation order) from the two now open.
await player.getByText('Back', { exact: true }).first().click().catch(() => {});
await player.getByText('Open', { exact: true }).nth(1).click();
await player.waitForSelector('text=Training is Tuesdays and Thursdays.', { timeout: 15000 });
await player.fill('input[placeholder="Write a message (no personal contact details)"]', 'Count me in for Tuesday.');
await player.keyboard.press('Enter');
await grass.waitForSelector('text=Count me in for Tuesday.', { timeout: 15000 });
say('B: Grassroots ↔ player two-way conversation over the same backend');

// ================= C. Pro club ↔ guardian of a minor =================
await portalRequestContact(club, 'Guni Adebayo', 'We would love to talk about our U15 pathway.', true);
say('C: club sent a guardian-routed request for the 14-year-old');
const guardian = await ctxGuardian.newPage();
await guardian.goto('http://localhost:8281/');
await guardian.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await guardian.getByText('Enter', { exact: true }).last().click(); // Amara — always the last demo row
await guardian.waitForSelector('text=Club requests', { timeout: 20000 });
await guardian.waitForSelector('text=Eastport FC', { timeout: 15000 });
await guardian.click('text=Accept conversation');
say('C: the guardian (own context) received and accepted the request');
await guardian.getByText('Open', { exact: true }).first().click();
await guardian.fill('input[placeholder="Write a message (no personal contact details)"]', 'Please send the session details — Amara (Guni\'s mum).');
await guardian.keyboard.press('Enter');
await portalOpenThread(club, 'Guni Adebayo');
await club.waitForSelector("text=Guni's mum", { timeout: 15000 });
await club.waitForSelector('text=thread is with the guardian', { timeout: 5000 });
say('C: guardian ↔ club conversation live; the thread is explicitly with the guardian');

// ================= D. refresh persistence + outage UI =================
await player.goto('http://localhost:8281/');
await player.waitForSelector('text=Your visibility right now', { timeout: 30000 }); // session restored
await player.click('a[href="/inbox"]');
await player.getByText('Open', { exact: true }).first().click();
await player.waitForSelector('text=Thursday 6pm at the training ground?', { timeout: 15000 });
say('D: full reload — session restored, message history intact from the server');

serverProc.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 500));
// A fresh context (no stored session) lands on onboarding, where the
// connection state is surfaced. No mock data, no white screen.
const ctxOutage = await browser.newContext({ viewport: { width: 420, height: 880 } });
const outage = await ctxOutage.newPage();
await outage.goto('http://localhost:8281/');
await outage.waitForSelector("text=Can't reach the ScoutBox backend", { timeout: 30000 });
say('D: backend outage shows an actionable error — no fabricated data, no white screen');

await browser.close();
cleanup();
console.log('\nLIVE INTEGRATION OK — separate contexts, one backend, no demo bus');
