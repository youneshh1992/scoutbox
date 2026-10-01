// M24B — case navigation acceptance (no browser).
//
// Compiles the REAL category → subcategory models of Pro, Grassroots, Agent
// and Player with rolldown and asserts the hard rule — NO recruitment
// category in any application holds more than five subcategories — plus the
// things a wrong model would silently break: unique ids, every legacy tab
// the server still emits resolves to a subcategory, every deep link the app
// writes it can read back, a malformed link still rejects.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'scoutbox-club', 'package.json'));
const { rolldown } = require('rolldown');

let passed = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const section = (n) => console.log(`\n— ${n} —`);

async function load(file) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'sbx-casenav-')), 'm.mjs');
  const bundle = await rolldown({ input: path.join(ROOT, file), logLevel: 'silent' });
  await bundle.write({ file: out, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(out).href);
}

const ds = await load('design-system/caseNav.ts');
const MAX = ds.CASE_NAV_MAX_SUBS;
ok(MAX === 5, `the hard rule is five (${MAX})`);

// The tabs the SERVER still emits (notification targets + journey next-action
// tabs, m23/journeyRoutes.mjs + m23/journeyModel.mjs). Each must resolve.
const SERVER_ROOM_TABS = ['overview', 'contact', 'trial', 'offer', 'signing', 'assessments', 'decision'];
const SERVER_CLIENT_TABS = ['contacts', 'offers'];

const models = [];

// ------------------------------------------------------------ Pro + Grassroots
for (const [app, expectCats] of [['scoutbox-club', ['overview', 'player', 'evaluation', 'engagement', 'deal', 'history']], ['scoutbox-grassroots', ['overview', 'player-review', 'recruitment', 'agreement', 'history']]]) {
  section(`${app} — Recruitment Room`);
  const m = await load(`${app}/src/caseNav.ts`);
  const nav = await load(`${app}/src/nav.ts`);
  const model = m.ROOM_NAV;
  models.push([app, 'room', model]);
  const problems = ds.validateCaseNav(model);
  for (const p of problems) console.error(`   ${p}`);
  ok(problems.length === 0, 'the model is structurally sound (unique ids, no empty category, no ambiguous link)');
  ok(model.categories.map((c) => c.id).join(',') === expectCats.join(','), `categories: ${model.categories.map((c) => c.id).join(' · ')}`);
  ok(ds.widestCategory(model) <= MAX, `no category holds more than ${MAX} subcategories (widest: ${ds.widestCategory(model)})`);
  for (const tab of SERVER_ROOM_TABS) {
    const loc = ds.resolveTab(model, tab);
    if (!loc) fail(`server tab "${tab}" resolves to nothing`); else passed++;
  }
  console.log(`✓ every tab the server emits (${SERVER_ROOM_TABS.join(', ')}) resolves to a subcategory (${SERVER_ROOM_TABS.length} folded)`);
  // Every function the Room had is still reachable: the old flat tab ids.
  const OLD = ['overview', 'passport', 'evidence', 'assessments', 'combine', 'development', 'discussion', 'contact', 'trial', 'activity', 'decision', 'offer', 'signing'];
  const lost = OLD.filter((id) => !ds.resolveTab(model, id));
  ok(lost.length === 0, `every pre-M24B Room function is still a subcategory (lost: ${lost.join(',') || '—'})`);
  // Deep links: the app writes "<id>/<category>/<sub>", reads it back, and keeps reading the legacy form.
  for (const sub of ds.allSubs(model)) {
    const h = nav.hashForRoom('case-7', sub);
    const back = nav.roomTabFromHash(h);
    const loc = ds.locate(model, sub);
    const expectDefault = ds.caseSegments(model, loc).length === 0;
    if (nav.roomFromHash(h) !== 'case-7') fail(`${sub}: room id lost in ${h}`);
    else if (!expectDefault && back !== sub) fail(`${sub}: wrote ${h}, read back ${back}`);
    else if (expectDefault && (h !== '#/recruitment/rooms/case-7' || back !== null)) fail(`${sub}: the default page must be the bare room link (${h})`);
    else passed++;
  }
  console.log(`✓ every subcategory link round-trips (${ds.allSubs(model).length} folded)`);
  ok(nav.hashForRoom('case-7', 'offer') === '#/recruitment/rooms/case-7/deal/offer' || nav.hashForRoom('case-7', 'offer') === '#/recruitment/rooms/case-7/agreement/offer', `an Offer link names its category (${nav.hashForRoom('case-7', 'offer')})`);
  ok(nav.roomTabFromHash('#/recruitment/rooms/case-7/offer') === 'offer' && nav.roomTabFromHash('#/recruitment/rooms/case-7/signing') === 'signing' && nav.roomTabFromHash('#/recruitment/rooms/case-7/activity') === 'activity', 'legacy flat tab links still resolve (offer, signing, activity)');
  ok(nav.roomTabFromHash('#/recruitment/rooms/case-7/overview') === 'summary', 'the legacy "overview" tab resolves to Overview › Summary');
  ok(nav.roomTabFromHash('#/recruitment/rooms/case-7/history') === 'timeline', 'a category alone opens its first page');
  ok(nav.roomFromHash('#/recruitment/rooms/case-7/nope') === null && nav.roomFromHash('#/recruitment/rooms/case-7/deal/nope') === null && nav.roomFromHash('#/recruitment/rooms/case-7/history/offer') === null && nav.roomFromHash('#/recruitment/rooms/case-7/deal/offer/x') === null, 'unknown category, unknown sub, sub under the wrong category, and a third segment all reject');
  ok(nav.roomFromHash('#/recruitment/rooms/a/b') === null && nav.roomFromHash('#/recruitment/rooms/../x') === null, 'the M17 malformed-link cases still reject');
  ok(nav.screenFromHash(nav.hashForRoom('case-7', 'offer')) === 'rooms' && nav.screenFromHash(nav.hashForRoom('case-7', 'timeline')) === 'rooms', 'a category/sub deep link resolves to the Rooms destination');
}

// ------------------------------------------------------------------ Agent
{
  const app = 'scoutbox-agent';
  section(`${app} — client and transaction`);
  const m = await load(`${app}/src/caseNav.ts`);
  const nav = await load(`${app}/src/nav.ts`);
  for (const [name, model] of [['client', m.CLIENT_NAV], ['transaction', m.TRANSACTION_NAV]]) {
    models.push([app, name, model]);
    const problems = ds.validateCaseNav(model);
    for (const p of problems) console.error(`   ${p}`);
    ok(problems.length === 0, `${name}: the model is structurally sound`);
    ok(ds.widestCategory(model) <= MAX, `${name}: no category holds more than ${MAX} subcategories (widest: ${ds.widestCategory(model)})`);
  }
  ok(m.CLIENT_NAV.categories.map((c) => c.id).join(',') === 'overview,player,recruitment,transaction,history', 'client categories: Overview · Player · Recruitment · Transaction · History');
  ok(m.TRANSACTION_NAV.categories.map((c) => c.id).join(',') === 'workspace,records', 'transaction categories: Workspace · Records');
  for (const tab of SERVER_CLIENT_TABS) if (!ds.resolveTab(m.CLIENT_NAV, tab)) fail(`server client tab "${tab}" resolves to nothing`); else passed++;
  console.log('✓ the client tabs the server emits (contacts, offers) resolve (2 folded)');
  const OLD_CLIENT = ['overview', 'representation', 'opportunities', 'contacts', 'trials', 'offers', 'activity'];
  ok(OLD_CLIENT.every((id) => ds.resolveTab(m.CLIENT_NAV, id)), 'every pre-M24B client tab is still a subcategory');
  const OLD_TX = ['overview', 'parties', 'compliance', 'documents', 'messages', 'timeline'];
  ok(OLD_TX.every((id) => ds.resolveTab(m.TRANSACTION_NAV, id)), 'every pre-M24B transaction tab is still a subcategory');
  // Private functions are ABSENT from the agent's models, not hidden.
  const agentSubs = new Set([...ds.allSubs(m.CLIENT_NAV), ...ds.allSubs(m.TRANSACTION_NAV)]);
  for (const forbidden of ['assessments', 'decision', 'discussion', 'secondlook', 'evidence', 'passport', 'past-decisions', 'inbox']) if (agentSubs.has(forbidden)) fail(`the agent model carries a club-private subcategory: ${forbidden}`); else passed++;
  console.log('✓ no club-private page (assessment, decision, discussion, Second Look, evidence, Passport, Room inbox) exists in the agent model (8 folded)');
  ok(nav.clientFromHash('#/clients/rep-7')?.tab === 'summary' && nav.clientFromHash('#/clients/rep-7/overview')?.tab === 'summary', 'a bare or legacy client link opens Overview › Summary');
  ok(nav.clientFromHash('#/clients/rep-7/contacts')?.tab === 'contacts' && nav.clientFromHash('#/clients/rep-7/recruitment/contacts')?.tab === 'contacts', 'a contacts link resolves in its legacy and its category form');
  ok(nav.clientFromHash('#/clients/rep-7/offer') === null && nav.clientFromHash('#/clients/rep-7/transaction/nope') === null && nav.clientFromHash('#/clients/rep-7/history/offers') === null, 'an unknown client page, and a page under the wrong category, reject');
  ok(nav.hashForClient('rep-7') === '#/clients/rep-7' && nav.hashForClient('rep-7', 'offers') === '#/clients/rep-7/transaction/offers' && nav.clientFromHash(nav.hashForClient('rep-7', 'offers'))?.tab === 'offers', 'client links round-trip');
  ok(nav.transactionFromHash('#/transactions/atx-7/documents')?.tab === 'documents' && nav.transactionFromHash('#/transactions/atx-7/records/documents')?.tab === 'documents', 'a transaction documents link resolves in both forms');
  ok(nav.transactionFromHash('#/transactions/atx-7/offer') === null && nav.transactionFromHash('#/transactions/atx-7/signing') === null && nav.transactionFromHash('#/transactions/atx-7/fees') === null, 'offer, signing and fees are still not transaction pages');
  ok(nav.hashForTransaction('atx-7', 'timeline') === '#/transactions/atx-7/records/timeline' && nav.hashForTransaction('atx-7') === '#/transactions/atx-7', 'transaction links round-trip');
}

// ----------------------------------------------------------------- Player
{
  const app = 'scoutbox-player';
  section(`${app} — recruitment experience`);
  const m = await load(`${app}/src/caseNav.ts`);
  const model = m.PLAYER_NAV;
  models.push([app, 'player', model]);
  const problems = ds.validateCaseNav(model);
  for (const p of problems) console.error(`   ${p}`);
  ok(problems.length === 0, 'the model is structurally sound');
  ok(ds.widestCategory(model) <= MAX, `no category holds more than ${MAX} subcategories (widest: ${ds.widestCategory(model)})`);
  ok(model.categories.map((c) => c.id).join(',') === 'journey,contact,trial,offer,signing,board', 'categories: My journey · Club contact · Trial · Offer · Signing · Board');
  const subs = new Set(ds.allSubs(model));
  for (const forbidden of ['watchlist', 'priority', 'assessments', 'decision', 'discussion', 'secondlook', 'shortlist', 'notes', 'evidence']) if (subs.has(forbidden)) fail(`the player model carries a club-private page: ${forbidden}`); else passed++;
  console.log('✓ no club-private page (watchlist, priority, assessment, decision, discussion, Second Look, shortlist, notes, evidence) exists in the player model (9 folded)');
  ok(m.playerLocation('offer', 'offer-documents').sub === 'offer-documents' && m.playerLocation('offer', undefined).sub === 'offer-terms', '?cat=offer&tab= resolves, and a category alone opens its first page');
  ok(m.playerLocation('nope', 'nope').category === 'journey' && m.playerLocation(undefined, undefined).sub === 'overview', 'an unknown link falls back to My journey › Overview without throwing');
  ok(m.playerLocation(undefined, 'signing-contract').category === 'signing', 'a tab alone is found in its category');
  ok(m.playerCategoryFor('offer') === 'offer' && m.playerCategoryFor('signing') === 'signing' && m.playerCategoryFor('trial') === 'trial' && m.playerCategoryFor('inbox') === 'contact', 'a notification target maps to the category that holds its record');
}

// ---------------------------------------------------------------- the rule
section('the max-5 rule, every application');
const widest = models.map(([app, name, model]) => [app, name, ds.widestCategory(model)]);
for (const [app, name, w] of widest) console.log(`   ${app} ${name}: widest category ${w}`);
ok(widest.every(([, , w]) => w <= MAX), `NO recruitment category in any application contains more than ${MAX} subcategories (largest: ${Math.max(...widest.map((x) => x[2]))})`);

console.log(`\ncaseNav: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
process.exit(process.exitCode ?? 0);
