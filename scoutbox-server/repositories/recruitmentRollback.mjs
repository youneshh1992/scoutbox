/**
 * S8a-core rollback on a COPY (see scripts/recruitmentRollback.mjs for the operator
 * contract; docs/architecture/sqlite-migration-plan.md §D.7.7). Exported separately so
 * the behaviour is unit-tested without spawning the CLI. The source file is NEVER
 * modified: it is opened read-only and copied with VACUUM INTO (whatever the WAL side
 * file holds is in the copy), and everything below happens on the copy, which is
 * removed again if any step fails — a refused or failed rollback leaves no usable
 * partial output.
 *
 * What it reconstructs: the storage the pre-S8a build (the accepted commit `9b109dc`)
 * reads — the `requests` and `trials` blobs with EVERY record of the tables in `seq`
 * order, each in its writer's literal (presence, absence, null, off-type and unknown
 * fields exactly as recorded; the slots, sessions, evidence, revisions, attendance,
 * history, day containers, the report, the reminders and the keys nested back in list
 * order), so nothing written after the cutover is lost and every route, reader, export
 * and the admin audit read identically there; the `channels` table recreated in its
 * 0012 definition (`request_id` without the foreign key that build never had) with
 * every thread, message and attachment copied back with its seq/position; the fifteen
 * recruitment tables dropped; the `0015_recruitment` record and `meta.recruitmentCutover`
 * removed; `meta.saveSeq` advanced. Nothing else is touched: the S4a–S6b and S4b-R tables
 * included. The re-upgrade (migration 0015 on the copy) imports the blobs back as the
 * same rows.
 *
 * Why a copy and never the old build on the live file: the migration runner skips a
 * recorded step and refuses none it does not know, so that build opens a 0015 file,
 * finds no `requests` / `trials` blob (the rows are invisible to it), and its
 * boot-contract integrity check reports STORE_MISSING and exits 1 before listening
 * (measured in scripts/testRecruitmentServer.mjs on the actual 9b109dc build): nothing
 * is served, nothing is written, and there is no way back without this tool.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0015 (`NOT_CUT_OVER`), an output directory
 * that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0015 whose tables are missing
 * (`UNEXPECTED_SCHEMA`). The completed copy is revalidated before it is reported:
 * integrity, foreign keys, the tables and the record gone, both blobs present with
 * exactly the counts the tables held, the threads row for row, every other table exactly
 * that of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S4BR_KNOWN_MIGRATIONS } from './playerErasureRollback.mjs';
import { CHANNELS_DDL } from './channels.mjs';
import { RECRUITMENT_MIGRATION, RECRUITMENT_CUTOVER_META, RECRUITMENT_TABLES, readRequests, readTrials } from './recruitment.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S4BR_KNOWN_MIGRATIONS, RECRUITMENT_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', 'player_media', 'player_media_tags', 'player_attendance', 'player_timeline', 'player_badges', 'player_drills', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_season_history', 'player_medical_records', 'player_programme_completions', 'collections'];

/** The three thread tables copied out, dropped (children first), `channels` recreated WITHOUT the request key (the 0012 definition), every row put back. Foreign keys must be OFF on the connection. */
function rebuildChannelsWithoutKey(sqlite) {
  const channels = sqlite.prepare('SELECT * FROM channels ORDER BY seq').all().map((r) => ({ ...r }));
  const messages = sqlite.prepare('SELECT * FROM messages ORDER BY seq').all().map((r) => ({ ...r }));
  const attachments = sqlite.prepare('SELECT * FROM message_attachments ORDER BY rowid').all().map((r) => ({ ...r }));
  const messagesDdl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get().sql;
  const attachmentsDdl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'").get().sql;
  const indexes = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('messages', 'message_attachments') AND sql IS NOT NULL").all().map((r) => r.sql);
  sqlite.exec('DROP TABLE message_attachments; DROP TABLE messages; DROP TABLE channels;');
  sqlite.exec(CHANNELS_DDL); // the 0012 definition creates channels, messages and message_attachments with their indexes
  for (const t of ['message_attachments', 'messages']) sqlite.exec(`DROP TABLE ${t};`); // the two children exactly as the source held them
  sqlite.exec(`${messagesDdl};`); sqlite.exec(`${attachmentsDdl};`); for (const ix of indexes) sqlite.exec(`${ix};`);
  const insert = (table, rows) => { if (!rows.length) return; const cols = Object.keys(rows[0]); const st = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`); for (const r of rows) st.run(r); };
  insert('channels', channels); insert('messages', messages); insert('message_attachments', attachments);
  return { channels: channels.length, messages: messages.length, attachments: attachments.length };
}

export function rollbackRecruitmentCopy(sourceFile, outDir, { _failBeforeCommit = false } = {}) {
  if (!fs.existsSync(sourceFile)) throw refusal('NO_SOURCE', `${sourceFile} does not exist`);
  fs.mkdirSync(outDir, { recursive: true });
  const leftovers = fs.readdirSync(outDir);
  if (leftovers.length) throw refusal('OUTPUT_NOT_EMPTY', `${outDir} is not empty (${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'}); the rollback needs a fresh, empty output directory and never overwrites anything`);
  const output = path.join(outDir, 'scoutbox.db');

  let sqlite = null;
  let done = false;
  try {
    copyDatabaseReadOnly(sourceFile, output);
    sqlite = new DatabaseSync(output);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const applied = hasTable('data_migrations') ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) throw refusal('LATER_SCHEMA', `the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
    if (!applied.includes(RECRUITMENT_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${RECRUITMENT_MIGRATION}; there is nothing to roll back`);
    const missing = [...RECRUITMENT_TABLES, 'channels', 'messages', 'message_attachments'].filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${RECRUITMENT_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The two blob rows
    // this tool writes are excluded from the collections comparison; the threads are
    // compared row for row on their own, after the rebuild.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare('SELECT name, value FROM collections WHERE name NOT IN (?, ?) ORDER BY name').all('requests', 'trials'))
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));
    const threadsBefore = JSON.stringify(sqlite.prepare('SELECT * FROM channels ORDER BY seq').all());

    // 1. What that build reads: every record in insertion order, in the writers' literals, children nested in list order.
    const requests = readRequests(sqlite); const trials = readTrials(sqlite);
    const counts = { requests: requests.length, trials: trials.length };

    sqlite.exec('PRAGMA foreign_keys = OFF;'); // the channels rebuild drops a table that messages references; every reference is checked before COMMIT
    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved; let threads;
    try {
      const upsert = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      upsert.run('requests', JSON.stringify(requests)); upsert.run('trials', JSON.stringify(trials));
      // 2. The channels lose the key that build never had (its rows kept), the fifteen tables (children first) and the bookkeeping go.
      threads = rebuildChannelsWithoutKey(sqlite);
      for (const t of [...RECRUITMENT_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(RECRUITMENT_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(RECRUITMENT_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      if (_failBeforeCommit) throw new Error('synthetic commit failure (test seam)');
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON;');
    }
    sqlite.exec('VACUUM');

    // 3. Revalidate the completed copy before reporting it.
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(RECRUITMENT_MIGRATION)) problems.push('the 0015 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(RECRUITMENT_CUTOVER_META)) problems.push('the S8a meta key is still present');
    for (const t of RECRUITMENT_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    if (sqlite.prepare('PRAGMA foreign_key_list(channels)').all().some((f) => f.from === 'request_id')) problems.push('channels.request_id still carries the foreign key');
    if (JSON.stringify(sqlite.prepare('SELECT * FROM channels ORDER BY seq').all()) !== threadsBefore) problems.push('the channels rows changed');
    for (const [name, n] of Object.entries(counts)) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
      let count = null; try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) count = parsed.length; } catch { /* reported below */ }
      if (count !== n) problems.push(`the ${name} blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${n} the table held`);
    }
    for (const t of UNTOUCHED) {
      const after = hasTable(t) ? snapshotOf(t) : null;
      if (after !== before[t]) problems.push(`the ${t} table changed`);
    }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, ...counts, channels: threads, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
