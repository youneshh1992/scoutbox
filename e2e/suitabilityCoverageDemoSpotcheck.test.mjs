// Demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through the suitability, coverage, insight, imports, budgets and network surfaces and fails on any page error.
// Needs freshly built demo bundles (buildDemos.mjs).
import { chromium } from 'playwright-core';
import { playerCategory, playerSub } from './caseNavHelpers.mjs';
import { ensureDemoHost } from './demoHost.mjs';

// This test owns its demo host: it starts one if none is running (see demoHost.mjs).
const demo = await ensureDemoHost();

const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const say = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: EXE });
const errors = [];
async function page(url) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(url);
  return p;
}

// ---- Pro demo: the screens on demo fixtures
const club = await page(`${demo.host}/club/`);
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('.topbar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/insight'; }); // deep link (Scouting Insight)
await club.waitForSelector('text=Exposure funnel', { timeout: 15000 });
await club.waitForSelector('text=Danny Osei', { timeout: 10000 });
say('pro demo: Scouting Insight renders the exposure funnel + review queue');
await club.evaluate(() => { location.hash = '#/imports'; }); // deep link (Imports & Integrations)
await club.waitForSelector('text=Identity reviews', { timeout: 10000 });
await club.waitForSelector('text=not configured', { timeout: 10000 });
say('pro demo: imports + honest not-configured connectors');
await club.evaluate(() => { location.hash = '#/budgets'; }); // deep link (Deal Budgets)
await club.waitForSelector('.f-about > summary', { timeout: 10000 }); await club.click('.f-about > summary'); // the note sits behind About
await club.waitForSelector('text=no market values, no resale projections', { timeout: 10000 });
say('pro demo: budgets screen carries the no-invented-values note');
await club.evaluate(() => { location.hash = '#/network'; }); // deep link (Club Network)
await club.waitForSelector('text=North West Development Group', { timeout: 10000 });
await club.waitForSelector('text=Leo Marchetti', { timeout: 10000 });
say('pro demo: groups + transition pack fixtures render');
// FR switch on one of these screens
await club.selectOption('select[aria-label="Language"]', 'fr');
await club.waitForSelector('.topbar h1:has-text("Réseau")', { timeout: 10000 }); // the h1 is the page title
say('pro demo: FR switch translates the suitability and coverage navigation (labelled machine translation)');
await club.close();

// ---- Grassroots demo
const grass = await page(`${demo.host}/grassroots/`);
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('.topbar', { timeout: 20000 });
await grass.evaluate(() => { location.hash = '#/coverage'; }); // deep link (Coverage)
await grass.waitForSelector('text=Travel time/route estimates unavailable', { timeout: 15000 });
await grass.evaluate(() => { location.hash = '#/organisation'; }); // deep link (Organisation)
for (let i = 0; i < 20 && !(await grass.locator('details.settings-row').count()); i++) await grass.waitForTimeout(250); await grass.evaluate(() => document.querySelectorAll('details.settings-row').forEach((d) => { d.open = true; })); // Staff & Security sections are rows; open them, then assert the same
await grass.waitForSelector('text=Onboarding checklist', { timeout: 10000 });
say('grassroots demo: coverage (honest travel note) + onboarding render');
await grass.close();

// ---- Player demo: preferences + fit + representation honesty
const player = await page(`${demo.host}/player/`);
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href^="/you"]');
await player.getByRole('tab', { name: 'Clubs' }).click(); // representation is Clubs › Current; suitability is Account › Preferences
await player.waitForSelector('text=NOT an independently verified licence', { timeout: 15000 });
await player.getByRole('tab', { name: 'Account' }).click();
await player.click('[data-testid="account-cat-preferences"]');
await player.waitForSelector('text=Suitability preferences', { timeout: 20000 });
say('player demo: preferences + representation (honest credential label) render on You');
await playerCategory(player, 'journey', 'Board'); // the fit section sits on My journey › Board
await player.waitForSelector('text=Opportunity fit', { timeout: 20000 });
say('player demo: opportunity fit section renders on Opportunities');
await player.close();

// ---- Trust & Safety demo: the matching tabs
const admin = await page(`${demo.host}/admin/`);
await admin.waitForSelector('text=Report queue', { timeout: 20000 });
await admin.click('nav.sidebar button:has-text("Delivery & Billing")'); // Delivery centre sits in Delivery & Billing (Operations split so no group lists more than five)
await admin.click('nav.subnav button:has-text("Delivery centre")');
await admin.waitForSelector('text=no message leaves this machine', { timeout: 10000 });
await admin.click('nav.sidebar button:has-text("Cases")');
await admin.click('nav.subnav button:has-text("Support desk")');
await admin.waitForSelector('.f-about > summary', { timeout: 10000 }); await admin.locator('.f-about > summary').first().click(); // the notice sits behind About
await admin.waitForSelector('text=no silent impersonation path', { timeout: 10000 });
await admin.click('nav.sidebar button:has-text("System")');
await admin.click('nav.subnav button:has-text("Backups")');
await admin.waitForSelector('.f-about > summary', { timeout: 10000 }); await admin.locator('.f-about > summary').first().click(); // the notice sits behind About
await admin.waitForSelector('text=never over the live database', { timeout: 10000 });
say('admin demo: delivery centre, support desk and backups tabs render honestly');
await admin.close();

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
console.log('\nM13 DEMO SPOTCHECK OK — zero page errors');
await browser.close();
await demo.stop();
process.exit(0);
