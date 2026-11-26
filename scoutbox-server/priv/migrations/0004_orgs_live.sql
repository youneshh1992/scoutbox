-- 0004_orgs_live: organisations become a typed table (explicit writes, SQL reads); the staff table is 0001's

-- foreign_keys: off

DROP TABLE IF EXISTS orgs;

CREATE TABLE orgs (
  id                           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  name                         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  type                         TEXT NOT NULL CHECK (type IN ('club', 'agency')),
  level                        TEXT CHECK (level IS NULL OR level IN ('pro', 'academy', 'agency', 'grassroots')),
  plan                         TEXT NOT NULL CHECK (plan IN ('Grassroots', 'Academy', 'Pro', 'Agency')),
  country                      TEXT CHECK (country IS NULL OR length(country) BETWEEN 1 AND 40),
  city                         TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  lat                          REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                          REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  federation                   TEXT CHECK (federation IS NULL OR length(federation) BETWEEN 1 AND 120),
  federation_registration_id   TEXT CHECK (federation_registration_id IS NULL OR length(federation_registration_id) BETWEEN 1 AND 60),
  trusted_partner              INTEGER NOT NULL DEFAULT 0 CHECK (trusted_partner IN (0,1)),
  verified                     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verified_domain              TEXT CHECK (verified_domain IS NULL OR length(verified_domain) BETWEEN 1 AND 253),
  safeguarding_contract_signed INTEGER NOT NULL DEFAULT 0 CHECK (safeguarding_contract_signed IN (0,1)),
  suspended                    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  password_hash                TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND 512),
  email_domain                 TEXT CHECK (email_domain IS NULL OR length(email_domain) BETWEEN 1 AND 253),
  email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
  mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
  verification_revoked_at      INTEGER,
  created_at                   INTEGER NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (city IS NULL OR lat IS NOT NULL),
  CHECK ((federation IS NULL) = (federation_registration_id IS NULL))
) STRICT;
CREATE INDEX orgs_type_level ON orgs (type, level);

INSERT INTO meta (key, value) VALUES ('orgsInit', 'pending') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
