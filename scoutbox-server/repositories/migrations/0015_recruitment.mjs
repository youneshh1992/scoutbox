/**
 * Recruitment requests and accepted trials (S8a) get their own tables (recruitment_requests, request_trial_slots,
 * trials and its owned child tables, idempotency_keys), and `channels` is rebuilt so `request_id` is a real key.
 * Runs with foreign keys off because it rebuilds a referenced table.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { PLAYER_ERASURE_MIGRATION } from '../identity.mjs';
import { RECRUITMENT_MIGRATION, RECRUITMENT_DDL, RECRUITMENT_TABLES, CHANNELS_DDL_WITH_KEY } from '../recruitment.mjs';

export const id = RECRUITMENT_MIGRATION;
export const note = 'recruitment requests and accepted trials become their own tables (recruitment_requests, request_trial_slots, trials and its eleven owned child tables, idempotency_keys; insertion and list order kept; absence, null, off-type and unknown fields kept losslessly; the player references tolerant and counted (Q7a), the case and guardian references checked strictly in code (Q7b, Q7c)); channels rebuilt with the real request_id foreign key (D-A)';
export const foreignKeysOff = true;

/** Copy the three thread tables out, drop them (children first), recreate `channels` with the key, and put every row back with its seq/position. */
export function rebuildChannelsWithKey(sqlite) {
  const channels = sqlite.prepare('SELECT * FROM channels ORDER BY seq').all().map((r) => ({ ...r }));
  const messages = sqlite.prepare('SELECT * FROM messages ORDER BY seq').all().map((r) => ({ ...r }));
  const attachments = sqlite.prepare('SELECT * FROM message_attachments ORDER BY rowid').all().map((r) => ({ ...r }));
  const messagesDdl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get().sql;
  const attachmentsDdl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'").get().sql;
  const indexes = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('messages', 'message_attachments') AND sql IS NOT NULL").all().map((r) => r.sql);
  sqlite.exec('DROP TABLE message_attachments; DROP TABLE messages; DROP TABLE channels;');
  sqlite.exec(CHANNELS_DDL_WITH_KEY); sqlite.exec(`${messagesDdl};`); sqlite.exec(`${attachmentsDdl};`); for (const ix of indexes) sqlite.exec(`${ix};`);
  const insert = (table, rows) => { if (!rows.length) return; const cols = Object.keys(rows[0]); const st = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`); for (const r of rows) st.run(r); };
  insert('channels', channels); insert('messages', messages); insert('message_attachments', attachments);
  return { channels: channels.length, messages: messages.length, attachments: attachments.length };
}

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION)) throw new Error(`${id}: ${PLAYER_ERASURE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['channels', 'messages', 'message_attachments']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although 0012_channels is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_DDL);
  rebuildChannelsWithKey(sqlite);
}
