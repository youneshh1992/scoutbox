// S13a — import batches, prospects, identity reviews, API keys, webhook endpoints and webhook deliveries as typed
// tables with explicit writes (repositories/integrations.mjs, migration 0034). What this suite proves: the migration
// creates the STRICT tables (no JSON column), empty; the typers refuse junk naming the record and field (an unknown
// scope or event, a mapping to a column the CSV lacks, a summary that does not count the rows, a payload that does not
// fit its event); a batch keeps its header, mapping, rows, messages and history as rows and reads back the literal the
// route wrote; a commit writes its prospects, reviews and history at once, and one live prospect per provider and
// external id holds (a reversal frees the identity); a review's record is its batch row's; a key is found by its hash
// only while live and records its use; a rotation keeps the old secret; a delivery's attempts are numbered rows and the
// due query finds only open ones; a rolled-back unit leaves nothing; the db.* names throw; and the snapshot write types,
// names a missing reference and reads back what it wrote. Temporary databases only; nothing touches DATA_DIR.
// Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  INTEGRATIONS_MIGRATION as MIGRATION, INTEGRATIONS_TABLES as TABLES, INTEGRATIONS_COLLECTIONS as COLLECTIONS,
  typeBatch, typeApiKey, typeEndpoint, typeDelivery, typeProspect,
} from '../repositories/integrations.mjs';

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
const HASH = 'a'.repeat(64);

// ------------------------------------------------------------- fixtures: the literals the routes write
const HEADER = ['name', 'dob', 'position', 'foot', 'heightCm', 'provider', 'externalId', 'notes'];
const rows = () => [
  { row: 2, record: { name: 'Jonas Weber', dob: '2003-05-10', position: 'CM', foot: 'right', heightCm: '180', provider: 'sp', externalId: 'SP-1', notes: '' }, errors: [], disposition: 'create', matchPlayerId: null },
  { row: 3, record: { name: 'Bad Row', dob: '20-13-99', position: 'GK', foot: 'right', heightCm: '180', provider: 'sp', externalId: 'SP-3', notes: 'x' }, errors: ['dob must be YYYY-MM-DD'], disposition: 'error', matchPlayerId: null },
  { row: 4, record: { name: 'Ada Adult', dob: '2000-01-01', position: 'ST', foot: 'left', heightCm: '', provider: 'sp', externalId: 'SP-9', notes: '' }, errors: [], disposition: 'ambiguous_identity', matchPlayerId: 'pl-adult' },
];
const summaryOf = (rs) => ({ total: rs.length, creatable: rs.filter((r) => r.disposition === 'create').length, errors: rs.filter((r) => r.disposition === 'error').length, duplicatesInFile: 0, alreadyImported: 0, linkedExisting: 0, ambiguous: rs.filter((r) => r.disposition === 'ambiguous_identity').length });
const batch = (over = {}) => {
  const rs = over.rows ?? rows();
  const summary = summaryOf(rs);
  return {
    id: 'imp-1', orgId: ORG.id, kind: 'prospects', createdBy: SCOUT.userId, createdByName: 'Maria', createdAt: NOW,
    header: [...HEADER], mapping: null, rows: rs, status: 'validated', summary, committedAt: null, reversedAt: null, createdProspectIds: [],
    history: [{ id: 'aud-1', at: NOW, byKind: 'org_user', byId: SCOUT.userId, byName: 'Maria', action: 'validated', detail: summary }],
    ...over,
  };
};
const prospect = (over = {}) => ({ id: 'prs-1', orgId: ORG.id, batchId: 'imp-1', name: 'Jonas Weber', dob: '2003-05-10', position: 'CM', foot: 'right', heightCm: 180, provider: 'sp', externalId: 'SP-1', notes: null, minor: false, createdAt: NOW, reversedAt: null, ...over });
const review = (over = {}) => ({ id: 'idr-1', orgId: ORG.id, batchId: 'imp-1', row: 4, candidatePlayerId: 'pl-adult', status: 'open', resolvedBy: null, resolvedAt: null, resolution: null, createdAt: NOW, ...over });
const apiKey = (over = {}) => ({ id: 'key-1', orgId: ORG.id, scopes: ['export:prospects'], keyHash: HASH, label: 'API key', createdBy: 'Maria', createdAt: NOW, revokedAt: null, lastUsedAt: null, ...over });
const endpoint = (over = {}) => ({ id: 'whk-1', orgId: ORG.id, url: 'https://hooks.example.test/x', events: ['import.committed'], secret: 'whsec_1', secretPrev: null, secretPrevValidUntil: null, active: true, createdBy: 'Maria', createdAt: NOW, ...over });
const delivery = (over = {}) => ({ id: 'dlv-1', endpointId: 'whk-1', orgId: ORG.id, eventId: 'evt_1', type: 'import.committed', data: { batchId: 'imp-1', created: 1 }, status: 'queued', attempts: [], nextAt: NOW, createdAt: NOW, deliveredAt: null, ...over });

const FIX = () => ({ users: [...USERS()], notifications: [], dispatches: [] });
function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.integrations, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); saveFixture(dir, FIX()); return { dir, s: serverOpen(dir) }; };
const by = { id: SCOUT.userId, name: 'Maria' };

// ------------------------------------------------------------- schema
test('[schema] 0034 is registered after 0033 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0033_insight_coverage') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13a-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.ok(typeBatch(batch()).ok);
  assert.match(typeBatch(batch({ mapping: { shoe: 'name' } })).reason, /importBatches imp-1\.mapping names a column the CSV does not have/);
  assert.match(typeBatch(batch({ mapping: { name: 'shoeSize' } })).reason, /mapping\.name must be one of/);
  assert.match(typeBatch(batch({ summary: { ...summaryOf(rows()), creatable: 5 } })).reason, /summary\.creatable must count the rows/);
  assert.match(typeBatch(batch({ rows: [{ ...rows()[1], errors: [] }] })).reason, /errors are listed exactly when the disposition is error/);
  assert.match(typeBatch(batch({ rows: [{ ...rows()[0], record: { name: 'x', shoe: '42' } }] })).reason, /record carries field\(s\) this build does not store: shoe/);
  assert.match(typeBatch(batch({ rows: [{ ...rows()[0], record: { name: 'x'.repeat(201) } }] })).reason, /record\.name must be text of at most 200/);
  assert.match(typeProspect(prospect({ dob: '2003-02-30' })).reason, /prospects prs-1\.dob must be a calendar day/);
  assert.match(typeProspect(prospect({ position: 'Winger' })).reason, /position must be one of/);
  assert.match(typeApiKey(apiKey({ scopes: ['export:everything'] })).reason, /apiKeys key-1\.scopes\[0\] must be one of/);
  assert.match(typeApiKey(apiKey({ scopes: [] })).reason, /scopes must list 1 to/);
  assert.match(typeApiKey(apiKey({ keyHash: 'plain-key' })).reason, /keyHash must be a sha-256 hex digest/);
  assert.match(typeEndpoint(endpoint({ events: ['import.committed', 'import.committed'] })).reason, /events names a value twice/);
  assert.match(typeDelivery(delivery({ data: { batchId: 'imp-1' } })).reason, /data\.created must be a count/);
  assert.match(typeDelivery(delivery({ data: { batchId: 'imp-1', created: 1, extra: true } })).reason, /data carries field\(s\) this build does not store: extra/);
  assert.match(typeDelivery(delivery({ attempts: [{ at: NOW, status: 200, error: 'x' }] })).reason, /status or error: exactly one is recorded/);
  assert.match(typeDelivery(delivery({ status: 'delivered' })).reason, /deliveredAt is set exactly when the delivery was delivered/);
});

// ------------------------------------------------------------- imports
test('[imports] a batch keeps header, mapping, rows, messages and history as rows and reads back what the route wrote', () => {
  const { dir, s } = seeded('s13a-batch');
  const b = batch({ mapping: { notes: null, heightCm: 'heightCm' } });
  const stored = s.repo.batches.create(b);
  assert.deepEqual(plain(stored), plain({ ...b, mapping: { heightCm: 'heightCm' } }), 'a null mapping entry is the default, kept as no entry');
  assert.deepEqual(stored.rows[2].record.heightCm, '', 'a mapped empty cell stays empty text');
  refused(() => s.repo.batches.create(batch({ id: 'imp-2', createdBy: 'usr-none' })), /createdBy names no staff member/);
  refused(() => s.repo.batches.create(batch()), /INTEGRATIONS_DUPLICATE/);
  const page = s.repo.reads.batches.page(ORG.id, { limit: 10 });
  assert.equal(page.items[0].rowCount, 3); assert.equal(page.items[0].rows, undefined); assert.equal(page.nextCursor, null);
  s.close(); rm(dir);
});

test('[imports] a commit writes prospects, reviews and history at once; one live prospect per identity; a reversal frees it', () => {
  const { dir, s } = seeded('s13a-commit');
  s.repo.batches.create(batch());
  const committed = s.repo.batches.commit('imp-1', { at: NOW + 1, by, prospects: [prospect()], reviews: [review()], historyId: 'aud-2' });
  assert.equal(committed.status, 'committed'); assert.deepEqual(committed.createdProspectIds, ['prs-1']);
  assert.deepEqual(committed.history.map((h) => [h.action, h.detail]), [['validated', summaryOf(rows())], ['committed', { created: 1 }]]);
  const r = s.repo.reads.reviews.openForOrg(ORG.id)[0];
  assert.deepEqual(plain(r.record), plain(rows()[2].record), 'the review\'s record is its batch row\'s');
  assert.ok(s.repo.reads.prospects.liveKeyTaken(ORG.id, 'sp', 'SP-1'));
  refused(() => s.repo.prospects.keepSeparate(prospect({ id: 'prs-2' })), /IMPORT_IDENTITY_TAKEN/);
  s.repo.batches.create(batch({ id: 'imp-2', history: [{ ...batch().history[0], id: 'aud-3' }] }));
  refused(() => s.repo.batches.commit('imp-2', { at: NOW, by, prospects: [prospect({ id: 'prs-3', batchId: 'imp-2' })], reviews: [], historyId: 'aud-4' }), /IMPORT_IDENTITY_TAKEN/);
  assert.equal(s.repo.reads.batches.byId('imp-2').status, 'validated', 'the refused commit wrote nothing');
  const { removed } = s.repo.batches.reverse('imp-1', { at: NOW + 2, by, historyId: 'aud-5' });
  assert.equal(removed, 1); assert.equal(s.repo.reads.prospects.liveKeyTaken(ORG.id, 'sp', 'SP-1'), false);
  s.repo.prospects.keepSeparate(prospect({ id: 'prs-2' }));
  assert.deepEqual(s.repo.reads.prospects.page(ORG.id, { limit: 10 }).items.map((p) => p.id), ['prs-2'], 'the reversed one is not listed');
  const resolved = s.repo.reviews.resolve('idr-1', { resolution: 'kept_separate', by: 'Maria', at: NOW + 3 });
  assert.equal(resolved.status, 'resolved'); refused(() => s.repo.reviews.resolve('idr-1', { resolution: 'linked', by: 'Maria', at: NOW }), /already resolved/);
  assert.ok(s.repo.reads.batches.hasCommitted(ORG.id) === false, 'a reversed batch is not a committed import');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- keys and webhooks
test('[keys] a key is found by its hash only while live, and records its use', () => {
  const { dir, s } = seeded('s13a-keys');
  s.repo.apiKeys.create(apiKey());
  assert.equal(s.repo.reads.apiKeys.liveByHash(HASH).id, 'key-1');
  s.repo.apiKeys.touch('key-1', NOW + 5); assert.equal(s.repo.reads.apiKeys.byId('key-1').lastUsedAt, NOW + 5);
  s.repo.apiKeys.revoke('key-1', NOW + 6); s.repo.apiKeys.revoke('key-1', NOW + 7);
  assert.equal(s.repo.reads.apiKeys.byId('key-1').revokedAt, NOW + 6, 'the first revocation stands');
  assert.equal(s.repo.reads.apiKeys.liveByHash(HASH), null);
  refused(() => s.repo.apiKeys.create(apiKey({ id: 'key-2' })), /UNIQUE|key_hash/);
  s.close(); rm(dir);
});

test('[webhooks] a rotation keeps the old secret; a delivery\'s attempts are numbered rows and only open ones are due', () => {
  const { dir, s } = seeded('s13a-webhooks');
  s.repo.endpoints.create(endpoint());
  assert.equal(s.repo.reads.endpoints.subscribed(ORG.id, 'import.committed').length, 1);
  assert.equal(s.repo.reads.endpoints.subscribed(ORG.id, 'identity.resolved').length, 0);
  const rotated = s.repo.endpoints.rotate('whk-1', { secret: 'whsec_2', prevValidUntil: NOW + 10 });
  assert.equal(rotated.secret, 'whsec_2'); assert.equal(rotated.secretPrev, 'whsec_1');
  s.repo.deliveries.create(delivery());
  s.repo.deliveries.recordAttempt('dlv-1', { at: NOW + 1, status: 500 }, { status: 'retrying', nextAt: NOW + 100 });
  assert.deepEqual(s.repo.reads.deliveries.due(NOW + 50).map((d) => d.id), [], 'not due before its time');
  assert.deepEqual(s.repo.reads.deliveries.due(NOW + 100).map((d) => d.id), ['dlv-1']);
  const done = s.repo.deliveries.recordAttempt('dlv-1', { at: NOW + 101, status: 204 }, { status: 'delivered', deliveredAt: NOW + 102 });
  assert.deepEqual(plain(done.attempts), [{ at: NOW + 1, status: 500 }, { at: NOW + 101, status: 204 }]);
  assert.deepEqual(plain(done.data), { batchId: 'imp-1', created: 1 }, 'the typed payload reads back as the event data');
  assert.equal(s.repo.reads.deliveries.backlogCount(), 0);
  s.repo.endpoints.deactivate('whk-1'); assert.equal(s.repo.reads.endpoints.subscribed(ORG.id, 'import.committed').length, 0);
  refused(() => s.repo.deliveries.create(delivery({ id: 'dlv-2', eventId: 'evt_2', endpointId: 'whk-none' })), /no endpoint whk-none/);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- units, retirement, snapshot
test('[unit] a rolled-back unit leaves nothing, and the db.* names throw naming the repository', () => {
  const { dir, s } = seeded('s13a-unit');
  assert.throws(() => s.unit(() => { s.repo.endpoints.create(endpoint()); s.repo.apiKeys.create(apiKey()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.endpoints.byId('whk-1'), null); assert.equal(s.repo.reads.apiKeys.byId('key-1'), null);
  assert.equal(typeof s.repo.reads.apiKeys.create, 'undefined', 'the reads cannot write');
  for (const n of COLLECTIONS) assert.throws(() => s.db[n], new RegExp(`db\\.${n} is gone: read it through the integrations repository`));
  s.close(); rm(dir);
});

test('[snapshot] the write types every record, names a missing reference, and reads back what it wrote', () => {
  const dir = tempDir('s13a-snapshot');
  const committed = batch({ status: 'committed', committedAt: NOW + 1, createdProspectIds: ['prs-1'], history: [...batch().history, { id: 'aud-2', at: NOW + 1, byKind: 'org_user', byId: SCOUT.userId, byName: 'Maria', action: 'committed', detail: { created: 1 } }] });
  const failing = delivery({ status: 'failed', attempts: [{ at: NOW, error: 'ECONNREFUSED' }, { at: NOW + 1, status: 500 }] });
  saveFixture(dir, { ...FIX(), importBatches: [committed], prospects: [prospect()], identityReviews: [review()], apiKeys: [apiKey()], webhookEndpoints: [endpoint()], webhookDeliveries: [failing] });
  const store = openStore(dir);
  const back = readTableBacked(store.sqlite);
  assert.deepEqual(plain(back.importBatches), [plain(committed)]);
  assert.deepEqual(plain(back.webhookDeliveries), [plain(failing)]);
  assert.deepEqual(plain(back.identityReviews[0].record), plain(rows()[2].record));
  const snap = store.load();
  refused(() => store.save({ ...snap, db: { ...snap.db, prospects: [prospect({ batchId: 'imp-none' })] } }), /INTEGRATIONS_REFERENCE_MISSING.*imp-none/);
  refused(() => store.save({ ...snap, db: { ...snap.db, identityReviews: [review({ row: 9 })] } }), /import_batch_rows imp-1#9/);
  refused(() => store.save({ ...snap, db: { ...snap.db, identityReviews: [{ ...review(), record: { name: 'Someone else' } }] } }), /carries a record that is not its batch row's/);
  refused(() => store.save({ ...snap, db: { ...snap.db, prospects: [prospect(), prospect({ id: 'prs-2' })] } }), /two live prospects name the same organisation, provider and external id/);
  refused(() => store.save({ ...snap, db: { ...snap.db, apiKeys: [apiKey({ scopes: ['admin'] })] } }), /INTEGRATIONS_IMPORT_BLOCKED.*scopes\[0\]/);
  assert.deepEqual(readTableBacked(store.sqlite).prospects.map((p) => p.id), ['prs-1'], 'a refused write changed nothing');
  store.sqlite.close(); rm(dir);
});

console.log(`\n${passed} integrations checks passed`);
