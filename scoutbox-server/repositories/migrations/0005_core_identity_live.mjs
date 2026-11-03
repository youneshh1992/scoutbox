/**
 * Players, guardians and the guardian–child link become authoritative in their tables (S4a). Runs with foreign
 * keys OFF (the runner checks `foreign_key_check` before committing): the three S1 shadow tables are dropped and
 * recreated with the live definitions (`CANDIDATE_DDL`: the identity DDL plus `facets_json`). Nothing references
 * them (`sessions` carries `kind`/`ref_id` without a foreign key). `meta.coreIdentityInit` is `pending`: the data
 * layer imports the seed once, through the reviewed preflight, on the first boot (repositories/identity.mjs
 * `initialize`), and a snapshot save settles it.
 * REGISTERED in DATA_MIGRATIONS.
 */
import { CANDIDATE_DDL, CORE_IDENTITY_LIVE_MIGRATION } from '../identityPreflight.mjs';
import { CORE_IDENTITY_INIT_META } from '../identity.mjs';

export const id = CORE_IDENTITY_LIVE_MIGRATION;
export const note = 'players, guardians and guardian_children become live tables (scalars in columns, other fields in facets_json)';
export const foreignKeysOff = true;

/** The three tables this step replaces, in drop order (children first). */
export const IDENTITY_TABLES = Object.freeze(['guardian_children', 'players', 'guardians']);

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  for (const t of IDENTITY_TABLES) sqlite.exec(`DROP TABLE IF EXISTS ${t};`);
  sqlite.exec(CANDIDATE_DDL);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CORE_IDENTITY_INIT_META, 'pending');
}
