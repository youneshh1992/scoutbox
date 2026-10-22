/**
 * Recruitment requests and accepted trials become their own tables (migration plan
 * step S8a-core; docs/architecture/sqlite-migration-plan.md §D.7 as corrected and
 * accepted at d0f0205; the Founder's decisions Q7a, Q7b and Q7c of 22 October 2026).
 * REGISTERED in DATA_MIGRATIONS. Runs with foreign keys OFF (the runner's
 * `foreignKeysOff`): the step rebuilds `channels`, which `messages` references, and
 * `PRAGMA foreign_key_check` must report nothing before it commits — every reference
 * is also checked explicitly, with ids only, before a row is written.
 *
 * Inside the runner's one transaction, after 0014 (player erasure):
 *   1. Create the fifteen recruitment tables (RECRUITMENT_DDL).
 *   2. Import the `requests` and `trials` blobs the file holds through the repository's
 *      own validation: every entry's identifiers, no duplicate id, every trial naming a
 *      request of the file and at most one trial per request, every request/trial pair
 *      agreeing (a request without a trialId key beside its trial is the pre-P4B legacy
 *      pair — counted, never fabricated), every case id in the file's recruitmentCases
 *      blob (Q7b, strict), every guardian id in the guardians table (Q7c, strict); the
 *      player ids are counted as live, retained or missing and never refused (Q7a).
 *      Nothing is coerced or normalised: columns for the mapped scalars, child tables in
 *      list order, absence / null / off-type / unknown fields kept. ANY refusal aborts the
 *      whole migration with RECRUITMENT_IMPORT_BLOCKED, its detail naming the specific
 *      refusal (an invalid entry, PAIR_MISMATCH, RECRUITMENT_CASE_MISSING or
 *      RECRUITMENT_GUARDIAN_MISSING) with positions, ids and reasons — never a name, a
 *      message, an address or a note: the runner rolls back, the blobs and saveSeq are
 *      untouched, the next boot refuses the same way.
 *   3. Rebuild `channels` with the REAL `request_id` foreign key (the D-A conversion):
 *      every thread, message and attachment copied out and back with its seq/position.
 *   4. Retire the two blob rows; record the counts in `meta.recruitmentCutover`.
 * A file without the blobs (a first installation) creates the tables and imports
 * nothing — never from the seed, never from memory. The step never runs twice
 * (recorded) and refuses to run before 0014 or when any of the tables already exists.
 */
import { migrationApplied } from '../database.mjs';
import { PLAYER_ERASURE_MIGRATION } from '../identity.mjs';
import { RECRUITMENT_MIGRATION, RECRUITMENT_CUTOVER_META, RECRUITMENT_DDL, RECRUITMENT_TABLES, CHANNELS_DDL_WITH_KEY, importRecruitmentBlobs } from '../recruitment.mjs';

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

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION)) throw new Error(`${id}: ${PLAYER_ERASURE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['channels', 'messages', 'message_attachments']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although 0012_channels is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_DDL);
  const counts = importRecruitmentBlobs(sqlite);
  const threads = rebuildChannelsWithKey(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECRUITMENT_CUTOVER_META, JSON.stringify({ at: now, ...counts, channels: threads }));
}
