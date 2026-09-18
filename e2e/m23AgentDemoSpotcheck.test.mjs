// M23 P5.6B demo spotcheck — drives the self-contained Agent demo bundle
// (the exact artifact HTML) and the player demo's My Agent card, and fails
// on any page error. Owns its demo host (D7 pattern).
import { chromium } from 'playwright-core';
import { ensureDemoHost } from './demoHost.mjs';

const demo = await ensureDemoHost();
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const say = (m) => console.log(`✓ ${m}`);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: EXE });
const errors = [];
async function page(url, viewport = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport });
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  await p.goto(url);
  return p;
}
const text = (p) => p.locator('body').innerText();

// ---- Agent demo: Ana (licensed agent) — the whole workspace on sample data
const agent = await page(`${demo.host}/agent/`);
await agent.waitForSelector('.org-card', { timeout: 20000 });
if (!/Self-contained demo/.test(await text(agent))) fail('agent demo: the login does not declare itself a demo');
await agent.click('.org-card:has-text("North Star")');
await agent.fill('.enter-row input[aria-label]', 'Ana Costa');
await agent.click('button:has-text("Enter workspace")');
await agent.waitForSelector('[data-testid="agent-home"]', { timeout: 20000 });
await agent.waitForSelector('[data-testid="home-active"]', { timeout: 15000 });
if ((await agent.locator('[data-testid="home-active"] .v').innerText()) !== '2') fail('agent demo: Home should count two active clients');
if (!/adjudicates no conflicts/.test(await text(agent))) fail('agent demo: the regulatory notice is missing');
say('agent demo: Home renders counts, tiers and the regulatory notice');
await agent.evaluate(() => { location.hash = '#/profile'; });
await agent.waitForSelector('[data-testid="facet-fifa-licence"]', { timeout: 15000 });
if (!/local-synthetic-test-provider/.test(await agent.locator('[data-testid="facet-fifa-licence"]').innerText())) fail('agent demo: the FIFA facet does not name the synthetic provider');
if (!/never exists in production/.test(await agent.locator('[data-testid="provider-note"]').innerText())) fail('agent demo: the provider note is not honest');
say('agent demo: verification facets render with named provenance and the honest provider note');
await agent.evaluate(() => { location.hash = '#/clients'; });
await agent.waitForSelector('[data-testid="clients-active"]', { timeout: 15000 });
const rows = await agent.locator('[data-testid="clients-active"] .list-row').allInnerTexts();
if (!rows.some((r) => /Kola Adeyemi/.test(r)) || !rows.some((r) => /Mateus Carvalho/.test(r))) fail('agent demo: active clients missing');
if (!(await agent.locator('[data-testid="clients-ended"]').innerText()).includes('Disputed')) fail('agent demo: the disputed record is not listed');
say('agent demo: Clients lists active, pending and disputed records');
await agent.evaluate(() => { location.hash = '#/clients/rep-d4'; });
await agent.waitForSelector('[data-testid="client-detail"][data-status="disputed"]', { timeout: 15000 });
if (!/Access suspended/.test(await agent.locator('[data-testid="access-line"]').innerText())) fail('agent demo: disputed detail should say access is suspended');
if (!/nothing here can resolve it/.test(await text(agent))) fail('agent demo: the dispute note must say nothing here resolves it');
say('agent demo: a disputed client says access is suspended and nothing here can resolve it');
await agent.evaluate(() => { location.hash = '#/clients/rep-d1/opportunities'; });
await agent.waitForSelector('[data-testid="client-opps"]', { timeout: 15000 });
if (!/Open trial — forwards/.test(await text(agent))) fail('agent demo: the client board is empty');
say('agent demo: an active client\'s Opportunities tab shows the client\'s board');
await agent.evaluate(() => { location.hash = '#/agency/team'; });
await agent.waitForSelector('[data-testid="team-rows"]', { timeout: 15000 });
if ((await agent.locator('[data-testid="add-member"]').count()) !== 0) fail('agent demo: a licensed agent must not see the add-member form');
say('agent demo: Team is read-only for a licensed agent');
await agent.evaluate(() => { location.hash = '#/agency/compliance'; });
await agent.waitForSelector('[data-testid="compliance-honest"]', { timeout: 15000 });
if (!/Informational only/.test(await text(agent))) fail('agent demo: compliance must be informational');
say('agent demo: Compliance is informational');
// ---- M23 P5.6C: the compliance surface in the demo artifact
await agent.evaluate(() => { location.hash = '#/compliance'; });
await agent.waitForSelector('[data-testid="agent-compliance"]', { timeout: 15000 });
// The screen mounts before its projection arrives; wait for the data, not the frame.
await agent.waitForSelector('[data-testid="provider-status"]', { timeout: 15000 });
{
  const body = await text(agent);
  if (!/not statements of legal validity/.test(body)) fail('agent demo: the compliance screen must say a policy result is not a statement of legal validity');
  if ((await agent.locator('[data-testid="provider-status"]').getAttribute('data-live')) !== '0') fail('agent demo: the provider must declare that no live register is connected');
  const pol = await agent.locator('[data-testid="policies-section"]').innerText();
  if (!/jp-fifa-2025-1/.test(pol) || !/jp-eng-2026-27-1/.test(pol)) fail('agent demo: the policy versions in effect are missing');
  if (!/pathway not enabled/.test(await agent.locator('[data-testid="minors-section"]').innerText())) fail('agent demo: the minors pathway must read as not enabled');
  say('agent demo: Compliance shows the honest provider, the policy versions and a closed minors pathway');
}
{
  await agent.click('[data-testid="open-new-context"]');
  await agent.waitForSelector('[data-testid="new-context"]', { timeout: 10000 });
  await agent.selectOption('[data-testid="ctx-individual"]', { label: 'Kola Adeyemi' });
  await agent.selectOption('[data-testid="ctx-engaging"]', { label: 'Eastport FC' });
  await agent.click('[data-testid="ctx-create"]');
  await agent.waitForSelector('[data-testid="context-detail"]', { timeout: 15000 });
  if ((await agent.locator('[data-testid="outcome"]').first().getAttribute('data-outcome')) !== 'CLEAR') fail('agent demo: a fresh context should evaluate CLEAR');
  await agent.selectOption('[data-testid="declare-role"]', 'individual');
  await agent.click('[data-testid="declare"]');
  await agent.waitForSelector('[data-testid="party-individual"][data-represented="verified"]', { timeout: 15000 });
  await agent.selectOption('[data-testid="declare-role"]', 'engaging_entity');
  await agent.click('[data-testid="declare"]');
  await agent.waitForSelector('[data-testid="refusal"]', { timeout: 15000 });
  const refusal = await agent.locator('[data-testid="refusal"]').innerText();
  if (!/attributed review/i.test(refusal)) fail('agent demo: declaring an entity with no agreement must say it needs attributed review');
  if (!/not a Transaction Room/i.test(await text(agent))) fail('agent demo: the context must say what it is not');
  say('agent demo: a context evaluates CLEAR, one party is recorded, and the club declaration is refused into attributed review');
}
await agent.evaluate(() => { location.hash = '#/agency/compliance'; });
await agent.waitForSelector('[data-testid="compliance-honest"]', { timeout: 15000 });
await agent.selectOption('nav.sidebar select[aria-label="Language"]', 'fr');
await agent.waitForTimeout(400);
if (!/Agence/.test(await agent.locator('nav.sidebar').innerText())) fail('agent demo: FR sidebar');
say('agent demo: FR renders');
await agent.close();

// ---- Agent demo: Tomás (admin) — governance, no client requests
const admin = await page(`${demo.host}/agent/`);
await admin.waitForSelector('.org-card', { timeout: 20000 });
await admin.click('.org-card:has-text("North Star")');
await admin.fill('.enter-row input[aria-label]', 'Tomás Rivera');
await admin.click('button:has-text("Enter workspace")');
await admin.waitForSelector('[data-testid="agent-home"]', { timeout: 20000 });
if (/Opportunit/.test(await admin.locator('nav.sidebar').innerText())) fail('agent demo: an administrator must not see Opportunities');
await admin.evaluate(() => { location.hash = '#/agency/team'; });
await admin.waitForSelector('[data-testid="add-member"]', { timeout: 15000 });
say('agent demo: an administrator sees Team management and no Opportunities');
await admin.evaluate(() => { location.hash = '#/clients'; });
await admin.waitForSelector('[data-testid="agent-clients"]', { timeout: 15000 });
if ((await admin.locator('[data-testid="open-request"]').count()) !== 0) fail('agent demo: an administrator must not be offered "Request a relationship"');
if (!(await admin.locator('[data-testid="clients-summary"]').innerText()).includes('Kola Adeyemi')) fail('agent demo: the shared summary row is missing');
say('agent demo: an administrator sees only the summary a client chose to share');
await admin.close();

// ---- Agent demo at 390: login and Home fit
const phone = await page(`${demo.host}/agent/`, { width: 390, height: 844 });
await phone.waitForSelector('.org-card', { timeout: 20000 });
if (!(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1))) fail('agent demo: 390px login scrolls horizontally');
await phone.click('.org-card:has-text("North Star")');
await phone.fill('.enter-row input[aria-label]', 'Ana Costa');
await phone.click('button:has-text("Enter workspace")');
await phone.waitForSelector('[data-testid="agent-home"]', { timeout: 20000 });
if (!(await phone.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1))) fail('agent demo: 390px Home scrolls horizontally');
say('agent demo: 390px login and Home fit');
await phone.close();

// ---- Player demo: My Agent on You › Clubs
const player = await page(`${demo.host}/player/`);
await player.waitForSelector('text=Our promises to every player', { timeout: 30000 });
await player.locator('text=Enter').nth(0).click();
await player.waitForSelector('text=Your visibility right now', { timeout: 20000 });
await player.click('a[href="/you"]');
await player.getByRole('tab', { name: 'Clubs' }).click();
await player.waitForSelector('[data-testid="my-agent"]', { timeout: 30000 });
const card = player.locator('[data-testid="my-agent"]');
let t = '';
for (let i = 0; i < 60; i++) { t = await card.innerText().catch(() => ''); if (/Ana Costa/.test(t)) break; await player.waitForTimeout(250); }
if (!/Ana Costa/.test(t)) console.error('   card text:', JSON.stringify(t).slice(0, 500));
if (!/Ana Costa/.test(t) || !/Awaiting your answer/.test(t)) fail('player demo: My Agent should list Ana\'s pending request');
if (!/NOT verified/.test(t)) fail('player demo: the unverified agent must be labelled NOT verified');
if (/TEST-VERIFIED/.test(t)) fail('player demo: no reference number may reach the player');
await card.locator('text="Confirm"').first().click();
await player.waitForSelector('text=Confirmed — active from now', { timeout: 15000 });
say('player demo: My Agent shows the requests with honest licence states and confirms one');
await player.close();

// ---- Admin demo: the attributed compliance review console (G-C0)
const ts = await page(`${demo.host}/admin/`);
await ts.waitForSelector('nav.sidebar', { timeout: 20000 });
await ts.click('nav.sidebar button:has-text("Agents")');
await ts.waitForSelector('[data-testid="reviewer-who"]', { timeout: 20000 });
{
  const who = await ts.locator('[data-testid="reviewer-who"]').innerText();
  if (!/authenticated reviewer/.test(who)) fail('admin demo: the console must name the authenticated reviewer');
  const queue = await text(ts);
  if (!/resolves missing or uncertain/.test(queue)) fail('admin demo: the reviewer\'s remit must be stated');
  if (!/never rewrites policy/.test(queue)) fail('admin demo: the limit on a reviewer\'s power must be stated');
  const ids = await ts.locator('[data-testid^="review-rrv-"]').count();
  if (ids === 0) fail('admin demo: the queue shows no items');
  say(`admin demo: the attributed review queue lists ${ids} open item(s) with the reviewer's remit and its limits`);
  await ts.click('[data-testid="open-rrv-d1"]');
  await ts.waitForSelector('[data-testid="review-detail"]', { timeout: 15000 });
  const detail = await ts.locator('[data-testid="review-detail"]').innerText();
  if (!/FA-REAL-42/.test(detail)) fail('admin demo: the reviewer must see the reference under review');
  if (!/Evidence references/.test(detail)) fail('admin demo: an approval must ask for evidence');
  say('admin demo: an item opens with exactly what the review needs and an evidence field');
}
await ts.click('nav.subnav button:has-text("Jurisdiction policy")');
await ts.waitForSelector('[data-testid="policy-jp-eng-2026-27-1"]', { timeout: 15000 });
{
  const pol = await text(ts);
  if (!/one\s+administrator proposes it, a different one approves it/.test(pol)) fail('admin demo: dual control must be stated');
  if (!/under legal review/.test(pol)) fail('admin demo: a rule whose operative status is contested must show it');
  if ((await ts.locator('[data-testid="approve-jp-eng-2026-27-2"]').count()) === 0) fail('admin demo: a proposed version should offer approval to an administrator');
  say('admin demo: policy versions show each rule\'s operative status, and publication is dual-controlled');
}
await ts.click('nav.subnav button:has-text("Reviewer identities")');
await ts.waitForSelector('[data-testid="decision-audit"]', { timeout: 15000 });
{
  const body = await text(ts);
  if (!/at least one administrator must remain/i.test(body)) fail('admin demo: the last-administrator floor must be stated');
  if (!/Marcus Bell/.test(await ts.locator('[data-testid="decision-audit"]').innerText())) fail('admin demo: the decision record must name the reviewer');
  say('admin demo: reviewer identities and an attributed decision record');
}
await ts.close();

if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
console.log('\nM23 P5.6B/P5.6C AGENT + COMPLIANCE DEMO SPOTCHECK OK — zero page errors');
await browser.close();
await demo.stop();
process.exit(0);
