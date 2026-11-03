/**
 * Organisations become authoritative in their table (S3). Runs with foreign keys OFF (the runner checks
 * `foreign_key_check` before committing) because two tables are rebuilt:
 *   1. `orgs`: the S1 shadow definition is replaced by the live one (level nullable, `facets_json` for the
 *      fields that have not moved yet);
 *   2. `org_users` is rebuilt STRICT with `org_id REFERENCES orgs(id)` and `json_valid` checks, every row and
 *      index carried over (created under a temporary name, copied, the old table dropped, then renamed, so
 *      `sessions` keeps referencing `org_users`);
 *   3. `meta.orgsInit` is `pending`: the data layer initialises the table from the seed once, on the first boot,
 *      and a snapshot save settles it (repositories/index.mjs `writeTableBacked`).
 * REGISTERED in DATA_MIGRATIONS.
 */
import { ORGS_CUTOVER_MIGRATION, ORGS_INIT_META } from '../orgs.mjs';

export const id = ORGS_CUTOVER_MIGRATION;
export const note = 'organisations become table-backed (scalars in columns, other fields in facets_json); org_users rebuilt STRICT with the orgs foreign key and JSON checks';
export const foreignKeysOff = true;

export const ORGS_DDL = `
    CREATE TABLE orgs (
      id                           TEXT PRIMARY KEY,
      name                         TEXT NOT NULL,
      type                         TEXT NOT NULL CHECK (type IN ('club','agency')),
      level                        TEXT CHECK (level IS NULL OR level IN ('pro','academy','agency','grassroots')),
      plan                         TEXT NOT NULL CHECK (plan IN ('Pro','Academy','Agency','Grassroots')),
      country                      TEXT,
      city                         TEXT,
      lat                          REAL,
      lng                          REAL,
      federation                   TEXT,
      federation_registration_id   TEXT,
      trusted_partner              INTEGER NOT NULL DEFAULT 0 CHECK (trusted_partner IN (0,1)),
      verified                     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
      verified_domain              TEXT,
      safeguarding_contract_signed INTEGER NOT NULL DEFAULT 0 CHECK (safeguarding_contract_signed IN (0,1)),
      suspended                    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
      password_hash                TEXT,
      email_domain                 TEXT,
      email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
      mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
      verification_revoked_at      INTEGER,
      verification_org_type        TEXT,
      created_at                   INTEGER,
      facets_json                  TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)),
      CHECK ((lat IS NULL) = (lng IS NULL))
    ) STRICT;
    CREATE INDEX orgs_type_level ON orgs (type, level);
`;

export const ORG_USERS_DDL = `
    CREATE TABLE org_users (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL REFERENCES orgs(id),
      name                TEXT NOT NULL,
      role                TEXT,
      email               TEXT,
      sso_subject         TEXT,
      created_at          INTEGER,
      removed_at          INTEGER,
      removed_by          TEXT,
      provenance          TEXT,
      mfa_json            TEXT CHECK (mfa_json IS NULL OR json_valid(mfa_json)),
      delivery_prefs_json TEXT CHECK (delivery_prefs_json IS NULL OR json_valid(delivery_prefs_json))
    ) STRICT;
    CREATE INDEX org_users_org ON org_users (org_id);
    CREATE INDEX org_users_org_name ON org_users (org_id, lower(name));
    CREATE INDEX org_users_org_email ON org_users (org_id, email);
    CREATE INDEX org_users_sso ON org_users (sso_subject);
`;

const ORG_USERS_COLUMNS = 'id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json';

export function up(sqlite) {
  // 1. orgs (the shadow's rows are derived and simply go).
  sqlite.exec('DROP TABLE IF EXISTS orgs;');
  sqlite.exec(ORGS_DDL);
  // 2. org_users with the foreign key. Create the new table under a temporary name, copy, DROP the old one, then
  //    rename: renaming the OLD table first would rewrite the REFERENCES clause of `sessions` to the temporary name.
  const staff = sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n;
  sqlite.exec(ORG_USERS_DDL.replace('CREATE TABLE org_users (', 'CREATE TABLE org_users_s3 (').replace(/CREATE INDEX [\s\S]*$/, ''));
  sqlite.exec(`INSERT INTO org_users_s3 (${ORG_USERS_COLUMNS}) SELECT ${ORG_USERS_COLUMNS} FROM org_users ORDER BY rowid;`);
  sqlite.exec('DROP TABLE org_users;');
  sqlite.exec('ALTER TABLE org_users_s3 RENAME TO org_users;');
  sqlite.exec(ORG_USERS_DDL.slice(ORG_USERS_DDL.indexOf('CREATE INDEX')));
  if (sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n !== staff) throw new Error(`${id}: the staff table rebuild lost rows`);
  // 3. A first installation waits for its seed.
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ORGS_INIT_META, 'pending');
}
