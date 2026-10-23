/**
 * S8b rollback on a COPY (see scripts/recruitmentCasesRollback.mjs for the operator contract; readiness review §7).
 * Exported separately so the behaviour is unit-tested without spawning the CLI. The source file is NEVER modified: it
 * is opened read-only and copied with VACUUM INTO (whatever the WAL side file holds is in the copy), and everything
 * below happens on the copy, which is removed again if any step fails — a refused or failed rollback leaves no usable
 * partial output.
 *
 * What it reconstructs: the storage the pre-S8b build (the accepted commit `7a7efc6`, whose server source the S8b
 * design commits left byte-identical) reads — the `recruitmentCases`, `roomComments`, `roomSnapshots`, `roomDecisions`
 * and `roomEvidenceState` blobs with EVERY record of the tables in `seq` order, each in its writer's literal (presence,
 * absence, null, off-type and unknown fields exactly as recorded; the room facet, assignments, tasks, approvals,
 * history, links, the decision draft, the transaction handoff and the budget nested back in list order; the keys
 * reassembled), so nothing written after the cutover is lost and every route, reader, export and the admin audit read
 * identically there; `recruitment_requests` and `trials` recreated in their S8a definitions (`case_id` without the
 * foreign key that build never had) with every row copied back with its seq; `idempotency_keys` recreated with the S8a
 * owner CHECK, the S8b owners' rows removed (they live in the blobs' `keys` now); the twenty-five tables dropped; the
 * `0016_recruitment_cases` record and `meta.recruitmentCasesCutover` removed; `meta.saveSeq` advanced. Nothing else is
 * touched: the S8a child tables, the threads, the S4a–S6b and S4b-R tables included. The re-upgrade (migration 0016 on
 * the copy) imports the blobs back as the same rows.
 *
 * Why a copy and never the old build on the live file: the migration runner skips a recorded step and refuses none it
 * does not know, so that build opens a 0016 file and finds none of the five blobs (the rows are invisible to it) —
 * measured in scripts/testRecruitmentCasesServer.mjs on the actual build: it reports INTEGRITY STORE_MISSING for the
 * five collections and serves nothing from the tables. There is no way back without this tool.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know (`LATER_SCHEMA`), a copy that never
 * applied 0016 (`NOT_CUT_OVER`), an output directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0016 whose
 * tables are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated before it is reported: integrity, foreign
 * keys, the tables and the record gone, the five blobs present with exactly the counts the tables held, the two
 * rebuilt parents and the S8a key rows row for row, every other table exactly that of the source. Logs and results
 * carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S8A_KNOWN_MIGRATIONS } from './recruitmentRollback.mjs';
import { idempotencyKeysDdl, S8A_KEY_OWNERS } from './recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_CUTOVER_META, RECRUITMENT_CASES_COLLECTIONS, RECRUITMENT_CASES_TABLES, readCases, readRoomComments, readRoomSnapshots, readRoomDecisions, readRoomEvidenceStates } from './recruitmentCases.mjs';
import { rebuildTable, rebuildRecruitmentParents } from './migrations/0016_recruitment_cases.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S8A_KNOWN_MIGRATIONS, RECRUITMENT_CASES_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', 'player_media', 'player_media_tags', 'player_attendance', 'player_timeline', 'player_badges', 'player_drills', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_season_history', 'player_medical_records', 'player_programme_completions', 'request_trial_slots', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'collections'];
const READERS = { recruitmentCases: readCases, roomComments: readRoomComments, roomSnapshots: readRoomSnapshots, roomDecisions: readRoomDecisions, roomEvidenceState: readRoomEvidenceStates };

export function rollbackRecruitmentCasesCopy(sourceFile, outDir, { _failBeforeCommit = false } = {}) {
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
    if (!applied.includes(RECRUITMENT_CASES_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${RECRUITMENT_CASES_MIGRATION}; there is nothing to roll back`);
    const missing = [...RECRUITMENT_CASES_TABLES, 'recruitment_requests', 'trials', 'idempotency_keys'].filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${RECRUITMENT_CASES_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The five blob rows this tool writes are excluded
    // from the collections comparison; the two rebuilt parents and the S8a key rows are compared row for row on their own.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare(`SELECT name, value FROM collections WHERE name NOT IN (${RECRUITMENT_CASES_COLLECTIONS.map(() => '?').join(', ')}) ORDER BY name`).all(...RECRUITMENT_CASES_COLLECTIONS))
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));
    const parentsBefore = JSON.stringify([sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY seq').all(), sqlite.prepare('SELECT * FROM trials ORDER BY seq').all()]);
    const s8aKeysBefore = JSON.stringify(sqlite.prepare(`SELECT * FROM idempotency_keys WHERE owner_table IN (${S8A_KEY_OWNERS.map(() => '?').join(', ')}) ORDER BY owner_table, owner_id, position`).all(...S8A_KEY_OWNERS));

    // 1. What that build reads: every record in insertion order, in the writers' literals, children nested in list order.
    const collections = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, READERS[n](sqlite)]));
    const counts = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, collections[n].length]));

    sqlite.exec('PRAGMA foreign_keys = OFF;'); // the rebuilds drop tables that others reference; every reference is checked before COMMIT
    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved; let rebuilt;
    try {
      const upsert = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      for (const n of RECRUITMENT_CASES_COLLECTIONS) upsert.run(n, JSON.stringify(collections[n]));
      // 2. The two parents lose the case key that build never had (their rows kept); the key table narrows to the S8a owners (the S8b owners' rows are in the blobs now); the twenty-five tables (children first) and the bookkeeping go.
      for (const t of [...RECRUITMENT_CASES_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      rebuilt = rebuildRecruitmentParents(sqlite, { caseKey: false });
      sqlite.prepare(`DELETE FROM idempotency_keys WHERE owner_table NOT IN (${S8A_KEY_OWNERS.map(() => '?').join(', ')})`).run(...S8A_KEY_OWNERS);
      rebuilt.idempotencyKeys = rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8A_KEY_OWNERS));
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(RECRUITMENT_CASES_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(RECRUITMENT_CASES_CUTOVER_META);
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(RECRUITMENT_CASES_MIGRATION)) problems.push('the 0016 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(RECRUITMENT_CASES_CUTOVER_META)) problems.push('the S8b meta key is still present');
    for (const t of RECRUITMENT_CASES_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    for (const t of ['recruitment_requests', 'trials']) if (sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.table === 'recruitment_cases')) problems.push(`${t}.case_id still carries the foreign key`);
    if (JSON.stringify([sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY seq').all(), sqlite.prepare('SELECT * FROM trials ORDER BY seq').all()]) !== parentsBefore) problems.push('the recruitment_requests or trials rows changed');
    if (JSON.stringify(sqlite.prepare('SELECT * FROM idempotency_keys ORDER BY owner_table, owner_id, position').all()) !== s8aKeysBefore) problems.push('the S8a idempotency_keys rows changed');
    if (!/owner_table IN \('recruitment_requests', 'trials'\)/.test(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get()?.sql ?? '')) problems.push('idempotency_keys does not carry the S8a owner CHECK');
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
    return { output, applied, recordRemoved, ...counts, rebuilt, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
