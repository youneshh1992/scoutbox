/**
 * Enterprise: staff invites (the emailed code stored only as its hash), SSO configurations, SSO sign-in states (state
 * and nonce stored only as hashes), support tickets (references and replies as rows) and support access grants (the
 * access log as rows).
 */
import { migrationApplied } from '../database.mjs';
import { INTEGRATIONS_MIGRATION } from '../integrations.mjs';
import { ENTERPRISE_MIGRATION, ENTERPRISE_DDL, ENTERPRISE_TABLES } from '../enterprise.mjs';

export const id = ENTERPRISE_MIGRATION;
export const note = 'Staff invites, SSO configurations and sign-in states, support tickets and support access grants become typed tables (S13b)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, INTEGRATIONS_MIGRATION)) throw new Error(`${id}: ${INTEGRATIONS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = ENTERPRISE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(ENTERPRISE_DDL);
}
