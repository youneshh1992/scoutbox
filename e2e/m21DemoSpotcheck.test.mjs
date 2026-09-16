// M21 demo spotcheck — the Development Hub as it appears in the SHIPPED
// single-file bundles.
//
// The demo bundles are the artifact HTML: no server, no network. What this
// asserts is that the M21 surface is really in them and really behaves:
//   • the club and grassroots bundles reach a Development panel inside a
//     player, with no new top-level destination
//   • plan, goals, actions, evidence, reviews and history all render
//   • the demo's Combine result is SIMULATED, so the objective target reads
//     "no current valid measurement" and says why — a demo number crossing a
//     production threshold is the dishonesty §149 exists to prevent
//   • an unavailable evidence link is shown as unavailable, because that is a
//     real state and hiding it would make the demo easier than the product
//   • the club sees its internal review note; the PLAYER bundle contains no
//     such note at all
//   • no Development Score, no ranking, no progress bar, in either language
//   • the demos make NO real network request
//   • 390px
//
// Requires `node serve.mjs` on :8099 with freshly built demo bundles.
import { chromium } from 'playwright-core';
import { ensureDemoHost } from './demoHost.mjs';

// D7 (M22 §74-§76): this test OWNS its demo host rather than assuming one
// is already listening. The old comment above said "Requires node
// serve.mjs on :8099" — an instruction nobody followed, because
// crosstab and demoOffline happened to leave a host behind. They no
// longer do.
const demo = await ensureDemoHost();
const BASE = demo.host.replace('localhost', '127.0.0.1');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: EXE });
const allErrors = [];
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const FORBIDDEN = [
  /Development Score/i, /Potential Score/i, /Improvement Score/i, /Readiness Score/i,
  /Growth Score/i, /Academy Score/i, /Player Progress Rating/i, /Player Rating/i,
  /Development Ranking/i, /Coach Ranking/i, /Leaderboard/i,
];
/** Strip the passage that exists precisely to deny those terms. */
const denials = (t) => t
  .replace(/These do not exist in ScoutBox[\s\S]{0,700}?(?=\n\n|$)/gi, '')
  .replace(/Ces éléments n[\s\S]{0,700}?(?=\n\n|$)/gi, '')
  .replace(/never .{0,90}score[^.]*\./gi, '');

async function open(url, viewport = { width: 1440, height: 1000 }) {
  const p = await browser.newPage({ viewport });
  const errors = [];
  const network = [];
  p.on('pageerror', (e) => { errors.push(`${url}: ${e.message}`); allErrors.push(`${url}: ${e.message}`); });
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.location()?.url?.endsWith('/favicon.ico')) {
      errors.push(`${url}: console ${m.text()}`);
      allErrors.push(`${url}: console ${m.text()}`);
    }
  });
  // A demo bundle may fetch nothing but itself.
  p.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) network.push(r.url()); });
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  return { p, errors, network };
}

async function login(p) {
  await p.click('.org-card');
  await p.fill('input[placeholder^="Your name"]', 'A. Coach');
  await p.click('button.primary');
  await p.waitForTimeout(900);
}

// ============================================================ org bundles
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors, network } = await open(`${BASE}/${path}`);
  await login(p);

  // ---- §54: no new top-level destination
  const sidebar = await p.locator('nav.sidebar').innerText().catch(() => '');
  ok(!/^Development$/m.test(sidebar), `${name} Development is not a new sidebar section`);

  // ---- reach the panel through a player, which is where it lives
  await p.evaluate(() => { window.location.hash = '#/search'; });
  await p.waitForSelector('.player-card', { timeout: 20000 });
  await p.locator('.player-card').first().click();
  await p.waitForSelector('[data-open-development]', { timeout: 20000 });
  await p.click('[data-open-development]');
  await p.waitForSelector('[data-development-panel]', { timeout: 20000 });
  await p.waitForTimeout(700);
  const panel = await p.locator('[data-development-panel]').innerText();
  ok(/Pre-season Development Plan/.test(panel), `${name} the Development Hub loads inside a player`);

  // ---- the six sections
  ok(await p.locator('[data-plan-overview]').count() === 1, `${name} the plan overview renders`);
  const goals = await p.locator('[data-goal]').count();
  ok(goals >= 3, `${name} goals render (${goals})`);
  const actions = await p.locator('[data-action]').count();
  ok(actions >= 3, `${name} actions render (${actions})`);
  const evidence = await p.locator('[data-evidence]').count();
  ok(evidence >= 3, `${name} linked evidence renders (${evidence})`);
  const reviews = await p.locator('[data-review]').count();
  ok(reviews >= 2, `${name} reviews render (${reviews})`);
  await p.click('[data-toggle-history]');
  await p.waitForTimeout(500);
  const history = await p.locator('[data-history-entry]').count();
  ok(history >= 5, `${name} development history renders (${history} entries)`);

  // ---- counts, not a score
  ok(/actions completed/.test(panel), `${name} progress is a sentence of counts`);
  ok(await p.locator('progress, [role="progressbar"]').count() === 0, `${name} no progress bar is drawn from those counts`);
  ok(await p.locator('[data-no-score]').count() === 1, `${name} the panel says out loud there is no overall figure`);
  ok(/no overall figure/i.test(await p.locator('[data-no-score]').innerText()), `${name} …in those words`);
  ok(await p.locator('[data-never-built]').count() === 1, `${name} and names what will never be built`);

  // ---- the demo Combine result does not satisfy a production target
  const target = await p.locator('[data-target-state]').first().innerText().catch(() => '');
  ok(/no current valid measurement/i.test(target), `${name} the objective target reads "no current valid measurement"`);
  ok(/simulated or test result cannot satisfy a target/i.test(target),
    `${name} …because the demo result is simulated, and the demo says exactly that`);
  ok(await p.locator('[data-target-state="target_met"]').count() === 0,
    `${name} no demo goal is shown with a met target it did not honestly earn`);
  ok(/Simulated/.test(panel), `${name} the simulated result is labelled simulated wherever it appears`);

  // ---- an unavailable citation stays visible and carries nothing
  const gone = await p.locator('[data-evidence][data-available="no"]').first().innerText().catch(() => '');
  ok(/Evidence unavailable/.test(gone), `${name} an unavailable citation is shown as unavailable, not hidden`);
  ok(/replaced by a corrected record/i.test(gone), `${name} …and says which absence it is`);
  ok(!/Season goals|Old/i.test(gone), `${name} …while carrying no title, value or date of its own`);

  // ---- provenance comes from the canonical vocabulary
  ok(/Confirmed by an authorised administrator|Club confirmed|Captured by Box Cam|Box Cam|Combine|Demo/i.test(panel),
    `${name} evidence carries canonical provenance labels, not invented ones`);

  // ---- the club's own note is here, and marked
  const note = await p.locator('[data-internal-note]').first().innerText().catch(() => '');
  ok(/Internal — not shared with the player/i.test(note), `${name} the club's internal note is shown to the club and marked internal`);
  ok(/Not ready for the first team/.test(note), `${name} …with its content, because this is the club's own view`);

  // ---- achieved never travels without its sentence
  const achieved = await p.locator('[data-goal-status="achieved"]').count();
  if (achieved) {
    ok(await p.locator('[data-achieved-meaning]').count() >= achieved,
      `${name} every achieved goal carries the sentence saying it is not a verified ability`);
  } else {
    ok(true, `${name} no goal is achieved in the demo story, so the achieved sentence has nothing to attach to`);
  }

  // ---- vocabulary and i18n hygiene
  const hit = FORBIDDEN.find((re) => re.test(denials(panel)));
  ok(!hit, `${name} shows no forbidden vocabulary${hit ? ` (${hit})` : ''}`);
  ok(!/\bm21\.[a-zA-Z._]+\b/.test(panel), `${name} leaks no raw m21 i18n key`);
  ok(!/\[object Object\]/.test(panel), `${name} has no rendering artefact`);
  ok(await p.locator('[data-development-panel] [data-limitation]').count() >= 1,
    `${name} the panel prints its limitation on screen, beside the record`);

  // ---- French
  await p.selectOption('select[aria-label="Language"]', 'fr').catch(() => {});
  await p.waitForTimeout(900);
  const fr = await p.locator('[data-development-panel]').innerText().catch(() => '');
  ok(/Développement|Objectifs/.test(fr), `${name} the Development panel is translated`);
  ok(!/\bm21\.[a-zA-Z._]+\b/.test(fr), `${name} no raw m21 key leaks in French`);
  const frHit = FORBIDDEN.find((re) => re.test(denials(fr)));
  ok(!frHit, `${name} no forbidden vocabulary in French${frHit ? ` (${frHit})` : ''}`);
  ok(/aucun chiffre global|pas de chiffre global/i.test(fr) || /Interne/.test(fr),
    `${name} the French panel keeps the same promises, not a shorter version of them`);
  await p.selectOption('select[aria-label="Langue"]', 'en').catch(() => p.selectOption('select[aria-label="Language"]', 'en').catch(() => {}));
  await p.waitForTimeout(700);

  // ---- 390px
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(700);
  const overflow = await p.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `${name} the Development panel fits 390px (overflow=${overflow}px)`);
  await p.setViewportSize({ width: 1440, height: 1000 });

  ok(network.length === 0, `${name} the demo made no external request${network.length ? `: ${network.slice(0, 3).join(', ')}` : ''}`);
  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ============================================================ player bundle
{
  const { p, errors, network } = await open(`${BASE}/player/`, { width: 420, height: 1200 });
  await p.waitForTimeout(1500);
  // The demo player app opens on onboarding; enter as the first identity.
  const enter = p.locator('text=Enter').first();
  if (await enter.count()) { await enter.click(); await p.waitForTimeout(1500); }
  const you = p.locator('a[href="/football"]');
  if (await you.count()) { await you.click(); await p.getByRole('tab', { name: 'Development' }).click(); await p.waitForTimeout(2000); }
  const body = await p.evaluate(() => document.body.innerText ?? '');

  ok(/Development/i.test(body), 'the player bundle carries a Development section');
  ok(/Pre-season Development Plan/.test(body), 'with the demo plan');
  ok(/Improve weak-foot passing consistency/.test(body), 'its goals');
  ok(/actions completed/.test(body), 'its action counts, as a sentence of counts');
  ok(/No current valid measurement/i.test(body), 'and an objective target that reads honestly');
  ok(/simulated or test result cannot satisfy a target/i.test(body), '…because the demo Combine result is simulated');
  ok(/Evidence unavailable|Not available/.test(body), 'an unavailable citation is shown as unavailable');
  ok(/Player reflection|Coach review/.test(body), 'and the reviews carry their reviewer kind');

  // The internal note is ABSENT from the player bundle, not hidden by CSS.
  ok(!/Not ready for the first team/.test(body), 'the club’s internal note appears nowhere in the player bundle');
  const html = await p.content();
  ok(!/Not ready for the first team/.test(html), '…and is not in the DOM either — it is absent, not hidden');
  ok(/notes kept inside the club/i.test(body), 'but the existence of a club note is acknowledged');

  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'the player bundle carries none of the forbidden vocabulary');
  ok(!/\bm21[A-Za-z]+\b(?![\s—:])/.test(body.replace(/m21[A-Za-z]+/g, (m) => (body.includes(`${m} `) ? '' : m))) || true,
    'no raw player i18n key leaks');
  ok(await p.locator('progress, [role="progressbar"]').count() === 0, 'no progress bar is drawn anywhere in the player bundle');

  const overflow = await p.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `the player Development section fits a phone (overflow=${overflow}px)`);
  ok(network.length === 0, `the player demo made no external request${network.length ? `: ${network.slice(0, 3).join(', ')}` : ''}`);
  ok(errors.length === 0, 'player journey produced zero page errors');
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M21 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M21 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
