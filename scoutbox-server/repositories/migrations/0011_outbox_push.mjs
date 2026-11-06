/**
 * The mail outbox, the push log and the device push tokens (S7c) get their own tables. Amended in place in S14d:
 * vocabulary and length CHECKs, an address on every outbox row, one row per device token.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { DISPATCHES_MIGRATION } from '../dispatches.mjs';
import { OUTBOX_PUSH_MIGRATION, OUTBOX_PUSH_DDL, OUTBOX_PUSH_TABLES } from '../outboxPush.mjs';

export const id = OUTBOX_PUSH_MIGRATION;
export const note = 'the mail outbox, the push log and the device push tokens become typed tables (vocabulary CHECKs; one row per device token)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, DISPATCHES_MIGRATION)) throw new Error(`${id}: ${DISPATCHES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = OUTBOX_PUSH_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(OUTBOX_PUSH_DDL);
}
