/**
 * The media-deletion queue over `media_deletions` (migration 0006). The
 * database decides WHAT must disappear, inside the deletion's transaction;
 * the filesystem (or the object store) is a separate boundary and is handled
 * after COMMIT, retried until it succeeds. The row is the source of truth for
 * "this file is gone or going": `/media/:id` refuses a queued id before it
 * looks at storage, so a file whose removal is still pending is never served.
 *
 *   enqueue(ids, { playerId, at })  — inside the caller's open transaction only
 *   process(storage)                — after commit: remove each queued file,
 *                                     drop the row when storage reports the
 *                                     file removed or already absent, keep it
 *                                     (attempts + 1, the error) otherwise
 *   isQueued(id) / pending() / count()
 *
 * `storage.delete(id)` must resolve the filesystem truthfully: it returns the
 * number of files removed (0 when none existed) and THROWS on any error other
 * than "absent" — a permission problem must keep the row, never clear it.
 *
 * Backups and restores (review of 9656a4b, finding 2): the queue lives only in
 * this table, so a snapshot of the database carries it as the `mediaDeletions`
 * collection, in the rows' stored form (`pending()`; `MEDIA_DELETIONS_TABLE`
 * for the snapshot tools). A file whose removal is queued is never copied into
 * a backup — a backup must not carry a file without the intent to remove it —
 * and the restored server imports the queue (migration 0006 on a restored
 * `db.json`, `MEDIA_DELETIONS_TABLE.replace` for a snapshot tool), serves
 * nothing for those ids and finishes the removal at boot. Every imported entry
 * is validated (a media id is `[a-z0-9-]+`, so an entry can never name a path
 * outside the media directory); one invalid entry refuses the whole import.
 */
import { migrationApplied } from './database.mjs';
import { PLAYER_COLUMNS, playerFromRow } from './identityMapping.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from './identityPreflight.mjs';
import { subrecordsLive } from './playerSubrecords.mjs';

export const MEDIA_DELETIONS_MIGRATION = '0006_media_deletions';

// ------------------------------------------------------------ the ownership invariant (review of 4ef9345)
// A file referenced by ANY live player must never be deleted by the removed-owner
// cleanup queue. A queue entry's own player_id is metadata, not proof that the
// file is unowned: the authority is the identity records themselves — every
// `media[].id` a live player carries — read through the established mapping
// (whatever facets layout the row was written in). The invariant is checked
// wherever queue rows become authoritative (a restored blob imported by migration
// 0006, a snapshot written through MEDIA_DELETIONS_TABLE, an identity write that
// gives a queued id an owner) and again at the execution boundary (every sweep),
// so a conflicting entry that is already stored is retained with a diagnostic
// and never acted on.
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Every media id a live player references, with the ids of the players that
 * carry it: the authoritative players table once the identity cutover is
 * recorded (rows decoded through the mapping), the `players` blob before it
 * (a snapshot tool on a pre-S4 file, a restored db.json before 0005 ran), plus
 * any `records` the caller holds (the server's in-memory view, so an upload
 * whose facet is not flushed yet counts too).
 */
export function liveMediaReferences(sqlite, { records = [] } = {}) {
  const refs = new Map();
  const add = (p) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.media)) return;
    for (const m of p.media) {
      const id = m?.id;
      if (typeof id !== 'string') continue;
      if (!refs.has(id)) refs.set(id, []);
      if (!refs.get(id).includes(p.id)) refs.get(id).push(p.id);
    }
  };
  if (subrecordsLive(sqlite)) {
    // S5: the clips are rows of player_media; every row is a live player's reference (the rows cascade with the player row).
    for (const r of sqlite.prepare('SELECT player_id, id FROM player_media ORDER BY player_id, position').all()) {
      if (!refs.has(r.id)) refs.set(r.id, []);
      if (!refs.get(r.id).includes(r.player_id)) refs.get(r.id).push(r.player_id);
    }
  } else if (migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) {
    for (const r of sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players`).all()) add(playerFromRow(r));
  } else if (tableExists(sqlite, 'collections')) {
    const b = sqlite.prepare("SELECT value FROM collections WHERE name = 'players'").get();
    let arr = null;
    if (b) { try { arr = JSON.parse(b.value); } catch { arr = null; } }
    if (Array.isArray(arr)) for (const p of arr) add(p);
  }
  for (const p of records) add(p);
  return refs;
}

/** The queue entries (given, or the stored ones) that name a live-referenced media id: `[{ media_id, owners }]`, ids only. */
export function mediaQueueConflicts(sqlite, rows = null, { records = [] } = {}) {
  const entries = rows ?? (tableExists(sqlite, 'media_deletions') ? sqlite.prepare('SELECT media_id FROM media_deletions ORDER BY queued_at, media_id').all() : []);
  if (!entries.length) return [];
  const refs = liveMediaReferences(sqlite, { records });
  return entries.filter((r) => refs.has(r.media_id)).map((r) => ({ media_id: r.media_id, owners: refs.get(r.media_id).slice() }));
}

/** The stable, actionable refusal: ids only, never a record. */
export function ownershipConflictError(conflicts, { label = 'the media-removal queue' } = {}) {
  const list = conflicts.map((c) => `${c.media_id} (player ${c.owners.join(', ')})`);
  const err = new Error(`MEDIA_QUEUE_OWNERSHIP_CONFLICT: ${conflicts.length} queued removal${conflicts.length === 1 ? '' : 's'} in ${label} name${conflicts.length === 1 ? 's' : ''} media a live player still references — ${list.slice(0, 20).join('; ')}${list.length > 20 ? '; …' : ''}; nothing was removed and the write was rolled back; resolve the queue entry or the player's reference by hand before retrying`);
  err.code = 'MEDIA_QUEUE_OWNERSHIP_CONFLICT';
  err.conflicts = conflicts;
  return err;
}

/** Throw MEDIA_QUEUE_OWNERSHIP_CONFLICT when the stored queue conflicts with the live references as they stand NOW (inside the caller's transaction, so the refusal rolls the whole write back). No-op before migration 0006. */
export function assertMediaQueueConsistent(sqlite, { label, records = [] } = {}) {
  if (!tableExists(sqlite, 'media_deletions')) return [];
  const conflicts = mediaQueueConflicts(sqlite, null, { records });
  if (conflicts.length) throw ownershipConflictError(conflicts, { label });
  return conflicts;
}
const MEDIA_ID = /^[a-z0-9-]+$/i;
const ROW_FIELDS = ['media_id', 'player_id', 'queued_at', 'attempts', 'last_attempt_at', 'last_error'];

/** Validate one exported queue entry without coercion: `{ ok: true, row }` or `{ ok: false, reason }`. */
export function validateMediaDeletionRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const unknown = Object.keys(raw).filter((k) => !ROW_FIELDS.includes(k));
  if (unknown.length) return { ok: false, reason: `unknown field(s) ${unknown.join(', ')}` };
  const { media_id, player_id = null, queued_at, attempts = 0, last_attempt_at = null, last_error = null } = raw;
  if (typeof media_id !== 'string' || !MEDIA_ID.test(media_id)) return { ok: false, reason: `${JSON.stringify(media_id)} is not a media id` };
  if (player_id !== null && typeof player_id !== 'string') return { ok: false, reason: 'player_id must be a string or null' };
  if (!Number.isSafeInteger(queued_at)) return { ok: false, reason: 'queued_at must be an integer' };
  if (!Number.isSafeInteger(attempts) || attempts < 0) return { ok: false, reason: 'attempts must be a non-negative integer' };
  if (last_attempt_at !== null && !Number.isSafeInteger(last_attempt_at)) return { ok: false, reason: 'last_attempt_at must be an integer or null' };
  if (last_error !== null && typeof last_error !== 'string') return { ok: false, reason: 'last_error must be a string or null' };
  return { ok: true, row: { media_id, player_id, queued_at, attempts, last_attempt_at, last_error } };
}

/** Validate a whole exported queue; throws `MEDIA_QUEUE_IMPORT_BLOCKED` naming entries and reasons (ids only, never a file). */
export function validateMediaDeletionRows(rows, { label = 'the mediaDeletions collection' } = {}) {
  const blocked = (detail) => { const err = new Error(`MEDIA_QUEUE_IMPORT_BLOCKED: ${detail}; nothing was imported`); err.code = 'MEDIA_QUEUE_IMPORT_BLOCKED'; return err; };
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of queue entries (got ${rows === null ? 'null' : typeof rows})`);
  const out = []; const problems = []; const seen = new Set();
  rows.forEach((raw, i) => {
    const v = validateMediaDeletionRow(raw);
    if (!v.ok) { problems.push(`entry #${i}: ${v.reason}`); return; }
    if (seen.has(v.row.media_id)) { problems.push(`entry #${i}: duplicate media id`); return; }
    seen.add(v.row.media_id); out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`);
  return out;
}

/** Rewrite the table from validated rows, inside the caller's transaction. */
export function writeMediaDeletionRows(sqlite, rows) {
  sqlite.exec('DELETE FROM media_deletions');
  const ins = sqlite.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at, attempts, last_attempt_at, last_error) VALUES (@media_id, @player_id, @queued_at, @attempts, @last_attempt_at, @last_error)');
  for (const r of rows) ins.run(r);
  return rows.length;
}

/**
 * Whole-snapshot access for the tools (backups, restores, the persistence
 * suites): the queue as rows in their stored form. `read` returns null before
 * migration 0006 is recorded (the caller keeps whatever blob it holds);
 * `replace` returns false before it (the caller writes the blob, which the
 * migration imports on the next boot), otherwise validates every entry and
 * rewrites the table inside the caller's transaction — one invalid entry
 * refuses the whole write.
 */
export const MEDIA_DELETIONS_TABLE = {
  name: 'mediaDeletions',
  read(sqlite) {
    if (!migrationApplied(sqlite, MEDIA_DELETIONS_MIGRATION)) return null;
    return sqlite.prepare('SELECT media_id, player_id, queued_at, attempts, last_attempt_at, last_error FROM media_deletions ORDER BY queued_at, media_id').all().map((r) => ({ ...r }));
  },
  replace(sqlite, rows) {
    if (!migrationApplied(sqlite, MEDIA_DELETIONS_MIGRATION)) return false;
    if (!sqlite.isTransaction) throw new Error('media deletions: replace() runs inside the caller\'s transaction');
    writeMediaDeletionRows(sqlite, validateMediaDeletionRows(rows));
    // The FINAL state: the identity pair is written before the queue, so the players table is the snapshot's (or the retained one).
    assertMediaQueueConsistent(sqlite, { label: 'the mediaDeletions collection' });
    return true;
  },
};

/**
 * `liveRecords()` (optional) returns the player records the caller holds in
 * memory (the server's authoritative view): they count as live references
 * alongside the table, so an upload whose facet is not flushed yet is protected.
 */
export function createMediaDeletionsQueue({ sqlite, log = () => {}, warn = () => {}, now = Date.now, liveRecords = null }) {
  if (!sqlite) throw new TypeError('the media-deletion queue needs a SQLite connection (node:sqlite)');
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_deletions'").get()) throw new Error('media deletions: the media_deletions table does not exist (migration 0006 has not run)');
  if (liveRecords !== null && typeof liveRecords !== 'function') throw new TypeError('media deletions: liveRecords must be a function returning the live player records, or null');
  const held = () => { const r = liveRecords ? liveRecords() : []; return Array.isArray(r) ? r : Array.from(r ?? []); };
  const stmt = {
    insert: sqlite.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, ?, ?) ON CONFLICT(media_id) DO UPDATE SET player_id = excluded.player_id, queued_at = excluded.queued_at'),
    pending: sqlite.prepare('SELECT media_id, player_id, queued_at, attempts, last_attempt_at, last_error FROM media_deletions ORDER BY queued_at, media_id'),
    isQueued: sqlite.prepare('SELECT 1 FROM media_deletions WHERE media_id = ?'),
    done: sqlite.prepare('DELETE FROM media_deletions WHERE media_id = ?'),
    failed: sqlite.prepare('UPDATE media_deletions SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE media_id = ?'),
    // A conflict is not an attempt: the diagnostic is recorded, the attempt count is not touched.
    conflict: sqlite.prepare('UPDATE media_deletions SET last_attempt_at = ?, last_error = ? WHERE media_id = ?'),
    count: sqlite.prepare('SELECT COUNT(*) AS n FROM media_deletions'),
  };
  const idOk = (id) => typeof id === 'string' && /^[a-z0-9-]+$/i.test(id);
  return {
    /** Queue the removal of these media files; runs only inside the transaction that removes their owner. */
    enqueue(mediaIds, { playerId = null, at = now() } = {}) {
      if (!sqlite.isTransaction) throw new Error('media deletions: enqueue() runs inside the deletion\'s transaction (a unit of work), never on its own');
      let n = 0;
      for (const id of mediaIds) {
        if (!idOk(id)) throw new TypeError(`media deletions: ${JSON.stringify(id)} is not a media id`);
        stmt.insert.run(id, playerId, at); n += 1;
      }
      return n;
    },
    isQueued: (id) => idOk(id) && !!stmt.isQueued.get(id),
    pending: () => stmt.pending.all().map((r) => ({ ...r })),
    count: () => stmt.count.get().n,
    /** The stored entries that name a clip a live player still references (`[{ media_id, owners }]`), judged against the table and the held records right now. */
    conflicts: () => mediaQueueConflicts(sqlite, stmt.pending.all(), { records: held() }),
    /**
     * Remove every queued file through `storage`; never inside a transaction
     * (each outcome is its own autocommit statement, so a crash mid-sweep loses
     * at most the bookkeeping of files already removed, which the next sweep
     * finds absent and clears). The ownership invariant is checked first, on
     * the live references as they stand at this sweep: an entry that names a
     * clip a live player still carries is RETAINED with a diagnostic
     * (`last_error`, the attempt count untouched) and storage is never asked to
     * remove it; it becomes a legitimate removal only if the reference really
     * goes. The other entries complete as usual.
     */
    process(storage) {
      if (sqlite.isTransaction) throw new Error('media deletions: process() runs outside any transaction');
      const out = { removed: 0, absent: 0, failed: 0, conflicts: 0 };
      const rows = stmt.pending.all();
      if (!rows.length) return out;
      const refs = liveMediaReferences(sqlite, { records: held() });
      const retained = [];
      for (const row of rows) {
        const owners = refs.get(row.media_id);
        if (owners) {
          out.conflicts += 1; retained.push(`${row.media_id} (player ${owners.join(', ')})`);
          stmt.conflict.run(now(), `OWNERSHIP_CONFLICT: still referenced by live player(s) ${owners.join(', ')}; not removed — resolve the queue entry or the player's reference by hand`.slice(0, 300), row.media_id);
          continue;
        }
        try {
          const removed = storage.delete(row.media_id);
          stmt.done.run(row.media_id);
          if (removed > 0) out.removed += 1; else out.absent += 1;
        } catch (err) {
          out.failed += 1;
          stmt.failed.run(now(), String(err?.message ?? err).slice(0, 300), row.media_id);
          warn(`media deletions: ${row.media_id} could not be removed (attempt ${row.attempts + 1}): ${String(err?.message ?? err).slice(0, 200)}; it stays queued and is never served`);
        }
      }
      if (retained.length) warn(`MEDIA_QUEUE_OWNERSHIP_CONFLICT: ${retained.length} queued removal(s) name media a live player still references and were retained, not removed: ${retained.slice(0, 20).join('; ')}${retained.length > 20 ? '; …' : ''}; nothing is served for these ids until the queue entry or the reference is resolved by hand`);
      if (out.removed || out.absent || out.failed) log(`media deletions: ${out.removed} file(s) removed, ${out.absent} already absent, ${out.failed} still queued`);
      return out;
    },
  };
}
