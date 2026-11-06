// The store's unit of work: the transaction foundation S4a needs. An explicit
// unit of work makes repository row writes and facet changes commit or roll
// back TOGETHER, and a failure restores the database AND memory (the
// participants' records, held references, repository views) to their
// pre-operation state. Since S14a there is no blob and no store memento: each
// participant restores itself (the memento module keeps its direct tests).
// Retrying means re-running the whole operation; a later ordinary save never
// completes a fragment of a failed one. Ordinary saves keep their S3 contract
// (a failed save leaves facet changes pending and the next save retries them).
// Everything runs on throwaway databases with synthetic fixtures. Run with: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';
import { captureGraph, restoreGraph } from '../repositories/memento.mjs';
import { readonlyView } from '../repositories/readonly.mjs';
import { hasBlobTable } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TTL = 30 * 86_400_000;
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const ORGS = () => [
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', location: { lat: 51.889, lng: 1.02, city: 'Eastport' }, plan: 'Pro', trustedPartner: true, country: 'GB', verified: true, verifiedDomain: 'eastportfc.example', safeguardingContractSigned: true, agencyNotes: null, memos: [] },
  { id: 'org-grass', name: 'Riverside Juniors', type: 'club', level: 'grassroots', location: { lat: 51.5, lng: -0.1, city: 'London' }, plan: 'Grassroots', trustedPartner: false, country: 'GB', verified: false, safeguardingContractSigned: false, memos: [], tags: ['ST'] },
  { id: 'org-agency', name: 'Northstar Agency', type: 'agency', level: null, plan: 'Pro', trustedPartner: false, country: 'FR', verified: false, agencyNotes: { licence: 'FIFA-1' } },
];
// Since S4a the players and guardians are table-backed too: the fixture player is a valid record (the identity repositories validate it at the first boot's import).
// The first installation's records (S14a: handed in as the seed; staff are written through their repository).
const fixtureSeed = () => ({ orgs: ORGS(), guardians: [], players: [{ id: 'pl-1', name: 'P', dob: '2000-01-01', country: 'GB', medical: { shared: false, records: [], conditionStatus: 'unknown' } }] });

/** A first installation with the fixture seeded and one staff member; returns everything a test needs. */
function boot(dir, seed = fixtureSeed()) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const layer = attachDataLayer({ db, seed, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  layer.users.insert({ orgId: 'org-pro', name: 'Maria', role: 'Head of Recruitment' });
  store.save();
  const raw = (sql, ...p) => store.sqlite.prepare(sql).get(...p);
  return { store, layer, db, raw, unit: (fn) => store.unitOfWork(fn) };
}
/** Count the BEGINs the store issues while `fn` runs: one per transaction. */
function begins(t, fn) {
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let n = 0;
  t.store.sqlite.exec = (sql) => { if (/^BEGIN/.test(sql)) n += 1; return exec(sql); };
  try { fn(); } finally { t.store.sqlite.exec = exec; }
  return n;
}
/** The multi-collection operation under test: a row insert, a row update, a facet change on a held record, a session row. */
function operation(t, { failLate = false, afterCommit = null } = {}) {
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  let token = null;
  const result = t.unit(() => {
    t.layer.orgs.insert({ id: 'org-new', name: 'New FC', type: 'club', plan: 'Pro' });
    t.layer.orgs.update('org-pro', { suspended: true });
    pro.memos.push({ id: 'sq-op', name: 'Op', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
    token = t.layer.sessions.create('player', 'pl-1').token;
    if (afterCommit) t.store.afterCommit(afterCommit);
    // Rewritten in S14a: the failure used to be an unserialisable blob; now the work fails after every write.
    if (failLate) throw new Error('late failure after the writes');
    return 'done';
  });
  return { result, token };
}
/** The pre-operation state the database must show after a failure (nothing of the operation), and memory must show (operation undone, unrelated edits kept). */
function assertDatabaseUntouched(t, { unrelatedSaved }) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").n, 0, 'no inserted row');
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0, 'no updated column');
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 0, 'no flushed facet');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player'").n, 0, 'no session row');
  const grass = JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-grass'").facets_json);
  assert.deepEqual(grass.tags, unrelatedSaved ? ['GK'] : ['ST']);
  assert.equal(hasBlobTable(t.store.sqlite), false, 'rewritten in S14a: there is no blob table');
}
function assertMemoryRestored(t, refs) {
  const { pro, grass } = refs;
  assert.equal(t.db.orgs.find((o) => o.id === 'org-pro'), pro, 'the same record object');
  assert.equal(pro.suspended, undefined, 'the column write is undone on the held record');
  assert.equal(pro.memos.length, 0, 'the facet push is undone in place');
  assert.equal(t.layer.orgs.byId('org-new'), null); assert.equal(t.db.orgs.length, 3); assert.equal(t.layer.orgs.count(), 3);
  // Unrelated edits made BEFORE the operation are still in memory and still pending.
  assert.deepEqual(grass.tags, ['GK']);
  assert.equal(t.layer.orgs.uncommitted(), 1, 'the pre-operation facet change is still eligible for the next save');
}
function assertOperationPersisted(t, token) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").n, 1);
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1);
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 1);
  assert.ok(t.layer.sessions.byToken(token), 'the session minted inside the unit is live');
  assert.deepEqual(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-grass'").facets_json).tags, ['GK']);
  assert.equal(t.layer.orgs.uncommitted(), 0);
}
const prepare = (t) => {
  const pro = t.db.orgs.find((o) => o.id === 'org-pro'); const grass = t.db.orgs.find((o) => o.id === 'org-grass');
  grass.tags = ['GK']; // an unrelated edit, pending before the operation (players are a repository view since S4a)
  return { pro, grass };
};

// ------------------------------------------------------------- the memento itself
await test('memento: every reachable object and array is restored in place, by identity — added keys removed, removed keys back, nested arrays truncated, views and frozen leaves untouched', () => {
  const inner = { n: 1, list: [1, 2] };
  const view = readonlyView({ v: 1 }, 'x');
  const frozen = Object.freeze({ f: 1 });
  const root = { a: 1, inner, arr: [inner, { k: 'v' }], view, frozen };
  const arr = root.arr; const second = arr[1];
  const m = captureGraph([root]);
  root.a = 2; root.added = true; delete root.inner; inner.n = 9; inner.list.push(3); arr.push({ extra: true }); arr.splice(0, 1); second.k = 'changed'; second.more = 1;
  restoreGraph(m);
  assert.equal(root.a, 1); assert.equal('added' in root, false); assert.equal(root.inner, inner); assert.equal(inner.n, 1); assert.deepEqual(inner.list, [1, 2]);
  assert.equal(root.arr, arr); assert.equal(arr.length, 2); assert.equal(arr[0], inner); assert.equal(arr[1], second); assert.equal(second.k, 'v'); assert.equal('more' in second, false);
  assert.equal(root.view, view); assert.equal(root.frozen, frozen); assert.equal(m.has(view), false, 'views are not walked'); assert.equal(m.has(frozen), false);
});

// ------------------------------------------------------------- success
await test('unit of work: a row insert, a row update, a facet change and a session commit together in one transaction; after-commit callbacks run once, after COMMIT', () => {
  const dir = tempDir('uow-ok'); const t = boot(dir);
  const refs = prepare(t);
  const calls = [];
  let outcome = null;
  // Rewritten in S14a: this counted the store's save revision, which is gone; the BEGINs are counted instead.
  assert.equal(begins(t, () => { outcome = operation(t, { afterCommit: () => calls.push(t.store.sqlite.isTransaction) }); }), 1, 'one transaction for the whole unit');
  const { result, token } = outcome;
  assert.equal(result, 'done'); assert.equal(t.store.sqlite.isTransaction, false);
  assertOperationPersisted(t, token);
  assert.deepEqual(calls, [false], 'the callback ran once, outside the transaction');
  assert.equal(refs.pro.suspended, true);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- failure after the writes
await test('unit of work: a failure after the row writes and the facet mutation rolls the database back AND restores memory (held records, nested arrays, views); unrelated pending edits survive; an ordinary save persists no fragment; an explicit retry persists everything', () => {
  const dir = tempDir('uow-fail'); const t = boot(dir);
  const refs = prepare(t);
  let err = null;
  try { operation(t, { failLate: true }); } catch (e) { err = e; }
  assert.match(err.message, /late failure/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.store.sqlite.isTransaction, false);
  assertDatabaseUntouched(t, { unrelatedSaved: false });
  assertMemoryRestored(t, refs);
  // No after-commit callback fired (none registered reached commit); no success event.
  // An ORDINARY save now: the unrelated edits land, nothing of the failed operation does.
  t.store.save();
  assertDatabaseUntouched(t, { unrelatedSaved: true });
  assert.equal(t.layer.orgs.uncommitted(), 0);
  // Explicit retry of the WHOLE operation.
  const { token } = operation(t);
  assertOperationPersisted(t, token);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- failure at COMMIT
await test('unit of work: a failure at COMMIT takes the same path — database untouched, memory restored, unrelated edits kept, retry lands everything', () => {
  const dir = tempDir('uow-commit'); const t = boot(dir);
  const refs = prepare(t);
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let explode = true;
  t.store.sqlite.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('disk full at commit'); } return exec(sql); };
  let err = null;
  try { operation(t); } catch (e) { err = e; }
  assert.match(err.message, /disk full at commit/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.store.sqlite.isTransaction, false);
  assertDatabaseUntouched(t, { unrelatedSaved: false });
  assertMemoryRestored(t, refs);
  const { token } = operation(t);
  assertOperationPersisted(t, token);
  t.store.sqlite.exec = exec; t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- crash before commit
await test('unit of work: a process killed before COMMIT leaves the pre-operation database — a restart sees no row and no facet change of the operation', () => {
  const dir = tempDir('uow-crash'); const t = boot(dir);
  t.store.sqlite.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'unitOfWorkCrashChild.mjs'), dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, 'SIGKILL', `the child must die by SIGKILL: status ${r.status} signal ${r.signal} ${r.stderr.slice(-300)}`);
  assert.match(r.stdout, /ABOUT_TO_CRASH/);
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = {};
  const layer2 = attachDataLayer({ db: db2, store: again, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.equal(layer2.orgs.byId('org-crash'), null); assert.equal(db2.orgs.length, 3);
  assert.equal(db2.orgs.find((o) => o.id === 'org-pro').memos.length, 0);
  assert.ok(!db2.orgs.find((o) => o.id === 'org-pro').suspended);
  assert.equal(again.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- the two contracts, side by side
await test('ordinary saves keep the S3 contract: a facet change in a FAILED ordinary save stays pending and the next ordinary save persists it (no explicit retry needed)', () => {
  const dir = tempDir('uow-s3'); const t = boot(dir);
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  pro.memos.push({ id: 'sq-1', name: 'A', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
  // Rewritten in S14a: the save used to fail on an unserialisable blob; now its COMMIT fails once.
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let explode = true;
  t.store.sqlite.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('disk full at commit'); } return exec(sql); };
  assert.throws(() => t.store.save(), /disk full at commit/);
  t.store.sqlite.exec = exec;
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 0);
  assert.equal(pro.memos.length, 1, 'an ordinary save failure does NOT undo memory: memory is the intended state, retried by the next save');
  assert.equal(t.layer.orgs.uncommitted(), 1);
  t.store.save();
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 1);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- nesting, saves inside, async, participants
await test('unit of work: a nested unit joins the enclosing one (an inner failure rolls everything back); a save() inside a unit is absorbed into its commit; asynchronous work is refused and rolled back; a unit cannot start inside a foreign transaction', () => {
  const dir = tempDir('uow-nest'); const t = boot(dir);
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  // Nested join: the inner failure undoes the outer insert too.
  let err = null;
  try {
    t.unit(() => {
      t.layer.orgs.insert({ id: 'org-outer', name: 'Outer', type: 'club', plan: 'Pro' });
      t.unit(() => { pro.memos.push({ id: 'sq-inner', name: 'I', position: 'ST', playerId: null, source: 'manual', addedAt: 1 }); throw new Error('inner failed'); });
    });
  } catch (e) { err = e; }
  assert.match(err.message, /inner failed/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.layer.orgs.byId('org-outer'), null); assert.equal(pro.memos.length, 0);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-outer'").n, 0);
  // save() inside a unit does not open a second transaction; the facet it would flush lands with the unit.
  // (Rewritten in S14a: the save revision and the absorbed blob are gone; the BEGINs are counted instead.)
  assert.equal(begins(t, () => t.unit(() => { pro.memos.push({ id: 'sq-abs', name: 'A', position: 'ST', playerId: null, source: 'manual', addedAt: 1 }); t.store.save(); t.layer.orgs.insert({ id: 'org-abs', name: 'Abs', type: 'club', plan: 'Pro' }); })), 1, 'exactly one transaction');
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 1); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-abs'").n, 1);
  // Asynchronous work: a SQLite transaction must never span an await.
  err = null;
  try { t.unit(async () => { t.layer.orgs.insert({ id: 'org-async', name: 'Async', type: 'club', plan: 'Pro' }); }); } catch (e) { err = e; }
  assert.match(err.message, /synchronous/); assert.equal(t.layer.orgs.byId('org-async'), null); assert.equal(t.store.sqlite.isTransaction, false);
  // A foreign open transaction refuses the unit before anything happens.
  t.store.sqlite.exec('BEGIN');
  assert.throws(() => t.unit(() => {}), /inside an open transaction/);
  t.store.sqlite.exec('ROLLBACK');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('unit of work: participants — organisations and sessions take part; staff (org_users) writes are refused inside a unit because their bookkeeping is not integrated, and nothing of the attempt persists', () => {
  const dir = tempDir('uow-parts'); const t = boot(dir);
  let err = null;
  try { t.unit(() => { t.layer.orgs.insert({ id: 'org-x', name: 'X', type: 'club', plan: 'Pro' }); t.layer.users.insert({ orgId: 'org-pro', name: 'New Staff', role: 'Scout' }); }); } catch (e) { err = e; }
  assert.match(err.message, /org_users .*unit of work|not integrated/);
  assert.equal(t.layer.orgs.byId('org-x'), null); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-x'").n, 0);
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM org_users').n, 1); assert.equal(t.db.users.length, 1);
  // Outside a unit, staff writes work as before (their own autocommit).
  t.layer.users.insert({ orgId: 'org-pro', name: 'Later Staff', role: 'Scout' });
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM org_users').n, 2);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('unit of work: an after-commit callback that fails does not undo the commit; it is counted and reported, never treated as a rollback; callbacks registered outside a unit run at once', () => {
  const dir = tempDir('uow-after'); const t = boot(dir);
  let err = null;
  try { operation(t, { afterCommit: () => { throw new Error('push gateway down'); } }); } catch (e) { err = e; }
  assert.equal(err, null, 'a delivery failure after COMMIT is not an error of the operation');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").n, 1, 'committed');
  const state = t.store.unitOfWorkState();
  assert.equal(state.afterCommitFailures, 1); assert.match(state.lastAfterCommitError.message, /push gateway down/);
  let ran = false; t.store.afterCommit(() => { ran = true; }); assert.equal(ran, true, 'outside a unit the callback runs immediately');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('unit of work: snapshot mode refuses it (a tool writes whole snapshots, it does not run operations)', () => {
  const dir = tempDir('uow-snap');
  const tool = openStore(dir);
  assert.throws(() => tool.unitOfWork(() => {}), /server mode/);
  tool.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('unit of work: capturing the memento of a synthetic snapshot is bounded in time', () => {
  const players = Array.from({ length: 1000 }, (_, i) => ({ id: `pl-${i}`, name: `P${i}`, media: [{ id: `m-${i}`, tags: { pace: 1 } }], attendance: [{ id: `a-${i}`, gps: { lat: 1, lng: 2 } }], stats: { goals: i } }));
  const db = { players, notes: Array.from({ length: 2000 }, (_, i) => ({ id: `v-${i}`, history: ['a', 'b'] })) };
  const t0 = performance.now(); const m = captureGraph([db]); const captured = performance.now() - t0;
  const t1 = performance.now(); restoreGraph(m); const restored = performance.now() - t1;
  console.log(`    (memento of 1,000 players + 2,000 notes: capture ${captured.toFixed(1)} ms, restore ${restored.toFixed(1)} ms, ${m.size} objects)`);
  assert.ok(captured < 2000 && restored < 2000);
});

// ------------------------------------------------------------- review corrections (independent review of the first foundation commit)
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Collect unhandled rejections while `fn` runs (plus two turns of the event loop), so an unobserved promise is a test failure rather than a process crash. */
async function withUnhandled(fn) {
  const seen = [];
  const listener = (e) => seen.push(String(e?.message ?? e));
  process.on('unhandledRejection', listener);
  try { await fn(); await tick(); await tick(); } finally { process.off('unhandledRejection', listener); }
  return seen;
}

await test('a failure at BEGIN leaves no unit open — the work never runs, no transaction is left behind, ordinary saves and later units work; a failing cleanup step (a participant whose restore throws) is reported and still clears the unit', () => {
  const dir = tempDir('uow-begin'); const t = boot(dir);
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let failBegin = true; let invoked = 0;
  t.store.sqlite.exec = (sql) => { if (sql === 'BEGIN IMMEDIATE' && failBegin) { failBegin = false; throw new Error('injected BEGIN failure'); } return exec(sql); };
  assert.throws(() => t.unit(() => { invoked += 1; }), /injected BEGIN failure/);
  assert.equal(invoked, 0, 'the work must not run when the transaction could not start');
  assert.equal(t.store.inUnitOfWork(), false, 'no fictitious unit remains active');
  assert.equal(t.store.unit.active(), false); assert.equal(t.store.sqlite.isTransaction, false);
  const grass = t.db.orgs.find((o) => o.id === 'org-grass');
  grass.tags = ['ordinary edit'];
  t.store.save();
  assert.deepEqual(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-grass'").facets_json).tags, ['ordinary edit'], 'a later ordinary save is a real save, not absorbed by a phantom unit');
  t.unit(() => { t.layer.orgs.insert({ id: 'org-after-begin', name: 'After', type: 'club', plan: 'Pro' }); });
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-after-begin'").n, 1, 'a later unit works');
  t.store.sqlite.exec = exec;
  // Cleanup errors: a participant whose restoreState throws must not leave the flag stuck or the transaction open.
  let restoreCalls = 0;
  t.store.setSaveHook({ flush() {}, snapshotState: () => 'state', restoreState() { restoreCalls += 1; throw new Error('restore exploded'); } });
  let err = null;
  try { t.unit(() => { t.layer.orgs.update('org-grass', { suspended: true }); grass.tags = ['doomed']; throw new Error('operation failed'); }); } catch (e) { err = e; }
  assert.match(err.message, /operation failed/, 'the caller sees the operation failure');
  assert.equal(err.unitOfWork, 'rolled_back'); assert.equal(restoreCalls, 1);
  assert.ok(Array.isArray(err.unitOfWorkCleanup) && /restore exploded/.test(err.unitOfWorkCleanup.join(' ')), 'the cleanup failure is attached to the error');
  assert.equal(t.store.inUnitOfWork(), false, 'the unit is closed even though cleanup failed');
  assert.equal(t.store.sqlite.isTransaction, false);
  // Rewritten in S14a: the store memento restored a blob here; now the organisations participant (registered before the failing one) restores itself.
  assert.deepEqual(grass.tags, ['ordinary edit']); assert.ok(!t.layer.orgs.byId('org-grass').suspended, 'the earlier participant still restored its record');
  assert.ok(t.store.unitOfWorkState().restoreFailures >= 1);
  t.store.save();
  assert.deepEqual(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-grass'").facets_json).tags, ['ordinary edit']);
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-grass'").suspended, 0);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('a nested (joined) unit that fails poisons the whole unit even when its caller catches the error — nothing commits, nothing is published, memory is restored, a later ordinary save persists no fragment', () => {
  const dir = tempDir('uow-swallow'); const t = boot(dir);
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  let events = 0; let outer = null; let innerSeen = null; let continued = false;
  try {
    t.unit(() => {
      t.layer.orgs.update('org-pro', { suspended: true });
      try {
        t.unit(() => {
          t.layer.orgs.insert({ id: 'org-inner', name: 'Inner', type: 'club', plan: 'Pro' });
          pro.memos.push({ id: 'sq-inner', name: 'I', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
          t.store.afterCommit(() => { events += 1; });
          throw new Error('inner failure');
        });
      } catch (e) { innerSeen = e.message; }
      continued = true; // the caller carried on after swallowing the inner error
      t.store.afterCommit(() => { events += 1; });
    });
  } catch (e) { outer = e; }
  assert.equal(innerSeen, 'inner failure'); assert.equal(continued, true);
  assert.ok(outer, 'the outer unit must fail: a joined unit failed inside it');
  assert.match(outer.message, /cannot commit|joined|nested/i); assert.match(String(outer.cause?.message), /inner failure/);
  assert.equal(outer.unitOfWork, 'rolled_back');
  assert.equal(t.store.sqlite.isTransaction, false); assert.equal(t.store.inUnitOfWork(), false);
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0, 'the outer row write did not commit');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-inner'").n, 0);
  assert.equal(events, 0, 'no after-commit callback of a failed unit runs');
  assert.equal(t.db.orgs.find((o) => o.id === 'org-pro').suspended, undefined); assert.equal(t.layer.orgs.byId('org-inner'), null); assert.equal(pro.memos.length, 0);
  t.store.save();
  assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 0); assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0);
  // The same operation, retried without the failure, commits whole.
  t.unit(() => { t.layer.orgs.update('org-pro', { suspended: true }); t.unit(() => { t.layer.orgs.insert({ id: 'org-inner', name: 'Inner', type: 'club', plan: 'Pro' }); }); t.store.afterCommit(() => { events += 1; }); });
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-inner'").n, 1); assert.equal(events, 1);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('a facet value written by a row update inside a unit and then changed back before COMMIT is overwritten in the database — view and table agree after commit, after rollback, after an ordinary save and after a restart', () => {
  const dir = tempDir('uow-revert'); const t = boot(dir);
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  const memos = (id = 'org-pro') => JSON.parse(t.raw('SELECT facets_json FROM orgs WHERE id = ?', id).facets_json).memos.length;
  // Commit: the intermediate value (one member) is written by the row update; the final value (none) must win.
  t.unit(() => {
    pro.memos.push({ id: 'sq-temp', name: 'T', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
    t.layer.orgs.update('org-pro', { name: 'Eastport FC (renamed)' });
    pro.memos = [];
  });
  assert.equal(pro.memos.length, 0); assert.equal(memos(), 0, 'the table holds the final value, not the intermediate one');
  assert.equal(t.raw("SELECT name FROM orgs WHERE id = 'org-pro'").name, 'Eastport FC (renamed)'); assert.equal(t.layer.orgs.uncommitted(), 0);
  // The mirror image: a third value after the update is written too.
  t.unit(() => { pro.memos.push({ id: 'sq-a', name: 'A', position: 'ST', playerId: null, source: 'manual', addedAt: 1 }); t.layer.orgs.update('org-pro', { suspended: true }); pro.memos.push({ id: 'sq-b', name: 'B', position: 'GK', playerId: null, source: 'manual', addedAt: 2 }); });
  assert.equal(memos(), 2); assert.equal(pro.memos.length, 2);
  // Rollback: the same shape, then a failure — the database keeps the committed value and memory is restored.
  assert.throws(() => t.unit(() => { pro.memos.push({ id: 'sq-x', name: 'X', position: 'ST', playerId: null, source: 'manual', addedAt: 3 }); t.layer.orgs.update('org-pro', { suspended: false }); pro.memos = []; throw new Error('late failure'); }), /late failure/);
  assert.equal(memos(), 2); assert.equal(pro.memos.length, 2); assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1); assert.equal(t.layer.orgs.uncommitted(), 0);
  // Ordinary save: a facet changed back to its committed value after an uncommitted change is simply not written; one changed away from it is.
  pro.memos.push({ id: 'sq-c', name: 'C', position: 'ST', playerId: null, source: 'manual', addedAt: 4 }); pro.memos.pop();
  assert.equal(t.layer.orgs.uncommitted(), 0); t.store.save(); assert.equal(memos(), 2);
  pro.memos = []; t.store.save(); assert.equal(memos(), 0);
  // Restart: the table is what the next boot sees.
  t.store.sqlite.close();
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = {};
  attachDataLayer({ db: db2, store: again, nextId, persist: () => {}, sessionTtlMs: TTL });
  const pro2 = db2.orgs.find((o) => o.id === 'org-pro');
  assert.equal(pro2.name, 'Eastport FC (renamed)'); assert.equal(pro2.memos.length, 0); assert.equal(pro2.suspended, true);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('an async function is refused BEFORE it is invoked (top-level and nested), so nothing of it ever runs; an unexpected thenable from a plain function is rolled back, its rejection is observed and counted, and the fact that its continuation is NOT cancelled is recorded, not hidden', async () => {
  const dir = tempDir('uow-async'); const t = boot(dir);
  const pro = t.db.orgs.find((o) => o.id === 'org-pro');
  let invoked = 0;
  const unhandled = await withUnhandled(async () => {
    // Top-level async work: refused before invocation.
    let err = null;
    try { t.unit(async () => { invoked += 1; await tick(); t.layer.orgs.update('org-pro', { suspended: true }); }); } catch (e) { err = e; }
    assert.match(err.message, /async function|synchronous/); assert.equal(invoked, 0, 'an identifiable async function never runs');
    assert.equal(t.store.inUnitOfWork(), false); assert.equal(t.store.sqlite.isTransaction, false);
    // Nested async work: refused before invocation, and the enclosing unit cannot commit.
    err = null;
    try { t.unit(() => { t.layer.orgs.insert({ id: 'org-outer2', name: 'O', type: 'club', plan: 'Pro' }); try { t.unit(async () => { invoked += 1; }); } catch { /* swallowed */ } }); } catch (e) { err = e; }
    assert.ok(err && err.unitOfWork === 'rolled_back'); assert.equal(invoked, 0); assert.equal(t.layer.orgs.byId('org-outer2'), null);
    await tick(); await tick();
    t.store.save();
    assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0);
    assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-outer2'").n, 0);
    // An UNEXPECTED thenable: a plain function that returns a promise cannot be told apart before it runs.
    // Its synchronous part ran inside the unit and is rolled back; the unit refuses; the promise is observed
    // (its rejection is counted, never unhandled). What its continuation does later happens OUTSIDE any unit —
    // the store cannot cancel it and does not claim to; it counts the escape so the operator can see it.
    let continuation = 0;
    err = null;
    try {
      t.unit(() => {
        pro.memos.push({ id: 'sq-sync', name: 'S', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
        return (async () => { await tick(); continuation += 1; throw new Error('continuation rejected'); })();
      });
    } catch (e) { err = e; }
    assert.match(err.message, /synchronous|thenable|promise/); assert.equal(err.unitOfWork, 'rolled_back');
    assert.equal(pro.memos.length, 0, 'the synchronous part of the work is rolled back');
    assert.equal(JSON.parse(t.raw("SELECT facets_json FROM orgs WHERE id = 'org-pro'").facets_json).memos.length, 0);
    await tick(); await tick();
    assert.equal(continuation, 1, 'the continuation still ran: refusing the promise does not cancel the work (documented limitation)');
    const stray = t.store.unitOfWorkState().strayAsyncWork;
    assert.equal(stray.escaped, 1); assert.equal(stray.rejected, 1); assert.match(stray.lastError.message, /continuation rejected/);
    // A resolving thenable is observed the same way (counted as escaped, not as a failure).
    try { t.unit(() => Promise.resolve('late')); } catch { /* refused */ }
    await tick();
    assert.equal(t.store.unitOfWorkState().strayAsyncWork.escaped, 2); assert.equal(t.store.unitOfWorkState().strayAsyncWork.rejected, 1);
  });
  assert.deepEqual(unhandled, [], 'no unhandled rejection escapes the store');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('after-commit side effects that return a promise are observed — an asynchronous failure is counted and logged (never an unhandled rejection, never a rollback), a success is not, and later callbacks still run; the same holds outside a unit', async () => {
  const dir = tempDir('uow-async-after'); const t = boot(dir);
  const order = [];
  const unhandled = await withUnhandled(async () => {
    t.unit(() => {
      t.layer.orgs.update('org-pro', { suspended: true });
      t.store.afterCommit(async () => { await tick(); order.push('async-fail'); throw new Error('async delivery failed'); });
      t.store.afterCommit(() => { order.push('sync-fail'); throw new Error('sync delivery failed'); });
      t.store.afterCommit(async () => { await tick(); order.push('async-ok'); return 'delivered'; });
      t.store.afterCommit(() => { order.push('sync-ok'); });
    });
    assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1, 'committed regardless of delivery');
    assert.deepEqual(order, ['sync-fail', 'sync-ok'], 'every synchronous callback ran, in order, despite the failure');
    await tick(); await tick(); await tick();
    assert.deepEqual([...order].sort(), ['async-fail', 'async-ok', 'sync-fail', 'sync-ok']);
    const state = t.store.unitOfWorkState();
    assert.equal(state.afterCommitFailures, 2, 'one synchronous and one asynchronous failure counted');
    assert.equal(state.afterCommitDelivered, 2, 'two deliveries succeeded');
    assert.match(state.lastAfterCommitError.message, /async delivery failed/);
    // Outside a unit: the callback runs now; a returned promise is observed the same way.
    t.store.afterCommit(async () => { await tick(); throw new Error('immediate async failure'); });
    await tick(); await tick();
    assert.equal(t.store.unitOfWorkState().afterCommitFailures, 3);
    assert.doesNotThrow(() => t.store.afterCommit(() => { throw new Error('immediate sync failure'); }), 'a side effect never fails the operation that registered it');
    assert.equal(t.store.unitOfWorkState().afterCommitFailures, 4);
  });
  assert.deepEqual(unhandled, [], 'no unhandled rejection escapes the store');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('participant API: store.unit.join runs an operation inside the open unit through the poisoning boundary — a throw rethrows unchanged and poisons the unit even when caught, an asynchronous shape is refused before it runs, a result is returned, and it is refused outside a unit (no BEGIN of its own)', () => {
  const dir = tempDir('uow-join'); const t = boot(dir);
  assert.throws(() => t.store.unit.join(() => 1), /needs an open unit of work/);
  assert.throws(() => t.store.unit.join('nope'), /synchronous work function/);
  assert.equal(t.store.sqlite.isTransaction, false, 'a refused join opened nothing');
  // Inside a unit: a thrown operation poisons the unit although the caller catches it.
  const boom = new Error('statement failed after a write');
  let caught = null; let outer = null; let published = 0; let result = null; let begins = 0;
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  t.store.sqlite.exec = (sql) => { if (sql === 'BEGIN IMMEDIATE') begins += 1; return exec(sql); };
  try {
    t.unit(() => {
      result = t.store.unit.join(() => { t.layer.orgs.update('org-pro', { suspended: true }); return 'joined'; });
      try { t.store.unit.join(() => { t.layer.orgs.insert({ id: 'org-half', name: 'Half', type: 'club', plan: 'Pro' }); throw boom; }); } catch (e) { caught = e; }
      t.store.afterCommit(() => { published += 1; });
    });
  } catch (e) { outer = e; }
  t.store.sqlite.exec = exec;
  assert.equal(result, 'joined'); assert.equal(caught, boom, 'the error is rethrown unchanged');
  assert.ok(outer && /cannot commit/.test(outer.message) && outer.cause === boom, 'the unit fails at its end with the joined failure as cause');
  assert.equal(outer.unitOfWork, 'rolled_back'); assert.equal(published, 0); assert.equal(begins, 1, 'join opens no transaction of its own');
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0); assert.equal(t.layer.orgs.byId('org-half'), null); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-half'").n, 0); assert.ok(!t.layer.orgs.byId('org-pro').suspended, 'the joined row update is restored in memory too');
  assert.equal(t.store.unit.active(), false); assert.equal(t.store.sqlite.isTransaction, false);
  // An asynchronous operation is refused before it is invoked, and that refusal poisons the unit too.
  let invoked = 0; let refusal = null; outer = null;
  try { t.unit(() => { try { t.store.unit.join(async () => { invoked += 1; }); } catch (e) { refusal = e; } }); } catch (e) { outer = e; }
  assert.match(String(refusal?.message), /must be synchronous/); assert.equal(invoked, 0); assert.ok(outer && /cannot commit/.test(outer.message));
  // A clean join commits with the unit.
  t.unit(() => { t.store.unit.join(() => t.layer.orgs.update('org-pro', { suspended: true })); });
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('cost (migration.md §4.3.1): a player write — standalone, inside a unit of work with an organisation update, and the ordinary save after it — runs exactly as many SQL statements with 2,000 players as with 20, and a rolled-back unit still restores the record it touched', () => {
  // Every statement the process runs is counted: StatementSync run / get / all / iterate and DatabaseSync exec.
  const counted = { on: false, n: 0 };
  const restore = [];
  for (const [proto, names] of [[StatementSync.prototype, ['run', 'get', 'all', 'iterate']], [DatabaseSync.prototype, ['exec']]]) {
    for (const name of names) {
      const original = proto[name];
      proto[name] = function counting(...args) { if (counted.on) counted.n += 1; return original.apply(this, args); };
      restore.push(() => { proto[name] = original; });
    }
  }
  try {
    const statementsFor = (n) => {
      const dir = tempDir(`cost-${n}`);
      const seed = { ...fixtureSeed(), players: Array.from({ length: n }, (_, i) => ({ id: `pl-${i}`, name: `Player ${i}`, dob: '2000-01-01', country: 'GB', city: 'Start', trialReports: [] })) }; // the seed's shape: a trialReports list, derived from the trials
      const t = boot(dir, seed);
      const players = t.layer.players;
      counted.n = 0; counted.on = true;
      players.update('pl-7', { city: 'Standalone' });
      t.unit(() => { players.update('pl-7', { city: 'In a unit' }); t.layer.orgs.update('org-pro', { suspended: true }); }); // (S14a: the blob edit that stood here is gone)
      t.store.save();
      counted.on = false;
      const statements = counted.n;
      // A unit that fails after the write: the held record is restored in place, the row is unchanged.
      const held = players.byId('pl-7');
      assert.throws(() => t.unit(() => { players.update('pl-7', { city: 'Rolled back' }); throw new Error('late'); }), /late/);
      assert.equal(held.city, 'In a unit'); assert.equal(players.byId('pl-7'), held); assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-7'").city, 'In a unit');
      assert.equal(players.byId(`pl-${n - 1}`).city, 'Start', 'an untouched player is unchanged');
      t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
      return statements;
    };
    const small = statementsFor(20); const large = statementsFor(2000);
    assert.ok(small > 0, 'the counter saw the statements');
    assert.equal(large, small, `a write's statements do not grow with the player count (20 players: ${small}, 2,000 players: ${large})`);
  } finally {
    for (const undo of restore) undo();
  }
});

console.log(`\n${passed} unit-of-work checks passed`);
