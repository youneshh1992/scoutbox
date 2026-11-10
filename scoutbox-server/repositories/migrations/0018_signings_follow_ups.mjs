/**
 * Signing packages, completed signings, post-signing follow-ups and outcome reports, and `idempotency_keys` for the
 * signing packages' keys. Runs with foreign keys off.
 */
import { migrationApplied } from '../database.mjs';
import { idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION } from '../recruitmentContactsOffers.mjs';
import {
  SIGNINGS_FOLLOWUPS_MIGRATION,
  SIGNINGS_FOLLOWUPS_DDL,
  SIGNINGS_FOLLOWUPS_TABLES,
  SIGNINGS_KEY_OWNERS,
} from '../signingsFollowUps.mjs';

export const id = SIGNINGS_FOLLOWUPS_MIGRATION;
export const note =
  'signing packages (revisions, documents, parties, history), completed signings (parties), post-signing follow-ups and outcome reports (confirmations) become typed tables; idempotency_keys created for signing_packages';
export const foreignKeysOff = true;

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CONTACTS_OFFERS_MIGRATION))
    throw new Error(`${id}: ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SIGNINGS_FOLLOWUPS_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  for (const t of ['recruitment_cases', 'recruitment_offers', 'offer_revisions', 'org_users', 'orgs'])
    if (!hasTable(t))
      throw new Error(
        `${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`,
      );
  sqlite.exec(SIGNINGS_FOLLOWUPS_DDL);
  if (hasTable('idempotency_keys'))
    throw new Error(`${id}: idempotency_keys already exists without the migration record; refusing to guess its state`);
  const keys = idempotencyKeysDdl(SIGNINGS_KEY_OWNERS);
  sqlite.exec(keys.table);
  for (const ix of keys.indexes) sqlite.exec(`${ix};`);
}
