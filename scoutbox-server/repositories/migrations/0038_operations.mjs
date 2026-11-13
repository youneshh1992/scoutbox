/**
 * Upload sessions (chunks as rows), saved searches (typed filters), invoices (minor units, one per signing), the demo
 * reputation seed and the delivery centre's bookkeeping (callback ids applied, the instant the centre started, injected
 * failures by channel), with the delivery centre's rows. Each set of tables belongs to its own repository. Plans and
 * archetypes are constants (catalogue.mjs), not tables.
 */
import { migrationApplied } from '../database.mjs';
import { GRASSROOTS_MIGRATION } from '../grassroots.mjs';
import { UPLOAD_SESSIONS_DDL, UPLOAD_SESSIONS_TABLES } from '../uploadSessions.mjs';
import { SAVED_SEARCHES_DDL, SAVED_SEARCHES_TABLES } from '../savedSearches.mjs';
import { INVOICES_DDL, INVOICES_TABLES } from '../invoices.mjs';
import { REPUTATION_SEED_DDL, REPUTATION_SEED_TABLES } from '../reputationSeed.mjs';
import { DELIVERY_BOOKKEEPING_DDL, DELIVERY_BOOKKEEPING_TABLES, seedDeliveryRows } from '../deliveryBookkeeping.mjs';

export const id = '0038_operations';
export const note =
  "Upload sessions, saved searches, invoices, the demo reputation seed and the delivery centre's bookkeeping become typed tables";

export const TABLES = Object.freeze([
  ...UPLOAD_SESSIONS_TABLES,
  ...SAVED_SEARCHES_TABLES,
  ...INVOICES_TABLES,
  ...REPUTATION_SEED_TABLES,
  ...DELIVERY_BOOKKEEPING_TABLES,
]);

export function up(sqlite, { now }) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, GRASSROOTS_MIGRATION))
    throw new Error(`${id}: ${GRASSROOTS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  for (const t of ['orgs', 'org_users', 'signings']) {
    if (!hasTable(t))
      throw new Error(
        `${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`,
      );
  }
  for (const ddl of [
    UPLOAD_SESSIONS_DDL,
    SAVED_SEARCHES_DDL,
    INVOICES_DDL,
    REPUTATION_SEED_DDL,
    DELIVERY_BOOKKEEPING_DDL,
  ])
    sqlite.exec(ddl);
  seedDeliveryRows(sqlite, now);
}
