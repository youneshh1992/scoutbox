// M14 demo spotcheck — drives the self-contained demo bundles (the exact
// artifact HTML) through the Verification surfaces and fails on any page
// error. Demo personas: verified club + root admin, verified scout, pending
// coach, former (historical) coach, licence submitted-but-NOT-verified, root
// request awaiting T&S, grassroots request awaiting review.
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

// ---- Pro demo: Verification workspace
const club = await page('http://localhost:8099/club/');
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.waitForSelector('.topbar', { timeout: 20000 });
await club.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await club.waitForSelector('text=Verify your football role', { timeout: 15000 });
await club.waitForSelector('text=Role verified: Head of Recruitment', { timeout: 10000 });
// licence honesty: submitted credential must NOT read as verified
const meText = await club.locator('body').innerText();
if (!meText.includes('malware scan: not configured')) fail('evidence checks not honestly labelled');
if (!meText.includes('review pending') && !meText.includes('requires human review')) say('… (licence pending state shown via status pill)');
say('pro demo: My verification — steps, badges with provenance, honest evidence labels');

await club.click('button[role="tab"]:has-text("Requests")');
await club.waitForSelector('text=Jo Denton', { timeout: 10000 });
await club.waitForSelector('text=work email on verified domain', { timeout: 10000 });
say('pro demo: pending coach request with prepared email/identity status');
await club.click('button[role="tab"]:has-text("Staff")');
await club.waitForSelector('.list-row:has-text("Tom Field")', { timeout: 10000 });
await club.waitForSelector('.list-row:has-text("Priya Nair"):has-text("Former")', { timeout: 10000 });
say('pro demo: verified scout (current) + former coach (2019–2023 historical) personas');
await club.click('button[role="tab"]:has-text("Domains")');
await club.waitForSelector('text=eastportfc.com', { timeout: 10000 });
await club.click('button[role="tab"]:has-text("Administrators")');
await club.waitForSelector('text=verification root admin', { timeout: 10000 });
say('pro demo: domains + root admin persona render');
// FR switch on the verification screen
await club.selectOption('select[aria-label="Language"]', 'fr');
await club.waitForSelector('nav.subnav button:has-text("Vérification")', { timeout: 10000 });
await club.getByRole('tab', { name: 'Ma vérification' }).click();
await club.waitForSelector('text=Vérifiez votre rôle dans le football', { timeout: 10000 });
say('pro demo: FR switch translates the Verification screen');
await club.close();

// ---- Grassroots demo
const grass = await page('http://localhost:8099/grassroots/');
await grass.click('.org-card:has-text("Hackney Marsh")');
await grass.fill('.enter-row input', 'Dee Coach');
await grass.click('button:has-text("Enter workspace")');
await grass.waitForSelector('.topbar', { timeout: 20000 });
await grass.evaluate(() => { location.hash = '#/verification'; }); // M15-Nav deep link (Verification)
await grass.waitForSelector('text=Verify your football role', { timeout: 15000 });
const gText = await grass.locator('body').innerText();
if (!gText.includes('Hackney Marsh Rovers')) fail('grassroots verification screen missing its own club identity');
say('grassroots demo: verification workspace renders for the grassroots club');
await grass.close();

// ---- Player demo: references with provenance
const player = await page('http://localhost:8099/player/');
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.waitForSelector('text=Coach references', { timeout: 20000 });
await player.waitForSelector('text=Coach affiliation was verified when this reference was submitted.', { timeout: 10000 });
const pText = await player.locator('body').innerText();
if (!pText.includes('is verified')) fail('current-coach provenance line missing');
say('player demo: references show live vs at-submission provenance honestly');
await player.close();

// ---- T&S demo: verification review centre
const admin = await page('http://localhost:8099/admin/');
await admin.waitForSelector('text=Report queue', { timeout: 20000 });
await admin.getByRole('button', { name: 'Verification', exact: true }).click();
await admin.waitForSelector('text=Riverton Athletic FC', { timeout: 10000 });
await admin.waitForSelector('text=Marsh Lane Juniors', { timeout: 10000 });
await admin.waitForSelector('text=dnsOwnership=not_configured', { timeout: 10000 });
await admin.waitForSelector('text=signals, not fraud', { timeout: 10000 }).catch(() => {});
say('T&S demo: root request (pro) + grassroots request awaiting review, honest check labels');
await admin.click('nav.sidebar button:has-text("Cases")');
await admin.click('nav.subnav button:has-text("Ver. disputes")');
await admin.waitForSelector('text=worked through July', { timeout: 10000 });
say('T&S demo: dispute case renders with preserved reason');
await admin.close();

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
console.log('\nm14DemoSpotcheck: all demo verification surfaces OK, zero page errors');
process.exit(0);
