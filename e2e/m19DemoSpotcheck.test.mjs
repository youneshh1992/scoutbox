// M19 demo spotcheck — Explainable Matching and Dynamic Watchlists, as they
// appear in the SHIPPED single-file bundles.
//
// The demo bundles are the artifact HTML: no server, no network. What this
// asserts is that the M19 surface is really in them and really behaves:
//   • both org bundles boot clean and reach both M19 destinations
//   • the demo story — "2027 Defensive Midfielders" — is there, with
//     membership, a change summary, an explanation per player and a history
//   • the criteria editor offers the typed vocabulary and no protected trait
//   • a criteria refusal in the demo reads like the server's refusal
//   • no forbidden vocabulary, and no raw m19.* i18n key, anywhere
//   • the demo makes NO real network request — a demo that quietly calls
//     localhost:4000 is not a demo
//   • the player bundle knows nothing about any of it
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

const FORBIDDEN = [/AI Match Score/i, /Talent Score/i, /Potential Score/i, /Recruitability/i, /ScoutBox Rating/i, /\bBest Match\b/i, /Recommended Player/i];
/** Strip the sentences that exist precisely to deny those terms. */
const denials = (t) => t
  .replace(/no match score[^.]*\./gi, '')
  .replace(/does not rank or score[^.]*\./gi, '')
  .replace(/never scored[^.]*\.?/gi, '')
  .replace(/not a score[^.]*\.?/gi, '');

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
const goHash = async (p, hash, wait = 1300) => {
  await p.evaluate((h) => { window.location.hash = h; }, hash);
  await p.waitForTimeout(wait);
};

for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors, network } = await open(`${BASE}/${path}`);
  await login(p);

  // ---- the Dynamic Watchlists destination and the demo story
  await goHash(p, '#/recruitment/watchlists');
  let body = (await p.locator('body').innerText()) ?? '';
  ok(/Dynamic Watchlists/.test(body), `${name} the Dynamic Watchlists destination exists in the bundle`);
  ok(/2027 Defensive Midfielders/.test(body), `${name} the demo story watchlist is pre-seeded`);
  ok(/derived when you open a watchlist|derived when this page is read/i.test(body),
    `${name} the list says membership is derived on read`);

  const openBtn = p.locator('table.data tbody tr', { hasText: '2027 Defensive Midfielders' }).locator('button:has-text("Open")');
  ok(await openBtn.count() === 1, `${name} the demo watchlist can be opened`);
  await openBtn.click();
  await p.waitForTimeout(1200);
  body = (await p.locator('body').innerText()) ?? '';
  ok(/Why this player matches/.test(body), `${name} the watchlist explains every member`);
  ok(/preferred criteria met/.test(body), `${name} preferred criteria are shown as a count`);
  ok(/It is not a score/.test(body), `${name} the count says what it is not`);
  ok(/currently match/.test(body) && /newly matched/.test(body) && /no longer match/.test(body),
    `${name} the change summary is present`);
  ok(/not an improvement in a player/i.test(body), `${name} the summary says entering a list is not an improvement`);
  ok(/Membership history/i.test(body), `${name} the membership history is present`);
  ok(/does not recompute watchlists in the background/i.test(body),
    `${name} the demo does not imply a scheduler this build does not have`);
  const cards = await p.locator('[data-match-card]').count();
  ok(cards > 0, `${name} the demo watchlist has members (${cards})`);

  // ---- the matching workspace and its editor
  await goHash(p, '#/recruitment/matching');
  body = (await p.locator('body').innerText()) ?? '';
  ok(/Player Matching/.test(body), `${name} the Player Matching destination exists in the bundle`);
  ok(/Required criteria/.test(body) && /Preferred criteria/.test(body), `${name} both criteria classes are offered`);
  await p.locator('[data-criteria-class="required"] button:has-text("Add required criterion")').click();
  await p.waitForTimeout(400);
  const types = await p.locator('select[aria-label="Fact"]').first().locator('option').evaluateAll((els) => els.map((e) => e.value));
  ok(types.length >= 9, `${name} the criterion vocabulary is offered (${types.length} types)`);
  ok(!types.some((t) => /ethnic|race|religion|disab|income|school|orientation/i.test(t)),
    `${name} no protected characteristic is offered as a criterion`);

  // A criterion with no value is refused, in the demo, the way the server does.
  await p.click('button:has-text("Show matching players")');
  await p.waitForTimeout(900);
  body = (await p.locator('body').innerText()) ?? '';
  ok(/cannot be saved as written/i.test(body) || /needs a value/i.test(body),
    `${name} the demo refuses an incomplete criterion instead of matching everyone`);

  // …and a complete one matches, with an explanation.
  await p.locator('[data-criteria-class="required"] input[type=checkbox]').nth(6).check(); // CDM
  await p.click('button:has-text("Show matching players")');
  await p.waitForTimeout(900);
  const total = await p.locator('[data-match-total]').count();
  ok(total === 1, `${name} the demo runs the match and reports a total`);
  body = (await p.locator('body').innerText()) ?? '';
  ok(/Why this player matches/.test(body), `${name} the demo match explains itself`);
  ok(/Matches position criteria/.test(body), `${name} the explanation names the criterion`);

  // ---- vocabulary and i18n hygiene across both screens
  for (const hash of ['#/recruitment/matching', '#/recruitment/watchlists']) {
    await goHash(p, hash);
    const text = (await p.locator('body').innerText()) ?? '';
    const stripped = denials(text);
    const hit = FORBIDDEN.find((re) => re.test(stripped));
    ok(!hit, `${name} ${hash} shows no forbidden vocabulary${hit ? ` (${hit})` : ''}`);
    ok(!/\bm19\.[a-zA-Z._]+\b/.test(text), `${name} ${hash} leaks no raw m19 i18n key`);
    ok(!/\[object Object\]/.test(text), `${name} ${hash} has no rendering artefact`);
  }

  // ---- French
  await goHash(p, '#/recruitment/watchlists');
  await p.selectOption('select[aria-label="Language"]', 'fr').catch(() => {});
  await p.waitForTimeout(900);
  const fr = (await p.locator('body').innerText()) ?? '';
  ok(/Listes dynamiques/.test(fr), `${name} the watchlists screen is translated`);
  ok(!/\bm19\.[a-zA-Z._]+\b/.test(fr), `${name} no raw m19 key leaks in French`);
  await p.selectOption('select[aria-label="Langue"]', 'en').catch(() => p.selectOption('select[aria-label="Language"]', 'en').catch(() => {}));
  await p.waitForTimeout(600);

  // ---- 390px
  await p.setViewportSize({ width: 390, height: 844 });
  for (const hash of ['#/recruitment/matching', '#/recruitment/watchlists']) {
    await goHash(p, hash, 900);
    const overflow = await p.evaluate(() => Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ));
    ok(overflow <= 4, `${name} ${hash} fits 390px (overflow=${overflow}px)`);
  }
  await p.setViewportSize({ width: 1440, height: 900 });

  ok(network.length === 0, `${name} the demo made no external request${network.length ? `: ${network.slice(0, 3).join(', ')}` : ''}`);
  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- the player bundle knows nothing about M19
{
  const { p, errors } = await open(`${BASE}/player/`, { width: 420, height: 900 });
  await p.waitForTimeout(1800);
  const body = await p.evaluate(() => document.body.innerText ?? '');
  ok(!/watchlist|dynamic list|player matching|criteria your/i.test(body),
    'the player app never mentions a watchlist, matching or a club’s criteria');
  ok(!FORBIDDEN.some((re) => re.test(denials(body))), 'the player app carries none of the forbidden vocabulary');
  ok(errors.length === 0, 'player journey produced zero page errors');
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M19 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M19 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
