/**
 * Recruitment contacts and offers become their own tables (migration plan step S8c; docs/architecture/
 * s8c-readiness-review.md as independently accepted at 19f5ca8; the Founder's explicit answers of 24 October 2026:
 * Q8c-a tolerant, counted player references; Q8c-b strict guardian checks). REGISTERED in DATA_MIGRATIONS. Runs with
 * foreign keys OFF (the runner's `foreignKeysOff`): the step rebuilds `idempotency_keys`, which nothing references but
 * whose rows must be copied back under the broadened CHECK, and `PRAGMA foreign_key_check` must report nothing before it
 * commits — every reference is also checked explicitly, with ids only, before a row is written.
 *
 * Inside the runner's one transaction, after 0016 (recruitment cases):
 *   1. Refuse a file whose S8b key format is not the one this build reads (the marker is read, never written).
 *   2. Create the nine tables (RECRUITMENT_CONTACTS_OFFERS_DDL).
 *   3. Rebuild `idempotency_keys` with the owner CHECK broadened to the two parents (every existing row copied back).
 *   4. Import the two blobs the file holds through the repository's own preflight (every entry's identifiers, no
 *      duplicate id, every case in recruitment_cases, every contact's request in recruitment_requests with the pair
 *      agreeing, every organisation and staff id in its table, every guardian id in the guardians table (Q8c-b), the
 *      five offer pointers under the pointer rule — a known foreign-owner target refuses, an unresolved one imports and
 *      is counted; the player ids counted as live, retained or missing and never refused — Q8c-a) in array order.
 *   5. Retire the two blob rows; record the counts in `meta.recruitmentContactsOffersCutover`.
 * Nothing is coerced or normalised. ANY refusal aborts the whole migration with CONTACTS_OFFERS_IMPORT_BLOCKED, its
 * detail naming the specific refusal with positions, tables and ids — never a subject, a body, a note or a name: the
 * runner rolls back, the blobs and saveSeq are untouched, the next boot refuses the same way. A file without the blobs
 * (a first installation) creates the tables and imports nothing — never from the seed, never from memory. The step
 * never runs twice (recorded) and refuses to run before 0016 or when any of the tables already exists.
 */
import { migrationApplied } from '../database.mjs';
import { idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CASES_MIGRATION, assertKeyFormat } from '../recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION, RECRUITMENT_CONTACTS_OFFERS_CUTOVER_META, RECRUITMENT_CONTACTS_OFFERS_DDL, RECRUITMENT_CONTACTS_OFFERS_TABLES, S8C_KEY_OWNERS, importRecruitmentContactsOffersBlobs } from '../recruitmentContactsOffers.mjs';
import { rebuildTable } from './0016_recruitment_cases.mjs';

export const id = RECRUITMENT_CONTACTS_OFFERS_MIGRATION;
export const note = 'recruitment contacts and offers become their own tables (nine tables; insertion and list order kept; absence, null, off-type and unknown fields kept losslessly; the five offer pointers stored as written under the final-collection pointer rule; the player references tolerant and counted (Q8c-a), the guardian references strict (Q8c-b)); idempotency_keys rebuilt with the owner CHECK broadened to the two parents';
export const foreignKeysOff = true;

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_CASES_MIGRATION} must be recorded first`);
  assertKeyFormat(sqlite, { label: `migration ${id}` });
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = RECRUITMENT_CONTACTS_OFFERS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_requests', 'recruitment_cases', 'idempotency_keys']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although ${RECRUITMENT_CASES_MIGRATION} is recorded; refusing to guess the schema's state`);
  sqlite.exec(RECRUITMENT_CONTACTS_OFFERS_DDL);
  const keyRows = rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8C_KEY_OWNERS));
  const counts = importRecruitmentContactsOffersBlobs(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECRUITMENT_CONTACTS_OFFERS_CUTOVER_META, JSON.stringify({ at: now, ...counts, rebuilt: { idempotencyKeys: keyRows } }));
}
