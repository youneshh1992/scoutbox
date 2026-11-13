// Saved searches (repositories/savedSearches.mjs): the scout's name read live, a club deletes only its own, new-player
// candidates prefiltered in SQL, the route's filter reading, typing, units of work and fixtures. Temporary databases
// only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  SAVED_SEARCHES_MIGRATION as MIGRATION,
  SAVED_SEARCHES_TABLES as TABLES,
  SAVED_SEARCHES_COLLECTIONS as COLLECTIONS,
  typeSavedSearch,
} from '../repositories/savedSearches.mjs';
import { readSearchFilters } from '../domains/discovery/savedSearches.mjs';

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

const ORG = 'org-pro';
const OTHER = 'org-two';
const FIX = () => ({
  users: [
    ...USERS(),
    { id: 'usr-2', orgId: ORG, name: 'Gone Scout', role: 'Scout', createdAt: 1, removedAt: 5, removedById: 'usr-1' },
    { id: 'usr-o', orgId: OTHER, name: 'Other', role: 'Scout', createdAt: 1 },
  ],
  orgs: [...ORGS(), { ...ORGS()[0], id: OTHER, name: 'Second FC' }],
});
const search = (over = {}) => ({
  id: 'ss-1',
  orgId: ORG,
  userId: 'usr-1',
  name: 'Left wingers',
  filters: { position: 'LW', foot: 'left' },
  createdAt: NOW,
  ...over,
});
const write = (dir, records) => writeFixture(dir, records, { now: NOW });
const seeded = (label) => {
  const dir = tempDir(label);
  write(dir, fixtureDb(FIX()));
  return { dir, s: serverOpen(dir) };
};

test('[schema] 0038 creates the STRICT saved_searches table, empty, with no JSON column', () => schemaChecks(TABLES));

test('[typing] junk is refused naming the record and field', () => {
  const ok = typeSavedSearch(search());
  assert.ok(ok.ok, ok.reason);
  for (const [r, pattern] of [
    [typeSavedSearch(search({ filters: { position: 'Winger' } })), /ss-1\.filters\.position must be one of/],
    [
      typeSavedSearch(search({ filters: { colour: 'red' } })),
      /ss-1\.filters carries field\(s\) this build does not store: colour/,
    ],
    [typeSavedSearch(search({ filters: { newDays: 0 } })), /ss-1\.filters\.newDays/],
  ]) {
    assert.equal(r.ok, false, String(pattern));
    assert.match(r.reason, pattern);
  }
});

test("[typing] the route's filter reading: empty, false and null mean no filter; junk names the field", () => {
  assert.deepEqual(
    readSearchFilters({ q: '  ', country: '', foot: null }),
    { filters: {} },
    'a blank search box is no filter',
  );
  assert.deepEqual(
    readSearchFilters({ q: '', position: 'ST', academyPlus: false, country: null, ageGroup: 'u18', newDays: 7 }),
    { filters: { position: 'ST', ageGroup: 'u18', newDays: 7 } },
  );
  assert.deepEqual(readSearchFilters(undefined), { filters: {} });
  assert.deepEqual(readSearchFilters({ ageGroup: 'u12' }), { field: 'filters.ageGroup' });
  assert.deepEqual(readSearchFilters({ sort: 'age' }), { field: 'filters.sort' });
  assert.deepEqual(readSearchFilters({ academyPlus: 'yes' }), { field: 'filters.academyPlus' });
  assert.deepEqual(readSearchFilters({ newDays: '7' }), { field: 'filters.newDays' });
  assert.deepEqual(readSearchFilters(['ST']), { field: 'filters' });
});

test("[saved searches] the scout's name is live, a club deletes only its own, and new-player candidates are prefiltered", () => {
  const { dir, s } = seeded('ss');
  const ss = s.layer.savedSearches;
  const made = ss.create(search());
  assert.deepEqual(plain(made), {
    id: 'ss-1',
    orgId: ORG,
    userId: 'usr-1',
    scoutName: 'Maria',
    name: 'Left wingers',
    filters: { position: 'LW', foot: 'left' },
    createdAt: NOW,
  });
  ss.create(search({ id: 'ss-any', filters: {} }));
  ss.create(search({ id: 'ss-gb', filters: { country: 'GB', academyPlus: true } }));
  ss.create(search({ id: 'ss-gone', userId: 'usr-2', filters: {} }));
  ss.create(search({ id: 'ss-o', orgId: OTHER, userId: 'usr-o', filters: { availability: 'loan_open' } }));
  refused(() => ss.create(search({ id: 'ss-bad', userId: 'usr-none' })), /SAVED_SEARCH_REFERENCE_MISSING.*usr-none/);
  refused(() => ss.create(search()), /SAVED_SEARCH_DUPLICATE/);
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(ss.forOrg(ORG)), ['ss-1', 'ss-any', 'ss-gb', 'ss-gone'], 'oldest first');
  assert.deepEqual(
    ids(ss.candidatesFor({ position: 'LW', foot: 'left', country: 'NG', availability: 'loan_open' })),
    ['ss-1', 'ss-any', 'ss-o'],
    'removed staff are skipped',
  );
  assert.deepEqual(
    ids(ss.candidatesFor({ position: 'ST', foot: 'left', country: 'GB', availability: 'available_now' })),
    ['ss-any', 'ss-gb'],
  );
  assert.deepEqual(ids(ss.candidatesFor({})), ['ss-any'], 'a player with no fields can only match an open search');
  assert.equal(ss.remove(OTHER, 'ss-1'), false, 'another club cannot delete it');
  assert.equal(ss.remove(ORG, 'ss-1'), true);
  assert.equal(ss.byId('ss-1'), null);
  s.close();
  rm(dir);
});

test('[unit] a rolled-back unit leaves nothing, the reads cannot write', () => {
  const { dir, s } = seeded('ss-unit');
  assert.throws(
    () =>
      s.unit(() => {
        s.layer.savedSearches.create(search());
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(s.layer.savedSearches.reads.byId('ss-1'), null);
  for (const w of ['create', 'remove'])
    assert.equal(typeof s.layer.savedSearches.reads[w], 'undefined', `the reads cannot ${w}`);
  s.close();
  rm(dir);
});

test('[fixtures] a search written through the repository reads back with the live scout name; a missing reference is named and leaves nothing', () => {
  const dir = tempDir('ss-fix');
  write(dir, fixtureDb({ ...FIX(), savedSearches: [search()] }));
  assert.deepEqual(plain(readRecords(dir).savedSearches), [{ ...search(), scoutName: 'Maria' }]);
  refused(
    () => write(dir, { savedSearches: [search({ id: 'ss-2', orgId: 'org-none' })] }),
    /SAVED_SEARCH_REFERENCE_MISSING.*org-none/,
  );
  assert.deepEqual(
    readRecords(dir).savedSearches.map((x) => x.id),
    ['ss-1'],
    'a refused write changed nothing',
  );
  rm(dir);
});

console.log(`\n${passed} saved search checks passed`);
