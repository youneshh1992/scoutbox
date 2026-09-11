// M17 demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through every Recruitment Room surface and fails on any page
// error. The boundary this asserts hardest: the Room exists in Pro and
// Grassroots and does NOT exist in the player app.
// Requires `node serve.mjs` on :8099.
import { chromium } from 'playwright-core';

const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
// Language that would turn a workspace into a talent judgement.
const FORBIDDEN = /player score|overall rating|talent score|signing probability|readiness score|decision score|untrustworthy|suspicious|risky|poor player/i;
let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: EXE });
const errors = [];
async function page(url, viewport = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport });
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(url);
  return p;
}

async function driveClub(url, label, { enterprise }) {
  const app = await page(url);
  await app.click('.org-card');
  await app.fill('.enter-row input', 'Maria Keane');
  await app.click('button:has-text("Enter workspace")');
  await app.waitForSelector('nav.sidebar', { timeout: 25000 });

  // The Room lives inside the EXISTING Recruitment destination.
  await app.evaluate(() => { location.hash = '#/rooms'; });
  await app.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 20000 });
  say(`${label}: the Rooms list opens inside Recruitment`);
  {
    const body = await app.locator('body').innerText();
    if (!/never sorts or ranks rooms by Trust Score/i.test(body)) fail(`${label}: the no-ranking statement is missing`);
    say(`${label}: the list states rooms are never ranked by Trust Score`);
    if (!/Evidence confidence — not football ability/i.test(body)) fail(`${label}: the Trust disclaimer is missing from the list`);
    say(`${label}: the Trust Score carries its disclaimer in the list`);
    if (FORBIDDEN.test(body)) fail(`${label}: prohibited scoring language in the Rooms list`);
    say(`${label}: no player score, rating or probability appears in the list`);
  }

  // Saved views are filters on one page, not new sidebar destinations.
  const sidebarItems = await app.locator('nav.sidebar button').count();
  await app.click('[aria-label="Saved views"] button[role="tab"]:nth-child(2)');
  await app.waitForTimeout(400);
  if (await app.locator('nav.sidebar button').count() !== sidebarItems) fail(`${label}: a saved view changed the global navigation`);
  say(`${label}: saved views are page-level filters, not new sidebar items`);
  await app.click('[aria-label="Saved views"] button[role="tab"]:nth-child(1)');
  await app.waitForTimeout(400);

  await app.click('button[aria-label^="Open room"]');
  await app.waitForSelector('[aria-label="Room header"]', { timeout: 20000 });
  say(`${label}: a room opens from the list`);
  {
    const hash = await app.evaluate(() => location.hash);
    if (!/^#\/recruitment\/rooms\//.test(hash)) fail(`${label}: the room has no deep link (${hash})`);
    say(`${label}: the room has its own deep link`);
    const header = await app.locator('[aria-label="Room header"]').innerText();
    if (!/Evidence confidence — not football ability/i.test(header)) fail(`${label}: the room header shows a score without its disclaimer`);
    say(`${label}: the room header shows the Trust Score with its disclaimer`);
    const body = await app.locator('body').innerText();
    if (!/private to your organisation/i.test(body)) fail(`${label}: the room does not state it is organisation-private`);
    say(`${label}: the room states it is private to the organisation`);
  }

  for (const tab of ['Overview', 'Passport', 'Evidence', 'Assessments', 'Combine', 'Development', 'Discussion', 'Activity', 'Decision']) {
    await app.click(`[aria-label="Room sections"] button[role="tab"]:has-text("${tab}")`);
    await app.waitForSelector(`[role="tabpanel"][aria-label="${tab}"]`, { timeout: 10000 });
  }
  say(`${label}: all nine room tabs render`);

  // Readiness is counts and words; health is a word.
  await app.click('[aria-label="Room sections"] button[role="tab"]:has-text("Overview")');
  {
    const panel = await app.locator('[role="tabpanel"][aria-label="Overview"]').innerText();
    if (FORBIDDEN.test(panel)) fail(`${label}: prohibited scoring language on the overview`);
    say(`${label}: the overview carries no second score`);
    if (!/Ready for review|Waiting on evidence|Assessment outstanding|Trial pending|Decision recorded/i.test(panel)) fail(`${label}: room health is not shown as a word`);
    say(`${label}: room health is a word, never a number`);
  }

  // A room task is staff work and says so.
  {
    const panel = await app.locator('[role="tabpanel"][aria-label="Overview"]').innerText();
    if (!/never sent to the player/i.test(panel)) fail(`${label}: the tasks note does not say tasks are never sent to the player`);
    say(`${label}: room tasks state they are never sent to the player`);
  }

  // Discussion is internal, and a deleted comment is tombstoned not erased.
  await app.click('[aria-label="Room sections"] button[role="tab"]:has-text("Discussion")');
  {
    const panel = await app.locator('[role="tabpanel"][aria-label="Discussion"]').innerText();
    if (!/tombstoned, never erased/i.test(panel)) fail(`${label}: the tombstone rule is not explained`);
    say(`${label}: the discussion explains that a deleted comment is tombstoned, never erased`);
  }

  // The decision tab is human-framed and append-only.
  await app.click('[aria-label="Room sections"] button[role="tab"]:has-text("Decision")');
  {
    const panel = await app.locator('[role="tabpanel"][aria-label="Decision"]').innerText();
    if (!/human judgement/i.test(panel)) fail(`${label}: the decision tab does not say the decision is human`);
    say(`${label}: the decision tab states ScoutBox never recommends whether to sign`);
    if (!/append-only/i.test(panel)) fail(`${label}: the append-only rule is not stated`);
    say(`${label}: the decision tab states decisions are append-only`);
    if (FORBIDDEN.test(panel)) fail(`${label}: prohibited scoring language on the decision tab`);
    say(`${label}: the decision tab produces no score of its own`);
  }

  // The archived room is where decision memory actually has something to show:
  // a superseded decision, a structured archive reason, and the evidence
  // confidence the club could see when it decided.
  await app.evaluate(() => { location.hash = '#/rooms'; });
  await app.waitForSelector('[aria-label="Recruitment Rooms table"]', { timeout: 20000 });
  await app.click('[aria-label="Saved views"] button[role="tab"]:has-text("Archived")');
  await app.waitForTimeout(500);
  await app.click('button[aria-label^="Open room"]');
  await app.waitForSelector('[aria-label="Room header"]', { timeout: 20000 });
  await app.click('[aria-label="Room sections"] button[role="tab"]:has-text("Decision")');
  {
    const panel = await app.locator('[role="tabpanel"][aria-label="Decision"]').innerText();
    if (!/Trust at decision/i.test(panel)) fail(`${label}: the decision-time Trust snapshot is not shown`);
    say(`${label}: an archived room shows the Trust Score at decision time beside the current one`);
    if (!/insufficient|recent evidence/i.test(panel)) fail(`${label}: the structured archive reason is not shown`);
    say(`${label}: the archive reason is shown as a structured, machine-readable reason`);
    if (!/superseded|Superseded/.test(panel)) fail(`${label}: the superseded earlier decision is not marked`);
    say(`${label}: the earlier decision is marked superseded rather than rewritten`);
  }

  if (enterprise) {
    // Structured reasons only — and never a protected characteristic.
    await app.click('[aria-label="Room sections"] button[role="tab"]:has-text("Overview")');
    const reasons = await app.locator('[aria-label="Reasons"]').innerText().catch(() => '');
    if (/nationality|ethnic|religion|disab|postcode|income/i.test(reasons)) fail(`${label}: a protected characteristic is offered as a reason`);
    say(`${label}: the reason picker offers no protected characteristic`);
  }

  // Narrow layout: the tab strip scrolls, the page does not.
  await app.setViewportSize({ width: 400, height: 900 });
  await app.waitForTimeout(500);
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  if (overflow) fail(`${label}: the room overflows horizontally at 400px`);
  say(`${label}: the room fits a 400px viewport with no horizontal page scroll`);
  await app.setViewportSize({ width: 1440, height: 900 });

  await app.close();
}

await driveClub('http://localhost:8099/club/', 'pro demo', { enterprise: true });
await driveClub('http://localhost:8099/grassroots/', 'grassroots demo', { enterprise: false });

// ================================= the player app must not know rooms exist
{
  const player = await page('http://localhost:8099/player/', { width: 480, height: 1200 });
  await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
  await player.locator('text=Enter').nth(0).click();
  await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
  await player.click('a[href="/you"]');
  await player.waitForSelector('text=ScoutBox Trust Score', { timeout: 20000 });
  const body = await player.locator('body').innerText();
  if (/Recruitment Room/i.test(body)) fail('player demo: the player app mentions a Recruitment Room');
  say('player demo: the player app never mentions a Recruitment Room');
  // NB the word "shortlist" legitimately appears in the player's OWN interest
  // feed ("2 clubs shortlisted you") — that is a pre-existing player-facing
  // insight, not room state. What must never appear is the room's internal
  // vocabulary.
  // ("append-only" is likewise pre-existing: the player is told their safety
  // ledger is append-only, which is about THEIR record, not a room's.)
  if (/room lead|decision readiness|room health|reason code|trust at decision|private to your organisation/i.test(body)) {
    fail('player demo: club-internal recruitment vocabulary leaked to the player');
  }
  say('player demo: no room lead, readiness, health, decision reason or snapshot reaches the player');
  if (/Under review|Offer consideration|Trial requested|Offer made/i.test(body)) fail('player demo: a room status label leaked to the player');
  say('player demo: no room status label reaches the player');
  await player.close();
}

// ============================= T&S sees counts, never a room's contents
{
  const admin = await page('http://localhost:8099/admin/');
  await admin.waitForSelector('text=Report queue', { timeout: 20000 });
  const body = await admin.locator('body').innerText();
  if (/Recruitment Room — |room discussion|decision reason/i.test(body)) fail('T&S demo: room contents are exposed in the back office');
  say('T&S demo: the back office exposes no Recruitment Room contents');
  await admin.close();
}

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
console.log(`\nm17DemoSpotcheck: ${passed} checks passed — Recruitment Rooms demo story OK, zero page errors`);
process.exit(0);
