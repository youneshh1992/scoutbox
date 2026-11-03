/**
 * The eight audit collections (S6b) get their own tables: blocks, reports, moderation_log, org_notes, ledger,
 * ops_events, source_changes and idv_queue.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start empty and are written
 * through the repository.
 */
import { migrationApplied } from '../database.mjs';
import { CHANNELS_MIGRATION } from '../channels.mjs';
import { SAFETY_AUDIT_MIGRATION, SAFETY_AUDIT_DDL, AUDIT_TABLE_NAMES } from '../safetyAudit.mjs';

export const id = SAFETY_AUDIT_MIGRATION;
export const note = 'the eight audit collections become their own tables (blocks, reports, moderation_log, org_notes, ledger, ops_events, source_changes, idv_queue; insertion order kept; typed columns, unknown fields dropped and off-type values normalised or dropped, each reported by id; no foreign key — the five player references tolerant and counted (Q4), the IDV guardian reference checked strictly in code (Q4b), the block lift still a delete (Q5))';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, CHANNELS_MIGRATION)) throw new Error(`${id}: ${CHANNELS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = AUDIT_TABLE_NAMES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(SAFETY_AUDIT_DDL);
}
