// Unit tests for the relational data layer (repositories/): the table
// migration runner, the staff repository, the read-only views, the legacy
// import and the snapshot store's table-backed exclusions. Everything runs on
// an in-memory or throwaway SQLite database. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction, dataSchemaReport } from '../repositories/database.mjs';
import { createUsersRepository } from '../repositories/users.mjs';
import { readonlyView } from '../repositories/readonly.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const fresh = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); return s; };
let counter = 1000;
const nextId = (p) => `${p}-${++counter}`;
const repoOn = (sqlite, legacy = []) => { const r = createUsersRepository({ sqlite, nextId, persist: () => {} }); r.attach(legacy); return r; };

// ------------------------------------------------------- migration runner
test('migrations: each step runs once, in id order, and is recorded in the database', () => {
  const s = fresh();
  const seen = [];
  const steps = [
    { id: '0002_b', note: 'b', up: () => seen.push('b') },
    { id: '0001_a', note: 'a', up: (db) => { seen.push('a'); db.exec('CREATE TABLE a (x)'); } },
  ];
  const first = runDataMigrations(s, steps);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(first, { ran: ['0001_a', '0002_b'], applied: 2, known: 2 });
  const second = runDataMigrations(s, steps);
  assert.deepEqual(second.ran, []);
  assert.equal(seen.length, 2);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, 2);
});
test('migrations: a failing step rolls back and aborts without recording itself', () => {
  const s = fresh();
  const steps = [{ id: '0001_bad', note: 'bad', up: (db) => { db.exec('CREATE TABLE half (x)'); throw new Error('boom'); } }];
  assert.throws(() => runDataMigrations(s, steps), /data migration 0001_bad failed: boom/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get().n, 0);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, 0);
});
test('transaction: rolls back on throw, commits otherwise', () => {
  const s = fresh();
  s.exec('CREATE TABLE t (x)');
  assert.throws(() => transaction(s, () => { s.exec("INSERT INTO t VALUES (1)"); throw new Error('no'); }), /no/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(transaction(s, () => { s.exec("INSERT INTO t VALUES (1)"); return 'ok'; }), 'ok');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
});
test('schema report: names tables and counts, never rows', () => {
  const s = fresh();
  runDataMigrations(s, DATA_MIGRATIONS);
  const report = dataSchemaReport(s, DATA_MIGRATIONS);
  assert.deepEqual(report, { engine: 'sqlite', migrationsApplied: 1, migrationsKnown: 1, tables: ['org_users'] });
  assert.deepEqual(dataSchemaReport(null, DATA_MIGRATIONS), { engine: 'memory', migrationsApplied: 0, migrationsKnown: 1, tables: [] });
});

// --------------------------------------------------------- read-only views
test('views: reads work as before; every write throws and names the repository', () => {
  const target = { id: 'u1', name: 'A', mfa: { recoveryHashes: ['h'] } };
  const rows = [target];
  const view = readonlyView(rows, 'a staff record');
  assert.equal(view.length, 1);
  assert.equal(view.find((u) => u.id === 'u1').name, 'A');
  assert.equal(JSON.stringify(view), JSON.stringify(rows));
  assert.ok(Array.isArray(view));
  assert.deepEqual({ ...view[0] }, target);
  assert.throws(() => { view[0].name = 'B'; }, /staff record.*repositories/);
  assert.throws(() => { view[0].mfa.recoveryHashes.splice(0, 1); }, /repositories/);
  assert.throws(() => { view[0].mfa.enabledAt = 1; }, /repositories/);
  assert.throws(() => { view.push({ id: 'u2' }); }, /repositories/);
  assert.throws(() => { delete view[0].name; }, /repositories/);
  assert.equal(target.name, 'A', 'the target is untouched');
  assert.equal(readonlyView(target), readonlyView(target), 'one view per target');
});

// -------------------------------------------------------- staff repository
test('repository: insert assigns the id, stores the row and refreshes the view', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const u = repo.insert({ orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', id: 'ignored' });
  assert.match(u.id, /^usr-\d+$/);
  assert.equal(u.orgId, 'org-a');
  assert.ok(typeof u.createdAt === 'number');
  assert.equal(repo.view.length, 1);
  assert.equal(repo.view[0], u, 'the view holds the same object the caller got');
  const stored = s.prepare('SELECT id, org_id, name, role, email FROM org_users').all().map((r) => ({ ...r }));
  assert.deepEqual(stored, [{ id: u.id, org_id: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', email: null }]);
  assert.deepEqual(Object.keys({ ...u }).sort(), ['createdAt', 'id', 'name', 'orgId', 'role'], 'unset fields are absent, not null');
});
test('repository: insert refuses incomplete records', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  assert.throws(() => repo.insert({ name: 'X', role: 'Scout' }), /orgId/);
  assert.throws(() => repo.insert({ orgId: 'o', role: 'Scout' }), /name/);
  assert.throws(() => repo.insert({ orgId: 'o', name: 'X', role: ' ' }), /role/);
  assert.equal(repo.view.length, 0);
});
test('repository: update changes the row in place, null clears, undefined leaves alone, nested values are replaced whole', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const u = repo.insert({ orgId: 'org-a', name: 'Dee', role: 'Scout' });
  const same = repo.update(u.id, { role: 'Manager', email: 'dee@example.com', mfa: { secretB32: 'S', enabledAt: null, recoveryHashes: ['a', 'b'] }, name: undefined });
  assert.equal(same, u, 'callers holding the view see the change');
  assert.equal(u.role, 'Manager');
  assert.equal(u.email, 'dee@example.com');
  assert.deepEqual({ ...u.mfa }, { secretB32: 'S', enabledAt: null, recoveryHashes: ['a', 'b'] });
  repo.update(u.id, { mfa: { ...u.mfa, recoveryHashes: u.mfa.recoveryHashes.filter((h) => h !== 'a') } });
  assert.deepEqual([...u.mfa.recoveryHashes], ['b']);
  repo.update(u.id, { mfa: null, email: null });
  assert.equal('mfa' in { ...u }, false);
  assert.equal('email' in { ...u }, false);
  const stored = { ...s.prepare('SELECT role, email, mfa_json FROM org_users WHERE id = ?').get(u.id) };
  assert.deepEqual(stored, { role: 'Manager', email: null, mfa_json: null });
  assert.throws(() => repo.update('usr-nope', { role: 'x' }), /does not exist/);
  assert.throws(() => repo.update(u.id, { id: 'other' }), /never changes/);
});
test('repository: lookups by id, by organisation and by case-insensitive name', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const a = repo.insert({ orgId: 'org-a', name: 'Maria Keane', role: 'Scout' });
  repo.insert({ orgId: 'org-b', name: 'Maria Keane', role: 'Scout' });
  assert.equal(repo.byId(a.id), a);
  assert.equal(repo.byId('missing'), null);
  assert.equal(repo.byId(undefined), null);
  assert.equal(repo.byOrgAndName('org-a', '  maria keane '), a);
  assert.equal(repo.byOrgAndName('org-c', 'Maria Keane'), null);
  assert.equal(repo.byOrgAndName('org-a', ''), null);
  assert.equal(repo.listByOrg('org-a').length, 1);
  assert.equal(repo.count(), 2);
});
test('repository: a table row survives a new process while the id counter is behind — ids are skipped, never reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-users-'));
  const file = path.join(dir, 'x.db');
  let s = new DatabaseSync(file); runDataMigrations(s, DATA_MIGRATIONS);
  let local = 1000; const ids = (p) => `${p}-${++local}`;
  let repo = createUsersRepository({ sqlite: s, nextId: ids, persist: () => {} }); repo.attach([]);
  const first = repo.insert({ orgId: 'o', name: 'One', role: 'Scout' });
  s.close();
  // "Restart" with the counter reset, as after an abrupt stop before the snapshot saved it.
  s = new DatabaseSync(file); local = 1000;
  repo = createUsersRepository({ sqlite: s, nextId: ids, persist: () => {} });
  const boot = repo.attach([]);
  assert.deepEqual(boot, { engine: 'sqlite', loaded: 1, imported: 0 });
  assert.equal(repo.view[0].name, 'One');
  const second = repo.insert({ orgId: 'o', name: 'Two', role: 'Scout' });
  assert.notEqual(second.id, first.id);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 2);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('repository: the legacy blob array is imported once, with every field kept, and ignored once the table has rows', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const legacy = [
    { id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 5, email: 'a@x', ssoSubject: 'idp-1', mfa: { secretB32: 'S', enabledAt: 7, recoveryHashes: [] }, deliveryPrefs: { quietStart: '22:00' }, removedAt: 9, removedBy: 'B', oddField: { kept: true } },
    { id: 'usr-2', orgId: 'o', name: 'B', role: 'Manager', createdAt: 6 },
    null, { notARow: true },
  ];
  const warnings = [];
  const repo = createUsersRepository({ sqlite: s, nextId, persist: () => {}, warn: (m) => warnings.push(m) });
  const boot = repo.attach(legacy);
  assert.deepEqual(boot, { engine: 'sqlite', loaded: 2, imported: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(repo.view[0])), legacy[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(repo.view[1])), legacy[1]);
  assert.equal(s.prepare('SELECT extra_json FROM org_users WHERE id = ?').get('usr-1').extra_json, '{"oddField":{"kept":true}}');
  const again = createUsersRepository({ sqlite: s, nextId, persist: () => {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(again.attach(legacy), { engine: 'sqlite', loaded: 2, imported: 0 });
  assert.ok(warnings.some((w) => /stale users blob/.test(w)));
});
test('repository: without sqlite the same API runs in memory and asks the snapshot to persist', () => {
  let persisted = 0;
  const repo = createUsersRepository({ sqlite: null, nextId, persist: () => { persisted++; } });
  assert.deepEqual(repo.attach([{ id: 'usr-9', orgId: 'o', name: 'Z', role: 'Scout', createdAt: 1 }]), { engine: 'memory', loaded: 1, imported: 0 });
  const u = repo.insert({ orgId: 'o', name: 'Y', role: 'Scout' });
  repo.update(u.id, { role: 'Manager' });
  assert.equal(persisted, 2);
  assert.equal(repo.byId('usr-9').name, 'Z');
});

// ------------------------------------------------------ attach + store
test('attachDataLayer: db.users becomes the repository view and cannot be replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-layer-'));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { players: [], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 1, imported: 1 });
  assert.equal(db.users.length, 1);
  assert.throws(() => { db.users = []; }, TypeError);
  assert.throws(() => { db.users.push({}); }, /repositories/);
  assert.equal(layer.report().domains.users.rows, 1);
  assert.deepEqual(layer.report().tables, ['org_users']);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (server mode): a table-backed collection is never written as a blob again, and a stale blob row is deleted on the next save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
  let store = openStore(dir);
  store.save({ savedAt: 1, idCounter: 1000, db: { players: [{ id: 'p' }], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] } });
  store.sqlite.close();
  store = openStore(dir, { tableBacked: ['users'] });
  const loaded = store.load();
  assert.equal(loaded.db.users.length, 1, 'the old blob is still handed back for the one-time import');
  store.save({ savedAt: 2, idCounter: 1001, db: { players: [{ id: 'p' }], users: [{ id: 'usr-1' }] } });
  const names = store.sqlite.prepare('SELECT name FROM collections ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(names, ['players']);
  assert.equal(store.load().db.users, undefined);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): load merges table-backed collections in from their tables and save writes them back there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-snap-'));
  // A server boot: the table exists and holds one row; the blob is gone.
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { players: [{ id: 'p' }], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] };
  attachDataLayer({ db, store: server, nextId, persist: () => {} });
  server.save({ savedAt: 1, idCounter: 1000, db });
  server.sqlite.close();
  // A tool reading the file as one snapshot sees the staff rows as before.
  const tool = openStore(dir);
  const snap = tool.load();
  assert.deepEqual(snap.db.users, [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }]);
  assert.deepEqual(snap.db.players, [{ id: 'p' }]);
  // Writing a changed snapshot lands in the table, not in a blob.
  snap.db.users.push({ id: 'usr-2', orgId: 'o', name: 'B', role: 'Manager', createdAt: 2, mfa: { secretB32: 'S', enabledAt: 3, recoveryHashes: [] } });
  snap.db.users[0].role = 'Director';
  tool.save(snap);
  assert.deepEqual(tool.sqlite.prepare('SELECT name FROM collections ORDER BY name').all().map((r) => r.name), ['players']);
  assert.deepEqual(tool.sqlite.prepare('SELECT id, role, mfa_json FROM org_users ORDER BY rowid').all().map((r) => ({ ...r })),
    [{ id: 'usr-1', role: 'Director', mfa_json: null }, { id: 'usr-2', role: 'Manager', mfa_json: '{"secretB32":"S","enabledAt":3,"recoveryHashes":[]}' }]);
  tool.sqlite.close();
  // And the next server boot reads exactly that.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = { players: [], users: [] };
  const layer = attachDataLayer({ db: db2, store: again, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 2, imported: 0 });
  assert.equal(db2.users[0].role, 'Director');
  assert.equal(db2.users[1].mfa.enabledAt, 3);
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): before any boot there is no table, so a fixture is written as a blob and imported by the first boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fixture-'));
  const tool = openStore(dir);
  tool.save({ savedAt: 1, idCounter: 1000, db: { players: [], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] } });
  assert.deepEqual(tool.sqlite.prepare('SELECT name FROM collections ORDER BY name').all().map((r) => r.name), ['players', 'users']);
  tool.sqlite.close();
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...server.load().db };
  const layer = attachDataLayer({ db, store: server, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 1, imported: 1 });
  server.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} data-layer checks passed`);
