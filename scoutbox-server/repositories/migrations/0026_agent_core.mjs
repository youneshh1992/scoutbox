/**
 * The agent core: agent profiles (declared jurisdictions, verification facets, history), agency affiliations (roles,
 * history), representation agreements (scope, policy versions, opportunity shares, history) and an agency's settings.
 */
import { migrationApplied } from '../database.mjs';
import { TRANSITIONS_MIGRATION } from '../transitionsVouches.mjs';
import { AGENT_CORE_MIGRATION, AGENT_CORE_DDL, AGENT_CORE_TABLES } from '../agentCore.mjs';

export const id = AGENT_CORE_MIGRATION;
export const note = 'agent profiles, agency affiliations, representation agreements and agency settings become typed tables (S11a)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, TRANSITIONS_MIGRATION)) throw new Error(`${id}: ${TRANSITIONS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = AGENT_CORE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(AGENT_CORE_DDL);
}
