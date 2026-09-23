// M23 P5.6F — A3: the GRASSROOTS journey, directly observed (reconstructed).
//
// RECONSTRUCTION NOTE. The original P5.6F closed A3 with a suite that was lost
// with its container. This is a rebuild against the frozen b8556c1 base. The
// historical run reported 29 checks / 23 negative; that is a historical figure
// and nothing here is padded toward it.
//
// A3 was the one of the three carried observations that was a genuine hole
// rather than a classification question: confidence in the Grassroots side came
// from shared code and inference, and the P5.6A privacy matrix's line
// "Grassroots. No agent surface." had never been watched in a browser.
//
// The suite asserts two different kinds of thing, because the mandate forbids
// manufacturing Agent UI where the product wants none (§7):
//
//   PRESENT — a grassroots club is a club. It signs in on its own platform, the
//             app renders, its player list answers, its surfaces behave.
//   ABSENT  — and it is not an agency. No agency vocabulary in the shell or the
//             navigation, no agent lane reachable, no agent field in the player
//             projection. Absence is PROVED, not assumed.
//
// And the safeguards that are the actual reason Grassroots is a separate
// platform: no date of birth in a player list, and the 50km radius still
// withholding players a professional club can see — established by COMPARISON
// against a professional club's view of the same platform, then by reaching for
// each withheld id directly.
//
// There is no `|| true`, no `.catch(() => null)` that degrades into a pass, and
// no assertion that would hold on any status code. §7 forbids all three, and the
// frozen P5.6E integration suite contains an example of the third
// (`neg(true, 'N1 (the grassroots app has no seeded club…)')`) which is recorded
// in the defect register rather than imitated here.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4051;
const API = `http://localhost:${API_PORT}`;
const GRASS_PORT = 9151;
const PLAYER_PORT = 8851;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-p56f-grass-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, GRASS_PORT, PLAYER_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live56f';
const bundles = [['scoutbox-grassroots', GRASS_PORT], ['scoutbox-player', PLAYER_PORT]];
const haveDist = bundles.every(([app]) => fs.existsSync(path.join(ROOT, app, DIST, 'index.html')));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  for (const [app] of bundles) {
    if (app === 'scoutbox-player') execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else execSync(`VITE_API_URL=${API} npx vite build --outDir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
  }
}

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
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
for (const [app, port] of bundles) serveDir(path.join(app, DIST), port);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) for (const [app] of bundles) fs.rmSync(path.join(ROOT, app, DIST), { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 160; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token, extra = {}) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };

// =========================================================== G1 — it is a club

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const grass = watch(await ctx.newPage(), 'grassroots');
grass.on('dialog', (d) => d.accept());
await grass.goto(`http://localhost:${GRASS_PORT}/`);
await grass.waitForSelector('.org-card', { timeout: 30000 });
const clubCards = await grass.locator('.org-card').count();
ok(clubCards >= 2, `G1 the Grassroots app loads and offers its clubs (${clubCards} on the chooser)`);

const cardText = await grass.$eval('.org-grid', (el) => el.innerText);
neg(!/Northstar|agency/i.test(cardText), 'G1b and the club chooser offers no AGENCY — an agency has no account on this platform');

await grass.click('.org-card:has-text("Hackney Marsh Rovers")');
await grass.fill('.enter-row input', 'Pat Doyle');
await grass.selectOption('.enter-row select', { index: 0 }).catch(() => {});
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('nav.sidebar', { timeout: 30000 });
ok((await grass.locator('nav.sidebar').count()) === 1 && /Hackney Marsh Rovers/.test(await grass.evaluate(() => document.body.innerText)), 'G2 a verified grassroots club signs in and reaches its workspace, which names the club it belongs to');

const grassToken = await grass.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('scoutbox-grassroots-session') ?? 'null')?.token ?? null; } catch { return null; }
});
ok(!!grassToken, 'G2b with a real session token — this is the live API, not a demo bundle');

// ====================================================== G3 — no agency surface

const navText = await grass.$eval('nav.sidebar', (el) => el.innerText);
const AGENCY_WORDS = ['My Clients', 'Agency', 'Licensed agent', 'Representation agreement', 'Mandate', 'Conflict of interest', 'Compliance'];
for (const word of AGENCY_WORDS) {
  neg(!new RegExp(word, 'i').test(navText), `G3 the navigation carries no "${word}" — the P5.6A matrix says "Grassroots. No agent surface." and this is that line, watched`);
}
const shellText = await grass.evaluate(() => document.body.innerText);
for (const word of ['My Clients', 'Licensed agent', 'Representation agreement', 'Conflict of interest']) {
  neg(!new RegExp(word, 'i').test(shellText), `G3b nor does the rendered shell carry "${word}"`);
}

// The agent lane is not merely hidden in the UI — it is refused to this session.
for (const [what, url] of [
  ['clients', '/org/agent/clients'],
  ['agent home', '/org/agent/home'],
  ['compliance contexts', '/org/agent/compliance/contexts'],
  ['agent transactions', '/org/agent/transactions'],
  ['agent inbox', '/org/agent/inbox'],
]) {
  const r = await j('GET', url, undefined, grassToken);
  neg(r.status === 403 && typeof r.body?.error === 'string', `G4 a grassroots session is refused the agent lane's ${what} — 403 ${r.body?.error} — hiding a control is not a boundary; this is`);
}

// ================================================= G5 — safeguards on the list

const players = await j('GET', '/org/players', undefined, grassToken);
ok(players.status === 200, `G5 the grassroots club's own player list answers (${players.status})`);
const grassIds = (players.body?.players ?? players.body?.items ?? players.body ?? []).map((p) => p.id).filter(Boolean);
ok(grassIds.length > 0, `G5b and it contains players (${grassIds.length})`);

const listText = JSON.stringify(players.body);
neg(!/"dob"\s*:\s*"\d{4}-\d{2}-\d{2}"/.test(listText), 'G5c no date of birth is projected into a grassroots player list');
neg(!/"agent"\s*:|"agentUserId"\s*:|representationAgreement/i.test(listText), 'G5d and no agent field: the grassroots player projection has no agent concept at all');

// ============================ G6 — the 50km radius, proved by COMPARISON

// A professional club sees the whole platform; the grassroots club sees a
// radius. So the grassroots list must be a strict SUBSET, and the difference
// must be unreachable rather than merely unlisted.
const pro = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
ok(!!pro?.token, 'G6 a professional club signed in, to compare against');
const proPlayers = await j('GET', '/org/players', undefined, pro.token);
const proIds = (proPlayers.body?.players ?? proPlayers.body?.items ?? proPlayers.body ?? []).map((p) => p.id).filter(Boolean);
ok(proIds.length > 0, `G6b and its list answers (${proIds.length} players)`);

const withheld = proIds.filter((id) => !grassIds.includes(id));
neg(withheld.length > 0, `G6c the grassroots club is shown FEWER players than the professional club (${grassIds.length} vs ${proIds.length}); ${withheld.length} are withheld — the radius is doing something`);
neg(grassIds.every((id) => proIds.includes(id)), 'G6d and the grassroots list is a strict SUBSET, not a different set — the filter narrows, it does not substitute');

// Reaching for a withheld id directly must not yield anything private. The
// statuses are reported rather than swallowed: an assertion that would pass just
// as happily on six 404s as on six sanitised 200s should say which it got.
const probes = [];
let leaked = 0;
for (const id of withheld.slice(0, 6)) {
  const r = await j('GET', `/org/players/${id}`, undefined, grassToken);
  probes.push(r.status);
  if (r.status === 200 && /"dob"|"email"|"phone"/.test(JSON.stringify(r.body))) leaked += 1;
}
neg(leaked === 0, `G6e reaching for ${probes.length} withheld ids DIRECTLY yields no private field — statuses ${probes.join(',')} — the radius is a boundary, not a list filter`);
neg(probes.every((s) => s === probes[0]), `G6f and every withheld id answers identically (${probes.join(',')}) — the radius is not an existence oracle either`);

// ============================================== G7 — minors, still protected

// Pinned to ONE branch. Hackney Marsh Rovers is seeded verified with the
// safeguarding contract signed, so it MAY see a local minor — the same bar as
// any club — and the assertion is about what it gets, not whether it gets in.
// An either-way `if (200) … else refused` here would have passed under two
// contradictory products.
const minor = await j('GET', '/org/players/pl-guni', undefined, grassToken);
ok(minor.status === 200, `G7 a verified, safeguarding-signed grassroots club can open a local minor's record (${minor.status})`);
const minorText = JSON.stringify(minor.body ?? {});
neg(!/"dob"\s*:\s*"\d{4}/.test(minorText), 'G7a and still gets no date of birth');
neg(!/"email"|"phone"/.test(minorText), 'G7b and no contact details');
const agentOnMinor = await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG', clientKey: 'grass-probe-1' }, grassToken);
neg(agentOnMinor.status === 403 && typeof agentOnMinor.body?.error === 'string', `G7c and a grassroots session cannot open an agent mandate on a minor — 403 ${agentOnMinor.body?.error} — the agent lane is closed to this platform whoever the subject is`);

// ============================================== G8 — the player side agrees

const player = watch(await ctx.newPage(), 'player');
await player.goto(`http://localhost:${PLAYER_PORT}/`);
// No `.catch(() => {})` swallowing the wait and no `ok(true)` after it: if the
// player app does not put up its entry screen, this is a failure, not a pass.
await player.waitForSelector('text=/Sign in|Continue|Your visibility/i', { timeout: 40000 });
const playerEntry = await player.locator('text=/Sign in|Continue|Your visibility/i').count();
ok(playerEntry > 0, `G8 the player app renders its entry screen against the same live API (${playerEntry} matching element${playerEntry === 1 ? '' : 's'})`);
const playerShell = await player.evaluate(() => document.body.innerText);
neg(!/Hackney Marsh Rovers.*(agent|agency)/is.test(playerShell), 'G8b and carries no agency vocabulary attached to the grassroots club');

// ============================================ G9 — responsive and console-clean

for (const w of [1440, 1280, 1024, 768, 390, 360]) {
  await grass.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
  await sleep(350);
  const overflow = await grass.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(overflow, `G9 no horizontal overflow at ${w}px`);
  const visible = await grass.evaluate(() => (document.body.innerText || '').trim().length > 80);
  ok(visible, `G9b and the page still has its content at ${w}px — a blank page does not overflow either`);
}

ok(errors.length === 0, `G10 no page error in either client (${errors.join(' | ')})`);

console.log(`\nM23 P5.6F GRASSROOTS LIVE (reconstructed): ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
console.log('A3 is closed by observation: the Grassroots app was driven, not inferred');
await browser.close();
process.exit(0);
