/**
 * Recruitment contacts and offers (S8c) get their own tables; `idempotency_keys` is rebuilt with the S8c owners.
 * Runs with foreign keys off.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION } from '../recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION, RECRUITMENT_CONTACTS_OFFERS_DDL, RECRUITMENT_CONTACTS_OFFERS_TABLES, S8C_KEY_OWNERS } from '../recruitmentContactsOffers.mjs';
import { rebuildTable } from './0016_recruitment_cases.mjs';

export const id = RECRUITMENT_CONTACTS_OFFERS_MIGRATION;
export const note = 'recruitment contacts and offers become their own tables (nine tables)';
export const foreignKeysOff = true;

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_CASES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_CONTACTS_OFFERS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_requests', 'recruitment_cases', 'idempotency_keys']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although ${RECRUITMENT_CASES_MIGRATION} is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_CONTACTS_OFFERS_DDL);
  rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8C_KEY_OWNERS));
}
