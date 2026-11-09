/**
 * Recruitment cases (with the Room facet, decision draft, transaction handoff and budget) and the room comments,
 * snapshots, decisions and evidence states (repositories/recruitmentCases.mjs).
 */
import { migrationApplied } from '../database.mjs';
import { RECRUITMENT_MIGRATION } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_DDL, RECRUITMENT_CASES_TABLES } from '../recruitmentCases.mjs';

export const id = RECRUITMENT_CASES_MIGRATION;
export const note = 'recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room snapshots, room decisions and room evidence states become typed tables (twenty-five tables; the player references tolerant and counted (Q8a))';

/** Copy a table's rows out, drop it, recreate it from `ddl` with its indexes, and put every row back. Foreign keys must be OFF on the connection. */
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
  const existing = RECRUITMENT_CASES_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(RECRUITMENT_CASES_DDL);
}
