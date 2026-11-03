/**
 * Message threads (S7d) get their own tables: channels, messages and message_attachments.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { OUTBOX_PUSH_MIGRATION } from '../outboxPush.mjs';
import { CHANNELS_MIGRATION, CHANNELS_DDL, CHANNELS_TABLES } from '../channels.mjs';

export const id = CHANNELS_MIGRATION;
export const note = 'message threads become their own tables (channels, messages, message_attachments; typed columns, insertion and message order kept; unknown fields and wrong-typed optional values dropped and reported with ids; the request, guardian and organisation references checked — D-A/D-B approved)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION)) throw new Error(`${id}: ${OUTBOX_PUSH_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = CHANNELS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(CHANNELS_DDL);
}
