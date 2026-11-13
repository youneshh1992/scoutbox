// The demo reputation rows (repositories/reputationSeed.mjs): imported only with a first installation's seed, never
// otherwise, and typed. Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  REPUTATION_SEED_MIGRATION as MIGRATION,
  REPUTATION_SEED_TABLES as TABLES,
  REPUTATION_SEED_COLLECTIONS as COLLECTIONS,
  typeReputation,
} from '../repositories/reputationSeed.mjs';

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

const row = (over = {}) => ({
  scoutName: 'Maria Keane',
  orgName: 'Eastport FC',
  discoveries: 14,
  successRatePct: 64,
  avgResaleMultiple: 3.1,
  seeded: true,
  ...over,
});

test('[schema] 0038 creates the STRICT reputation_seed table, empty, with no JSON column', () => schemaChecks(TABLES));

test('[typing] junk is refused naming the field', () => {
  const ok = typeReputation(row());
  assert.ok(ok.ok, ok.reason);
  const r = typeReputation(row({ successRatePct: 101, seeded: undefined }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /successRatePct/);
});

test("[reputation] the demo rows are imported once with a first installation's seed, and never otherwise", () => {
  const rows = [row()];
  const fresh = tempDir('rep-fresh');
  // A first installation's records are the `seed` (imported only while the database is new).
  const first = openLayer(fresh, {
    seed: { orgs: [], users: [], players: [], guardians: [], reputationSeed: rows },
    now: () => NOW,
    nextId,
  });
  assert.deepEqual(plain(first.layer.reputationSeed.all()), rows, 'a first installation imports its seed');
  first.close();
  const again = openLayer(fresh, {
    seed: { players: [], guardians: [], reputationSeed: [row({ scoutName: 'Someone Else' })] },
    now: () => NOW,
    nextId,
  });
  assert.deepEqual(plain(again.layer.reputationSeed.all()), rows, 'a later boot never imports from memory');
  again.close();
  rm(fresh);
  const dir = tempDir('rep-saved');
  writeFixture(dir, fixtureDb({ users: USERS(), orgs: ORGS() }), { now: NOW });
  const s = serverOpen(dir);
  assert.deepEqual(s.layer.reputationSeed.all(), [], 'a database written without demo rows has none');
  s.close();
  rm(dir);
});

test("[reputation] a first installation's junk or repeated row refuses the whole import", () => {
  const dir = tempDir('rep-junk');
  assert.throws(
    () =>
      openLayer(dir, {
        seed: { orgs: [], users: [], players: [], guardians: [], reputationSeed: [row(), row()] },
        now: () => NOW,
        nextId,
      }),
    /REPUTATION_IMPORT_BLOCKED.*duplicates an earlier entry/,
  );
  rm(dir);
});

test("[fixtures] a new database's fixture is its first installation: its rows read back", () => {
  const dir = tempDir('rep-fix');
  writeFixture(dir, fixtureDb({ users: USERS(), orgs: ORGS(), reputationSeed: [row()] }), { now: NOW });
  assert.deepEqual(plain(readRecords(dir).reputationSeed), [row()]);
  rm(dir);
});

console.log(`\n${passed} reputation seed checks passed`);
