/**
 * One-time codes become their own tables (migration plan step S6a;
 * docs/architecture/s6-readiness-review.md §6). REGISTERED in DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0004 (organisations live) and
 * 0005 (players live):
 *   1. Create `email_challenges` and `pairing_codes` (ONE_TIME_CODES_DDL).
 *   2. Import the `emailChallenges` and `pairingCodes` blobs if the file holds
 *      them — the legacy plain-code shape every earlier build wrote, or the
 *      stored (hashed) shape a backup taken after this step holds — through the
 *      repository's own validation: every entry is checked (either format,
 *      never both), the plain codes are hashed on the way in and never stored,
 *      an entry already expired at this instant is NOT imported and is counted,
 *      a live entry whose organisation / player does not exist refuses the
 *      step. ANY refusal aborts the whole migration with
 *      ONE_TIME_CODES_IMPORT_BLOCKED (entry indexes and reasons, never a code):
 *      the runner rolls back, the file is byte-identical, the next boot refuses
 *      the same way until the blob is resolved by hand on the previous build.
 *   3. Retire the two blob rows; record the counts in `meta.oneTimeCodesCutover`.
 * A file without the blobs (a first installation, a database whose codes were
 * never saved) creates the tables and imports nothing. The step never runs
 * twice (recorded) and refuses to run before 0004 / 0005.
 */
import { migrationApplied } from '../database.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from '../identityPreflight.mjs';
import { ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_CUTOVER_META, ONE_TIME_CODES_DDL, ONE_TIME_CODE_TABLES, importCodeBlobs } from '../oneTimeCodes.mjs';

export const id = ONE_TIME_CODES_MIGRATION;
export const note = 'one-time codes (club e-mail challenges, child pairing codes) become their own tables, stored as hashes with expiry and attempt counts';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, '0004_orgs_live')) throw new Error(`${id}: 0004_orgs_live must be recorded first (the orgs table must be live)`);
  if (!migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) throw new Error(`${id}: ${CORE_IDENTITY_LIVE_MIGRATION} must be recorded first (the players table must be live)`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = ONE_TIME_CODE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(ONE_TIME_CODES_DDL);
  const counts = importCodeBlobs(sqlite, { now });
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ONE_TIME_CODES_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
