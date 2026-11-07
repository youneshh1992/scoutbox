// The store's unit of work: the transaction foundation S4a needs. An explicit
// unit of work makes repository row writes commit or roll back TOGETHER, and a
// failure restores the database AND memory (the staged participants' records,
// held references, repository views) to their pre-operation state. Since S14a
// there is no blob and no store memento: each participant restores itself (the
// memento module keeps its direct tests). Since S14g the organisations are
// explicit (no mirror), so the players (still staged) are the participant whose
// held records are checked. Retrying means re-running the whole operation; a
// later ordinary save never completes a fragment of a failed one.
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
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', location: { lat: 51.889, lng: 1.02, city: 'Eastport' }, plan: 'Pro', trustedPartner: true, country: 'GB', verified: true, verifiedDomain: 'eastportfc.example', safeguardingContractSigned: true },
  { id: 'org-grass', name: 'Riverside Juniors', type: 'club', level: 'grassroots', location: { lat: 51.5, lng: -0.1, city: 'London' }, plan: 'Grassroots', trustedPartner: false, country: 'GB', verified: false, safeguardingContractSigned: false },
  { id: 'org-agency', name: 'Northstar Agency', type: 'agency', level: null, plan: 'Pro', trustedPartner: false, country: 'FR', verified: false },
];
// Since S4a the players and guardians are table-backed too: the fixture player is a valid record (the identity repositories validate it at the first boot's import).
// The first installation's records (S14a: handed in as the seed; staff are written through their repository).
const fixtureSeed = () => ({ orgs: ORGS(), guardians: [], players: [{ id: 'pl-1', name: 'P', dob: '2000-01-01', country: 'GB', city: 'Start', medical: { shared: false, records: [], conditionStatus: 'unknown' } }] });

/** A first installation with the fixture seeded and one staff member; returns everything a test needs. */
function boot(dir, seed = fixtureSeed()) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const layer = attachDataLayer({ db, seed, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  layer.users.create({ orgId: 'org-pro', name: 'Maria', role: 'Head of Recruitment' });
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
/** The multi-collection operation under test: an organisation insert and update (explicit rows), a staged player write on a held record, a session row. */
function operation(t, { failLate = false, afterCommit = null } = {}) {
  let token = null;
  const result = t.unit(() => {
    t.layer.orgs.create({ id: 'org-new', name: 'New FC', type: 'club', plan: 'Pro' });
    t.layer.orgs.update('org-pro', (d) => { d.suspended = true; });
    t.layer.players.update('pl-1', { city: 'In the unit' });
    token = t.layer.sessions.create('player', 'pl-1').token;
    if (afterCommit) t.store.afterCommit(afterCommit);
    // Rewritten in S14a: the failure used to be an unserialisable blob; now the work fails after every write.
    if (failLate) throw new Error('late failure after the writes');
    return 'done';
  });
  return { result, token };
}
/** The pre-operation state the database must show after a failure: nothing of the operation, the unrelated earlier write kept. */
function assertDatabaseUntouched(t) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").n, 0, 'no inserted row');
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0, 'no updated column');
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Start', 'no player write');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player'").n, 0, 'no session row');
  assert.equal(t.raw("SELECT verified FROM orgs WHERE id = 'org-grass'").verified, 1, 'the unrelated write made before the unit is kept');
  assert.equal(hasBlobTable(t.store.sqlite), false, 'rewritten in S14a: there is no blob table');
}
/** Memory after a failure: the staged participant's held record restored in place; the organisations read the table. */
function assertMemoryRestored(t, refs) {
  const { p1 } = refs;
  assert.equal(t.layer.players.byId('pl-1'), p1, 'the same record object');
  assert.equal(p1.city, 'Start', 'the player write is undone on the held record');
  assert.equal(t.layer.orgs.byId('org-new'), null); assert.equal(t.layer.orgs.count(), 3);
  assert.equal(t.layer.orgs.byId('org-pro').suspended, false, 'a read after the rollback sees the committed row');
  assert.equal(t.layer.orgs.byId('org-grass').verified, true);
}
function assertOperationPersisted(t, token) {
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-new'").n, 1);
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1);
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'In the unit');
  assert.ok(t.layer.sessions.byToken(token), 'the session minted inside the unit is live');
  assert.equal(t.raw("SELECT verified FROM orgs WHERE id = 'org-grass'").verified, 1);
}
const prepare = (t) => {
  t.layer.orgs.update('org-grass', (d) => { d.verified = true; }); // an unrelated write before the operation (explicit: it commits at once)
  return { p1: t.layer.players.byId('pl-1') };
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
await test('unit of work: a row insert, a row update, a staged player write and a session commit together in one transaction; after-commit callbacks run once, after COMMIT', () => {
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
  assert.equal(t.layer.orgs.byId('org-pro').suspended, true); assert.equal(refs.p1.city, 'In the unit');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- failure after the writes
await test('unit of work: a failure after the writes rolls the database back AND restores memory (held records); an unrelated earlier write survives; an ordinary save persists no fragment; an explicit retry persists everything', () => {
  const dir = tempDir('uow-fail'); const t = boot(dir);
  const refs = prepare(t);
  let err = null;
  try { operation(t, { failLate: true }); } catch (e) { err = e; }
  assert.match(err.message, /late failure/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.store.sqlite.isTransaction, false);
  assertDatabaseUntouched(t);
  assertMemoryRestored(t, refs);
  // An ORDINARY save now: nothing of the failed operation lands.
  t.store.save();
  assertDatabaseUntouched(t);
  // Explicit retry of the WHOLE operation.
  const { token } = operation(t);
  assertOperationPersisted(t, token);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- failure at COMMIT
await test('unit of work: a failure at COMMIT takes the same path — database untouched, memory restored, the unrelated earlier write kept, retry lands everything', () => {
  const dir = tempDir('uow-commit'); const t = boot(dir);
  const refs = prepare(t);
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let explode = true;
  t.store.sqlite.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('disk full at commit'); } return exec(sql); };
  let err = null;
  try { operation(t); } catch (e) { err = e; }
  assert.match(err.message, /disk full at commit/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.store.sqlite.isTransaction, false);
  assertDatabaseUntouched(t);
  assertMemoryRestored(t, refs);
  const { token } = operation(t);
  assertOperationPersisted(t, token);
  t.store.sqlite.exec = exec; t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- crash before commit
await test('unit of work: a process killed before COMMIT leaves the pre-operation database — a restart sees no row and no player change of the operation', () => {
  const dir = tempDir('uow-crash'); const t = boot(dir);
  t.store.sqlite.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'unitOfWorkCrashChild.mjs'), dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, 'SIGKILL', `the child must die by SIGKILL: status ${r.status} signal ${r.signal} ${r.stderr.slice(-300)}`);
  assert.match(r.stdout, /ABOUT_TO_CRASH/);
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = {};
  const layer2 = attachDataLayer({ db: db2, store: again, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.equal(layer2.orgs.byId('org-crash'), null); assert.equal(layer2.orgs.count(), 3);
  assert.equal(layer2.players.byId('pl-1').city, 'Start');
  assert.equal(layer2.orgs.byId('org-pro').suspended, false);
  assert.equal(again.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- an ordinary save has nothing of the organisations to stage
await test('ordinary saves: an organisation write is in its row when the call returns (S14g: no staged facet), so a FAILED ordinary save neither loses nor delays it', () => {
  const dir = tempDir('uow-s3'); const t = boot(dir);
  t.layer.orgs.update('org-pro', (d) => { d.name = 'Eastport FC (renamed)'; });
  // Rewritten in S14a (the save failed on an unserialisable blob) and S14g (a facet edit stayed pending): the save's COMMIT fails once.
  const exec = t.store.sqlite.exec.bind(t.store.sqlite);
  let explode = true;
  t.store.sqlite.exec = (sql) => { if (explode && sql === 'COMMIT') { explode = false; throw new Error('disk full at commit'); } return exec(sql); };
  assert.throws(() => t.store.save(), /disk full at commit/);
  t.store.sqlite.exec = exec;
  assert.equal(t.raw("SELECT name FROM orgs WHERE id = 'org-pro'").name, 'Eastport FC (renamed)', 'the write committed when it was made');
  t.store.save();
  assert.equal(t.layer.orgs.byId('org-pro').name, 'Eastport FC (renamed)');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- nesting, saves inside, async, participants
await test('unit of work: a nested unit joins the enclosing one (an inner failure rolls everything back); a save() inside a unit is absorbed into its commit; asynchronous work is refused and rolled back; a unit cannot start inside a foreign transaction', () => {
  const dir = tempDir('uow-nest'); const t = boot(dir);
  const p1 = t.layer.players.byId('pl-1');
  // Nested join: the inner failure undoes the outer insert too.
  let err = null;
  try {
    t.unit(() => {
      t.layer.orgs.create({ id: 'org-outer', name: 'Outer', type: 'club', plan: 'Pro' });
      t.unit(() => { t.layer.players.update('pl-1', { city: 'Inner' }); throw new Error('inner failed'); });
    });
  } catch (e) { err = e; }
  assert.match(err.message, /inner failed/); assert.equal(err.unitOfWork, 'rolled_back');
  assert.equal(t.layer.orgs.byId('org-outer'), null); assert.equal(p1.city, 'Start');
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-outer'").n, 0);
  // save() inside a unit does not open a second transaction; what the unit wrote lands with it.
  // (Rewritten in S14a: the save revision and the absorbed blob are gone; the BEGINs are counted instead.)
  assert.equal(begins(t, () => t.unit(() => { t.layer.players.update('pl-1', { city: 'Absorbed' }); t.store.save(); t.layer.orgs.create({ id: 'org-abs', name: 'Abs', type: 'club', plan: 'Pro' }); })), 1, 'exactly one transaction');
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Absorbed'); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-abs'").n, 1);
  // Asynchronous work: a SQLite transaction must never span an await.
  err = null;
  try { t.unit(async () => { t.layer.orgs.create({ id: 'org-async', name: 'Async', type: 'club', plan: 'Pro' }); }); } catch (e) { err = e; }
  assert.match(err.message, /synchronous/); assert.equal(t.layer.orgs.byId('org-async'), null); assert.equal(t.store.sqlite.isTransaction, false);
  // A foreign open transaction refuses the unit before anything happens.
  t.store.sqlite.exec('BEGIN');
  assert.throws(() => t.unit(() => {}), /inside an open transaction/);
  t.store.sqlite.exec('ROLLBACK');
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('unit of work: participants — organisations, staff (S14f) and sessions take part: a failure later in the unit leaves none of them; a unit that finishes commits them together', () => {
  const dir = tempDir('uow-parts'); const t = boot(dir);
  let err = null;
  try {
    t.unit(() => {
      t.layer.orgs.create({ id: 'org-x', name: 'X', type: 'club', plan: 'Pro' });
      const u = t.layer.users.create({ orgId: 'org-pro', name: 'New Staff', role: 'Scout' });
      t.layer.sessions.create('org', 'org-pro', { userId: u.id });
      assert.equal(t.layer.users.byOrgAndName('org-pro', 'new staff')?.id, u.id, 'a read inside the unit sees its write');
      throw new Error('late failure');
    });
  } catch (e) { err = e; }
  assert.match(err.message, /late failure/);
  assert.equal(t.layer.orgs.byId('org-x'), null); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-x'").n, 0);
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM org_users').n, 1); assert.equal(t.layer.users.byOrgAndName('org-pro', 'New Staff'), null);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'org'").n, 0);
  const kept = t.unit(() => { const u = t.layer.users.create({ orgId: 'org-pro', name: 'Later Staff', role: 'Scout' }); t.layer.sessions.create('org', 'org-pro', { userId: u.id }); return u; });
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM org_users').n, 2);
  assert.equal(t.layer.sessions.listOrgUser(kept.id).length, 1);
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
  t.layer.players.update('pl-1', { city: 'Ordinary edit' });
  t.store.save();
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Ordinary edit', 'a later write is real, not absorbed by a phantom unit');
  t.unit(() => { t.layer.orgs.create({ id: 'org-after-begin', name: 'After', type: 'club', plan: 'Pro' }); });
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-after-begin'").n, 1, 'a later unit works');
  t.store.sqlite.exec = exec;
  // Cleanup errors: a participant whose restoreState throws must not leave the flag stuck or the transaction open.
  let restoreCalls = 0;
  t.store.setSaveHook({ flush() {}, snapshotState: () => 'state', restoreState() { restoreCalls += 1; throw new Error('restore exploded'); } });
  let err = null;
  try { t.unit(() => { t.layer.orgs.update('org-grass', (d) => { d.suspended = true; }); t.layer.players.update('pl-1', { city: 'Doomed' }); throw new Error('operation failed'); }); } catch (e) { err = e; }
  assert.match(err.message, /operation failed/, 'the caller sees the operation failure');
  assert.equal(err.unitOfWork, 'rolled_back'); assert.equal(restoreCalls, 1);
  assert.ok(Array.isArray(err.unitOfWorkCleanup) && /restore exploded/.test(err.unitOfWorkCleanup.join(' ')), 'the cleanup failure is attached to the error');
  assert.equal(t.store.inUnitOfWork(), false, 'the unit is closed even though cleanup failed');
  assert.equal(t.store.sqlite.isTransaction, false);
  // Rewritten in S14a (the store memento restored a blob) and S14g (the organisations participant restored itself): the
  // players participant, registered before the failing one, still restores its record.
  assert.equal(t.layer.players.byId('pl-1').city, 'Ordinary edit', 'the earlier participant still restored its record'); assert.equal(t.layer.orgs.byId('org-grass').suspended, false);
  assert.ok(t.store.unitOfWorkState().restoreFailures >= 1);
  t.store.save();
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Ordinary edit');
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-grass'").suspended, 0);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('a nested (joined) unit that fails poisons the whole unit even when its caller catches the error — nothing commits, nothing is published, memory is restored, a later ordinary save persists no fragment', () => {
  const dir = tempDir('uow-swallow'); const t = boot(dir);
  const p1 = t.layer.players.byId('pl-1');
  let events = 0; let outer = null; let innerSeen = null; let continued = false;
  try {
    t.unit(() => {
      t.layer.orgs.update('org-pro', (d) => { d.suspended = true; });
      try {
        t.unit(() => {
          t.layer.orgs.create({ id: 'org-inner', name: 'Inner', type: 'club', plan: 'Pro' });
          t.layer.players.update('pl-1', { city: 'Inner' });
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
  assert.equal(t.layer.orgs.byId('org-pro').suspended, false); assert.equal(t.layer.orgs.byId('org-inner'), null); assert.equal(p1.city, 'Start');
  t.store.save();
  assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Start'); assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 0);
  // The same operation, retried without the failure, commits whole.
  t.unit(() => { t.layer.orgs.update('org-pro', (d) => { d.suspended = true; }); t.unit(() => { t.layer.orgs.create({ id: 'org-inner', name: 'Inner', type: 'club', plan: 'Pro' }); }); t.store.afterCommit(() => { events += 1; }); });
  assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1); assert.equal(t.raw("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-inner'").n, 1); assert.equal(events, 1);
  t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('an organisation updated twice inside a unit: the second update sees the first, the commit writes the last; a rollback leaves the committed row; a restart reads the table (S14g: replaces the facet change-detection check)', () => {
  const dir = tempDir('uow-revert'); const t = boot(dir);
  t.unit(() => {
    t.layer.orgs.update('org-pro', (d) => { d.name = 'Eastport FC (renamed)'; });
    assert.equal(t.layer.orgs.byId('org-pro').name, 'Eastport FC (renamed)', 'a read inside the unit sees its write');
    t.layer.orgs.update('org-pro', (d) => { assert.equal(d.name, 'Eastport FC (renamed)', 'the draft is the current row'); d.suspended = true; });
  });
  assert.equal(t.raw("SELECT name FROM orgs WHERE id = 'org-pro'").name, 'Eastport FC (renamed)'); assert.equal(t.raw("SELECT suspended FROM orgs WHERE id = 'org-pro'").suspended, 1);
  assert.throws(() => t.unit(() => { t.layer.orgs.update('org-pro', (d) => { d.suspended = false; d.name = 'Nope'; }); throw new Error('late failure'); }), /late failure/);
  assert.equal(t.layer.orgs.byId('org-pro').suspended, true); assert.equal(t.layer.orgs.byId('org-pro').name, 'Eastport FC (renamed)');
  // An update from inside the same organisation's update is refused (§4.3).
  assert.throws(() => t.layer.orgs.update('org-pro', () => { t.layer.orgs.update('org-pro', (d) => { d.suspended = false; }); }), /already being updated/);
  t.store.sqlite.close();
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer2 = attachDataLayer({ db: {}, store: again, nextId, persist: () => {}, sessionTtlMs: TTL });
  const pro2 = layer2.orgs.byId('org-pro');
  assert.equal(pro2.name, 'Eastport FC (renamed)'); assert.equal(pro2.suspended, true);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

await test('an async function is refused BEFORE it is invoked (top-level and nested), so nothing of it ever runs; an unexpected thenable from a plain function is rolled back, its rejection is observed and counted, and the fact that its continuation is NOT cancelled is recorded, not hidden', async () => {
  const dir = tempDir('uow-async'); const t = boot(dir);
  const p1 = t.layer.players.byId('pl-1');
  let invoked = 0;
  const unhandled = await withUnhandled(async () => {
    // Top-level async work: refused before invocation.
    let err = null;
    try { t.unit(async () => { invoked += 1; await tick(); t.layer.orgs.update('org-pro', (d) => { d.suspended = true; }); }); } catch (e) { err = e; }
    assert.match(err.message, /async function|synchronous/); assert.equal(invoked, 0, 'an identifiable async function never runs');
    assert.equal(t.store.inUnitOfWork(), false); assert.equal(t.store.sqlite.isTransaction, false);
    // Nested async work: refused before invocation, and the enclosing unit cannot commit.
    err = null;
    try { t.unit(() => { t.layer.orgs.create({ id: 'org-outer2', name: 'O', type: 'club', plan: 'Pro' }); try { t.unit(async () => { invoked += 1; }); } catch { /* swallowed */ } }); } catch (e) { err = e; }
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
        t.layer.players.update('pl-1', { city: 'Sync part' });
        return (async () => { await tick(); continuation += 1; throw new Error('continuation rejected'); })();
      });
    } catch (e) { err = e; }
    assert.match(err.message, /synchronous|thenable|promise/); assert.equal(err.unitOfWork, 'rolled_back');
    assert.equal(p1.city, 'Start', 'the synchronous part of the work is rolled back');
    assert.equal(t.raw("SELECT city FROM players WHERE id = 'pl-1'").city, 'Start');
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
      t.layer.orgs.update('org-pro', (d) => { d.suspended = true; });
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
      result = t.store.unit.join(() => { t.layer.orgs.update('org-pro', (d) => { d.suspended = true; }); return 'joined'; });
      try { t.store.unit.join(() => { t.layer.orgs.create({ id: 'org-half', name: 'Half', type: 'club', plan: 'Pro' }); throw boom; }); } catch (e) { caught = e; }
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
  t.unit(() => { t.store.unit.join(() => t.layer.orgs.update('org-pro', (d) => { d.suspended = true; })); });
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
      t.unit(() => { players.update('pl-7', { city: 'In a unit' }); t.layer.orgs.update('org-pro', (d) => { d.suspended = true; }); }); // (S14a: the blob edit that stood here is gone)
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

test('cost (migration.md §4.3.1, S14g): an empty unit of work runs no statement on the organisations, however many there are', () => {
  const sqlOf = [];
  const restore = [];
  for (const [proto, names] of [[StatementSync.prototype, ['run', 'get', 'all', 'iterate']], [DatabaseSync.prototype, ['exec']]]) {
    for (const name of names) {
      const original = proto[name];
      proto[name] = function recording(...args) { sqlOf.push(this instanceof StatementSync ? this.sourceSQL : String(args[0])); return original.apply(this, args); };
      restore.push(() => { proto[name] = original; });
    }
  }
  try {
    const emptyUnit = (n) => {
      const dir = tempDir(`empty-${n}`);
      const seed = { ...fixtureSeed(), orgs: [...ORGS(), ...Array.from({ length: n }, (_, i) => ({ id: `org-c${i}`, name: `Club ${i}`, type: 'club', level: 'grassroots', plan: 'Grassroots' }))] };
      const t = boot(dir, seed);
      sqlOf.length = 0;
      t.unit(() => {});
      const ran = [...sqlOf];
      t.store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
      return ran;
    };
    const few = emptyUnit(3); const many = emptyUnit(500);
    assert.ok(!many.some((q) => /\borgs\b/.test(q)), `no statement names the organisations (${many.filter((q) => /\borgs\b/.test(q)).join(' | ')})`);
    assert.equal(many.length, few.length, `the empty unit's statements do not grow with the organisations (3: ${few.length}, 500: ${many.length})`);
  } finally {
    for (const undo of restore) undo();
  }
});

console.log(`\n${passed} unit-of-work checks passed`);
