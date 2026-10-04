// M24F.3 — the redesigned Player Inbox in a real browser against the real
// Player bundle and a live scoutbox-server. Everything the Inbox shows is
// seeded through the public API as the clubs would do it:
//   N  a normal conversation (an accepted contact → a thread with a composer);
//   U  an unread row (dot, bold line) that clears when the thread opens;
//   C  a contact request: Request label, one-line preview, Accept / Decline
//      visible, the full message only behind "View full message";
//   T  a trial invitation: the TRIAL accent (gold/amber) AND the word "Trial",
//      the slot chips, the venue behind the disclosure, accepting confirms;
//   O  an offer event row (offer accent + "Offer"), opening lands on the Offer;
//   S  a signing event row (signing accent + "Signing");
//   B  a blocked organisation: the request stays refused (403) — the UI says
//      so and nothing flips to Accepted; authorization is the server's.
// At 390 / 430 / 1024: zero page errors, compact rows, no horizontal overflow.
// Own ports (API 4066). KEEP_DIST=1 reuses dist-live24f3. Never two live
// suites at once. Run from e2e/: node m24f3InboxLive.test.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4066; const API = `http://localhost:${API_PORT}`;
const PLAYER_PORT = 8886;
const DIST = 'dist-live24f3';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m24f3inbox-'));
const KEEP = process.env.KEEP_DIST === '1';
// M24F3_SHOTS=1 also writes the after captures into design-system/screenshots (not in the battery: the demo hash covers that folder)
const SHOTS = process.env.M24F3_SHOTS === '1';
const H = 3_600_000; const DAY = 24 * H; const T0 = Date.now();
let passed = 0; const failures = []; const errors = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const say = (m) => console.log(`  · ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const port of [API_PORT, PLAYER_PORT]) { try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch { /* free */ } }
const bundle = path.join(ROOT, 'scoutbox-player', DIST);
if (KEEP && fs.existsSync(path.join(bundle, 'index.html'))) console.log('reusing the live Player bundle (KEEP_DIST=1)');
else { console.log(`building the live Player bundle for :${API_PORT}…`); execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' }); }
const serverProc = spawn('node', ['server.mjs'], { cwd: path.join(ROOT, 'scoutbox-server'), env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const statik = http.createServer((req, res) => {
  let f = path.join(bundle, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(bundle, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(PLAYER_PORT);
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

const j = async (method, p, body, token) => {
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const must = (r, what, codes = [200, 201]) => { if (!codes.includes(r.status)) { console.log(`  ! ${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`); return null; } return r.body; };

// ------------------------------------------------------------ actors
const lead = must(await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }), 'Eastport lead login');
const harbour = must(await j('POST', '/auth/org/login', { orgId: 'org-harbour', scoutName: 'Harbour Lead', role: 'Head of Recruitment' }), 'Harbour lead login');
const KOLA = must(await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' }), 'Kola login')?.token;
const ELIAS = must(await j('POST', '/auth/player/login', { playerId: 'pl-svensson' }), 'Elias login')?.token;
ok(lead?.token && harbour?.token && KOLA && ELIAS, 'two club leads and two adult players logged in over HTTP');
const LEAD = lead.token; const HARB = harbour.token;

const room = async (token, playerId) => { const r = must(await j('POST', '/org/rooms', { playerId }, token), `room for ${playerId}`)?.room; return r ? { id: r.roomId, rev: r.rev } : null; };
const rev = async (id, token) => (await j('GET', `/org/rooms/${id}`, undefined, token)).body.room?.rev;
async function moveStatus(id, token, status) { const r = await j('POST', `/org/rooms/${id}/status`, { status, expectedRev: await rev(id, token) }, token); return r.status; }
async function sendContact(id, token, body) {
  const d = must(await j('POST', `/org/rooms/${id}/contacts`, { body }, token), 'contact draft'); if (!d) return null;
  const s = await j('POST', `/org/rooms/${id}/contacts/${d.contact.id}/send`, { expectedRev: d.contact.rev }, token);
  return must(s, 'contact send') ? d.contact.id : null;
}
const VENUE = 'Eastport Training Ground'; const SECRET_LINE = 'Please bring boots and a water bottle';
const CONTACT_BODY = `Hello Kola — we have followed your season and would like to talk about our U21s. ${SECRET_LINE}; the meeting is informal.`;

// --- Kola: Eastport contact + trial (one room), Harbour offer + signing (another)
const RK = await room(LEAD, 'pl-adeyemi');
say(`Eastport room for Kola: ${RK?.id} → under_review ${await moveStatus(RK.id, LEAD, 'under_review')} → contact_planned ${await moveStatus(RK.id, LEAD, 'contact_planned')}`);
const CONTACT_ID = await sendContact(RK.id, LEAD, CONTACT_BODY);
const trial = await j('POST', `/org/rooms/${RK.id}/trials`, { timezone: 'Europe/London', venue: { name: VENUE, town: 'Eastport' }, message: `A trial with our U21s. ${SECRET_LINE}.`, slots: [{ startsAt: T0 + 3 * DAY, endsAt: T0 + 3 * DAY + 2 * H }, { startsAt: T0 + 5 * DAY, endsAt: T0 + 5 * DAY + 2 * H }] }, LEAD);
ok(CONTACT_ID && [200, 201].includes(trial.status), `seed: a contact request and a trial invitation reached Kola (trial ${trial.status} ${trial.body?.error ?? ''})`);

const RH = await room(HARB, 'pl-adeyemi');
let OFFER = null; let SIGNING = null;
if (RH) {
  const journey = async () => (await j('GET', `/org/rooms/${RH.id}/journey?limit=50`, undefined, HARB)).body;
  const lifecycle = async (action) => j('POST', `/org/rooms/${RH.id}/lifecycle`, { action, expectedRev: (await journey()).case?.rev }, HARB);
  if ((await journey()).lifecycle?.currentStage === 'watching') await lifecycle('startReview');
  if ((await journey()).lifecycle?.currentStage === 'under_review') await lifecycle('shortlist');
  const dr = await j('POST', `/org/rooms/${RH.id}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: 'live' }, HARB);
  const fin = await j('POST', `/org/rooms/${RH.id}/decision/finalize`, { expectedRev: dr.body.draft?.rev, clientKey: `m24f3-${RH.id}` }, HARB);
  say(`Harbour room ${RH.id}: decision ${dr.status}/${fin.status}`);
  const d = must(await j('POST', `/org/rooms/${RH.id}/offers`, { terms: { role: 'Midfielder', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 10 * DAY, internalNote: 'live' }, HARB), 'offer draft');
  if (d) {
    const iss = must(await j('POST', `/org/offers/${d.offer.id}/issue`, { expectedRev: d.offer.rev, clientKey: `m24f3-issue-${RH.id}` }, HARB), 'offer issue');
    if (iss) {
      OFFER = d.offer.id;
      const mine = (await j('GET', `/player/offers/${OFFER}`, undefined, KOLA)).body.offer;
      const acc = must(await j('POST', `/player/offers/${OFFER}/accept`, { revisionId: mine?.currentRevisionId, clientKey: `m24f3-accept-${RH.id}` }, KOLA), 'offer accept (HTTP, so a signing can open)');
      if (acc) {
        const s = must(await j('POST', `/org/offers/${OFFER}/signing`, { internalNote: 'live', clientKey: `m24f3-sign-${RH.id}` }, HARB), 'signing open');
        if (s) {
          const sid = s.signing.id;
          const srev = async () => (await j('GET', `/org/signings/${sid}`, undefined, HARB)).body.signing?.rev;
          const PDF = Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% Contract — Kola Adeyemi — m24f3\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
          const doc = must(await j('POST', `/org/signings/${sid}/document`, { dataUrl: `data:application/pdf;base64,${PDF.toString('base64')}`, filename: 'contract.pdf', label: 'Contract', expectedRev: await srev() }, HARB), 'signing document');
          const ready = doc && must(await j('POST', `/org/signings/${sid}/ready`, { expectedRev: await srev(), clientKey: `m24f3-ready-${RH.id}` }, HARB), 'signing ready');
          if (ready) SIGNING = sid;
        }
      }
    }
  }
}
ok(!!OFFER, 'seed: Harbour issued an Offer to Kola');
ok(!!SIGNING, 'seed: Harbour presented a signing to Kola');

// --- Elias: Eastport contact, then Elias blocks Eastport
const RE = await room(LEAD, 'pl-svensson');
say(`Eastport room for Elias: ${RE?.id} → under_review ${await moveStatus(RE.id, LEAD, 'under_review')} → contact_planned ${await moveStatus(RE.id, LEAD, 'contact_planned')}`);
const ELIAS_REQ = await sendContact(RE.id, LEAD, 'Hello Elias — a conversation about next season?');
const blocked = await j('POST', '/player/block', { orgId: 'org-eastport' }, ELIAS);
ok(ELIAS_REQ && [200, 201].includes(blocked.status), `seed: Elias received a request, then blocked the organisation (${blocked.status})`);
const eliasInbox = (await j('GET', '/player/inbox', undefined, ELIAS)).body;
const ELIAS_REQ_ID = Array.isArray(eliasInbox) ? eliasInbox.find((r) => r.type === 'contact')?.id : null;

// ------------------------------------------------------------ browser
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctxFor = (w, h) => browser.newContext({ viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); return page; };
async function enter(page, rowText, landing = 'text=Your visibility right now') {
  await page.goto(`http://localhost:${PLAYER_PORT}/`); await page.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const row = page.locator('div', { hasText: rowText }).filter({ has: page.locator('text=Enter') }).last();
  await row.locator('text=Enter').last().click(); await page.waitForSelector(landing, { timeout: 30000 }); await sleep(500);
}
// leave a detail / thread through its own back control (history back would leave the Messages tab)
const leave = async (page) => { const b = page.locator('[data-testid="detail-back"], [data-testid="thread-back"], [aria-label="Back to messages"], [aria-label="Back"]').first(); if (await b.count()) await b.click(); else await leave(page); };
const openInbox = async (page) => { await page.click('a[href^="/inbox"]'); await page.waitForSelector('[role="tablist"]', { timeout: 15000 }); await sleep(900); };
const vp = (page) => page.locator('[data-testid="mobile-viewport"]');
const text = async (page) => (await vp(page).innerText()).replace(/\s+/g, ' ');
const OVERFLOW = `(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth)`;
const TRIAL_RGB = ['rgb(176, 138, 28)', 'rgb(233, 196, 106)'];
const rowBox = async (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; });

for (const [w, h] of [[390, 844], [430, 932], [1024, 768]]) {
  const tag = `Kola ${w}px`;
  const ctx = await ctxFor(w, h); const page = watch(await ctx.newPage(), tag);
  await enter(page, 'Kola Adeyemi'); await openInbox(page);
  ok(!(await page.evaluate(OVERFLOW)), `${tag}: no horizontal overflow on the Inbox`);
  if (SHOTS && w === 1024) await page.screenshot({ path: path.join(ROOT, 'design-system/screenshots/m24f3-after-inbox-desktop-1024.png') }).catch(() => {});
  if (SHOTS && w === 390) await page.screenshot({ path: path.join(ROOT, 'design-system/screenshots/m24f3-after-inbox-live-390.png') }).catch(() => {});
  const tabs = await page.locator('[role="tablist"]').filter({ hasText: 'Requests' }).first().locator('[role="tab"]').allInnerTexts();
  ok(tabs.length === 3 && /All/.test(tabs[0]) && /Unread/.test(tabs[1] ?? '') && /Requests/.test(tabs[2] ?? ''), `${tag}: tabs are All / Unread / Requests (${tabs.map((t) => t.trim()).join(' · ')})`);
  const requests = page.locator('[data-testid^="inbox-request-"]');
  ok((await requests.count()) >= 2, `${tag}: Kola's two requests (contact, trial) are rows (${await requests.count()})`);
  const heights = []; for (let i = 0; i < Math.min(4, await requests.count()); i++) heights.push((await rowBox(requests.nth(i))).h);
  ok(heights.every((x) => x > 0 && x <= 96), `${tag}: request rows are compact (${heights.join(', ')}px)`);
  const listText = await text(page);
  ok(!listText.includes(SECRET_LINE), `${tag}: the list shows no message body — one line per row`);
  ok(!/\d{1,2}:\d{2}:\d{2}/.test(listText) && !/\d{4}-\d{2}-\d{2}/.test(listText), `${tag}: no seconds, no ISO dates on the Inbox`);

  // T — the trial row: accent + label
  const trialRow = requests.filter({ has: page.locator('[data-testid="row-accent-trial"]') }).first();
  ok((await trialRow.count()) === 1, `${tag}: exactly one trial row carries the trial accent`);
  if (await trialRow.count()) {
    const accent = await trialRow.locator('[data-testid="row-accent-trial"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    ok(TRIAL_RGB.includes(accent), `${tag}: the trial accent is the warm gold (${accent})`);
    ok(/\bTrial\b/.test(await trialRow.innerText()), `${tag}: the trial row says "Trial" — not colour alone`);
    await trialRow.click(); await sleep(700);
    const detail = page.locator('[data-testid^="request-detail-"]');
    ok((await detail.count()) === 1 && (await detail.locator('[data-testid="trial-card"]').count()) === 1, `${tag}: opening the row shows the trial card`);
    const before = await detail.innerText();
    ok(/Trial invitation/i.test(before) && /Accept/.test(before) && /Decline/.test(before), `${tag}: Trial invitation names itself; Accept and Decline are visible`);
    if (SHOTS && w === 390) await page.screenshot({ path: path.join(ROOT, 'design-system/screenshots/m24f3-after-trial-invite-390.png') }).catch(() => {});
    ok(!before.includes(SECRET_LINE) && (await detail.locator('[data-testid^="trial-slot-"]').count()) === 2, `${tag}: the full message is hidden; the two slots are chips`);
    const more = detail.locator('[data-testid^="req-details-"]').first(); await more.click(); await sleep(400);
    const afterTxt = await detail.innerText();
    ok(afterTxt.includes(SECRET_LINE) && afterTxt.includes(VENUE), `${tag}: "View full message" reveals the message and the venue`);
    await leave(page);
  }

  // O / S — event rows (notifications load after the list; wait for them)
  const events = page.locator('[data-testid^="inbox-event-"]');
  for (let i = 0; i < 24 && (await events.count()) < ((OFFER ? 1 : 0) + (SIGNING ? 1 : 0)); i++) await sleep(500);
  const evTexts = await events.allInnerTexts();
  ok(OFFER ? evTexts.some((t) => /Offer/.test(t)) : true, `${tag}: an Offer row is on the list (${evTexts.length} events)`);
  ok(SIGNING ? evTexts.some((t) => /Signing/.test(t)) : true, `${tag}: a Signing row is on the list`);
  ok((await page.locator('[data-testid="row-accent-offer"]').count()) >= (OFFER ? 1 : 0) && (await page.locator('[data-testid="row-accent-signing"]').count()) >= (SIGNING ? 1 : 0), `${tag}: offer and signing rows carry their accents`);
  if (OFFER && w === 390) {
    await events.filter({ hasText: /Offer/ }).first().click(); await sleep(1200);
    ok(/\/opportunities/.test(page.url()) && /cat=offer/.test(page.url()), `${tag}: opening the Offer row lands on Opportunities › Offer (${new URL(page.url()).search})`);
    await openInbox(page);
  }

  // Requests tab holds only requests
  await page.locator('[role="tab"]', { hasText: /Requests/ }).click(); await sleep(500);
  ok((await page.locator('[data-testid^="inbox-request-"]').count()) >= 2 && (await page.locator('[data-testid^="thread-"]').count()) === 0, `${tag}: the Requests tab shows requests only`);
  await page.locator('[role="tab"]', { hasText: /^All/ }).click(); await sleep(300);
  await ctx.close();
}

// ------------------------------------------------------------ C / N / U — accept the contact, then the conversation
{
  const tag = 'Kola 390px (contact → conversation)';
  const ctx = await ctxFor(390, 844); const page = watch(await ctx.newPage(), tag);
  await enter(page, 'Kola Adeyemi'); await openInbox(page);
  const contactRow = page.locator('[data-testid^="inbox-request-"]').filter({ has: page.locator('[data-testid="row-accent-request"]') }).first();
  ok((await contactRow.count()) === 1 && /Request/.test(await contactRow.innerText()), `${tag}: the contact request row carries the Request label`);
  await contactRow.click(); await sleep(700);
  const detail = page.locator('[data-testid^="request-detail-"]');
  ok((await detail.locator('[data-testid="contact-card"]').count()) === 1 && /Contact request/i.test(await detail.innerText()), `${tag}: the contact card names itself`);
  if (SHOTS) await page.screenshot({ path: path.join(ROOT, 'design-system/screenshots/m24f3-after-contact-request-390.png') }).catch(() => {});
  ok(!(await detail.innerText()).includes(SECRET_LINE), `${tag}: the message body waits behind "View full message"`);
  await detail.locator('[data-testid^="req-details-"]').first().click(); await sleep(400);
  ok((await detail.innerText()).includes(SECRET_LINE), `${tag}: the full message opens`);
  await detail.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.waitForSelector('[data-testid^="req-status-"]:has-text("Accepted")', { timeout: 15000 }).catch(() => {});
  ok(/Accepted/.test(await detail.innerText().catch(() => '')), `${tag}: Accept → the status word says Accepted`);
  const inboxNow = (await j('GET', '/player/inbox', undefined, KOLA)).body;
  ok(Array.isArray(inboxNow) && inboxNow.some((r) => r.type === 'contact' && r.status === 'accepted' && /eastport/i.test(r.orgId ?? r.orgName ?? r.org?.name ?? 'eastport')), `${tag}: the server holds the acceptance`);
  await leave(page);
  const threads = page.locator('[data-testid^="thread-"]');
  ok((await threads.count()) >= 1, `${tag}: a conversation row appears (${await threads.count()})`);
  const row = threads.first(); const unreadBefore = await row.locator('[data-testid="row-unread"]').count();
  ok((await rowBox(row)).h <= 96 && /Eastport/.test(await row.innerText()), `${tag}: the conversation row is compact and names the club`);
  await row.click(); await sleep(900);
  const thread = page.locator('[data-testid="inbox-thread"]');
  ok((await thread.count()) === 1 && (await thread.locator('input[placeholder="Message…"], textarea[placeholder="Message…"]').count()) === 1, `${tag}: the thread opens with a "Message…" composer`);
  ok(!/Policy|provenance|ledger/i.test(await thread.innerText()), `${tag}: the thread view carries no policy prose`);
  await thread.locator('input[placeholder="Message…"], textarea[placeholder="Message…"]').first().fill('Thanks — happy to talk.');
  await thread.getByRole('button', { name: /Send/ }).first().click(); await sleep(1200);
  ok(/happy to talk/.test(await thread.innerText()), `${tag}: the player's message appears as a bubble`);
  await leave(page);
  ok((await threads.first().locator('[data-testid="row-unread"]').count()) === 0, `${tag}: after reading, the row carries no unread dot (was ${unreadBefore})`);
  await ctx.close();
}

// ------------------------------------------------------------ B — Elias, blocked
{
  const tag = 'Elias 390px (blocked)';
  const ctx = await ctxFor(390, 844); const page = watch(await ctx.newPage(), tag);
  await enter(page, 'Elias Svensson'); await openInbox(page);
  const row = page.locator('[data-testid^="inbox-request-"]').first();
  ok((await row.count()) >= 1, `${tag}: the request row is listed`);
  if (await row.count()) {
    await row.click(); await sleep(700);
    const detail = page.locator('[data-testid^="request-detail-"]');
    await detail.getByRole('button', { name: 'Accept', exact: true }).click(); await sleep(1500);
    const txt = await detail.innerText();
    ok(!/\bAccepted\b/.test(txt), `${tag}: nothing flips to Accepted for a blocked organisation`);
    ok(/block/i.test(txt) || /could not|refused|not permitted/i.test(txt), `${tag}: the screen says why`);
  }
  const api = ELIAS_REQ_ID ? await j('POST', `/player/requests/${ELIAS_REQ_ID}/respond`, { accept: true }, ELIAS) : { status: 0 };
  ok(api.status === 403, `${tag}: the API refuses the acceptance (403 ${api.body?.error ?? ''})`);
  await ctx.close();
}

ok(errors.length === 0, `zero page errors (${errors.length})${errors.length ? ` — ${errors.slice(0, 2).join(' | ')}` : ''}`);
console.log(`\nm24f3InboxLive: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
await browser.close(); serverProc.kill(); statik.close();
process.exit(failures.length ? 1 : 0);
