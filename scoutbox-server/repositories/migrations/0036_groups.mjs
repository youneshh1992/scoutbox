/**
 * Group workspaces and group grants: groups with their members (an admin flag on the member row), pending invites,
 * shared templates and programmes; grants with their recipients as ordered rows.
 */
import { migrationApplied } from '../database.mjs';
import { ENTERPRISE_MIGRATION } from '../enterprise.mjs';
import { GROUPS_MIGRATION, GROUPS_DDL, GROUPS_TABLES } from '../groups.mjs';

export const id = GROUPS_MIGRATION;
export const note = 'Group workspaces (members, invites, shared templates, programmes) and group grants (recipients) become typed tables (S13c)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, ENTERPRISE_MIGRATION)) throw new Error(`${id}: ${ENTERPRISE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = GROUPS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  if (!hasTable('orgs')) throw new Error(`${id}: orgs is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(GROUPS_DDL);
}
