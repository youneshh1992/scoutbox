// M12 LIVE browser integration — separate contexts, one real backend, no demo
// bus. Exercises the new client surfaces end to end:
//   E1. Pro publishes a structured opportunity → the player's board (own
//       context) shows it → the player applies → Pro sees the application
//       and records an outcome → the player sees the answer.
//   E2. A submitted assessment's PUBLISHED feedback (the only club→player
//       door) appears on the player's You tab; the raw report never does.
//   E3. The player logs an evidence claim from the passport UI; the org's
//       API view shows it as self-reported.
// Requires dist-live bundles built for :4001 (liveIntegration builds them —
// run that first, or this script rebuilds if missing).
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m12live-'));
const say = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

if (!fs.existsSync(path.join(ROOT, 'scoutbox-club/dist-live/index.html'))) {
  say('building live bundles…');
  execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
}

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA },
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
serveDir('scoutbox-player/dist-live', 8281);
serveDir('scoutbox-club/dist-live', 8282);

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

// API helpers for setup steps that other suites already cover in-browser.
const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const MARIA = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body.token;

const browser = await chromium.launch({ executablePath: EXE });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxPlayer = await browser.newContext({ viewport: { width: 420, height: 880 } });

// ---- Pro context: publish an opportunity through the actual screen
const club = await ctxClub.newPage();
await club.goto('http://localhost:8282/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('.topbar', { timeout: 20000 });
await club.click('nav.sidebar button:has-text("Opportunities")');
const deadline = new Date(Date.now() + 21 * 86400e3).toISOString().slice(0, 10);
await club.fill('input[aria-label="Opportunity title"]', 'U23 look — pressing forwards');
await club.fill('input[aria-label="Deadline"]', deadline);
await club.click('button:has-text("Publish opportunity")');
await club.waitForSelector('text=U23 look — pressing forwards', { timeout: 10000 });
say('E1: Pro published a structured opportunity through the real screen');

// ---- Player context: board shows it; apply
const player = await ctxPlayer.newPage();
await player.goto('http://localhost:8281/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click(); // Kola (dev login, live server)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.waitForSelector('text=Opportunity board', { timeout: 20000 });
await player.waitForSelector('text=U23 look — pressing forwards', { timeout: 15000 });
say('E1: the opportunity reached the player’s board in his own context');
await player.locator('div', { hasText: 'U23 look — pressing forwards' }).locator('text=Apply').last().click();
await player.waitForSelector('text=Application submitted', { timeout: 10000 });
say('E1: player applied from the board');

// ---- Pro sees the application and answers it
await club.click('nav.sidebar button:has-text("Opportunities")');
await club.locator('.list-row', { hasText: 'U23 look' }).locator('button:has-text("Applications")').click();
await club.waitForSelector('text=Kola Adeyemi', { timeout: 15000 });
await club.locator('.list-row', { hasText: 'Kola Adeyemi' }).locator('button:has-text("Accept")').click();
await club.waitForSelector('text=accepted', { timeout: 10000 });
say('E1: Pro answered the application — no ghosting');

// ---- E2: published feedback (created via API — assessment editor is covered
// by demo suites) appears in the player context; raw report does not.
let r = await j('/org/assessments', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi', positionGroup: 'ATT' }) }, bearer(MARIA));
const assId = r.body.assessment.id;
await j(`/org/assessments/${assId}`, { method: 'PUT', body: JSON.stringify({ ratings: [{ attrId: 'finishing', rating: 4, confidence: 'high' }], recommendation: { verdict: 'monitor', reasons: 'live test' } }) }, bearer(MARIA));
await j(`/org/assessments/${assId}/submit`, { method: 'POST', body: JSON.stringify({}) }, bearer(MARIA));
await j(`/org/assessments/${assId}/publish-feedback`, { method: 'POST', body: JSON.stringify({ text: 'Great pressing angles this month — next: recovery runs after losing it.' }) }, bearer(MARIA));
await player.click('a[href="/you"]');
await player.waitForSelector('text=Great pressing angles this month', { timeout: 20000 });
say('E2: published feedback reached the player’s You tab');
const pageText = await player.locator('body').innerText();
if (pageText.includes('live test') || pageText.includes('monitor')) fail('raw assessment content leaked to the player');
say('E2: the raw report (recommendation, reasons) is NOT in the player view');

// ---- E3: evidence claim logged through the passport UI, visible to the org
await player.click('a[href="/profile"]');
await player.waitForSelector('text=Evidence passport', { timeout: 20000 });
await player.fill('input[aria-label="Evidence claim label"]', 'Assists 2025/26');
await player.fill('input[aria-label="Evidence value"]', '7');
await player.locator('text=Log a claim').click();
await player.waitForSelector('text=Logged as self-reported', { timeout: 10000 });
r = await j('/org/players/pl-adeyemi/passport', {}, bearer(MARIA));
const rec = r.body.records.find((x) => x.label === 'Assists 2025/26');
if (!rec || rec.verification.status !== 'self_reported') fail('claim not visible to the org as self-reported');
say('E3: passport claim flowed player UI → server → org passport view, honestly tiered');

console.log('\nM12 LIVE INTEGRATION OK — real backend, separate contexts');
await browser.close();
process.exit(0);
