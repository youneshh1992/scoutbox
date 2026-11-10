/**
 * Message threads: channels, messages and message_attachments. A channel names its recruitment request with a real
 * key (the table 0015 creates); the sender is typed columns by kind (staff a key to org_users); the retry id is
 * unique per thread and sender.
 */
import { migrationApplied } from '../database.mjs';
import { OUTBOX_PUSH_MIGRATION } from '../outboxPush.mjs';
import { CHANNELS_MIGRATION, CHANNELS_DDL, CHANNELS_TABLES } from '../channels.mjs';

export const id = CHANNELS_MIGRATION;
export const note =
  'message threads become their own tables (channels, messages, message_attachments; typed columns; the request, organisation and staff sender are keys, the player and guardian tolerant; the activity time orders the inboxes; the retry id is unique per thread and sender)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION))
    throw new Error(`${id}: ${OUTBOX_PUSH_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = CHANNELS_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  sqlite.exec(CHANNELS_DDL);
}
