/**
 * The compliance engine's records: compliance contexts (jurisdictions, parties, representations, resolved facts,
 * history) and their append-only evaluations (reasons, outstanding consents, policy versions, the identity of the
 * inputs); regulatory reviews (subject by kind, reasons, versions, evidence, decision, history); consents (regarding,
 * versions, rule ids, history) and their revocations.
 */
import { migrationApplied } from '../database.mjs';
import { COMPLIANCE_POLICIES_MIGRATION } from '../compliancePolicies.mjs';
import { COMPLIANCE_RECORDS_MIGRATION, COMPLIANCE_RECORDS_DDL, COMPLIANCE_RECORDS_TABLES } from '../complianceRecords.mjs';

export const id = COMPLIANCE_RECORDS_MIGRATION;
export const note = 'compliance contexts and their evaluations, regulatory reviews and consents (with revocations) become typed tables (S11b-2)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, COMPLIANCE_POLICIES_MIGRATION)) throw new Error(`${id}: ${COMPLIANCE_POLICIES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = COMPLIANCE_RECORDS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'agent_profiles', 'representation_agreements', 'ts_reviewers', 'jurisdiction_policies']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(COMPLIANCE_RECORDS_DDL);
}
