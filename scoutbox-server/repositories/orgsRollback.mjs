/**
 * S3 rollback on a COPY (see scripts/orgsRollback.mjs for the operator
 * contract). Exported separately so the behaviour is unit-tested without
 * spawning the CLI.
 *
 * What it reconstructs: the storage representation the pre-S3 build (S2)
 * reads — an `orgs` blob in `collections` holding every organisation record
 * exactly as the S3 table renders it (scalars and facets merged, original key
 * order and absent/null shape), the S1 shadow definition of `orgs` (empty: the
 * pre-S3 shadow fills it only when validation is on), and the migration-0001
 * definition of `org_users` (not STRICT, no organisation foreign key) with
 * every staff row carried over. `sessions` is untouched: it keeps referencing
 * `org_users` by name and no session is revived or revoked, so nobody has to
 * sign in again. The `0004_orgs_live` record and `meta.orgsCutover` are removed.
 *
 * Foreign keys are off while the two tables are rebuilt (the same reason as
 * the migration: dropping `org_users` with them on would cascade into
 * sessions) and `PRAGMA foreign_key_check` must be clean before the copy is
 * committed. A copy carrying a schema step later than 0004 is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { ORGS_CUTOVER_MIGRATION, ORGS_INIT_META, fromRow } from './orgs.mjs';

/** The S1 shadow definition of `orgs` (migration 0002), which the pre-S3 build expects. */
const S1_ORGS_DDL = `
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
    CREATE INDEX orgs_type_level ON orgs (type, level);`;

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze(['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', ORGS_CUTOVER_MIGRATION]);

const S0_ORG_USERS_DDL = `
    CREATE TABLE org_users_s0 (
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
    );`;
const ORG_USERS_COLUMNS = 'id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json';

export function rollbackOrgsCopy(sourceFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, 'scoutbox.db');
  if (fs.existsSync(output)) throw new Error(`${output} already exists`);
  copyDatabaseReadOnly(sourceFile, output);

  const sqlite = new DatabaseSync(output);
  let done = false;
  try {
    const hasMigrations = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get();
    const applied = hasMigrations ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) {
      const err = new Error(`the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
      err.code = 'LATER_SCHEMA';
      throw err;
    }
    if (!applied.includes(ORGS_CUTOVER_MIGRATION)) {
      const err = new Error(`the database has not applied ${ORGS_CUTOVER_MIGRATION}; there is nothing to roll back`);
      err.code = 'NOT_CUT_OVER';
      throw err;
    }
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.exec('BEGIN');
    try {
      // 1. The organisations, as the S2 build stored them: a blob of full records.
      const records = sqlite.prepare('SELECT * FROM orgs ORDER BY rowid').all().map(fromRow);
      sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
      sqlite.prepare("INSERT INTO collections (name, value) VALUES ('orgs', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(JSON.stringify(records));
      // 2. The S1 shadow definition of orgs, empty (the pre-S3 projection fills it only when validation is on).
      sqlite.exec('DROP TABLE orgs;');
      sqlite.exec(S1_ORGS_DDL);
      // 3. org_users back to the migration-0001 definition, every row carried over, sessions untouched.
      const staffBefore = sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n;
      sqlite.exec(S0_ORG_USERS_DDL);
      sqlite.exec(`INSERT INTO org_users_s0 (${ORG_USERS_COLUMNS}) SELECT ${ORG_USERS_COLUMNS} FROM org_users ORDER BY rowid;`);
      sqlite.exec('DROP TABLE org_users;');
      sqlite.exec('ALTER TABLE org_users_s0 RENAME TO org_users;');
      sqlite.exec(`CREATE INDEX org_users_org ON org_users (org_id);
        CREATE INDEX org_users_org_name ON org_users (org_id, lower(name));
        CREATE INDEX org_users_org_email ON org_users (org_id, email);
        CREATE INDEX org_users_sso ON org_users (sso_subject);`);
      const staffAfter = sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n;
      if (staffAfter !== staffBefore) throw new Error(`the staff rebuild carried ${staffAfter} of ${staffBefore} rows`);
      const sessionsSql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()?.sql ?? '';
      if (sessionsSql && !/REFERENCES\s+"?org_users"?\s*\(/.test(sessionsSql)) throw new Error('the sessions table no longer references org_users');
      // 4. Records and bookkeeping.
      const recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(ORGS_CUTOVER_MIGRATION).changes > 0;
      sqlite.prepare("DELETE FROM meta WHERE key = 'orgsCutover'").run();
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(ORGS_INIT_META);
      const seq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(seq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s)`);
      sqlite.exec('COMMIT');
      sqlite.exec('PRAGMA foreign_keys = ON;');
      sqlite.exec('VACUUM');
      done = true;
      return { output, applied, recordRemoved, organisations: records.length, staff: staffAfter, sessions: sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n };
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  } finally {
    sqlite.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
