/**
 * Recruitment contacts and offers (ten tables). Runs with foreign keys off.
 */
import { migrationApplied } from '../database.mjs';
import { RECRUITMENT_CASES_MIGRATION } from '../recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION, RECRUITMENT_CONTACTS_OFFERS_DDL, RECRUITMENT_CONTACTS_OFFERS_TABLES } from '../recruitmentContactsOffers.mjs';

export const id = RECRUITMENT_CONTACTS_OFFERS_MIGRATION;
export const note = 'recruitment contacts and offers become typed tables (ten tables)';
export const foreignKeysOff = true;

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_CASES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_CONTACTS_OFFERS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_requests', 'recruitment_cases', 'orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although ${RECRUITMENT_CASES_MIGRATION} is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_CONTACTS_OFFERS_DDL);
}
