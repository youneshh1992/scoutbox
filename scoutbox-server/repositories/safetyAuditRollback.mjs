/**
 * S6b rollback on a COPY (see scripts/safetyAuditRollback.mjs for the operator
 * contract; docs/architecture/sqlite-migration-plan.md §D.4). Exported separately so
 * the behaviour is unit-tested without spawning the CLI. The source file is NEVER
 * modified: it is opened read-only and copied with VACUUM INTO (whatever the WAL side
 * file holds is in the copy), and everything below happens on the copy, which is
 * removed again if any step fails — a refused or failed rollback leaves no usable
 * partial output.
 *
 * What it reconstructs: the storage representation the pre-S6b build (the accepted
 * commit `4f954ad`, whose scoutbox-server source is byte-identical to `1792fc7`) reads
 * — the eight blobs `blocks`, `reports`, `moderationLog`, `orgNotes`, `ledger`,
 * `opsEvents`, `sourceChanges` and `idvQueue`, each with EVERY row of its table in
 * `seq` order in the writer's literal (unknown fields spread first, absent keys absent,
 * off-type values restored exactly) — so nothing written, updated or deleted after the
 * cutover is lost: a block lifted after the cutover is absent, a report resolved after
 * it carries its resolution, a source change trimmed by the cap is absent, and every
 * route, list, export and admin console of that build reads identically; the eight
 * tables dropped, the `0013_safety_audit` record and `meta.safetyAuditCutover` removed,
 * `meta.saveSeq` advanced. Nothing else is touched: the S4a–S7d tables included.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0013 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0013 whose tables are
 * missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated before it is
 * reported: integrity, foreign keys, the tables and the record gone, every blob present
 * with exactly the row count its table held, every other table exactly that of the
 * source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S7D_KNOWN_MIGRATIONS } from './channelsRollback.mjs';
import { SAFETY_AUDIT_MIGRATION, SAFETY_AUDIT_CUTOVER_META, AUDIT_COLLECTIONS, AUDIT_TABLE_NAMES, AUDIT_SNAPSHOT_TABLES } from './safetyAudit.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S7D_KNOWN_MIGRATIONS, SAFETY_AUDIT_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'collections'];

export function rollbackSafetyAuditCopy(sourceFile, outDir, { now = Date.now(), _failBeforeCommit = false } = {}) {
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
    if (!applied.includes(SAFETY_AUDIT_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${SAFETY_AUDIT_MIGRATION}; there is nothing to roll back`);
    const missing = AUDIT_TABLE_NAMES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${SAFETY_AUDIT_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The blob
    // rows this tool writes are excluded from the collections comparison.)
    const placeholders = AUDIT_COLLECTIONS.map(() => '?').join(', ');
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare(`SELECT name, value FROM collections WHERE name NOT IN (${placeholders}) ORDER BY name`).all(...AUDIT_COLLECTIONS))
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));

    // 1. What that build reads: every row of every table in insertion order, in the writers' literals.
    const blobs = {}; const counts = {};
    for (const t of AUDIT_SNAPSHOT_TABLES) { blobs[t.name] = t.read(sqlite); counts[t.name] = blobs[t.name].length; }

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      const put = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      for (const name of AUDIT_COLLECTIONS) put.run(name, JSON.stringify(blobs[name]));
      // 2. The tables and the bookkeeping go.
      for (const t of [...AUDIT_TABLE_NAMES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(SAFETY_AUDIT_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(SAFETY_AUDIT_CUTOVER_META);
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(SAFETY_AUDIT_MIGRATION)) problems.push('the 0013 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(SAFETY_AUDIT_CUTOVER_META)) problems.push('the S6b meta key is still present');
    for (const t of AUDIT_TABLE_NAMES) if (hasTable(t)) problems.push(`${t} still exists`);
    for (const name of AUDIT_COLLECTIONS) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
      let count = null; try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) count = parsed.length; } catch { /* reported below */ }
      if (count !== counts[name]) problems.push(`the ${name} blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${counts[name]} the table held`);
    }
    for (const t of UNTOUCHED) {
      const after = hasTable(t) ? snapshotOf(t) : null;
      if (after !== before[t]) problems.push(`the ${t} table changed`);
    }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, counts, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
