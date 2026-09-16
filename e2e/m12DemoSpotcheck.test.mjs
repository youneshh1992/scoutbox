// M12 demo spotcheck: the rebuilt single-file demo bundles show populated
// examples of the new features and the interactive demo actions work.
// Serve dist first: node serve.mjs &
import { chromium } from 'playwright-core';
import { ensureDemoHost } from './demoHost.mjs';

// D7 (M22 §74-§76): this test OWNS its demo host. It used to assume one
// was already listening on :8099 — which was true only because crosstab
// and demoOffline left one behind. Once those correctly released the
// port, every spotcheck failed, which is the ambient-state dependency
// becoming visible rather than a new break.
const demo = await ensureDemoHost();
const HOST = process.env.DEMO_HOST || demo.host;
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const say = (m) => console.log(m);
const browser = await chromium.launch({ executablePath: EXE });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// ---- Pro demo
await page.goto(`${HOST}/club/`);
await page.click('.org-card:has-text("Eastport FC")');
await page.fill('.enter-row input', 'Maria Keane');
await page.click('button:has-text("Enter workspace")');
await page.waitForSelector('.topbar', { timeout: 20000 });
await page.evaluate(() => { location.hash = '#/assessments'; }); // M15-Nav deep link (Assessments)
await page.waitForSelector('text=independence is enforced by the server', { timeout: 10000 });
await page.selectOption('select[aria-label="Player"]', { label: 'Kola Adeyemi' });
await page.waitForSelector('text=Evidence passport', { timeout: 10000 });
await page.waitForSelector('text=coach confirmed', { timeout: 10000 });
await page.click('button:has-text("Compare scouts")');
await page.waitForSelector('text=Alex Ford', { timeout: 10000 });
say('Pro demo: assessments + passport + compare populated');
await page.evaluate(() => { location.hash = '#/recruitment'; }); // M15-Nav deep link (Recruitment)
await page.waitForSelector('text=Owner Maria Keane', { timeout: 10000 });
await page.locator('.section button', { hasText: 'Kola Adeyemi' }).first().click();
await page.waitForSelector('text=History (append-only)', { timeout: 5000 });
await page.evaluate(() => { location.hash = '#/planner'; }); // M15-Nav deep link (Squad Planner)
await page.waitForSelector('text=no invented percentages', { timeout: 10000 });
await page.locator('button:has-text("Candidates")').first().click();
await page.waitForSelector('text=profile field: position', { timeout: 10000 });
say('Pro demo: recruitment board + explainable candidates');
await page.evaluate(() => { location.hash = '#/opportunities'; }); // M15-Nav deep link (Opportunities)
await page.waitForSelector('text=U23 open trial — attackers', { timeout: 10000 });
await page.evaluate(() => { location.hash = '#/campaigns'; }); // M15-Nav deep link (Campaigns)
await page.waitForSelector('text=Remote sprint assessment', { timeout: 10000 });
await page.evaluate(() => { location.hash = '#/video'; }); // M15-Nav deep link (Video Workspace)
await page.waitForSelector('text=sets the trap on the CB', { timeout: 10000 });
await page.evaluate(() => { location.hash = '#/outcomes'; }); // M15-Nav deep link (Outcomes)
await page.waitForSelector('text=Filip Nowak', { timeout: 10000 });
await page.evaluate(() => { location.hash = '#/trialdays'; }); // M15-Nav deep link (Trial Days)
await page.waitForSelector('text=Check-in is blocked', { timeout: 10000 });
say('Pro demo: opportunities, campaigns, video, outcomes, trial days all populated');
// FR switch holds layout
await page.selectOption('nav.sidebar select', 'fr');
await page.waitForSelector('nav.sidebar button:has-text("Recrutement")', { timeout: 5000 });
await page.selectOption('nav.sidebar select', 'en');
say('Pro demo: EN/FR switch works');

// ---- Grassroots demo
await page.goto(`${HOST}/grassroots/`);
await page.click('.org-card:has-text("Hackney Marsh Rovers")');
await page.fill('.enter-row input', 'Dee Mensah');
await page.click('button:has-text("Enter workspace")');
await page.waitForSelector('.topbar', { timeout: 20000 });
await page.evaluate(() => { location.hash = '#/coaches'; }); // M15-Nav deep link (Coaches)
await page.waitForSelector('text=coach confirmed', { timeout: 10000 }).catch(() => {});
await page.waitForSelector('text=Confirm affiliation', { timeout: 10000 });
await page.waitForSelector('text=Dee Mensah', { timeout: 5000 });
say('Grassroots demo: coach affiliations populated');
await page.evaluate(() => { location.hash = '#/trialdays'; }); // M15-Nav deep link (Trial Days)
await page.waitForSelector('text=Check-in is blocked', { timeout: 10000 });
say('Grassroots demo: trial days present');

// ---- Player demo (mobile viewport)
const mob = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
mob.on('pageerror', (e) => errors.push(String(e)));
await mob.goto(`${HOST}/player/`);
await mob.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await mob.getByText('Enter', { exact: true }).first().click();
await mob.waitForSelector('text=Your visibility right now', { timeout: 20000 });
// P2.5: the board lives on the Opportunities tab.
await mob.click('a[href="/opportunities"]');
await mob.waitForSelector('text=Opportunity board', { timeout: 20000 });
await mob.waitForSelector('text=U23 open trial — attackers', { timeout: 10000 });
say('Player demo: opportunity board populated');
await mob.click('a[href="/you"]'); // P2.5: Profile is the first page tab of You
await mob.waitForSelector('text=Evidence passport', { timeout: 20000 });
await mob.waitForSelector('text=club assessed', { timeout: 10000 });
say('Player demo: evidence passport with honest tiers');
await mob.click('a[href="/you"]');
await mob.getByRole('tab', { name: 'Clubs' }).click();
await mob.waitForSelector('text=pressing triggers', { timeout: 20000 });
await mob.getByRole('tab', { name: 'Account' }).click();
await mob.waitForSelector('text=Access & language', { timeout: 10000 });
say('Player demo: feedback loop + access settings');
await mob.click('a[href="/opportunities"]'); // P2.5: squad invitations sit with the other opportunities
await mob.waitForSelector('text=Squad invitations', { timeout: 20000 });
await mob.waitForSelector('text=safety pack', { timeout: 10000 });
say('Player demo: squad invites + trial safety pack');

// ---- Admin demo
await page.goto(`${HOST}/admin/`);
await page.waitForSelector('text=Report queue', { timeout: 20000 });
await page.click('nav.subnav button:has-text("Evidence disputes")');
await page.waitForSelector('text=Club records show 11', { timeout: 10000 });
await page.click('nav.sidebar button:has-text("Verification")');
await page.click('nav.subnav button:has-text("Staff checks")');
await page.waitForSelector('text=Marcus Cole', { timeout: 10000 });
await page.click('nav.sidebar button:has-text("Operations")');
await page.click('nav.subnav button:has-text("Outcome tracking")');
await page.waitForSelector('text=suppressed', { timeout: 10000 });
say('Admin demo: disputes, staff checks, outcome suppression all populated');

if (errors.length) { console.error('page errors:', errors); await demo.stop(); process.exit(1); }
console.log('\nM12 DEMO SPOTCHECK OK — zero page errors');
await browser.close();
await demo.stop();
process.exit(0);
