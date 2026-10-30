/**
 * Delivery dispatch records and their attempts become their own tables
 * (migration plan step S7b; docs/architecture/s7-readiness-review.md §9 as
 * corrected by the review of dc4b559). REGISTERED in DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0009 (notifications):
 *   1. Create `dispatches` and `dispatch_attempts` (DISPATCHES_DDL).
 *   2. Import the `dispatches` blob if the file holds it — the eighteen-key
 *      literal every build since M13 wrote, attempts nested — through the
 *      repository's own validation: every entry is checked, nothing is coerced
 *      or normalised; the array position becomes the durable ordering key and
 *      each attempt's position its key; unknown own fields are kept in
 *      `extra_json`; a finite fractional callback timestamp is stored exactly;
 *      a dispatch whose notification no longer exists (an ordinary deletion
 *      left it behind) is imported unchanged and COUNTED as an orphan
 *      reference — never refused, pruned or re-parented. ANY refusal aborts
 *      the whole migration with DISPATCHES_IMPORT_BLOCKED (entry indexes and
 *      reasons, never an address or a provider text): the runner rolls back,
 *      the blob and saveSeq are untouched, the next boot refuses the same way.
 *   3. Retire the blob row; record the counts in `meta.dispatchesCutover`
 *      (imported, attempts, withExtraFields, orphanReferences, byStatus).
 * A file without the blob (a first installation, a database saved before M13)
 * creates the tables and imports nothing — never from the seed, never from
 * memory. The step never runs twice (recorded) and refuses to run before 0009
 * or when either table already exists.
 */
import { migrationApplied } from '../database.mjs';
import { NOTIFICATIONS_MIGRATION } from '../notifications.mjs';
import { DISPATCHES_MIGRATION, DISPATCHES_CUTOVER_META, DISPATCHES_DDL, DISPATCH_TABLES, importDispatchesBlob } from '../dispatches.mjs';

export const id = DISPATCHES_MIGRATION;
export const note = 'delivery dispatch records and their attempts become their own tables (insertion order kept; notification reference indexed, no foreign key)';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, NOTIFICATIONS_MIGRATION)) throw new Error(`${id}: ${NOTIFICATIONS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = DISPATCH_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(DISPATCHES_DDL);
  const counts = importDispatchesBlob(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DISPATCHES_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
