/**
 * One-time codes (S6a): club e-mail challenges and child pairing codes get their own tables, stored as hashes
 * with expiry and attempt counts.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from '../identityPreflight.mjs';
import { ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_DDL, ONE_TIME_CODE_TABLES } from '../oneTimeCodes.mjs';

export const id = ONE_TIME_CODES_MIGRATION;
export const note = 'one-time codes (club e-mail challenges, child pairing codes) become their own tables, stored as hashes with expiry and attempt counts';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, '0004_orgs_live')) throw new Error(`${id}: 0004_orgs_live must be recorded first (the orgs table must be live)`);
  if (!migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) throw new Error(`${id}: ${CORE_IDENTITY_LIVE_MIGRATION} must be recorded first (the players table must be live)`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = ONE_TIME_CODE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(ONE_TIME_CODES_DDL);
}
