// M23 P3 LIVE — the Contact workflow, driven through the real Pro workspace
// and the real player app against a real server.
//
//   A  ADULT      lead opens a room for Kola (adult) → the Contact tab is a
//                 page-local tab, not a nav item → gated until Contact planned
//                 → a draft changes nothing the player can see → Send →
//                 the case moves to Contacted → Kola reads it in his Inbox at
//                 390px, replies, accepts → the lead sees the response on the
//                 Contact, and the case does NOT move again
//   M  MINOR      lead opens a room for Guni (14) → routing says guardian →
//                 Send → Amara reads it in the Guardian screen at 390px,
//                 replies, declines → Guni's own Updates carry the outcome,
//                 never the message → the lead sees the guardian's answer
//   N  NEGATIVES  no valid guardian route fails closed in the UI and the API;
//                 a block placed after delivery refuses accept but not decline;
//                 a contributor sees history read-only and is refused on write;
//                 a foreign organisation gets the concealing 404; the
//                 sentinel in an unsent draft reaches no recipient surface;
//                 390px: the Contact tab has no horizontal scroll
//
// Every refusal here asserts its exact status AND code. The exhaustive
// invariants live in scoutbox-server/scripts/m23ContactE2E.mjs; this suite
// proves the real interfaces drive them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4024;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8724;
const PLAYER_PORT = 8824;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m23contactlive-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const SENTINEL = 'PRIVATE_ROOM_SENTINEL_123';

let passed = 0;
let negatives = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const neg = (cond, m) => { negatives++; ok(cond, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Assert an exact status AND an exact error code. Never "not 200". */
const expect = (res, status, code, what) => {
  if (res.status !== status) fail(`${what}: expected ${status}${code ? ` ${code}` : ''}, got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  if (code && res.body?.error !== code) fail(`${what}: expected error ${code}, got ${JSON.stringify(res.body?.error)}`);
  negatives++;
  say(what);
};

for (const port of [API_PORT, CLUB_PORT, PLAYER_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

// KEEP_DIST=1 reuses bundles from a previous run while iterating on the suite itself.
const KEEP = process.env.KEEP_DIST === '1';
const haveDist = fs.existsSync(path.join(ROOT, 'scoutbox-club/dist-live23c/index.html')) && fs.existsSync(path.join(ROOT, 'scoutbox-player/dist-live23c/index.html'));
if (KEEP && haveDist) console.log('reusing live bundles (KEEP_DIST=1)');
else {
  console.log(`building live bundles for :${API_PORT}…`);
  execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live23c`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
  execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live23c`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });
}

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
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
serveDir('scoutbox-club/dist-live23c', CLUB_PORT);
serveDir('scoutbox-player/dist-live23c', PLAYER_PORT);

let browser = null;
const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  if (!KEEP) {
    fs.rmSync(path.join(ROOT, 'scoutbox-club/dist-live23c'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'scoutbox-player/dist-live23c'), { recursive: true, force: true });
  }
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
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e}`));
  return page;
};

// --------------------------------------------------------------- club helpers

/** Log in through the real client and hand back the session it stored. */
async function enterClub(ctx, org, name, role, who) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 25000 });
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
  });
  if (!token) fail(`${name}: the client stored no session token after login`);
  return { page, token };
}

/** Open a Room for a named player through the UI (search → drawer → Add to Recruitment Room). */
async function openRoomFor(page, playerName) {
  await page.evaluate(() => { location.hash = '#/search'; });
  await page.waitForSelector('.player-card:not(.skeleton)', { timeout: 25000 });
  const card = page.locator(`.player-card:has-text("${playerName}")`).first();
  if (!(await card.count())) fail(`search shows no card for ${playerName}`);
  await card.click();
  await page.waitForSelector('.drawer', { timeout: 15000 });
  await page.click('button:has-text("Add to Recruitment Room")');
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  const hash = await page.evaluate(() => location.hash);
  const id = hash.split('/').pop();
  if (!/^case-/.test(id)) fail(`could not read the room id from the deep link (${hash})`);
  return id;
}

const tab = async (page, name) => {
  await page.click(`[role="tablist"] button[role="tab"]:has-text("${name}")`);
  await page.waitForSelector(`[role="tabpanel"][aria-label="${name}"]`, { timeout: 10000 });
  // The Contact panel renders a loading line until its list arrives.
  if (name === 'Contact') await page.locator('[role="tabpanel"][aria-label="Contact"] [aria-label="Contact history"]').waitFor({ timeout: 15000 });
};
const contactPanel = (page) => page.locator('[role="tabpanel"][aria-label="Contact"]');
const headerStatus = async (page) => (await page.locator('[aria-label="Room header"] .badges').innerText());
const liveLine = (page) => contactPanel(page).locator('[role="status"][aria-live="polite"]').innerText();
/** Poll the Contact panel until its text matches — the list re-fetches after every action. */
async function waitPanel(page, re) {
  for (let i = 0; i < 40; i++) { if (re.test(await contactPanel(page).innerText().catch(() => ''))) return true; await sleep(250); }
  return false;
}
async function waitLive(page, re) {
  for (let i = 0; i < 40; i++) { if (re.test(await liveLine(page).catch(() => ''))) return true; await sleep(250); }
  return false;
}
const moveTo = async (page, status) => {
  await page.selectOption('[aria-label="Move to"]', status);
  await page.click('button:has-text("Apply")');
  await page.waitForTimeout(800);
};
async function contactTab(page, roomId) {
  // A full reload, so what the panel shows is what the server holds — not a
  // panel that happened to stay mounted.
  await page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${roomId}`);
  await page.reload();
  await page.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(page, 'Contact');
  await contactPanel(page).locator('[aria-label="Contact history"]').waitFor({ timeout: 15000 });
}

// ------------------------------------------------------------ player helpers

/** Enter the player app as a seeded identity through its own onboarding screen. */
async function enterPlayer(ctx, rowText, who, landing) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${PLAYER_PORT}/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click();
  await page.waitForSelector(landing, { timeout: 30000 });
  return page;
}
const openInbox = async (page) => {
  await page.click('a[href="/inbox"]');
  await page.waitForTimeout(800);
  await page.locator('a[href="/inbox"]').waitFor();
};
const bodyText = (page) => page.locator('body').innerText();

// ================================================================== A — ADULT

const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const AMARA = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
ok(KOLA && AMARA, 'HTTP actors for the recipient-side checks logged in');

const ctxLead = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lead = await enterClub(ctxLead, 'Eastport FC', 'Maria Keane', 'Head of Recruitment', 'lead');
say('A1: a recruitment lead signs in through the real client');

// §54: no new top-level navigation item.
{
  const nav = await lead.page.locator('nav.sidebar').innerText();
  neg(!/\bContact\b/.test(nav), 'A1b: the sidebar carries no "Contact" item — contact is a function of a case, not a destination');
}

const ROOM_A = await openRoomFor(lead.page, 'Kola Adeyemi');
say(`A2: the lead opens a Recruitment Room for an adult player through the UI (${ROOM_A})`);
{
  const tabs = await lead.page.locator('[role="tablist"] button[role="tab"]').allInnerTexts();
  ok(tabs.includes('Contact'), 'A2b: the room offers a page-local Contact tab');
  const idx = tabs.indexOf('Contact');
  ok(idx > tabs.indexOf('Discussion') && idx < tabs.indexOf('Activity'), 'A2c: it sits after Discussion — internal talk first, shared communication second');
}

await tab(lead.page, 'Contact');
{
  const panel = await contactPanel(lead.page).innerText();
  neg(/Contact opens once the case is at .Contact planned/.test(panel), 'A3: before the case is planned, the tab says contact is gated — and why');
  const send = contactPanel(lead.page).locator('button:has-text("Send")').first();
  neg(await send.isDisabled(), 'A3b: and Send is disabled');
  ok(/No contact yet\. Nothing has been shared/.test(panel), 'A3c: the history is honest about being empty');
}

await tab(lead.page, 'Overview');
await moveTo(lead.page, 'contact_planned');
ok(/Contact planned/.test(await headerStatus(lead.page)), 'A4: the lead moves the case to Contact planned through the room header');
await tab(lead.page, 'Contact');
{
  const panel = await contactPanel(lead.page).innerText();
  ok(/Will be delivered to the player \(adult\)/.test(panel), 'A4b: the tab shows the SERVER-derived route: the adult player himself');
  ok(!/Contact opens once/.test(panel), 'A4c: the gate notice is gone');
}

// A draft is not contact.
const DRAFT_BODY = 'Hello Kola — we watched your last three matches and would like to talk about a trial with our U21s.';
await contactPanel(lead.page).locator('[aria-label="Subject (optional)"]').fill('Eastport FC — a conversation about a trial');
await contactPanel(lead.page).locator('[aria-label="Message the player or guardian will read"]').fill(DRAFT_BODY);
await contactPanel(lead.page).locator('button:has-text("Save draft")').click();
ok(await waitLive(lead.page, /Draft saved\. Nothing has been sent\./), 'A5: the lead saves a draft and the live region says nothing has been sent');
{
  // Section headings are upper-cased by CSS, and innerText reports the rendered case.
  ok(await waitPanel(lead.page, /Contact history \(1\)/i), 'A5b: the history lists one entry');
  ok(/\bDraft\b/.test(await contactPanel(lead.page).innerText()), 'A5b\': and it is a Draft');
  neg(/Contact planned/.test(await headerStatus(lead.page)), 'A5c: the case is STILL at Contact planned — a draft moved nothing');
  const inbox = (await j('GET', '/player/inbox', undefined, KOLA)).body;
  neg(!JSON.stringify(inbox).includes('U21s'), 'A5d: nothing reached the player\'s Inbox');
}

// The player at phone width — before the send, so the "nothing" is observed in the UI too.
const ctxKola = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const kola = await enterPlayer(ctxKola, 'Kola Adeyemi', 'kola', 'text=Your visibility right now');
await openInbox(kola);
{
  const txt = await bodyText(kola);
  neg(/No requests yet/.test(txt) && !/U21s/.test(txt), 'A5e: at 390px the player\'s Inbox shows no request and none of the draft\'s words');
}

// Send the existing draft from its history row.
await contactPanel(lead.page).locator('[aria-label="Contact history"] button:has-text("Send")').first().click();
ok(await waitLive(lead.page, /Message delivered to the recipient.s ScoutBox Inbox\. Case moved to Contacted\./), 'A6: the lead sends the draft; the live region reports delivery AND the case move');
{
  ok(await waitPanel(lead.page, /\bDelivered\b/), 'A6b: the history row says Delivered');
  await sleep(500);
  ok(/\bContacted\b/.test(await headerStatus(lead.page)), 'A6c: the room header now says Contacted');
  const panel = await contactPanel(lead.page).innerText();
  ok(/A message was delivered recently and has not been answered/.test(panel), 'A6d: and the cooldown notice appears — a second message cannot chase the first');
  const send = contactPanel(lead.page).locator('form button:has-text("Send")').first();
  neg(await send.isDisabled(), 'A6e: the compose Send is disabled while the cooldown holds');
}

// The player reads it and answers, at phone width.
await kola.reload();
await kola.locator('a[href="/inbox"]').or(kola.getByText('Our promises to every player')).first().waitFor({ timeout: 40000 });
if (await kola.locator('text=Our promises to every player').count()) {
  await kola.locator('div', { hasText: 'Kola Adeyemi' }).filter({ has: kola.locator('text=Enter') }).last().locator('text=Enter').last().click();
  await kola.waitForSelector('text=Your visibility right now', { timeout: 30000 });
}
await openInbox(kola);
await kola.waitForSelector('text=Eastport FC — a conversation about a trial', { timeout: 20000 });
{
  const txt = await bodyText(kola);
  ok(/Eastport FC/.test(txt) && /Maria Keane/.test(txt), 'A7: the player sees the message attributed to a named person at a named organisation');
  ok(/U21s/.test(txt), 'A7b: with the body the lead wrote');
  ok(/Your reply \(optional\)/.test(txt), 'A7c: and a reply field — the answer belongs to this contact');
  const noScroll = await kola.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'A7d: 390px: no horizontal scroll');
}
await kola.locator('[data-testid^="req-reply-"], [aria-label="Your reply (optional)"]').first().fill('Happy to talk. Evenings are best for me.');
await kola.getByText('Accept contact', { exact: true }).click();
await kola.waitForSelector('text=You accepted', { timeout: 20000 });
say('A8: the player replies and accepts');

// The lead sees the response on the Contact — and the case does not move again.
await contactTab(lead.page, ROOM_A);
{
  const panel = await contactPanel(lead.page).innerText();
  ok(/Response received/.test(panel), 'A9: the lead\'s Contact history shows Response received');
  ok(/Evenings are best for me/.test(panel), 'A9b: with the player\'s words');
  neg(/\bContacted\b/.test(await headerStatus(lead.page)) && !/Contact planned/.test(await headerStatus(lead.page)), 'A9c: the case is still Contacted — a response is a Contact state, not a case status');
  ok(!/has not been answered/.test(panel), 'A9d: the cooldown notice is gone — the message was answered');
}

// ================================================================== M — MINOR

const ROOM_M = await openRoomFor(lead.page, 'Guni Adebayo');
say(`M1: the lead opens a Room for a 14-year-old through the UI (${ROOM_M})`);
await moveTo(lead.page, 'contact_planned');
await tab(lead.page, 'Contact');
{
  const panel = await contactPanel(lead.page).innerText();
  ok(/Will be delivered to the parent or guardian — under-18, never the child/.test(panel), 'M2: the tab says the route is the guardian, never the child');
}
const MINOR_BODY = 'Hello — we would like to talk with you about Guni joining our U15 development group.';
await contactPanel(lead.page).locator('[aria-label="Subject (optional)"]').fill('About Guni — U15 development group');
await contactPanel(lead.page).locator('[aria-label="Message the player or guardian will read"]').fill(MINOR_BODY);
await contactPanel(lead.page).locator('form button:has-text("Send")').first().click();
ok(await waitLive(lead.page, /Message delivered to the recipient.s ScoutBox Inbox\. Case moved to Contacted\./), 'M3: the lead sends; delivered, case moved');
{
  ok(await waitPanel(lead.page, /Guardian email copy:/), 'M3a: the history row appears with the email-copy state');
  const panel = await contactPanel(lead.page).innerText();
  const emailLine = panel.split('\n').find((l) => /^Guardian email copy:/.test(l));
  ok(emailLine, 'M3b: the history reports what happened to the courtesy email copy — as a state');
  neg(!/\bdelivered\b/i.test(emailLine.replace(/not confirmed delivered/, '')), 'M3c: and never describes the email as delivered');
}

// The guardian at phone width.
const ctxAmara = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const amara = await enterPlayer(ctxAmara, 'Amara Adebayo', 'amara', 'text=Guardian');
await amara.waitForSelector('text=About Guni — U15 development group', { timeout: 25000 });
{
  const txt = await bodyText(amara);
  ok(/about Guni/.test(txt) && /U15 development group/.test(txt), 'M4: the guardian sees the message, about her child, at 390px');
  ok(/routed to you because the player is under age/.test(txt), 'M4b: and is told why it reached her and not the child');
  ok(/Your reply \(optional\)/.test(txt), 'M4c: with a reply field');
}
await amara.locator('[aria-label="Your reply (optional)"]').first().fill('Thank you, not this season — Guni is settled where he is.');
await amara.getByText('Decline', { exact: true }).first().click();
await amara.waitForSelector('text=You declined', { timeout: 20000 });
say('M5: the guardian replies and declines');

// The child sees the outcome, never the message.
const ctxGuni = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const guni = await enterPlayer(ctxGuni, 'Guni Adebayo', 'guni', 'a[href="/inbox"]');
await openInbox(guni);
{
  const txt = await bodyText(guni);
  ok(/guardian-managed/.test(txt) && /Eastport FC/.test(txt), 'M6: the child\'s Updates show a guardian-managed item from the club');
  neg(!/U15 development group/.test(txt) && !/About Guni/.test(txt), 'M6b: the message body and subject never reach the child');
  neg(!/Your reply/.test(txt) && !(await guni.locator('[aria-label="Your reply (optional)"]').count()), 'M6c: and there is no reply field on the child\'s screen');
}

await contactTab(lead.page, ROOM_M);
{
  const panel = await contactPanel(lead.page).innerText();
  ok(/Response received/.test(panel) && /not this season/.test(panel), 'M7: the lead sees the guardian\'s answer on the Contact');
  neg(/\bContacted\b/.test(await headerStatus(lead.page)), 'M7b: the case stays at Contacted — a decline is not a case state');
}

// ============================================================== N — NEGATIVES

// N1 — no valid guardian route: Tomasz (16, guardian Marek). A draft written
// while the route was valid, then Marek's IDV is revoked.
const LEAD = lead.token;
{
  const ROOM_T = await openRoomFor(lead.page, 'Tomasz');
  await moveTo(lead.page, 'contact_planned');
  const d = await j('POST', `/org/rooms/${ROOM_T}/contacts`, { body: 'About Tomasz.' }, LEAD);
  ok(d.status === 201, 'N1: a draft for the minor while his guardian is verified');
  const revoke = await j('POST', '/admin/guardians/gd-marek/idv', { approved: false }, undefined, ADMIN);
  ok(revoke.status === 200 && revoke.body.idVerified === false, 'N1b: Trust & Safety revokes the guardian\'s identity verification');
  await contactTab(lead.page, ROOM_T);
  const panel = await contactPanel(lead.page).innerText();
  neg(/This player cannot be contacted right now/.test(panel) && /no verified guardian route exists/.test(panel), 'N1c: the tab now says the minor cannot be contacted and why — no direct fallback offered');
  neg(await contactPanel(lead.page).locator('form button:has-text("Send")').first().isDisabled(), 'N1d: Send is disabled');
  expect(await j('POST', `/org/rooms/${ROOM_T}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev }, LEAD), 422, 'CONTACT_GUARDIAN_REQUIRED', 'N1e: sending the existing draft fails closed — 422 CONTACT_GUARDIAN_REQUIRED');
  expect(await j('POST', `/org/rooms/${ROOM_T}/contacts`, { body: 'Another try.' }, LEAD), 422, 'CONTACT_GUARDIAN_REQUIRED', 'N1f: and a new draft is refused at compose time — the rule runs before anything is written');
  const jr = (await j('GET', `/org/rooms/${ROOM_T}/journey`, undefined, LEAD)).body;
  neg(jr.lifecycle.currentStage === 'contact_planned', 'N1g: the case did not move');
  const MAREK = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-marek' })).body.token;
  neg((await j('GET', '/guardian/inbox', undefined, MAREK)).body.every((r) => r.playerId !== 'pl-tomasz' || r.type !== 'contact'), 'N1h: nothing reached the unverified guardian');
}

// N2 — a block placed AFTER delivery: accept is refused, decline is allowed.
{
  const ROOM_E = await openRoomFor(lead.page, 'Elias Svensson');
  await moveTo(lead.page, 'contact_planned');
  await tab(lead.page, 'Contact');
  await contactPanel(lead.page).locator('[aria-label="Message the player or guardian will read"]').fill('Hello Elias — would you talk to us about a trial?');
  await contactPanel(lead.page).locator('form button:has-text("Send")').first().click();
  ok(await waitLive(lead.page, /Message delivered/), 'N2: a message is delivered to an adult');
  const d0 = await j('POST', `/org/rooms/${ROOM_E}/contacts`, { body: 'A follow-up, drafted before any block.' }, LEAD);
  ok(d0.status === 201, 'N2a: a second draft is written while the player is still reachable');
  const ELIAS = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
  const req = (await j('GET', '/player/inbox', undefined, ELIAS)).body.find((r) => r.status === 'pending' && r.type === 'contact');
  ok(req, 'N2b: it is in the player\'s Inbox');
  ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, ELIAS)).status === 201, 'N2c: the player then blocks the organisation');
  expect(await j('POST', `/player/requests/${req.id}/respond`, { accept: true }, ELIAS), 403, 'BLOCKED', 'N2d: accepting a message from a blocked organisation is refused 403 BLOCKED');
  const dec = await j('POST', `/player/requests/${req.id}/respond`, { accept: false, message: 'No thank you.' }, ELIAS);
  ok(dec.status === 200 && dec.body.status === 'declined', 'N2e: declining it is allowed');
  await contactTab(lead.page, ROOM_E);
  const panel = await contactPanel(lead.page).innerText();
  neg(/This player cannot be contacted right now/.test(panel) && /blocked your organisation/.test(panel), 'N2f: the lead\'s tab now says the player cannot be contacted — blocked');
  expect(await j('POST', `/org/rooms/${ROOM_E}/contacts/${d0.body.contact.id}/send`, { expectedRev: d0.body.contact.rev }, LEAD), 403, 'CONTACT_BLOCKED', 'N2g: sending a draft written before the block is refused 403 CONTACT_BLOCKED — the block is re-checked at send time');
  expect(await j('POST', `/org/rooms/${ROOM_E}/contacts`, { body: 'Again?' }, LEAD), 403, 'CONTACT_BLOCKED', 'N2h: and a new draft is refused at compose time');
}

// N3 — a contributor: read-only history, refused on write, in the UI and the API.
{
  const ctxScout = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const scout = await enterClub(ctxScout, 'Eastport FC', 'Tom Reilly', 'First-Team Scout', 'scout');
  await contactTab(scout.page, ROOM_A);
  const panel = await contactPanel(scout.page).innerText();
  neg(/Only a room lead or recruitment lead can draft, send or record a contact/.test(panel), 'N3: a scout who is not the room lead is told the tab is read-only');
  neg(!(await contactPanel(scout.page).locator('form').count()), 'N3b: and gets no compose form');
  ok(/Response received/.test(panel), 'N3c: but can read the history — internal, same organisation');
  expect(await j('POST', `/org/rooms/${ROOM_A}/contacts`, { body: 'Let me in.' }, scout.token), 403, 'CONTACT_NOT_PERMITTED', 'N3d: the API refuses the write — 403 CONTACT_NOT_PERMITTED');
  await ctxScout.close();
}

// N4 — a foreign organisation: the concealing 404, in the UI and the API.
{
  const ctxRival = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rival = await enterClub(ctxRival, 'Harbour City FC', 'Rita Doyle', 'Head of Recruitment', 'rival');
  await rival.page.evaluate((h) => { location.hash = h; }, `#/recruitment/rooms/${ROOM_A}`);
  await rival.page.waitForTimeout(2000);
  const txt = await bodyText(rival.page);
  neg(!/U21s|Evenings are best|Kola Adeyemi — a conversation/.test(txt), 'N4: another club opening the deep link sees none of the contact');
  const foreign = await j('GET', `/org/rooms/${ROOM_A}/contacts`, undefined, rival.token);
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/contacts', undefined, rival.token);
  neg(foreign.status === 404 && ghost.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(ghost.body), 'N4b: the API answers the same 404 as for a case that never existed');
  await ctxRival.close();
}

// N5 — the sentinel: an unsent draft that reaches no recipient surface.
{
  await contactTab(lead.page, ROOM_A);
  await contactPanel(lead.page).locator('[aria-label="Message the player or guardian will read"]').fill(`Internal only ${SENTINEL} — do not send.`);
  await contactPanel(lead.page).locator('button:has-text("Save draft")').click();
  ok(await waitLive(lead.page, /Draft saved/), 'N5: the lead saves a second draft carrying the sentinel');
  await kola.reload();
  await kola.locator('a[href="/inbox"]').or(kola.getByText('Our promises to every player')).first().waitFor({ timeout: 40000 });
  if (await kola.locator('text=Our promises to every player').count()) {
    await kola.locator('div', { hasText: 'Kola Adeyemi' }).filter({ has: kola.locator('text=Enter') }).last().locator('text=Enter').last().click();
    await kola.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  }
  await openInbox(kola);
  neg(!(await bodyText(kola)).includes(SENTINEL), 'N5b: the player\'s Inbox does not carry it');
  const surfaces = {
    'player inbox': (await j('GET', '/player/inbox', undefined, KOLA)).body,
    'player notifications': (await j('GET', '/player/notifications', undefined, KOLA)).body,
    'player export': (await j('GET', '/player/export', undefined, KOLA)).body,
    'guardian inbox': (await j('GET', '/guardian/inbox', undefined, AMARA)).body,
    'outbox': (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body,
  };
  for (const [name, body] of Object.entries(surfaces)) neg(!JSON.stringify(body ?? {}).includes(SENTINEL), `N5c: ${name} carries no internal draft`);
}

// N6 — 390px: the club's Contact tab. The lead's own session, carried into a
// phone-sized context, so the check is about the tab and not the login screen.
{
  const session = await lead.page.evaluate(() => localStorage.getItem('scoutbox-club-session'));
  const ctxPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctxPhone.addInitScript((s) => { localStorage.setItem('scoutbox-club-session', s); }, session);
  const phone = watch(await ctxPhone.newPage(), 'phone');
  await phone.goto(`http://localhost:${CLUB_PORT}/#/recruitment/rooms/${ROOM_A}`);
  await phone.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
  await tab(phone, 'Contact');
  const noScroll = await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  ok(noScroll, 'N6: 390px: the Contact tab has no horizontal page scroll');
  const send = contactPanel(phone).locator('form button:has-text("Send")').first();
  const box = await send.boundingBox();
  ok(box && box.height >= 32 && box.x >= 0 && box.x + box.width <= 390, 'N6b: 390px: the Send control is a real touch target inside the viewport');
  const label = await contactPanel(phone).locator('label:has-text("Message the player or guardian will read")').count();
  ok(label >= 1, 'N6c: the message field is labelled for assistive technology');
  const tabs = phone.locator('[role="tablist"]');
  const tabsFit = await tabs.evaluate((el) => el.scrollWidth >= el.clientWidth && getComputedStyle(el).overflowX === 'auto');
  ok(tabsFit, 'N6d: the tab strip scrolls within itself rather than widening the page');
  await ctxPhone.close();
}

// ------------------------------------------------------------------- done
if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
say('no page errors on any surface');
console.log(`\nM23 P3 CONTACT LIVE: ${passed} checks passed (${negatives} negative, ${Math.round((negatives / passed) * 100)}%)`);
await browser.close();
process.exit(0);
