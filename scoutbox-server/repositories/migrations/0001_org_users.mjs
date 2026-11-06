/**
 * Organisation staff accounts (S0; amended in place by S14f, docs/architecture/migration.md §4.6). The final typed
 * table: `org_id` a RESTRICT key to `orgs` (created by 0002 and rebuilt by 0004; SQLite resolves a key when a row is
 * written), a name unique in its organisation, MFA and delivery preferences as columns, recovery codes as child rows.
 * The DDL is the staff repository's (repositories/users.mjs); sql/01_identity.sql matches it.
 * REGISTERED in DATA_MIGRATIONS.
 */
import { ORG_USERS_DDL } from '../users.mjs';

export const id = '0001_org_users';
export const note = 'organisation staff accounts: org_users and org_user_recovery_codes';

export function up(sqlite) {
  sqlite.exec(ORG_USERS_DDL);
}
