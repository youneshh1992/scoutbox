// M18 demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through Second Look, Nobody Missed and Recruitment Briefs.
//
// A passing `vite build` does NOT catch the circular-import class of bug that
// crashed the M16.1 bundle — only actually booting the bundle does, so this
// suite loads all four bundles and fails on any page error.
//
// The boundaries it asserts hardest: neither system exists in the player app;
// Second Look never judges a decision and prints club-side reasons as still
// standing; Nobody Missed is Evaluation Coverage, never a quality score; and a
// previous value that was never recorded reads "Previous detail unavailable",
// never a fabricated number.
//
// Requires `node serve.mjs` on :8099.
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8099';
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: EXE });
const allErrors = [];
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

async function open(url, viewport = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport });
  const errors = [];
  p.on('pageerror', (e) => { errors.push(`${url}: ${e.message}`); allErrors.push(`${url}: ${e.message}`); });
  p.on('console', (m) => {
    // The demo host serves no favicon; that 404 is the host, not the bundle.
    if (m.type() === 'error' && !m.location()?.url?.endsWith('/favicon.ico')) {
      errors.push(`${url}: console ${m.text()}`);
      allErrors.push(`${url}: console ${m.text()}`);
    }
  });
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  return { p, errors };
}

async function login(p) {
  await p.click('.org-card');
  await p.fill('input[placeholder^="Your name"]', 'A. Coach');
  await p.click('button.primary');
  await p.waitForTimeout(900);
}

// ---- 1. every bundle boots with zero page errors
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/'], ['admin', 'admin/'], ['player', 'player/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  const body = ((await p.textContent('body')) ?? '').trim();
  ok(errors.length === 0 && body.length > 40, `${name} demo boots — pageErrors=${errors.length} bodyChars=${body.length}`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 2. the three M18 deep links land on the right screen in both org apps
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  await login(p);

  for (const [hash, expect] of [
    ['#/recruitment/second-look', /Second Look/i],
    ['#/recruitment/nobody-missed', /Nobody Missed/i],
    ['#/briefs', /Recruitment Briefs/i],
  ]) {
    await p.evaluate((h) => { window.location.hash = h; }, hash);
    await p.waitForTimeout(900);
    const body = (await p.textContent('body')) ?? '';
    ok(expect.test(body), `${name} deep link ${hash} renders`);
  }

  // Second Look tabs + the honesty copy that must always travel with them.
  await p.evaluate(() => { window.location.hash = '#/recruitment/second-look'; });
  await p.waitForTimeout(900);
  let body = (await p.textContent('body')) ?? '';
  ok(/Worth Another Look/.test(body), `${name} Second Look: "Worth Another Look" tab`);
  ok(/Evidence Changed/.test(body), `${name} Second Look: "Evidence Changed" tab`);
  ok(/does not judge that decision/i.test(body), `${name} Second Look carries its disclaimer`);
  ok(/Reasons that still stand/.test(body) && /Squad space/i.test(body),
    `${name} Second Look prints the club-side reason as still standing`);
  ok(/New since your review/i.test(body), `${name} Second Look shows the change list`);
  ok(/Evidence confidence — not football ability/.test(body), `${name} Trust Score carries its note`);
  ok(!/scout quality|recruitment quality|scouting score|fairness score|talent score|match score/i.test(body),
    `${name} Second Look uses none of the forbidden score names`);
  ok((await p.getAttribute('[role="tab"][aria-selected="true"]', 'role')) === 'tab',
    `${name} Second Look tabs expose role=tab/aria-selected`);

  // Review Changes: changed rows only, and an honest "unavailable" row.
  await p.click('button:has-text("Review changes")');
  await p.waitForTimeout(900);
  body = (await p.textContent('body')) ?? '';
  ok(/At your previous review vs now/i.test(body), `${name} Review Changes opens`);
  ok(/Previous detail unavailable/.test(body), `${name} Review Changes says "Previous detail unavailable" honestly`);
  ok(/Combine Verified protocols/.test(body) === false, `${name} Review Changes hides unchanged rows`);

  // Nobody Missed: coverage arithmetic and the "Why shown" block.
  await p.evaluate(() => { window.location.hash = '#/recruitment/nobody-missed'; });
  await p.waitForTimeout(1200);
  body = (await p.textContent('body')) ?? '';
  ok(/Evaluation Coverage/.test(body), `${name} Nobody Missed shows Evaluation Coverage`);
  const stats = await p.$$eval('[aria-label="Evaluation Coverage"] .stat .v', (els) => els.map((e) => e.textContent.trim()));
  ok(stats.join('/') === '8/5/3/63%', `${name} coverage arithmetic renders 8 / 5 / 3 / 63% (got ${stats.join(' / ')})`);
  ok(/Why shown/.test(body), `${name} candidate carries a "Why shown" block`);
  ok(/Idris Bello/.test(body) && /Marek Sobota/.test(body) && /Owen Pritchard/.test(body),
    `${name} the three candidates are the three unevaluated players`);
  ok(!/scout quality|recruitment quality|scouting score|fairness score|talent score|match score/i.test(body),
    `${name} Nobody Missed uses none of the forbidden score names`);

  // Briefs: version + criteriaExplained, and a working parameterised deep link.
  await p.evaluate(() => { window.location.hash = '#/briefs'; });
  await p.waitForTimeout(900);
  await p.click('[aria-label="Recruitment briefs"] button:has-text("Open")');
  await p.waitForTimeout(900);
  const hash = await p.evaluate(() => window.location.hash);
  ok(/^#\/recruitment\/briefs\/[A-Za-z0-9_-]+$/.test(hash), `${name} opening a brief pushes ${hash}`);
  body = (await p.textContent('body')) ?? '';
  ok(/Version/.test(body) && /Criteria/.test(body), `${name} brief detail shows version and explained criteria`);
  await p.goBack();
  await p.waitForTimeout(700);
  ok((await p.evaluate(() => window.location.hash)) === '#/briefs', `${name} browser Back closes the brief`);

  // Refresh straight into a deep link.
  await p.goto(`${BASE}/${path}#/recruitment/nobody-missed`, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  ok(/Nobody Missed/.test((await p.textContent('body')) ?? ''), `${name} refresh into a deep link works`);

  // 400px: no horizontal page scroll.
  await p.setViewportSize({ width: 400, height: 800 });
  await p.evaluate(() => { window.location.hash = '#/recruitment/second-look'; });
  await p.waitForTimeout(900);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `${name} no horizontal page scroll at 400px (overflow=${overflow}px)`);

  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 3. the product boundary: nothing player-facing
{
  const { p } = await open(`${BASE}/player/`);
  await p.waitForTimeout(1500);
  const body = ((await p.textContent('body')) ?? '');
  ok(!/second look|nobody missed|you were missed|reconsider/i.test(body),
    'player app carries no Second Look / Nobody Missed surface');
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M18 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M18 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
