/**
 * Organisation staff accounts (DDL in repositories/users.mjs). `org_id` is a RESTRICT key to `orgs`, which 0002
 * creates later: SQLite resolves a foreign key when a row is written, not when the table is created.
 */
import { ORG_USERS_DDL } from '../users.mjs';

export const id = '0001_org_users';
export const note = 'organisation staff accounts: org_users and org_user_recovery_codes';

export function up(sqlite) {
  sqlite.exec(ORG_USERS_DDL);
}
