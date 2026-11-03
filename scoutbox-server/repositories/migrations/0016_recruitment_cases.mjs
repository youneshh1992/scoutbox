/**
 * Recruitment cases (S8b), with the Room facet, decision draft, transaction handoff and budget, and the room
 * comments, snapshots, decisions and evidence states get their own tables, and the shared `idempotency_keys` table
 * of the case graph is created with the S8b owners. REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the
 * tables start empty and are written through the repository. The request and trial `case_id` keys (0015) name
 * recruitment_cases and are checked from here on.
 */
import { migrationApplied } from '../database.mjs';
import { RECRUITMENT_MIGRATION, idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_DDL, RECRUITMENT_CASES_TABLES, S8B_KEY_OWNERS } from '../recruitmentCases.mjs';

export const id = RECRUITMENT_CASES_MIGRATION;
export const note = 'recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room snapshots, room decisions and room evidence states become their own tables (twenty-five tables; insertion and list order kept; absence, null, off-type and unknown fields kept losslessly; the player references tolerant and counted (Q8a)); idempotency_keys created for the case graph\'s owners';

/** Copy a table's rows out (seq included), drop it, recreate it from `ddl` with its indexes, and put every row back. Foreign keys must be OFF on the connection. */
export function rebuildTable(sqlite, table, { table: ddl, indexes }) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
  sqlite.exec(`DROP TABLE ${table};`);
  sqlite.exec(ddl); for (const ix of indexes) sqlite.exec(`${ix};`);
  if (rows.length) { const cols = Object.keys(rows[0]); const st = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`); for (const r of rows) st.run(r); }
  return rows.length;
}

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = [...RECRUITMENT_CASES_TABLES, 'idempotency_keys'].filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(RECRUITMENT_CASES_DDL);
  const keys = idempotencyKeysDdl(S8B_KEY_OWNERS);
  sqlite.exec(keys.table); for (const ix of keys.indexes) sqlite.exec(`${ix};`);
}
