/**
 * S5 rollback on a COPY (see scripts/playerSubrecordsRollback.mjs for the
 * operator contract; docs/architecture/s5-player-subrecords.md §2.10).
 * Exported separately so the behaviour is unit-tested without spawning the
 * CLI. The source file is NEVER modified: it is opened read-only and copied
 * with VACUUM INTO (whatever the WAL side file holds is in the copy), and
 * everything below happens on the copy, which is removed again if any step
 * fails — a refused or failed rollback leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the S4a build (`480afdb`)
 * reads —
 *   - every player's arrays back inside `facets_json`, under their own keys
 *     (the layout that build writes and reads), from the rows of the twelve
 *     tables in their position order, post-S5 inserts, updates and removals
 *     included; the item shape (key order, nulls, unknown fields) exactly as
 *     the rows carry it;
 *   - `trialReports` rebuilt from the `trials` blob in the derived order
 *     (that build pushes a copy of every filed report onto the player and reads
 *     it there), where the record has the key or a report exists;
 *   - the twelve tables dropped, the `0007_player_subrecords` record and
 *     `meta.playerSubrecordsCutover` removed, `meta.saveSeq` advanced;
 *   - `players` scalars, `guardians`, `guardian_children`, `sessions`,
 *     `org_users`, `orgs`, the media-removal queue (migration 0006, which both
 *     builds have) and every other collection untouched.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA` — a later step needs its own rollback; no partial downgrade
 * is guessed), a copy that never applied 0007 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0007 whose
 * tables are missing (`UNEXPECTED_SCHEMA`), a `trials` collection that is not
 * a JSON array while a player has a `trialReports` key (`TRIALS_UNREADABLE`),
 * a player row whose shape metadata says `medical` or `programme` is null or
 * absent while its child rows exist (`INCONSISTENT_ROWS`, raised by the one
 * decoder: a copy that hid those rows would not be the record — review of
 * 132eda2, finding 3).
 * The completed copy is revalidated before it is reported: integrity, foreign
 * keys, every player's facets decode back to the record the rows held, the
 * tables are gone, the sessions are exactly those of the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { playerFromRow, playerToRow } from './identityMapping.mjs';
import { KNOWN_MIGRATIONS as S4_KNOWN_MIGRATIONS } from './coreIdentityRollback.mjs';
import { PLAYER_SUBRECORDS_MIGRATION, SUBRECORD_TABLES, prepareSubrecordStatements, readPlayersWithChildren, readTrialsBlob } from './playerSubrecords.mjs';
import { PLAYER_SUBRECORDS_CUTOVER_META } from './migrations/0007_player_subrecords.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S4_KNOWN_MIGRATIONS, PLAYER_SUBRECORDS_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const SESSION_ROWS = 'SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY sid';

export function rollbackPlayerSubrecordsCopy(sourceFile, outDir) {
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
    if (!applied.includes(PLAYER_SUBRECORDS_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${PLAYER_SUBRECORDS_MIGRATION}; there is nothing to roll back`);
    const missing = SUBRECORD_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${PLAYER_SUBRECORDS_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    if (!hasTable('players') || !sqlite.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'facets_json')) throw refusal('UNEXPECTED_SCHEMA', 'the players table is not the live definition (facets_json); refusing to guess');
    const trials = readTrialsBlob(sqlite);
    const sessionsBefore = hasTable('sessions') ? sqlite.prepare(SESSION_ROWS).all() : null;

    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.exec('BEGIN');
    let players; let saveSeq; let recordRemoved; const rowsPerTable = {};
    try {
      // 1. The records, as the S4a build stored them: every array (and the derived trial reports) inside facets_json.
      const st = prepareSubrecordStatements(sqlite);
      for (const t of SUBRECORD_TABLES) rowsPerTable[t] = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      const full = readPlayersWithChildren(sqlite, st, { trials: trials ?? [] });
      if (trials === null && full.some(({ record }) => Object.hasOwn(record, 'trialReports'))) throw refusal('TRIALS_UNREADABLE', 'the trials collection is not a JSON array, so the trialReports copies the S4a build reads cannot be rebuilt; refusing to guess');
      const setFacets = sqlite.prepare('UPDATE players SET facets_json = @facets_json WHERE id = @id');
      players = full.map(({ record }) => record);
      for (const { record } of full) setFacets.run({ id: record.id, facets_json: playerToRow(record, { subrecords: 'facets' }).facets_json });
      // 2. The tables and the bookkeeping go.
      for (const t of [...SUBRECORD_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(PLAYER_SUBRECORDS_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(PLAYER_SUBRECORDS_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec('VACUUM');

    // 3. Revalidate the completed copy before reporting it.
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(PLAYER_SUBRECORDS_MIGRATION)) problems.push('the 0007 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(PLAYER_SUBRECORDS_CUTOVER_META)) problems.push('the S5 meta key is still present');
    for (const t of SUBRECORD_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    const expected = new Map(players.map((p) => [p.id, JSON.stringify(p)]));
    for (const row of sqlite.prepare('SELECT * FROM players ORDER BY rowid').all()) {
      let back; try { back = JSON.stringify(playerFromRow(row)); } catch (err) { problems.push(`players ${row.id}: facets_json does not decode (${String(err?.message ?? err).slice(0, 80)})`); continue; }
      if (back !== expected.get(row.id)) problems.push(`players ${row.id}: the facets do not read back as the record the rows held`);
    }
    const sessionsAfter = hasTable('sessions') ? sqlite.prepare(SESSION_ROWS).all() : null;
    if (JSON.stringify(sessionsAfter) !== JSON.stringify(sessionsBefore)) problems.push('the sessions table changed');
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, players: players.length, rows: rowsPerTable, sessions: sessionsAfter ? sessionsAfter.length : 0, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
