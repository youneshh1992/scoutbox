// M20 demo spotcheck — the Director Dashboard as it appears in the SHIPPED
// single-file bundles.
//
// The demo bundles are the artifact HTML: no server, no network. What this
// asserts is that the M20 surface is really in them and really behaves:
//   • both org bundles boot clean and reach the dashboard
//   • all seven families render, and every panel carries its limitation
//   • a withheld rate, a zero and "nothing happened" read as three different
//     things — the demo's dataset is small on purpose so the first is visible
//   • the funnel says it is not a one-way funnel; the association figure
//     carries its association sentence; watchlist churn admits what it counts
//   • there is no filter by person, and the demo says so
//   • no forbidden vocabulary and no raw m20.* i18n key, in either language
//   • the demo makes NO real network request — a demo that quietly calls
//     localhost:4000 is not a demo
//   • the player bundle knows nothing about any of it
//   • 390px
//
// Requires `node serve.mjs` on :8099 with freshly built demo bundles.
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8099';
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: EXE });
const allErrors = [];
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const FORBIDDEN = [
  /Recruitment Score/i, /Scout Score/i, /Player Success Score/i, /Efficiency Score/i,
  /Talent Conversion/i, /Club Intelligence/i, /Leaderboard/i, /Top Scout/i, /\bBest Scout\b/i,
  /Scout Ranking/i, /Player Ranking/i,
];
/** Strip the passage that exists precisely to deny those terms. */
const denials = (t) => t
  .replace(/What this page will never show[\s\S]{0,1200}?(?=\n\n|$)/gi, '')
  .replace(/Ce que cette page n’affichera jamais[\s\S]{0,1200}?(?=\n\n|$)/gi, '')
  .replace(/never .{0,90}score[^.]*\./gi, '');

async function open(url, viewport = { width: 1440, height: 900 }) {
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
const goHash = async (p, hash, wait = 1400) => {
  await p.evaluate((h) => { window.location.hash = h; }, hash);
  await p.waitForTimeout(wait);
};

const DASH = '#/recruitment/dashboard';

for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors, network } = await open(`${BASE}/${path}`);
  await login(p);

  // ---- the destination exists in the bundle
  await goHash(p, DASH);
  let body = (await p.locator('body').innerText()) ?? '';
  ok(/Director Dashboard/.test(body), `${name} the Director Dashboard destination exists in the bundle`);
  ok(/do not measure any player/i.test(body) && /colleague/i.test(body),
    `${name} the governing sentence is on the page`);

  const families = await p.locator('[data-family]').count();
  ok(families === 7, `${name} all seven metric families render (${families})`);

  // ---- every panel carries its caveat
  const panels = await p.locator('[data-metric]').count();
  const limitations = await p.locator('[data-metric] [data-limitation]').count();
  ok(panels >= 20 && limitations >= panels,
    `${name} every one of the ${panels} panels prints its limitation (${limitations})`);
  ok(await p.locator('details [data-limitation]').count() === 0,
    `${name} no limitation is hidden behind a disclosure`);

  // ---- the three absences stay three
  ok(/too few to express as a rate/i.test(body), `${name} a rate over too few records is withheld, in those words`);
  ok(/Nothing in this period/i.test(body) || /Too few to give a typical figure/i.test(body),
    `${name} an empty figure has its own wording`);
  ok(!/0% of 0/.test(body), `${name} nothing renders as a percentage of nothing`);

  // ---- the honesty markers the payload carries
  ok(await p.locator('[data-not-a-funnel]').count() === 1, `${name} the funnel says it is not a one-way funnel`);
  ok(/Reopened after ending/i.test(body), `${name} …and reports reopenings`);
  const assoc = await p.locator('[data-association]').innerText().catch(() => '');
  ok(/does not show that the property caused it/i.test(assoc),
    `${name} the association-only figure refuses the causal reading, in the payload's own words`);
  const churn = await p.locator('[data-derived-on-read]').innerText().catch(() => '');
  ok(/does not recompute watchlists in the background/i.test(churn),
    `${name} watchlist churn admits it counts recalculations, not changes in a player`);

  // ---- period-over-period, freshness, and the zero rule
  ok(await p.locator('[data-trend-strip]').count() === 1, `${name} the period-over-period strip is in the bundle`);
  const trendWords = (await p.locator('[data-trend-words]').allInnerTexts()).join(' | ');
  ok(!/Infinity|NaN|undefined/.test(trendWords), `${name} no comparison renders Infinity, NaN or undefined (${trendWords})`);
  ok(/from none last period/i.test(trendWords) || /no change/i.test(trendWords) || /%/.test(trendWords),
    `${name} every comparison says something a reader can act on`);
  ok(await p.locator('[data-calculated-at]').count() === 1,
    `${name} the page says when it was calculated rather than implying a live feed`);
  const bucketIds = await p.locator('[data-bucket]').evaluateAll((els) => els.map((e) => e.getAttribute('data-bucket')));
  ok(bucketIds.includes('0_7') && bucketIds.includes('60_plus'),
    `${name} open rooms are bucketed by age, with an open-ended last bucket`);

  // ---- there is no person here, and the screen says so
  ok(await p.locator('[data-no-person-filter]').count() === 1, `${name} the screen states there is no filter by colleague`);
  const filterSelects = await p.locator('section:has([data-no-person-filter]) select').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok(filterSelects.length >= 3 && !filterSelects.some((s) => /scout|colleague|user|owner|person/i.test(s ?? '')),
    `${name} the filter row offers ${filterSelects.length} controls and not one names a person`);

  // ---- the sources of the association figure stay alphabetical
  const sources = await p.locator('[data-metric="source_stage_reach"] table.data tbody tr td:first-child').allInnerTexts();
  const sorted = sources.slice().sort((a, b) => a.localeCompare(b));
  ok(JSON.stringify(sources) === JSON.stringify(sorted), `${name} sources are alphabetical, never ranked`);

  // ---- the demo refuses what the server refuses
  await goHash(p, `${DASH}?window=forever`);
  const refused = (await p.locator('body').innerText()) ?? '';
  ok(/Unknown window/i.test(refused) || await p.locator('[data-refusal]').count() > 0,
    `${name} the demo refuses an unknown period the way the server does`);
  await goHash(p, DASH);

  // ---- a filter that changes the view reaches the URL
  const periods = await p.locator('select[aria-label="Period"] option').evaluateAll((els) => els.map((e) => e.getAttribute('value')));
  ok(periods.includes('last_7_days'), `${name} a seven-day period is offered (${periods.join(', ')})`);
  await p.selectOption('select[aria-label="Period"]', 'last_30_days').catch(() => {});
  await p.waitForTimeout(900);
  const hash = await p.evaluate(() => location.hash);
  ok(/window=last_30_days/.test(hash), `${name} the chosen period reaches the URL (${hash})`);

  // ---- vocabulary and i18n hygiene
  await goHash(p, DASH);
  body = (await p.locator('body').innerText()) ?? '';
  const hit = FORBIDDEN.find((re) => re.test(denials(body)));
  ok(!hit, `${name} shows no forbidden vocabulary${hit ? ` (${hit})` : ''}`);
  ok(!/\bm20\.[a-zA-Z._]+\b/.test(body), `${name} leaks no raw m20 i18n key`);
  ok(!/\[object Object\]/.test(body), `${name} has no rendering artefact`);
  ok(!/\{n\}|\{min\}|\{pct\}|\{total\}|\{days\}/.test(body), `${name} every copy placeholder was substituted`);

  // ---- French
  await p.selectOption('select[aria-label="Language"]', 'fr').catch(() => {});
  await p.waitForTimeout(1000);
  const fr = (await p.locator('body').innerText()) ?? '';
  ok(/Tableau de bord du directeur/.test(fr), `${name} the dashboard is translated`);
  ok(!/\bm20\.[a-zA-Z._]+\b/.test(fr), `${name} no raw m20 key leaks in French`);
  const frHit = FORBIDDEN.find((re) => re.test(denials(fr)));
  ok(!frHit, `${name} no forbidden vocabulary in French${frHit ? ` (${frHit})` : ''}`);
  ok(/pas de filtre par collègue/i.test(fr), `${name} the no-person promise is translated, not dropped`);
  await p.selectOption('select[aria-label="Langue"]', 'en').catch(() => p.selectOption('select[aria-label="Language"]', 'en').catch(() => {}));
  await p.waitForTimeout(700);

  // ---- 390px
  await p.setViewportSize({ width: 390, height: 844 });
  await goHash(p, DASH, 1000);
  const overflow = await p.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `${name} the dashboard fits 390px (overflow=${overflow}px)`);
  await p.setViewportSize({ width: 1440, height: 900 });

  ok(network.length === 0, `${name} the demo made no external request${network.length ? `: ${network.slice(0, 3).join(', ')}` : ''}`);
  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- the player bundle knows nothing about M20
{
  const { p, errors } = await open(`${BASE}/player/`, { width: 420, height: 900 });
  await p.waitForTimeout(1800);
  const body = await p.evaluate(() => document.body.innerText ?? '');
  ok(!/director dashboard|recruitment analytics|stalled room|pipeline shape/i.test(body),
    'the player app never mentions a dashboard, analytics or a club’s pipeline');
  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'the player app carries none of the forbidden vocabulary');
  ok(errors.length === 0, 'player journey produced zero page errors');
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M20 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M20 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
