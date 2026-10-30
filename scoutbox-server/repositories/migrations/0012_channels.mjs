/**
 * Message threads become their own tables (migration plan step S7d;
 * docs/architecture/s7-readiness-review.md §11.5 as corrected by the independent
 * reviews of 46e5afe (§11.7) and 8330f08 (§11.8); approved by the Founder's two
 * explicit decisions D-A and D-B, recorded in §11.9). REGISTERED in DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0011 (outbox/push):
 *   1. Create `channels`, `messages` and `message_attachments` (CHANNELS_DDL).
 *   2. Import the `channels` blob the file holds through the repository's own
 *      validation: every thread (the openChannel literal), every nested message
 *      (the postMessage literal) and every attachment (the clip or the trial-report
 *      shape) is checked; nothing is coerced or normalised; the array position of a
 *      thread becomes `seq`, the array position of a message its `position`; a
 *      present legacy field (orgUserIdForNotify) and every unknown own field — at
 *      channel, message, attachment, readBy and sender level — is kept in
 *      `extra_json`; an absent optional key is recorded in `absent_keys_json` so the
 *      way back manufactures no null. The TRANSITIONAL CHECKED REFERENCE (D-A): a
 *      thread whose request is not in the file's `requests` blob, whose guardian is
 *      not in the `guardians` table or whose organisation is not in `orgs` refuses the
 *      step. ANY refusal aborts the whole migration with CHANNELS_IMPORT_BLOCKED
 *      (positions, ids and reasons — never a message text, a name or an address):
 *      the runner rolls back, the blob and saveSeq are untouched, the next boot
 *      refuses the same way.
 *   3. Retire the blob row; record the counts in `meta.channelsCutover`.
 * A file without a blob (a first installation) creates the tables and imports
 * nothing — never from the seed, never from memory. The step never runs twice
 * (recorded) and refuses to run before 0011 or when any of the three tables already
 * exists.
 */
import { migrationApplied } from '../database.mjs';
import { OUTBOX_PUSH_MIGRATION } from '../outboxPush.mjs';
import { CHANNELS_MIGRATION, CHANNELS_CUTOVER_META, CHANNELS_DDL, CHANNELS_TABLES, importChannelsBlob } from '../channels.mjs';

export const id = CHANNELS_MIGRATION;
export const note = 'message threads become their own tables (channels, messages, message_attachments; insertion and message order kept; legacy and unknown fields kept at every level; absent optional keys preserved as absent; the request, guardian and organisation references checked — D-A/D-B approved)';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION)) throw new Error(`${id}: ${OUTBOX_PUSH_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = CHANNELS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(CHANNELS_DDL);
  const counts = importChannelsBlob(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CHANNELS_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
