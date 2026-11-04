/**
 * A club's own setup (S9c) gets its own typed tables: the tactical setup (roles, criteria, windows), the squad, the
 * shadow list, looking-for, the federation-route request and vacancies. REGISTERED in DATA_MIGRATIONS. `up()` is the
 * DDL, plus one clean-up: the four retired organisation facets (tactical, squad, lookingFor, federationCheck) are
 * removed from orgs.facets_json. Their contents are not carried over (no production data; rollback means re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { SCOUTING_ASSESSMENTS_MIGRATION } from '../scoutingAssessments.mjs';
import { CLUB_SETUP_MIGRATION, CLUB_SETUP_DDL, CLUB_SETUP_TABLES, CLUB_SETUP_FACETS } from '../clubSetup.mjs';

export const id = CLUB_SETUP_MIGRATION;
export const note = 'tactical setups (roles, criteria, windows), squads, shadow lists, looking-for, federation checks and vacancies become typed tables (S9c)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, SCOUTING_ASSESSMENTS_MIGRATION)) throw new Error(`${id}: ${SCOUTING_ASSESSMENTS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = CLUB_SETUP_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  if (!hasTable('orgs')) throw new Error(`${id}: orgs is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(CLUB_SETUP_DDL);
  const paths = CLUB_SETUP_FACETS.map((f) => `'$.${f}'`).join(', ');
  sqlite.exec(`UPDATE orgs SET facets_json = json_remove(facets_json, ${paths}) WHERE facets_json IS NOT NULL`);
}
