// M16.2 demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through every Trust Score surface and fails on any page
// error. The demo story: Kola has a broad, attributable record (Strong
// evidence); Elias has less on record (Developing evidence) and the UI must
// present that as LIMITED EVIDENCE, never as a lesser or riskier player.
// Requires `node serve.mjs` on :8099.
import { chromium } from 'playwright-core';
import { ensureDemoHost } from './demoHost.mjs';

// D7 (M22 §74-§76): own the demo host instead of assuming one is up.
// These files hard-coded the URL inline, so the earlier pass imported the
// helper without ever calling it — the import looked like the fix and was
// not one.
const demo = await ensureDemoHost();

const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const DISCLAIMER = /reflects verification and evidence confidence — not football ability or recruitment suitability/;
// Language that would turn an evidence score into a character or talent
// judgement. None of it may appear on any Trust surface, in any app.
const FORBIDDEN = /untrustworthy|suspicious|fraudulent|risky|bad player|poor player|talent score|ability score|potential score/i;
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

// ============================================== player demo: Trust Profile
const player = await page(`${demo.host}/player/`, { width: 480, height: 1200 });
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/football"]');
await player.waitForSelector('text=ScoutBox Trust Score', { timeout: 20000 });
{
  const body = await player.locator('body').innerText();
  if (!DISCLAIMER.test(body)) fail('player demo: the mandatory disclaimer is missing');
  say('player demo: the Trust Score carries the mandatory disclaimer');
  if (!/79/.test(body) || !/Strong evidence/.test(body)) fail('player demo: the fixture score/band did not render');
  say('player demo: the demo player reads 79 — Strong evidence');
  if (FORBIDDEN.test(body)) fail('player demo: prohibited ability/character language on the Trust surface');
  say('player demo: no ability or character language appears');
  // §17/§58 — a simulated evidence context must say so wherever it is shown.
  if (!/[Dd]emo|simulated/.test(body)) fail('player demo: simulated evidence is not labelled');
  say('player demo: simulated evidence is labelled on the score');

  await player.getByText('Why this score?', { exact: true }).first().click();
  await player.waitForSelector('text=Evidence Confidence', { timeout: 15000 });
  const why = await player.locator('body').innerText();
  for (const c of ['Identity', 'Football history', 'Relationships', 'Evidence', 'Combine', 'References']) {
    if (!why.includes(c)) fail(`player demo: "Why this score?" is missing ${c}`);
  }
  say('player demo: "Why this score?" explains all six components');
  if (!/Policy version/.test(why)) fail('player demo: the policy version is not shown');
  say('player demo: the derivation names its policy version');
  // §26 — a gap is an evidence gap, never an accusation.
  if (!/provided by the player and not independently confirmed/.test(why)) fail('player demo: player-submitted history is not honestly labelled');
  say('player demo: an unconfirmed entry is labelled as unconfirmed, not as dishonest');
}
await player.close();

// ============================================== Pro demo: safe club view
const club = await page(`${demo.host}/club/`);
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('nav.sidebar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/search'; });
await club.waitForSelector('.player-card:has-text("Kola Adeyemi")', { timeout: 20000 });
await club.click('.player-card:has-text("Kola Adeyemi")');
await club.waitForSelector('[aria-label="Trust Profile"]', { timeout: 15000 });
{
  await club.click('[aria-label="Trust Profile"] button:has-text("Show")');
  await club.waitForSelector('[aria-label="Trust Profile"]:has-text("Evidence Confidence")', { timeout: 15000 });
  const panel = await club.locator('[aria-label="Trust Profile"]').innerText();
  if (!/79/.test(panel) || !/Strong evidence/.test(panel)) fail('pro demo: the club fixture score/band did not render');
  say('pro demo: the club sees the score and band for a well-evidenced player');
  if (!/not football ability/i.test(panel)) fail('pro demo: the club panel is missing the ability disclaimer');
  say('pro demo: the club panel states evidence confidence, not football ability');
  if (!/never ranks players by Trust Score/i.test(panel)) fail('pro demo: the no-ranking statement is missing');
  say('pro demo: the club panel states ScoutBox never ranks players by Trust Score');
  if (FORBIDDEN.test(panel)) fail('pro demo: prohibited language in the club panel');
  say('pro demo: no ability or character language reaches the club');
  // §54/§76 — the club never sees the player's own derivation or sources.
  if (/What could strengthen it further/i.test(panel)) fail('pro demo: the player\'s evidence gaps leaked to the club');
  if (/gd-|vclm-|identityVerified/.test(panel)) fail('pro demo: source identifiers leaked to the club');
  say('pro demo: neither the evidence gaps nor any source identifier reaches the club');
}
// §27/§29 — the player with less on record is presented as limited evidence.
await club.click('.drawer button.close');
await club.waitForSelector('.drawer-veil', { state: 'detached', timeout: 10000 });
await club.click('.player-card:has-text("Elias Svensson")');
await club.waitForSelector('[aria-label="Trust Profile"]', { timeout: 15000 });
{
  await club.click('[aria-label="Trust Profile"] button:has-text("Show")');
  await club.waitForSelector('[aria-label="Trust Profile"]:has-text("Evidence Confidence")', { timeout: 15000 });
  const panel = await club.locator('[aria-label="Trust Profile"]').innerText();
  if (!/Developing evidence/.test(panel)) fail('pro demo: the second demo player did not render a lower band');
  say('pro demo: a thinner record reads as Developing evidence, with the same neutral framing');
  if (FORBIDDEN.test(panel)) fail('pro demo: a lower score is framed as a judgement of the player');
  say('pro demo: a lower score carries no judgement of the player');
}
await club.close();

// ============================================== Grassroots demo
const grass = await page(`${demo.host}/grassroots/`);
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('nav.sidebar', { timeout: 20000 });
await grass.evaluate(() => { location.hash = '#/search'; });
await grass.waitForSelector('.player-card', { timeout: 20000 });
await grass.locator('.player-card').first().click();
await grass.waitForSelector('[aria-label="Trust Profile"]', { timeout: 15000 });
{
  await grass.click('[aria-label="Trust Profile"] button:has-text("Show")');
  await grass.waitForSelector('[aria-label="Trust Profile"]:has-text("Evidence Confidence")', { timeout: 15000 });
  const panel = await grass.locator('[aria-label="Trust Profile"]').innerText();
  if (!/not football ability/i.test(panel)) fail('grassroots demo: the ability disclaimer is missing');
  say('grassroots demo: the grassroots club sees the same safe Trust panel');
  if (FORBIDDEN.test(panel)) fail('grassroots demo: prohibited language in the grassroots panel');
  say('grassroots demo: no ability or character language in the grassroots panel');
}
await grass.close();

// ============================================== T&S demo: derivation only
const admin = await page(`${demo.host}/admin/`);
await admin.waitForSelector('text=Report queue', { timeout: 20000 });
await admin.click('nav.sidebar button:has-text("Cases")');
await admin.click('nav.subnav button:has-text("Trust")');
await admin.waitForSelector('text=ScoutBox Trust Score', { timeout: 15000 });
{
  const body = await admin.locator('body').innerText();
  if (!DISCLAIMER.test(body)) fail('T&S demo: the mandatory disclaimer is missing');
  say('T&S demo: the inspector carries the mandatory disclaimer');
  // §50 — T&S can inspect a derivation but can never type a score.
  if (!/cannot set or adjust a score/i.test(body)) fail('T&S demo: the no-write notice is missing');
  say('T&S demo: the inspector states that a score cannot be set or adjusted');
  if (!/correct the underlying evidence or the policy/i.test(body)) fail('T&S demo: the remedy is not stated');
  say('T&S demo: the stated remedy is to correct the evidence or the policy, then recalculate');
  if (await admin.locator('input[type="number"]').count()) fail('T&S demo: a numeric input on the Trust inspector could be read as a score field');
  say('T&S demo: the inspector offers no field that could set a score');
  if (FORBIDDEN.test(body)) fail('T&S demo: prohibited language in the inspector');
  say('T&S demo: no ability or character language in the inspector');
}
await admin.close();

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
console.log(`\nm162DemoSpotcheck: ${passed} checks passed — Trust Score demo story OK, zero page errors`);
process.exit(0);
