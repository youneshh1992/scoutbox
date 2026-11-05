/**
 * Trust & Safety reviewers and jurisdiction policy versions get their own typed tables (S11b-1): a reviewer with its
 * history; a policy version with its publishers, rules (sources, overrides, typed parameters) and history. REGISTERED
 * in DATA_MIGRATIONS. `up()` is the DDL plus the catalogue: the three seeded policy versions (FIFA, the FA, U.S. Soccer),
 * published and attributed to this migration, which every database has from its first boot (blob step 2306 used to
 * push them into memory). Nothing else is carried over (no production data; rollback means re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { AGENT_CORE_MIGRATION } from '../agentCore.mjs';
import { COMPLIANCE_POLICIES_MIGRATION, COMPLIANCE_POLICIES_DDL, COMPLIANCE_POLICIES_TABLES, insertSeededPolicies } from '../compliancePolicies.mjs';

export const id = COMPLIANCE_POLICIES_MIGRATION;
export const note = 'Trust & Safety reviewers and jurisdiction policy versions become typed tables; the seeded policy versions are inserted (S11b-1)';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, AGENT_CORE_MIGRATION)) throw new Error(`${id}: ${AGENT_CORE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = COMPLIANCE_POLICIES_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(COMPLIANCE_POLICIES_DDL);
  insertSeededPolicies(sqlite, now);
}
