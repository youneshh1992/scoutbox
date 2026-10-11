// The media-deletion queue (repositories/mediaDeletions.mjs, migration 0006):
// an entry is written inside the deletion's transaction, processed after COMMIT
// through the storage adapter, retried while the adapter fails, cleared only
// once the file is gone or was already absent; the S4a rollback tool refuses a
// copy whose queue is not empty and drops the table when it is. Temporary
// databases and directories only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createMediaDeletionsQueue } from '../repositories/mediaDeletions.mjs';
import { rollbackCoreIdentityCopy } from '../repositories/coreIdentityRollback.mjs';
import { createStorage } from '../adapters.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, adult, s3File, migrate, openRaw } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const memDb = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(s, DATA_MIGRATIONS, { now: NOW }); return s; };
/** A storage double that records calls; `behaviour[id]` is a number (files removed) or an Error to throw. */
const fakeStorage = (behaviour = {}) => { const calls = []; return { calls, delete(id) { calls.push(id); const b = behaviour[id]; if (b instanceof Error) throw b; return b ?? 0; } }; };

test('queue: enqueue runs only inside a transaction, refuses a malformed id, upserts; isQueued/pending/count read the rows; process clears an entry when the file was removed or was already absent, keeps it with attempts and the error when storage throws, and never runs inside a transaction', () => {
  const s = memDb();
  const q = createMediaDeletionsQueue({ sqlite: s, now: () => NOW });
  assert.throws(() => q.enqueue(['media-1']), /enqueue\(\) runs inside the deletion's transaction/);
  assert.throws(() => transaction(s, () => q.enqueue(['../etc'])), /is not a media id/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n, 0, 'the refused batch wrote nothing');
  assert.equal(transaction(s, () => q.enqueue(['media-1', 'media-2', 'media-1'], { playerId: 'pl-x', at: NOW })), 3);
  assert.equal(q.count(), 2, 'upsert: one row per id'); assert.equal(q.isQueued('media-1'), true); assert.equal(q.isQueued('media-9'), false); assert.equal(q.isQueued('../x'), false);
  assert.deepEqual(q.pending().map((r) => [r.media_id, r.player_id, r.queued_at, r.attempts, r.last_error]), [['media-1', 'pl-x', NOW, 0, null], ['media-2', 'pl-x', NOW, 0, null]]);
  assert.throws(() => transaction(s, () => q.process(fakeStorage())), /process\(\) runs outside any transaction/);
  // media-1 removed, media-2 fails (a permission problem): one cleared, one kept with the attempt recorded.
  const st = fakeStorage({ 'media-1': 1, 'media-2': Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) });
  assert.deepEqual(q.process(st), { removed: 1, absent: 0, failed: 1 }); assert.deepEqual(st.calls, ['media-1', 'media-2']);
  assert.equal(q.isQueued('media-1'), false); assert.equal(q.isQueued('media-2'), true);
  assert.deepEqual(q.pending().map((r) => [r.media_id, r.attempts, r.last_attempt_at, r.last_error]), [['media-2', 1, NOW, 'EACCES: permission denied']]);
  // The retry: still failing → attempts 2; then absent (0 files) → cleared: the entry goes only when the file is gone.
  assert.deepEqual(q.process(fakeStorage({ 'media-2': new Error('still locked') })), { removed: 0, absent: 0, failed: 1 }); assert.equal(q.pending()[0].attempts, 2);
  assert.deepEqual(q.process(fakeStorage({ 'media-2': 0 })), { removed: 0, absent: 1, failed: 0 }); assert.equal(q.count(), 0);
  assert.deepEqual(q.process(fakeStorage()), { removed: 0, absent: 0, failed: 0 }, 'an empty queue is a no-op');
  s.close();
});

test('storage adapter: delete() returns the number of files removed, 0 for an absent id, and throws on an error other than ENOENT (a directory in the file\'s place), so the queue keeps the entry', () => {
  const dir = tempDir('media-storage'); const storage = createStorage(dir);
  assert.equal(storage.delete('media-none'), 0);
  storage.saveDataUrl('media-a', 'data:video/webm;base64,AAAA');
  assert.ok(fs.existsSync(path.join(dir, 'media', 'media-a.webm')));
  assert.equal(storage.delete('media-a'), 1); assert.equal(fs.existsSync(path.join(dir, 'media', 'media-a.webm')), false);
  fs.mkdirSync(path.join(dir, 'media', 'media-b.webm'), { recursive: true }); // unlink refuses a directory: not "absent"
  assert.throws(() => storage.delete('media-b'), (err) => err.code !== 'ENOENT');
  rm(dir);
});

test('transaction coupling: an entry queued inside a unit of work that rolls back is gone with everything else; one queued inside a unit that commits is processed only after COMMIT, and the row stays across a reopen while the file could not be removed', () => {
  const dir = tempDir('media-unit'); const storageDir = tempDir('media-unit-files'); const storage = createStorage(storageDir);
  let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { orgs: [], users: [], sessions: [], players: [adult()], guardians: [], requests: [] };
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  storage.saveDataUrl('media-x', 'data:video/webm;base64,AAAA');
  // Rolled back: the queue entry, the player removal and the blob edit all go.
  assert.throws(() => store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); db.requests.push({ id: 'r' }); throw new Error('boom'); }, { snapshot }), /boom/);
  assert.equal(layer.mediaDeletions.count(), 0); assert.equal(layer.players.count(), 1); assert.equal(db.requests.length, 0);
  assert.ok(fs.existsSync(path.join(storageDir, 'media', 'media-x.webm')), 'the file was never touched');
  // Committed: the entry exists after COMMIT; processing then removes the file and clears the entry.
  let seenInside = null;
  store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); seenInside = layer.mediaDeletions.isQueued('media-x'); }, { snapshot });
  assert.equal(seenInside, true); assert.equal(layer.mediaDeletions.count(), 1); assert.equal(layer.players.count(), 0);
  // A failure at the filesystem boundary (a directory now sits where the file was): the entry survives a reopen.
  fs.rmSync(path.join(storageDir, 'media', 'media-x.webm')); fs.mkdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 0, failed: 1 });
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: { ...store.load().db, players: [], guardians: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  assert.equal(layer.mediaDeletions.isQueued('media-x'), true); assert.equal(layer.report().mediaDeletions.queued, 1);
  fs.rmdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 1, failed: 0 }, 'absent now: cleared');
  assert.equal(layer.report().mediaDeletions.queued, 0);
  store.sqlite.close(); rm(dir, storageDir);
});

test('rollback tool: a copy whose queue is not empty is refused (MEDIA_QUEUE_PENDING, exit 8) and no output is left; once the queue drained the tool drops media_deletions with its migration record, and the real migration brings both back on re-upgrade', () => {
  const dir = tempDir('media-rb'); s3File(dir);
  let s = openRaw(dir); migrate(s, { now: NOW });
  transaction(s, () => createMediaDeletionsQueue({ sqlite: s, now: () => NOW }).enqueue(['media-gone'], { playerId: 'pl-adult', at: NOW }));
  s.close();
  const out1 = tempDir('media-rb-o1');
  assert.throws(() => rollbackCoreIdentityCopy(path.join(dir, 'scoutbox.db'), out1), (err) => err.code === 'MEDIA_QUEUE_PENDING' && /media-gone|1 media file/.test(err.message));
  assert.deepEqual(fs.readdirSync(out1), []);
  const script = path.join(HERE, 'coreIdentityRollback.mjs');
  try { execFileSync(process.execPath, [script, dir, path.join(tempDir('media-rb-cli'), 'x')], { stdio: 'pipe' }); assert.fail('should refuse'); } catch (err) { assert.equal(err.status, 8); }
  s = openRaw(dir); s.prepare('DELETE FROM media_deletions').run(); s.close(); // the sweep removed the file and cleared the entry
  const out2 = tempDir('media-rb-o2');
  const result = rollbackCoreIdentityCopy(path.join(dir, 'scoutbox.db'), out2);
  assert.equal(result.recordRemoved, true);
  const o = openRaw(out2);
  assert.equal(o.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_deletions'").get().n, 0, 'the table is gone');
  assert.deepEqual(o.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live']);
  assert.deepEqual(migrate(o, { now: NOW }).ran, ['0005_core_identity_live', '0006_media_deletions'], 're-upgrade: both steps run again');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n, 0);
  o.close(); rm(dir, out1, out2);
});

console.log(`\n${passed} media-deletion checks passed`);
