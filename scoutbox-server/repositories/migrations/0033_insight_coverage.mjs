/**
 * Insight and coverage: exposure events, review-later deferrals, evidence suggestions (cited records as rows),
 * calibration sessions (participants, blind submissions, ratings and notes as rows; the rubric is the pinned template
 * version), fixtures, coverage plans and coverage assignments (targets and warnings as rows).
 */
import { migrationApplied } from '../database.mjs';
import { DISCOVERY_MIGRATION } from '../discovery.mjs';
import { INSIGHT_COVERAGE_MIGRATION, INSIGHT_COVERAGE_DDL, INSIGHT_COVERAGE_TABLES } from '../insightCoverage.mjs';

export const id = INSIGHT_COVERAGE_MIGRATION;
export const note = 'Exposure events, review-later deferrals, evidence suggestions, calibration sessions, fixtures, coverage plans and coverage assignments become typed tables';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, DISCOVERY_MIGRATION)) throw new Error(`${id}: ${DISCOVERY_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = INSIGHT_COVERAGE_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users', 'assessment_templates', 'assessment_template_attributes']) {
    if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  }
  sqlite.exec(INSIGHT_COVERAGE_DDL);
}
