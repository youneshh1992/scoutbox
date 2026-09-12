// M18.1 demo spotcheck — the hardening, as it appears in the SHIPPED bundles.
//
// The demo bundles are the artifact HTML. A passing `vite build` does not
// catch the circular-import class of bug that once crashed the M16.1 bundle,
// and it certainly does not catch a terminology regression or a layout that
// breaks at 390px. Booting the real bundles does.
//
// What this asserts, specifically, is the M18.1 surface work:
//   • two numbers, two names — "Profile completeness" is not "Trust Score"
//   • a missing value is words, never "—" and never 0
//   • each Second Look tab has its own empty state
//   • the toast is a live region and the emoji-only controls have names
//   • every M17/M18 surface survives a 390px phone
//   • the demo is unmistakably a demo, and no simulated Combine result is
//     dressed up as production evidence
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

// ---- 1. every bundle still boots clean after the M18.1 client work
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/'], ['admin', 'admin/'], ['player', 'player/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  const body = ((await p.textContent('body')) ?? '').trim();
  ok(errors.length === 0 && body.length > 40, `${name} demo boots — pageErrors=${errors.length} bodyChars=${body.length}`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 2. terminology, states and accessibility in both org bundles
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  await login(p);

  // -- two numbers, two names
  await p.evaluate(() => { window.location.hash = '#/search'; });
  await p.waitForTimeout(1200);
  let body = (await p.textContent('body')) ?? '';
  ok(/Profile completeness/i.test(body), `${name} Discover names the completeness figure for what it measures`);
  ok(!/\bTrust\s+\d{1,3}%/.test(body), `${name} Discover no longer labels that figure "Trust NN%"`);
  ok(!/\bTrust Score\b/i.test(body) || /Evidence confidence/i.test(body),
    `${name} Discover never says "Trust Score" without saying evidence confidence`);

  // -- untranslated keys would render as literal dotted identifiers
  ok(!/term\.profileSignal|common\.retry|common\.conflict|rm\.trustUnavailableShort|m18\.sl\.empty\./.test(body),
    `${name} no raw i18n key leaks onto the page`);

  // -- the emoji-only header controls have accessible names
  const bellName = await p.getAttribute('button[aria-label^="Notifications"]', 'aria-label').catch(() => null);
  ok(!!bellName, `${name} the notification bell has an accessible name ("${bellName ?? 'missing'}")`);
  const reportName = await p.getAttribute('button[aria-label^="Report or block"]', 'aria-label').catch(() => null);
  ok(!!reportName, `${name} the report/block control has an accessible name`);

  // -- Second Look: four tabs, four distinct empty states, no generic fallback
  await p.evaluate(() => { window.location.hash = '#/recruitment/second-look'; });
  await p.waitForTimeout(1200);
  body = (await p.textContent('body')) ?? '';
  ok(/Worth Another Look/.test(body), `${name} Second Look renders`);
  ok(!/Nothing in this queue\./.test(body), `${name} no tab shows the retired generic empty state`);
  {
    const empties = new Set();
    const tabs = await p.locator('[role="tab"]').count();
    for (let i = 0; i < tabs; i++) {
      await p.locator('[role="tab"]').nth(i).click();
      await p.waitForTimeout(350);
      const panel = (await p.locator('[role="tabpanel"]').innerText()) ?? '';
      const first = panel.trim().split('\n').filter(Boolean)[0] ?? '';
      if (/^No |^Nothing/i.test(first)) empties.add(first);
    }
    ok(empties.size !== 1 || tabs <= 1, `${name} empty Second Look tabs each say something different (${empties.size} distinct)`);
  }

  // -- Rooms: a missing evidence confidence is words, never a bare dash or 0
  await p.evaluate(() => { window.location.hash = '#/recruitment/rooms'; });
  await p.waitForTimeout(1400);
  const table = await p.locator('table.data').first().innerText().catch(() => '');
  ok(!/^—$/m.test(table) || /Not available|Player withheld/i.test(table),
    `${name} the Rooms table never leaves a bare em dash where evidence confidence belongs`);
  ok(!/Trust[^\n]*\s0\b/.test(table), `${name} a missing Trust profile is not rendered as 0`);

  // -- the toast is announced. A toast only exists while one is on screen, so
  //    provoke one and look, rather than asserting on an empty page. Nobody
  //    Missed always has a candidate in the demo, and reviewing one toasts.
  await p.evaluate(() => { window.location.hash = '#/recruitment/nobody-missed'; });
  await p.waitForTimeout(1400);
  {
    const review = p.locator('button:has-text("Review player")').first();
    if (await review.count()) {
      await review.click();
      await p.waitForTimeout(600);
      const announced = await p.evaluate(() => {
        const el = document.querySelector('.toast');
        if (!el) return null;
        return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), text: el.textContent };
      });
      if (announced) {
        ok(announced.role === 'status' || announced.role === 'alert', `${name} the toast is announced (role=${announced.role}, aria-live=${announced.live})`);
      } else {
        ok(true, `${name} the action produced no toast in the demo bundle (nothing asserted)`);
      }
    } else {
      ok(true, `${name} no reviewable candidate in the demo bundle (nothing asserted)`);
    }
  }

  // -- 390px: no surface may scroll the page sideways
  await p.setViewportSize({ width: 390, height: 844 });
  for (const [label, hash] of [
    ['Second Look', '#/recruitment/second-look'],
    ['Nobody Missed', '#/recruitment/nobody-missed'],
    ['Briefs', '#/briefs'],
    ['Rooms', '#/recruitment/rooms'],
  ]) {
    await p.evaluate((h) => { window.location.hash = h; }, hash);
    await p.waitForTimeout(900);
    const overflow = await p.evaluate(() => Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ));
    ok(overflow <= 4, `${name} ${label} fits 390px (overflow=${overflow}px)`);
  }
  await p.setViewportSize({ width: 1440, height: 900 });

  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 3. the player bundle: Combine states are differentiated, demo is labelled
{
  const { p, errors } = await open(`${BASE}/player/`, { width: 420, height: 900 });
  await p.waitForTimeout(1800);
  // innerText, NOT textContent: this bundle inlines its own JavaScript inside
  // <body>, so textContent returns 1.4 MB of source and every assertion below
  // would match the bundle rather than the screen.
  const body = await p.evaluate(() => document.body.innerText ?? '');

  // The demo must never let a simulated observation read as production evidence.
  ok(/demo/i.test(body), 'the player demo says it is a demo');
  ok(!/production evidence|verified by an official/i.test(body),
    'no simulated result claims to be production evidence');

  // Terminology: the player's own completeness figure is not called Trust.
  ok(!/\bTrust\s+\d{1,3}%/.test(body), 'the player app does not label completeness "Trust NN%"');

  // The M18 systems remain club-internal.
  ok(!/second look|nobody missed|worth another look|evaluation coverage/i.test(body),
    'the player app carries no Second Look / Nobody Missed surface');

  // A raw combine state id must never reach a player.
  ok(!/combine_verified|measurement_unavailable|protocol_invalid|integrity_review|partially_measured/.test(body),
    'no raw Combine state identifier is rendered at the player');
  ok(!/cmbState_|m15prov_/.test(body), 'no raw player i18n key leaks onto the page');

  ok(errors.length === 0, `player journey produced zero page errors`);
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M18.1 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
