/**
 * Organisations as their typed table (repositories/orgs.mjs `ORGS_DDL`), replacing 0002's definition. Runs with
 * foreign keys OFF (the runner checks `foreign_key_check` before committing) because `org_users` references `orgs`.
 * `meta.orgsInit` starts `pending`: the data layer initialises the table from the seed once, on the first boot.
 */
import { ORGS_TABLE_MIGRATION, ORGS_INIT_META, ORGS_DDL } from '../orgs.mjs';

export const id = ORGS_TABLE_MIGRATION;
export const note = 'organisations become a typed table (explicit writes, SQL reads); the staff table is 0001\'s';
export const foreignKeysOff = true;
export { ORGS_DDL };

export function up(sqlite) {
  // 0002's rows are derived and simply go.
  sqlite.exec('DROP TABLE IF EXISTS orgs;');
  sqlite.exec(ORGS_DDL);
  // A first installation waits for its seed.
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ORGS_INIT_META, 'pending');
}
