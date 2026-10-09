/**
 * Organisation staff accounts — the first collection to leave the blob store.
 *
 * One row per staff member of a club, academy or agency. The columns are the
 * fields the server reads today; `mfa_json` and `delivery_prefs_json` hold
 * the two small structured values a row can carry, and `extra_json` keeps
 * anything an older snapshot stored that this schema does not name, so an
 * import never silently drops data (the repository reports such fields).
 *
 * `org_id` is not yet a foreign key: organisations are still a blob
 * collection. The constraint is added by the migration that moves them.
 * `role` and `created_at` are nullable only for rows imported from older
 * snapshots; every record the repository creates has both.
 */
export const id = '0001_org_users';
export const note = 'organisation staff accounts move from the users blob to the org_users table';

export function up(sqlite) {
  sqlite.exec(`
    CREATE TABLE org_users (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      name                TEXT NOT NULL,
      role                TEXT,
      email               TEXT,
      sso_subject         TEXT,
      created_at          INTEGER,
      removed_at          INTEGER,
      removed_by          TEXT,
      provenance          TEXT,
      mfa_json            TEXT,
      delivery_prefs_json TEXT,
      extra_json          TEXT
    );
    CREATE INDEX org_users_org ON org_users (org_id);
    CREATE INDEX org_users_org_name ON org_users (org_id, lower(name));
    CREATE INDEX org_users_org_email ON org_users (org_id, email);
    CREATE INDEX org_users_sso ON org_users (sso_subject);
  `);
}
