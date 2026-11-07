/**
 * Core identity tables — organisations and sessions — created as a shadow of the blob snapshot (migration plan step
 * S1). Both have since cut over: sessions (0003), orgs (0004). S14h: the players, guardians and guardian–child links
 * are no longer created here; 0005 creates their final tables.
 *
 * S14f amended the sessions table in place: an org session's staff member and organisation are one key,
 * (org_user_id, ref_id) → org_users(id, org_id), so a session cannot name staff of another organisation.
 *
 * The DDL is the identity section of docs/architecture/sql/01_identity.sql
 * (the player_* sub-record tables of that file arrive with step S5).
 */
export const id = '0002_core_identity_shadow';
export const note = 'orgs and sessions tables (shadow of the snapshot)';

export function up(sqlite) {
  sqlite.exec(`
    CREATE TABLE orgs (
      id                           TEXT PRIMARY KEY,
      name                         TEXT NOT NULL,
      type                         TEXT NOT NULL CHECK (type IN ('club','agency')),
      level                        TEXT NOT NULL CHECK (level IN ('pro','academy','agency','grassroots')),
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
      CHECK ((lat IS NULL) = (lng IS NULL))
    ) STRICT;
    CREATE INDEX orgs_type_level ON orgs (type, level);

    CREATE TABLE sessions (
      token_hash  TEXT PRIMARY KEY,
      sid         TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL CHECK (kind IN ('player','guardian','org','ts_reviewer')),
      ref_id      TEXT NOT NULL,
      org_user_id TEXT,
      via         TEXT CHECK (via IS NULL OR via IN ('sso')),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      CHECK ((kind = 'org') = (org_user_id IS NOT NULL)),
      CHECK (expires_at > created_at),
      FOREIGN KEY (org_user_id, ref_id) REFERENCES org_users(id, org_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX sessions_ref ON sessions (kind, ref_id);
    CREATE INDEX sessions_org_user ON sessions (org_user_id);
    CREATE INDEX sessions_expires ON sessions (expires_at);
  `);
}
