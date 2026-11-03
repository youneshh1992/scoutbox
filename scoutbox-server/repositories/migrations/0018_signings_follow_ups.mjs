/**
 * Signing packages, completed signings, post-signing follow-ups and outcome reports (S8d) get their own typed
 * tables; `idempotency_keys` is rebuilt with the S8d owners. Runs with foreign keys off.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION } from '../recruitmentContactsOffers.mjs';
import { rebuildTable } from './0016_recruitment_cases.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION, SIGNINGS_FOLLOWUPS_DDL, SIGNINGS_FOLLOWUPS_TABLES, S8D_KEY_OWNERS } from '../signingsFollowUps.mjs';

export const id = SIGNINGS_FOLLOWUPS_MIGRATION;
export const note = 'signing packages (revisions, documents, parties, history), completed signings (parties), post-signing follow-ups and outcome reports (confirmations) become typed tables; idempotency_keys broadened to signing_packages (S8d)';
export const foreignKeysOff = true;

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CONTACTS_OFFERS_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SIGNINGS_FOLLOWUPS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_cases', 'recruitment_offers', 'offer_revisions', 'idempotency_keys', 'org_users', 'orgs']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(SIGNINGS_FOLLOWUPS_DDL);
  rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8D_KEY_OWNERS));
}
