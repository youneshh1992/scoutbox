/**
 * Trust & Safety reviewers (with history) and jurisdiction policy versions (publishers, rules with sources, overrides
 * and typed parameters, history). Also inserts the catalogue: the three seeded policy versions (FIFA, the FA, U.S.
 * Soccer), published and attributed to this migration, which every database has from its first boot.
 */
import { migrationApplied } from '../database.mjs';
import { AGENT_CORE_MIGRATION } from '../agentCore.mjs';
import {
  COMPLIANCE_POLICIES_MIGRATION,
  COMPLIANCE_POLICIES_DDL,
  COMPLIANCE_POLICIES_TABLES,
  insertSeededPolicies,
} from '../compliancePolicies.mjs';

export const id = COMPLIANCE_POLICIES_MIGRATION;
export const note =
  'Trust & Safety reviewers and jurisdiction policy versions become typed tables; the seeded policy versions are inserted';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, AGENT_CORE_MIGRATION))
    throw new Error(`${id}: ${AGENT_CORE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = COMPLIANCE_POLICIES_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  sqlite.exec(COMPLIANCE_POLICIES_DDL);
  insertSeededPolicies(sqlite, now);
}
