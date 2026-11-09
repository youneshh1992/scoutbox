/**
 * Recruitment requests, request trial slots, trials and the trials' owned child tables
 * (repositories/recruitment.mjs). The `case_id` keys name recruitment_cases, which 0016 creates in the same boot.
 */
import { migrationApplied } from '../database.mjs';
import { PLAYER_ERASURE_MIGRATION } from '../identity.mjs';
import { RECRUITMENT_MIGRATION, RECRUITMENT_DDL, RECRUITMENT_TABLES } from '../recruitment.mjs';

export const id = RECRUITMENT_MIGRATION;
export const note = 'recruitment requests and accepted trials become typed tables (recruitment_requests, request_trial_slots, trials and its thirteen owned child tables; vocabulary CHECKs, no lossless side columns; the case and trial keys deferred to COMMIT while cases are staged; the player references tolerant and counted (Q7a), the guardian references checked in code (Q7c))';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION)) throw new Error(`${id}: ${PLAYER_ERASURE_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(RECRUITMENT_DDL);
}
