/**
 * S7b rollback on a COPY (see scripts/dispatchesRollback.mjs for the operator
 * contract; docs/architecture/s7-readiness-review.md §9.4). Exported separately
 * so the behaviour is unit-tested without spawning the CLI. The source file is
 * NEVER modified: it is opened read-only and copied with VACUUM INTO (whatever
 * the WAL side file holds is in the copy), and everything below happens on the
 * copy, which is removed again if any step fails — a refused or failed rollback
 * leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the pre-S7b build (the
 * accepted S7a commit `0641b2c`) reads — the `dispatches` blob with EVERY row
 * of the table in `seq` order, in the eighteen-key shape that build wrote,
 * attempts nested in their positions and in their two shapes ({at, ok, error}
 * / {at, note}), fractional callback clocks, orphan references and unknown
 * fields as stored — so nothing written after the cutover is lost and the
 * sweep, the callbacks and the admin views read identically there; the two
 * tables dropped (attempts first), the `0010_dispatches` record and
 * `meta.dispatchesCutover` removed, `meta.saveSeq` advanced. Nothing else is
 * touched: the S7a notification tables included.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0010 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0010 whose
 * tables are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated
 * before it is reported: integrity, foreign keys, the tables and the record
 * gone, the blob present with exactly the count the table held, every other
 * table exactly that of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S7A_KNOWN_MIGRATIONS } from './notificationsRollback.mjs';
import { DISPATCHES_MIGRATION, DISPATCHES_CUTOVER_META, DISPATCH_TABLES, DISPATCHES_TABLE } from './dispatches.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S7A_KNOWN_MIGRATIONS, DISPATCHES_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'collections'];

export function rollbackDispatchesCopy(sourceFile, outDir, { now = Date.now() } = {}) {
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
    if (!applied.includes(DISPATCHES_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${DISPATCHES_MIGRATION}; there is nothing to roll back`);
    const missing = DISPATCH_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${DISPATCHES_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The blob
    // row this tool writes is excluded from the collections comparison.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare("SELECT name, value FROM collections WHERE name <> 'dispatches' ORDER BY name").all())
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));

    // 1. What that build reads: every row, in insertion order, attempts nested, in the eighteen-key shape.
    const dispatches = DISPATCHES_TABLE.read(sqlite);
    let attempts = 0; for (const d of dispatches) attempts += d.attempts.length;
    const counts = { dispatches: dispatches.length, attempts };

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run('dispatches', JSON.stringify(dispatches));
      // 2. The tables (children first) and the bookkeeping go.
      for (const t of [...DISPATCH_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(DISPATCHES_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(DISPATCHES_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(DISPATCHES_MIGRATION)) problems.push('the 0010 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(DISPATCHES_CUTOVER_META)) problems.push('the S7b meta key is still present');
    for (const t of DISPATCH_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    {
      const v = sqlite.prepare("SELECT value FROM collections WHERE name = 'dispatches'").get()?.value;
      let n = null; let a = null; try { const parsed = JSON.parse(v); n = parsed.length; a = parsed.reduce((sum, d) => sum + d.attempts.length, 0); } catch { /* reported below */ }
      if (n !== counts.dispatches) problems.push(`the dispatches blob holds ${n === null ? 'nothing readable' : `${n} entries`}, not the ${counts.dispatches} the table held`);
      if (a !== counts.attempts) problems.push(`the dispatches blob nests ${a === null ? 'nothing readable' : `${a} attempts`}, not the ${counts.attempts} the table held`);
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
