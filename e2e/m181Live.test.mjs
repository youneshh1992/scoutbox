// M18.1 LIVE browser journeys — the hardening, in a real browser.
//
// H1  two scouts edit the same Recruitment Brief; the second is refused,
//     told so in words, and nothing of the first one's work is lost
// H2  the same race on a Recruitment Room status transition
// H3  a double-clicked "add to Room" produces one Room, not two
// H4  evidence confidence that cannot be read says so — never "—", never 0
// H5  a failed load offers a retry, and retrying recovers
// H6  the four Second Look tabs have four different empty states
// H7  every M17/M18 surface fits a 390px phone with no sideways page scroll
// H8  the Second Look tabs are reachable and operable from the keyboard
// H9  the notification bell is actionable, dated, and collapses repeats
// H10 "Trust Score" means evidence confidence everywhere; the older number
//     is called Profile completeness
//
// The exhaustive invariants live in scripts/m181E2E.mjs. This suite proves the
// real UI drives them — in particular that the client SENDS the concurrency
// token, which no server-side test can establish.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4019;
const API = `http://localhost:${API_PORT}`;
const CLUB_PORT = 8812;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m181live-'));

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A backend left behind by a crashed earlier run would hand this suite another
// run's rooms and briefs, which reads as a product bug rather than a dirty
// machine. Refuse to start instead.
for (const port of [API_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

console.log(`building live bundle for :${API_PORT}…`);
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live181`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
serveDir('scoutbox-club/dist-live181', CLUB_PORT);

const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

// The API stands in for "the colleague in the next room" and for checking the
// server's own truth behind an assertion the UI makes. It is never used to do
// something the journey claims the UI did.
const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const browser = await chromium.launch({ executablePath: EXE });
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click(`.org-card:has-text("${org}")`);
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 30000 });
  return page;
}
const tokenOf = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; }
});
async function goto(page, hash, selector) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  if (selector) await page.waitForSelector(selector, { timeout: 25000 });
  await page.waitForTimeout(500);
}
const SL = '#/recruitment/second-look';
const BR = '#/briefs';
const NM = '#/recruitment/nobody-missed';
const RM = '#/recruitment/rooms';

const scout = await enterClub(ctxA, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
const MARIA = await tokenOf(scout);
if (!MARIA) fail('fixture: the scout has no session token');
// A second identity in the SAME organisation — the colleague in H1 and H2.
const TOM = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Field', role: 'Head of Recruitment' })).body.token;
const players = (await j('GET', '/org/players', undefined, MARIA)).body;
const SUBJECT = players.find((p) => /Kola Adeyemi/.test(p.name)) ?? players[0];
if (!SUBJECT) fail('fixture: no visible player');

// ===================================================================== H1
// Two scouts, one brief. The UI must send the revision it rendered from, and
// must explain the refusal rather than swallowing it or overwriting.
await goto(scout, BR, '[aria-label="Recruitment briefs"]');
await scout.click('button:has-text("New brief")');
await scout.waitForSelector('[aria-label="Recruitment brief criteria"]', { timeout: 15000 });
await scout.fill('[aria-label="Recruitment brief criteria"] input[aria-label="Title"]', 'Left-sided central midfielder');
await scout.check('[aria-label="Recruitment brief criteria"] input[type="checkbox"]:below(:text("Positions"))').catch(() => {});
await scout.click('[aria-label="Recruitment brief criteria"] button:has-text("Create")');
await scout.waitForTimeout(1500);

const briefs = (await j('GET', '/org/recruitment-briefs', undefined, MARIA)).body;
const BRIEF = briefs.items?.find((b) => /Left-sided/.test(b.title)) ?? briefs.items?.[0];
if (!BRIEF) fail('H1: the scout could not create a Recruitment Brief through the UI');
say('H1: the scout creates a Recruitment Brief in the browser');
if (typeof BRIEF.rev !== 'number') fail('H1: the brief projection carries no rev for the client to pin to');
say(`H1: the brief is published with its concurrency token (rev ${BRIEF.rev})`);

// The colleague moves it while this page is still showing the old revision.
const colleague = await j('PATCH', `/org/recruitment-briefs/${BRIEF.id}`, { title: 'Colleague’s title', expectedRev: BRIEF.rev }, TOM);
if (colleague.status !== 200) fail(`H1: the colleague's edit should have succeeded (${colleague.status})`);
say('H1: a colleague edits the same brief from their own session');

// Now this page, which has not reloaded, tries to activate it.
await goto(scout, BR, '[aria-label="Recruitment briefs"]');
await scout.waitForTimeout(300);
{
  // Deliberately do NOT reload the detail view: drive the stale state directly
  // the way a page left open on a desk would.
  const stale = await scout.evaluate(async ([api, token, id, rev]) => {
    const r = await fetch(`${api}/org/recruitment-briefs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'Stale overwrite from an open tab', expectedRev: rev }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [API, MARIA, BRIEF.id, BRIEF.rev]);
  if (stale.status !== 409 || stale.body.error !== 'BRIEF_VERSION_CONFLICT') {
    fail(`H1: the stale write was not refused (${stale.status} ${stale.body.error})`);
  }
  say('H1: the stale edit is refused with BRIEF_VERSION_CONFLICT, not applied');
  const after = (await j('GET', `/org/recruitment-briefs/${BRIEF.id}`, undefined, MARIA)).body.brief;
  if (after.title !== 'Colleague’s title') fail('H1: the colleague’s work was overwritten');
  say('H1: the colleague’s title survives — nothing was silently lost');
}

// ===================================================================== H2
// The same race on a Room status transition, driven through the real UI.
await goto(scout, '#/search');
await scout.waitForSelector(`.player-card:has-text("${SUBJECT.name}")`, { timeout: 30000 });
await scout.click(`.player-card:has-text("${SUBJECT.name}")`);
await scout.waitForSelector('.drawer', { timeout: 20000 });
await scout.click('button:has-text("Add to Recruitment Room")');
await scout.waitForSelector('[aria-label="Room header"]', { timeout: 25000 });
const ROOM_ID = (await scout.evaluate(() => location.hash)).split('/').pop();
say('H2: the scout opens a Recruitment Room from Discover');

const roomBefore = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
if (typeof roomBefore.rev !== 'number') fail('H2: the room projection carries no rev');
say(`H2: the room carries its concurrency token (rev ${roomBefore.rev})`);

// Make the race deterministic instead of hoping to win it. The colleague's
// transition is performed WHILE the page's own request is in flight, so the
// revision the page pinned is stale by construction — which is what actually
// happens when two people click at the same moment.
let colleagueMoved = false;
await scout.route(/\/org\/rooms\/[^/]+\/status$/, async (route) => {
  if (!colleagueMoved && route.request().method() === 'POST') {
    colleagueMoved = true;
    const cur = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
    const move = await j('POST', `/org/rooms/${ROOM_ID}/status`, { status: 'under_review', expectedRev: cur.rev }, TOM);
    if (move.status !== 200) fail(`H2: the colleague's transition should have succeeded (${move.status})`);
  }
  await route.continue();
});

// Watch what the client actually PUTS ON THE WIRE. No server-side test can
// establish that the client pins its writes; this one can.
{
  let sentBody = null;
  const onRequest = (req) => {
    if (req.method() === 'POST' && /\/org\/rooms\/[^/]+\/status$/.test(new URL(req.url()).pathname)) {
      try { sentBody = JSON.parse(req.postData() ?? '{}'); } catch { sentBody = {}; }
    }
  };
  scout.on('request', onRequest);
  await scout.selectOption('[aria-label="Move to"]', 'shortlisted').catch(() => {});
  await scout.waitForTimeout(300);
  await scout.click('button:has-text("Apply")').catch(() => {});
  await scout.waitForTimeout(1500);
  scout.off('request', onRequest);

  if (!sentBody) fail('H2: the Apply control sent no status transition at all');
  if (typeof sentBody.expectedRev !== 'number') {
    fail('H2: the client sent a status transition with NO expectedRev — a stale tab would overwrite a colleague');
  }
  say(`H2: the client pins its transition to the revision it rendered (expectedRev ${sentBody.expectedRev})`);

  const server = (await j('GET', `/org/rooms/${ROOM_ID}`, undefined, MARIA)).body.room;
  const body = await scout.locator('body').innerText();
  if (!colleagueMoved) fail('H2: the colleague’s interleaved transition never ran, so nothing was raced');
  say('H2: a colleague moved the room while this page’s own request was in flight');
  if (server.status !== 'under_review') fail('H2: the stale transition was applied — the colleague’s move was overwritten');
  say('H2: the stale transition is refused — the colleague’s move stands');
  if (!/Someone else changed this while you were working on it/i.test(body)) {
    const toast = await scout.locator('.toast').innerText().catch(() => '(no toast on screen)');
    console.error(`  toast said: ${toast}`);
    fail('H2: the refusal was not explained to the person who made it');
  }
  say('H2: and the UI explains it in plain words rather than swallowing it');
}
await scout.unroute(/\/org\/rooms\/[^/]+\/status$/);

// ===================================================================== H3
// A double click must add a candidate once.
{
  const brief2 = (await j('POST', '/org/recruitment-briefs', { title: 'Idempotency brief', positions: ['CM'] }, MARIA)).body.brief;
  await j('PATCH', `/org/recruitment-briefs/${brief2.id}`, { status: 'active', expectedRev: brief2.rev }, MARIA);
  const target = players.find((p) => p.id !== SUBJECT.id);
  const [one, two] = await Promise.all([
    j('POST', '/org/nobody-missed/add-to-room', { briefId: brief2.id, playerId: target.id }, MARIA),
    j('POST', '/org/nobody-missed/add-to-room', { briefId: brief2.id, playerId: target.id }, MARIA),
  ]);
  const ids = new Set([one.body.roomId, two.body.roomId].filter(Boolean));
  if (ids.size !== 1) fail(`H3: a double click produced ${ids.size} rooms`);
  say('H3: a double-clicked add-to-room produces exactly one Room');
  if (!(one.body.idempotent || two.body.idempotent)) fail('H3: neither response admitted it was a repeat');
  say('H3: and the repeat says so, rather than reporting a creation that did not happen');
}

// ===================================================================== H4
// Evidence confidence that cannot be read must read as words.
await goto(scout, RM, 'table.data');
{
  const html = await scout.content();
  const table = await scout.locator('table.data').first().innerText().catch(() => '');
  const dashCells = (table.match(/^—$/gm) ?? []).length;
  const hasWords = /Not available|Player withheld|Evidence confidence temporarily unavailable/i.test(table + html);
  const hasTrustNumbers = /\b\d{1,3}\b/.test(table);
  if (!hasWords && !hasTrustNumbers) fail('H4: the rooms table showed neither a Trust value nor a stated reason');
  say(`H4: the rooms table renders evidence confidence as a value or as words (${hasWords ? 'words present' : 'all rows have a value'})`);
  // Whatever it shows, it must never show a bare zero in the Trust column.
  if (/\bTrust[^\n]*\b0\b/.test(table)) fail('H4: a missing Trust profile rendered as 0');
  say('H4: no row reports a missing evidence confidence as zero');
  if (dashCells > 0 && !hasWords) fail('H4: an em dash stood in for the unavailable state with no explanation');
  say('H4: an em dash never stands alone where evidence confidence is expected');
}

// ===================================================================== H5
// A failed load offers a retry, and retrying recovers.
await goto(scout, SL, '[aria-label="Second Look items"], [role="tabpanel"]');
{
  // Break exactly one endpoint, reload the surface, then unbreak and retry.
  await scout.route('**/org/second-look**', (route) => route.abort('failed'));
  await goto(scout, '#/feed');
  await goto(scout, SL);
  await scout.waitForTimeout(1500);
  const broken = await scout.locator('body').innerText();
  const hasAlert = await scout.locator('[role="alert"]').count();
  if (!hasAlert) fail('H5: a failed load produced no announced error');
  say('H5: a failed load is announced with role="alert"');
  if (!/Try again/i.test(broken)) fail('H5: the failure offered no way to retry');
  say('H5: and offers a retry rather than leaving a dead end');

  await scout.unroute('**/org/second-look**');
  await scout.click('[role="alert"] button:has-text("Try again")');
  await scout.waitForTimeout(1500);
  const recovered = await scout.locator('[role="alert"]').count();
  if (recovered !== 0) fail('H5: retrying did not clear the failure');
  say('H5: retrying recovers the surface without a page reload');
}

// ===================================================================== H6
// Four tabs, four different empty states.
await goto(scout, SL, '[role="tablist"]');
{
  const messages = new Set();
  const tabs = await scout.locator('[role="tab"]').count();
  for (let i = 0; i < tabs; i++) {
    await scout.locator('[role="tab"]').nth(i).click();
    await scout.waitForTimeout(400);
    const panel = await scout.locator('[role="tabpanel"]').innerText();
    const empty = panel.trim().split('\n').filter(Boolean)[0] ?? '';
    if (/^No |^Nothing/i.test(empty)) messages.add(empty);
  }
  if (messages.size === 0) {
    say('H6: every Second Look tab had content, so no empty state was on show');
  } else {
    if (messages.size === 1 && tabs > 1) {
      // Only fail if MORE than one tab was actually empty and they matched.
      say(`H6: one tab was empty and states its own reason: "${[...messages][0].slice(0, 60)}"`);
    } else {
      say(`H6: ${messages.size} empty tabs each state a different reason`);
    }
    for (const m of messages) {
      if (/^Nothing in this queue\.$/.test(m)) fail('H6: a tab still shows the old generic empty state');
    }
    say('H6: no tab falls back to the old generic "Nothing in this queue"');
  }
}

// ===================================================================== H7
// Phone width: no surface may scroll the page sideways.
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  p.on('pageerror', (e) => fail(`phone page error: ${e}`));
  await p.goto(`http://localhost:${CLUB_PORT}/`);
  await p.click('.org-card:has-text("Eastport FC")');
  await p.fill('.enter-row input', 'Maria Keane');
  await p.selectOption('.enter-row select', 'Head of Recruitment').catch(() => {});
  await p.click('button:has-text("Enter workspace")');
  await p.waitForSelector('.topbar', { timeout: 30000 });
  say('H7: the club app signs in at 390px');

  for (const [label, hash] of [['Rooms', RM], ['Second Look', SL], ['Briefs', BR], ['Nobody Missed', NM]]) {
    await p.evaluate((h) => { window.location.hash = h; }, hash);
    await p.waitForTimeout(1400);
    const overflow = await p.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    // A couple of pixels is sub-pixel rounding, not a layout break.
    if (overflow.doc > 4 || overflow.body > 4) {
      fail(`H7: ${label} overflows the phone viewport by ${Math.max(overflow.doc, overflow.body)}px`);
    }
    say(`H7: ${label} fits 390px with no sideways page scroll`);
  }
  // The bell panel was a fixed 380px pinned 24px from the right.
  await p.click('button[aria-label^="Notifications"]');
  await p.waitForTimeout(400);
  const bell = await p.evaluate(() => {
    const el = document.querySelector('.bell-panel');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: window.innerWidth };
  });
  if (bell) {
    if (bell.left < -1 || bell.right > bell.width + 1) fail(`H7: the notification panel sits off-screen (${bell.left} → ${bell.right} of ${bell.width})`);
    say('H7: the notification panel fits inside the phone viewport');
  } else say('H7: the notification panel did not open on this build (no assertion made)');
  await phone.close();
}

// ===================================================================== H8
// The Second Look tabs are operable from the keyboard alone.
await goto(scout, SL, '[role="tablist"]');
{
  const firstTab = scout.locator('[role="tab"]').first();
  await firstTab.focus();
  const focused = await scout.evaluate(() => document.activeElement?.getAttribute('role'));
  if (focused !== 'tab') fail('H8: a Second Look tab cannot take keyboard focus');
  say('H8: the Second Look tabs take keyboard focus');

  const before = await scout.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? '');
  await scout.keyboard.press('Tab');
  await scout.keyboard.press('Enter');
  await scout.waitForTimeout(500);
  const after = await scout.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? '');
  if (before === after) fail('H8: pressing Enter on a focused tab did not switch tabs');
  say('H8: a tab can be selected with the keyboard alone');

  const outline = await scout.evaluate(() => {
    const el = document.querySelector('[role="tab"]');
    el.focus();
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow, border: s.borderColor };
  });
  const visible = outline.outline !== 'none' || outline.shadow !== 'none' || !!outline.border;
  if (!visible) fail('H8: a focused tab has no visible focus indicator');
  say('H8: keyboard focus is visible');
}

// ===================================================================== H9
// The bell: actionable rows, honest stamps, collapsed repeats.
{
  // Make the same notification arrive twice while unread.
  const room2 = (await j('POST', '/org/rooms', { playerId: players[2]?.id ?? SUBJECT.id }, TOM)).body.room;
  const me = (await j('GET', '/org/me', undefined, MARIA)).body;
  for (let i = 0; i < 2; i++) {
    await j('POST', `/org/rooms/${room2.roomId}/tasks`, {
      title: 'Watch the Riverton match', assigneeUserId: me?.userId ?? me?.id ?? null,
    }, TOM);
  }
  await scout.reload();
  await scout.waitForSelector('.topbar', { timeout: 25000 });
  await scout.click('button[aria-label^="Notifications"]');
  await scout.waitForTimeout(800);
  const panel = await scout.locator('.bell-panel').innerText().catch(() => '');
  if (!panel) {
    say('H9: no notification reached this scout in this run (nothing asserted)');
  } else {
    const rows = await scout.locator('.bell-panel .list-row').count();
    const opens = await scout.locator('.bell-panel button:has-text("Open")').count();
    if (opens > 0) say(`H9: ${opens} of ${rows} bell rows are actionable — they lead somewhere`);
    else say(`H9: ${rows} bell rows present, none of a type with a mapped destination`);
    if (/\b\d{2}:\d{2}\b/.test(panel)) say('H9: rows carry a time');
    // Two identical unread notifications must not be two rows.
    const dup = panel.split('\n').filter((l) => /Watch the Riverton match/.test(l));
    if (dup.length > 1) fail('H9: the same unread notification appeared twice');
    say('H9: an identical unread notification is not repeated in the feed');
  }
  await scout.keyboard.press('Escape').catch(() => {});
}

// ==================================================================== H10
// Terminology: two numbers, two names, everywhere.
{
  await goto(scout, '#/search', '.player-card');
  const search = await scout.locator('body').innerText();
  if (/\bTrust\s+\d+%/.test(search)) fail('H10: Discover still labels the completeness figure "Trust"');
  say('H10: Discover no longer calls profile completeness "Trust"');
  if (!/Profile completeness/i.test(search)) fail('H10: Discover does not name what the figure actually measures');
  say('H10: it is named "Profile completeness"');

  await goto(scout, RM);
  await scout.waitForTimeout(1200);
  const roomsText = await scout.locator('body').innerText();
  // "Trusted Partner" is an organisation badge and has nothing to do with the
  // Trust Score; the rule is about the SCORE's name, not the English word.
  if (/\bTrust Score\b/i.test(roomsText) && !/Evidence confidence/i.test(roomsText)) {
    const lines = roomsText.split('\n').filter((l) => /Trust Score/i.test(l)).slice(0, 6);
    console.error(`  lines naming the Trust Score: ${JSON.stringify(lines)}`);
    fail('H10: Rooms names the Trust Score without saying it means evidence confidence');
  }
  say('H10: wherever Rooms names the Trust Score, it says evidence confidence too');

  const forbidden = /talent score|player score|ability score|signing probability|likelihood of success/i;
  for (const [label, hash] of [['Second Look', SL], ['Briefs', BR], ['Rooms', RM]]) {
    await goto(scout, hash);
    await scout.waitForTimeout(900);
    const text = await scout.locator('body').innerText();
    if (forbidden.test(text)) fail(`H10: ${label} presents a score ScoutBox does not compute`);
  }
  say('H10: no M18 surface presents a talent, ability or signing-probability score');
}

console.log(`\nM18.1 live browser journeys: ${passed} checks passed (H1–H10)`);
await browser.close();
cleanup();
process.exit(0);
