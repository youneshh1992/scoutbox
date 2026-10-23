/**
 * Recruitment cases, room comments, room snapshots, room decisions and room evidence states become their own tables
 * (migration plan step S8b; docs/architecture/s8b-readiness-review.md as independently accepted at 4d2c74b; the
 * Founder's explicit Q8a answer of 23 October 2026: tolerant, counted player references). REGISTERED in
 * DATA_MIGRATIONS. Runs with foreign keys OFF (the runner's `foreignKeysOff`): the step rebuilds `recruitment_requests`,
 * `trials` and `idempotency_keys`, which other tables reference, and `PRAGMA foreign_key_check` must report nothing
 * before it commits — every reference is also checked explicitly, with ids only, before a row is written.
 *
 * Inside the runner's one transaction, after 0015 (recruitment):
 *   1. Create the twenty-five case and room tables (RECRUITMENT_CASES_DDL).
 *   2. Import the five blobs the file holds through the repository's own preflight (every entry's identifiers, no
 *      duplicate id, every link naming a request/trial of the S8a tables, every room row naming a case of the file,
 *      the decision chain, every organisation and staff id in its table; the player ids counted as live, retained or
 *      missing and never refused — Q8a) in the review's order: A the cases with their owned children, then
 *   3. the two S8a parents rebuilt with the REAL `case_id` key to recruitment_cases (Q7b's conversion: every row and
 *      its seq copied out and back, the indexes recreated), then C the link rows, D the room rows;
 *   4. `idempotency_keys` rebuilt with the broadened owner CHECK (every S8a key row copied back; the S8b owners' rows
 *      were written by D inside the broadened definition — see below);
 *   5. the five blob rows retired; the counts recorded in `meta.recruitmentCasesCutover`.
 * Nothing is coerced or normalised. ANY refusal aborts the whole migration with RECRUITMENT_CASES_IMPORT_BLOCKED, its
 * detail naming the specific refusal with positions, tables and ids — never a name, a note or a body: the runner rolls
 * back, the blobs and saveSeq are untouched, the next boot refuses the same way. A file without the blobs (a first
 * installation) creates the tables and imports nothing — never from the seed, never from memory. The step never runs
 * twice (recorded) and refuses to run before 0015 or when any of the tables already exists.
 *
 * The key table is broadened FIRST (step 4 runs before step 2's room rows need it: the CHECK would refuse a
 * `room_decisions` owner otherwise); the order of the numbered list above is the data order, the code's is: tables,
 * broaden the key table, import (A, rebuild parents, C, D), retire the blobs, record.
 */
import { migrationApplied } from '../database.mjs';
import { RECRUITMENT_MIGRATION, recruitmentParentDdl, idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_CUTOVER_META, RECRUITMENT_CASES_FORMAT_META, RECRUITMENT_CASES_KEY_FORMAT, RECRUITMENT_CASES_DDL, RECRUITMENT_CASES_TABLES, S8B_KEY_OWNERS, importRecruitmentCasesBlobs } from '../recruitmentCases.mjs';

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

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_CASES_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_requests', 'trials', 'idempotency_keys']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although ${RECRUITMENT_MIGRATION} is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_CASES_DDL);
  const keyRows = rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8B_KEY_OWNERS));
  let parents = null;
  const counts = importRecruitmentCasesBlobs(sqlite, { rebuildParents: () => { parents = rebuildRecruitmentParents(sqlite, { caseKey: true }); } });
  // the persisted key format, in the same transaction as the rows (review of 2fe05df, R1): the readers refuse a 0016 file without it
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECRUITMENT_CASES_FORMAT_META, RECRUITMENT_CASES_KEY_FORMAT);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECRUITMENT_CASES_CUTOVER_META, JSON.stringify({ at: now, ...counts, rebuilt: { ...parents, idempotencyKeys: keyRows } }));
}
