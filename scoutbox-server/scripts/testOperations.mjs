// S13e — the remaining operations collections as typed tables with explicit writes (repositories/operations.mjs,
// migration 0038). What this suite proves: the migration creates the STRICT tables (no JSON column) with the delivery
// centre's start and a zero count per failure channel, and nothing else; the typers refuse junk naming the record and
// field (an upload whose chunks do not add up, a checksum that is not hex, a finalised session without its media, an
// unknown or junk search filter, an invoice in a lower-case currency, a success rate over 100); an upload session
// records each chunk once, ends once (finalised with its media, aborted or abandoned by the sweep) and is deleted with
// its player; saved searches read the scout's name live, are deleted by their own club only, and the new-player
// candidates are prefiltered by position, foot, country and availability and skip removed staff; an invoice is one per
// signing, stored in minor units, and pages newest first; callback ids are remembered once and the oldest 1,000 go past
// 5,000; injected failures are added and used up one at a time; the demo reputation rows are imported once with a first
// installation's seed and never otherwise; a rolled-back unit leaves nothing; a fixture written through the repository
// is typed, names a missing reference and reads back what it wrote; and the plans the orgs table accepts are exactly the
// catalogue's. Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import { legacySigning } from './signingsFollowUpsTestFixtures.mjs';
import {
  OPERATIONS_MIGRATION as MIGRATION, OPERATIONS_TABLES as TABLES, OPERATIONS_COLLECTIONS as COLLECTIONS,
  typeUpload, typeSavedSearch, typeInvoice, typeReputation, FAIL_INJECT_CHANNELS,
} from '../repositories/operations.mjs';
import { readSearchFilters } from '../domains/discovery/savedSearches.mjs';
import { PLANS } from '../catalogue.mjs';
import { ORG_PLANS } from '../repositories/orgs.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const ORG = 'org-pro'; const OTHER = 'org-two';
const FIX = () => ({
  users: [...USERS(), { id: 'usr-2', orgId: ORG, name: 'Gone Scout', role: 'Scout', createdAt: 1, removedAt: 5, removedById: 'usr-1' }, { id: 'usr-o', orgId: OTHER, name: 'Other', role: 'Scout', createdAt: 1 }],
  orgs: [...ORGS(), { ...ORGS()[0], id: OTHER, name: 'Second FC' }],
  notifications: [], dispatches: [],
  signings: [legacySigning({ id: 'sign-a' }), legacySigning({ id: 'sign-b', playerId: 'pl-b' }), legacySigning({ id: 'sign-c', playerId: 'pl-c', orgId: OTHER, orgName: 'Second FC' })],
});
const MB = 1024 * 1024; const CHUNK = 512 * 1024;
const upload = (over = {}) => ({
  id: 'upl-1', playerId: 'pl-adult', size: MB, mime: 'video/mp4', title: 'Volley', sha256: null, chunkSize: CHUNK, totalChunks: 2,
  status: 'open', createdAt: NOW, finalisedMediaId: null, ...over,
});
const search = (over = {}) => ({ id: 'ss-1', orgId: ORG, userId: 'usr-1', name: 'Left wingers', filters: { position: 'LW', foot: 'left' }, createdAt: NOW, ...over });
const invoice = (over = {}) => ({
  id: 'inv-1', ts: NOW, orgId: ORG, orgName: 'Eastport FC', signingId: 'sign-a', playerName: 'Kid One', description: 'Success fee',
  amountMinor: 150_000, currency: 'EUR', status: 'issued', provider: 'dev-ledger', ...over,
});

/**
 * Records written the way the routes write them: a staff account is created, then removed; an upload session is
 * opened, then each chunk received, then finalised or aborted; a provider callback id is marked seen.
 */
const WRITERS = {
  uploadSessions: (L, records) => {
    for (const { received = [], status, finalisedMediaId = null, ...u } of records) {
      L.operations.uploads.open({ ...u, status: 'open', finalisedMediaId: null });
      for (const c of received) L.operations.uploads.receiveChunk(u.id, c);
      if (status === 'finalised') L.operations.uploads.finalise(u.id, finalisedMediaId);
      else if (status === 'aborted') L.operations.uploads.abort(u.id);
      else if (status !== 'open') throw new Error(`upload_sessions ${u.id}: a fixture cannot write a ${status} session`);
    }
  },
  deliveryCallbacksSeen: (L, ids, { now }) => { for (const id of ids) L.operations.delivery.markSeen(id, now); },
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: WRITERS });
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.operations, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); write(dir, fixtureDb(FIX())); return { dir, s: serverOpen(dir) }; };

// ------------------------------------------------------------- schema
test('[schema] 0038 is registered after 0037 and creates the STRICT tables (no JSON column), with only the delivery centre\'s rows', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0037_grassroots') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13e-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    const n = s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    assert.equal(n, t === 'delivery_centre' ? 1 : t === 'delivery_fail_injections' ? FAIL_INJECT_CHANNELS.length : 0, `${t} rows`);
  }
  assert.equal(s.prepare('SELECT SUM(remaining) AS n FROM delivery_fail_injections').get().n, 0, 'no failure is injected');
  for (const t of ['plans', 'archetypes', 'ops_settings']) assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), undefined, `${t} is not a table`);
  s.close(); rm(dir);
});

test('[schema] the plans an organisation can be on are exactly the catalogue\'s, and the orgs table\'s CHECK says the same', () => {
  assert.deepEqual([...ORG_PLANS].sort(), Object.keys(PLANS).sort());
  const dir = tempDir('s13e-plans'); const s = openLayer(dir).sqlite;
  const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orgs'").get().sql;
  const listed = /plan\s+TEXT NOT NULL CHECK \(plan IN \(([^)]*)\)\)/.exec(sql)[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(listed.sort(), Object.keys(PLANS).sort());
  assert.ok(Object.isFrozen(PLANS.Grassroots) && PLANS.Grassroots.attributionWindowMonths === 12, 'the catalogue is frozen');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  for (const ok of [typeUpload({ ...upload(), received: [1, 0] }), typeSavedSearch(search()), typeInvoice(invoice()), typeReputation({ scoutName: 'A', orgName: 'B', discoveries: 1, successRatePct: 50, avgResaleMultiple: 2.5, seeded: true })]) assert.ok(ok.ok, ok.reason);
  const cases = [
    [typeUpload({ ...upload({ totalChunks: 3 }), received: [] }), /upl-1\.totalChunks/],
    [typeUpload({ ...upload({ size: 1.5 }), received: [] }), /upl-1\.size must be an integer/],
    [typeUpload({ ...upload({ sha256: 'z'.repeat(64) }), received: [] }), /upl-1\.sha256/],
    [typeUpload({ ...upload({ status: 'finalised' }), received: [] }), /upl-1\.finalisedMediaId/],
    [typeUpload({ ...upload({ mime: 'application/pdf' }), received: [] }), /upl-1\.mime must be one of/],
    [typeUpload({ ...upload(), received: [2] }), /received\[0\]/],
    [typeSavedSearch(search({ filters: { position: 'Winger' } })), /ss-1\.filters\.position must be one of/],
    [typeSavedSearch(search({ filters: { colour: 'red' } })), /ss-1\.filters carries field\(s\) this build does not store: colour/],
    [typeSavedSearch(search({ filters: { newDays: 0 } })), /ss-1\.filters\.newDays/],
    [typeInvoice(invoice({ currency: 'eur' })), /inv-1\.currency/],
    [typeInvoice(invoice({ amountMinor: 1500.5 })), /inv-1\.amountMinor must be an integer/],
    [typeReputation({ scoutName: 'A', orgName: 'B', discoveries: 1, successRatePct: 101, avgResaleMultiple: 1 }), /successRatePct/],
  ];
  for (const [r, pattern] of cases) { assert.equal(r.ok, false, String(pattern)); assert.match(r.reason, pattern); }
});

test('[typing] the route\'s filter reading: empty, false and null mean no filter; junk names the field', () => {
  assert.deepEqual(readSearchFilters({ q: '  ', country: '', foot: null }), { filters: {} }, 'a blank search box is no filter');
  assert.deepEqual(readSearchFilters({ q: '', position: 'ST', academyPlus: false, country: null, ageGroup: 'u18', newDays: 7 }), { filters: { position: 'ST', ageGroup: 'u18', newDays: 7 } });
  assert.deepEqual(readSearchFilters(undefined), { filters: {} });
  assert.deepEqual(readSearchFilters({ ageGroup: 'u12' }), { field: 'filters.ageGroup' });
  assert.deepEqual(readSearchFilters({ sort: 'age' }), { field: 'filters.sort' });
  assert.deepEqual(readSearchFilters({ academyPlus: 'yes' }), { field: 'filters.academyPlus' });
  assert.deepEqual(readSearchFilters({ newDays: '7' }), { field: 'filters.newDays' });
  assert.deepEqual(readSearchFilters(['ST']), { field: 'filters' });
});

// ------------------------------------------------------------- uploads
test('[uploads] a session records each chunk once, ends once, is abandoned by the sweep and goes with its player', () => {
  const { dir, s } = seeded('s13e-upl');
  const { uploads } = s.repo;
  uploads.open(upload());
  uploads.receiveChunk('upl-1', 1); uploads.receiveChunk('upl-1', 0); uploads.receiveChunk('upl-1', 1);
  assert.deepEqual(plain(uploads.byId('upl-1').received), [1, 0], 'in arrival order, once each');
  refused(() => uploads.receiveChunk('upl-1', 2), /out of range/);
  assert.equal(uploads.forPlayerById('pl-other', 'upl-1'), null, 'another player never sees it');
  assert.equal(uploads.finalise('upl-1', 'media-1').status, 'finalised');
  refused(() => uploads.abort('upl-1'), /UPLOAD_NOT_OPEN/);
  refused(() => uploads.receiveChunk('upl-1', 0), /UPLOAD_NOT_OPEN/);
  uploads.open(upload({ id: 'upl-old', createdAt: NOW - 25 * 3600_000 }));
  uploads.open(upload({ id: 'upl-new', createdAt: NOW - 3600_000 }));
  assert.deepEqual(uploads.abandonOpenBefore(NOW - 24 * 3600_000), ['upl-old']);
  assert.equal(uploads.byId('upl-old').status, 'abandoned');
  assert.equal(uploads.byId('upl-new').status, 'open');
  uploads.open(upload({ id: 'upl-x', playerId: 'pl-other' }));
  assert.deepEqual(uploads.removeForPlayer('pl-adult').sort(), ['upl-1', 'upl-new', 'upl-old']);
  assert.equal(uploads.byId('upl-1'), null);
  assert.equal(s.store.sqlite.prepare('SELECT count(*) AS n FROM upload_session_chunks').get().n, 0, 'the chunk rows went with it');
  assert.equal(uploads.byId('upl-x').playerId, 'pl-other', 'another player\'s session stays');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- saved searches
test('[saved searches] the scout\'s name is live, a club deletes only its own, and new-player candidates are prefiltered', () => {
  const { dir, s } = seeded('s13e-ss');
  const { savedSearches: ss } = s.repo;
  const made = ss.create(search());
  assert.deepEqual(plain(made), { id: 'ss-1', orgId: ORG, userId: 'usr-1', scoutName: 'Maria', name: 'Left wingers', filters: { position: 'LW', foot: 'left' }, createdAt: NOW });
  ss.create(search({ id: 'ss-any', filters: {} }));
  ss.create(search({ id: 'ss-gb', filters: { country: 'GB', academyPlus: true } }));
  ss.create(search({ id: 'ss-gone', userId: 'usr-2', filters: {} }));
  ss.create(search({ id: 'ss-o', orgId: OTHER, userId: 'usr-o', filters: { availability: 'loan_open' } }));
  refused(() => ss.create(search({ id: 'ss-bad', userId: 'usr-none' })), /OPERATIONS_REFERENCE_MISSING.*usr-none/);
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(ss.forOrg(ORG)), ['ss-1', 'ss-any', 'ss-gb', 'ss-gone'], 'oldest first');
  assert.deepEqual(ids(ss.candidatesFor({ position: 'LW', foot: 'left', country: 'NG', availability: 'loan_open' })), ['ss-1', 'ss-any', 'ss-o'], 'removed staff are skipped');
  assert.deepEqual(ids(ss.candidatesFor({ position: 'ST', foot: 'left', country: 'GB', availability: 'available_now' })), ['ss-any', 'ss-gb']);
  assert.deepEqual(ids(ss.candidatesFor({})), ['ss-any'], 'a player with no fields can only match an open search');
  assert.equal(ss.remove(OTHER, 'ss-1'), false, 'another club cannot delete it');
  assert.equal(ss.remove(ORG, 'ss-1'), true);
  assert.equal(ss.byId('ss-1'), null);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- invoices
test('[invoices] one per signing, in minor units, paged newest first', () => {
  const { dir, s } = seeded('s13e-inv');
  const { invoices } = s.repo;
  invoices.issue(invoice());
  refused(() => invoices.issue(invoice({ id: 'inv-2' })), /INVOICE_EXISTS.*sign-a/);
  refused(() => invoices.issue(invoice({ id: 'inv-3', signingId: 'sign-none' })), /OPERATIONS_REFERENCE_MISSING.*sign-none/);
  invoices.issue(invoice({ id: 'inv-2', signingId: 'sign-b', amountMinor: 50_000 }));
  invoices.issue(invoice({ id: 'inv-o', signingId: 'sign-c', orgId: OTHER }));
  assert.equal(invoices.forSigning('sign-a').amountMinor, 150_000);
  const first = invoices.pageForOrg(ORG, { limit: 1 });
  assert.deepEqual(first.items.map((i) => i.id), ['inv-2']);
  const after = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  const second = invoices.pageForOrg(ORG, { limit: 1, after });
  assert.deepEqual([second.items.map((i) => i.id), second.nextCursor], [['inv-1'], null]);
  assert.deepEqual(invoices.page({ limit: 10 }).items.map((i) => i.id), ['inv-o', 'inv-2', 'inv-1']);
  assert.equal(invoices.count(), 3);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- delivery bookkeeping
test('[delivery] callback ids are remembered once and pruned past 5,000; injected failures are used up one at a time', () => {
  const { dir, s } = seeded('s13e-dlv');
  const { delivery } = s.repo;
  assert.ok(Number.isSafeInteger(delivery.centreSince()) && delivery.centreSince() <= Date.now(), 'the centre started when the migration ran');
  assert.equal(delivery.markSeen('cb-1', NOW), true);
  assert.equal(delivery.markSeen('cb-1', NOW), false, 'a duplicate');
  refused(() => delivery.markSeen('x'.repeat(201), NOW), /1 to 200 characters/);
  s.unit(() => { for (let i = 2; i <= 5001; i++) delivery.markSeen(`cb-${i}`, NOW); });
  assert.equal(delivery.seenCount(), 4001, 'the 5,001st id pruned the oldest 1,000');
  assert.equal(delivery.hasSeen('cb-1'), false); assert.equal(delivery.hasSeen('cb-1001'), true);
  assert.equal(delivery.consumeInjectedFailure('trial'), false, 'nothing injected');
  assert.equal(delivery.inject('trial', 2), 2);
  refused(() => delivery.inject('fax', 1), /OPERATIONS_INPUT_INVALID/);
  assert.deepEqual([delivery.consumeInjectedFailure('trial'), delivery.consumeInjectedFailure('trial'), delivery.consumeInjectedFailure('trial')], [true, true, false]);
  assert.equal(delivery.injected('trial'), 0);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- reputation seed
test('[reputation] the demo rows are imported once with a first installation\'s seed, and never otherwise', () => {
  const rows = [{ scoutName: 'Maria Keane', orgName: 'Eastport FC', discoveries: 14, successRatePct: 64, avgResaleMultiple: 3.1, seeded: true }];
  const fresh = tempDir('s13e-rep-fresh');
  // A first installation's records are the `seed` (imported only while the database is new).
  const first = openLayer(fresh, { seed: { orgs: [], users: [], players: [], guardians: [], reputationSeed: rows }, now: () => NOW, nextId });
  assert.deepEqual(plain(first.layer.operations.reputationSeed.all()), rows, 'a first installation imports its seed');
  first.close();
  const again = openLayer(fresh, { seed: { players: [], guardians: [], reputationSeed: [{ ...rows[0], scoutName: 'Someone Else' }] }, now: () => NOW, nextId });
  assert.deepEqual(plain(again.layer.operations.reputationSeed.all()), rows, 'a later boot never imports from memory');
  again.close(); rm(fresh);
  const { dir, s } = seeded('s13e-rep-saved');
  assert.deepEqual(s.repo.reputationSeed.all(), [], 'a database written without demo rows has none');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- units
test('[unit] a rolled-back unit leaves nothing, the reads cannot write', () => {
  const { dir, s } = seeded('s13e-unit');
  assert.throws(() => s.unit(() => { s.repo.savedSearches.create(search()); s.repo.invoices.issue(invoice()); s.repo.delivery.inject('email', 1); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.savedSearches.byId('ss-1'), null);
  assert.equal(s.repo.reads.invoices.count(), 0);
  assert.equal(s.repo.reads.delivery.injected('email'), 0);
  for (const [ns, w] of [['uploads', 'open'], ['uploads', 'removeForPlayer'], ['savedSearches', 'create'], ['invoices', 'issue'], ['delivery', 'markSeen'], ['delivery', 'consumeInjectedFailure']]) {
    assert.equal(typeof s.repo.reads[ns][w], 'undefined', `the reads cannot ${ns}.${w}`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- fixtures
test('[fixtures] a record written through the repository is typed, a missing reference is named, a refused write leaves nothing, and the records read back as written', () => {
  const dir = tempDir('s13e-fix');
  const up = { ...upload({ status: 'finalised', finalisedMediaId: 'media-1' }), received: [0, 1] };
  const rep = { scoutName: 'A', orgName: 'B', discoveries: 1, successRatePct: 50, avgResaleMultiple: 2.5, seeded: true };
  write(dir, fixtureDb({ ...FIX(), uploadSessions: [up], savedSearches: [search()], invoices: [invoice()], reputationSeed: [rep], deliveryCallbacksSeen: ['cb-a', 'cb-b'] }));
  const back = readRecords(dir);
  assert.deepEqual(plain(back.uploadSessions), [plain(up)]);
  assert.deepEqual(plain(back.savedSearches), [{ ...search(), scoutName: 'Maria' }]);
  assert.deepEqual(plain(back.invoices), [invoice()]);
  assert.deepEqual(plain(back.reputationSeed), [rep], 'a new database\'s fixture is its first installation');
  assert.deepEqual(back.deliveryCallbacksSeen, ['cb-a', 'cb-b']);
  refused(() => write(dir, { invoices: [invoice({ id: 'inv-2', signingId: 'sign-none' })] }), /OPERATIONS_REFERENCE_MISSING.*sign-none/);
  refused(() => write(dir, { invoices: [{ ...invoice({ id: 'inv-3', signingId: 'sign-b' }), amount: 1500 }] }), /OPERATIONS_INPUT_INVALID.*does not store: amount/);
  refused(() => write(dir, { deliveryCallbacksSeen: [7] }), /OPERATIONS_INPUT_INVALID.*a callback id is 1 to/);
  const after = readRecords(dir);
  assert.deepEqual([plain(after.invoices), after.deliveryCallbacksSeen], [[invoice()], ['cb-a', 'cb-b']], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} operations checks passed`);
