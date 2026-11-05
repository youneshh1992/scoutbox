/**
 * The Agent Transaction Workspace gets its own typed tables (S11c): transactions (jurisdictions, parties, the
 * compliance snapshot naming its evaluation row, notes, linked threads, terms versions, replay keys, history),
 * representation bindings (scopes, history) and documents (version chain, history). REGISTERED in DATA_MIGRATIONS.
 * `up()` is the DDL only: nothing is carried over (no production data; rollback means re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { COMPLIANCE_RECORDS_MIGRATION } from '../complianceRecords.mjs';
import { AGENT_TRANSACTIONS_MIGRATION, AGENT_TRANSACTIONS_DDL, AGENT_TRANSACTIONS_TABLES } from '../agentTransactions.mjs';

export const id = AGENT_TRANSACTIONS_MIGRATION;
export const note = 'agent transactions, their representation bindings and their documents become typed tables (S11c)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, COMPLIANCE_RECORDS_MIGRATION)) throw new Error(`${id}: ${COMPLIANCE_RECORDS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = AGENT_TRANSACTIONS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'compliance_contexts', 'compliance_evaluations', 'regulatory_reviews', 'representation_agreements', 'jurisdiction_policies', 'ver_evidence', 'recruitment_cases']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(AGENT_TRANSACTIONS_DDL);
}
