/**
 * The retained player record. No table or column changes: once this migration is recorded, an account deletion
 * keeps the player row as the retained record (identity.mjs `retainedRowFor`, via players.erase) instead of
 * deleting it. The full birth date and the country code are kept: Founder's decisions (docs/decisions.md).
 */
import { migrationApplied } from '../database.mjs';
import { SAFETY_AUDIT_MIGRATION } from '../safetyAudit.mjs';
import { PLAYER_ERASURE_MIGRATION } from '../identity.mjs';

export const id = PLAYER_ERASURE_MIGRATION;
export const note = 'an account deletion keeps the player row as the retained record (id, deleted_at, birth_date, country; placeholders and NULL elsewhere; owned rows and links removed) instead of deleting it; no table, no column, no foreign key, no retention period';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SAFETY_AUDIT_MIGRATION)) throw new Error(`${id}: ${SAFETY_AUDIT_MIGRATION} must be recorded first`);
}
