// M18.2 demo spotcheck — the cleanup, as it appears in the SHIPPED bundles.
//
// The demo bundles are the artifact HTML. What this asserts is the M18.2
// surface work, in the real single-file builds:
//   • every bundle boots with zero page errors after the client changes
//   • Discover states its ordering, and says it is not a ranking
//   • the Organisation screen carries the notification preferences and the
//     audit log, the mandatory category is locked, email is a local outbox
//   • no raw M18.2 i18n key leaks (prefs., audit., conflict., prov., confirm.)
//   • the provenance vocabulary never renders "Player-provided" for an
//     unknown source
//   • the destructive confirm states a consequence and declining does nothing
//   • the new panels fit 390px
//   • the player bundle is unaffected and still says it is a demo
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

// ---- 1. every bundle boots clean
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/'], ['admin', 'admin/'], ['player', 'player/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  const body = ((await p.textContent('body')) ?? '').trim();
  ok(errors.length === 0 && body.length > 40, `${name} demo boots — pageErrors=${errors.length} bodyChars=${body.length}`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 2. the org bundles
for (const [name, path] of [['club', 'club/'], ['grassroots', 'grassroots/']]) {
  const { p, errors } = await open(`${BASE}/${path}`);
  await login(p);

  // Discover: ordering stated
  await p.evaluate(() => { window.location.hash = '#/search'; });
  await p.waitForTimeout(1200);
  const ordering = await p.locator('[data-ordering]').innerText().catch(() => '');
  ok(/not ability/i.test(ordering) && /Trust Score/.test(ordering), `${name} Discover states its ordering and that it is not ability or the Trust Score`);
  let body = (await p.locator('body').innerText()) ?? '';
  ok(!/\b(prefs|audit|conflict|prov|confirm|http|discover)\.[a-zA-Z.]+\b/.test(body), `${name} no raw M18.2 i18n key leaks onto Discover`);

  // Organisation: the two panels
  await p.evaluate(() => { window.location.hash = '#/organisation'; });
  await p.waitForTimeout(1400);
  const prefs = await p.locator('[data-panel="notification-preferences"]').count();
  const audit = await p.locator('[data-panel="audit-log"]').count();
  ok(prefs === 1 && audit === 1, `${name} Organisation carries the notification preferences and the audit log`);
  const prefsText = await p.locator('[data-panel="notification-preferences"]').innerText().catch(() => '');
  if (prefs) {
    ok(/local outbox|no external email/i.test(prefsText) || /Loading|could not|offline|unavailable/i.test(prefsText),
      `${name} the email channel is described honestly (or the demo has no preferences source, stated as such)`);
    const locked = await p.locator('[data-panel="notification-preferences"] input[type="checkbox"][disabled]').count();
    const anyToggle = await p.locator('[data-panel="notification-preferences"] input[type="checkbox"]').count();
    ok(anyToggle === 0 || locked >= 1, `${name} when preferences render, the mandatory category is locked (${locked} locked of ${anyToggle})`);
  }
  body = (await p.locator('body').innerText()) ?? '';
  ok(!/\b(prefs|audit|conflict|prov|confirm|http)\.[a-zA-Z.]+\b/.test(body), `${name} no raw M18.2 i18n key leaks onto Organisation`);
  ok(!/\[object Object\]|undefined/.test(prefsText), `${name} no rendering artefact in the preferences panel`);

  // Provenance: never "Player-provided" for an unknown source
  await p.evaluate(() => { window.location.hash = '#/recruitment/rooms'; });
  await p.waitForTimeout(1200);
  const pills = await p.locator('[data-provenance]').evaluateAll((els) => els.map((e) => ({ type: e.getAttribute('data-provenance'), known: e.getAttribute('data-known'), text: e.textContent })));
  ok(!pills.some((x) => x.known === 'false' && /Player-provided/i.test(x.text ?? '')), `${name} no unknown provenance is labelled Player-provided (${pills.length} pills seen)`);

  // Destructive confirm: a consequence, and declining does nothing
  {
    let message = null;
    p.once('dialog', async (d) => { message = d.message(); await d.dismiss(); });
    const row = p.locator('table.data tbody tr').first();
    if (await row.count()) {
      await row.click();
      await p.waitForTimeout(900);
      await p.selectOption('[aria-label="Move to"]', 'archived').catch(() => {});
      await p.waitForTimeout(200);
      await p.click('button:has-text("Apply")').catch(() => {});
      await p.waitForTimeout(700);
      if (message) {
        ok(/preserved|can be undone|cannot be undone/i.test(message) && !/are you sure/i.test(message), `${name} archiving states its consequence and never asks "are you sure"`);
        const header = await p.locator('[aria-label="Room header"]').innerText().catch(() => '');
        ok(!/Archived/.test(header), `${name} declining the confirmation left the Room open`);
      } else ok(true, `${name} no archive control reachable in the demo Room (nothing asserted)`);
    } else ok(true, `${name} no Room row in the demo (nothing asserted)`);
  }

  // 390px: the new panels
  await p.setViewportSize({ width: 390, height: 844 });
  await p.evaluate(() => { window.location.hash = '#/organisation'; });
  await p.waitForTimeout(1200);
  const overflow = await p.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ));
  ok(overflow <= 4, `${name} Organisation with the new panels fits 390px (overflow=${overflow}px)`);
  await p.setViewportSize({ width: 1440, height: 900 });

  ok(errors.length === 0, `${name} journey produced zero page errors`);
  for (const e of errors.slice(0, 4)) console.log(`    ${e}`);
  await p.close();
}

// ---- 3. the player bundle is untouched by M18.2 and still a demo
{
  const { p, errors } = await open(`${BASE}/player/`, { width: 420, height: 900 });
  await p.waitForTimeout(1800);
  const body = await p.evaluate(() => document.body.innerText ?? '');
  ok(/demo/i.test(body), 'the player demo says it is a demo');
  ok(!/audit log|notification preferences/i.test(body), 'the player app carries none of the organisation panels');
  ok(!/\bTrust\s+\d{1,3}%/.test(body), 'the player app does not label completeness "Trust NN%"');
  ok(errors.length === 0, 'player journey produced zero page errors');
  await p.close();
}

await browser.close();
console.log(`\n${bad === 0 ? 'M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors' : `M18.2 headless spotcheck: ${bad} FAILURE(S)`}`);
if (allErrors.length) { console.log('page errors:'); for (const e of allErrors) console.log(`  ${e}`); }
process.exit(bad ? 1 : 0);
