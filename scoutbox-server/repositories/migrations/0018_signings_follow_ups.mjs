/**
 * Signing packages, completed signings, post-signing follow-ups and outcome reports become their own tables
 * (migration plan step S8d; docs/architecture/s8d-design-note.md; the rules of 30 October 2026). REGISTERED in
 * DATA_MIGRATIONS. Runs with foreign keys OFF (the runner's `foreignKeysOff`): the step rebuilds `idempotency_keys`,
 * which other tables' rows live in, and `PRAGMA foreign_key_check` must report nothing before it commits — every
 * reference is also checked explicitly, with ids only, before a row is written.
 *
 * Inside the runner's one transaction, after 0017 (contacts and offers):
 *   1. Create the ten typed tables (SIGNINGS_FOLLOWUPS_DDL).
 *   2. Rebuild `idempotency_keys` with the owner CHECK broadened to `signing_packages` (every S8a/S8b/S8c key row
 *      copied back byte for byte; the S8b key-format marker is read by nothing here and left as it is).
 *   3. Import the four blobs the file holds, TYPED: every field in its column, the vocabulary and length CHECKs of
 *      file 02; the normalisations the design note lists applied and REPORTED with the row id (a signing without
 *      `method` → LEGACY_RECORDED, a missing `rev` → 1, the dead signing fields and unknown fields dropped, a copied
 *      ledger row reduced to its reference); every organisation, staff, case, offer, package, revision, signing and
 *      follow-up reference checked against the tables as they stand; the uniqueness rules the code keeps named;
 *      the player ids counted (live / retained / missing) and never refused (Q7a/Q8a/Q8c-a applied).
 *   4. The four blob rows retired; the counts and the notes recorded in `meta.signingsFollowUpsCutover`.
 * A row the columns cannot hold STOPS the migration with its id (SIGNINGS_IMPORT_BLOCKED): nothing is dropped, the
 * runner rolls back, the blobs and saveSeq are untouched, the next boot refuses the same way. A file without the
 * blobs (a first installation) creates the tables and imports nothing — never from the seed, never from memory.
 * The step never runs twice (recorded) and refuses to run before 0017 or when any of the tables already exists.
 */
import { migrationApplied } from '../database.mjs';
import { idempotencyKeysDdl } from '../recruitment.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_MIGRATION } from '../recruitmentContactsOffers.mjs';
import { rebuildTable } from './0016_recruitment_cases.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION, SIGNINGS_FOLLOWUPS_CUTOVER_META, SIGNINGS_FOLLOWUPS_DDL, SIGNINGS_FOLLOWUPS_TABLES, S8D_KEY_OWNERS, importSigningsFollowUpsBlobs } from '../signingsFollowUps.mjs';

export const id = SIGNINGS_FOLLOWUPS_MIGRATION;
export const note = 'signing packages (revisions, documents, parties, history), completed signings (parties), post-signing follow-ups and outcome reports (confirmations) become typed tables; the four blobs imported with the normalisations reported and retired; idempotency_keys broadened to signing_packages (S8d)';
export const foreignKeysOff = true;

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, RECRUITMENT_CONTACTS_OFFERS_MIGRATION)) throw new Error(`${id}: ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SIGNINGS_FOLLOWUPS_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  for (const t of ['recruitment_cases', 'recruitment_offers', 'offer_revisions', 'idempotency_keys', 'org_users', 'orgs']) if (!hasTable(t)) throw new Error(`${id}: ${t} is missing although the earlier steps are recorded; refusing to guess the schema's state`);
  sqlite.exec(SIGNINGS_FOLLOWUPS_DDL);
  const keyRows = rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8D_KEY_OWNERS));
  let imported;
  try { imported = importSigningsFollowUpsBlobs(sqlite); } catch (e) { throw new Error(`${/^SIGNINGS_IMPORT_BLOCKED/.test(e.message) ? '' : 'SIGNINGS_IMPORT_BLOCKED: '}${e.message}; nothing was imported`, { cause: e }); }
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SIGNINGS_FOLLOWUPS_CUTOVER_META, JSON.stringify({ at: now, keyRowsRebuilt: keyRows, ...imported }));
}
