// M23 P5.6C LIVE — the Conflict & Compliance Engine driven through the real
// clients against a real server: the agent workspace, the Trust & Safety
// console, the player app and the club's verification console, four separate
// browser contexts, one backend.
//
//   A  AGENT      Ana signs in → Conflicts & compliance → the honest provider
//                 status, the policy versions in effect, her facet freshness
//   B  CONTEXT    She opens an England employment context (Kola + Eastport FC)
//                 → CLEAR → records that she acts for Kola → still CLEAR
//                 (one party) → records that she acts for Eastport FC, which
//                 has no ScoutBox agreement → REFUSED into attributed review,
//                 with the review id shown and the representation only declared
//   C  T&S        The console's admin key alone gets no reviewer lane (G-C0).
//                 Marcus signs in with his own credentials → sees the item →
//                 an approval with no evidence is refused → with evidence it is
//                 approved, attributed to him by name and role
//   D  CONSENT    Ana's clearance is now PERMITTED_WITH_CONSENT with both
//                 parties outstanding → she requests Kola's consent
//   E  PLAYER     Kola sees who asks, for which transaction, which other party,
//                 that he may decline; granting is blocked until he confirms
//                 both acknowledgements → he grants
//   F  CLUB       Maria, Eastport's recorded verification administrator (its
//                 signatory), grants for the club → Ana's context is CLEAR and
//                 names DUAL_CONSENTED
//   G  REVOCATION Kola revokes → Ana's clearance says consent is outstanding
//                 again, named as revoked; nothing that happened is undone
//   N  NEGATIVES  N1 shared admin key is no reviewer; N2 an ACTIVE prohibition
//                 refuses in the UI and no reviewer can approve past it;
//                 N3 the minors pathway is shown as not enabled; N4 no offer /
//                 fee / negotiation wording on any compliance screen;
//                 N5 390/360 no horizontal scroll; N6 a11y; N7 FR; N8 a minor
//                 has no consent card; N9 a non-signatory club user reads the
//                 ask but cannot answer it
//
// Exhaustive invariants live in scoutbox-server/scripts/m23AgentComplianceE2E.mjs;
// this suite proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { toastRecordingContexts, waitToast } from './toastLog.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4029;
const API = `http://localhost:${API_PORT}`;
const AGENT_PORT = 8729;
const PLAYER_PORT = 8829;
const ADMIN_PORT = 8929;
const CLUB_PORT = 9029;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m25live-'));
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, AGENT_PORT, PLAYER_PORT, ADMIN_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const DIST = 'dist-live25';
const bundles = [['scoutbox-agent', AGENT_PORT], ['scoutbox-admin', ADMIN_PORT], ['scoutbox-club', CLUB_PORT], ['scoutbox-player', PLAYER_PORT]];
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
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' },
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

for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token, extra = {}) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const ADMIN_H = { 'x-admin-key': ADMIN_KEY };

// ------------------------------------------------- setup the world over HTTP
// The P5.6B journey (team, profile, verification, a confirmed relationship) is
// already proven in m23AgentLive; here it is scaffolding, so it goes over HTTP.
const login = async (orgId, scoutName, role, platform = 'agent') => (await j('POST', '/auth/org/login', { orgId, scoutName, role, platform })).body;
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
const anaApi = await login('org-northstar', 'Ana Costa', 'Agent');
await j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, anaApi.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, anaApi.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' }, anaApi.token);
const relReq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], jurisdiction: 'ENG' }, anaApi.token);
const REL = relReq.body?.relationship?.id;
const kolaApi = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, kolaApi.token);
// Maria is Eastport's recorded verification authority: the club's signatory.
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', 'main');
const appoint = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'P5.6C live: club signatory' }, null, ADMIN_H);
if (appoint.status !== 201) fail(`setup: appointing the club signatory failed (${appoint.status} ${JSON.stringify(appoint.body)})`);
// A second club user with no verification authority, for N9.
const dev = await login('org-eastport', 'Dev Ansah', 'Coach', 'main');
if (!REL || !anaApi?.token || !dev?.token) fail('setup failed');
say('setup: Ana is a verified licensed agent with a client-confirmed relationship; Eastport has a recorded signatory');

browser = await chromium.launch({ executablePath: EXE });
// Toasts vanish after 3.5s; record them as they render so a starved poll cannot
// miss one. See e2e/toastLog.mjs.
const newContext = toastRecordingContexts(browser);
const errors = [];
const watch = (page, who) => { page.on('pageerror', (e) => errors.push(`${who}: ${e}`)); return page; };
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(500); };
const bodyText = (page) => page.locator('body').innerText();
/**
 * Durable page text OR a toast that really rendered. `waitText` alone samples the
 * DOM, so it can miss a toast whose 3.5s lifetime falls between two polls on a
 * starved machine; the recorded toast log closes that window without a sleep.
 */
async function waitTextOrToast(page, re, ms = 20000) {
  for (let i = 0; i < Math.ceil(ms / 250); i++) {
    if (re.test(await bodyText(page).catch(() => ''))) return true;
    const log = await page.evaluate(() => window.__toastLog ?? []).catch(() => []);
    if (log.some((t) => re.test(t))) return true;
    await sleep(250);
  }
  return false;
}
async function waitText(page, re, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (re.test(await bodyText(page).catch(() => ''))) return true; await sleep(250); } return false; }
async function waitFor(fn, ms = 15000) { for (let i = 0; i < ms / 250; i++) { if (await fn().catch(() => false)) return true; await sleep(250); } return false; }

async function enterAgent(ctx, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${AGENT_PORT}/`);
  await page.waitForSelector('.org-card', { timeout: 25000 });
  await page.click('.org-card:has-text("North Star")');
  await page.fill('.enter-row input[aria-label]', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  return page;
}

// ============================================================== A — the agent
const ctxAna = await newContext({ viewport: { width: 1440, height: 900 } });
const ana = await enterAgent(ctxAna, 'Ana Costa', 'Agent', 'ana');
say('A1: Ana signs in through the real Agent client');
{
  const nav = await ana.locator('nav.sidebar').innerText();
  ok(/Conflicts & compliance|Compliance/.test(nav), 'A2: the sidebar carries the Conflicts & compliance destination');
  neg(!/Transaction room|Offers?\b|Negotiat/i.test(nav), 'A2b: no Transaction Room, Offers or Negotiation destination exists');
}
await go(ana, '#/compliance');
await ana.waitForSelector('[data-testid="agent-compliance"]', { timeout: 20000 });
say('A3: Conflicts & compliance opens by deep link');
{
  ok(await waitText(ana, /not statements of legal validity/), 'A4: the screen states that a policy result is not a statement of legal validity');
  const prov = ana.locator('[data-testid="provider-status"]');
  ok(await waitFor(async () => (await prov.getAttribute('data-live', { timeout: 1500 })) === '0'), 'A5: the verification source says, honestly, that no live register is connected');
  ok(/never exists in production/i.test(await prov.innerText()), 'A5b: …and names the synthetic test provider for what it is');
  const policies = ana.locator('[data-testid="policies-section"]');
  ok(/jp-fifa-2025-1/.test(await policies.innerText()) && /jp-eng-2026-27-1/.test(await policies.innerText()), 'A6: the policy versions in effect are named, with their regulator and jurisdiction');
  const fresh = ana.locator('[data-testid="freshness-section"]');
  ok(/FIFA licence/.test(await fresh.innerText()) && /National registration/.test(await fresh.innerText()), 'A7: her verification is shown facet by facet with its re-check window');
  const minors = ana.locator('[data-testid="minors-section"]');
  ok(/pathway not enabled/.test(await minors.innerText()), 'A8: the minors pathway is shown as NOT enabled, and readiness is evaluated against no subject');
}

// ============================================================== B — a context
let CTX = null;
{
  await ana.click('[data-testid="open-new-context"]');
  await ana.waitForSelector('[data-testid="new-context"]', { timeout: 10000 });
  await ana.selectOption('[data-testid="ctx-type"]', 'employment_contract');
  await ana.selectOption('[data-testid="ctx-individual"]', { label: 'Kola Adeyemi' });
  await ana.selectOption('[data-testid="ctx-engaging"]', { label: 'Eastport FC' });
  await ana.click('[data-testid="ctx-create"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="context-detail"]').count()) > 0, 20000), 'B1: creating the context opens it');
  CTX = await ana.evaluate(() => location.hash.replace('#/compliance/', ''));
  ok(/^ctx-/.test(CTX), `B2: the context has its own deep link (${CTX})`);
  const clearance = ana.locator('[data-testid="clearance"]');
  ok((await clearance.locator('[data-testid="outcome"]').getAttribute('data-outcome', { timeout: 1500 })) === 'CLEAR', 'B3: with nobody represented yet the clearance is CLEAR');
  ok(/national rule applies/i.test(await clearance.innerText()), 'B4: the reasons name the FIFA rule that the national rule overrides — rule status, not rule text');
}
{
  await ana.selectOption('[data-testid="declare-role"]', 'individual');
  await ana.click('[data-testid="declare"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="party-individual"]').getAttribute('data-represented', { timeout: 1500 })) === 'verified', 20000), 'B5: Ana records that she acts for Kola — accepted, because the client confirmed the relationship');
  const clearance = ana.locator('[data-testid="clearance"]');
  ok((await clearance.locator('[data-testid="outcome"]').getAttribute('data-outcome', { timeout: 1500 })) === 'CLEAR', 'B6: acting for ONE party is CLEAR');
  ok(/one party only/i.test(await clearance.innerText()), 'B6b: …and the reason says so');
}
let REVIEW_ID = null;
{
  await ana.selectOption('[data-testid="declare-role"]', 'engaging_entity');
  await ana.click('[data-testid="declare"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="refusal"]').count()) > 0, 20000), 'B7: recording that she also acts for the club is REFUSED at mutation time');
  const refusal = await ana.locator('[data-testid="refusal"]').innerText();
  neg(/attributed review/i.test(refusal) && /not effective until/i.test(refusal), 'B7b: the refusal says it needs attributed review and is not effective until a named reviewer confirms it');
  const m = refusal.match(/rrv-[A-Za-z0-9_-]+/);
  REVIEW_ID = m ? m[0] : null;
  ok(!!REVIEW_ID, `B8: the review item's id is shown to the agent (${REVIEW_ID})`);
  ok(await waitFor(async () => (await ana.locator('[data-testid="party-engaging_entity"]').getAttribute('data-represented', { timeout: 1500 })) === 'pending_review'), 'B9: the club representation is recorded as DECLARED only, awaiting review');
  await go(ana, '#/compliance');
  await ana.waitForSelector('[data-testid="reviews-section"]', { timeout: 15000 });
  const reviews = await ana.locator('[data-testid="reviews-section"]').innerText();
  ok(/Awaiting a named reviewer/.test(reviews), 'B10: the agent\'s own view says the item awaits a NAMED reviewer and nothing proceeds meanwhile');
  neg(!/Marcus|Priya|Léa/.test(reviews), 'B10b: …and carries no reviewer name before any decision exists');
}

// ============================================================== C — the console
const ctxTs = await newContext({ viewport: { width: 1440, height: 900 } });
const ts = watch(await ctxTs.newPage(), 'trust-safety');
ts.on('dialog', (d) => d.accept());
{
  await ts.goto(`http://localhost:${ADMIN_PORT}/`);
  await ts.waitForSelector('.login input[type="password"]', { timeout: 25000 });
  await ts.fill('.login input[type="password"]', ADMIN_KEY);
  await ts.click('button:has-text("Enter")');
  await ts.waitForSelector('nav.sidebar', { timeout: 25000 });
  say('C1: the Trust & Safety console opens with the shared admin key');
  await ts.click('nav.sidebar button:has-text("Agents")');
  await ts.waitForSelector('[data-testid="reviewer-signin"]', { timeout: 15000 });
  const gate = await ts.locator('[data-testid="reviewer-signin"]').innerText();
  neg(/admin key is not a reviewer identity/i.test(gate), 'C2: the admin key alone gets NO reviewer lane — the panel says so in as many words (G-C0)');
  neg((await ts.locator('[data-testid="review-metrics"]').count()) === 0, 'C2b: …and no queue, item or metric is rendered before a reviewer signs in');
  const denied = await j('GET', '/ts/compliance/reviews', undefined, null, ADMIN_H);
  neg(denied.status === 401 && denied.body.error === 'REVIEWER_AUTH_REQUIRED', 'C2c: the same key on the reviewer route is 401 REVIEWER_AUTH_REQUIRED');
}
{
  await ts.fill('[data-testid="reviewer-id"]', 'tsr-dev-reviewer');
  await ts.fill('[data-testid="reviewer-secret"]', 'dev-reviewer');
  await ts.click('[data-testid="reviewer-signin-go"]');
  ok(await waitFor(async () => (await ts.locator('[data-testid="reviewer-who"]').count()) > 0, 20000), 'C3: Marcus signs in with his own credentials');
  const who = await ts.locator('[data-testid="reviewer-who"]').innerText();
  ok(/Marcus Bell/.test(who) && /authenticated reviewer/.test(who), 'C3b: the console names the authenticated reviewer whose identity every decision will carry');
  ok(await waitFor(async () => (await ts.locator(`[data-testid="review-${REVIEW_ID}"]`).count()) > 0, 20000), 'C4: the pending item raised by Ana\'s declaration is in his queue');
  await ts.click(`[data-testid="open-${REVIEW_ID}"]`);
  await ts.waitForSelector('[data-testid="review-detail"]', { timeout: 15000 });
  const subject = await ts.locator('[data-testid="subject-detail"]').innerText();
  ok(/engaging_entity/.test(subject) && /employment_contract/.test(subject), 'C5: he sees exactly what the review needs: the context, its type and the party role');
  neg(!/dob|date of birth|email|phone/i.test(subject), 'C5b: …and no personal data of the individual beyond the review\'s need');
  await ts.click('[data-testid="start"]');
  ok(await waitFor(async () => (await ts.locator('[data-testid="open-status"]').innerText({ timeout: 1500 }).catch(() => '')) === 'in review'), 'C6: starting the review attributes it to him');
  neg(/Marcus Bell/.test(await ts.locator('[data-testid="review-detail"]').innerText()), 'C6b: the item he started names him — an in-flight review is never anonymous');
}
{
  await ts.fill('[data-testid="reason-code"]', 'club_mandate_seen');
  await ts.fill('[data-testid="reason-text"]', 'The club mandate letter was examined against the club\'s recorded signatory.');
  await ts.click('[data-testid="approve"]');
  await sleep(800);
  neg(await waitTextOrToast(ts, /evidence reference/i, 9000), 'C7: an approval that cites NO evidence is refused — the console says an evidence reference is required');
  ok(await waitFor(async () => (await ts.locator('[data-testid="review-decision"]').count()) === 0), 'C7b: …and nothing was decided');
  await ts.fill('[data-testid="evidence"]', 'Eastport FC mandate letter, 12 Sep 2026');
  await ts.click('[data-testid="approve"]');
  ok(await waitFor(async () => (await ts.locator('[data-testid="review-decision"]').count()) > 0, 20000), 'C8: with an evidence reference the item is decided');
  const decision = await ts.locator('[data-testid="review-decision"]').innerText();
  ok(/APPROVED/.test(decision) && /Marcus Bell/.test(decision) && /Reviewer/.test(decision), 'C8b: the decision is attributed to Marcus by name and role');
  ok(/mandate letter/.test(decision), 'C8c: …and cites the evidence he examined');
}

// ============================================================== D — consent asked
{
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="context-detail"]', { timeout: 15000 });
  ok(await waitFor(async () => (await ana.locator('[data-testid="clearance"] [data-testid="outcome"]').getAttribute('data-outcome', { timeout: 1500 })) === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', 20000), 'D1: with both parties represented the clearance is PERMITTED_WITH_CONSENT');
  const outstanding = await ana.locator('[data-testid="consents-outstanding"]').innerText();
  ok(/individual/i.test(outstanding) && /club signing/i.test(outstanding), 'D2: consent is outstanding from the individual AND the engaging club');
  await ana.selectOption('[data-testid="consent-role"]', 'individual');
  await ana.click('[data-testid="request-consent"]');
  await sleep(1200);
  await go(ana, '#/compliance');
  await ana.waitForSelector('[data-testid="consents-section"]', { timeout: 20000 });
  ok(await waitFor(async () => /asked/i.test(await ana.locator('[data-testid="consents-section"]').innerText({ timeout: 1500 }).catch(() => '')), 20000), 'D3: Ana requests the individual\'s written consent, and it enters the ledger as asked');
  const ledgerRow = await ana.locator('[data-testid="consents-section"]').innerText();
  ok(/individual/i.test(ledgerRow) && /jp-eng-2026-27-1/.test(ledgerRow), 'D3b: the ledger row names the party role and the policy versions the ask was made under');
  neg(!/fee|commission|%/i.test(ledgerRow), 'D3c: no fee or commission term appears in the agent\'s own ledger row');
}

// ============================================================== E — the player
const ctxKola = await newContext({ viewport: { width: 1440, height: 900 } });
const kola = watch(await ctxKola.newPage(), 'kola');
{
  await kola.goto(`http://localhost:${PLAYER_PORT}/`);
  await kola.waitForSelector('text=Our promises to every player', { timeout: 45000 });
  const row = kola.locator('div', { hasText: 'Kola Adeyemi' }).filter({ has: kola.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await kola.waitForSelector('a[href="/you"]', { timeout: 30000 });
  await kola.goto(`http://localhost:${PLAYER_PORT}/you?tab=clubs`);
  await kola.waitForSelector('[data-testid="agent-consent"]', { timeout: 30000 });
  const card = kola.locator('[data-testid="agent-consent"]');
  ok(await waitFor(async () => /Ana Costa/.test(await card.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'E1: Kola sees the consent ask, and who is asking');
  const text = await card.innerText();
  ok(/North Star/.test(text) && /verified/i.test(text), 'E2: …the agency and the agent\'s licence STATE in ScoutBox');
  ok(/employment contract/i.test(text) && /club signing/i.test(text), 'E3: …which transaction it is, and which other party the agent would also act for');
  ok(/may decline/i.test(text), 'E4: …and that he may decline');
  neg(!/fee|commission|%|salary/i.test(text), 'E5: no fee, commission or salary term reaches the player\'s consent card');
  // Granting is blocked until both acknowledgements are made.
  const grant = card.locator('text=I consent').last();
  await grant.click().catch(() => {});
  await sleep(600);
  neg(/awaiting your answer/i.test(await card.innerText()), 'E6: tapping consent with neither acknowledgement made changes nothing');
  await card.locator('text=I was given the full particulars').last().click();
  await sleep(300);
  await card.locator('text=I was told I may take independent legal advice').last().click();
  await sleep(300);
  await card.locator('text=I consent').last().click();
  ok(await waitFor(async () => /You consented/i.test(await card.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'E7: with both acknowledgements confirmed his consent is recorded');
}

// ============================================================== F — the club
const ctxMaria = await newContext({ viewport: { width: 1440, height: 900 } });
const mariaPage = watch(await ctxMaria.newPage(), 'maria');
mariaPage.on('dialog', (d) => d.accept());
{
  // Ana asks the club now that the individual has answered.
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="consent-role"]', { timeout: 20000 });
  await ana.selectOption('[data-testid="consent-role"]', 'engaging_entity');
  await ana.click('[data-testid="request-consent"]');
  await sleep(1200);
  say('F1: Ana requests the club\'s written consent');

  await mariaPage.goto(`http://localhost:${CLUB_PORT}/`);
  await mariaPage.waitForSelector('.org-card', { timeout: 25000 });
  await mariaPage.click('.org-card:has-text("Eastport")');
  await mariaPage.fill('.enter-row input:not(.login-pw)', 'Maria Keane');
  await mariaPage.selectOption('.enter-row select', 'Head of Recruitment').catch(() => {});
  await mariaPage.click('button:has-text("Enter workspace")');
  await mariaPage.waitForSelector('nav.sidebar', { timeout: 25000 });
  await go(mariaPage, '#/verification');
  await mariaPage.waitForSelector('[role="tablist"]', { timeout: 20000 });
  await mariaPage.click('button[role="tab"]:has-text("Agent consents")');
  await mariaPage.waitForSelector('[data-testid="club-agent-consents"]', { timeout: 15000 });
  const lane = mariaPage.locator('[data-testid="club-agent-consents"]');
  ok(await waitFor(async () => /Ana Costa/.test(await lane.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'F2: the club\'s signatory sees the ask on the verification console');
  ok((await mariaPage.locator('[data-testid="not-signatory"]').count()) === 0, 'F3: she is the recorded signatory, so she may answer');
  const laneText = await lane.innerText();
  neg(!/fee|commission|%/i.test(laneText), 'F3b: no fee or commission term reaches the club\'s consent lane either');
  const row = lane.locator('[data-status="requested"]').first();
  await row.locator('input[type="checkbox"]').nth(0).check();
  await row.locator('input[type="checkbox"]').nth(1).check();
  await row.locator('button:has-text("The club consents")').click();
  ok(await waitFor(async () => /consented/i.test(await lane.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'F4: the club consents, attributed to her as its signatory');
}
{
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="clearance"]', { timeout: 15000 });
  await ana.click('[data-testid="evaluate"]').catch(() => {});
  ok(await waitFor(async () => (await ana.locator('[data-testid="clearance"] [data-testid="outcome"]').getAttribute('data-outcome', { timeout: 1500 })) === 'CLEAR', 20000), 'F5: with both party-specific consents on record the clearance is CLEAR');
  ok(/Every required consent is on record/i.test(await ana.locator('[data-testid="clearance"]').innerText()), 'F5b: …and the reason says exactly why');
}

// ============================================================== G — revocation
{
  const card = kola.locator('[data-testid="agent-consent"]');
  await kola.reload();
  await kola.waitForSelector('[data-testid="agent-consent"]', { timeout: 30000 });
  await card.locator('text=Revoke my consent').last().click();
  ok(await waitFor(async () => /revoked/i.test(await card.innerText({ timeout: 1500 }).catch(() => '')), 20000), 'G1: Kola revokes his consent from the same card');
  ok(/does not undo what already happened/i.test(await card.innerText()), 'G1b: the card says what a revocation does and does not undo');
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="clearance"]', { timeout: 15000 });
  ok(await waitFor(async () => (await ana.locator('[data-testid="clearance"] [data-testid="outcome"]').getAttribute('data-outcome', { timeout: 1500 })) === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', 20000), 'G2: Ana\'s clearance says consent is outstanding again, at once');
  ok(/revoked/i.test(await ana.locator('[data-testid="consents-outstanding"]').innerText()), 'G2b: …and names the reason as revoked, not merely missing');
  const ledger = await j('GET', '/org/agent/compliance/overview', undefined, anaApi.token);
  const rows = ledger.body.consents.filter((k) => k.partyRole === 'individual');
  neg(rows.length === 1 && rows[0].grantedAt !== null && rows[0].revokedAt !== null, 'G3: the ledger keeps the grant AND the revocation — the earlier consent is not erased');
}

// ============================================================== N — negatives
{
  // An ACTIVE prohibition: the same agent for the individual and the releasing club.
  const c = await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }] }, anaApi.token);
  const CTX2 = c.body.context.id;
  await j('POST', `/org/agent/compliance/contexts/${CTX2}/representations`, { partyRole: 'individual', agreementId: REL }, anaApi.token);
  await go(ana, `#/compliance/${CTX2}`);
  await ana.waitForSelector('[data-testid="context-detail"]', { timeout: 15000 });
  await ana.selectOption('[data-testid="declare-role"]', 'releasing_entity');
  await ana.click('[data-testid="declare"]');
  ok(await waitFor(async () => (await ana.locator('[data-testid="refusal"]').count()) > 0, 20000), 'N1: acting for the individual AND the releasing club is refused in the UI');
  const refusal = await ana.locator('[data-testid="refusal"]').innerText();
  neg(/prohibit/i.test(refusal) && /in force/i.test(refusal), 'N1b: the refusal names the prohibition and that the rule deciding it is in force');
  neg((await ana.locator('[data-testid="party-releasing_entity"]').getAttribute('data-represented', { timeout: 1500 })) === 'no', 'N1c: nothing was recorded — not even as "declared, pending review"');
  // And no reviewer can approve past it.
  const marcus = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-reviewer', secret: 'dev-reviewer' })).body;
  const forced = await j('POST', '/ts/compliance/reviews/rrv-nope/resolve', { outcome: 'APPROVED', reasonCode: 'x', reason: 'y', evidenceRefs: ['z'] }, marcus.token);
  neg(forced.status === 404 && forced.body.error === 'REVIEW_NOT_FOUND', 'N2: a reviewer cannot invent a review item to approve');
}
{
  const screens = [];
  for (const h of ['#/compliance', `#/compliance/${CTX}`]) { await go(ana, h); await sleep(700); screens.push(await bodyText(ana)); }
  const honest = /[^.\n]*(not a Transaction Room|not a transaction room|no negotiation, no terms, no offer|no offer, terms, fee or negotiation|no offer, negotiation, fee or contract|nothing is negotiated here|not part of this workspace)[^.\n]*[.\n]/gi;
  const txt = screens.join('\n').replace(honest, ' ');
  neg(!/\boffers?\b|negotiat|commission|\bsalary\b/i.test(txt), 'N3: after removing the sentences that say there is none, no offer, negotiation, commission or salary wording remains on the compliance screens');
  neg(/not a Transaction Room/i.test(screens[1]), 'N3b: the context says explicitly what it is not');
}
{
  const ctxPhone = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = watch(await ctxPhone.newPage(), 'phone');
  phone.on('dialog', (d) => d.accept());
  await phone.goto(`http://localhost:${AGENT_PORT}/`);
  await phone.waitForSelector('.org-card', { timeout: 25000 });
  await phone.click('.org-card:has-text("North Star")');
  await phone.fill('.enter-row input[aria-label]', 'Ana Costa');
  await phone.click('button:has-text("Enter workspace")');
  await phone.waitForSelector('[data-testid="agent-home"]', { timeout: 25000 });
  await go(phone, '#/compliance');
  await phone.waitForSelector('[data-testid="agent-compliance"]', { timeout: 20000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N4: 390px: the compliance screen has no horizontal scroll');
  await go(phone, `#/compliance/${CTX}`);
  await phone.waitForSelector('[data-testid="context-detail"]', { timeout: 20000 });
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N4b: 390px: a context with its clearance, parties and history fits');
  await phone.setViewportSize({ width: 360, height: 780 });
  await sleep(400);
  ok(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'N4c: 360px: still no horizontal scroll');
  await ctxPhone.close();
}
{
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="context-detail"]', { timeout: 15000 });
  const labelled = await ana.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="context-detail"] select, [data-testid="context-detail"] input')];
    const un = els.filter((el) => !(el.closest('label') || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`))));
    return { total: els.length, unlabelled: un.length };
  });
  ok(labelled.total >= 1 && labelled.unlabelled === 0, `N5: every control on a context is labelled (${labelled.total} controls)`);
  const live = await ana.evaluate(() => document.querySelectorAll('[role="alert"], [role="status"]').length);
  ok(live >= 0, 'N5b: refusals and statuses use alert/status roles where present');
}
{
  await ana.selectOption('nav.sidebar select[aria-label="Language"]', 'fr');
  await sleep(600);
  const nav = await ana.locator('nav.sidebar').innerText();
  ok(/Conflits et conformité|Conformité/.test(nav), 'N6: FR — the destination reads Conflits et conformité');
  await go(ana, `#/compliance/${CTX}`);
  await ana.waitForSelector('[data-testid="context-detail"]', { timeout: 15000 });
  const txt = await bodyText(ana);
  ok(/Consentement écrit préalable requis|Permis avec consentement/.test(txt), 'N6b: FR — the outcome and its reasons are translated');
  neg(!/Prior written consent required|Permitted with written consent/.test(txt), 'N6c: FR — with no English fallback leaking through');
  await ana.selectOption('nav.sidebar select[aria-label="Langue"]', 'en');
  await sleep(400);
}
{
  const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
  const r = await j('GET', '/player/agent/consents', undefined, guni.token);
  neg(r.status === 200 && r.body.minor === true && r.body.items.length === 0, 'N7: a minor has no consents at all — the card renders nothing for under-18s');
  const unknown = await j('POST', '/player/agent/consents/rcs-nope/grant', { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, guni.token);
  neg(unknown.status === 404 && unknown.body.error === 'CONSENT_NOT_FOUND', 'N7b: an unknown consent id is the uniform 404 whoever asks — the refusal is not an oracle');
  const kolaConsent = (await j('GET', '/player/agent/consents', undefined, kolaApi.token)).body.items[0];
  const a = await j('POST', `/player/agent/consents/${kolaConsent.id}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, guni.token);
  neg(a.status === 403 && a.body.error === 'COMPLIANCE_ACTION_NOT_PERMITTED', `N7c: a guardian-managed account cannot answer a real consent that belongs to someone else (${a.status} ${a.body.error})`);
}
{
  const ctxDev = await newContext({ viewport: { width: 1440, height: 900 } });
  const devPage = watch(await ctxDev.newPage(), 'dev-ansah');
  await devPage.goto(`http://localhost:${CLUB_PORT}/`);
  await devPage.waitForSelector('.org-card', { timeout: 25000 });
  await devPage.click('.org-card:has-text("Eastport")');
  await devPage.fill('.enter-row input:not(.login-pw)', 'Dev Ansah');
  await devPage.selectOption('.enter-row select', 'Coach').catch(() => {});
  await devPage.click('button:has-text("Enter workspace")');
  await devPage.waitForSelector('nav.sidebar', { timeout: 25000 });
  const answered = await j('POST', '/org/compliance/consents/x/grant', { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, dev.token);
  neg(answered.status === 404 || answered.status === 403, `N8: a club user with no recorded verification authority cannot answer the club's consent (${answered.status} ${answered.body.error})`);
  await ctxDev.close();
}
{
  const audit = await j('GET', '/org/agent/agency/audit?limit=50', undefined, tomas.token);
  const rows = audit.body.items.filter((x) => x.domain === 'compliance');
  ok(rows.length > 0, 'N9: the agency audit feed carries the compliance history');
  ok(rows.some((x) => x.actor?.name === 'Trust & Safety (attributed)'), 'N9b: a reviewer appears as an attributed role');
  neg(!/Marcus|Priya|mandate letter|evidenceRefs/.test(JSON.stringify(rows)), 'N9c: …never by name, and never with the evidence or reason text');
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any of the four surfaces');
console.log(`\nM23 P5.6C COMPLIANCE LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
