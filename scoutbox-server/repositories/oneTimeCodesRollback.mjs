/**
 * S6a rollback on a COPY (see scripts/oneTimeCodesRollback.mjs for the
 * operator contract; docs/architecture/s6-readiness-review.md §6–§7).
 * Exported separately so the behaviour is unit-tested without spawning the
 * CLI. The source file is NEVER modified: it is opened read-only and copied
 * with VACUUM INTO (whatever the WAL side file holds is in the copy), and
 * everything below happens on the copy, which is removed again if any step
 * fails — a refused or failed rollback leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the S5 build (`2178c5b`,
 * or the documentation commit `7fbce74` on top of it) reads —
 *   - the `emailChallenges` and `pairingCodes` blob collections, written EMPTY:
 *     a stored row holds only a hash, which cannot be turned back into the
 *     plain code that build compares, so every outstanding (unexpired) code is
 *     INVALIDATED by the rollback and counted; the organisation requests a
 *     fresh challenge, the guardian mints a fresh pairing code. Nothing else
 *     is lost: the organisations' verification flags, the players, the
 *     guardians, the sessions and every other collection are untouched;
 *   - the two tables dropped, the `0008_one_time_codes` record and
 *     `meta.oneTimeCodesCutover` removed, `meta.saveSeq` advanced.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0008 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0008 whose
 * tables are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated
 * before it is reported: integrity, foreign keys, the tables and the record
 * gone, the two blobs present and empty, the players, guardians, organisations
 * and sessions exactly those of the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S5_KNOWN_MIGRATIONS } from './playerSubrecordsRollback.mjs';
import { ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_CUTOVER_META, ONE_TIME_CODE_TABLES } from './oneTimeCodes.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S5_KNOWN_MIGRATIONS, ONE_TIME_CODES_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = {
  sessions: 'SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY sid',
  players: 'SELECT * FROM players ORDER BY id',
  guardians: 'SELECT * FROM guardians ORDER BY id',
  orgs: 'SELECT * FROM orgs ORDER BY id',
};

export function rollbackOneTimeCodesCopy(sourceFile, outDir, { now = Date.now() } = {}) {
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
    const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const applied = hasTable('data_migrations') ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) throw refusal('LATER_SCHEMA', `the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
    if (!applied.includes(ONE_TIME_CODES_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${ONE_TIME_CODES_MIGRATION}; there is nothing to roll back`);
    const missing = ONE_TIME_CODE_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${ONE_TIME_CODES_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    const before = Object.fromEntries(Object.entries(UNTOUCHED).map(([k, sql]) => [k, hasTable(k) ? JSON.stringify(sqlite.prepare(sql).all()) : null]));

    // What the rollback invalidates (counts only, never a hash or a code).
    const invalidated = {
      emailChallenges: sqlite.prepare('SELECT COUNT(*) AS n FROM email_challenges WHERE expires_at > ?').get(now).n,
      pairingCodes: sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE expires_at > ?').get(now).n,
    };
    const expired = {
      emailChallenges: sqlite.prepare('SELECT COUNT(*) AS n FROM email_challenges WHERE expires_at <= ?').get(now).n,
      pairingCodes: sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE expires_at <= ?').get(now).n,
    };

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      // 1. The blobs that build reads, empty: no code can be reconstructed from a hash.
      const put = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      put.run('emailChallenges', '[]');
      put.run('pairingCodes', '[]');
      // 2. The tables and the bookkeeping go.
      for (const t of [...ONE_TIME_CODE_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(ONE_TIME_CODES_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(ONE_TIME_CODES_CUTOVER_META);
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(ONE_TIME_CODES_MIGRATION)) problems.push('the 0008 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(ONE_TIME_CODES_CUTOVER_META)) problems.push('the S6a meta key is still present');
    for (const t of ONE_TIME_CODE_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    for (const name of ['emailChallenges', 'pairingCodes']) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
      if (v !== '[]') problems.push(`the ${name} blob is ${v === undefined ? 'absent' : 'not empty'}`);
    }
    for (const [k, sql] of Object.entries(UNTOUCHED)) {
      const after = hasTable(k) ? JSON.stringify(sqlite.prepare(sql).all()) : null;
      if (after !== before[k]) problems.push(`the ${k} table changed`);
    }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, invalidated, expired, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
