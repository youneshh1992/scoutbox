/**
 * Notifications and category notification preferences become their own tables
 * (migration plan step S7a; docs/architecture/s7-readiness-review.md §5–§6).
 * REGISTERED in DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0008 (one-time codes):
 *   1. Create `notifications`, `notification_prefs` and
 *      `notification_pref_categories` (NOTIFICATIONS_DDL).
 *   2. Import the `notifications` and `notificationPrefs` blobs if the file
 *      holds them — the shape every earlier build wrote (and every backup
 *      holds) — through the repository's own validation: every entry is
 *      checked, nothing is coerced; the array position becomes the durable
 *      ordering key; a pre-M18.2 row is normalised exactly as the snapshot
 *      migration m182_005 normalised it (repeatCount 1) and the absent optional
 *      fields default, each normalisation counted; unknown fields are kept in
 *      `extra_json`; a stored mandatory preference `false` is imported as it is.
 *      ANY refusal aborts the whole migration with NOTIFICATIONS_IMPORT_BLOCKED
 *      (entry indexes and reasons, never a text): the runner rolls back, the
 *      file is byte-identical, the next boot refuses the same way until the blob
 *      is resolved by hand on the previous build.
 *   3. Retire the two blob rows; record the counts in `meta.notificationsCutover`.
 * A file without the blobs (a first installation, a database saved before
 * notifications existed) creates the tables and imports nothing — never from
 * the seed, never from memory. The step never runs twice (recorded) and refuses
 * to run before 0008 or when any of the three tables already exists.
 */
import { migrationApplied } from '../database.mjs';
import { ONE_TIME_CODES_MIGRATION } from '../oneTimeCodes.mjs';
import { NOTIFICATIONS_MIGRATION, NOTIFICATIONS_CUTOVER_META, NOTIFICATIONS_DDL, NOTIFICATION_TABLES, importNotificationBlobs } from '../notifications.mjs';

export const id = NOTIFICATIONS_MIGRATION;
export const note = 'notifications and category notification preferences become their own tables (insertion order kept as the feed order)';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, ONE_TIME_CODES_MIGRATION)) throw new Error(`${id}: ${ONE_TIME_CODES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = NOTIFICATION_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(NOTIFICATIONS_DDL);
  const counts = importNotificationBlobs(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(NOTIFICATIONS_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
