/**
 * The development domain: development objectives (items, exercise references, baseline evidence, progress, shares,
 * reassessments), drill-guidance reviews, and the Development Hub's plans, goals, actions, evidence links and reviews
 * with one history table.
 */
import { migrationApplied } from '../database.mjs';
import { AGENT_TRANSACTIONS_MIGRATION } from '../agentTransactions.mjs';
import { DEVELOPMENT_MIGRATION, DEVELOPMENT_DDL, DEVELOPMENT_TABLES } from '../development.mjs';

export const id = DEVELOPMENT_MIGRATION;
export const note = 'development objectives, drill-guidance reviews and the Development Hub (plans, goals, actions, evidence links, reviews, history) become typed tables';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, AGENT_TRANSACTIONS_MIGRATION)) throw new Error(`${id}: ${AGENT_TRANSACTIONS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = DEVELOPMENT_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(DEVELOPMENT_DDL);
}
