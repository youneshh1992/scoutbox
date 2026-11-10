/**
 * The opportunity board, applications, assessment campaigns (drills, rubric, submissions and attempts) and players'
 * private suitability preferences.
 */
import { migrationApplied } from '../database.mjs';
import { CLUB_SETUP_MIGRATION } from '../clubSetup.mjs';
import {
  OPPORTUNITIES_CAMPAIGNS_MIGRATION,
  OPPORTUNITIES_CAMPAIGNS_DDL,
  OPPORTUNITIES_CAMPAIGNS_TABLES,
} from '../opportunitiesCampaigns.mjs';

export const id = OPPORTUNITIES_CAMPAIGNS_MIGRATION;
export const note =
  'opportunities, applications, campaigns (drills, rubric, submissions, attempts) and player suitability preferences become typed tables';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, CLUB_SETUP_MIGRATION))
    throw new Error(`${id}: ${CLUB_SETUP_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = OPPORTUNITIES_CAMPAIGNS_TABLES.filter(hasTable);
  if (existing.length)
    throw new Error(
      `${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`,
    );
  for (const t of ['orgs', 'org_users'])
    if (!hasTable(t))
      throw new Error(
        `${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`,
      );
  sqlite.exec(OPPORTUNITIES_CAMPAIGNS_DDL);
}
