/**
 * S4b-R — the retained player record (migration plan §D.6/§D.6.1; the Founder's
 * decisions: the full birth date, 12 October 2026, and the country code KEPT,
 * 21 October 2026). REGISTERED in DATA_MIGRATIONS.
 *
 * No table is created and no column changes: `players.deleted_at` exists since
 * 0005 and every constraint of the live table is satisfied by the retained row's
 * mapping (identity.mjs `retainedRowFor`). Inside the runner's one transaction,
 * after 0013 (safety audit):
 *   1. Refuse a file in which any players row already carries `deleted_at` (no
 *      build before this step writes it): UNEXPECTED_SCHEMA, ids only — refusing
 *      to guess their state.
 *   2. Import the `playersRetained` blob if the file carries one (a restored
 *      backup, a rollback copy being re-upgraded): every entry validated (exactly
 *      id, deletedAt, birthDate, country; no duplicate; no id that is a players row),
 *      written as retained rows, the blob row retired. ANY refusal aborts the whole
 *      step with PLAYER_ERASURE_IMPORT_BLOCKED (ids, fields and reasons — never a
 *      date): the runner rolls back, the blob and every row are untouched, the next
 *      boot refuses the same way. A file without the blob imports nothing.
 *   3. Record `meta.playerErasureCutover` ({ at, imported }: counts only).
 * The step never runs twice (recorded) and refuses to run before 0013.
 *
 * What changes at run time once this record exists: an account deletion keeps the
 * row as the retained record (server.mjs deletePlayerData → players.erase) instead
 * of deleting it. Nothing is fabricated for the ids of players deleted before this
 * step (Q4: counted, never refused, never given a parent — Q3 untouched).
 */
import { migrationApplied } from '../database.mjs';
import { SAFETY_AUDIT_MIGRATION } from '../safetyAudit.mjs';
import { PLAYER_ERASURE_MIGRATION, PLAYER_ERASURE_CUTOVER_META, importPlayersRetainedBlob } from '../identity.mjs';

export const id = PLAYER_ERASURE_MIGRATION;
export const note = 'an account deletion keeps the player row as the retained record (id, deleted_at, birth_date, country; placeholders and NULL elsewhere; owned rows and links removed) instead of deleting it; the retained records of a restored backup (playersRetained) are imported; no table, no column, no foreign key, no retention period';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SAFETY_AUDIT_MIGRATION)) throw new Error(`${id}: ${SAFETY_AUDIT_MIGRATION} must be recorded first`);
  const stray = sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL ORDER BY id').all().map((r) => r.id);
  if (stray.length) throw Object.assign(new Error(`${id}: UNEXPECTED_SCHEMA — ${stray.length} players row(s) already carry deleted_at before this step (${stray.slice(0, 20).join(', ')}${stray.length > 20 ? ', …' : ''}); no earlier build writes it, so their state is not guessed; nothing was written`), { code: 'UNEXPECTED_SCHEMA' });
  const imported = importPlayersRetainedBlob(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PLAYER_ERASURE_CUTOVER_META, JSON.stringify({ at: now, imported }));
}
