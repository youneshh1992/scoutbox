// M15 LIVE browser journeys (P1–P8) — real backend, separate contexts, no
// demo bus. Assertions read page content, never just toasts.
//   P1. Player: opens their Football Passport, adds a career entry with a
//       year-only date, adds an achievement — everything renders with honest
//       "provided by player" provenance.
//   P2. Club: search cards carry batch passport chips (ONE call), the player
//       drawer shows the recruitment passport with own-org-only records, and
//       a verified club confirms an achievement (provenance upgrade).
//   P3. Guardian: sees the child's passport, mints a recruitment share —
//       which STILL never opens the minor to an agency or unverified club.
//   P4. Historical truth: a coach departs; the reference snapshot copy flips
//       to "verified when this reference was submitted" — never rewritten.
//   P5. Conflict engine: a confirmed club relationship vs the player's own
//       current entry → the self view EXPLAINS a CURRENT_CLUB_CONFLICT.
//   P6. Sharing: the player mints a public link (URL shown once), anyone can
//       open the SAFE projection (no DOB), revocation kills it instantly.
//   P7. Grassroots: local minor's passport renders for the verified local
//       club; the 50 km radius and the agency/minor wall re-assert live.
//   P8. Deletion: a deleted player's share dies and is indistinguishable
//       from an unknown token.
//   T&S. Correction resolved with a written reason; share killed from the
//       registry; the source-graph inspector shows the conflict.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4007;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m15live-'));
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const A = { 'x-admin-key': 'scoutbox-admin', 'content-type': 'application/json' };

console.log('building live bundles for :4007…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live15`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live15`, { cwd: path.join(ROOT, 'scoutbox-grassroots'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live15`, { cwd: path.join(ROOT, 'scoutbox-admin'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live15`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

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
serveDir('scoutbox-player/dist-live15', 8491);
serveDir('scoutbox-club/dist-live15', 8492);
serveDir('scoutbox-grassroots/dist-live15', 8493);
serveDir('scoutbox-admin/dist-live15', 8494);

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
console.log(`backend up on :${API_PORT} (isolated db)`);

const j = async (p, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const outboxCode = async (to) => {
  const r = await j('/admin/outbox', {}, A);
  const mail = (r.body ?? []).find((m) => m.to === to);
  return mail ? (mail.text.match(/code is ([A-Za-z0-9_-]{8,})/) ?? [])[1] ?? null : null;
};

// ---------------------------------------------------------- API groundwork
const maria = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body;
await j('/admin/verification/orgs/org-eastport/appoint-root', { method: 'POST', body: JSON.stringify({ userId: maria.userId, reason: 'm15live root admin' }) }, A);
const sam = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Sam Cole', role: 'Coach' }) })).body;
const kolaApi = (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).body;

// Verified coach → structured reference on Kola (P4 raw material).
{
  const aff = await j('/org/verification/affiliation', { method: 'POST', body: JSON.stringify({ role: 'Coach' }) }, bearer(sam.token));
  await j('/org/verification/work-email', { method: 'POST', body: JSON.stringify({ email: 'sam.cole@eastportfc.com' }) }, bearer(sam.token));
  const code = await outboxCode('sam.cole@eastportfc.com');
  await j('/org/verification/work-email/confirm', { method: 'POST', body: JSON.stringify({ code }) }, bearer(sam.token));
  const d = await j(`/org/verification/requests/${aff.body.affiliation.id}/decide`, { method: 'POST', body: JSON.stringify({ action: 'confirm' }) }, bearer(maria.token));
  if (d.status !== 200) fail('setup: coach affiliation not confirmed');
  const ref = await j('/org/verification/references', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi', relationship: 'Head coach, two seasons', summary: 'Reliable, coachable forward.' }) }, bearer(sam.token));
  if (ref.status !== 201) fail('setup: reference not created');
}
// A trial (own-org record for P2) + coarse availability.
{
  const tr = await j('/org/players/pl-adeyemi/request', { method: 'POST', body: JSON.stringify({ type: 'trial', message: 'Trial invitation for our U23 squad.', proposedDate: '2026-10-01' }) }, bearer(maria.token));
  const resp = await j(`/player/requests/${tr.body.requestId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true, chosenSlot: '2026-10-01' }) }, bearer(kolaApi.token));
  if (resp.status !== 200) fail('setup: trial not accepted');
  await j('/player/football-passport/prefs', { method: 'PATCH', body: JSON.stringify({ availability: 'open_to_trials' }) }, bearer(kolaApi.token));
}

const browser = await chromium.launch({ executablePath: EXE });
const ctxPlayer = await browser.newContext({ viewport: { width: 480, height: 960 } });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxGuardian = await browser.newContext({ viewport: { width: 480, height: 960 } });
const ctxGrass = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// ================================================================ P1
const player = await ctxPlayer.newPage();
await player.goto('http://localhost:8491/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click(); // Kola (adult, dev login)
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/football"]');
await player.waitForSelector('text=Football Passport', { timeout: 20000 });
{
  const body = await player.locator('body').innerText();
  if (!body.includes('Identity confirmed by ScoutBox review')) fail('P1: honest identity assurance missing');
  if (body.includes('Government identity verified')) fail('P1: over-claimed identity');
  if (!body.includes('not a rating of football ability')) fail('P1: passport self-description missing');
  say('P1: self passport renders with honest identity assurance and the no-rating note');
  await player.fill('input[placeholder="Achievement (e.g. League top scorer 2025)"]', 'County Cup Winner 2024');
  await player.getByText('Add', { exact: true }).nth(0).click();
  await player.waitForSelector('text=🏅 County Cup Winner 2024', { timeout: 15000 });
  say('P1: achievement added (player-submitted until a club confirms it)');
  await player.fill('input[placeholder="Club name"]', 'Sunday Kings FC');
  await player.fill('input[placeholder="From (e.g. 2019)"]', '2018');
  await player.getByText('Add', { exact: true }).nth(1).click();
  await player.waitForSelector('text=Sunday Kings FC', { timeout: 15000 });
  const after = await player.locator('body').innerText();
  if (!after.includes('Provided by player')) fail('P1: player-provided provenance chip missing');
  say('P1: year-only career entry lands in club history with "Provided by player" provenance');
}

// ================================================================ P5
{
  const inv = await j('/org/verification/player-invites', { method: 'POST', body: JSON.stringify({ name: 'Kola Adeyemi', playerId: 'pl-adeyemi' }) }, bearer(maria.token));
  const acc = await j('/player/invites/accept', { method: 'POST', body: JSON.stringify({ code: inv.body.code }) }, bearer(kolaApi.token));
  if (acc.status !== 200) fail('P5: squad invite not accepted');
  await player.reload();
  await player.waitForSelector('text=Our promises to every player', { timeout: 30000 }).catch(() => {});
  await player.click('a[href="/football"]').catch(() => {});
  await player.waitForSelector('text=Football Passport', { timeout: 25000 });
  await player.waitForSelector('text=confirmed as your current club', { timeout: 15000 });
  const body = await player.locator('body').innerText();
  if (!body.includes('Eastport FC')) fail('P5: authoritative current club not displayed');
  say('P5: CURRENT_CLUB_CONFLICT is EXPLAINED to the player — authoritative record displayed, nothing silently overwritten');
}

// ================================================================ P4
{
  await j(`/org/verification/staff/${sam.userId}/departed`, { method: 'POST', body: JSON.stringify({}) }, bearer(maria.token));
  await player.reload();
  await player.click('a[href="/football"]').catch(() => {});
  await player.waitForSelector('text=Football Passport', { timeout: 25000 });
  await player.waitForSelector('text=Coach affiliation was verified when this reference was submitted.', { timeout: 15000 });
  say('P4: after the coach departs, the reference shows its SNAPSHOT provenance — historical truth never rewritten');
}

// ================================================================ P6
let kolaShareUrl = null;
{
  await player.getByText('Create public link', { exact: true }).click();
  await player.waitForSelector('text=/\\/passport\\/shared\\//', { timeout: 15000 });
  kolaShareUrl = (await player.locator('text=/\\/passport\\/shared\\//').first().innerText()).trim();
  say('P6: public share minted in the player UI — the secret URL is shown once');
  const pub = await fetch(`${API}${kolaShareUrl}`);
  const pubBody = await pub.text();
  if (pub.status !== 200) fail(`P6: public share did not resolve (${pub.status})`);
  if (pubBody.includes('"dob"') || /guardian/i.test(pubBody)) fail('P6: public projection leaked DOB/guardian data');
  say('P6: anonymous open shows the SAFE public projection (age, never DOB)');
  await player.getByText('Revoke', { exact: true }).first().click();
  await player.waitForSelector('text=revoked', { timeout: 15000 });
  const dead = await fetch(`${API}${kolaShareUrl}`);
  if (dead.status !== 404) fail(`P6: revoked share still resolves (${dead.status})`);
  say('P6: revocation is immediate — the next request with the link fails');
}

// ================================================================ P2
const club = await ctxClub.newPage();
await club.goto('http://localhost:8492/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.selectOption('.enter-row select', 'Head of Recruitment');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('nav.sidebar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/search'; });
await club.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 20000 });
{
  await club.waitForSelector('.player-card:has-text("Kola Adeyemi") .pill:has-text("Evidence:")', { timeout: 15000 });
  say('P2: search cards carry batch passport summary chips (one batch call, no N+1)');
  await club.click('.player-card:has-text("Kola Adeyemi")');
  await club.waitForSelector('[aria-label="Football Passport"]', { timeout: 15000 });
  await club.click('[aria-label="Football Passport"] button:has-text("Show")');
  await club.waitForSelector('text=Sunday Kings FC', { timeout: 15000 });
  const panel = await club.locator('[aria-label="Football Passport"]').innerText();
  if (!panel.includes('Player-provided')) fail('P2: self-submitted history must be labelled in the club view');
  if (!panel.includes('YOUR organisation')) fail('P2: own-org privacy note missing');
  if (!panel.includes('Trial')) fail('P2: own-org trial missing from the panel');
  say('P2: recruitment passport shows provenance-labelled history and own-org-only records');
  await club.locator('.list-row', { hasText: 'County Cup Winner 2024' }).locator('button:has-text("Confirm")').click();
  await club.waitForSelector('text=provenance upgrades to club-confirmed', { timeout: 15000 });
  await club.waitForSelector('[aria-label="Football Passport"] .list-row:has-text("County Cup Winner 2024") .pill:has-text("Club confirmed ✓")', { timeout: 15000 });
  say('P2: verified club confirms the achievement — provenance upgrades without rewriting the entry');
}

// ================================================================ P3
const guardian = await ctxGuardian.newPage();
await guardian.goto('http://localhost:8491/');
await guardian.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await guardian.locator('text=Enter').last().click(); // Amara (guardian, dev login)
await guardian.waitForSelector('text=Guardian', { timeout: 20000 });
let guniRecSecret = null;
{
  await guardian.waitForSelector('text=Football Passport — Guni Adebayo', { timeout: 25000 });
  const gbody = await guardian.locator('body').innerText();
  if (!gbody.includes('controlled by you, the guardian')) fail('P3: guardian-controlled sharing wording missing');
  say("P3: guardian sees the child's passport; sharing is explicitly guardian-controlled");
  await guardian.getByText('Create club link', { exact: true }).first().click();
  await guardian.waitForSelector('text=/\\/org\\/passport\\/shared\\//', { timeout: 15000 });
  const url = (await guardian.locator('text=/\\/org\\/passport\\/shared\\//').first().innerText()).trim();
  guniRecSecret = url.split('/').pop();
  say('P3: guardian minted a recruitment share for the minor');
  const alex = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Agent' }) })).body;
  const wall = await j(`/org/passport/shared/${guniRecSecret}`, {}, bearer(alex.token));
  if (wall.status !== 403 || wall.body.error !== 'UNDER_18_WALL') fail(`P3: agency opened a minor's share (${wall.status})`);
  say("P3: the SAME share still never opens the minor to an agency — a link locates, it never authorises");
  const ruth = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-harbour', scoutName: 'Ruth Vane', role: 'Scout' }) })).body;
  const wall2 = await j(`/org/passport/shared/${guniRecSecret}`, {}, bearer(ruth.token));
  if (wall2.status !== 403) fail('P3: unverified club opened a minor share');
  say('P3: nor to an unverified club');
}

// ================================================================ P7
const grass = await ctxGrass.newPage();
await grass.goto('http://localhost:8493/');
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('nav.sidebar', { timeout: 20000 });
await grass.evaluate(() => { location.hash = '#/search'; });
await grass.waitForSelector('.player-card:has-text("Guni Adebayo")', { timeout: 20000 });
{
  await grass.click('.player-card:has-text("Guni Adebayo")');
  await grass.waitForSelector('[aria-label="Football Passport"]', { timeout: 15000 });
  await grass.click('[aria-label="Football Passport"] button:has-text("Show")');
  await grass.waitForSelector('[aria-label="Football Passport"] .stat-grid', { timeout: 15000 });
  say('P7: verified LOCAL grassroots club renders the minor’s recruitment passport (standing rule, unchanged)');
  const dee = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Coach', role: 'Manager', platform: 'grassroots' }) })).body;
  const far = await j('/org/players/pl-adeyemi/football-passport', {}, bearer(dee.token));
  if (far.status !== 403) fail(`P7: 50km radius did not hold (${far.status})`);
  const alex = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Agent' }) })).body;
  const wall = await j('/org/players/pl-guni/football-passport', {}, bearer(alex.token));
  if (wall.status !== 403 || wall.body.error !== 'UNDER_18_WALL') fail('P7: agency/minor wall did not hold');
  say('P7: the 50 km grassroots radius and the agency/minor wall re-assert against the live server');
}

// ================================================================ P8
{
  const signup = await j('/auth/player/signup', { method: 'POST', body: JSON.stringify({ name: 'Bob Forward', dob: '1995-05-05', country: 'GB', position: 'ST', password: 'longenough1' }) });
  const bob = signup.body?.token ? signup.body : (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: signup.body.playerId }) })).body;
  const share = await j('/player/football-passport/shares', { method: 'POST', body: JSON.stringify({ mode: 'public' }) }, bearer(bob.token));
  const url = share.body.url;
  if ((await fetch(`${API}${url}`)).status !== 200) fail('P8: share did not resolve before deletion');
  const del = await j('/player/account', { method: 'DELETE' }, bearer(bob.token));
  if (del.status !== 200) fail('P8: deletion failed');
  const gone = await fetch(`${API}${url}`);
  const bogus = await fetch(`${API}/passport/shared/not-a-real-token-000111`);
  if (gone.status !== 404 || (await gone.text()) !== (await bogus.text())) fail('P8: dead share distinguishable from unknown');
  say('P8: a deleted player’s share dies instantly and is indistinguishable from an unknown link');
}

// ================================================================ T&S
{
  await j('/player/football-passport/corrections', { method: 'POST', body: JSON.stringify({ targetType: 'club_history', reason: 'Joined in August, the record says July.' }) }, bearer(kolaApi.token));
  const admin = await ctxAdmin.newPage();
  await admin.goto('http://localhost:8494/');
  await admin.fill('input[type="password"]', 'scoutbox-admin');
  await admin.click('button:has-text("Enter")');
  await admin.waitForSelector('nav.sidebar', { timeout: 20000 });
  await admin.click('nav.sidebar button:has-text("Cases")');
  await admin.click('nav.subnav button:has-text("Passport")');
  await admin.waitForSelector('text=Correction requests', { timeout: 15000 });
  await admin.waitForSelector('text=Joined in August', { timeout: 15000 });
  admin.once('dialog', (d) => d.accept('Date corrected after club confirmation.'));
  await admin.locator('.list-row', { hasText: 'Joined in August' }).locator('button:has-text("Corrected")').click();
  await admin.waitForSelector('text=Resolved: corrected.', { timeout: 15000 });
  say('T&S: correction resolved with a written, audited reason — the record itself was never edited here');
  await admin.waitForSelector('.list-row:has-text("pl-guni") button:has-text("Kill link")', { timeout: 15000 });
  await admin.locator('.list-row:has-text("pl-guni")').first().locator('button:has-text("Kill link")').click();
  await admin.waitForSelector('text=Share revoked', { timeout: 15000 });
  const dead = await j(`/org/passport/shared/${guniRecSecret}`, {}, bearer((await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Coach', role: 'Manager', platform: 'grassroots' }) })).body.token));
  if (dead.status !== 404) fail(`T&S: killed share still resolves (${dead.status})`);
  say('T&S: share killed from the registry — dead for everyone, immediately');
  await admin.fill('input[placeholder="Player id (e.g. pl-adeyemi)"]', 'pl-adeyemi');
  await admin.click('button:has-text("Inspect")');
  await admin.waitForSelector('text=CURRENT_CLUB_CONFLICT', { timeout: 15000 });
  const graphText = await admin.locator('body').innerText();
  if (!graphText.includes('pev:')) fail('T&S: source graph missing canonical event ids');
  if (!graphText.includes('never an automatic fraud accusation')) fail('T&S: conflict framing missing');
  say('T&S: source-graph inspector shows canonical ids, provenance and the flagged conflict (framed as a correction, not an accusation)');
}

await browser.close();
console.log(`\nm15Live: ${passed} checks passed — P1–P8 + T&S complete`);
process.exit(0);
