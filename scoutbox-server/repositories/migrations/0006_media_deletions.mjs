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
}
