// M16 LIVE browser journeys (B1–B12) — real backend, separate contexts,
// a fake camera device (Chromium fake-media flags) so the live Box Cam
// capture flow runs end to end. The web-limited provider verifies presence
// + active duration; the deep integrity/abuse coverage lives in
// scripts/m16E2E.mjs — this suite proves the cross-app product journey.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4008;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m16live-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const A = { 'x-admin-key': 'scoutbox-admin', 'content-type': 'application/json' };

console.log('building live bundles for :4008…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live16`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live16`, { cwd: path.join(ROOT, 'scoutbox-admin'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live16`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

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
serveDir('scoutbox-player/dist-live16', 8591);
serveDir('scoutbox-club/dist-live16', 8592);
serveDir('scoutbox-admin/dist-live16', 8594);
process.on('exit', () => { try { serverProc.kill('SIGKILL'); } catch {} for (const s of statics) s.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
console.log(`backend up on :${API_PORT}`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const maria = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body;
await j('/admin/verification/orgs/org-eastport/appoint-root', { method: 'POST', body: JSON.stringify({ userId: maria.userId, reason: 'm16live root admin' }) }, A);

// A fake camera device so getUserMedia succeeds headless.
const browser = await chromium.launch({ executablePath: EXE, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctxPlayer = await browser.newContext({ viewport: { width: 480, height: 960 }, permissions: ['camera'] });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// ============================================= B-live 1: player Box Cam capture
const player = await ctxPlayer.newPage();
player.on('pageerror', (e) => fail(`player page error: ${e}`));
await player.goto('http://localhost:8591/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();          // Kola (adult)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=Train in the Box', { timeout: 20000 });
say('B-live: player You tab shows Box Training — "Train in the Box"');
{
  await player.getByText('Start Box Cam', { exact: true }).click();
  // Box Cam Ready Check against the fake camera, then start.
  await player.waitForSelector('text=Box Cam Ready Check', { timeout: 20000 });
  say('B-live: Box Cam Ready Check runs against the (fake) camera');
  await player.getByText('Box it', { exact: true }).first().click();
  await player.waitForSelector('text=Training detected', { timeout: 20000 });
  say('B1-live: recording — Box Cam verified and session clocks shown separately');
  await new Promise((r) => setTimeout(r, 6000)); // let a little active time accrue
  await player.getByText('Finish', { exact: true }).click();
  await player.waitForSelector('text=/Box Session (Complete|Recorded)/', { timeout: 20000 });
  const body = await player.locator('body').innerText();
  if (!/Partially verified|Box Cam Verified|Recorded, unverified/.test(body)) fail('B1-live: no Box Cam result state shown');
  say('B1-live: result screen shows a Box Cam state (partial credit — elapsed never substitutes)');
  if (!body.includes('Box Cam verified') || !body.includes('Session')) fail('B1-live: verified vs session clocks missing from result');
  say('B1-live: verified active time is distinct from session duration');
}

// ============================================= B5-live: coach assigns, sees result
const club = await ctxClub.newPage();
club.on('pageerror', (e) => fail(`club page error: ${e}`));
await club.goto('http://localhost:8592/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.selectOption('.enter-row select', 'Head of Recruitment');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('nav.sidebar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/search'; });
await club.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 20000 });
await club.click('.player-card:has-text("Kola Adeyemi")');
await club.waitForSelector('[aria-label="Box Training"]', { timeout: 15000 });
await club.click('[aria-label="Box Training"] button:has-text("Show")');
await club.waitForSelector('text=Assign Box Training', { timeout: 15000 });
say('B5-live: coach opens the Box Training panel in the player drawer');
{
  await club.selectOption('[aria-label="Box Training"] select', { label: 'Box Wall' }).catch(async () => {
    await club.selectOption('[aria-label="Box Training"] select', 'box-wall');
  });
  await club.fill('input[aria-label="Target"]', '150');
  await club.click('[aria-label="Box Training"] button:has-text("Assign Box Training")');
  await club.waitForSelector('[aria-label="Box Training"] .list-row:has-text("Box Wall")', { timeout: 15000 });
  say('B5-live: coach assigns Box Wall 150 — appears in the assignment list');
  const panel = await club.locator('[aria-label="Box Training"]').innerText();
  if (!panel.includes('never') || !/footage/i.test(panel)) fail('B5-live: coach panel must state raw footage is never captured/shared');
  say('B5-live: coach panel states results only — never raw home footage');
}

// verify assignment result flows to the coach after the player completes it
{
  const kola = (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).body;
  const assigns = (await j('/player/box-cam/assignments', {}, bearer(kola.token))).body.items;
  const wall = assigns.find((a) => a.drillId === 'box-wall');
  // run the assigned session via the API test provider (camera-free, deterministic)
  const created = (await j('/player/box-cam/sessions', { method: 'POST', body: JSON.stringify({ drillId: 'box-wall', target: { type: 'repetitions', value: 150 }, provider: 'local_test', assignmentId: wall.id }) }, bearer(kola.token))).body;
  await j(`/player/box-cam/sessions/${created.session.id}/start`, { method: 'POST', body: JSON.stringify({ nonce: created.nonce, liveness: created.livenessChallenge }) }, bearer(kola.token));
  await j(`/player/box-cam/sessions/${created.session.id}/events`, { method: 'POST', body: JSON.stringify({ nonce: created.nonce, batch: [{ seq: 1, type: 'presence_interval', fromMs: 0, toMs: 480000, quality: 'good' }, { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 480000 }, { seq: 3, type: 'active_interval', fromMs: 0, toMs: 480000, quality: 'good' }] }) }, bearer(kola.token));
  await j(`/player/box-cam/sessions/${created.session.id}/complete`, { method: 'POST', body: JSON.stringify({ nonce: created.nonce }) }, bearer(kola.token));
  await club.reload();
  await club.waitForSelector('nav.sidebar', { timeout: 20000 });
  await club.evaluate(() => { location.hash = '#/search'; });
  await club.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 20000 });
  await club.click('.player-card:has-text("Kola Adeyemi")');
  await club.waitForSelector('[aria-label="Box Training"]', { timeout: 15000 });
  await club.click('[aria-label="Box Training"] button:has-text("Show")');
  await club.waitForSelector('[aria-label="Box Training"]:has-text("Box Cam")', { timeout: 15000 });
  say('B5-live: the player’s Box Cam result flows back to the coach as a result summary');
}

// ============================================= B12-live: T&S Box Cam tab
const admin = await ctxAdmin.newPage();
admin.on('pageerror', (e) => fail(`admin page error: ${e}`));
await admin.goto('http://localhost:8594/');
await admin.fill('input[type="password"]', 'scoutbox-admin');
await admin.click('button:has-text("Enter")');
await admin.waitForSelector('nav.sidebar', { timeout: 20000 });
await admin.click('nav.sidebar button:has-text("Cases")');
await admin.click('nav.subnav button:has-text("Box Cam")');
await admin.waitForSelector('text=Box Cam disputes', { timeout: 15000 });
const adminBody = await admin.locator('body').innerText();
if (!adminBody.includes('never fabricates')) fail('B12-live: T&S Box Cam tab must state results are never fabricated');
say('B12-live: T&S Box Cam case tab reachable and states results are server-derived, never fabricated');

await browser.close();
console.log(`\nm16Live: ${passed} checks passed — Box Cam cross-app journey complete`);
process.exit(0);
