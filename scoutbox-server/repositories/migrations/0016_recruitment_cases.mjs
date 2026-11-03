/**
 * Recruitment cases (S8b), with the Room facet, decision draft, transaction handoff and budget, and the room
 * comments, snapshots, decisions and evidence states get their own tables. `recruitment_requests` and `trials`
 * are rebuilt with the real case key and `idempotency_keys` with the S8b owners. Runs with foreign keys off.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { RECRUITMENT_MIGRATION, recruitmentParentDdl, idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_DDL, RECRUITMENT_CASES_TABLES, S8B_KEY_OWNERS } from '../recruitmentCases.mjs';

export const id = RECRUITMENT_CASES_MIGRATION;
export const note = 'recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room snapshots, room decisions and room evidence states become their own tables (twenty-five tables; insertion and list order kept; absence, null, off-type and unknown fields kept losslessly; the player references tolerant and counted (Q8a)); recruitment_requests and trials rebuilt with the real case_id key (Q7b); idempotency_keys rebuilt with the broadened owner CHECK';
export const foreignKeysOff = true;

/** Copy a table's rows out (seq included), drop it, recreate it from `ddl` with its indexes, and put every row back. Foreign keys must be OFF on the connection. */
export function rebuildTable(sqlite, table, { table: ddl, indexes }) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
  sqlite.exec(`DROP TABLE ${table};`);
  sqlite.exec(ddl); for (const ix of indexes) sqlite.exec(`${ix};`);
  if (rows.length) { const cols = Object.keys(rows[0]); const st = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`); for (const r of rows) st.run(r); }
  return rows.length;
}
/** The two S8a parents with the real case key (0016) or without it again (the S8b rollback). */
export function rebuildRecruitmentParents(sqlite, { caseKey }) {
  return { requests: rebuildTable(sqlite, 'recruitment_requests', recruitmentParentDdl('recruitment_requests', { caseKey })), trials: rebuildTable(sqlite, 'trials', recruitmentParentDdl('trials', { caseKey })) };
}

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_CASES_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_requests', 'trials', 'idempotency_keys']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although ${RECRUITMENT_MIGRATION} is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_CASES_DDL);
  rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8B_KEY_OWNERS));
  rebuildRecruitmentParents(sqlite, { caseKey: true });
}
