/**
 * Notifications and category notification preferences (S7a) get their own tables; insertion order is the feed order.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { ONE_TIME_CODES_MIGRATION } from '../oneTimeCodes.mjs';
import { NOTIFICATIONS_MIGRATION, NOTIFICATIONS_DDL, NOTIFICATION_TABLES } from '../notifications.mjs';

export const id = NOTIFICATIONS_MIGRATION;
export const note = 'notifications and category notification preferences become their own tables (insertion order kept as the feed order)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, ONE_TIME_CODES_MIGRATION)) throw new Error(`${id}: ${ONE_TIME_CODES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = NOTIFICATION_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(NOTIFICATIONS_DDL);
}
