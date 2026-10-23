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
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { rollbackOutboxPushCopy } from '../repositories/outboxPushRollback.mjs';
import { rollbackChannelsCopy } from '../repositories/channelsRollback.mjs';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';
import { rollbackPlayerErasureCopy } from '../repositories/playerErasureRollback.mjs';
import { rollbackRecruitmentCopy } from '../repositories/recruitmentRollback.mjs';
import { rollbackRecruitmentCasesCopy } from '../repositories/recruitmentCasesRollback.mjs';
import { createStorage } from '../adapters.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, adult, s3File, migrate, openRaw, applied, blob, dump } from './coreIdentityTestFixtures.mjs';
// S6b: a file this tree wrote carries 0013 too; the S7d tool refuses a later schema step, so the rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6b = (file) => { const s8b = tempDir('s8b-to-s8a'); rollbackRecruitmentCasesCopy(file, s8b); /* S8b: the file carries 0016; its rollback (copy-only, the cases and the four room collections written back as blobs) goes first */ const s8a = tempDir('s8a-to-s4br'); rollbackRecruitmentCopy(path.join(s8b, 'scoutbox.db'), s8a); /* then S8a (requests and trials written back as blobs) */ const s4br = tempDir('s4br-to-s6b'); rollbackPlayerErasureCopy(path.join(s8a, 'scoutbox.db'), s4br); /* then S4b-R */ const out = tempDir('s6b-to-s7d'); rollbackSafetyAuditCopy(path.join(s4br, 'scoutbox.db'), out); return path.join(out, 'scoutbox.db'); };

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
  const db = { orgs: [], users: [], sessions: [], players: [adult()], guardians: [], requests: [], vouches: [] };
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  storage.saveDataUrl('media-x', 'data:video/webm;base64,AAAA');
  // Rolled back: the queue entry, the player removal and the blob edit all go.
  assert.throws(() => store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); db.vouches.push({ id: 'r' }); throw new Error('boom'); }, { snapshot }), /boom/);
  assert.equal(layer.mediaDeletions.count(), 0); assert.equal(layer.players.count(), 1); assert.equal(db.vouches.length, 0);
  assert.ok(fs.existsSync(path.join(storageDir, 'media', 'media-x.webm')), 'the file was never touched');
  // Committed: the entry exists after COMMIT; processing then removes the file and clears the entry.
  let seenInside = null;
  store.unitOfWork(() => { layer.mediaDeletions.enqueue(['media-x'], { playerId: 'pl-adult', at: NOW }); layer.players.remove('pl-adult'); seenInside = layer.mediaDeletions.isQueued('media-x'); }, { snapshot });
  assert.equal(seenInside, true); assert.equal(layer.mediaDeletions.count(), 1); assert.equal(layer.players.count(), 0);
  // A failure at the filesystem boundary (a directory now sits where the file was): the entry survives a reopen.
  fs.rmSync(path.join(storageDir, 'media', 'media-x.webm')); fs.mkdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 0, failed: 1, conflicts: 0 });
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  layer = attachDataLayer({ db: { ...store.load().db, players: [], guardians: [] }, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  assert.equal(layer.mediaDeletions.isQueued('media-x'), true); assert.equal(layer.report().mediaDeletions.queued, 1);
  fs.rmdirSync(path.join(storageDir, 'media', 'media-x.webm'));
  assert.deepEqual(layer.mediaDeletions.process(storage), { removed: 0, absent: 1, failed: 0, conflicts: 0 }, 'absent now: cleared');
  assert.equal(layer.report().mediaDeletions.queued, 0);
  store.sqlite.close(); rm(dir, storageDir);
});

test('rollback tool: a copy whose queue is not empty is refused (MEDIA_QUEUE_PENDING, exit 8) and no output is left; once the queue drained the tool drops media_deletions with its migration record, and the real migration brings both back on re-upgrade', () => {
  const dir = tempDir('media-rb'); s3File(dir);
  let s = openRaw(dir); migrate(s, { now: NOW });
  transaction(s, () => createMediaDeletionsQueue({ sqlite: s, now: () => NOW }).enqueue(['media-gone'], { playerId: 'pl-adult', at: NOW }));
  s.close();
  // S5: the file carries 0007, which the S4a tool refuses outright (LATER_SCHEMA); the S5 rollback goes first and keeps the queue (both builds have it).
  const out0 = tempDir('media-rb-o0');
  assert.throws(() => rollbackCoreIdentityCopy(path.join(dir, 'scoutbox.db'), out0), (err) => err.code === 'LATER_SCHEMA' && /0007_player_subrecords/.test(err.message));
  assert.deepEqual(fs.readdirSync(out0), []);
  // S6a: the file carries 0008 too; the S6a rollback goes first (copy-only; the queue and everything else kept), then the S5 tool on its output.
  const s7c = tempDir('media-rb-s7c'); rollbackChannelsCopy(preS6b(path.join(dir, 'scoutbox.db')), s7c); /* S7d first: the file carries 0012 */ const s7b = tempDir('media-rb-s7b'); rollbackOutboxPushCopy(path.join(s7c, 'scoutbox.db'), s7b); const s7a = tempDir('media-rb-s7a'); rollbackDispatchesCopy(path.join(s7b, 'scoutbox.db'), s7a); const s6a = tempDir('media-rb-s6a'); rollbackNotificationsCopy(path.join(s7a, 'scoutbox.db'), s6a); const s5 = tempDir('media-rb-s5'); rollbackOneTimeCodesCopy(path.join(s6a, 'scoutbox.db'), s5); // S7a: the file carries 0009 too; its rollback goes first (copy-only, nothing lost)
  const s4a = tempDir('media-rb-s4a'); rollbackPlayerSubrecordsCopy(path.join(s5, 'scoutbox.db'), s4a);
  assert.equal(openRaw(s4a).prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n, 1, 'the S5 rollback keeps the pending queue entry');
  const out1 = tempDir('media-rb-o1');
  assert.throws(() => rollbackCoreIdentityCopy(path.join(s4a, 'scoutbox.db'), out1), (err) => err.code === 'MEDIA_QUEUE_PENDING' && /media-gone|1 media file/.test(err.message));
  assert.deepEqual(fs.readdirSync(out1), []);
  const script = path.join(HERE, 'coreIdentityRollback.mjs');
  try { execFileSync(process.execPath, [script, s4a, path.join(tempDir('media-rb-cli'), 'x')], { stdio: 'pipe' }); assert.fail('should refuse'); } catch (err) { assert.equal(err.status, 8); }
  s = openRaw(dir); s.prepare('DELETE FROM media_deletions').run(); s.close(); // the sweep removed the file and cleared the entry
  const s7c2 = tempDir('media-rb-s7c2'); rollbackChannelsCopy(preS6b(path.join(dir, 'scoutbox.db')), s7c2); const s7b2 = tempDir('media-rb-s7b2'); rollbackOutboxPushCopy(path.join(s7c2, 'scoutbox.db'), s7b2); const s7a2 = tempDir('media-rb-s7a2'); rollbackDispatchesCopy(path.join(s7b2, 'scoutbox.db'), s7a2); const s6a2 = tempDir('media-rb-s6a2'); rollbackNotificationsCopy(path.join(s7a2, 'scoutbox.db'), s6a2); const s52 = tempDir('media-rb-s52'); rollbackOneTimeCodesCopy(path.join(s6a2, 'scoutbox.db'), s52);
  const s4a2 = tempDir('media-rb-s4a2'); rollbackPlayerSubrecordsCopy(path.join(s52, 'scoutbox.db'), s4a2);
  const out2 = tempDir('media-rb-o2');
  const result = rollbackCoreIdentityCopy(path.join(s4a2, 'scoutbox.db'), out2);
  assert.equal(result.recordRemoved, true);
  const o = openRaw(out2);
  assert.equal(o.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_deletions'").get().n, 0, 'the table is gone');
  assert.deepEqual(o.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live']);
  assert.deepEqual(migrate(o, { now: NOW }).ran, ['0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases'], 're-upgrade: the steps run again (0015 included)');
  assert.equal(o.prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n, 0);
  o.close(); rm(dir, out1, out2);
});

test('backup/restore pieces (review of 9656a4b): the queue travels as the mediaDeletions collection — a snapshot tool reads it from the table and writes it back through the table, validated whole (a path instead of an id, an unknown field, a duplicate, a bad time or a non-array refuses the save with nothing written); before migration 0006 the tool writes it as a blob and the migration imports and retires it; a tampered blob aborts the migration whole, keeps the blob, creates nothing and refuses again on the next run; a stale in-memory array at boot is reported, dropped and its blob row deleted — the queue never imports from memory', () => {
  // (a) A migrated file, snapshot mode: read from the table, written back through it.
  const dir = tempDir('media-snap'); s3File(dir); { const s = openRaw(dir); migrate(s, { now: NOW }); s.close(); }
  let tool = openStore(dir);
  assert.deepEqual(tool.load().db.mediaDeletions, [], 'the collection is present (empty) once 0006 is recorded');
  { const s = openRaw(dir); transaction(s, () => createMediaDeletionsQueue({ sqlite: s, now: () => NOW }).enqueue(['media-q'], { playerId: 'pl-gone', at: NOW })); s.close(); }
  tool.sqlite.close(); tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.mediaDeletions, [{ media_id: 'media-q', player_id: 'pl-gone', queued_at: NOW, attempts: 0, last_attempt_at: null, last_error: null }], 'read from the table in its stored form');
  snap.db.mediaDeletions[0].attempts = 2; snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 });
  tool.save(snap);
  assert.deepEqual(tool.sqlite.prepare('SELECT media_id, attempts FROM media_deletions ORDER BY queued_at').all().map((r) => [r.media_id, r.attempts]), [['media-q', 2], ['media-r', 0]], 'written back through the table');
  assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'mediaDeletions'").get().n, 0, 'never a blob once the table is live');
  const before = dump(tool.sqlite); const seq = tool.revision();
  for (const [label, bad, re] of [
    ['a path instead of an id', [{ media_id: '../../etc/passwd', queued_at: 1 }], /MEDIA_QUEUE_IMPORT_BLOCKED.*is not a media id/],
    ['an unknown field', [{ media_id: 'media-x', queued_at: 1, path: '/tmp/x' }], /unknown field\(s\) path/],
    ['a duplicate', [{ media_id: 'media-q', queued_at: 1 }, { media_id: 'media-q', queued_at: 2 }], /duplicate media id/],
    ['a non-integer time', [{ media_id: 'media-x', queued_at: 'now' }], /queued_at must be an integer/],
  ]) {
    snap = tool.load(); snap.db.mediaDeletions = bad;
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`); assert.equal(dump(tool.sqlite), before, `${label}: nothing changed`); assert.equal(tool.revision(), seq);
  }
  snap = tool.load(); snap.db.mediaDeletions = { media_id: 'media-q' };
  assert.throws(() => tool.save(snap), /mediaDeletions: the snapshot collection must be an array/); assert.equal(dump(tool.sqlite), before);
  tool.sqlite.close();
  // (b) Before 0006 (a restored backup is this path: db.json imported as blobs, then the migrations): the blob, then the import.
  const pre = tempDir('media-pre'); s3File(pre);
  tool = openStore(pre); snap = tool.load(); assert.equal(snap.db.mediaDeletions, undefined, 'nothing to read before the record');
  snap.db.mediaDeletions = [{ media_id: 'media-restored', player_id: 'pl-gone', queued_at: NOW, attempts: 1, last_attempt_at: NOW, last_error: 'EACCES' }];
  tool.save(snap);
  assert.deepEqual(blob(tool.sqlite, 'mediaDeletions').map((r) => r.media_id), ['media-restored'], 'written as a blob (no table yet)');
  tool.sqlite.close();
  { const s = openRaw(pre); assert.deepEqual(migrate(s, { now: NOW }).ran, ['0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases']);
    assert.deepEqual(s.prepare('SELECT media_id, attempts, last_error FROM media_deletions').all().map((r) => ({ ...r })), [{ media_id: 'media-restored', attempts: 1, last_error: 'EACCES' }], 'the migration imported the blob');
    assert.equal(blob(s, 'mediaDeletions'), undefined, 'and retired it'); s.close(); }
  // (c) A tampered blob aborts the migration whole; the next run refuses the same way.
  const bad = tempDir('media-bad'); s3File(bad, { extra: { mediaDeletions: [{ media_id: '../../outside', queued_at: 1 }] } });
  { const s = openRaw(bad);
    assert.throws(() => migrate(s, { now: NOW }), /MEDIA_QUEUE_IMPORT_BLOCKED.*is not a media id/);
    assert.equal(s.isTransaction, false);
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_deletions'").get().n, 0, 'nothing created');
    assert.deepEqual(applied(s).filter((id) => /^000[56]/.test(id)), ['0005_core_identity_live'], '0005 committed on its own; 0006 did not');
    assert.deepEqual(blob(s, 'mediaDeletions'), [{ media_id: '../../outside', queued_at: 1 }], 'the blob is kept, imported by nothing');
    assert.throws(() => migrate(s, { now: NOW }), /MEDIA_QUEUE_IMPORT_BLOCKED/, 'the next run refuses the same way'); s.close(); }
  // (d) A stale in-memory array at boot (server mode): reported, dropped, its blob row deleted, the table untouched.
  { const store = openStore(dir, { tableBacked: TABLE_BACKED }); const warnings = [];
    store.sqlite.prepare("INSERT INTO collections (name, value) VALUES ('mediaDeletions', '[]')").run();
    const db = { ...store.load().db, players: [], guardians: [], mediaDeletions: [{ media_id: 'media-stale', queued_at: 1 }] };
    const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
    assert.ok(warnings.some((w) => /media deletions: an in-memory array with 1 entry was ignored/.test(w)), JSON.stringify(warnings));
    assert.equal(Object.hasOwn(db, 'mediaDeletions'), false, 'the array is dropped from memory');
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name = 'mediaDeletions'").get().n, 0, 'the blob row is deleted');
    assert.deepEqual(layer.mediaDeletions.pending().map((r) => r.media_id), ['media-q', 'media-r'], 'the table is untouched');
    store.sqlite.close(); }
  rm(dir, pre, bad);
});

// ------------------------------------------------------------- ownership guard (review of 4ef9345)
// The invariant: a file referenced by ANY live player (`media[].id` on the
// authoritative identity records, read through the mapping) is never deleted by
// the removed-owner cleanup queue — whatever the queue entry's own player_id says.
test('ownership guard (review of 4ef9345): a queue entry naming a clip a live player still references is a conflict — the sweep retains it with a diagnostic and never unlinks the file (legitimate entries in the same sweep still complete), whether the entry names an unrelated player, no player or the owner itself, and an in-memory record not yet flushed counts too; once the owner is really gone the entry is a legitimate removal again', () => {
  const dir = tempDir('media-own'); s3File(dir); // FIXTURE: pl-seeded carries media med-1
  const s = openRaw(dir); migrate(s, { now: NOW });
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

test('ownership guard (review of 4ef9345): a snapshot whose FINAL state has a queue entry naming a live-referenced clip is refused whole — a queue-only write against the retained players, an identity-only write that adds the reference against the retained queue, and the migration importing a restored blob (nothing created, the blob kept, the next run refusing again); a consistent whole replacement that removes the owner and queues the file is accepted; a failure of the real COMMIT where the check participated leaves everything unchanged and the retry succeeds', () => {
  const dir = tempDir('media-own-snap'); s3File(dir); { const s = openRaw(dir); migrate(s, { now: NOW }); s.close(); }
  const tool = openStore(dir);
  const before = dump(tool.sqlite); const seq = tool.revision();
  const refused = (label, mutate, re) => {
    const snap = tool.load(); mutate(snap.db); snap.db.notes = [{ id: 'unrelated-change-in-the-same-save' }];
    assert.throws(() => tool.save(snap), re, label);
    assert.equal(tool.sqlite.isTransaction, false, `${label}: the transaction is closed`);
    assert.equal(dump(tool.sqlite), before, `${label}: nothing changed, the unrelated change included`);
    assert.equal(tool.revision(), seq, `${label}: the save revision did not advance`);
  };
  // Queue-only write: the entry names med-1, which pl-seeded still carries.
  refused('queue only', (d) => { d.mediaDeletions = [{ media_id: 'med-1', player_id: 'pl-unrelated', queued_at: NOW }]; }, /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*med-1.*pl-seeded/);
  // Identity-only write against a retained queue: the queue holds a legitimate entry; the new players give it an owner.
  { const s = openRaw(dir); s.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, ?, ?)').run('media-q', 'pl-gone', NOW); s.close(); }
  const withQueue = dump(tool.sqlite);
  { const snap = tool.load(); delete snap.db.mediaDeletions; snap.db.players.find((p) => p.id === 'pl-adult').media.push({ id: 'media-q', title: 'now mine', kind: 'video' }); snap.db.notes = [{ id: 'x' }];
    assert.throws(() => tool.save(snap), /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*media-q.*pl-adult/, 'identity-only write against the retained queue');
    assert.equal(dump(tool.sqlite), withQueue); assert.equal(tool.revision(), seq); }
  // Both supplied and consistent: pl-seeded is removed and its clip queued in the same snapshot — accepted.
  { const snap = tool.load(); snap.db.players = snap.db.players.filter((p) => p.id !== 'pl-seeded'); snap.db.mediaDeletions.push({ media_id: 'med-1', player_id: 'pl-seeded', queued_at: NOW }); tool.save(snap);
    assert.deepEqual(tool.sqlite.prepare('SELECT media_id FROM media_deletions ORDER BY media_id').all().map((r) => r.media_id), ['med-1', 'media-q']);
    assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-seeded'").get().n, 0); }
  // The real COMMIT fails on a valid write in which the check took part: nothing changes, the retry succeeds.
  const settled = dump(tool.sqlite); const seq2 = tool.revision();
  { const exec = tool.sqlite.exec.bind(tool.sqlite); let fired = 0;
    tool.sqlite.exec = (sql) => { if (sql === 'COMMIT' && !fired) { fired += 1; exec('PRAGMA defer_foreign_keys = ON'); exec('CREATE TABLE fault_parent (id TEXT PRIMARY KEY); CREATE TABLE fault_child (parent_id TEXT NOT NULL REFERENCES fault_parent(id))'); tool.sqlite.prepare('INSERT INTO fault_child (parent_id) VALUES (?)').run('missing'); } return exec(sql); };
    try { const snap = tool.load(); snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 }); snap.db.players[0].name = 'Renamed'; assert.throws(() => tool.save(snap), /FOREIGN KEY constraint failed/); } finally { tool.sqlite.exec = exec; }
    assert.equal(fired, 1); assert.equal(tool.sqlite.isTransaction, false); assert.equal(dump(tool.sqlite), settled); assert.equal(tool.revision(), seq2); }
  { const snap = tool.load(); snap.db.mediaDeletions.push({ media_id: 'media-r', player_id: null, queued_at: NOW + 1 }); snap.db.players[0].name = 'Renamed'; tool.save(snap); assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions WHERE media_id = 'media-r'").get().n, 1); assert.equal(tool.revision(), seq2 + 1); }
  tool.sqlite.close();
  // The migration importing a restored blob that names a live clip: aborted whole, the blob kept, 0005 recorded on its own, the next run refuses again.
  const bad = tempDir('media-own-bad'); s3File(bad, { extra: { mediaDeletions: [{ media_id: 'med-1', player_id: 'pl-unrelated-removed', queued_at: 1 }] } });
  { const s = openRaw(bad);
    assert.throws(() => migrate(s, { now: NOW }), /MEDIA_QUEUE_OWNERSHIP_CONFLICT.*med-1.*pl-seeded/);
    assert.equal(s.isTransaction, false);
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_deletions'").get().n, 0, 'nothing created');
    assert.deepEqual(applied(s).filter((id) => /^000[56]/.test(id)), ['0005_core_identity_live']);
    assert.deepEqual(blob(s, 'mediaDeletions').map((r) => r.media_id), ['med-1'], 'the blob is kept, imported by nothing');
    assert.throws(() => migrate(s, { now: NOW }), /MEDIA_QUEUE_OWNERSHIP_CONFLICT/, 'the next run refuses the same way'); s.close(); }
  rm(dir, bad);
});

console.log(`\n${passed} media-deletion checks passed`);
