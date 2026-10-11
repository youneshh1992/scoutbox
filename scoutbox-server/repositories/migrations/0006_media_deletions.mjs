/**
 * The media-deletion queue (migration plan step S4a; readiness review §7.4,
 * §9 item 14). Deleting a player removes their media FILES from object
 * storage, which is outside the database transaction. The intent to remove a
 * file is queued HERE, inside the same transaction that removes the player, so
 * a crash between the commit and the file removal leaves a row that the next
 * boot (and every sweep) retries; a queue entry goes only once the file is gone
 * or was already absent. While an entry exists the file is never served.
 *
 * Nothing else references this table and it references nothing: the pre-S4
 * build ignores it, and the rollback tool removes it (and this record) when
 * the queue is empty — and refuses while it is not, so a pre-S4 build can
 * never serve media the S4 build had already decided to remove.
 */
import { validateMediaDeletionRows, writeMediaDeletionRows } from '../mediaDeletions.mjs';

export const id = '0006_media_deletions';
export const note = 'crash-safe queue of media files to remove after a player deletion commits';

export const MEDIA_DELETIONS_DDL = `
    CREATE TABLE media_deletions (
      media_id        TEXT PRIMARY KEY,
      player_id       TEXT,
      queued_at       INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error      TEXT
    ) STRICT;
    CREATE INDEX media_deletions_queued ON media_deletions (queued_at);`;

export function up(sqlite) {
  sqlite.exec(MEDIA_DELETIONS_DDL);
  // A restored backup — `db.json` imported as blobs by the store before the
  // migrations run — carries the queue of the server it was taken from as a
  // `mediaDeletions` blob (review of 9656a4b, finding 2). It is imported here,
  // inside the migration's transaction, entry by entry through the queue's own
  // validation: one invalid entry aborts the migration (nothing is removed on
  // the strength of a tampered file), the file stays as it was, and the next
  // boot refuses the same way. The blob is then retired. A database without
  // it — a first installation, a backup from a build without the queue —
  // imports nothing.
  const hasCollections = !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get();
  const blobRow = hasCollections ? sqlite.prepare("SELECT value FROM collections WHERE name = 'mediaDeletions'").get() : null;
  if (!blobRow) return;
  let rows;
  try { rows = JSON.parse(blobRow.value); } catch { throw Object.assign(new Error('MEDIA_QUEUE_IMPORT_BLOCKED: the mediaDeletions blob is not valid JSON; nothing was imported'), { code: 'MEDIA_QUEUE_IMPORT_BLOCKED' }); }
  writeMediaDeletionRows(sqlite, validateMediaDeletionRows(rows, { label: 'the mediaDeletions blob' }));
  sqlite.prepare("DELETE FROM collections WHERE name = 'mediaDeletions'").run();
}
