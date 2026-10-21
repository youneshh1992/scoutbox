/**
 * S4b-R rollback on a COPY (see scripts/playerErasureRollback.mjs for the operator
 * contract; docs/architecture/sqlite-migration-plan.md §D.6.1). Exported separately so
 * the behaviour is unit-tested without spawning the CLI. The source file is NEVER
 * modified: it is opened read-only and copied with VACUUM INTO (whatever the WAL side
 * file holds is in the copy), and everything below happens on the copy, which is
 * removed again if any step fails — a refused or failed rollback leaves no usable
 * partial output.
 *
 * What it reconstructs: the storage the pre-S4b-R build (the accepted commit
 * `f0abd34`) reads. That build treats EVERY players row as an account, so the retained
 * rows must not stay in the table: they are moved into the `playersRetained` legacy
 * blob (exactly the records, in insertion order) — a collection that build loads into
 * memory under a name no route reads, keeps through its saves and exports in its
 * backups, and serves to nobody as an account — and the rows are deleted from
 * `players`; the `0014_player_erasure` record and `meta.playerErasureCutover` are
 * removed, `meta.saveSeq` advanced. The live rows and every other table (the S4a–S6b
 * tables included) are untouched. The re-upgrade (migration 0014 on the copy) imports
 * the blob back as the same rows. THE ERASED PERSONAL DATA IS RESTORED BY NOTHING: a
 * rollback copy carries the retained records, not the deleted accounts.
 *
 * Why a copy and never the old build on the live file: the migration runner skips a
 * recorded step and refuses none it does not know, so that build boots a 0014 file
 * and serves a retained row as a live, passwordless account named "Deleted player".
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0014 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`). The completed copy is revalidated
 * before it is reported: integrity, foreign keys, the record and the meta key gone, no
 * retained row left, the blob holding exactly the records, the live rows and every
 * other table exactly those of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S6B_KNOWN_MIGRATIONS } from './safetyAuditRollback.mjs';
import { PLAYER_ERASURE_MIGRATION, PLAYER_ERASURE_CUTOVER_META, PLAYERS_RETAINED, PLAYERS_RETAINED_COLLECTION } from './identity.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S6B_KNOWN_MIGRATIONS, PLAYER_ERASURE_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', 'player_media', 'player_media_tags', 'player_attendance', 'player_timeline', 'player_badges', 'player_drills', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_season_history', 'player_medical_records', 'player_programme_completions', 'collections'];

export function rollbackPlayerErasureCopy(sourceFile, outDir, { _failBeforeCommit = false } = {}) {
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
    if (!applied.includes(PLAYER_ERASURE_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${PLAYER_ERASURE_MIGRATION}; there is nothing to roll back`);
    if (!hasTable('players')) throw refusal('UNEXPECTED_SCHEMA', `${PLAYER_ERASURE_MIGRATION} is recorded but the players table does not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The blob row this
    // tool writes is excluded from the collections comparison; the live players rows are
    // compared on their own.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare('SELECT name, value FROM collections WHERE name <> ? ORDER BY name').all(PLAYERS_RETAINED_COLLECTION))
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));
    const liveBefore = JSON.stringify(sqlite.prepare('SELECT * FROM players WHERE deleted_at IS NULL ORDER BY rowid').all());

    // 1. The retained records, exactly (the same reader the backup uses).
    const records = PLAYERS_RETAINED.read(sqlite) ?? [];

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(PLAYERS_RETAINED_COLLECTION, JSON.stringify(records));
      // 2. The rows leave the table that build reads as accounts; the bookkeeping goes.
      const removed = sqlite.prepare('DELETE FROM players WHERE deleted_at IS NOT NULL').run().changes;
      if (removed !== records.length) throw new Error(`${removed} retained row(s) removed but ${records.length} record(s) were read; refusing to continue`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(PLAYER_ERASURE_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(PLAYER_ERASURE_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      if (_failBeforeCommit) throw new Error('synthetic commit failure (test seam)');
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
    sqlite.exec('VACUUM');

    // 3. Revalidate the completed copy before reporting it.
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(PLAYER_ERASURE_MIGRATION)) problems.push('the 0014 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(PLAYER_ERASURE_CUTOVER_META)) problems.push('the S4b-R meta key is still present');
    if (sqlite.prepare('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NOT NULL').get().n) problems.push('a retained row is still in the players table');
    if (JSON.stringify(sqlite.prepare('SELECT * FROM players ORDER BY rowid').all()) !== liveBefore) problems.push('the live players rows changed');
    { const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(PLAYERS_RETAINED_COLLECTION)?.value; let count = null; try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) count = parsed.length; } catch { /* reported below */ } if (count !== records.length) problems.push(`the playersRetained blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${records.length} the table held`); }
    for (const t of UNTOUCHED) { const after = hasTable(t) ? snapshotOf(t) : null; if (after !== before[t]) problems.push(`the ${t} table changed`); }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, retained: records.length, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
