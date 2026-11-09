/**
 * Discovery: Recruitment Briefs (criteria as columns and rows, the audit trail), Nobody Missed reviews, Second Look
 * items (fingerprints, resolved reasons and trail as rows), and Dynamic Watchlists (criteria by kind, the last derived
 * membership, the lifecycle trail and the membership transitions).
 */
import { migrationApplied } from '../database.mjs';
import { BOX_CAM_MIGRATION } from '../boxCam.mjs';
import { DISCOVERY_MIGRATION, DISCOVERY_DDL, DISCOVERY_TABLES } from '../discovery.mjs';

export const id = DISCOVERY_MIGRATION;
export const note = 'Recruitment Briefs, Nobody Missed reviews, Second Look items and Dynamic Watchlists with their membership history become typed tables (S12c)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, BOX_CAM_MIGRATION)) throw new Error(`${id}: ${BOX_CAM_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = DISCOVERY_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'recruitment_cases', 'room_decisions']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(DISCOVERY_DDL);
}
