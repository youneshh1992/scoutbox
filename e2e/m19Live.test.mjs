// M19 LIVE browser journeys — Explainable Matching and Dynamic Watchlists,
// driven through the real Pro workspace against a real server.
//
// M19-1   a recruiter writes criteria and gets a set of players back
// M19-2   every card names every required criterion — nothing matches for an
//         unstated reason
// M19-3   preferred criteria are COUNTED, shown as met and unmet, and never
//         remove anyone or reorder anyone
// M19-4   the ordering control declares what it orders by, and offers nothing
//         called a best match
// M19-5   a protected characteristic cannot be chosen in the editor, and is
//         refused by name if it is sent anyway
// M19-6   an invalid criterion is refused in the server's own words, the
//         offending row is named, and the draft survives
// M19-7   a search that was run reaches the URL; refresh reproduces it
// M19-8   saving as a Dynamic Watchlist forces an explicit mode choice
// M19-9   the watchlist says when membership was last derived, and that
//         nothing recomputes in the background in this build
// M19-10  narrowing the criteria moves players out, and the history says why
// M19-11  a colleague's write raises the shared conflict notice; archiving
//         states its consequence before it happens
// M19-12  the screens fit a 390px phone, are keyboard-operable, and the
//         forbidden vocabulary appears nowhere on them
//
// The exhaustive invariants live in scoutbox-server/scripts/m19E2E.mjs. This
// suite proves the real UI drives them.
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
const CLUB_PORT = 8814;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m19live-'));

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live19`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });

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
serveDir('scoutbox-club/dist-live19', CLUB_PORT);

const cleanup = () => {
  try { serverProc.kill('SIGKILL'); } catch { /* gone */ }
  for (const s of statics) s.close();
  fs.rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

for (let i = 0; i < 160; i++) { try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
console.log(`backend up on :${API_PORT}`);

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

const errors = [];
async function enterClub(ctx, org, name, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
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
  if (selector) {
    await page.waitForSelector(selector, { timeout: 25000 }).catch(async () => {
      const where = await page.evaluate(() => location.hash);
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 400);
      fail(`navigation to ${hash} never showed ${selector} (now at ${where}): ${text}`);
    });
  }
  await page.waitForTimeout(400);
}
const MATCHING = '#/recruitment/matching';
const WATCHLISTS = '#/recruitment/watchlists';

const maria = await enterClub(ctxA, 'Eastport FC', 'Maria Keane', 'Head of Recruitment');
const MARIA = await tokenOf(maria);
if (!MARIA) fail('fixture: the recruiter has no session token');
const TOM = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Field', role: 'Head of Recruitment' })).body.token;

// ------------------------------------------------------------------ helpers
/** Add a criterion row of a given type to a class, and return its row locator. */
async function addCriterion(page, cls, type) {
  const label = cls === 'required' ? 'Add required criterion' : 'Add preferred criterion';
  const scope = page.locator(`[data-criteria-class="${cls}"]`);
  const before = await scope.locator('.list-row').count();
  await scope.locator(`button:has-text("${label}")`).click();
  // Pinned by index, not by .last(): a later row must not move this handle.
  const row = scope.locator('.list-row').nth(before);
  await row.waitFor({ timeout: 10000 });
  if (type !== 'position') await row.locator('select[aria-label="Fact"]').selectOption(type);
  return row;
}
const bodyText = (page) => page.locator('body').innerText();

// ============================================================== M19-1, M19-2
{
  await goto(maria, MATCHING, '.topbar h1:has-text("Player Matching")');
  const row = await addCriterion(maria, 'required', 'position');
  await row.locator('input[type=checkbox]').nth(6).check(); // CDM
  await maria.click('button:has-text("Show matching players")');
  await maria.waitForSelector('[data-match-total]', { timeout: 20000 });
  const total = Number(await maria.locator('[data-match-total]').getAttribute('data-match-total'));
  if (!(total > 0)) fail(`M19-1: matching returned ${total} players for a position every club can see`);
  say(`M19-1 a recruiter writes one criterion and gets ${total} players back`);

  const cards = maria.locator('[data-match-card]');
  const n = await cards.count();
  if (n !== total) fail(`M19-2: ${n} cards rendered for a total of ${total}`);
  for (let i = 0; i < n; i++) {
    const text = await cards.nth(i).innerText();
    if (!/Why this player matches/.test(text)) fail(`M19-2: card ${i} has no explanation`);
    if (!/Matches position criteria \(CDM\)/.test(text)) fail(`M19-2: card ${i} does not name the criterion it matched: ${text.slice(0, 200)}`);
  }
  say(`M19-2 all ${n} cards name the criterion they matched — nothing matches for an unstated reason`);
  // The ✓ / ○ glyph is decorative; the outcome also exists in words for a
  // screen reader, and that copy must not print on the page.
  const srCount = await maria.locator('[data-match-card] .sr-only').count();
  if (srCount === 0) fail('M19-2: the criterion outcome is carried by a glyph alone');
  const srVisible = await maria.locator('[data-match-card] .sr-only').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 || r.height > 2;
  });
  if (srVisible) fail('M19-2: the screen-reader-only outcome text is printing on the page');
  const glyphHidden = await maria.locator('[data-match-card] span[aria-hidden="true"]').first().getAttribute('aria-hidden');
  if (glyphHidden !== 'true') fail('M19-2: the decorative glyph is not hidden from assistive technology');
  say(`M19-2b the ✓ glyph is decorative and the outcome is also in words (${srCount} hidden labels, 0 visible)`);
}

// ==================================================================== M19-3
{
  const order = await maria.locator('[data-match-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-match-card')));
  const pref = await addCriterion(maria, 'preferred', 'trust_band');
  await pref.locator('select[aria-label="Value"]').selectOption('very_strong_evidence');
  await maria.click('button:has-text("Show matching players")');
  await maria.waitForSelector('[data-match-total]', { timeout: 20000 });
  const after = await maria.locator('[data-match-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-match-card')));
  if (JSON.stringify(order) !== JSON.stringify(after)) fail('M19-3: adding a preferred criterion changed who is on the list, or the order');
  const text = await bodyText(maria);
  if (!/0 of 1 preferred criteria met/.test(text)) fail(`M19-3: the preferred count is not shown as a count: ${text.slice(0, 400)}`);
  if (!/It is not a score, and players are never ordered by it/.test(text)) fail('M19-3: the count is shown without saying what it is not');
  await maria.locator('[data-match-card]').first().locator('button:has-text("Show preferred criteria")').click();
  await maria.waitForTimeout(200);
  const expanded = await maria.locator('[data-match-card]').first().innerText();
  if (!/Evidence confidence is below the criteria/.test(expanded)) fail(`M19-3: an UNMET preferred criterion is not shown as plainly as a met one: ${expanded}`);
  say('M19-3 preferred criteria are counted, shown met and unmet, and change neither membership nor order');
}

// ==================================================================== M19-4
{
  const options = await maria.locator('select[aria-label="Order by"]').locator('option').allInnerTexts();
  if (options.length === 0) fail('M19-4: no ordering control');
  const bad = options.find((o) => /best|recommend|relevan|score|rank|fit/i.test(o));
  if (bad) fail(`M19-4: the ordering control offers "${bad}"`);
  const note = await bodyText(maria);
  if (!/An ordering, not a ranking/.test(note)) fail('M19-4: the ordering is not declared as an ordering');
  await maria.locator('select[aria-label="Order by"]').selectOption('name');
  await maria.waitForTimeout(900);
  const names = await maria.locator('[data-match-card] b').evaluateAll((els) => els.filter((e) => e.style.fontSize === '15px').map((e) => e.textContent));
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(names) !== JSON.stringify(sorted)) fail(`M19-4: name ordering did not order by name: ${names.join(',')}`);
  say(`M19-4 the ordering control declares itself, offers no "best match", and does what it says (${options.length} options)`);
}

// ==================================================================== M19-5
{
  const types = await maria.locator('select[aria-label="Fact"]').first().locator('option').evaluateAll((els) => els.map((e) => e.value));
  const protectedish = types.find((t) => /ethnic|race|religion|disab|income|school|orientation/i.test(t));
  if (protectedish) fail(`M19-5: the criterion editor offers "${protectedish}"`);
  // And it is refused on the wire, by name, if it is sent anyway.
  const refusal = await maria.evaluate(async ([api, token]) => {
    const r = await fetch(`${api}/org/matching`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ criteria: { required: [{ type: 'ethnicity', operator: 'in', values: ['x'] }] } }),
    });
    return { status: r.status, body: await r.json() };
  }, [API, MARIA]);
  if (refusal.status !== 400 || refusal.body.error !== 'CRITERION_PROHIBITED') fail(`M19-5: a protected characteristic was not refused: ${JSON.stringify(refusal)}`);
  if (!refusal.body.prohibited.includes('ethnicity')) fail('M19-5: the refusal does not name the offending criterion');
  say(`M19-5 no protected characteristic is offered in the editor (${types.length} types), and one sent anyway is refused by name`);
}

// ==================================================================== M19-6
{
  // A fresh editor. Navigating to a bare matching link deliberately does NOT
  // discard criteria already typed — a colleague's link is not a reason to
  // throw away your work — so this journey starts from a reload.
  await maria.evaluate((h) => { window.location.hash = h; }, MATCHING);
  await maria.reload();
  await maria.waitForSelector('.topbar h1:has-text("Player Matching")', { timeout: 25000 });
  await maria.waitForTimeout(500);
  const good = await addCriterion(maria, 'required', 'position');
  await good.locator('input[type=checkbox]').nth(6).check(); // CDM
  const bad = await addCriterion(maria, 'required', 'age');
  await bad.locator('input[aria-label="Age from"]').fill('24');
  await bad.locator('input[aria-label="Age to"]').fill('16');
  await maria.click('button:has-text("Show matching players")');
  await maria.waitForTimeout(1200);
  const text = await bodyText(maria);
  if (!/cannot be saved as written/i.test(text)) fail(`M19-6: no refusal message: ${text.slice(0, 400)}`);
  if (!/the range starts after it ends/i.test(text)) fail(`M19-6: the refusal does not say what is wrong with the row: ${text.slice(0, 500)}`);
  const stillThere = await maria.locator('[data-criteria-class="required"] .list-row').count();
  if (stillThere !== 2) fail(`M19-6: the draft did not survive the refusal (${stillThere} rows left)`);
  const cdmStillChecked = await good.locator('input[type=checkbox]').nth(6).isChecked();
  if (!cdmStillChecked) fail('M19-6: the refusal cleared a criterion the club had already written');
  say('M19-6 an invalid criterion is refused in the server’s own words, the row is named, and the draft survives');
}

// ==================================================================== M19-7
{
  // Correct the row the refusal named, leaving the rest of the draft alone.
  const rows = maria.locator('[data-criteria-class="required"] .list-row');
  await rows.nth(1).locator('input[aria-label="Age from"]').fill('16');
  await rows.nth(1).locator('input[aria-label="Age to"]').fill('40');
  await maria.click('button:has-text("Show matching players")');
  await maria.waitForSelector('[data-match-total]', { timeout: 20000 });
  const hash = await maria.evaluate(() => location.hash);
  if (!hash.startsWith('#/recruitment/matching?c=')) fail(`M19-7: the criteria did not reach the URL: ${hash}`);
  const before = await maria.locator('[data-match-total]').getAttribute('data-match-total');
  await maria.reload();
  await maria.waitForSelector('[data-criteria-class="required"]', { timeout: 25000 });
  await maria.waitForTimeout(600);
  const reproduced = await maria.locator('[data-criteria-class="required"] .list-row').count();
  if (reproduced !== 2) fail(`M19-7: a refresh did not reproduce the criteria (${reproduced} rows)`);
  await maria.click('button:has-text("Show matching players")');
  await maria.waitForSelector('[data-match-total]', { timeout: 20000 });
  const after = await maria.locator('[data-match-total]').getAttribute('data-match-total');
  if (before !== after) fail(`M19-7: the reproduced search returned a different answer (${before} → ${after})`);
  say(`M19-7 a search that was run reaches the URL and a refresh reproduces it exactly (${after} players)`);
}

// ==================================================================== M19-8
let WL_HASH = null;
{
  await maria.click('button:has-text("Save as a Dynamic Watchlist")');
  await maria.waitForSelector('input[aria-label="Name"]', { timeout: 10000 });
  const modes = await maria.locator('input[name="m19-mode"]').count();
  if (modes < 1) fail('M19-8: the save form does not ask how the watchlist stays current');
  const legend = await bodyText(maria);
  if (!/How should this watchlist stay current\?/.test(legend)) fail('M19-8: the mode is not put as a question');
  if (!/keeps its own copy of these criteria/.test(legend)) fail('M19-8: the mode options do not say what they mean');
  const saveDisabled = await maria.locator('button.primary:has-text("Save")').isDisabled();
  if (!saveDisabled) fail('M19-8: a watchlist can be saved with no name');
  await maria.fill('input[aria-label="Name"]', '2027 Defensive Midfielders');
  await maria.click('button.primary:has-text("Save")');
  await maria.waitForSelector('h3:has-text("2027 Defensive Midfielders")', { timeout: 20000 });
  WL_HASH = await maria.evaluate(() => location.hash);
  if (!WL_HASH.startsWith('#/recruitment/watchlists/')) fail(`M19-8: saving did not open the watchlist: ${WL_HASH}`);
  say('M19-8 saving forces a named watchlist and an explicit mode choice, then opens it');
}

// ==================================================================== M19-9
{
  const text = await bodyText(maria);
  if (!/Membership last derived/.test(text)) fail('M19-9: the watchlist does not say when membership was derived');
  if (!/derived when this page is read/i.test(text)) fail('M19-9: the page does not say membership is derived on read');
  if (!/does not recompute watchlists in the background/i.test(text)) fail('M19-9: the page implies a scheduler this build does not have');
  if (!/newly matched/.test(text) || !/no longer match/.test(text)) fail('M19-9: no change summary');
  if (!/not an improvement in a player/i.test(text)) fail('M19-9: the counts are shown without saying what they are not');
  if (!/MEMBERSHIP HISTORY|Membership history/i.test(text)) fail('M19-9: no membership history');
  if (!/First time this watchlist was evaluated/.test(text)) fail('M19-9: the first derivation is not explained');
  say('M19-9 the watchlist states when it was derived, that nothing runs in the background, and what changed');
}

// =================================================================== M19-10
{
  const id = WL_HASH.split('/').pop();
  const before = (await j('GET', `/org/watchlists/${id}`, undefined, MARIA)).body.total;
  // Narrow the saved criteria through the API the UI uses, then re-read in the UI.
  const cur = (await j('GET', `/org/watchlists/${id}`, undefined, MARIA)).body.watchlist;
  const patch = await j('PATCH', `/org/watchlists/${id}`, {
    criteria: { required: [{ type: 'position', operator: 'in', values: ['CDM'] }, { type: 'age', operator: 'lte', value: 18 }] },
    expectedRev: cur.rev,
  }, MARIA);
  if (patch.status !== 200) fail(`M19-10: could not narrow the criteria: ${JSON.stringify(patch.body)}`);
  await maria.reload();
  await maria.waitForSelector('h3:has-text("2027 Defensive Midfielders")', { timeout: 25000 });
  await maria.waitForTimeout(800);
  const text = await bodyText(maria);
  const left = Number(await maria.locator('[data-wl-count="no-longer-matches"] b').innerText());
  const current = Number(await maria.locator('[data-wl-count="current"] b').innerText());
  if (!(left > 0)) fail(`M19-10: tightening the criteria removed nobody (before ${before}, now ${current})`);
  if (!/No longer matches/.test(text)) fail('M19-10: the history does not show the departures');
  if (!/The saved criteria changed/.test(text)) fail(`M19-10: the history does not say the CRITERIA changed — it must not blame the player: ${text.slice(0, 800)}`);
  say(`M19-10 narrowing the criteria moved ${left} players out, and the history says the criteria changed`);
}

// =================================================================== M19-11
{
  const id = WL_HASH.split('/').pop();
  const cur = (await j('GET', `/org/watchlists/${id}`, undefined, MARIA)).body.watchlist;
  await maria.click('button:has-text("Rename")');
  await maria.waitForTimeout(200);
  // A colleague renames it while this window still holds the older revision.
  const theirs = await j('PATCH', `/org/watchlists/${id}`, { name: 'Renamed by Tom', expectedRev: cur.rev }, TOM);
  if (theirs.status !== 200) fail(`M19-11: the colleague's write failed: ${JSON.stringify(theirs.body)}`);
  await maria.fill('input[aria-label="Name"]', 'Renamed by Maria');
  await maria.click('button.primary:has-text("Save")');
  await maria.waitForSelector('.notice, [role="alert"]', { timeout: 15000 }).catch(() => {});
  await maria.waitForTimeout(600);
  const notice = maria.locator('[data-conflict-code]');
  if (await notice.count() === 0) fail(`M19-11: no shared conflict notice: ${(await bodyText(maria)).slice(0, 500)}`);
  const code = await notice.first().getAttribute('data-conflict-code');
  if (code !== 'WATCHLIST_VERSION_CONFLICT') fail(`M19-11: the notice carries the wrong code (${code})`);
  const noticeText = await notice.first().innerText();
  if (!/This changed while you were editing/.test(noticeText)) fail(`M19-11: not the shared notice: ${noticeText}`);
  if (!/Tom Field saved a newer version/.test(noticeText)) fail(`M19-11: the conflict does not name the colleague: ${noticeText}`);
  if (!/nothing of yours has been lost/.test(noticeText)) fail('M19-11: the notice does not say the draft survived');
  const draft = await maria.locator('input[aria-label="Name"]').inputValue();
  if (draft !== 'Renamed by Maria') fail(`M19-11: the conflict destroyed the typed name ("${draft}")`);
  say('M19-11a a colleague’s write raises the SAME conflict notice used everywhere, names them, and keeps the draft');

  // Archiving states its consequence before it happens.
  await maria.reload();
  await maria.waitForSelector('button:has-text("Archive")', { timeout: 25000 });
  let dialogText = null;
  maria.once('dialog', async (d) => { dialogText = d.message(); await d.dismiss(); });
  await maria.click('button:has-text("Archive")');
  await maria.waitForTimeout(600);
  if (!dialogText) fail('M19-11: archiving did not confirm first');
  if (!/history is kept/i.test(dialogText) || !/not reopened/i.test(dialogText)) {
    fail(`M19-11: the confirmation does not state the consequence: ${dialogText}`);
  }
  if (/Are you sure/i.test(dialogText)) fail(`M19-11: the confirmation asks "are you sure" instead of saying what happens: ${dialogText}`);
  await maria.waitForTimeout(400);
  const stillActive = await bodyText(maria);
  if (/Archived/.test(stillActive.split('Membership')[0] ?? '')) fail('M19-11: dismissing the confirmation archived it anyway');
  say('M19-11b archiving states its consequence before acting, and dismissing it does nothing');
}

// =================================================================== M19-12
{
  const FORBIDDEN = [/AI Match Score/i, /Talent Score/i, /Potential Score/i, /Recruitability/i, /ScoutBox Rating/i, /\bBest Match\b/i, /Recommended Player/i];
  for (const hash of [MATCHING, WATCHLISTS, WL_HASH]) {
    await goto(maria, hash, '.content');
    await maria.waitForTimeout(500);
    const raw = await bodyText(maria);
    // Strip the sentences that exist precisely to deny these things.
    const text = raw.replace(/no match score[^.]*\./gi, '').replace(/does not rank or score[^.]*\./gi, '')
      .replace(/never scored[^.]*\.?/gi, '').replace(/not a score[^.]*\.?/gi, '');
    for (const re of FORBIDDEN) {
      if (re.test(text)) fail(`M19-12: ${hash} shows forbidden vocabulary matching ${re}`);
    }
  }
  say('M19-12a no forbidden vocabulary on any M19 screen');

  await maria.setViewportSize({ width: 390, height: 844 });
  for (const hash of [MATCHING, WATCHLISTS, WL_HASH]) {
    await goto(maria, hash, '.content');
    await maria.waitForTimeout(400);
    const overflow = await maria.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    if (overflow) fail(`M19-12: ${hash} scrolls sideways at 390px`);
  }
  say('M19-12b every M19 screen fits a 390px phone without sideways scrolling');

  await maria.setViewportSize({ width: 1440, height: 1000 });
  await goto(maria, MATCHING, '.topbar h1:has-text("Player Matching")');
  await maria.locator('[data-criteria-class="required"] button:has-text("Add required criterion")').focus();
  await maria.keyboard.press('Enter');
  await maria.waitForTimeout(300);
  const added = await maria.locator('[data-criteria-class="required"] .list-row').count();
  if (added < 1) fail('M19-12: the criteria editor cannot be operated from the keyboard');
  const labelled = await maria.locator('[data-criteria-class="required"] select, [data-criteria-class="required"] input[type=number], [data-criteria-class="required"] input[type=text]')
    .evaluateAll((els) => els.every((e) => e.getAttribute('aria-label') || e.closest('label')));
  if (!labelled) fail('M19-12: a control in the criteria editor has no accessible name');
  say('M19-12c the criteria editor is keyboard-operable and every control has an accessible name');

  if (errors.length) fail(`M19-12: page errors during the run: ${errors.slice(0, 3).join(' | ')}`);
  say('M19-12d no page errors across the whole journey');
}

await browser.close();
console.log(`\nM19 live journeys: ${passed} checks passed`);
cleanup();
process.exit(0);
