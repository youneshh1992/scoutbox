// M16.2 LIVE browser journeys (T1, T8) — real backend, separate contexts.
// T1: the player opens their Trust Profile, sees the score, the band and the
// mandatory disclaimer, and "Why this score?" explains every component.
// T8: a club sees the score and SAFE explanation only — never the raw
// components, gaps or source internals — with the ability disclaimer.
// The deep engine invariants (performance independence, grinding caps,
// invalidation, the authorization boundary) live in scripts/m162E2E.mjs.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4009;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m162live-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

console.log('building live bundles for :4009…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live162`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live162`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

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
serveDir('scoutbox-player/dist-live162', 8601);
serveDir('scoutbox-club/dist-live162', 8602);
process.on('exit', () => { try { serverProc.kill('SIGKILL'); } catch {} for (const s of statics) s.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
console.log(`backend up on :${API_PORT}`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const A = { 'x-admin-key': 'scoutbox-admin', 'content-type': 'application/json' };
const maria = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body;
await j('/admin/verification/orgs/org-eastport/appoint-root', { method: 'POST', body: JSON.stringify({ userId: maria.userId, reason: 'm162live root admin' }) }, A);

const browser = await chromium.launch({ executablePath: EXE });
const ctxPlayer = await browser.newContext({ viewport: { width: 480, height: 1200 } });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// ============================================= T1: player Trust Profile
const player = await ctxPlayer.newPage();
player.on('pageerror', (e) => fail(`player page error: ${e}`));
await player.goto('http://localhost:8601/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();          // Kola (adult)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=ScoutBox Trust Score', { timeout: 20000 });
say('T1: the player You tab shows the ScoutBox Trust Score');
{
  const body = await player.locator('body').innerText();
  if (!/reflects verification and evidence confidence/.test(body)) fail('T1: the mandatory disclaimer is missing');
  say('T1: the disclaimer states this is evidence confidence, not football ability');
  if (!/(Limited|Developing|Established|Strong|Very strong) evidence/.test(body)) fail('T1: no evidence band shown');
  say('T1: an evidence band is shown alongside the score');
  // No ability/character language anywhere on the surface.
  if (/untrustworthy|suspicious|fraud|risky|poor player|talent score|ability score/i.test(body)) fail('T1: prohibited ability/character language on the Trust surface');
  say('T1: no ability or character language appears');

  await player.getByText('Why this score?', { exact: true }).first().click();
  await player.waitForSelector('text=Evidence Confidence', { timeout: 15000 });
  const why = await player.locator('body').innerText();
  const components = ['Identity', 'Football history', 'Relationships', 'Evidence', 'Combine', 'References'];
  const missing = components.filter((c) => !why.includes(c));
  if (missing.length) fail(`T1: "Why this score?" is missing components: ${missing.join(', ')}`);
  say('T1: "Why this score?" explains all six components');
  if (!/Policy version/.test(why)) fail('T1: the policy version is not shown');
  say('T1: the policy version is shown with the derivation');
}

// ============================================= T8: club sees a SAFE view
const club = await ctxClub.newPage();
club.on('pageerror', (e) => fail(`club page error: ${e}`));
await club.goto('http://localhost:8602/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.selectOption('.enter-row select', 'Head of Recruitment');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('nav.sidebar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/search'; });
await club.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 20000 });
await club.click('.player-card:has-text("Kola Adeyemi")');
await club.waitForSelector('[aria-label="Trust Profile"]', { timeout: 15000 });
say('T8: the club player drawer contains a Trust Profile panel');
{
  await club.click('[aria-label="Trust Profile"] button:has-text("Show")');
  await club.waitForSelector('[aria-label="Trust Profile"]:has-text("Evidence Confidence")', { timeout: 15000 });
  const panel = await club.locator('[aria-label="Trust Profile"]').innerText();
  if (!/not football ability/i.test(panel)) fail('T8: the club panel must state evidence confidence, not football ability');
  say('T8: the club panel carries the "not football ability" disclaimer');
  if (!/never ranks players by Trust Score/i.test(panel)) fail('T8: the club panel must state ScoutBox never ranks by Trust Score');
  say('T8: the club panel states ScoutBox never ranks players by Trust Score');
  // The club projection must not carry the player's private derivation.
  if (/What could strengthen it further|gaps/i.test(panel)) fail('T8: the club must not see the player\'s evidence gaps');
  say('T8: the player\'s evidence gaps are not exposed to the club');
  if (/gd-amara|vclm-|identityVerified/i.test(panel)) fail('T8: restricted source identifiers leaked to the club');
  say('T8: no guardian identity or verification source id reaches the club');
}

await browser.close();
console.log(`\nm162Live: ${passed} checks passed — Trust Profile journeys complete`);
process.exit(0);
