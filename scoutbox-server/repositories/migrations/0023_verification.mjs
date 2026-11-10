/**
 * Verification claims: claims (codes, evidence links), the event log, evidence, tokens, verification administrators,
 * root transfers, root applications (codes), disputes, references, squad invitations by code, conflict declarations,
 * domain requests (codes), an organisation's verified domains and the verification boot marker. An organisation's
 * revocation is the orgs.verification_revoked_at column.
 */
import { migrationApplied } from '../database.mjs';
import { OPPORTUNITIES_CAMPAIGNS_MIGRATION } from '../opportunitiesCampaigns.mjs';
import { VERIFICATION_MIGRATION, VERIFICATION_DDL, VERIFICATION_TABLES } from '../verification.mjs';

export const id = VERIFICATION_MIGRATION;
export const note = 'verification claims, events, evidence, tokens, administrators, root transfers and applications, disputes, references, squad invitations, conflicts, domain requests and verified domains become typed tables';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OPPORTUNITIES_CAMPAIGNS_MIGRATION)) throw new Error(`${id}: ${OPPORTUNITIES_CAMPAIGNS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = VERIFICATION_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['orgs', 'org_users']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(VERIFICATION_DDL);
}
