/**
 * Players and guardians together: the tables (`players`, `guardians`, `guardian_children`), the links between them,
 * and a first installation's records. Each has its own repository: players.ts (the record is playerRecord.ts, the
 * lists playerSubrecords.ts) and guardians.ts; this module builds both on one connection and adds the link acts, which
 * write both sides.
 *
 * Relationships. `players.guardian_id` and the `primary` row of `guardian_children` are written together and cannot
 * disagree; a minor is created with its primary link in the same transaction (an unlinked child cannot be created);
 * a guardian's e-mail is unique case-insensitively. `ageUp` clears the primary link only (co-guardians keep listing
 * the player).
 *
 * A first installation's players and guardians (the seed) are imported once by `initialize`, while
 * `meta.coreIdentityInit` is `pending` (set by the migration).
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction, migrationApplied, type UnitParticipant } from './database.ts';
import { isAdult, TRUST } from '../domain.ts';
import {
  PLAYER_SUBRECORDS_MIGRATION,
  subrecordsLive,
  prepareSubrecordStatements,
  writeChildRows,
  readChildrenFor,
  type PlayerLists,
} from './playerSubrecords.ts';
import {
  PLAYER_POSITIONS,
  PLAYER_FEET,
  PLAYER_AVAILABILITY,
  PLAYER_CONTRACT_STATUS,
  PLAYER_LEVELS,
  P_SELECT,
  P_INSERT,
  playerWithDefaults,
  playerRecordProblems,
  playerParams,
  playerFromDb,
  livePlayerRow,
  type PlayerDraft,
  type PlayerRow,
  type PlayerTrialReport,
} from './playerRecord.ts';
import {
  G_SELECT,
  G_INSERT,
  guardianWithDefaults,
  guardianRecordProblems,
  guardianParams,
  guardianFromDb,
  codeHashProblem,
  createGuardians,
  noGuardian,
  GUARDIAN_WRITES,
  type GuardianDraft,
  type GuardianRow,
} from './guardians.ts';
import { createPlayers, refreshProfileSignals, noPlayer, PLAYER_WRITES, type Link } from './players.ts';
import {
  IDENTITY_LIMITS as L,
  refusal,
  isPlainObject,
  describe,
  passwordProblem,
  identityKit,
  readsOf,
  inList,
  optList,
  optText,
  flag,
  optFlag,
  range,
  HHMM,
  type IdentityKit,
} from './identityRules.ts';

export const CORE_IDENTITY_LIVE_MIGRATION = '0005_core_identity_live';
/** `meta` key holding the initialisation state (`pending` | `done`); absent reads as `done`. */
export const CORE_IDENTITY_INIT_META = 'coreIdentityInit';
/** The two collections the identity repositories own; coupled through the link rows. */
export const IDENTITY_COLLECTIONS = Object.freeze(['players', 'guardians'] as const);

// ------------------------------------------------------------------ the tables (what migration 0005 creates)
export const IDENTITY_DDL = `
CREATE TABLE guardians (
  id                      TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${L.id}),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  email                   TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND ${L.email}),
  password_hash           TEXT ${optText('password_hash', L.passwordHash)},
  email_verified          ${flag('email_verified')},
  email_code_hash         TEXT CHECK (email_code_hash IS NULL OR length(email_code_hash) = 64),
  id_verified             ${flag('id_verified')},
  idv_reference           TEXT ${optText('idv_reference', L.idvReference)},
  disclaimer_accepted     ${flag('disclaimer_accepted')},
  disclaimer_accepted_at  INTEGER,
  co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE RESTRICT,
  prefs_quiet_start       TEXT ${HHMM('prefs_quiet_start')},
  prefs_quiet_end         TEXT ${HHMM('prefs_quiet_end')},
  prefs_school_hours_mute ${optFlag('prefs_school_hours_mute')},
  prefs_timezone          TEXT ${optText('prefs_timezone', L.timezone)},
  created_at              INTEGER,
  CHECK (co_guardian_of IS NULL OR co_guardian_of <> id)
) STRICT;
CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));
CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);

CREATE TABLE players (
  id                        TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${L.id}),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  birth_date                TEXT NOT NULL CHECK (length(birth_date) = 10),
  country                   TEXT NOT NULL CHECK (length(country) BETWEEN 1 AND ${L.country}),
  city                      TEXT ${optText('city', L.city)},
  position                  TEXT ${optList('position', PLAYER_POSITIONS)},
  foot                      TEXT ${optList('foot', PLAYER_FEET)},
  height_cm                 INTEGER ${range('height_cm', L.heightCm)},
  weight_kg                 INTEGER ${range('weight_kg', L.weightKg)},
  squad_number              INTEGER ${range('squad_number', L.squadNumber)},
  contract_until_date       TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
  market_value_range        TEXT ${optText('market_value_range', L.marketValueRange)},
  agent_name                TEXT ${optText('agent_name', L.agentName)},
  academy_plus              ${flag('academy_plus')},
  first_team_seeker         ${flag('first_team_seeker')},
  availability              TEXT NOT NULL DEFAULT 'not_seeking' ${inList('availability', PLAYER_AVAILABILITY)},
  contract_status           TEXT NOT NULL DEFAULT 'unknown' ${inList('contract_status', PLAYER_CONTRACT_STATUS)},
  level                     TEXT NOT NULL DEFAULT 'amateur' ${inList('level', PLAYER_LEVELS)},
  football_category         TEXT ${optText('football_category', L.footballCategory)},
  identity_verified         ${flag('identity_verified')},
  guardian_id               TEXT REFERENCES guardians(id) ON DELETE RESTRICT,
  lat                       REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                       REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  stats_appearances         INTEGER CHECK (stats_appearances IS NULL OR stats_appearances >= 0),
  stats_goals               INTEGER CHECK (stats_goals IS NULL OR stats_goals >= 0),
  stats_assists             INTEGER CHECK (stats_assists IS NULL OR stats_assists >= 0),
  stats_pace_kmh            REAL CHECK (stats_pace_kmh IS NULL OR stats_pace_kmh >= 0),
  stats_pass_completion_pct REAL ${range('stats_pass_completion_pct', L.pct)},
  stats_duel_success_pct    REAL ${range('stats_duel_success_pct', L.pct)},
  stats_clean_sheets        INTEGER CHECK (stats_clean_sheets IS NULL OR stats_clean_sheets >= 0),
  medical_shared            ${flag('medical_shared')},
  medical_condition_status  TEXT NOT NULL DEFAULT 'unknown' CHECK (length(medical_condition_status) BETWEEN 1 AND ${L.conditionStatus}),
  prefs_quiet_start         TEXT ${HHMM('prefs_quiet_start')},
  prefs_quiet_end           TEXT ${HHMM('prefs_quiet_end')},
  prefs_school_hours_mute   ${optFlag('prefs_school_hours_mute')},
  prefs_timezone            TEXT ${optText('prefs_timezone', L.timezone)},
  programme_track           TEXT ${optText('programme_track', L.programmeTrack)},
  programme_started_at      INTEGER,
  password_hash             TEXT ${optText('password_hash', L.passwordHash)},
  profile_signal            INTEGER NOT NULL CHECK (profile_signal BETWEEN 0 AND ${TRUST.MAX}),
  created_at                INTEGER,
  deleted_at                INTEGER,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (deleted_at IS NULL OR guardian_id IS NULL)
) STRICT;
CREATE INDEX players_guardian ON players (guardian_id);
CREATE INDEX players_created_at ON players (created_at);
CREATE INDEX players_birth_date ON players (birth_date);
CREATE INDEX players_search ON players (country, position, availability);
CREATE INDEX players_level ON players (level);
CREATE INDEX players_located ON players (lat, lng) WHERE lat IS NOT NULL;
CREATE INDEX players_directory ON players (academy_plus DESC, profile_signal DESC, id) WHERE deleted_at IS NULL;

CREATE TABLE guardian_children (
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  role        TEXT NOT NULL ${inList('role', ['primary', 'co'])},
  PRIMARY KEY (guardian_id, player_id)
) STRICT;
CREATE INDEX guardian_children_player ON guardian_children (player_id);
CREATE UNIQUE INDEX guardian_children_one_primary ON guardian_children (player_id) WHERE role = 'primary';
`;

// ------------------------------------------------------------------ typing a whole identity (the seed)
const blocked = (detail: string, extra: { problems?: string[] } = {}) =>
  refusal('IDENTITY_IMPORT_BLOCKED', `${detail}; nothing was written`, extra);
/** The rows a typed identity writes. */
export type TypedIdentity = {
  guardians: { r: GuardianDraft; passwordHash: string | null; emailCodeHash: string | null }[];
  players: { r: PlayerDraft; passwordHash: string | null }[];
  links: { guardian_id: string; player_id: string; role: 'primary' | 'co' }[];
};
/**
 * Type a pair `{ players, guardians }` (the records plus `password`, and a guardian's `emailCodeHash`): every
 * record typed, ids and e-mails unique, every reference and both sides of every link consistent, no minor on `now`
 * without a primary guardian. Returns the rows to write, or throws IDENTITY_IMPORT_BLOCKED naming the ids and fields.
 */
export function typeIdentitySnapshot(
  { players, guardians }: { players: unknown; guardians: unknown },
  { now = Date.now(), retainedIds = new Set<string>() }: { now?: number; retainedIds?: ReadonlySet<string> } = {},
): TypedIdentity {
  for (const [name, value] of [
    ['players', players],
    ['guardians', guardians],
  ] as const)
    if (!Array.isArray(value))
      throw blocked(`${name}: the snapshot collection must be an array of records (got ${describe(value)})`);
  const problems: string[] = [];
  const gRows: TypedIdentity['guardians'] = [];
  const gIds = new Set<string>();
  const emails = new Map<string, string>();
  (guardians as unknown[]).forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`guardians #${i}: not an object (${describe(raw)})`);
      return;
    }
    const { password = null, emailCodeHash = null, ...rest } = raw;
    const g = guardianWithDefaults(rest);
    const at = `guardians ${typeof g.id === 'string' ? g.id : `#${i}`}`;
    const ps = guardianRecordProblems(g);
    const pw = passwordProblem(password);
    if (pw) ps.push(pw);
    const ch = codeHashProblem(emailCodeHash);
    if (ch) ps.push(ch);
    if (ps.length) {
      problems.push(`${at}: ${ps.join('; ')}`);
      return;
    }
    const r = g as GuardianDraft;
    if (gIds.has(r.id)) {
      problems.push(`${at}: duplicate id`);
      return;
    }
    const key = r.email.toLowerCase();
    if (emails.has(key)) {
      problems.push(`${at}: the e-mail is already used by guardian ${emails.get(key)} (compared case-insensitively)`);
      return;
    }
    gIds.add(r.id);
    emails.set(key, r.id);
    gRows.push({ r, passwordHash: password as string | null, emailCodeHash: emailCodeHash as string | null });
  });
  const pRows: TypedIdentity['players'] = [];
  const byId = new Map<string, PlayerDraft>();
  (players as unknown[]).forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`players #${i}: not an object (${describe(raw)})`);
      return;
    }
    const { password = null, ...rest } = raw;
    const p = playerWithDefaults(rest);
    const at = `players ${typeof p.id === 'string' ? p.id : `#${i}`}`;
    const ps = playerRecordProblems(p);
    const pw = passwordProblem(password);
    if (pw) ps.push(pw);
    if (ps.length) {
      problems.push(`${at}: ${ps.join('; ')}`);
      return;
    }
    const r = p as PlayerDraft;
    if (byId.has(r.id)) {
      problems.push(`${at}: duplicate id`);
      return;
    }
    if (retainedIds.has(r.id)) {
      problems.push(
        `${at}: the id is a deleted account whose record is retained; a deleted account is not created again`,
      );
      return;
    }
    if (r.guardianId !== null && !gIds.has(r.guardianId)) {
      problems.push(`${at}: guardianId names guardian ${r.guardianId}, which the snapshot does not hold`);
      return;
    }
    if (r.guardianId === null && !isAdult(r, new Date(now))) {
      problems.push(`${at}: a minor without a primary guardian (guardianId)`);
      return;
    }
    byId.set(r.id, r);
    pRows.push({ r, passwordHash: password as string | null });
  });
  const links: TypedIdentity['links'] = [];
  for (const { r } of gRows) {
    if (r.coGuardianOf !== null && !gIds.has(r.coGuardianOf))
      problems.push(
        `guardians ${r.id}: coGuardianOf names guardian ${r.coGuardianOf}, which the snapshot does not hold`,
      );
    for (const childId of r.childIds) {
      const p = byId.get(childId);
      if (!p) {
        problems.push(`guardians ${r.id}: childIds names player ${childId}, which the snapshot does not hold`);
        continue;
      }
      links.push({ guardian_id: r.id, player_id: childId, role: p.guardianId === r.id ? 'primary' : 'co' });
    }
  }
  const listed = new Set(links.filter((l) => l.role === 'primary').map((l) => l.player_id));
  for (const { r } of pRows)
    if (r.guardianId !== null && !listed.has(r.id))
      problems.push(`players ${r.id}: its guardian ${r.guardianId} does not list it in childIds`);
  if (problems.length)
    throw blocked(
      `identity snapshot: ${problems.length} record(s) or relationship(s) refused — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`,
      { problems },
    );
  return { guardians: gRows, players: pRows, links };
}
/** Write a typed identity (inside the caller's transaction): guardians (co-guardian keys in a second pass), players and their lists, then the links. */
function writeIdentity(sqlite: DatabaseSync, typed: TypedIdentity) {
  const insG = sqlite.prepare(G_INSERT);
  const coG = sqlite.prepare('UPDATE guardians SET co_guardian_of = ? WHERE id = ?');
  for (const { r, passwordHash, emailCodeHash } of typed.guardians)
    insG.run({ ...guardianParams(r, { passwordHash, emailCodeHash }), co_guardian_of: null });
  for (const { r } of typed.guardians) if (r.coGuardianOf !== null) coG.run(r.coGuardianOf, r.id);
  const insP = sqlite.prepare(P_INSERT);
  const st = prepareSubrecordStatements(sqlite);
  for (const { r, passwordHash } of typed.players) {
    insP.run(playerParams(r, passwordHash));
    writeChildRows(st, r);
  }
  const insL = sqlite.prepare(
    'INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (@guardian_id, @player_id, @role)',
  );
  for (const l of typed.links) insL.run(l);
  refreshProfileSignals(sqlite);
  return { players: typed.players.length, guardians: typed.guardians.length, links: typed.links.length };
}

const cutOver = (sqlite: DatabaseSync) => migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION);

/** Read every live player and guardian with their hashes (no trial reports, no coGuardians). */
function readIdentitySnapshot(sqlite: DatabaseSync) {
  const live = sqlite.prepare(`${P_SELECT} WHERE deleted_at IS NULL ORDER BY rowid`).all() as PlayerRow[];
  const children = readChildrenFor(
    sqlite,
    live.map((d) => d.id),
  );
  const players = live.map((d) => {
    const { trialReports: _derived, ...rec } = playerFromDb(d, children.get(d.id) as PlayerLists, []);
    return { ...rec, password: d.password_hash };
  });
  const links = new Map<string, string[]>();
  for (const l of sqlite.prepare('SELECT guardian_id, player_id FROM guardian_children ORDER BY rowid').all() as {
    guardian_id: string;
    player_id: string;
  }[]) {
    let list = links.get(l.guardian_id);
    if (!list) links.set(l.guardian_id, (list = []));
    list.push(l.player_id);
  }
  const guardians = (sqlite.prepare(`${G_SELECT} ORDER BY rowid`).all() as GuardianRow[]).map((d) => {
    const { coGuardians: _derived, ...rec } = guardianFromDb(d, links.get(d.id) ?? [], []);
    return { ...rec, password: d.password_hash, emailCodeHash: d.email_code_hash };
  });
  return { players, guardians };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const IDENTITY_RECORDS = {
  names: IDENTITY_COLLECTIONS,
  cutOver,
  read(sqlite: DatabaseSync) {
    return cutOver(sqlite) ? readIdentitySnapshot(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the links (both sides, one unit)
function createLinks(
  { q, operation }: IdentityKit,
  {
    playerRow,
    guardianChildIds,
  }: {
    playerRow: (id: unknown) => PlayerRow | null;
    guardianChildIds: (id: unknown) => readonly string[] | null;
  },
) {
  const link = (guardianId: string, playerId: string, role: 'primary' | 'co' = 'co'): Link =>
    operation(() => {
      if (role !== 'primary' && role !== 'co')
        throw new TypeError(`a link role is "primary" or "co", not ${JSON.stringify(role)}`);
      const childIds = guardianChildIds(guardianId);
      const p = playerRow(playerId);
      if (!childIds) throw noGuardian(guardianId);
      if (!p) throw noPlayer(playerId);
      if (childIds.includes(playerId))
        throw refusal('LINK_EXISTS', `guardian ${guardianId} already lists player ${playerId}`);
      if (role === 'primary' && p.guardian_id !== null)
        throw refusal(
          'PRIMARY_EXISTS',
          `player ${playerId} already has a primary guardian (${p.guardian_id}); a second primary is refused — unlink or ageUp first`,
        );
      q('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)').run(
        guardianId,
        playerId,
        role,
      );
      if (role === 'primary') q('UPDATE players SET guardian_id = ? WHERE id = ?').run(guardianId, playerId);
      return { guardianId, playerId, role };
    });
  const unlink = (guardianId: string, playerId: string): Link =>
    operation(() => {
      const p = playerRow(playerId);
      if (!q('SELECT 1 FROM guardians WHERE id = ?').get(guardianId)) throw noGuardian(guardianId);
      if (!p) throw noPlayer(playerId);
      const row = q('SELECT role FROM guardian_children WHERE guardian_id = ? AND player_id = ?').get(
        guardianId,
        playerId,
      ) as { role: 'primary' | 'co' } | undefined;
      if (!row) throw refusal('LINK_NOT_FOUND', `guardian ${guardianId} does not list player ${playerId}`);
      if (row.role === 'primary') q('UPDATE players SET guardian_id = NULL WHERE id = ?').run(playerId);
      q('DELETE FROM guardian_children WHERE guardian_id = ? AND player_id = ?').run(guardianId, playerId);
      return { guardianId, playerId, role: row.role };
    });
  return { link, unlink };
}

// ------------------------------------------------------------------ the repositories
type InitState = 'pending' | 'done';
/** What attaching or initialising reports. */
export type IdentityBoot = { engine: 'sqlite'; players: number; guardians: number; links: number; imported: number };

/**
 * `createIdentityRepositories({ sqlite, unit, now, log, trialReportsOf })`. `trialReportsOf(ids)` answers a Map player id
 * → the trial reports naming the player (the recruitment repository); without it every list is empty.
 */
export function createIdentityRepositories({
  sqlite,
  log = () => {},
  unit = null,
  now = Date.now,
  trialReportsOf = null,
}: {
  sqlite: DatabaseSync;
  log?: (line: string) => void;
  unit?: UnitParticipant | null;
  now?: () => number;
  trialReportsOf?: ((ids: string[]) => Map<string, PlayerTrialReport[]>) | null;
}) {
  if (!sqlite)
    throw new TypeError(
      'the identity repositories need a SQLite connection (node:sqlite); players and guardians have no in-memory fallback',
    );
  if (!cutOver(sqlite))
    throw new Error(
      `core identity: the cutover record ${CORE_IDENTITY_LIVE_MIGRATION} is missing from data_migrations; the players, guardians and guardian_children tables cannot be trusted as the source of truth`,
    );
  if (!subrecordsLive(sqlite))
    throw new Error(
      `core identity: the sub-record record ${PLAYER_SUBRECORDS_MIGRATION} is missing from data_migrations; the player lists have no storage on this connection`,
    );
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function'))
    throw new TypeError(
      "the identity repositories need the store's participant API `unit` ({ active(), join(work) }) or null",
    );
  const kit = identityKit(sqlite, unit, now);
  const { q } = kit;
  const playerRow = (id: unknown) => livePlayerRow(q, id);
  const guardianActs = createGuardians(kit, { playerRow });
  const { link, unlink } = createLinks(kit, {
    playerRow,
    guardianChildIds: (id) => guardianActs.byId(id)?.childIds ?? null,
  });
  const players = createPlayers(kit, { links: { link, unlink }, trialReportsOf });
  const guardians = {
    ...guardianActs,
    link: (guardianId: string, playerId: string, role?: 'primary' | 'co'): Link => link(guardianId, playerId, role),
    unlink,
  };

  const readInitState = (): InitState => {
    const row = q('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META) as { value: string } | undefined;
    if (!row) return 'done';
    if (row.value !== 'pending' && row.value !== 'done')
      throw new Error(
        `core identity: meta.${CORE_IDENTITY_INIT_META} holds ${JSON.stringify(row.value)}, which is neither "pending" nor "done"`,
      );
    return row.value;
  };
  const countOf = (sql: string) => (q(sql).get() as { n: number }).n;

  const identity = {
    players: Object.assign(players, { reads: readsOf(players, PLAYER_WRITES) }),
    guardians: Object.assign(guardians, { reads: readsOf(guardians, [...GUARDIAN_WRITES, 'link', 'unlink']) }),
    link,
    unlink,
    initState: readInitState,
    cutOver: () => cutOver(sqlite),
    attach(): IdentityBoot {
      if (readInitState() === 'pending')
        throw new Error(
          `core identity: initialisation is pending (meta.${CORE_IDENTITY_INIT_META}); call initialize() with the first installation's records instead of attach()`,
        );
      const counts = identity.report();
      log(`core identity: ${counts.players} player(s), ${counts.guardians} guardian(s) in the tables`);
      return {
        engine: 'sqlite',
        players: counts.players,
        guardians: counts.guardians,
        links: counts.links,
        imported: 0,
      };
    },
    /**
     * First-installation initialisation: type the given records (the seed, with their hashes) and write them with the
     * state `done` in one transaction. Allowed only while the state is `pending` and the tables are empty; a refused
     * seed writes nothing and the state stays `pending`.
     */
    initialize(
      seed: { players: unknown; guardians: unknown },
      { now: at = now() }: { now?: number } = {},
    ): IdentityBoot {
      if (readInitState() !== 'pending')
        throw new Error(
          `core identity: already initialised (meta.${CORE_IDENTITY_INIT_META} is "done"); the tables are authoritative and nothing is imported`,
        );
      const stored = countOf('SELECT (SELECT COUNT(*) FROM players) + (SELECT COUNT(*) FROM guardians) AS n');
      if (stored)
        throw new Error(
          `core identity: initialisation is pending but the tables already hold ${stored} row(s) written outside the repositories; refusing to initialise over them`,
        );
      if (sqlite.isTransaction)
        throw new Error(
          'core identity: initialize() runs in a transaction of its own and cannot start inside an open transaction',
        );
      if (!isPlainObject(seed))
        throw new TypeError(
          `core identity: initialize() needs { players, guardians } (got ${describe(seed)}); nothing was written and initialisation stays pending`,
        );
      let typed: TypedIdentity;
      try {
        typed = typeIdentitySnapshot(seed, { now: at });
      } catch (err) {
        const e = err as Error & { problems?: string[] };
        throw Object.assign(new Error(`CORE_IDENTITY_CUTOVER_BLOCKED: ${e.message}; initialisation stays pending`), {
          code: 'CORE_IDENTITY_CUTOVER_BLOCKED',
          problems: e.problems ?? [],
        });
      }
      const counts = transaction(sqlite, () => {
        const c = writeIdentity(sqlite, typed);
        q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          CORE_IDENTITY_INIT_META,
          'done',
        );
        return c;
      });
      log(
        `core identity: initialised ${counts.players} player(s), ${counts.guardians} guardian(s) and ${counts.links} link(s) from the first installation's records`,
      );
      return { engine: 'sqlite', ...counts, imported: counts.players + counts.guardians };
    },
    report: () => ({
      players: players.count(),
      retained: players.retainedCount(),
      guardians: guardians.count(),
      links: countOf('SELECT COUNT(*) AS n FROM guardian_children'),
      initState: readInitState(),
    }),
  };
  return identity;
}
export type IdentityRepositories = ReturnType<typeof createIdentityRepositories>;
export type Players = IdentityRepositories['players'];
export type Guardians = IdentityRepositories['guardians'];
