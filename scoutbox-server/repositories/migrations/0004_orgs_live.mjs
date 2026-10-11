/**
 * Organisations cut over (migration plan step S3).
 *
 * Runs with foreign keys OFF (the runner switches them off before the
 * transaction and verifies `PRAGMA foreign_key_check` before committing),
 * because two tables are rebuilt and SQLite can only add a constraint by
 * rebuilding: dropping the old `org_users` with foreign keys on would cascade
 * through `sessions.org_user_id` and delete every staff session.
 *
 * Inside the one transaction the runner opens:
 *   1. read the authoritative `orgs` blob straight from `collections`;
 *   2. validate every record without coercion (validateOrgRecord: id, name,
 *      type/level/plan lists, booleans, text, timestamps, composites), refuse
 *      duplicate ids, and refuse any staff row (`org_users.org_id`) that names
 *      an organisation the blob does not hold — ABORT on the first problem
 *      set, naming ids and reasons; the runner rolls back and the file is
 *      byte-identical, the blob still authoritative;
 *   3. rebuild `orgs`: the S1 shadow table (level NOT NULL, no facets) is
 *      replaced by the live definition (level nullable — the verification
 *      review creates non-grassroots organisations with `level: null` — plus
 *      `facets_json` for every field that has not cut over yet); import the
 *      records;
 *   4. rebuild `org_users` STRICT with `org_id REFERENCES orgs(id)` and
 *      `json_valid` CHECKs on the three JSON columns, copying every row and
 *      recreating its four indexes. `sessions.org_user_id` keeps referencing
 *      `org_users` by name, so after the rename every session still points at
 *      its staff row; the runner's foreign_key_check proves it;
 *   5. record `meta.orgsCutover`, delete the `orgs` blob.
 * The runner then writes the `data_migrations` row and commits. Completion is
 * decided only by that row (repositories/orgs.mjs `attach` refuses without it).
 */
import { validateOrgRecord, toRow, ORGS_CUTOVER_MIGRATION } from '../orgs.mjs';

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
      delivery_prefs_json TEXT CHECK (delivery_prefs_json IS NULL OR json_valid(delivery_prefs_json)),
      extra_json          TEXT CHECK (extra_json IS NULL OR json_valid(extra_json))
    ) STRICT;
    CREATE INDEX org_users_org ON org_users (org_id);
    CREATE INDEX org_users_org_name ON org_users (org_id, lower(name));
    CREATE INDEX org_users_org_email ON org_users (org_id, email);
    CREATE INDEX org_users_sso ON org_users (sso_subject);
`;

const ORG_USERS_COLUMNS = 'id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json';

export function up(sqlite, { now = Date.now() } = {}) {
  const hasCollections = !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get();
  const blobRow = hasCollections ? sqlite.prepare("SELECT value FROM collections WHERE name = 'orgs'").get() : null;
  let legacy = [];
  if (blobRow) {
    try { legacy = JSON.parse(blobRow.value); } catch { throw new Error('ORGS_CUTOVER_BLOCKED: the legacy orgs blob is not valid JSON'); }
    if (!Array.isArray(legacy)) throw new Error('ORGS_CUTOVER_BLOCKED: the legacy orgs blob is not an array');
  }

  // 2. Validate everything first; nothing is written until every record passes.
  const problems = [];
  const ids = new Set();
  legacy.forEach((rec, i) => {
    const v = validateOrgRecord(rec);
    const label = rec && typeof rec === 'object' && typeof rec.id === 'string' ? `id ${rec.id}` : `entry #${i}`;
    if (!v.ok) { problems.push(`${label}: ${v.reason}`); return; }
    if (ids.has(rec.id)) { problems.push(`${label}: duplicate id`); return; }
    ids.add(rec.id);
  });
  const staffRows = sqlite.prepare(`SELECT ${ORG_USERS_COLUMNS} FROM org_users ORDER BY rowid`).all();
  for (const u of staffRows) if (!ids.has(u.org_id)) problems.push(`staff ${u.id}: names organisation ${u.org_id}, which the orgs blob does not hold`);
  if (problems.length) {
    throw new Error(`ORGS_CUTOVER_BLOCKED: ${problems.length} unsupported record(s); repair them on the current build first — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`);
  }

  // 3. Rebuild orgs (the shadow's rows are derived and simply go) and import.
  sqlite.exec('DROP TABLE IF EXISTS orgs;');
  sqlite.exec(ORGS_DDL);
  const insert = sqlite.prepare(`INSERT INTO orgs (id, name, type, level, plan, country, city, lat, lng, federation, federation_registration_id,
    trusted_partner, verified, verified_domain, safeguarding_contract_signed, suspended, password_hash, email_domain, email_domain_verified,
    mfa_required_for_leads, verification_revoked_at, verification_org_type, created_at, facets_json)
    VALUES (@id, @name, @type, @level, @plan, @country, @city, @lat, @lng, @federation, @federation_registration_id,
    @trusted_partner, @verified, @verified_domain, @safeguarding_contract_signed, @suspended, @password_hash, @email_domain, @email_domain_verified,
    @mfa_required_for_leads, @verification_revoked_at, @verification_org_type, @created_at, @facets_json)`);
  for (const rec of legacy) insert.run(toRow(rec));

  // 4. Rebuild org_users with the foreign key; every row and every index is
  //    carried over. The order is the one SQLite documents for schema changes:
  //    create the NEW table under a temporary name, copy, DROP the old table
  //    (foreign keys are off, so nothing cascades into sessions), then rename
  //    the new one to `org_users`. Renaming the OLD table first would be wrong:
  //    since SQLite 3.26 a RENAME rewrites the REFERENCES clauses of other
  //    tables, so `sessions` would be left pointing at the temporary name.
  //    `sessions` never names the temporary table, so its REFERENCES clause is
  //    untouched and resolves to the rebuilt table; the runner's
  //    foreign_key_check proves every staff session still has its row.
  sqlite.exec(ORG_USERS_DDL.replace('CREATE TABLE org_users (', 'CREATE TABLE org_users_s3 (').replace(/CREATE INDEX [\s\S]*$/, ''));
  sqlite.exec(`INSERT INTO org_users_s3 (${ORG_USERS_COLUMNS}) SELECT ${ORG_USERS_COLUMNS} FROM org_users ORDER BY rowid;`);
  sqlite.exec('DROP TABLE org_users;');
  sqlite.exec('ALTER TABLE org_users_s3 RENAME TO org_users;');
  sqlite.exec(ORG_USERS_DDL.slice(ORG_USERS_DDL.indexOf('CREATE INDEX')));
  const copied = sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n;
  const sessionsRef = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()?.sql ?? '';
  if (sessionsRef && !/REFERENCES\s+"?org_users"?\s*\(/.test(sessionsRef)) throw new Error('ORGS_CUTOVER_BLOCKED: the sessions table no longer references org_users after the rebuild');
  if (copied !== staffRows.length) throw new Error(`ORGS_CUTOVER_BLOCKED: the staff table rebuild copied ${copied} of ${staffRows.length} rows`);

  // 5. Record and retire the blob.
  const meta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  meta.run('orgsCutover', JSON.stringify({ at: now, imported: legacy.length, staffRebuilt: copied, blobPresent: !!blobRow }));
  if (hasCollections) sqlite.prepare("DELETE FROM collections WHERE name = 'orgs'").run();
}
