// Feature spot-check across the player demo UI: M6 surfaces (directory, trial
// slots, season history, prefs/export) plus the M7 flows — guardian signup
// with password + email verification, and cross-tab device pairing.
import { chromium } from 'playwright-core';

const HOST = process.env.DEMO_HOST || 'http://localhost:8099';
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const say = (m) => console.log(m);
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 420, height: 880 } });

const freshPage = async () => {
  const p = await ctx.newPage();
  await p.goto(`${HOST}/player/`);
  await p.evaluate(() => localStorage.removeItem('scoutbox-player-session'));
  await p.goto(`${HOST}/player/`);
  await p.waitForSelector('text=Our promises to every player', { timeout: 30000 });
  return p;
};

// ---- Kola: directory, slots, seasons + trend, prefs/export/delete
{
  const page = await freshPage();
  await page.locator('text=Enter').nth(0).click(); // Kola
  await page.waitForSelector('text=Your visibility right now', { timeout: 20000 });
  await page.waitForSelector('text=Club directory', { timeout: 10000 });
  say(`directory card renders: ${await page.locator('text=Eastport FC').first().isVisible()}`);

  // M9: pathway + opportunity radar on Home
  await page.waitForSelector('text=Your pathway', { timeout: 10000 });
  await page.waitForSelector('text=Clubs within reach', { timeout: 10000 });
  await page.waitForSelector('text=Moss Side Athletic', { timeout: 5000 });
  say('pathway + opportunity radar render on Home');

  await page.waitForTimeout(9000); // delayed demo trial request arrives with slots
  await page.click('a[href="/inbox"]');
  await page.waitForSelector('text=Pick the date that works', { timeout: 15000 });
  say('trial slot picker renders in inbox');

  // M9: training programme on Upload
  await page.click('a[href="/upload"]');
  await page.waitForSelector('text=Your training programme', { timeout: 15000 });
  await page.getByText('Attacking track ★', { exact: true }).click();
  await page.waitForSelector('text=this week', { timeout: 10000 });
  say('training programme: track selected, weekly sessions render');

  await page.click('a[href="/profile"]');
  await page.waitForSelector('text=season by season', { timeout: 15000 });
  say('season history + goals trend renders on profile');
  await page.waitForSelector('text=Coach references', { timeout: 10000 });
  await page.waitForSelector('text=your cohort, not the pros', { timeout: 10000 });
  say('coach references + cohort benchmarks render on profile');

  await page.click('a[href="/you"]');
  await page.waitForSelector('text=School-hours mute', { timeout: 15000 });
  await page.waitForSelector('text=Preview my data export');
  await page.waitForSelector('text=Delete my account');
  await page.click('text=Preview my data export');
  await page.waitForSelector('text=exportedAt', { timeout: 8000 });
  say('You tab: prefs, export preview, delete render');
  await page.close();
}

// ---- new guardian: password + email code (DEMO42) gates, then IDV
{
  const page = await freshPage();
  await page.click('text=I\'m a parent / guardian');
  await page.fill('input[placeholder="Your full name"]', 'Nadia Test');
  await page.fill('input[placeholder="Your email"]', 'nadia@testfamily.co.uk');
  await page.fill('input[placeholder="Password (required, 8+ characters)"]', 'longenough1');
  await page.click('text=Continue to email verification');
  await page.waitForSelector('text=your code is: DEMO42', { timeout: 10000 });
  say('guardian signup: dev mail transport surfaces the code');
  await page.fill('input[placeholder="XXXXXX"]', 'DEMO42');
  await page.click('text=Verify email');
  await page.waitForSelector('text=ID verification', { timeout: 10000 });
  say('email verification gate passes with the mailed code');
  await page.close();
}

// ---- guardian → pairing code → child pairs in another tab (same browser)
{
  const g = await freshPage();
  await g.locator('text=Enter').nth(2).click(); // Amara (guardian)
  await g.waitForSelector('text=Club requests', { timeout: 20000 });
  await g.waitForSelector('text=Pick the date that works for your family', { timeout: 10000 });
  say('guardian slot picker renders');
  await g.click('text=Generate pairing code');
  await g.waitForSelector('text=Code: ', { timeout: 8000 });
  const code = (await g.locator('text=Code: ').first().innerText()).replace('Code: ', '').trim();
  say(`guardian pairing code generated: ${code}`);

  const c = await freshPage();
  await c.click('text=I have a code from my parent/guardian');
  await c.fill('input[placeholder="XXXXXX"]', code);
  await c.click('text=Pair and enter');
  await c.waitForSelector('text=Your visibility right now', { timeout: 20000 });
  say('child device paired via cross-tab code and landed on Home');
}

await browser.close();
console.log('UI SPOTCHECK OK');
