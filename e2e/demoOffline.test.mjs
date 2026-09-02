// Self-containment E2E: the single-file demo bundles must work with no
// network beyond the single page load. Club + admin load from file://; the
// player demo needs http (its deep-path history shim is a SecurityError under
// file://) so it loads from the deep path with everything else blocked.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const HOST = process.env.DEMO_HOST || 'http://localhost:8099';
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: EXE });

// ---- club demo, file://, all network aborted
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https?:\/\//, (r) => r.abort());
  page.on('pageerror', (e) => console.log('CLUB PAGE ERROR:', e.message));
  await page.goto(`file://${DIST}/scoutbox-club-demo.html`);
  await page.click('.org-card:has-text("Eastport FC")');
  await page.fill('.enter-row input', 'Maria Keane');
  await page.click('button:has-text("Enter workspace")');
  await page.click('nav.sidebar button:has-text("Search")');
  await page.waitForSelector('.player-card:not(.skeleton) .name');
  console.log('club demo: search shows', await page.locator('.player-card:not(.skeleton)').count(), 'players');
  await page.click('.player-card:not(.skeleton) >> nth=0');
  await page.waitForSelector('.drawer h3');
  console.log('club demo: profile opens:', await page.locator('.drawer h3').innerText());
  await page.close();
}

// ---- admin demo, file://, all network aborted
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https?:\/\//, (r) => r.abort());
  page.on('pageerror', (e) => console.log('ADMIN PAGE ERROR:', e.message));
  await page.goto(`file://${DIST}/scoutbox-admin-demo.html`);
  await page.waitForSelector('text=Report queue', { timeout: 15000 });
  await page.waitForSelector('text=URGENT', { timeout: 10000 });
  console.log('admin demo: report queue renders offline');
  await page.close();
}

// ---- grassroots demo, file://, all network aborted
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https?:\/\//, (r) => r.abort());
  page.on('pageerror', (e) => console.log('GRASSROOTS PAGE ERROR:', e.message));
  await page.goto(`file://${DIST}/scoutbox-grassroots-demo.html`);
  await page.click('.org-card:has-text("Hackney Marsh Rovers")');
  await page.fill('.enter-row input', 'Dee Mensah');
  await page.click('button:has-text("Enter workspace")');
  await page.click('nav.sidebar button:has-text("Search")');
  await page.waitForSelector('text=within 50 km');
  await page.waitForSelector('.player-card:not(.skeleton) .name');
  const names = await page.locator('.player-card:not(.skeleton) .name').allInnerTexts();
  if (names.includes('Elias Svensson')) throw new Error('grassroots demo: Manchester player visible from London');
  if (names.includes('Marcus Reid')) throw new Error('grassroots demo: pro player visible');
  const cards = await page.locator('.player-card:not(.skeleton)').allInnerTexts();
  if (!cards.some((t) => /km away/.test(t))) throw new Error('grassroots demo: no distance pills');
  console.log('grassroots demo: radius + level walls hold offline —', names.join(', '));
  await page.close();
}

// ---- player demo, deep path, only that origin allowed
{
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.route(/^https?:\/\//, (r) => (r.request().url().startsWith(`${HOST}/deep/nested`) ? r.continue() : r.abort()));
  page.on('pageerror', (e) => console.log('PLAYER PAGE ERROR:', e.message));
  await page.goto(`${HOST}/deep/nested/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${HOST}/deep/nested/`);
  await page.waitForSelector('text=Our promises to every player', { timeout: 30000 });
  await page.locator('text=Enter').nth(0).click(); // Kola
  await page.waitForSelector('text=Your visibility right now', { timeout: 20000 });
  console.log('player demo: logged in from a deep path, discover renders');
  await page.click('a[href="/inbox"]');
  await page.waitForSelector('text=Harbour City FC', { timeout: 15000 });
  await page.click('text=Accept contact');
  await page.waitForSelector('text=channel open', { timeout: 10000 });
  console.log('player demo: inbox accept works offline');
  await page.close();
}

await browser.close();
console.log('DEMO BUILDS OK');
