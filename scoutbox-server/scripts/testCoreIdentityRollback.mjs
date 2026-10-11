// Behavioural tests for the S4a rollback tool (readiness review §8):
// repositories/coreIdentityRollback.mjs and scripts/coreIdentityRollback.mjs
// produce, on a COPY, a database the pre-S4 build reads — and the real
// migration 0005 brings that copy back to the live state (round trip). Every
// database is a throwaway file with synthetic records; the tool is never
// pointed at a real data directory. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from '../repositories/identityPreflight.mjs';
import { rollbackCoreIdentityCopy, KNOWN_MIGRATIONS, S1_IDENTITY_SHADOW_DDL } from '../repositories/coreIdentityRollback.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0005 from '../repositories/migrations/0005_core_identity_live.mjs';
import { openStore } from '../store.mjs';
import {
  NOW, DAY, TTL, tempDir, sha256, adult, child, gSignup, FIXTURE, SESSIONS,
  s3File, openRaw, migrate, applied, isLive, blob, blobText, meta, sessionRows, links, dump, identityDump, filesDigest,
} from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
/**
 * What "the source is never modified" means, measured: the main file's bytes
 * are identical and so is the logical content. SQLite's read-only open of a
 * WAL-mode database may create an EMPTY -wal and a -shm index next to the
 * source when none existed (a reader needs the index; a read-only connection
 * cannot checkpoint or remove them) — housekeeping, not content, and the next
 * ordinary open-and-close removes them, which is asserted too.
 */
function assertSourceUntouched(src, before, logicalBefore, label) {
  const after = filesDigest(src);
  assert.equal(after['scoutbox.db'], before['scoutbox.db'], `${label}: the main file is byte-identical`);
  assert.ok(after['scoutbox.db-wal'] === 'absent' || /^0 bytes/.test(after['scoutbox.db-wal']), `${label}: the WAL side file is absent or empty, never content (${after['scoutbox.db-wal']})`);
  const s = openRaw(src); assert.equal(dump(s), logicalBefore, `${label}: the logical content is unchanged`); s.close();
  assert.deepEqual(filesDigest(src), before, `${label}: after an ordinary open and close the directory is exactly as before`);
}

/**
 * An S3 file cut over by the real migration, then USED on the S4 build: the
 * identity repositories insert, update, link, unlink, age up and remove, a
 * facet is edited and saved, a session is minted, a blob changes. Returns what
 * the rollback must carry.
 */
function liveDatabaseWithHistory(dir) {
  s3File(dir);
  const s = openRaw(dir); migrate(s, { now: NOW }); s.close();
  const store = openStore(dir, { tableBacked: [...TABLE_BACKED, 'players', 'guardians'] });
  const loaded = store.load(); const db = { ...loaded.db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  const identity = createIdentityRepositories({ sqlite: store.sqlite, unit: store.unit, now: () => NOW });
  identity.attach();
  Object.defineProperty(db, 'players', { value: identity.players.view, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(db, 'guardians', { value: identity.guardians.view, writable: false, configurable: false, enumerable: true });
  store.setSaveHook(identity.saveHook());
  const snapshot = () => ({ savedAt: NOW + DAY, idCounter: 1200, db });
  // Post-S4 history, standalone and inside a unit of work.
  identity.guardians.insert({ id: 'gd-new', name: 'New Parent', email: 'new@example.test', password: 'scrypt$ee$ff', emailVerified: false, emailCode: 'ZZ9QQ1', idVerified: false, disclaimerAccepted: false, childIds: [] });
  identity.players.insert({ ...child('pl-new', 'gd-new', '2017-07-07'), name: 'New Child' });
  identity.players.update('pl-seeded', { name: 'Seeded Renamed', medical: { shared: false } });
  identity.guardians.update('gd-primary', { name: 'Primary Renamed', idvReference: 'idv-2' });
  identity.players.link('gd-new', 'pl-child1', 'co');
  identity.players.unlink('gd-co', 'pl-child2');
  identity.players.ageUp('pl-grown');
  identity.players.remove('pl-adult');
  db.players.find((p) => p.id === 'pl-seeded').badges.push('PostS4');
  db.guardians.find((g) => g.id === 'gd-signup').coGuardians = [{ id: 'gd-new', name: 'New Parent', email: 'new@example.test' }];
  db.requests[0].status = 'post-s4';
  store.unitOfWork(() => { identity.players.insert({ ...child('pl-unit', 'gd-primary', '2018-02-02'), name: 'Unit Child' }); db.requests.push({ id: 'req-2', status: 'in-unit' }); }, { snapshot });
  const minted = layer.sessions.create('guardian', 'gd-new');
  store.save(snapshot());
  const expected = { players: JSON.parse(JSON.stringify(db.players)), guardians: JSON.parse(JSON.stringify(db.guardians)), live: identityDump(store.sqlite), sessions: sessionRows(store.sqlite), minted: minted.token, others: dump(store.sqlite, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations'] }), blobs: Object.fromEntries(['users', 'sessions', 'orgs', 'requests', 'ledger'].map((n) => [n, blobText(store.sqlite, n)])), saveSeq: Number(meta(store.sqlite, 'saveSeq')) };
  store.sqlite.close();
  return expected;
}

test('the S1 shadow definitions the tool restores equal migration 0002\'s, column for column and index for index', () => {
  const a = new DatabaseSync(':memory:'); a.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(a, [m0002]);
  const b = new DatabaseSync(':memory:'); b.exec('PRAGMA foreign_keys = ON;'); b.exec(S1_IDENTITY_SHADOW_DDL);
  for (const t of ['guardians', 'players', 'guardian_children']) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(b), cols(a), `${t} columns`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx(b), idx(a), `${t} indexes`);
    const fks = (d) => d.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`).sort();
    assert.deepEqual(fks(b), fks(a), `${t} foreign keys`);
  }
  assert.deepEqual([...KNOWN_MIGRATIONS], ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', CORE_IDENTITY_LIVE_MIGRATION]);
  a.close(); b.close();
});

test('rollback: the copy holds every post-S4 player, guardian and link in the two blobs (inserted present, removed gone, updates, link changes and facet edits kept, the outstanding e-mail codes plain), the S1 shadow tables empty, sessions by hash, staff, organisations and other blobs untouched, the S4 bookkeeping gone, the revision advanced; the source is unchanged (main file digest, logical content; the WAL side files are accounted for); the pre-S4 data layer reads the copy', () => {
  const src = tempDir('s4-rb-src'); const expected = liveDatabaseWithHistory(src);
  const srcBefore = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  const out = tempDir('s4-rb-out');
  const result = rollbackCoreIdentityCopy(dbFile(src), out);
  assertSourceUntouched(src, srcBefore, logicalBefore, 'after a successful rollback');
  // The result.
  assert.equal(result.output, dbFile(out)); assert.equal(result.recordRemoved, true);
  assert.equal(result.players, 6, 'five fixture players − the removed adult + the new child + the unit child'); assert.equal(result.guardians, 4); assert.equal(result.links, 6, 'five fixture links + the new child + the co link − the unlink − the ageUp + the unit child'); assert.equal(result.sessions, 4); assert.equal(result.saveSeq, expected.saveSeq + 1);
  assert.deepEqual(fs.readdirSync(out), ['scoutbox.db'], 'one file, no WAL leftovers after VACUUM');
  const o = openRaw(out);
  assert.deepEqual(applied(o), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live']);
  assert.equal(meta(o, CORE_IDENTITY_INIT_META), undefined); assert.equal(meta(o, m0005.CORE_IDENTITY_CUTOVER_META), undefined); assert.equal(Number(meta(o, 'saveSeq')), expected.saveSeq + 1);
  // The blobs: exactly what the repositories served after the history (byte-identical records, childIds in link order).
  const players = blob(o, 'players'); const guardians = blob(o, 'guardians');
  assert.equal(JSON.stringify(players), JSON.stringify(expected.players), 'the players blob equals the live view, record for record');
  assert.equal(JSON.stringify(guardians), JSON.stringify(expected.guardians), 'the guardians blob equals the live view, record for record');
  assert.deepEqual(players.map((p) => p.id), ['pl-child1', 'pl-seeded', 'pl-child2', 'pl-grown', 'pl-new', 'pl-unit'], 'the removed player is not resurrected; the inserted ones are there');
  assert.equal(players.find((p) => p.id === 'pl-seeded').name, 'Seeded Renamed'); assert.equal(players.find((p) => p.id === 'pl-seeded').medical.shared, false); assert.deepEqual(players.find((p) => p.id === 'pl-seeded').badges, ['Finisher', 'PostS4']);
  assert.equal(players.find((p) => p.id === 'pl-grown').guardianId, null, 'aged up');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-primary').childIds, ['pl-child1', 'pl-child2', 'pl-unit'], 'unlinked by ageUp, linked by the unit');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-co').childIds, ['pl-child1'], 'unlink');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-new').childIds, ['pl-new', 'pl-child1'], 'the new guardian\'s primary and co links, in link order');
  assert.equal(guardians.find((g) => g.id === 'gd-primary').name, 'Primary Renamed'); assert.equal(guardians.find((g) => g.id === 'gd-primary').idvReference, 'idv-2');
  assert.equal(guardians.find((g) => g.id === 'gd-signup').emailCode, 'K7Q2ZP', 'the outstanding code, plain'); assert.equal(guardians.find((g) => g.id === 'gd-new').emailCode, 'ZZ9QQ1');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-signup').coGuardians, [{ id: 'gd-new', name: 'New Parent', email: 'new@example.test' }], 'a facet edit saved after the cutover');
  assert.equal(blobText(o, 'players').split('K7Q2ZP').length - 1, 0); assert.equal(blobText(o, 'guardians').split('K7Q2ZP').length - 1, 1, 'the code appears exactly once, in the guardians blob');
  // The tables: the S1 shadow definition, empty.
  for (const t of ['players', 'guardians', 'guardian_children']) { assert.equal(o.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} empty`); assert.equal(isLive(o, t), false, `${t} is the shadow definition`); }
  // Untouched: sessions (the minted one included), staff, organisations, other blobs (the post-S4 blob edit kept).
  assert.deepEqual(sessionRows(o), expected.sessions); assert.ok(o.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(expected.minted)));
  assert.equal(dump(o, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations'] }), expected.others);
  for (const [n, text] of Object.entries(expected.blobs)) assert.equal(blobText(o, n), text, `${n} blob untouched`);
  assert.equal(blob(o, 'requests')[0].status, 'post-s4'); assert.equal(blob(o, 'requests')[1].id, 'req-2');
  assert.deepEqual(o.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(o.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  o.close();
  // The pre-S4 data layer (this build's production path: players and guardians are blobs) reads the copy as a snapshot and attaches.
  const store = openStore(out, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  assert.equal(JSON.stringify(loaded.db.players), JSON.stringify(expected.players)); assert.equal(JSON.stringify(loaded.db.guardians), JSON.stringify(expected.guardians));
  const db = { ...loaded.db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  assert.deepEqual(layer.report().migrations, DATA_MIGRATIONS.map((m) => m.id)); assert.equal(layer.orgs.count(), 1); assert.equal(layer.sessions.count(), 4);
  assert.ok(layer.sessions.byToken(expected.minted), 'the session minted after the cutover works on the pre-S4 data layer');
  db.players.push({ ...adult(), id: 'pl-pre-s4', name: 'Added on the pre-S4 build' });
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1300, db });
  assert.equal(blob(store.sqlite, 'players').at(-1).id, 'pl-pre-s4', 'the pre-S4 build persists players as a blob again');
  store.sqlite.close();
  rm(src, out);
});

test('round trip: the real migration cuts the rollback copy over again and the live tables equal the pre-rollback live state row for row (facets included), the repositories attach and serve the same records; a record added on the pre-S4 build is imported with them', () => {
  const src = tempDir('s4-rt-src'); const expected = liveDatabaseWithHistory(src);
  const out = tempDir('s4-rt-out');
  rollbackCoreIdentityCopy(dbFile(src), out);
  const o = openRaw(out);
  migrate(o, { now: NOW + 3 * DAY });
  assert.equal(identityDump(o), expected.live, 'players, guardians and links are identical to the pre-rollback live state');
  assert.deepEqual(sessionRows(o), expected.sessions); assert.equal(meta(o, CORE_IDENTITY_INIT_META), 'done');
  const identity = createIdentityRepositories({ sqlite: o, now: () => NOW });
  identity.attach();
  assert.equal(JSON.stringify(identity.players.view), JSON.stringify(expected.players)); assert.equal(JSON.stringify(identity.guardians.view), JSON.stringify(expected.guardians));
  o.close();
  // A write on the pre-S4 build between rollback and re-upgrade (a new guardian with a child) is imported with everything else.
  const out2 = tempDir('s4-rt-out2');
  rollbackCoreIdentityCopy(dbFile(src), out2);
  const store = openStore(out2, { tableBacked: TABLE_BACKED });
  const loaded = store.load(); const db = { ...loaded.db }; attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL });
  db.guardians.push({ ...gSignup(), id: 'gd-pre', email: 'pre@example.test', emailCode: 'PRE123', childIds: ['pl-pre'] });
  db.players.push(child('pl-pre', 'gd-pre', '2016-06-06'));
  db.guardians.find((g) => g.id === 'gd-signup').emailVerified = true; db.guardians.find((g) => g.id === 'gd-signup').emailCode = null; // verified on the pre-S4 build
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1300, db }); store.sqlite.close();
  const o2 = openRaw(out2);
  migrate(o2, { now: NOW + 3 * DAY });
  assert.equal(o2.prepare('SELECT COUNT(*) AS n FROM players').get().n, 7); assert.deepEqual(o2.prepare("SELECT guardian_id, role FROM guardian_children WHERE player_id = 'pl-pre'").all().map((r) => ({ ...r })), [{ guardian_id: 'gd-pre', role: 'primary' }]);
  const identity2 = createIdentityRepositories({ sqlite: o2, now: () => NOW }); identity2.attach();
  assert.equal(identity2.guardians.byId('gd-pre').emailCode, 'PRE123'); assert.equal(identity2.guardians.byId('gd-signup').emailVerified, true); assert.equal(identity2.guardians.byId('gd-signup').emailCode, null);
  o2.close(); rm(src, out, out2);
});

test('an active WAL is carried: a change still in the source\'s WAL (writer connection open, no checkpoint) is in the copy, and the tool neither checkpointed nor modified the source', () => {
  const src = tempDir('s4-rb-wal'); liveDatabaseWithHistory(src);
  const writer = openRaw(src); writer.exec('PRAGMA wal_autocheckpoint = 0;');
  writer.prepare("UPDATE players SET name = 'In The WAL' WHERE id = 'pl-seeded'").run();
  const before = filesDigest(src);
  assert.notEqual(before['scoutbox.db-wal'], 'absent'); assert.ok(!/^0 bytes/.test(before['scoutbox.db-wal']), 'the change sits in the WAL side file');
  const out = tempDir('s4-rb-wal-out');
  const result = rollbackCoreIdentityCopy(dbFile(src), out);
  assert.equal(result.players, 6);
  const after = filesDigest(src);
  assert.equal(after['scoutbox.db'], before['scoutbox.db'], 'the main file is byte-identical: the read-only open did not checkpoint');
  assert.equal(after['scoutbox.db-wal'], before['scoutbox.db-wal'], 'the WAL side file is byte-identical');
  // (The -shm index is shared memory a reader may touch; its bytes are not content and are not asserted.)
  const o = openRaw(out);
  assert.equal(blob(o, 'players').find((p) => p.id === 'pl-seeded').name, 'In The WAL', 'the copy holds the uncheckpointed change');
  o.close(); writer.close(); rm(src, out);
});

test('refusals and failures leave no output and never touch the source: a later schema step (exit 4), a file that never cut over (exit 5), a non-empty output directory (exit 1), a recorded 0005 over shadow tables, and an injected COMMIT failure inside the tool', () => {
  const src = tempDir('s4-rb-refuse'); liveDatabaseWithHistory(src);
  const before = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  // Later schema.
  const later = tempDir('s4-rb-later'); fs.copyFileSync(dbFile(src), dbFile(later));
  const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0006_future_step', 1)").run(); l.close();
  const out1 = tempDir('s4-rb-o1');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(later), out1), (err) => err.code === 'LATER_SCHEMA' && /0006_future_step/.test(err.message));
  assert.deepEqual(fs.readdirSync(out1), [], 'no output');
  // Never cut over (an S3 file).
  const s3 = tempDir('s4-rb-s3'); s3File(s3);
  const out2 = tempDir('s4-rb-o2');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(s3), out2), (err) => err.code === 'NOT_CUT_OVER');
  assert.deepEqual(fs.readdirSync(out2), []);
  // Non-empty output.
  const out3 = tempDir('s4-rb-o3'); fs.writeFileSync(path.join(out3, 'keep.txt'), 'x');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(src), out3), (err) => err.code === 'OUTPUT_NOT_EMPTY');
  assert.deepEqual(fs.readdirSync(out3), ['keep.txt'], 'nothing was written next to it');
  // A recorded 0005 whose tables are not the live definition: refused, not guessed.
  const odd = tempDir('s4-rb-odd'); s3File(odd);
  const od = openRaw(odd); od.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, 1)').run(CORE_IDENTITY_LIVE_MIGRATION); od.close();
  const out4 = tempDir('s4-rb-o4');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(odd), out4), (err) => err.code === 'UNEXPECTED_SCHEMA');
  assert.deepEqual(fs.readdirSync(out4), []);
  // An injected failure at the copy's COMMIT: the partial copy is removed.
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the rollback tool'); } return exec.call(this, sql); };
  const out5 = tempDir('s4-rb-o5');
  try { assert.throws(() => rollbackCoreIdentityCopy(dbFile(src), out5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.equal(fired, 1, 'the failure must actually have been injected');
  assert.deepEqual(fs.readdirSync(out5), [], 'no usable partial output');
  // The source after every refusal and the failure: untouched.
  assertSourceUntouched(src, before, logicalBefore, 'after the refusals and the injected failure');
  // The CLI's exit codes.
  const script = path.join(HERE, 'coreIdentityRollback.mjs');
  const run = (...a) => { try { execFileSync(process.execPath, [script, ...a], { stdio: 'pipe' }); return 0; } catch (err) { return err.status; } };
  assert.equal(run(later, path.join(tempDir('s4-rb-cli'), 'x')), 4);
  assert.equal(run(s3, path.join(tempDir('s4-rb-cli2'), 'x')), 5);
  assert.equal(run(src, out3), 1);
  assert.equal(run(src), 1, 'usage');
  const cliOut = path.join(tempDir('s4-rb-cli3'), 'copy');
  const json = JSON.parse(execFileSync(process.execPath, [script, src, cliOut, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(json.players, 6); assert.equal(json.recordRemoved, true); assert.ok(fs.existsSync(path.join(cliOut, 'scoutbox.db')));
  assertSourceUntouched(src, before, logicalBefore, 'after the CLI runs');
  rm(src, later, s3, odd, out1, out2, out3, out4, out5, path.dirname(cliOut));
});

console.log(`\n${passed} core-identity rollback checks passed`);
