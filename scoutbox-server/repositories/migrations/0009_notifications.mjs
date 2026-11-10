/**
 * Notifications and category notification preferences; insertion order is the feed order. A staff audience is a
 * RESTRICT key to org_users; the group key and the acknowledger are worked out, not stored.
 */
import { migrationApplied } from '../database.mjs';
import { ONE_TIME_CODES_MIGRATION } from '../oneTimeCodes.mjs';
import { NOTIFICATIONS_MIGRATION, NOTIFICATIONS_DDL, NOTIFICATION_TABLES } from '../notifications.mjs';

export const id = NOTIFICATIONS_MIGRATION;
export const note =
  'notifications and category notification preferences become their own tables (insertion order is the feed order; typed columns with vocabulary and length CHECKs; a staff audience is a key, players and guardians tolerant; the delivery marker)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, ONE_TIME_CODES_MIGRATION))
    throw new Error(`${id}: ${ONE_TIME_CODES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = NOTIFICATION_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  sqlite.exec(NOTIFICATIONS_DDL);
}
