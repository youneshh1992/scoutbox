// Import batches, prospects, identity reviews, API keys, webhook endpoints and webhook deliveries
// (repositories/integrations.mjs, migration 0034): the STRICT tables, the typers' refusals, a batch and its commit,
// one live prospect per provider and external id (a reversal frees the identity), a key found by its hash only while
// live, a rotation keeping the old secret, numbered delivery attempts, units of work and fixtures. Temporary databases
// only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
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
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.integrations, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); saveFixture(dir, FIX()); return { dir, s: serverOpen(dir) }; };
const by = { id: SCOUT.userId, name: 'Maria' };

// ------------------------------------------------------------- schema
test('[schema] 0034 is registered after 0033 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0033_insight_coverage') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s13a-empty'); const s = openLayer(dir).sqlite;
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

// ------------------------------------------------------------- units, retirement, fixtures
test('[unit] a rolled-back unit leaves nothing', () => {
  const { dir, s } = seeded('s13a-unit');
  assert.throws(() => s.unit(() => { s.repo.endpoints.create(endpoint()); s.repo.apiKeys.create(apiKey()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.endpoints.byId('whk-1'), null); assert.equal(s.repo.reads.apiKeys.byId('key-1'), null);
  assert.equal(typeof s.repo.reads.apiKeys.create, 'undefined', 'the reads cannot write');
  s.close(); rm(dir);
});

/**
 * Records written the way the routes write them: a batch is validated, then committed with the prospects it lists and
 * its open identity reviews (then reversed); a review is resolved after; any other prospect is one kept separate; a
 * delivery is queued, then each attempt recorded, the last with where the delivery ended. The batch's prospects and
 * reviews travel with its commit, so the writers are built from the whole fixture.
 */
const writersFor = (fix) => {
  const by = (h) => ({ id: h.byId, name: h.byName });
  return {
    importBatches: (L, records) => {
      for (const b of records) {
        const [validated, ...later] = b.history;
        L.integrations.batches.create({ ...b, status: 'validated', committedAt: null, reversedAt: null, createdProspectIds: [], history: [validated] });
        const committed = later.find((h) => h.action === 'committed');
        if (committed) {
          const reviews = (fix.identityReviews ?? []).filter((r) => r.batchId === b.id).map(({ record, ...r }) => ({ ...r, status: 'open', resolvedBy: null, resolvedAt: null, resolution: null }));
          L.integrations.batches.commit(b.id, { at: b.committedAt, by: by(committed), historyId: committed.id, prospects: (fix.prospects ?? []).filter((p) => b.createdProspectIds.includes(p.id)), reviews });
        }
        const reversed = later.find((h) => h.action === 'reversed');
        if (reversed) L.integrations.batches.reverse(b.id, { at: b.reversedAt, by: by(reversed), historyId: reversed.id });
      }
    },
    prospects: (L, records) => { for (const p of records) if (!L.integrations.prospects.byId(p.id)) L.integrations.prospects.keepSeparate(p); },
    identityReviews: (L, records) => {
      for (const r of records) {
        if (!L.integrations.reviews.byId(r.id)) throw new Error(`identity_reviews ${r.id}: a review is written by its batch's commit (batch ${r.batchId})`);
        if (r.status === 'resolved') L.integrations.reviews.resolve(r.id, { resolution: r.resolution, by: r.resolvedBy, at: r.resolvedAt });
      }
    },
    webhookDeliveries: (L, records) => {
      for (const { attempts = [], status, nextAt, deliveredAt = null, ...d } of records) {
        L.integrations.deliveries.create({ ...d, status: 'queued', attempts: [], nextAt: d.createdAt, deliveredAt: null });
        attempts.forEach((a, i) => L.integrations.deliveries.recordAttempt(d.id, a, i === attempts.length - 1 ? { status, nextAt, deliveredAt } : { status: 'retrying' }));
      }
    },
  };
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: writersFor(records) });
test('[fixtures] a record written through the repository is typed, a missing reference is named, a refused write leaves nothing, and the records read back as written', () => {
  const dir = tempDir('s13a-fix');
  const committed = batch({ status: 'committed', committedAt: NOW + 1, createdProspectIds: ['prs-1'], history: [...batch().history, { id: 'aud-2', at: NOW + 1, byKind: 'org_user', byId: SCOUT.userId, byName: 'Maria', action: 'committed', detail: { created: 1 } }] });
  const failing = delivery({ status: 'failed', attempts: [{ at: NOW, error: 'ECONNREFUSED' }, { at: NOW + 1, status: 500 }] });
  write(dir, fixtureDb({ ...FIX(), importBatches: [committed], prospects: [prospect()], identityReviews: [review()], apiKeys: [apiKey()], webhookEndpoints: [endpoint()], webhookDeliveries: [failing] }));
  const back = readRecords(dir);
  assert.deepEqual(plain(back.importBatches), [plain(committed)]);
  assert.deepEqual(plain(back.webhookDeliveries), [plain(failing)]);
  assert.deepEqual(plain(back.identityReviews[0].record), plain(rows()[2].record), 'a review\'s record is its batch row\'s');
  refused(() => write(dir, { prospects: [prospect({ id: 'prs-2', batchId: 'imp-none' })] }), /INTEGRATIONS_REFERENCE_MISSING.*imp-none/);
  const second = batch({ id: 'imp-2', status: 'committed', committedAt: NOW + 2, history: [{ ...batch().history[0], id: 'aud-3' }, { id: 'aud-4', at: NOW + 2, byKind: 'org_user', byId: SCOUT.userId, byName: 'Maria', action: 'committed', detail: { created: 0 } }] });
  refused(() => write(dir, { importBatches: [second], identityReviews: [review({ id: 'idr-2', batchId: 'imp-2', row: 9 })] }), /INTEGRATIONS_INPUT_INVALID.*idr-2: names no ambiguous row of the batch/);
  refused(() => write(dir, { prospects: [prospect({ id: 'prs-2' })] }), /IMPORT_IDENTITY_TAKEN.*sp SP-1 is already a live prospect/);
  refused(() => write(dir, { apiKeys: [apiKey({ id: 'key-2', scopes: ['admin'] })] }), /INTEGRATIONS_INPUT_INVALID.*scopes\[0\]/);
  const after = readRecords(dir);
  assert.deepEqual([after.importBatches.map((b) => b.id), after.prospects.map((p) => p.id), after.identityReviews.map((r) => r.id), after.apiKeys.map((k) => k.id)], [['imp-1'], ['prs-1'], ['idr-1'], ['key-1']], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} integrations checks passed`);
