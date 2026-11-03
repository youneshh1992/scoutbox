/**
 * Delivery dispatch records and their attempts (S7b) get their own tables; the notification reference is indexed,
 * without a foreign key.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { NOTIFICATIONS_MIGRATION } from '../notifications.mjs';
import { DISPATCHES_MIGRATION, DISPATCHES_DDL, DISPATCH_TABLES } from '../dispatches.mjs';

export const id = DISPATCHES_MIGRATION;
export const note = 'delivery dispatch records and their attempts become their own tables (insertion order kept; notification reference indexed, no foreign key)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, NOTIFICATIONS_MIGRATION)) throw new Error(`${id}: ${NOTIFICATIONS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = DISPATCH_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(DISPATCHES_DDL);
}
