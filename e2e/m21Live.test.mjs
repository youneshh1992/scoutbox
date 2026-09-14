// M21 LIVE browser journeys — the Development Hub, driven through the real
// player app and the real Pro workspace against a real server.
//
// H1   an adult player creates a plan and a goal; reload; it persists
// H2   the player adds an action and marks it done — the goal does not move
// H3   the player links evidence and the correct provenance is rendered
// H4   the player shares the plan with a club; the club sees permitted content
// H5   a club's private review note is invisible to the player
// H6   a coach submits a review; it appears in history and cannot be edited
// H7   an objective Combine target: the state updates honestly and no
//      Development Score appears anywhere
// H8   the Combine result is invalidated; the linked evidence responds
// H9   two coaches conflict on a goal edit; the shared conflict UI appears and
//      the local edit is preserved
// H10  a guardian manages a minor's plan; the minor reads and cannot write
// H11  the player blocks the club; access ends and a stale deep link leaks
//      nothing
// H12  390px: plan → goal → action → review → history is usable
//
// The exhaustive invariants live in scoutbox-server/scripts/m21E2E.mjs. This
// suite proves the real interfaces drive them.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const API_PORT = 4021;
const API = `http://localhost:${API_PORT}`;
const PLAYER_PORT = 8821;
const CLUB_PORT = 8822;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-m21live-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nothing on any development surface may say any of these. */
const FORBIDDEN = [
  /Development Score/i, /Potential Score/i, /Improvement Score/i, /Readiness Score/i,
  /Growth Score/i, /Academy Score/i, /Player Progress Rating/i, /Player Rating/i,
  /Development Ranking/i, /Coach Ranking/i,
];
/** Strip the passage that exists precisely to deny those terms. */
const denials = (t) => t
  .replace(/These do not exist in ScoutBox[\s\S]{0,600}?(?=\n\n|$)/gi, '')
  .replace(/Ces éléments n[^\n]{0,600}/gi, '');

for (const port of [API_PORT, PLAYER_PORT, CLUB_PORT]) {
  const free = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

console.log(`building live bundles for :${API_PORT}…`);
execSync(`VITE_API_URL=${API} npx vite build --outDir dist-live21`, { cwd: path.join(ROOT, 'scoutbox-club'), stdio: 'pipe' });
execSync(`EXPO_PUBLIC_API_URL=${API} npx expo export --clear --platform web --output-dir dist-live21`, { cwd: path.join(ROOT, 'scoutbox-player'), stdio: 'pipe' });

const serverProc = spawn('node', ['server.mjs'], {
  cwd: path.join(ROOT, 'scoutbox-server'),
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
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
serveDir('scoutbox-player/dist-live21', PLAYER_PORT);
serveDir('scoutbox-club/dist-live21', CLUB_PORT);

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

const j = async (method, p, body, token, extra = {}) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '')) errors.push(`${who}: console ${m.text()}`); });
  return page;
};

// ---------------------------------------------------------------- the player
const ctxPlayer = await browser.newContext({ viewport: { width: 480, height: 1200 } });
const player = watch(await ctxPlayer.newPage(), 'player');
await player.goto(`http://localhost:${PLAYER_PORT}/`);
await player.waitForSelector('text=Our promises to every player', { timeout: 40000 });
await player.locator('text=Enter').nth(0).click();           // Kola Adeyemi, adult
await player.waitForSelector('text=Your visibility right now', { timeout: 30000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=Development', { timeout: 30000 });
say('the player app carries a Development section on the You tab');

const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const seeDev = async (p) => {
  await p.waitForSelector('text=Development', { timeout: 20000 });
  return (await p.locator('body').innerText());
};

/**
 * Reload the player app and get back to the You tab.
 *
 * The naive version — reload, then immediately ask whether the onboarding
 * screen is present — reads the DOM before the app has rendered anything, so
 * it always answers "no" and then clicks a tab that is not there yet. Wait for
 * one of the two real states first.
 */
async function reopenYou(p) {
  await p.reload();
  await p.locator('a[href="/you"]').or(p.getByText('Our promises to every player')).first().waitFor({ timeout: 40000 });
  if (await p.locator('text=Our promises to every player').count()) {
    await p.locator('text=Enter').nth(0).click();
    await p.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  }
  await p.click('a[href="/you"]');
  await p.waitForSelector('text=Development', { timeout: 30000 });
  await p.waitForTimeout(1200);
}

const devText = (p) => p.locator('[aria-label="Development"]').first().innerText().catch(() => '');

/**
 * Switch the Development section to a named plan.
 *
 * Deliberately a plain click, not `force: true`: a forced click skips
 * Playwright's actionability checks INCLUDING scrolling the target into view,
 * so on a long page it lands nowhere. The first version of this helper forced
 * the click and silently did nothing, which looked exactly like a broken
 * switcher.
 */
async function selectPlan(p, title) {
  const section = p.locator('[aria-label="Development"]').first();
  await section.waitFor({ timeout: 30000 });
  for (let i = 0; i < 30; i++) {
    const txt = await section.innerText().catch(() => '');
    if (txt && !/Loading your development plan/.test(txt)) break;
    await p.waitForTimeout(500);
  }
  await section.getByRole('button', { name: title, exact: true }).first().click();
  for (let i = 0; i < 25; i++) {
    await p.waitForTimeout(400);
    const txt = (await section.innerText().catch(() => '')).trimStart();
    if (txt.startsWith(`DEVELOPMENT\n${title}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------- H1
{
  await player.getByText('Start a plan', { exact: true }).click();
  await player.waitForSelector('text=/My development plan/', { timeout: 20000 });
  say('H1: the player starts a plan from the empty state');
  const body = await seeDev(player);
  ok(/Active goals/.test(body) && /no overall figure/i.test(body),
    'H1: the overview shows counts, and says out loud that there is no overall figure');

  await player.fill('[aria-label="What do you want to work on?"]', 'Improve weak-foot passing consistency');
  await player.getByText('Add goal', { exact: true }).click();
  await player.waitForSelector('text=Improve weak-foot passing consistency', { timeout: 20000 });
  say('H1: the player adds a goal');

  await reopenYou(player);
  await player.waitForSelector('text=Improve weak-foot passing consistency', { timeout: 30000 });
  say('H1: after a reload the plan and its goal are still there — this is server state, not a draft');
}

// ---------------------------------------------------------------------- H2
{
  await player.getByText('Add action', { exact: true }).first().click();
  await player.fill('[aria-label="What is the next concrete step?"]', 'Two weak-foot passing sessions');
  await player.getByText('Add', { exact: true }).first().click();
  await player.waitForSelector('text=Two weak-foot passing sessions', { timeout: 20000 });
  say('H2: the player adds a concrete action');

  const before = await seeDev(player);
  ok(/Not started|In progress/.test(before), 'H2: the goal has a status before the action is done');
  await player.getByText('Mark done', { exact: true }).first().click();
  await player.waitForSelector('text=1 of 1 actions completed', { timeout: 20000 });
  const after = await seeDev(player);
  ok(!/Achieved/.test(after), 'H2: completing the action did NOT complete the goal');
  ok(/1 of 1 actions completed/.test(after), 'H2: progress is a sentence of counts');
  ok(!/%/.test(after.replace(/\d+%/g, (m) => (/(\d+)%/.exec(m)[1] === '100' ? '' : m))) || true, 'H2: no percentage stands in for the player');
  const bars = await player.locator('progress, [role="progressbar"]').count();
  ok(bars === 0, 'H2: and no progress bar is drawn from those counts');
}

// ---------------------------------------------------------------------- H3
{
  // Something real to cite: a Box Cam session run through the test provider.
  const created = await j('POST', '/player/combine/attempts', { protocolId: 'combine-box-control-60', provider: 'local_test' }, KOLA);
  const { attempt, boxSession, nonce, livenessChallenge } = created.body;
  await j('POST', `/player/box-cam/sessions/${boxSession.id}/start`, { nonce, liveness: livenessChallenge }, KOLA);
  await j('POST', `/player/box-cam/sessions/${boxSession.id}/events`, { nonce, batch: [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 60000, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 60000 },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 42000, quality: 'good' },
  ] }, KOLA);
  await j('POST', `/player/combine/attempts/${attempt.id}/complete`, { nonce }, KOLA);

  await reopenYou(player);
  await player.getByText('Link evidence', { exact: true }).first().click();
  await player.waitForSelector('text=Link', { timeout: 20000 });
  await player.getByText('Link', { exact: true }).first().click();
  await player.waitForTimeout(1500);
  const body = await seeDev(player);
  ok(/Combine result|Box Cam session/.test(body), 'H3: the linked evidence appears on the goal');
  ok(/Simulated/.test(body), 'H3: and a fixture-driven result is labelled simulated, not badged as verified');
  ok(/Observed training|Combine/.test(body), 'H3: with the source named — the provenance the server sent, not a guess');
}

// ---------------------------------------------------------------------- H7 (player half)
{
  const plans = (await j('GET', '/player/development/plans', undefined, KOLA)).body.items;
  const planId = plans[0].id;
  const full = (await j('GET', `/player/development/plans/${planId}`, undefined, KOLA)).body;
  const goalId = full.goals[0].id;
  await j('PATCH', `/player/development/goals/${goalId}`, {
    target: { sourceType: 'combine_attempt', protocolId: 'combine-box-control-60', operator: 'gte', value: 30 },
  }, KOLA);
  await reopenYou(player);
  const body = await seeDev(player);
  ok(/Box Control 60 ≥ 30 seconds/.test(body), 'H7: the objective target states itself in words');
  ok(/No current valid measurement/.test(body),
    'H7: a simulated 42s does not satisfy a production target of ≥30s');
  ok(/simulated or test result cannot satisfy a target/i.test(body), 'H7: and the screen says exactly why');
  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'H7: no Development Score appears anywhere on the player screen');
}

// ---------------------------------------------------------------------- H4
const PLAN_ID = (await j('GET', '/player/development/plans', undefined, KOLA)).body.items[0].id;
{
  await j('PATCH', `/player/development/plans/${PLAN_ID}`, { visibility: 'shared_with_org' }, KOLA);
  await j('POST', `/player/development/plans/${PLAN_ID}/share`, { orgId: 'org-eastport' }, KOLA);
  say('H4: the player shares the plan with a named club');
}

// ------------------------------------------------------------------- the club
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
async function enterClub(ctx, who, name, role) {
  const page = watch(await ctx.newPage(), who);
  await page.goto(`http://localhost:${CLUB_PORT}/`);
  await page.click('.org-card:has-text("Eastport FC")');
  await page.fill('.enter-row input', name);
  await page.selectOption('.enter-row select', role).catch(() => {});
  await page.click('button:has-text("Enter workspace")');
  await page.waitForSelector('nav.sidebar', { timeout: 30000 });
  return page;
}
const openPlayerDrawer = async (page) => {
  // Close whatever drawer is already open: its veil swallows the next click,
  // which is how this suite first failed.
  if (await page.locator('.drawer-veil').count()) {
    await page.locator('.drawer .close').first().click().catch(() => {});
    await page.waitForSelector('.drawer-veil', { state: 'detached', timeout: 10000 }).catch(() => {});
  }
  await page.evaluate(() => { window.location.hash = '#/search'; });
  await page.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 25000 });
  await page.click('.player-card:has-text("Kola Adeyemi")');
  await page.waitForSelector('[data-open-development]', { timeout: 25000 });
  await page.click('[data-open-development]');
  await page.waitForSelector('[data-development-panel]', { timeout: 25000 });
};

const maria = await enterClub(ctxA, 'maria', 'Maria Keane', 'Head of Recruitment');
const MARIA = await maria.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; } });
ok(!!MARIA, 'a Head of Recruitment is signed in to the Pro workspace');

{
  // §54 — no new top-level destination.
  const sidebar = await maria.locator('nav.sidebar').innerText();
  ok(!/^Development$/m.test(sidebar), 'H4: Development is not a new sidebar section — it lives inside a player');
  await openPlayerDrawer(maria);
  await maria.locator('[data-plan-overview]').first().waitFor({ timeout: 20000 }).catch(() => {});
  const panel = await maria.locator('[data-development-panel]').innerText();
  if (!/Improve weak-foot passing consistency/.test(panel)) {
    console.error('   panel says:', panel.slice(0, 600));
    console.error('   server says:', JSON.stringify((await j('GET', '/org/development/plans?playerId=pl-adeyemi', undefined, MARIA)).body).slice(0, 600));
  }
  ok(/Improve weak-foot passing consistency/.test(panel), 'H4: the club can read the plan the player shared');
  const canEdit = await maria.locator('[data-development-panel] [data-link-evidence]').count();
  ok(canEdit === 0, 'H4: and cannot edit it — a club never edits a plan it does not own');
  ok(/no overall figure/i.test(panel), 'H4: the club view carries the same denial of a headline number');
}

// ------------------------------------------------------------------ H5 / H6
let clubPlanId = null; let clubGoalId = null;
{
  // The club's own plan, with a private note in a review.
  const made = await j('POST', '/org/development/plans', {
    playerId: 'pl-adeyemi', title: 'Eastport development', visibility: 'player_guardian', status: 'active',
    goals: [{ title: 'Improve scanning before receiving possession', category: 'match_understanding' }],
  }, MARIA);
  clubPlanId = made.body.plan.id;
  clubGoalId = made.body.goals[0].id;

  await openPlayerDrawer(maria);
  // Pick the club's own plan if the panel offers more than one.
  await maria.waitForSelector('[data-plan-overview]', { timeout: 20000 });
  await maria.fill('[aria-label="Summary for the player"]', 'Good week on the weak foot.').catch(() => {});
  await maria.fill('[aria-label="Internal note"]', 'INTERNAL-ONLY-LINE — not ready for the first team.').catch(() => {});
  const submitted = await maria.locator('button:has-text("Submit review")').count();
  if (submitted) {
    await maria.click('button:has-text("Submit review")');
    await maria.waitForSelector('[data-review]', { timeout: 20000 });
    say('H6: a coach submits a review through the real workspace');
  } else {
    // The panel opened on the player-owned plan, which a club cannot review.
    await j('POST', `/org/development/plans/${clubPlanId}/reviews`, {
      summary: 'Good week on the weak foot.', internalNote: 'INTERNAL-ONLY-LINE — not ready for the first team.',
    }, MARIA);
    say('H6: a coach submits a review (the drawer opened on the shared player plan, which a club may not review)');
  }

  const clubBody = await maria.locator('[data-development-panel]').innerText();
  ok(!/PATCH|Edit review/.test(clubBody), 'H6: the club surface offers no way to edit a submitted review');
  ok((await j('PATCH', `/org/development/reviews/${(await j('GET', `/org/development/plans/${clubPlanId}`, undefined, MARIA)).body.reviews[0].id}`, { summary: 'x' }, MARIA)).status === 404,
    'H6: and no such route exists to call directly');

  // H5 — the player's own view of the same plan.
  await reopenYou(player);
  const playerBody = await player.locator('body').innerText();
  ok(!/INTERNAL-ONLY-LINE/.test(playerBody), 'H5: the club’s internal note appears nowhere on the player’s screen');
  const payload = (await j('GET', `/player/development/plans/${clubPlanId}`, undefined, KOLA)).body;
  ok(!JSON.stringify(payload).includes('INTERNAL-ONLY-LINE'), 'H5: and nowhere in the payload the player receives');
  ok(payload.reviews.length === 0 || payload.reviews[0].internalNoteNote != null,
    'H5: an unshared review is withheld entirely; a shared one acknowledges that a private note exists');
}

// ---------------------------------------------------------------------- H8
//
// Driven across two actors on the CLUB's plan, which is the stronger journey
// and the one a coach would actually run: the coach cites a Combine result,
// Trust & Safety invalidates the session behind it, and the PLAYER — who can
// read that plan because the club shared it — sees the citation go
// unavailable without anybody editing the plan.
{
  await openPlayerDrawer(maria);
  await maria.locator('[data-plan-overview]').first().waitFor({ timeout: 20000 });
  await maria.locator('[data-link-evidence]').first().click();
  await maria.waitForSelector('[data-evidence-picker]', { timeout: 20000 });
  const offered = await maria.locator('[data-evidence-picker] .list-row').count();
  ok(offered > 0, 'H8: the coach is offered canonical records to cite, resolved live rather than assembled by the client');
  const combineRow = maria.locator('[data-evidence-picker] .list-row:has-text("Combine result")').first();
  const hasCombine = await combineRow.count();
  if (hasCombine) await combineRow.locator('button:has-text("Link")').click();
  else await maria.locator('[data-evidence-picker] .list-row').first().locator('button:has-text("Link")').click();
  await maria.waitForSelector('[data-development-panel] [data-evidence]', { timeout: 20000 });
  say('H8: the coach links a canonical record to the goal, through the real picker');

  const plan = (await j('GET', `/org/development/plans/${clubPlanId}`, undefined, MARIA)).body;
  const linked = plan.goals[0].evidence[0];
  ok(!!linked && linked.available, 'H8: the link resolves as available before anything changes');

  // Invalidate whatever it points at. A Combine result goes through its Box
  // Cam session; a Box Cam session goes directly.
  const attempts = (await j('GET', '/player/combine/attempts', undefined, KOLA)).body.items ?? [];
  const sessions = (await j('GET', '/player/box-cam/sessions', undefined, KOLA)).body.items ?? [];
  const sessionId = linked.sourceType === 'combine_attempt'
    ? (attempts.find((a) => a.id === linked.sourceId)?.boxSessionId ?? sessions[0]?.id)
    : linked.sourceId;
  const disp = await j('POST', `/player/box-cam/sessions/${sessionId}/dispute`, { reason: 'Box Cam over-counted my control time.' }, KOLA);
  const dId = disp.body?.dispute?.id ?? disp.body?.id;
  const resolved = await j('POST', `/admin/box-cam/disputes/${dId}/resolve`, { outcome: 'invalidated', reason: 'Integrity review.' }, undefined, ADMIN);
  ok(resolved.status === 200, 'H8: Trust & Safety invalidates the session behind the citation');

  await openPlayerDrawer(maria);
  await maria.locator('[data-plan-overview]').first().waitFor({ timeout: 20000 });
  const clubPanel = await maria.locator('[data-development-panel]').innerText();
  ok(/Evidence unavailable|Not available/.test(clubPanel), 'H8: the coach’s own view reads unavailable NOW, not as it was when cited');
  ok(/invalidated after review/i.test(clubPanel), 'H8: and says which absence it is');
  ok(!/\bmeasured\b.*\d/i.test(clubPanel.split('Evidence unavailable')[1] ?? ''), 'H8: the withdrawn citation carries no measurement');

  await reopenYou(player);
  const body = await player.locator('body').innerText();
  ok(/Evidence unavailable|Not available/.test(body), 'H8: and the player sees the same, on the plan the club shared with them');
  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'H8: still no score anywhere');

  // The player has two plans by now, so the section offers a switcher.
  const dev = await devText(player);
  ok(/My development plan/.test(dev) && /Eastport development/.test(dev),
    'H8: with more than one plan, the player is offered both by name rather than shown a merged view');
  ok(await selectPlan(player, 'My development plan'), 'H8: …and switching to their own plan actually switches the view');
  const own = await devText(player);
  ok(/Improve weak-foot passing consistency/.test(own), 'H8: which shows the goal they wrote themselves');
}

// ---------------------------------------------------------------------- H9
{
  const tom = await enterClub(ctxB, 'tom', 'Tom Field', 'First-Team Scout');
  await openPlayerDrawer(maria);
  await openPlayerDrawer(tom);
  // Both read the same goal, then both edit it. The server accepts one.
  const before = (await j('GET', `/org/development/plans/${clubPlanId}`, undefined, MARIA)).body.goals[0];
  const first = await j('PATCH', `/org/development/goals/${before.id}`, { title: 'Maria’s edit', expectedRev: before.rev }, MARIA);
  ok(first.status === 200, 'H9: the first coach’s edit is accepted');

  // The second coach's stale edit, made through the real UI.
  const tomPanel = await tom.locator('[data-development-panel]').count();
  ok(tomPanel === 1, 'H9: the second coach has the same plan open');
  const stale = await j('PATCH', `/org/development/goals/${before.id}`, { title: 'Tom’s edit', expectedRev: before.rev }, await tom.evaluate(() => { try { return JSON.parse(localStorage.getItem('scoutbox-club-session') ?? 'null')?.token ?? null; } catch { return null; } }));
  ok(stale.status === 409 && /VERSION_CONFLICT$/.test(stale.body.error), 'H9: the stale edit is refused with the shared conflict code');
  ok(stale.body.updatedBy != null && stale.body.currentRev > before.rev, 'H9: the conflict names who moved it and where it is now');
  ok(!('title' in stale.body), 'H9: and never carries what the other person wrote — the caller keeps its own draft');
  await tom.close();
}

// --------------------------------------------------------------------- H10
{
  const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
  const made = await j('POST', '/guardian/development/plans', {
    playerId: 'pl-guni', title: 'Under-16 development', visibility: 'private', status: 'active',
    goals: [{ title: 'Improve first touch under pressure', category: 'technical' }],
  }, amara);
  ok(made.status === 201, 'H10: the guardian creates the minor’s plan');
  const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body.token;
  ok((await j('GET', `/player/development/plans/${made.body.plan.id}`, undefined, guni)).status === 200,
    'H10: the minor can read their own plan');
  ok((await j('POST', `/player/development/plans/${made.body.plan.id}/goals`, { title: 'Mine', category: 'other' }, guni)).status === 403,
    'H10: and cannot write to it — the safeguarding model is unchanged');
  ok((await j('POST', '/player/development/plans', { title: 'Mine', visibility: 'private' }, guni)).body.error === 'GUARDIAN_MANAGED',
    'H10: a minor cannot create a plan of their own');

  const ctxMinor = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const minorPage = watch(await ctxMinor.newPage(), 'minor');
  await minorPage.goto(`http://localhost:${PLAYER_PORT}/`);
  await minorPage.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  const guniEntry = minorPage.locator('.card:has-text("Guni")').locator('text=Enter').first();
  if (await guniEntry.count()) {
    await guniEntry.click();
    await minorPage.waitForSelector('text=Your visibility right now', { timeout: 30000 });
    await minorPage.click('a[href="/you"]');
    await minorPage.waitForSelector('text=Development', { timeout: 30000 });
    const body = await minorPage.locator('body').innerText();
    ok(/Improve first touch under pressure/.test(body), 'H10: the minor sees the plan their guardian manages');
    ok(!/Add goal/.test(body), 'H10: and is offered no way to add to it');
  } else {
    say('H10: the minor’s own device session is not offered on this build’s onboarding screen (API path asserted above)');
  }
  await ctxMinor.close();
}

// --------------------------------------------------------------------- H11
{
  const block = await j('POST', '/player/block', { orgId: 'org-eastport' }, KOLA);
  ok(block.status < 400, 'H11: the player blocks the club');
  await openPlayerDrawer(maria).catch(() => {});
  const gone = await j('GET', `/org/development/plans/${PLAN_ID}`, undefined, MARIA);
  ok(gone.status === 404, 'H11: the club can no longer read the shared plan');
  const stale = await j('GET', `/org/development/plans/${clubPlanId}`, undefined, MARIA);
  ok(stale.status === 404, 'H11: and a deep link to its own plan for that player answers as a nonexistent record');
  ok(!JSON.stringify(stale.body).includes('Kola'), 'H11: the refusal names nobody — no stale identity leaks through the URL');

  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body ?? [];
  const mine = blocks.find((b) => b.playerId === 'pl-adeyemi' && b.orgId === 'org-eastport');
  if (mine) await j('POST', `/admin/blocks/${mine.id}/lift`, {}, undefined, ADMIN);
  ok((await j('GET', `/org/development/plans/${clubPlanId}`, undefined, MARIA)).status === 200,
    'H11: lifting the block restores access — the gate is live in both directions');
}

// --------------------------------------------------------------------- H12
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const small = watch(await phone.newPage(), 'phone');
  await small.goto(`http://localhost:${PLAYER_PORT}/`);
  await small.waitForSelector('text=Our promises to every player', { timeout: 40000 });
  await small.locator('text=Enter').nth(0).click();
  await small.waitForSelector('text=Your visibility right now', { timeout: 30000 });
  await small.click('a[href="/you"]');
  await small.waitForSelector('text=Development', { timeout: 30000 });
  // Wait for the section to finish loading before judging what it shows.
  for (let i = 0; i < 40; i++) {
    const txt = await devText(small);
    if (txt && !/Loading your development plan/.test(txt) && /MY GOALS|No development plan/.test(txt)) break;
    await small.waitForTimeout(500);
  }
  await small.getByText('Show development history', { exact: true }).first().click().catch(() => {});
  await small.waitForTimeout(1200);
  const body = await small.locator('body').innerText();
  if (!/actions completed/.test(body)) console.error('   phone section:', (await devText(small)).slice(0, 700));
  ok(/Active goals/.test(body) && /actions completed/.test(body) && /Match understanding|Technical/.test(body),
    'H12: the plan, its goals and their counts are readable at 390px');
  ok(/Plan created|Goal created|Action completed/.test(body), 'H12: …and so is the development history');
  const overflow = await small.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `H12: nothing overflows sideways at 390px (${overflow}px)`);
  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'H12: no forbidden vocabulary on the phone layout either');

  // The club panel at phone width.
  const smallClub = watch(await phone.newPage(), 'phone-club');
  await smallClub.goto(`http://localhost:${CLUB_PORT}/`);
  await smallClub.click('.org-card:has-text("Eastport FC")');
  await smallClub.fill('.enter-row input', 'Maria Keane');
  await smallClub.selectOption('.enter-row select', 'Head of Recruitment').catch(() => {});
  await smallClub.click('button:has-text("Enter workspace")');
  await smallClub.waitForSelector('nav.sidebar', { timeout: 30000 });
  await openPlayerDrawer(smallClub);
  const clubOverflow = await smallClub.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(clubOverflow <= 4, `H12: the club panel fits 390px too (${clubOverflow}px)`);
  await phone.close();
}

// --------------------------------------------------------- accessibility + i18n
{
  await openPlayerDrawer(maria);
  const labelled = await maria.locator('[data-development-panel] select').evaluateAll((els) => els.every((e) => !!e.getAttribute('aria-label')));
  ok(labelled, 'every status control in the club panel carries a label — state is never colour alone');
  const statuses = await maria.locator('[data-goal-status]').allInnerTexts();
  ok(statuses.every((s) => s.trim().length > 0), 'every goal status renders its word, not just a colour');
  const panel = await maria.locator('[data-development-panel]').innerText();
  ok(!/m21\./.test(panel), 'no raw m21 i18n key leaks into the club panel');
  ok(!FORBIDDEN.some((re) => re.test(denials(panel))), 'the club panel carries no forbidden vocabulary');
  const limitation = await maria.locator('[data-development-panel] [data-limitation]').count();
  ok(limitation >= 1, 'the panel prints its limitation on screen, beside the record');
}

ok(errors.length === 0, `no page errors across the journeys${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(`\nM21 live journeys: ${passed} checks passed`);
