/**
 * Transition cases and coach references (vouches) become typed tables (S10c). The legacy M13 F10 representations move
 * with the agent stores in S11 (step 2305 mirrors them into the agent agreements).
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only; nothing is carried over (no production data; rollback means
 * re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { PASSPORT_MIGRATION } from '../passport.mjs';
import { TRANSITIONS_MIGRATION, TRANSITIONS_DDL, TRANSITIONS_TABLES } from '../transitionsVouches.mjs';

export const id = TRANSITIONS_MIGRATION;
export const note = 'Transition cases (pack items, grants, history) and coach references become typed tables (S10c)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, PASSPORT_MIGRATION)) throw new Error(`${id}: ${PASSPORT_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = TRANSITIONS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  if (!hasTable('orgs')) throw new Error(`${id}: orgs is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(TRANSITIONS_DDL);
}
