/**
 * Organisations become authoritative in their table (S3; amended in place by S14g: the final typed table, with no
 * facet storage). Runs with foreign keys OFF (the runner checks `foreign_key_check` before committing) because
 * `orgs`, which `org_users` references, replaces the S1 shadow definition:
 *   1. `orgs`: the typed table (repositories/orgs.mjs `ORGS_DDL`);
 *   2. (S14f: `org_users` is created in its final form by 0001 and no longer rebuilt here.)
 *   3. `meta.orgsInit` is `pending`: the data layer initialises the table from the seed once, on the first boot,
 *      and the first installation's import settles it.
 * REGISTERED in DATA_MIGRATIONS.
 */
import { ORGS_CUTOVER_MIGRATION, ORGS_INIT_META, ORGS_DDL } from '../orgs.mjs';

export const id = ORGS_CUTOVER_MIGRATION;
export const note = 'organisations become a typed table (S3; explicit writes and SQL reads since S14g); the staff table is 0001\'s';
export const foreignKeysOff = true;
export { ORGS_DDL };

export function up(sqlite) {
  // 1. orgs (the shadow's rows are derived and simply go).
  sqlite.exec('DROP TABLE IF EXISTS orgs;');
  sqlite.exec(ORGS_DDL);
  // 3. A first installation waits for its seed.
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ORGS_INIT_META, 'pending');
}
