/**
 * The eight audit collections become their own tables (migration plan step S6b —
 * Candidate A of docs/architecture/sqlite-migration-plan.md §D.4 as accepted at
 * 1792fc7; the Founder's decisions Q4, Q4b and Q5 of 19 October 2026). REGISTERED in
 * DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0012 (channels):
 *   1. Create blocks, reports, moderation_log, org_notes, ledger, ops_events,
 *      source_changes and idv_queue (SAFETY_AUDIT_DDL) — no foreign key on any of them.
 *   2. Import the eight blobs the file holds through the repository's own validation:
 *      every entry checked (an object with a non-empty string id, unique within its
 *      collection; a value JSON can carry), nothing coerced, narrowed or dropped — the
 *      array position becomes `seq`; unknown own fields are kept in `extra_json`; an
 *      absent known key is recorded in `absent_keys_json`; a known key whose value is
 *      not the column's type (the numeric or object targetPlayerId handleReport stores
 *      as received, a block's unchecked orgId) is kept as JSON in `offtype_json`; the
 *      ledger's userId/scoutName are kept verbatim (no actor kind derived); every
 *      ops-event kind is an ordinary row. Domain P (the five player references): a
 *      row naming a player that is not in the players table is imported as it is and
 *      COUNTED per collection — never refused, never given a fabricated parent, never
 *      deleted. Domain G (STRICT): an idv_queue entry whose guardianId is not a
 *      non-empty string or names no guardian refuses the step (IDV_GUARDIAN_MISSING).
 *      ANY refusal aborts the whole migration with SAFETY_AUDIT_IMPORT_BLOCKED
 *      (collections, positions, ids and reasons — never a reason text, a note, an
 *      excerpt, a name or a document value): the runner rolls back, every blob and
 *      saveSeq are untouched, the next boot refuses the same way.
 *   3. Retire the eight blob rows; record the counts in `meta.safetyAuditCutover`.
 * A file without the blobs (a first installation) creates the tables and imports
 * nothing — never from the seed, never from memory. The step never runs twice
 * (recorded) and refuses to run before 0012 or when any of the eight tables already
 * exists.
 */
import { migrationApplied } from '../database.mjs';
import { CHANNELS_MIGRATION } from '../channels.mjs';
import { SAFETY_AUDIT_MIGRATION, SAFETY_AUDIT_CUTOVER_META, SAFETY_AUDIT_DDL, AUDIT_TABLE_NAMES, importSafetyAuditBlobs } from '../safetyAudit.mjs';

export const id = SAFETY_AUDIT_MIGRATION;
export const note = 'the eight audit collections become their own tables (blocks, reports, moderation_log, org_notes, ledger, ops_events, source_changes, idv_queue; insertion order kept; unknown fields, absent keys and off-type values kept losslessly; no foreign key — the five player references tolerant and counted (Q4), the IDV guardian reference checked strictly in code (Q4b), the block lift still a delete (Q5))';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, CHANNELS_MIGRATION)) throw new Error(`${id}: ${CHANNELS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = AUDIT_TABLE_NAMES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(SAFETY_AUDIT_DDL);
  const counts = importSafetyAuditBlobs(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SAFETY_AUDIT_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
