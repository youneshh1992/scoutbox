/**
 * Grassroots operations get their own typed tables (S13d): open days (positions and registrations as rows; deleting
 * one stamps it), match days (credited players as rows) and the friendlies board (responses as rows). A coverage
 * assignment's key to a friendly or an open day (declared by 0033) resolves from here on.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: nothing is carried over (no production data; rollback means
 * re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { GROUPS_MIGRATION } from '../groups.mjs';
import { GRASSROOTS_MIGRATION, GRASSROOTS_DDL, GRASSROOTS_TABLES } from '../grassroots.mjs';

export const id = GRASSROOTS_MIGRATION;
export const note = 'Open days (positions, registrations), match days (credited players) and the friendlies board (responses) become typed tables (S13d)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, GROUPS_MIGRATION)) throw new Error(`${id}: ${GROUPS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = GRASSROOTS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'coverage_assignments']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('coverage_assignments')").all().map((c) => c.name);
  if (!columns.includes('open_trial_id')) {
    throw new Error(`${id}: coverage_assignments was created by an earlier build of 0033 (no open_trial_id column); re-seed the database (npm run reseed)`);
  }
  sqlite.exec(GRASSROOTS_DDL);
}
