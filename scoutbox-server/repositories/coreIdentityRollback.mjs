/**
 * S4a rollback on a COPY (see scripts/coreIdentityRollback.mjs for the operator
 * contract; readiness review §8). Exported separately so the behaviour is
 * unit-tested without spawning the CLI. The source file is NEVER modified: it
 * is opened read-only and copied with VACUUM INTO (a consistent copy that
 * includes whatever the WAL side file holds), and everything below happens on
 * the copy, which is removed again if any step fails — a refused or failed
 * rollback leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the pre-S4 build reads —
 *   - a `players` blob holding every player exactly as the live table renders
 *     it (columns and facets merged through the one mapping, `guardianId`
 *     from the column, key order and absent/null shape preserved), post-S4
 *     inserts, updates and removals included: a removed player is gone and is
 *     NOT resurrected;
 *   - a `guardians` blob with `childIds` rebuilt from `guardian_children` in
 *     rowid order (the order the links were written), `coGuardians`, the
 *     outstanding `emailCode` and every other facet as stored — the code is
 *     not hashed by S4a, so the pre-S4 build's verification route still
 *     accepts it (§8.2);
 *   - the S1 shadow definitions of the three tables, EMPTY (the pre-S4 build
 *     fills them only when shadow validation is on);
 *   - `sessions`, `org_users`, `orgs` and every other collection and table
 *     untouched: no session is revived or revoked, nobody signs in again.
 * The `0005_core_identity_live` record and the two S4 meta keys
 * (`coreIdentityCutover`, `coreIdentityInit`) are removed; `meta.saveSeq` is
 * advanced by one, as the earlier rollback tools do, so a shadow report taken
 * on the copy is never mistaken for one of the source's revision.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA` — a later step needs its own rollback; no partial downgrade
 * is guessed), a copy that never applied 0005 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0005 whose
 * tables are not the live definition (`UNEXPECTED_SCHEMA`), a first
 * installation whose initialisation has not completed (`INIT_PENDING`: the
 * live domain holds no authoritative data yet, and a pre-S4 build could not
 * tell that apart from an intentionally empty installation) and a malformed
 * initialisation marker (`INIT_STATE_INVALID`). The completed copy
 * is revalidated before it is reported: integrity, foreign keys, the blobs
 * parse back to the row counts, the shadow tables are empty, the sessions are
 * exactly those of the source.
 *
 * O1 is undecided: no tombstone exists in S4a, so nothing is omitted here and
 * the §8.3 omission rule has nothing to act on yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { playerFromRow, guardianFromRow, PLAYER_COLUMNS, GUARDIAN_COLUMNS } from './identityMapping.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from './identityPreflight.mjs';
import { CORE_IDENTITY_INIT_META } from './identity.mjs';
import { CORE_IDENTITY_CUTOVER_META, IDENTITY_TABLES } from './migrations/0005_core_identity_live.mjs';
import { KNOWN_MIGRATIONS as S3_KNOWN_MIGRATIONS } from './orgsRollback.mjs';

/** The media-deletion queue (migration 0006) belongs to the S4a build: removed with the cutover when it is empty, refused while it is not. */
export const MEDIA_DELETIONS_MIGRATION = '0006_media_deletions';
/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S3_KNOWN_MIGRATIONS, CORE_IDENTITY_LIVE_MIGRATION, MEDIA_DELETIONS_MIGRATION]);

/** The S1 shadow definitions of the three tables (migration 0002), which the pre-S4 build expects. `scripts/testCoreIdentityRollback.mjs` asserts they equal migration 0002's column for column. */
export const S1_IDENTITY_SHADOW_DDL = `
    CREATE TABLE guardians (
      id                      TEXT PRIMARY KEY,
      name                    TEXT NOT NULL,
      email                   TEXT NOT NULL,
      password_hash           TEXT,
      email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
      email_code_hash         TEXT,
      id_verified             INTEGER NOT NULL DEFAULT 0 CHECK (id_verified IN (0,1)),
      idv_reference           TEXT,
      disclaimer_accepted     INTEGER NOT NULL DEFAULT 0 CHECK (disclaimer_accepted IN (0,1)),
      disclaimer_accepted_at  INTEGER,
      co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE SET NULL,
      prefs_quiet_start       TEXT,
      prefs_quiet_end         TEXT,
      prefs_school_hours_mute INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
      prefs_timezone          TEXT,
      created_at              INTEGER,
      deleted_at              INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));
    CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);

    CREATE TABLE players (
      id                       TEXT PRIMARY KEY,
      name                     TEXT NOT NULL,
      birth_date               TEXT NOT NULL CHECK (length(birth_date) = 10),
      country                  TEXT NOT NULL,
      city                     TEXT,
      position                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
      foot                     TEXT CHECK (foot IS NULL OR foot IN ('left','right')),
      height_cm                INTEGER,
      weight_kg                INTEGER,
      squad_number             INTEGER,
      contract_until_date      TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
      market_value_range       TEXT,
      agent_name               TEXT,
      academy_plus             INTEGER NOT NULL DEFAULT 0 CHECK (academy_plus IN (0,1)),
      first_team_seeker        INTEGER NOT NULL DEFAULT 0 CHECK (first_team_seeker IN (0,1)),
      availability             TEXT NOT NULL DEFAULT 'not_seeking' CHECK (availability IN ('available_now','end_of_season','loan_open','overseas_open','not_seeking')),
      contract_status          TEXT NOT NULL DEFAULT 'unknown' CHECK (contract_status IN ('under_contract','expiring_summer','scholarship_ending','release_approaching','free_agent','unknown')),
      level                    TEXT NOT NULL DEFAULT 'amateur' CHECK (level IN ('amateur','semi_pro','pro')),
      football_category        TEXT,
      identity_verified        INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0,1)),
      guardian_id              TEXT REFERENCES guardians(id) ON DELETE SET NULL,
      lat                      REAL,
      lng                      REAL,
      stats_appearances        INTEGER,
      stats_goals              INTEGER,
      stats_assists            INTEGER,
      stats_pace_kmh           REAL,
      stats_pass_completion_pct REAL,
      stats_duel_success_pct   REAL,
      stats_clean_sheets       INTEGER,
      medical_shared           INTEGER NOT NULL DEFAULT 0 CHECK (medical_shared IN (0,1)),
      medical_condition_status TEXT NOT NULL DEFAULT 'unknown',
      prefs_quiet_start        TEXT,
      prefs_quiet_end          TEXT,
      prefs_school_hours_mute  INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
      prefs_timezone           TEXT,
      programme_track          TEXT,
      programme_started_at     INTEGER,
      password_hash            TEXT,
      created_at               INTEGER,
      deleted_at               INTEGER,
      CHECK ((lat IS NULL) = (lng IS NULL))
    ) STRICT;
    CREATE INDEX players_guardian ON players (guardian_id);
    CREATE INDEX players_created_at ON players (created_at);
    CREATE INDEX players_search ON players (country, position, availability);
    CREATE INDEX players_level ON players (level);

    CREATE TABLE guardian_children (
      guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
      player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','co')),
      PRIMARY KEY (guardian_id, player_id)
    ) STRICT;
    CREATE INDEX guardian_children_player ON guardian_children (player_id);`;

const refusal = (code, message) => Object.assign(new Error(message), { code });
const SESSION_ROWS = 'SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY sid';

export function rollbackCoreIdentityCopy(sourceFile, outDir) {
  if (!fs.existsSync(sourceFile)) throw refusal('NO_SOURCE', `${sourceFile} does not exist`);
  fs.mkdirSync(outDir, { recursive: true });
  const leftovers = fs.readdirSync(outDir);
  if (leftovers.length) throw refusal('OUTPUT_NOT_EMPTY', `${outDir} is not empty (${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'}); the rollback needs a fresh, empty output directory and never overwrites anything`);
  const output = path.join(outDir, 'scoutbox.db');

  let sqlite = null;
  let done = false;
  try {
    copyDatabaseReadOnly(sourceFile, output);
    sqlite = new DatabaseSync(output);
    const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const applied = hasTable('data_migrations') ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) throw refusal('LATER_SCHEMA', `the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
    if (!applied.includes(CORE_IDENTITY_LIVE_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${CORE_IDENTITY_LIVE_MIGRATION}; there is nothing to roll back`);
    for (const t of ['players', 'guardians']) {
      if (!hasTable(t) || !sqlite.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json')) throw refusal('UNEXPECTED_SCHEMA', `${CORE_IDENTITY_LIVE_MIGRATION} is recorded but the ${t} table is not the live definition (facets_json); refusing to guess`);
    }
    if (!hasTable('guardian_children')) throw refusal('UNEXPECTED_SCHEMA', `${CORE_IDENTITY_LIVE_MIGRATION} is recorded but guardian_children does not exist; refusing to guess`);
    // The initialisation state (review of 64ef3aa). A pre-S4 build has no notion
    // of "cut over but not yet initialised": a first installation whose import
    // never committed holds no authoritative identity data, and exporting its
    // empty tables as blobs would turn an unfinished setup into an intentionally
    // empty, initialised domain on the next upgrade. So `pending` is refused
    // with no output; `done` proceeds; an ABSENT marker reads as `done` — the
    // repositories' documented compatibility for a cut-over file whose marker
    // was never written — and any other value is malformed and refused, never
    // erased or guessed.
    const initRow = hasTable('meta') ? sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META) : null;
    if (initRow && initRow.value === 'pending') throw refusal('INIT_PENDING', `the first installation's initialisation has not completed (meta.${CORE_IDENTITY_INIT_META} is pending): the live tables hold no authoritative data yet and a pre-S4 build could not tell this apart from an intentionally empty installation, so no rollback copy is produced. Boot the S4 build once so the initialisation completes (it retries on every boot until it commits), then roll back; or, if the installation is abandoned, start the pre-S4 build on a fresh data directory`);
    if (initRow && initRow.value !== 'done') throw refusal('INIT_STATE_INVALID', `meta.${CORE_IDENTITY_INIT_META} holds ${JSON.stringify(initRow.value)}, which is neither "pending" nor "done"; refusing to guess the initialisation state (nothing is erased)`);
    // The media-deletion queue: files the S4 build decided to remove but has not
    // removed yet. A pre-S4 build has no queue and would serve them again, so a
    // non-empty queue refuses the rollback; an empty one goes with the cutover.
    const hasQueue = hasTable('media_deletions');
    if (hasQueue) {
      const queued = sqlite.prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n;
      if (queued) throw refusal('MEDIA_QUEUE_PENDING', `${queued} media file(s) are queued for removal and not removed yet (media_deletions); a pre-S4 build would serve them again. Boot the S4 build once so the queue drains (it retries at boot and every minute), then roll back`);
    }
    const sessionsBefore = hasTable('sessions') ? sqlite.prepare(SESSION_ROWS).all() : null;

    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.exec('BEGIN');
    let players; let guardians; let linkRows = 0; let recordRemoved; let saveSeq;
    try {
      // 1. The records, as the pre-S4 build stored them: two blobs of full records, rebuilt from the authoritative rows.
      const childIds = new Map();
      for (const l of sqlite.prepare('SELECT guardian_id, player_id FROM guardian_children ORDER BY rowid').all()) {
        if (!childIds.has(l.guardian_id)) childIds.set(l.guardian_id, []);
        childIds.get(l.guardian_id).push(l.player_id);
        linkRows += 1;
      }
      guardians = sqlite.prepare(`SELECT ${GUARDIAN_COLUMNS.join(', ')} FROM guardians ORDER BY rowid`).all().map((r) => guardianFromRow(r, childIds.get(r.id) ?? []));
      players = sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`).all().map((r) => playerFromRow(r));
      sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
      const put = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      put.run('players', JSON.stringify(players));
      put.run('guardians', JSON.stringify(guardians));
      // 2. The S1 shadow definitions, empty.
      for (const t of IDENTITY_TABLES) sqlite.exec(`DROP TABLE ${t};`);
      sqlite.exec(S1_IDENTITY_SHADOW_DDL);
      // 3. Records and bookkeeping (the empty queue and its record go with the cutover).
      if (hasQueue) sqlite.exec('DROP TABLE media_deletions;');
      sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(MEDIA_DELETIONS_MIGRATION);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(CORE_IDENTITY_LIVE_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(CORE_IDENTITY_CUTOVER_META);
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(CORE_IDENTITY_INIT_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec('VACUUM');

    // 4. Revalidate the completed copy before reporting it.
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(CORE_IDENTITY_LIVE_MIGRATION)) problems.push('the cutover record is still present');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(MEDIA_DELETIONS_MIGRATION) || hasTable('media_deletions')) problems.push('the media-deletion queue is still present');
    if (sqlite.prepare('SELECT COUNT(*) AS n FROM meta WHERE key IN (?, ?)').get(CORE_IDENTITY_CUTOVER_META, CORE_IDENTITY_INIT_META).n) problems.push('S4 meta keys are still present');
    for (const [name, expected] of [['players', players.length], ['guardians', guardians.length]]) {
      let parsed = null;
      try { parsed = JSON.parse(sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? 'null'); } catch { /* reported below */ }
      if (!Array.isArray(parsed) || parsed.length !== expected) problems.push(`the ${name} blob does not read back as ${expected} record(s)`);
    }
    for (const t of IDENTITY_TABLES) {
      if (!hasTable(t)) { problems.push(`${t} is missing`); continue; }
      if (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n) problems.push(`${t} is not empty`);
      if (sqlite.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json')) problems.push(`${t} still has the live definition`);
    }
    const sessionsAfter = hasTable('sessions') ? sqlite.prepare(SESSION_ROWS).all() : null;
    if (JSON.stringify(sessionsAfter) !== JSON.stringify(sessionsBefore)) problems.push('the sessions table changed');
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, players: players.length, guardians: guardians.length, links: linkRows, sessions: sessionsAfter ? sessionsAfter.length : 0, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
