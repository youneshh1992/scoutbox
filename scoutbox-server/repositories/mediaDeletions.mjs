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
 */
export function createMediaDeletionsQueue({ sqlite, log = () => {}, warn = () => {}, now = Date.now }) {
  if (!sqlite) throw new TypeError('the media-deletion queue needs a SQLite connection (node:sqlite)');
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_deletions'").get()) throw new Error('media deletions: the media_deletions table does not exist (migration 0006 has not run)');
  const stmt = {
    insert: sqlite.prepare('INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, ?, ?) ON CONFLICT(media_id) DO UPDATE SET player_id = excluded.player_id, queued_at = excluded.queued_at'),
    pending: sqlite.prepare('SELECT media_id, player_id, queued_at, attempts, last_attempt_at, last_error FROM media_deletions ORDER BY queued_at, media_id'),
    isQueued: sqlite.prepare('SELECT 1 FROM media_deletions WHERE media_id = ?'),
    done: sqlite.prepare('DELETE FROM media_deletions WHERE media_id = ?'),
    failed: sqlite.prepare('UPDATE media_deletions SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE media_id = ?'),
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
    /**
     * Remove every queued file through `storage`; never inside a transaction
     * (each outcome is its own autocommit statement, so a crash mid-sweep loses
     * at most the bookkeeping of files already removed, which the next sweep
     * finds absent and clears).
     */
    process(storage) {
      if (sqlite.isTransaction) throw new Error('media deletions: process() runs outside any transaction');
      const out = { removed: 0, absent: 0, failed: 0 };
      for (const row of stmt.pending.all()) {
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
      if (out.removed || out.absent || out.failed) log(`media deletions: ${out.removed} file(s) removed, ${out.absent} already absent, ${out.failed} still queued`);
      return out;
    },
  };
}
