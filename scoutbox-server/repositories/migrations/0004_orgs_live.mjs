/**
 * Organisations become authoritative in their table (S3). Runs with foreign keys OFF (the runner checks
 * `foreign_key_check` before committing) because `orgs`, which `org_users` references, is rebuilt:
 *   1. `orgs`: the S1 shadow definition is replaced by the live one (level nullable, `facets_json` for the
 *      fields that have not moved yet);
 *   2. (S14f: `org_users` is created in its final form by 0001 and no longer rebuilt here.)
 *   3. `meta.orgsInit` is `pending`: the data layer initialises the table from the seed once, on the first boot,
 *      and a snapshot save settles it (repositories/index.mjs `writeTableBacked`).
 * REGISTERED in DATA_MIGRATIONS.
 */
import { ORGS_CUTOVER_MIGRATION, ORGS_INIT_META } from '../orgs.mjs';

export const id = ORGS_CUTOVER_MIGRATION;
export const note = 'organisations become table-backed (scalars in columns, other fields in facets_json); the staff table is 0001\'s';
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

export function up(sqlite) {
  // 1. orgs (the shadow's rows are derived and simply go).
  sqlite.exec('DROP TABLE IF EXISTS orgs;');
  sqlite.exec(ORGS_DDL);
  // 3. A first installation waits for its seed.
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ORGS_INIT_META, 'pending');
}
