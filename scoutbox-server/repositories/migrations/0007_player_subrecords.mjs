/**
 * Player sub-records (`SUBRECORDS_DDL`): media, attendance, timeline, badges, drills, drill results, activity,
 * external ids, season history, medical records, programme completions and the rest. The seed's rows are written
 * when the data layer initialises the players (repositories/identity.mjs).
 */
import { CORE_IDENTITY_LIVE_MIGRATION } from '../identity.mjs';
import { PLAYER_SUBRECORDS_MIGRATION, SUBRECORDS_DDL, SUBRECORD_TABLES } from '../playerSubrecords.mjs';
import { migrationApplied } from '../database.mjs';

export const id = PLAYER_SUBRECORDS_MIGRATION;
export const note = 'player sub-records (media, attendance, timeline, badges, drills, drill results, activity, external ids, season history, medical records, programme completions) become their own tables; trialReports is served from the trials';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) throw new Error(`${id}: ${CORE_IDENTITY_LIVE_MIGRATION} must be recorded first (the players table must be live)`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SUBRECORD_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(SUBRECORDS_DDL);
}
