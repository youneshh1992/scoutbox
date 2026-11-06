/**
 * The remaining operations collections get their own typed tables (S13e): resumable upload sessions (chunks as rows),
 * saved searches (typed filters), invoices (minor units, one per signing), the demo reputation seed and the delivery
 * centre's bookkeeping (callback ids applied, the instant the centre started, injected failures by channel).
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL and the delivery centre's two singleton rows: nothing is carried over
 * (no production data; rollback means re-seed). Plans and archetypes are constants (catalogue.mjs), not tables.
 */
import { migrationApplied } from '../database.mjs';
import { GRASSROOTS_MIGRATION } from '../grassroots.mjs';
import { OPERATIONS_MIGRATION, OPERATIONS_DDL, OPERATIONS_TABLES, seedOperationsRows } from '../operations.mjs';

export const id = OPERATIONS_MIGRATION;
export const note = 'Upload sessions, saved searches, invoices, the demo reputation seed and the delivery centre\'s bookkeeping become typed tables (S13e)';

export function up(sqlite, { now }) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, GRASSROOTS_MIGRATION)) throw new Error(`${id}: ${GRASSROOTS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = OPERATIONS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'signings']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(OPERATIONS_DDL);
  seedOperationsRows(sqlite, now);
}
