/**
 * S4b-R — the retained player record (migration plan §D.6/§D.6.1; the Founder's decisions: the full birth date,
 * 12 October 2026, and the country code KEPT, 21 October 2026). REGISTERED in DATA_MIGRATIONS.
 *
 * No table is created and no column changes: `players.deleted_at` exists since 0005 and the retained row's
 * mapping (identity.mjs `retainedRowFor`) satisfies every constraint of the live table. The record is what
 * matters: once it exists, an account deletion keeps the row as the retained record (server.mjs
 * deletePlayerData → players.erase) instead of deleting it.
 */
import { migrationApplied } from '../database.mjs';
import { SAFETY_AUDIT_MIGRATION } from '../safetyAudit.mjs';
import { PLAYER_ERASURE_MIGRATION } from '../identity.mjs';

export const id = PLAYER_ERASURE_MIGRATION;
export const note = 'an account deletion keeps the player row as the retained record (id, deleted_at, birth_date, country; placeholders and NULL elsewhere; owned rows and links removed) instead of deleting it; the retained records of a restored backup (playersRetained) are imported; no table, no column, no foreign key, no retention period';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SAFETY_AUDIT_MIGRATION)) throw new Error(`${id}: ${SAFETY_AUDIT_MIGRATION} must be recorded first`);
}
