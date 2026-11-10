/**
 * Assessment templates (attributes), assessments (ratings, cited evidence, history), video segments (labels) and
 * playlists (segments) (repositories/scoutingAssessments.mjs). Also inserts the catalogue: the four v1 position
 * templates, which every database has from its first boot.
 */
import { migrationApplied } from '../database.mjs';
import { SCOUTING_EVIDENCE_MIGRATION } from '../scoutingEvidence.mjs';
import { SCOUTING_ASSESSMENTS_MIGRATION, SCOUTING_ASSESSMENTS_DDL, SCOUTING_ASSESSMENTS_TABLES, insertSeedTemplates } from '../scoutingAssessments.mjs';

export const id = SCOUTING_ASSESSMENTS_MIGRATION;
export const note = 'assessment templates, assessments (ratings, cited evidence, history), video segments and playlists become typed tables; the v1 templates are inserted';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SCOUTING_EVIDENCE_MIGRATION)) throw new Error(`${id}: ${SCOUTING_EVIDENCE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SCOUTING_ASSESSMENTS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(SCOUTING_ASSESSMENTS_DDL);
  insertSeedTemplates(sqlite, now);
}
