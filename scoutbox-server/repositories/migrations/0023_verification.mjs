/**
 * Verification claims (S10a) get their own typed tables: claims (codes, evidence links), the event log, evidence, tokens,
 * verification administrators, root transfers, root applications (codes), disputes, references, squad invitations by
 * code, conflict declarations, domain requests (codes), an organisation's verified domains and the M14 boot marker.
 * REGISTERED in DATA_MIGRATIONS. `up()` is the DDL, plus the clean-up of the retired organisation facet: `verification`
 * leaves orgs.facets_json (its revokedAt is the orgs.verification_revoked_at column, read as `verificationRevokedAt`;
 * its domains are org_verified_domains rows; its orgType was never read) and the unused verification_org_type column
 * is dropped. Nothing is carried over (no production data; rollback means re-seed).
 */
import { migrationApplied } from '../database.mjs';
import { OPPORTUNITIES_CAMPAIGNS_MIGRATION } from '../opportunitiesCampaigns.mjs';
import { VERIFICATION_MIGRATION, VERIFICATION_DDL, VERIFICATION_TABLES } from '../verification.mjs';

export const id = VERIFICATION_MIGRATION;
export const note = 'verification claims, events, evidence, tokens, administrators, root transfers and applications, disputes, references, squad invitations, conflicts, domain requests and verified domains become typed tables (S10a)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OPPORTUNITIES_CAMPAIGNS_MIGRATION)) throw new Error(`${id}: ${OPPORTUNITIES_CAMPAIGNS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = VERIFICATION_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(VERIFICATION_DDL);
  sqlite.exec("UPDATE orgs SET facets_json = json_remove(facets_json, '$.verification') WHERE facets_json IS NOT NULL");
  if (sqlite.prepare("SELECT 1 FROM pragma_table_info('orgs') WHERE name = 'verification_org_type'").get()) sqlite.exec('ALTER TABLE orgs DROP COLUMN verification_org_type');
}
