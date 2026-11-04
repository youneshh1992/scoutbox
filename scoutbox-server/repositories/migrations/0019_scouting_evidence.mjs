/**
 * The evidence passport (records, media links, disputes, history), coach affiliations (history) and squad
 * invitations (S9a) get their own typed tables. REGISTERED in DATA_MIGRATIONS. `up()` is the DDL only: the tables start
 * empty and are written through the repository (repositories/scoutingEvidence.mjs).
 */
import { migrationApplied } from '../database.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION } from '../signingsFollowUps.mjs';
import { SCOUTING_EVIDENCE_MIGRATION, SCOUTING_EVIDENCE_DDL, SCOUTING_EVIDENCE_TABLES } from '../scoutingEvidence.mjs';

export const id = SCOUTING_EVIDENCE_MIGRATION;
export const note = 'evidence passport records (media links, disputes, history), coach affiliations (history) and squad invitations become typed tables (S9a)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SIGNINGS_FOLLOWUPS_MIGRATION)) throw new Error(`${id}: ${SIGNINGS_FOLLOWUPS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SCOUTING_EVIDENCE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(SCOUTING_EVIDENCE_DDL);
}
