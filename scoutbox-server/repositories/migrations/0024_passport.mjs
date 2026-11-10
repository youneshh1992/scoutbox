/**
 * The Football Passport's own records: preferences (secondary positions, position history and public selections as
 * child rows), career entries, achievements, share links and correction requests.
 */
import { migrationApplied } from '../database.mjs';
import { VERIFICATION_MIGRATION } from '../verification.mjs';
import { PASSPORT_MIGRATION, PASSPORT_DDL, PASSPORT_TABLES } from '../passport.mjs';

export const id = PASSPORT_MIGRATION;
export const note = 'Passport preferences, career entries, achievements, share links and correction requests become typed tables';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, VERIFICATION_MIGRATION)) throw new Error(`${id}: ${VERIFICATION_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = PASSPORT_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  if (!hasTable('orgs')) throw new Error(`${id}: orgs is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(PASSPORT_DDL);
}
