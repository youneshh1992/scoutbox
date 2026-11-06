// The media-deletion queue (repositories/mediaDeletions.mjs, migration 0006):
// an entry is written inside the deletion's transaction, processed after COMMIT
// through the storage adapter, retried while the adapter fails, cleared only
// once the file is gone or was already absent. Temporary databases and
// directories only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createMediaDeletionsQueue } from '../repositories/mediaDeletions.mjs';
import { createStorage } from '../adapters.mjs';
import { openStore } from '../store.mjs';
import { NOW, T0, TTL, tempDir, adult, FIXTURE, ORGS, USERS, openRaw, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
/** A saved database holding the identity fixture (pl-seeded carries media med-1), written by a snapshot-mode save. */
function savedFile(dir) { const t = openStore(dir); t.save({ savedAt: T0, idCounter: 1000, db: { orgs: ORGS(), users: USERS(), ...FIXTURE() } }); t.sqlite.close(); }
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
  assert.deepEqual(q.process(st), { removed: 1, absent: 0, failed: 1, conflicts: 0 }); assert.deepEqual(st.calls, ['media-1', 'media-2']);
  assert.equal(q.isQueued('media-1'), false); assert.equal(q.isQueued('media-2'), true);
  assert.deepEqual(q.pending().map((r) => [r.media_id, r.attempts, r.last_attempt_at, r.last_error]), [['media-2', 1, NOW, 'EACCES: permission denied']]);
  // The retry: still failing → attempts 2; then absent (0 files) → cleared: the entry goes only when the file is gone.
  assert.deepEqual(q.process(fakeStorage({ 'media-2': new Error('still locked') })), { removed: 0, absent: 0, failed: 1, conflicts: 0 }); assert.equal(q.pending()[0].attempts, 2);
  assert.deepEqual(q.process(fakeStorage({ 'media-2': 0 })), { removed: 0, absent: 1, failed: 0, conflicts: 0 }); assert.equal(q.count(), 0);
  assert.deepEqual(q.process(fakeStorage()), { removed: 0, absent: 0, failed: 0, conflicts: 0 }, 'an empty queue is a no-op');
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
  let layer = attachDataLayer({ db: {}, seed: { orgs: [], players: [adult()], guardians: [] }, store, nextId, sessionTtlMs: TTL, now: () => NOW });
  storage.saveDataUrl('media-x', 'data:video/webm;base64,AAAA');
  // Rolled back: the queue entry and the player removal both go (S14a: the blob edit that went with them is gone).
  assert.throws(() => store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); throw new Error('boom'); }), /boom/);
  assert.equal(layer.mediaDeletions.count(), 0); assert.equal(layer.players.count(), 1); assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-adult'").get().n, 1);
  assert.ok(fs.existsSync(path.join(storageDir, 'media', 'media-x.webm')), 'the file was never touched');
  // Committed: the entry exists after COMMIT; processing then removes the file and clears the entry.
  let seenInside = null;
  store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); seenInside = layer.mediaDeletions.isQueued('media-x'); });
  assert.equal(seenInside, true); assert.equal(layer.mediaDeletions.count(), 1); assert.equal(layer.players.count(), 0);
  // A failure at the filesystem boundary (a directory now sits where the file was): the entry survives a reopen.
  fs.rmSync(path.join(storageDir, 'media', 'media-x.webm')); fs.mkdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 0, failed: 1, conflicts: 0 });
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: {}, store, nextId, sessionTtlMs: TTL, now: () => NOW });
  assert.equal(layer.mediaDeletions.isQueued('media-x'), true); assert.equal(layer.report().mediaDeletions.queued, 1);
  fs.rmdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 1, failed: 0, conflicts: 0 }, 'absent now: cleared');
  assert.equal(layer.report().mediaDeletions.queued, 0);
  store.sqlite.close(); rm(dir, storageDir);
});

test('snapshot tools: the queue is the mediaDeletions collection — a snapshot tool reads it from the table and writes it back through the table, validated whole (a path instead of an id, an unknown field, a duplicate, a bad time or a non-array refuses the save with nothing written); a stale array handed in at boot is ignored — the queue never imports from memory', () => {
  // (a) A migrated file, snapshot mode: read from the table, written back through it.
  const dir = tempDir('media-snap'); savedFile(dir);
  let tool = openStore(dir);
  assert.deepEqual(tool.load().db.mediaDeletions, [], 'the collection is present (empty)');
  { const s = openRaw(dir); transaction(s, () => createMediaDeletionsQueue({ sqlite: s, now: () => NOW }).enqueue(['media-q'], { playerId: 'pl-gone', at: NOW })); s.close(); }
  tool.sqlite.close(); tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.mediaDeletions, [{ media_id: 'media-q', player_id: 'pl-gone', queued_at: NOW, attempts: 0, last_attempt_at: null, last_error: null }], 'read from the table in its stored form');
  snap.db.mediaDeletions[0].attempts = 2; snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 });
  tool.save(snap);
  assert.deepEqual(tool.sqlite.prepare('SELECT media_id, attempts FROM media_deletions ORDER BY queued_at').all().map((r) => [r.media_id, r.attempts]), [['media-q', 2], ['media-r', 0]], 'written back through the table');
  const before = dump(tool.sqlite);
  for (const [label, bad, re] of [
    ['a path instead of an id', [{ media_id: '../../etc/passwd', queued_at: 1 }], /MEDIA_QUEUE_IMPORT_BLOCKED.*is not a media id/],
    ['an unknown field', [{ media_id: 'media-x', queued_at: 1, path: '/tmp/x' }], /unknown field\(s\) path/],
    ['a duplicate', [{ media_id: 'media-q', queued_at: 1 }, { media_id: 'media-q', queued_at: 2 }], /duplicate media id/],
    ['a non-integer time', [{ media_id: 'media-x', queued_at: 'now' }], /queued_at must be an integer/],
  ]) {
    snap = tool.load(); snap.db.mediaDeletions = bad;
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`); assert.equal(dump(tool.sqlite), before, `${label}: nothing changed`);
  }
  snap = tool.load(); snap.db.mediaDeletions = { media_id: 'media-q' };
  assert.throws(() => tool.save(snap), /mediaDeletions: the snapshot collection must be an array/); assert.equal(dump(tool.sqlite), before);
  tool.sqlite.close();
  // (b) A stale array handed in at boot (server mode): ignored, the table untouched (rewritten in S14a: the blob row it deleted no longer exists).
  { const store = openStore(dir, { tableBacked: TABLE_BACKED });
    const layer = attachDataLayer({ db: {}, seed: { players: [], guardians: [], mediaDeletions: [{ media_id: 'media-stale', queued_at: 1 }] }, store, nextId, sessionTtlMs: TTL, now: () => NOW });
    assert.equal(layer.mediaDeletions.isQueued('media-stale'), false, 'never imported');
    assert.deepEqual(layer.mediaDeletions.pending().map((r) => r.media_id), ['media-q', 'media-r'], 'the table is untouched');
    store.sqlite.close(); }
  rm(dir);
});

// ------------------------------------------------------------- ownership guard (review of 4ef9345)
// The invariant: a file referenced by ANY live player (`media[].id` on the
// authoritative identity records, read through the mapping) is never deleted by
// the removed-owner cleanup queue — whatever the queue entry's own player_id says.
test('ownership guard: a queue entry naming a clip a live player still references is a conflict — the sweep retains it with a diagnostic and never unlinks the file (legitimate entries in the same sweep still complete), whether the entry names an unrelated player, no player or the owner itself, and an in-memory record not yet flushed counts too; once the owner is really gone the entry is a legitimate removal again', () => {
  const dir = tempDir('media-own'); savedFile(dir); // FIXTURE: pl-seeded carries media med-1
  const s = openRaw(dir);
  const warnings = [];
  const q = createMediaDeletionsQueue({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  const row = (id, playerId) => s.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, ?, ?)').run(id, playerId, NOW);
  row('med-1', 'pl-unrelated-removed'); row('media-free', 'pl-gone');
  assert.deepEqual(q.conflicts(), [{ media_id: 'med-1', owners: ['pl-seeded'] }], 'the conflict names the media id and the live owner, never the record');
  let st = fakeStorage({ 'media-free': 0 });
  assert.deepEqual(q.process(st), { removed: 0, absent: 1, failed: 0, conflicts: 1 });
  assert.deepEqual(st.calls, ['media-free'], 'storage is never asked to remove a live-referenced id');
  const kept = s.prepare('SELECT media_id, attempts, last_error FROM media_deletions').all().map((r) => ({ ...r }));
  assert.deepEqual(kept.map((r) => [r.media_id, r.attempts]), [['med-1', 0]], 'the conflicting entry is retained (not an attempt); the legitimate one was cleared');
  assert.match(kept[0].last_error, /OWNERSHIP_CONFLICT.*pl-seeded/);
  assert.ok(warnings.some((w) => /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*med-1.*pl-seeded/.test(w)), JSON.stringify(warnings));
  assert.deepEqual(q.process(fakeStorage()).conflicts, 1, 'a later sweep does not delete it either');
  // The entry's own player_id proves nothing: the owner itself, or no player, is a conflict just the same.
  s.prepare('DELETE FROM media_deletions').run(); row('med-1', 'pl-seeded');
  assert.deepEqual(q.process(fakeStorage()), { removed: 0, absent: 0, failed: 0, conflicts: 1 });
  s.prepare('DELETE FROM media_deletions').run(); row('med-1', null);
  assert.deepEqual(q.process(fakeStorage()), { removed: 0, absent: 0, failed: 0, conflicts: 1 });
  // A record held in memory (an upload whose facet is not flushed yet) is a live reference too.
  const q2 = createMediaDeletionsQueue({ sqlite: s, now: () => NOW, warn: () => {}, liveRecords: () => [{ id: 'pl-mem', media: [{ id: 'media-mem' }] }] });
  s.prepare('DELETE FROM media_deletions').run(); row('media-mem', null);
  assert.deepEqual(q2.conflicts(), [{ media_id: 'media-mem', owners: ['pl-mem'] }]);
  assert.deepEqual(q2.process(fakeStorage()), { removed: 0, absent: 0, failed: 0, conflicts: 1 });
  // The owner really goes (today's hard delete, inside a transaction): the entry is legitimate again and completes.
  s.prepare('DELETE FROM media_deletions').run(); row('med-1', 'pl-seeded');
  transaction(s, () => s.prepare("DELETE FROM players WHERE id = 'pl-seeded'").run());
  assert.deepEqual(q.conflicts(), []);
  st = fakeStorage({ 'med-1': 1 });
  assert.deepEqual(q.process(st), { removed: 1, absent: 0, failed: 0, conflicts: 0 }); assert.equal(q.count(), 0);
  s.close(); rm(dir);
});

test('ownership guard: a snapshot whose FINAL state has a queue entry naming a live-referenced clip is refused whole — a queue-only write against the retained players, and an identity-only write that adds the reference against the retained queue; a consistent whole replacement that removes the owner and queues the file is accepted; a failure of the real COMMIT where the check participated leaves everything unchanged and the retry succeeds', () => {
  const dir = tempDir('media-own-snap'); savedFile(dir);
  const tool = openStore(dir);
  const before = dump(tool.sqlite);
  const refused = (label, mutate, re) => {
    const snap = tool.load(); mutate(snap.db); snap.db.orgs[0].name = 'Unrelated change in the same save'; // S14a: an organisation edit replaces the blob-only `notes`
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`);
    assert.equal(dump(tool.sqlite), before, `${label}: nothing changed, the unrelated change included`);
  };
  // Queue-only write: the entry names med-1, which pl-seeded still carries.
  refused('queue only', (d) => { d.mediaDeletions = [{ media_id: 'med-1', player_id: 'pl-unrelated', queued_at: NOW }]; }, /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*med-1.*pl-seeded/);
  // Identity-only write against a retained queue: the queue holds a legitimate entry; the new players give it an owner.
  { const s = openRaw(dir); s.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, ?, ?)').run('media-q', 'pl-gone', NOW); s.close(); }
  const withQueue = dump(tool.sqlite);
  { const snap = tool.load(); delete snap.db.mediaDeletions; snap.db.players.find((p) => p.id === 'pl-adult').media.push({ id: 'media-q', title: 'now mine', kind: 'video' }); snap.db.orgs[0].name = 'Unrelated change';
    assert.throws(() => tool.save(snap), /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*media-q.*pl-adult/, 'identity-only write against the retained queue');
    assert.equal(dump(tool.sqlite), withQueue); }
  // Both supplied and consistent: pl-seeded is removed and its clip queued in the same snapshot — accepted.
  { const snap = tool.load(); snap.db.players = snap.db.players.filter((p) => p.id !== 'pl-seeded'); snap.db.mediaDeletions.push({ media_id: 'med-1', player_id: 'pl-seeded', queued_at: NOW }); tool.save(snap);
    assert.deepEqual(tool.sqlite.prepare('SELECT media_id FROM media_deletions ORDER BY media_id').all().map((r) => r.media_id), ['med-1', 'media-q']);
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-seeded'").get().n, 0); }
  // The real COMMIT fails on a valid write in which the check took part: nothing changes, the retry succeeds.
  const settled = dump(tool.sqlite);
  { const exec = tool.sqlite.exec.bind(tool.sqlite); let fired = 0;
    tool.sqlite.exec = (sql) => { if (sql === 'COMMIT' && !fired) { fired += 1; exec('PRAGMA defer_foreign_keys = ON'); exec('CREATE TABLE fault_parent (id TEXT PRIMARY KEY); CREATE TABLE fault_child (parent_id TEXT NOT NULL REFERENCES fault_parent(id))'); tool.sqlite.prepare('INSERT INTO fault_child (parent_id) VALUES (?)').run('missing'); } return exec(sql); };
    try { const snap = tool.load(); snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 }); snap.db.players[0].name = 'Renamed'; assert.throws(() => tool.save(snap), /FOREIGN KEY constraint failed/); } finally { tool.sqlite.exec = exec; }
    assert.equal(fired, 1); assert.equal(tool.sqlite.isTransaction, false); assert.equal(dump(tool.sqlite), settled); }
  { const snap = tool.load(); snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 }); snap.db.players[0].name = 'Renamed'; tool.save(snap); assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions WHERE media_id = 'media-r'").get().n, 1); }
  tool.sqlite.close();
  rm(dir);
});

console.log(`\n${passed} media-deletion checks passed`);
