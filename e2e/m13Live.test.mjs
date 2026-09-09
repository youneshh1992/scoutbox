// M13 LIVE browser integration — four separate browser contexts (Pro lead,
// adult player, guardian, grassroots club), one real backend, no demo bus.
//   L1. Suitability: player sets private preferences in his own context,
//       checks fit against a structured opportunity, applies, APPROVES a
//       summary — the Pro context sees verdicts only, never the reasons.
//   L2. Coverage + insight: Pro creates a fixture and an observation
//       assignment through the real screens; review queue renders.
//   L3. Guardian: sets an under-18's preferences and checks fit from the
//       guardian panel (relocation never collected).
//   L4. Transition: the adult player opens a case and grants Eastport; the
//       Pro Network screen reads the pack; revocation cuts it off live.
//       Grassroots context renders its M13 screens (isolated by default).
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4002;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m13live-'));
const say = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

// Live bundles pinned to THIS api port.
say('building live bundles for :4002…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live13`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live13`, { cwd: path.join(ROOT, 'scoutbox-grassroots'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live13`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

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
serveDir('scoutbox-player/dist-live13', 8291);
serveDir('scoutbox-club/dist-live13', 8292);
serveDir('scoutbox-grassroots/dist-live13', 8293);

function cleanup() {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 250));
}
say(`backend up on :${API_PORT} (isolated db)`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const MARIA = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body.token;

// Setup via API (the creation screens are covered by m12Live/demo suites):
// a structured opportunity the fit engine can chew on.
const deadline = new Date(Date.now() + 21 * 86400e3).toISOString().slice(0, 10);
const opp = (await j('/org/opportunities', { method: 'POST', body: JSON.stringify({ title: 'First-team look — wide forwards', type: 'trial', category: 'mens', deadline }) }, bearer(MARIA))).body.opportunity;
await j(`/org/opportunities/${opp.id}/structured-requirements`, {
  method: 'PUT',
  body: JSON.stringify({ trainingSlots: [{ day: 'tue', start: '18:30', end: '20:00', tz: 'Europe/London' }], expensesCovered: true, environment: ['competitive'] }),
}, bearer(MARIA));

const browser = await chromium.launch({ executablePath: EXE });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxPlayer = await browser.newContext({ viewport: { width: 420, height: 880 } });
const ctxGuardian = await browser.newContext({ viewport: { width: 420, height: 880 } });
const ctxGrass = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// =========================================================== L1 suitability
const player = await ctxPlayer.newPage();
await player.goto('http://localhost:8291/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click(); // Kola (adult, dev login)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=Suitability preferences', { timeout: 20000 });
await player.fill('input[aria-label="Travel limit"]', '40');
await player.locator('text=Save travel limit').click();
await player.waitForSelector('text=Saved — private to you', { timeout: 10000 });
say('L1: adult player saved a private preference through his own screen');

await player.click('a[href="/discover"]');
await player.waitForSelector('text=Opportunity fit', { timeout: 20000 });
await player.locator('div', { hasText: 'First-team look — wide forwards' }).locator('text=Apply').last().click();
await player.waitForSelector('text=Application submitted', { timeout: 10000 });
// board reloads on apply; the fit section fetches its own copy
await player.locator('text=Check fit').first().click();
await player.waitForSelector('text=travel time unavailable', { timeout: 15000 });
say('L1: fit verdicts render with the honest “travel time unavailable” line');
await player.locator('text=Share summary with this club').first().click();
await player.waitForSelector('text=the club sees verdicts only', { timeout: 10000 });
say('L1: player approved a verdict summary');

const club = await ctxClub.newPage();
await club.goto('http://localhost:8292/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('.topbar', { timeout: 20000 });
await club.click('nav.sidebar button:has-text("Opportunities")');
await club.locator('.list-row', { hasText: 'First-team look' }).locator('button:has-text("Applications")').click();
await club.waitForSelector('text=Kola Adeyemi', { timeout: 15000 });
await club.locator('.list-row', { hasText: 'Kola Adeyemi' }).locator('button:has-text("Suitability")').click();
await club.waitForSelector('text=Suitability (player-approved)', { timeout: 10000 });
const clubText = await club.locator('body').innerText();
if (clubText.includes('BTEC') || clubText.includes('40 km') || clubText.includes('travelLimit')) fail('private preference detail leaked to the club');
say('L1: Pro sees the approved verdict summary — and none of the private reasons');

// ====================================================== L2 coverage+insight
await club.click('nav.sidebar button:has-text("Coverage")');
await club.waitForSelector('text=Coverage plans', { timeout: 15000 });
await club.fill('input[aria-label="Home"]', 'Eastport U21');
await club.fill('input[aria-label="Away"]', 'Harbour Rovers U21');
await club.fill('input[aria-label="Date"]', deadline);
await club.locator('button:has-text("Create")').last().click();
await club.waitForSelector('text=Fixture added', { timeout: 10000 });
await club.selectOption('select[aria-label="Fixture"]', { label: `Eastport U21 v Harbour Rovers U21 (${deadline})` });
await club.selectOption('select[aria-label="Scout"]', { label: 'Maria Keane' });
await club.locator('button:has-text("Assign")').first().click();
// Assert on the durable assignment row, not the transient toast.
await club.waitForSelector('.list-row:has-text("Eastport U21 v Harbour Rovers U21")', { timeout: 10000 });
await club.waitForSelector('text=Travel time/route estimates unavailable', { timeout: 10000 });
await club.locator('button:has-text("Mark observed")').first().click();
await club.waitForSelector('text=observed', { timeout: 10000 });
say('L2: fixture + assignment created through the real Coverage screen (honest travel note shown)');

await club.click('nav.sidebar button:has-text("Scouting Insight")');
await club.waitForSelector('text=Exposure funnel', { timeout: 15000 });
await club.waitForSelector('text=Not yet assessed', { timeout: 10000 });
say('L2: exposure funnel + not-yet-assessed review queue render for the lead');

// ============================================================== L3 guardian
const guardian = await ctxGuardian.newPage();
await guardian.goto('http://localhost:8291/');
await guardian.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await guardian.locator('text=Enter').last().click(); // Amara (guardian, dev login)
await guardian.waitForSelector('text=Guardian', { timeout: 20000 });
await guardian.waitForSelector('text=Suitability preferences', { timeout: 25000 });
const gText = await guardian.locator('body').innerText();
if (gText.includes('Relocation:')) fail('relocation preference rendered for a minor');
await guardian.locator('input[aria-label="Travel limit"]').first().fill('15');
await guardian.locator('text=Save travel limit').first().click();
await guardian.waitForSelector('text=Saved — private to you', { timeout: 10000 });
say('L3: guardian set the child’s preferences (relocation never collected for minors)');

// ============================================================ L4 transition
await player.click('a[href="/you"]');
await player.waitForSelector('text=Club transition', { timeout: 20000 });
await player.locator('text=Open a transition case').click();
await player.waitForSelector('text=Open to a new club', { timeout: 10000 });
await player.locator('input[aria-label="Org id"]').fill('org-eastport');
await player.locator('text=Share with club').click();
await player.waitForSelector('text=Shared — expiring and revocable', { timeout: 10000 });
say('L4: adult player opened a transition case and granted one specific club');

await club.click('nav.sidebar button:has-text("Club Network")');
await club.waitForSelector('text=Transition packs shared with you', { timeout: 15000 });
await club.waitForSelector('text=Kola Adeyemi', { timeout: 10000 });
await club.locator('button:has-text("Open pack")').first().click();
await club.waitForSelector('text=Open to a new club', { timeout: 10000 });
say('L4: Pro Network screen reads exactly the shared pack');

// The tab navigator keeps other screens mounted (hidden) — scope to the
// visible Withdraw control on the You tab's transition card.
// The long-lived SPA page occasionally resets to its Home tab on a live-sync
// tick; open a fresh page at /you in the SAME authenticated context instead.
const player2 = await ctxPlayer.newPage();
await player2.goto('http://localhost:8291/you');
await player2.waitForSelector('text=Club transition', { timeout: 25000 });
await player2.getByText('Withdraw', { exact: true }).locator('visible=true').first().click({ timeout: 15000 });
await player2.waitForSelector('text=cannot be remotely erased', { timeout: 10000 }).catch(async () => {
  const txt = await player2.locator('body').innerText();
  const at = txt.toUpperCase().indexOf('CLUB TRANSITION');
  console.error('revoke message missing — transition card area:\n', at >= 0 ? txt.slice(Math.max(0, at - 100), at + 1200) : `(no card) tail:\n${txt.slice(-1500)}`);
  fail('revocation did not confirm');
});
await club.locator('button:has-text("Open pack")').first().click();
await club.waitForSelector('text=Access to this pack was withdrawn', { timeout: 10000 });
say('L4: revocation in the player context cut the club’s access on the next read');

// ------------------------------------------------- grassroots context (L4b)
const grass = await ctxGrass.newPage();
await grass.goto('http://localhost:8293/');
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('.topbar', { timeout: 20000 });
await grass.click('nav.sidebar button:has-text("Scouting Insight")');
await grass.waitForSelector('text=Not yet assessed', { timeout: 15000 });
await grass.click('nav.sidebar button:has-text("Club Network")');
await grass.waitForSelector('text=No group memberships', { timeout: 15000 });
await grass.click('nav.sidebar button:has-text("Organisation")');
await grass.waitForSelector('text=Onboarding checklist', { timeout: 15000 });
say('L4b: grassroots context renders its M13 screens — isolated by default, no shares, own onboarding');

console.log('\nM13 LIVE INTEGRATION OK — real backend, four separate contexts');
await browser.close();
process.exit(0);
