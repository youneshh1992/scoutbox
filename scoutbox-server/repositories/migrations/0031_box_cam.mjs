/**
 * Box Cam, the At-Home Combine and the production CV results: preferences, challenges and entries, assignments,
 * sessions (observations, reasons and integrity history as rows), disputes, Combine requests and attempts, and CV
 * results. Also inserts the two ScoutBox challenges (a seeded catalogue).
 */
import { migrationApplied } from '../database.mjs';
import { DEVELOPMENT_MIGRATION } from '../development.mjs';
import { BOX_CAM_MIGRATION, BOX_CAM_DDL, BOX_CAM_TABLES, seedScoutboxChallenges } from '../boxCam.mjs';

export const id = BOX_CAM_MIGRATION;
export const note =
  'Box Cam preferences, challenges, assignments, sessions and disputes, Combine requests and attempts, and production CV results become typed tables';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, DEVELOPMENT_MIGRATION))
    throw new Error(`${id}: ${DEVELOPMENT_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = BOX_CAM_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  for (const t of ['orgs', 'org_users', 'dev_objectives']) {
    if (!hasTable(t))
      throw new Error(
        `${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`,
      );
  }
  sqlite.exec(BOX_CAM_DDL);
  seedScoutboxChallenges(sqlite, now);
}
