// M14 LIVE browser integration — separate browser contexts (club admin,
// requesting scout, guardian, grassroots club, Trust & Safety console), one
// real backend, no demo bus.
//   L1. Professional requests club verification → work-email code → the club
//       admin confirms in HER context → the scout's profile shows the
//       verified role with provenance.
//   L2. Club admin marks the scout departed → current badge disappears →
//       the historical verified role remains.
//   L3. A new club applies (public API flow) → the prepared case lands in
//       the T&S console → a human approves with a written reason → the
//       organisation and its first root admin exist.
//   L4. A licence upload stays explicitly UNVERIFIED ("Credential submitted").
//   L5. The departed scout disputes; the dispute reaches the T&S console and
//       is resolved with a reason.
//   L6. Guardian accepts a squad invitation for a minor; the agency-on-minor
//       block is re-asserted against the live server.
//   L7. Cross-tenant: a second club's console shows none of club A's people.
// Assertions read page content, never just toasts.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4003;
const API = `http://localhost:${API_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m14live-'));
const say = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const A = { 'x-admin-key': 'scoutbox-admin' };

say('building live bundles for :4003…');
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-grassroots'), stdio: 'pipe' });
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-admin'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live14`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

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
serveDir('scoutbox-player/dist-live14', 8391);
serveDir('scoutbox-club/dist-live14', 8392);
serveDir('scoutbox-grassroots/dist-live14', 8393);
serveDir('scoutbox-admin/dist-live14', 8394);

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
const outboxCode = async (to) => {
  const r = await j('/admin/outbox', {}, A);
  const mail = (r.body ?? []).find((m) => m.to === to);
  return mail ? (mail.text.match(/code (?:is|for[^:]*:) ?([A-Za-z0-9_-]{8,})/) ?? [])[1] ?? null : null;
};

// API setup: Trust & Safety establishes the club's root verification admin.
const maria = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body;
let r = await j('/admin/verification/orgs/org-eastport/appoint-root', { method: 'POST', body: JSON.stringify({ userId: maria.userId, reason: 'live test: migrated club, chair confirmed' }) }, A);
if (r.status !== 201) fail(`appoint-root failed: ${r.status}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctxClub = await browser.newContext({ viewport: { width: 1440, height: 900 } });   // Maria (root admin)
const ctxScout = await browser.newContext({ viewport: { width: 1440, height: 900 } });  // Tom (requesting scout)
const ctxGuardian = await browser.newContext({ viewport: { width: 420, height: 880 } });
const ctxGrass = await browser.newContext({ viewport: { width: 1440, height: 900 } });  // Dee (second club)
const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } });  // Trust & Safety

async function clubLogin(ctx, orgText, name, port = 8392) {
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.click(`.org-card:has-text("${orgText}")`);
  await page.fill('.enter-row input', name);
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('.topbar', { timeout: 20000 });
  return page;
}

// ================================================================ L1
const scout = await clubLogin(ctxScout, 'Eastport FC', 'Tom Field');
await scout.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await scout.waitForSelector('text=Verify your football role', { timeout: 15000 });
await scout.fill('input[aria-label="Professional role (e.g. Academy Scout)"]', 'Academy Scout');
await scout.click('button:has-text("Request affiliation")');
await scout.waitForSelector('text=club role', { timeout: 15000 });
await scout.fill('input[aria-label="Work email (your organisation domain)"]', 'tom.field@eastportfc.com');
await scout.click('button:has-text("Send code")');
await scout.waitForTimeout(700);
const code = await outboxCode('tom.field@eastportfc.com');
if (!code) fail('work-email code not found in the local outbox');
await scout.fill('input[aria-label="Code"]', code);
await scout.click('button:has-text("Confirm code")');
await scout.waitForSelector('text=automated checks passed', { timeout: 15000 });
say('L1: scout requested affiliation and proved the work mailbox in his own context');

const club = await clubLogin(ctxClub, 'Eastport FC', 'Maria Keane');
await club.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await club.click('button[role="tab"]:has-text("Requests")');
await club.waitForSelector('.list-row:has-text("Tom Field")', { timeout: 15000 });
const reqRowText = await club.locator('.list-row', { hasText: 'Tom Field' }).first().innerText();
if (!/work email/i.test(reqRowText)) fail('request row missing the email-status evidence line');
await club.locator('.list-row', { hasText: 'Tom Field' }).first().locator('button:has-text("Confirm")').first().click();
await club.waitForSelector('text=No pending requests.', { timeout: 15000 });
await club.click('button[role="tab"]:has-text("Staff")');
await club.waitForSelector('.list-row:has-text("Tom Field")', { timeout: 15000 });
say('L1: club admin confirmed the request from a PREPARED case in her own context');

await scout.reload();
await scout.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await scout.waitForSelector('text=Role verified: Academy Scout', { timeout: 20000 });
const prov = await scout.locator('body').innerText();
if (!prov.includes('Organisation confirmation')) fail('verification steps missing');
say('L1: scout profile shows “Role verified: Academy Scout” with admin-confirmation provenance');

// ================================================================ L4
await scout.fill('input[aria-label="Licence type"]', 'UEFA B Licence');
await scout.fill('input[aria-label="Issuing body"]', 'UEFA');
await scout.click('button:has-text("Submit credential")');
await scout.waitForSelector('text=Credential submitted', { timeout: 15000 });
await scout.reload();
await scout.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await scout.waitForSelector('text=Verify your football role', { timeout: 15000 });
// Assert on badges + claim rows, not the explanatory copy (which legitimately
// SAYS "Licence verified" while explaining when that label may appear).
const licBadges = await scout.locator('.ver-badge summary').allInnerTexts();
if (licBadges.some((t2) => t2.includes('Licence verified'))) fail('an uploaded credential rendered as a verified licence badge');
const licRow = await scout.locator('.list-row', { hasText: 'licence' }).first().innerText();
if (/\bverified\b/i.test(licRow.replace(/verification pending/i, ''))) fail('licence claim row shows verified after a mere upload');
say('L4: licence upload shows “Credential submitted” — never “Licence verified”');

// ================================================================ L2
await club.locator('.list-row', { hasText: 'Tom Field' }).first().locator('button:has-text("Mark as left organisation")').click();
await club.waitForSelector('.list-row:has-text("Tom Field"):has-text("Former")', { timeout: 15000 });
say('L2: staff registry shows the closed period');

await scout.reload();
await scout.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await scout.waitForSelector('text=Verified history', { timeout: 20000 });
const histText = await scout.locator('body').innerText();
if (!histText.includes('Former Eastport')) fail('historical badge missing');
// The CURRENT role badge must be gone from the public preview.
const badgeSummaries = await scout.locator('.ver-badge summary').allInnerTexts();
if (badgeSummaries.some((t2) => t2.includes('Role verified: Academy Scout') && !t2.includes('Former'))) fail('current badge survived departure');
say('L2: current badge gone; historical verified role remains on the profile');

// ================================================================ L3
r = await j('/auth/org/verification/apply', {
  method: 'POST',
  body: JSON.stringify({
    orgName: 'Riverton Athletic FC', orgType: 'professional club', country: 'GB',
    website: 'https://www.rivertonathletic.com', domain: 'rivertonathletic.com',
    applicantName: 'Priya Nair', applicantRole: 'Club Secretary', workEmail: 'priya.nair@rivertonathletic.com',
  }),
});
const rootReq = r.body;
const rootCode = await outboxCode('priya.nair@rivertonathletic.com');
await j(`/auth/org/verification/apply/${rootReq.requestId}/confirm-email`, { method: 'POST', body: JSON.stringify({ applicantSecret: rootReq.applicantSecret, code: rootCode }) });
await j(`/auth/org/verification/apply/${rootReq.requestId}/evidence`, { method: 'POST', body: JSON.stringify({ applicantSecret: rootReq.applicantSecret, note: 'FA affiliation number 88213; company no. 0141522' }) });
r = await j(`/auth/org/verification/apply/${rootReq.requestId}/submit`, { method: 'POST', body: JSON.stringify({ applicantSecret: rootReq.applicantSecret }) });
if (r.body.status !== 'requires_human_review') fail('root application did not stop at the human boundary');
say('L3: new club application collected evidence and stopped at requires_human_review');

const admin = await ctxAdmin.newPage();
admin.on('dialog', (d) => d.accept('Registry + federation listing match the submitted evidence.'));
await admin.goto('http://localhost:8394/');
await admin.fill('input[placeholder="Admin key"]', 'scoutbox-admin');
await admin.click('button:has-text("Enter")');
await admin.getByRole('button', { name: 'Verification', exact: true }).click();
await admin.waitForSelector('text=Riverton Athletic FC', { timeout: 15000 });
const caseText = await admin.locator('.list-row', { hasText: 'Riverton Athletic FC' }).innerText();
if (!caseText.includes('mailbox proved') || !caseText.includes('dnsOwnership=not_configured')) fail('prepared case missing honest check results');
await admin.locator('.list-row', { hasText: 'Riverton Athletic FC' }).locator('button:has-text("Approve org + root admin")').click();
await admin.waitForSelector('text=Organisation verified; root administrator established.', { timeout: 15000 });
r = await j('/orgs?platform=main');
if (!r.body.some((o) => o.name === 'Riverton Athletic FC' && o.verified)) fail('approved organisation not verified');
say('L3: Trust & Safety approved the prepared case — organisation + first root admin established');

// ================================================================ L5
await scout.locator('input[aria-label="Dispute reason"]').first().fill('My departure date is wrong — I worked through July.');
await scout.locator('button:has-text("Dispute")').first().click();
await scout.waitForSelector('text=Trust & Safety reviews the dispute', { timeout: 15000 });
await admin.click('nav.sidebar button:has-text("Cases")');
await admin.click('nav.subnav button:has-text("Ver. disputes")');
await admin.waitForSelector('text=worked through July', { timeout: 15000 });
await admin.locator('.list-row', { hasText: 'worked through July' }).locator('button:has-text("Uphold + correct")').click();
await admin.waitForSelector('text=Dispute resolved with a correction.', { timeout: 15000 });
say('L5: dispute travelled to the T&S console and was resolved with a written reason');

// ================================================================ L6
const inv = await j('/org/verification/player-invites', { method: 'POST', body: JSON.stringify({ name: 'Guardian Child', squad: 'U17' }) }, bearer(maria.token));
if (inv.status !== 201 || !inv.body.code) fail('verified club could not mint an invitation');
const guardian = await ctxGuardian.newPage();
await guardian.goto('http://localhost:8391/');
await guardian.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await guardian.locator('text=Enter').last().click();
await guardian.waitForSelector('text=Guardian', { timeout: 20000 });
await guardian.waitForSelector('text=Join a club squad', { timeout: 25000 });
const gNote = await guardian.locator('body').innerText();
if (!gNote.includes('accepted by you, the guardian')) fail('guardian invite section missing the guardian-only wording');
await guardian.locator('input[placeholder="Invitation code"]').first().fill(inv.body.code);
await guardian.getByText('Accept', { exact: true }).locator('visible=true').first().click();
await guardian.waitForSelector('text=✅', { timeout: 15000 });
say('L6: guardian accepted the squad invitation for the minor (child never in the loop)');

// Verified professionals still cannot bypass safeguarding — live negatives.
const amara = (await j('/auth/guardian/login', { method: 'POST', body: JSON.stringify({ guardianId: 'gd-amara' }) })).body;
const kids = (await j('/guardian/children', {}, bearer(amara.token))).body;
const minorId = (Array.isArray(kids) ? kids : kids.children ?? [])[0]?.id;
const agency = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Agent' }) })).body;
r = await j('/org/representation/propose', { method: 'POST', body: JSON.stringify({ playerId: minorId, scope: 'full_representation' }) }, bearer(agency.token));
if (r.status !== 403) fail(`agency representation of a minor was not refused (got ${r.status})`);
say('L6: agency representation of a minor still 403s — verification bypasses nothing');

// ================================================================ L7
const dee = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Coach', role: 'Manager', platform: 'grassroots' }) })).body;
await j('/admin/verification/orgs/org-hackneymarsh/appoint-root', { method: 'POST', body: JSON.stringify({ userId: dee.userId, reason: 'live test: grassroots committee chair' }) }, A);
const grass = await clubLogin(ctxGrass, 'Hackney Marsh', 'Dee Coach', 8393);
await grass.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await grass.waitForSelector('text=Verify your football role', { timeout: 15000 });
await grass.click('button[role="tab"]:has-text("Requests")');
await grass.waitForSelector('text=No pending requests.', { timeout: 15000 });
await grass.click('button[role="tab"]:has-text("Staff")');
await grass.waitForTimeout(600);
const grassText = await grass.locator('body').innerText();
if (grassText.includes('Tom Field') || grassText.includes('Maria Keane')) fail('cross-tenant leak: club B sees club A people');
say('L7: second club\'s console holds only its own tenant — no cross-club rows');

await browser.close();
console.log('\nm14Live: L1–L7 all passed (separate contexts, live backend)');
process.exit(0);
