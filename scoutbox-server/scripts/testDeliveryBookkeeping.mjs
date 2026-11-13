// The delivery centre's bookkeeping (repositories/deliveryBookkeeping.mjs): callback ids remembered once (the oldest
// 1,000 go past 5,000), the centre's start, injected failures used up one at a time, units of work and fixtures.
// Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  DELIVERY_BOOKKEEPING_MIGRATION as MIGRATION,
  DELIVERY_BOOKKEEPING_TABLES as TABLES,
  DELIVERY_BOOKKEEPING_COLLECTIONS as COLLECTIONS,
  FAIL_INJECT_CHANNELS,
} from '../repositories/deliveryBookkeeping.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The tables are STRICT, have no JSON column, and start with `rows(table)` rows. */
function schemaChecks(tables, rows = () => 0) {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0037_grassroots') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('repo-schema');
  const s = openLayer(dir).sqlite;
  for (const t of tables) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, rows(t, s), `${t} rows`);
  }
  s.close();
  rm(dir);
}
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

/** Callback ids written the way the delivery route writes them: each marked seen. */
const WRITERS = {
  deliveryCallbacksSeen: (L, ids, { now }) => {
    for (const id of ids) L.deliveryBookkeeping.markSeen(id, now);
  },
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: WRITERS });
const seeded = (label) => {
  const dir = tempDir(label);
  write(dir, fixtureDb({ users: USERS(), orgs: ORGS() }));
  return { dir, s: serverOpen(dir) };
};

test("[schema] 0038 creates the STRICT delivery tables with only the centre's start and one empty injection row per channel", () => {
  schemaChecks(TABLES, (t) =>
    t === 'delivery_centre' ? 1 : t === 'delivery_fail_injections' ? FAIL_INJECT_CHANNELS.length : 0,
  );
  const dir = tempDir('dlv-schema');
  const s = openLayer(dir).sqlite;
  assert.equal(
    s.prepare('SELECT SUM(remaining) AS n FROM delivery_fail_injections').get().n,
    0,
    'no failure is injected',
  );
  s.close();
  rm(dir);
});

test('[delivery] callback ids are remembered once and pruned past 5,000; injected failures are used up one at a time', () => {
  const { dir, s } = seeded('dlv');
  const delivery = s.layer.deliveryBookkeeping;
  assert.ok(
    Number.isSafeInteger(delivery.centreSince()) && delivery.centreSince() <= Date.now(),
    'the centre started when the migration ran',
  );
  assert.equal(delivery.markSeen('cb-1', NOW), true);
  assert.equal(delivery.markSeen('cb-1', NOW), false, 'a duplicate');
  refused(() => delivery.markSeen('x'.repeat(201), NOW), /DELIVERY_INPUT_INVALID.*1 to 200 characters/);
  s.unit(() => {
    for (let i = 2; i <= 5001; i++) delivery.markSeen(`cb-${i}`, NOW);
  });
  assert.equal(delivery.seenCount(), 4001, 'the 5,001st id pruned the oldest 1,000');
  assert.equal(delivery.hasSeen('cb-1'), false);
  assert.equal(delivery.hasSeen('cb-1001'), true);
  assert.equal(delivery.consumeInjectedFailure('trial'), false, 'nothing injected');
  assert.equal(delivery.inject('trial', 2), 2);
  refused(() => delivery.inject('fax', 1), /DELIVERY_INPUT_INVALID/);
  assert.deepEqual(
    [
      delivery.consumeInjectedFailure('trial'),
      delivery.consumeInjectedFailure('trial'),
      delivery.consumeInjectedFailure('trial'),
    ],
    [true, true, false],
  );
  assert.equal(delivery.injected('trial'), 0);
  s.close();
  rm(dir);
});

test('[unit] a rolled-back unit leaves nothing, the reads cannot write', () => {
  const { dir, s } = seeded('dlv-unit');
  const delivery = s.layer.deliveryBookkeeping;
  assert.throws(
    () =>
      s.unit(() => {
        delivery.inject('email', 1);
        delivery.markSeen('cb-x', NOW);
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(delivery.reads.injected('email'), 0);
  assert.equal(delivery.reads.hasSeen('cb-x'), false);
  for (const w of ['markSeen', 'inject', 'consumeInjectedFailure'])
    assert.equal(typeof delivery.reads[w], 'undefined', `the reads cannot ${w}`);
  s.close();
  rm(dir);
});

test('[fixtures] callback ids written through the repository read back; a junk one is refused and leaves nothing', () => {
  const dir = tempDir('dlv-fix');
  write(dir, fixtureDb({ users: USERS(), orgs: ORGS(), deliveryCallbacksSeen: ['cb-a', 'cb-b'] }));
  assert.deepEqual(readRecords(dir).deliveryCallbacksSeen, ['cb-a', 'cb-b']);
  refused(() => write(dir, { deliveryCallbacksSeen: [7] }), /DELIVERY_INPUT_INVALID.*a callback id is 1 to/);
  assert.deepEqual(readRecords(dir).deliveryCallbacksSeen, ['cb-a', 'cb-b'], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} delivery bookkeeping checks passed`);
