// Cross-tab messaging E2E: a club demo tab and a player demo tab in the SAME
// browser hold one real conversation over the sync bus. Requires
// buildDemos.mjs output + serve.mjs running on :8099.
import { chromium } from 'playwright-core';

const HOST = process.env.DEMO_HOST || 'http://localhost:8099';
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const say = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// ---- club tab: log in, open Kola, send a contact request
const club = await ctx.newPage();
await club.goto(`${HOST}/club/`);
await club.evaluate(() => localStorage.clear()); // fresh demo state
await club.goto(`${HOST}/club/`);
await club.click('.org-card:has-text("Eastport FC")');
await club.fill('.enter-row input', 'Maria Keane');
await club.click('button:has-text("Enter workspace")');
await club.click('nav.sidebar button:has-text("Search")');
await club.waitForSelector('.player-card:not(.skeleton)');

// ---- player tab joins (same origin → bus connects, presence marks peer)
const player = await ctx.newPage();
await player.goto(`${HOST}/player/`);
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click(); // Kola Adeyemi
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.waitForTimeout(1500); // one presence heartbeat

// club → request
await club.click('.player-card:has-text("Kola Adeyemi")');
await club.waitForSelector('.drawer h3');
await club.click('.drawer button:has-text("Request contact")');
await club.fill('.drawer input[placeholder^="Message to the player"]', 'Our first-team coach would like a word after your cup final.');
await club.click('.drawer button:has-text("Send")');
say('club: request sent');
await club.click('.drawer button:has-text("Close")');

// player: popup + accept
await player.waitForSelector('text=Eastport FC sent you a contact request', { timeout: 15000 });
say('player: popup banner appeared for incoming request');
await player.click('a[href="/inbox"]');
await player.waitForSelector('text=Accept contact', { timeout: 10000 });
await player.click('text=Accept contact');
await player.waitForSelector('text=channel open', { timeout: 10000 });
say('player: accepted the real request from the club tab');

// club: acceptance toast
await club.waitForSelector('.toast', { timeout: 15000 });
say('club: acceptance toast appeared');

// player → message (open the thread, then write)
await player.getByText('Open', { exact: true }).first().click();
await player.fill('input[placeholder="Write a message (no personal contact details)"]', 'Thanks — happy to talk this week.');
await player.keyboard.press('Enter');
say('player: message sent');

// club: red unread badge with a count, message visible in the thread
await club.waitForSelector('.nav-badge', { timeout: 15000 });
const badge = await club.locator('.nav-badge').first().innerText();
if (!/^\d+$/.test(badge.trim()) || Number(badge) < 1) fail(`club badge not a count: "${badge}"`);
say(`club: red Messages badge shows ${badge.trim()}`);
await club.click('nav.sidebar button:has-text("Messages")');
await club.click('.list-row:has-text("Kola Adeyemi")');
await club.waitForSelector('text=happy to talk this week', { timeout: 10000 });
say('club: player message visible in thread');

// player-side simulation suppressed: no canned org reply while the club tab
// is present (the canned reply would land ~3.5s after sending).
await player.waitForTimeout(6000);
const canned = await player.locator('text=stays on ScoutBox').count();
if (canned > 0) fail('simulated org reply appeared despite live club tab');
say('player: simulated counterparty suppressed while club tab present');

// club → real reply reaches the player
await club.fill('input[placeholder="Write a message (moderated — no personal contact details)"]', 'Great — Thursday 6pm in this thread.');
await club.click('button:has-text("Send")');
await player.waitForSelector('text=Thursday 6pm in this thread', { timeout: 15000 });
say('player: club reply arrived in open thread');

await browser.close();
console.log('CROSS-TAB E2E OK');
