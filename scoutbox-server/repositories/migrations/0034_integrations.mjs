/**
 * Integrations: import batches (columns, rows, row errors and history as rows), the prospects an import creates,
 * identity reviews (the record is the batch row they name), API keys (hash only, scopes as rows), webhook endpoints
 * (events as rows) and webhook deliveries (a typed payload, attempts as rows).
 */
import { migrationApplied } from '../database.mjs';
import { INSIGHT_COVERAGE_MIGRATION } from '../insightCoverage.mjs';
import { INTEGRATIONS_MIGRATION, INTEGRATIONS_DDL, INTEGRATIONS_TABLES } from '../integrations.mjs';

export const id = INTEGRATIONS_MIGRATION;
export const note = 'Import batches, prospects, identity reviews, API keys, webhook endpoints and webhook deliveries become typed tables (S13a)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, INSIGHT_COVERAGE_MIGRATION)) throw new Error(`${id}: ${INSIGHT_COVERAGE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = INTEGRATIONS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(INTEGRATIONS_DDL);
}
