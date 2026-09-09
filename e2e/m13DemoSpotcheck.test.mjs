// M13 demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through the new M13 surfaces and fails on any page error.
// Requires `node serve.mjs` on :8099.
import { chromium } from 'playwright-core';

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

// ---- Pro demo: M13 screens on demo fixtures
const club = await page('http://localhost:8099/club/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('.topbar', { timeout: 20000 });
await club.click('nav.sidebar button:has-text("Scouting Insight")');
await club.waitForSelector('text=Exposure funnel', { timeout: 15000 });
await club.waitForSelector('text=Danny Osei', { timeout: 10000 });
say('pro demo: Scouting Insight renders the exposure funnel + review queue');
await club.click('nav.sidebar button:has-text("Imports & Integrations")');
await club.waitForSelector('text=Identity reviews', { timeout: 10000 });
await club.waitForSelector('text=not configured', { timeout: 10000 });
say('pro demo: imports + honest not-configured connectors');
await club.click('nav.sidebar button:has-text("Deal Budgets")');
await club.waitForSelector('text=no market values, no resale projections', { timeout: 10000 });
say('pro demo: budgets screen carries the no-invented-values note');
await club.click('nav.sidebar button:has-text("Club Network")');
await club.waitForSelector('text=North West Development Group', { timeout: 10000 });
await club.waitForSelector('text=Leo Marchetti', { timeout: 10000 });
say('pro demo: groups + transition pack fixtures render');
// FR switch on an M13 screen
await club.selectOption('select[aria-label="Language"]', 'fr');
await club.waitForSelector('text=Réseau de clubs', { timeout: 10000 });
say('pro demo: FR switch translates the M13 navigation (labelled machine translation)');
await club.close();

// ---- Grassroots demo
const grass = await page('http://localhost:8099/grassroots/');
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('.topbar', { timeout: 20000 });
await grass.click('nav.sidebar button:has-text("Coverage")');
await grass.waitForSelector('text=Travel time/route estimates unavailable', { timeout: 15000 });
await grass.click('nav.sidebar button:has-text("Organisation")');
await grass.waitForSelector('text=Onboarding checklist', { timeout: 10000 });
say('grassroots demo: coverage (honest travel note) + onboarding render');
await grass.close();

// ---- Player demo: preferences + fit + representation honesty
const player = await page('http://localhost:8099/player/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=Suitability preferences', { timeout: 20000 });
await player.waitForSelector('text=NOT an independently verified licence', { timeout: 15000 });
say('player demo: preferences + representation (honest credential label) render on You');
await player.click('a[href="/discover"]');
await player.waitForSelector('text=Opportunity fit', { timeout: 20000 });
say('player demo: opportunity fit section renders on Discover');
await player.close();

// ---- Trust & Safety demo: M13 tabs
const admin = await page('http://localhost:8099/admin/');
await admin.waitForSelector('text=Report queue', { timeout: 20000 });
await admin.click('button:has-text("Delivery centre")');
await admin.waitForSelector('text=no message leaves this machine', { timeout: 10000 });
await admin.click('button:has-text("Support desk")');
await admin.waitForSelector('text=no silent impersonation path', { timeout: 10000 });
await admin.click('button:has-text("Backups")');
await admin.waitForSelector('text=never over the live database', { timeout: 10000 });
say('admin demo: delivery centre, support desk and backups tabs render honestly');
await admin.close();

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
console.log('\nM13 DEMO SPOTCHECK OK — zero page errors');
await browser.close();
process.exit(0);
