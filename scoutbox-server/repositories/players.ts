/**
 * Players (`players`; the lists are playerSubrecords.ts, the record is playerRecord.ts).
 *
 * A player's columns change only through the named acts (`setAvailability`, `recordStats`, …). The lists are rows of
 * the `player_*` tables, written only through `addItem`, `setItems` and `patchItem`. The password hash is never on a
 * record (`passwordHashOf`, `setPasswordHash`). Responses are allowlists.
 *
 * A minor is created with its primary guardian link in the same transaction (an unlinked child cannot be created);
 * `ageUp` clears the primary link only (co-guardians keep listing the player). An account deletion (`erase`) keeps the
 * retained record (playerRecord.ts); a retained row is served by nothing that serves accounts, only by the `retained*`
 * accessors, and its id is never created again. Not a retention policy.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { isConstraintError } from './writes.ts';
import { isAdult, ADULT_AGE, GRASSROOTS_RADIUS_KM, trustScoreFromFacts, haversineKm, type LatLng } from '../domain.ts';
import { deepFreeze } from '../domains/platform/values.ts';
import { boxAround } from './grassroots.mjs';
import {
  SUBRECORD_KEYS,
  SUBRECORD_SPECS,
  getSubrecords,
  validateSubrecordArray,
  prepareSubrecordStatements,
  writeChildRows,
  writeArrayRows,
  deleteChildRows,
  readChildren,
  readChildrenFor,
  countChildRows,
  itemRows,
  storedItem,
  type SubrecordKey,
  type SubrecordItems,
  type SubrecordInputs,
  type ObjectListKey,
  type PlayerLists,
} from './playerSubrecords.ts';
import {
  P_SELECT,
  P_INSERT,
  PLAYER_COLUMNS,
  ERASE_SQL,
  LIGHT_COLS,
  STATS_COLUMN,
  isStatsKey,
  playerWithDefaults,
  playerRecordProblems,
  playerParams,
  playerFromDb,
  lightFromRow,
  livePlayerRow,
  eraseParamsFor,
  retainedRecordFromRow,
  RETAINED_SELECT,
  type Player,
  type PlayerDraft,
  type PlayerInput,
  type PlayerRow,
  type LightRow,
  type LightPlayer,
  type PlayerTrialReport,
  type PlayerLevel,
  type PlayerAvailability,
  type PlayerContractStatus,
  type PlayerStats,
  type RetainedPlayer,
} from './playerRecord.ts';
import {
  refusal,
  isPlainObject,
  isClock,
  describe,
  clone,
  nb,
  prefsReplacementProblems,
  passwordProblem,
  NO_PREFS,
  pageOf,
  type IdentityKit,
  type NotificationPrefs,
} from './identityRules.ts';

// ------------------------------------------------------------------ visibility in SQL (a prefilter; the exact rule is domain.ts visibleToOrg)
/** The latest birth date of someone at least `years` old on `nowMs` (YYYY-MM-DD; compared as text, exactly ageOn's rule). */
export function bornByForAge(years: number, nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  return `${String(d.getUTCFullYear() - years).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** A condition on `players p` and its parameters. */
export type SqlWhere = { sql: string; args: SQLInputValue[] };
/** `birth_date <= <the adult cutoff of the player's country>`: the adults on `nowMs`, by the per-country age of majority. */
function adultsSql(nowMs: number): SqlWhere {
  const special = Object.entries(ADULT_AGE).filter(([k]) => k !== 'DEFAULT');
  const sql = `p.birth_date <= CASE p.country ${special.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ? END`;
  const args = [
    ...special.flatMap(([c, age]) => [c, bornByForAge(age, nowMs)]),
    bornByForAge(ADULT_AGE.DEFAULT, nowMs),
  ];
  return { sql, args };
}
/** The organisation a visibility read is for: what the rule reads off it. */
export type ViewingOrgRecord = {
  id: string;
  type?: string | null;
  verified?: boolean | null;
  level?: string | null;
  location?: LatLng | null;
};
/** Can this organisation ever see a minor (domain.ts visibleToOrg: a verified club only)? */
const seesMinors = (org: ViewingOrgRecord) => org?.type === 'club' && org.verified === true;
/**
 * The SQL functions the player reads use, registered on the connection from the JS rules themselves (one
 * definition each): `haversine_km` (domain.ts haversineKm, the Grassroots radius), `distance_tenths` (the distance a
 * Grassroots club is shown, in tenths of a km, as views/playerViews.mjs rounds it) and `lower_js` (JavaScript's
 * toLowerCase, which also lowers accented letters; SQLite's lower() is ASCII only).
 */
const withFunctions = new WeakSet<DatabaseSync>();
export function registerPlayerFunctions(sqlite: DatabaseSync): void {
  if (withFunctions.has(sqlite)) return;
  const at = (lat: number, lng: number) => ({ lat, lng });
  const real = (...vs: unknown[]): boolean => vs.every((v) => typeof v === 'number' && Number.isFinite(v));
  const km = (aLat: unknown, aLng: unknown, bLat: unknown, bLng: unknown): number | null =>
    real(aLat, aLng, bLat, bLng)
      ? haversineKm(at(aLat as number, aLng as number), at(bLat as number, bLng as number))
      : null;
  sqlite.function('haversine_km', { deterministic: true }, km);
  sqlite.function('distance_tenths', { deterministic: true }, (aLat, aLng, bLat, bLng) => {
    const d = km(aLat, aLng, bLat, bLng);
    return d === null ? null : Math.round(d * 10);
  });
  sqlite.function('lower_js', { deterministic: true }, (v) => (typeof v === 'string' ? v.toLowerCase() : v));
  withFunctions.add(sqlite);
}
/** The longitude ranges of a box, split in two where it crosses ±180° (so the far side of the antimeridian is kept). */
function lngRanges(box: { minLng: number; maxLng: number }): [number, number][] {
  if (box.maxLng - box.minLng >= 360) return [[-180, 180]];
  if (box.minLng < -180)
    return [
      [box.minLng + 360, 180],
      [-180, box.maxLng],
    ];
  if (box.maxLng > 180)
    return [
      [box.minLng, 180],
      [-180, box.maxLng - 360],
    ];
  return [[box.minLng, box.maxLng]];
}

// ------------------------------------------------------------------ profile completeness
/**
 * `players.profile_signal`: the directory's sort figure, domain.ts `trustScoreFromFacts` over the row's facts and its
 * list counts (attendance, clips, the trials' filed reports). Every write that can change a fact refreshes it in its own
 * transaction or unit: the player writes here, a trial write in the recruitment repository.
 * `ids` null refreshes every live player.
 */
type SignalStatements = { all: StatementSync; one: StatementSync; many: StatementSync; update: StatementSync };
type SignalRow = Pick<PlayerRow, 'id' | 'profile_signal' | 'identity_verified' | 'position' | 'foot'> &
  Pick<PlayerRow, 'height_cm' | 'weight_kg'> & { has_stats: 0 | 1; attendance: number; media: number; reports: number };
const signalSqlCache = new WeakMap<DatabaseSync, SignalStatements>();
function signalSql(sqlite: DatabaseSync): SignalStatements {
  const cached = signalSqlCache.get(sqlite);
  if (cached) return cached;
  // Cached only once the trial reports table exists (a connection that reads before it does asks again next time).
  const hasTrials = !!sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trial_reports'")
    .get();
  const reports = hasTrials
    ? '(SELECT COUNT(*) FROM trial_reports r JOIN trials t ON t.id = r.trial_id WHERE t.player_id = p.id)'
    : '0';
  const stats = Object.values(STATS_COLUMN)
    .map((c) => `p.${c} IS NOT NULL`)
    .join(' OR ');
  const select = `SELECT p.id, p.profile_signal, p.identity_verified, p.position, p.foot, p.height_cm, p.weight_kg, (${stats}) AS has_stats,
      (SELECT COUNT(*) FROM player_attendance a WHERE a.player_id = p.id) AS attendance,
      (SELECT COUNT(*) FROM player_media m WHERE m.player_id = p.id) AS media,
      ${reports} AS reports
      FROM players p WHERE p.deleted_at IS NULL`;
  const sql = {
    all: sqlite.prepare(select),
    one: sqlite.prepare(`${select} AND p.id = ?`),
    many: sqlite.prepare(`${select} AND p.id IN (SELECT value FROM json_each(?))`),
    update: sqlite.prepare('UPDATE players SET profile_signal = ? WHERE id = ?'),
  };
  if (hasTrials) signalSqlCache.set(sqlite, sql);
  return sql;
}
const signalOfRow = (d: SignalRow) =>
  trustScoreFromFacts({
    identityVerified: d.identity_verified === 1,
    attendanceCount: d.attendance,
    trialReportCount: d.reports,
    mediaCount: d.media,
    profileComplete: !!(d.position && d.foot && d.height_cm && d.weight_kg && d.has_stats),
  });
/** Bring the players' `profile_signal` up to date (all live players when `ids` is null); returns how many changed. */
export function refreshProfileSignals(sqlite: DatabaseSync, ids: readonly unknown[] | null = null): number {
  const sql = signalSql(sqlite);
  const list = ids === null ? null : [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x))];
  if (list !== null && !list.length) return 0;
  const rows = (
    list === null ? sql.all.all() : list.length === 1 ? sql.one.all(list[0]) : sql.many.all(JSON.stringify(list))
  ) as SignalRow[];
  let changed = 0;
  for (const d of rows) {
    const v = signalOfRow(d);
    if (v !== d.profile_signal) {
      sql.update.run(v, d.id);
      changed += 1;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ the repository
/**
 * The scans' filters (SQL prefilters; callers keep the exact rules). `visibleTo` applies what SQL can of the
 * visibility rule: the under-18 wall (by the country's age of majority) for an organisation that cannot see minors,
 * and for a grassroots club "not pro, inside the box around the ground" (a club without a ground sees nobody). The
 * caller still applies visibleToOrg and the blocks.
 */
export type PlayerFilter = {
  visibleTo?: ViewingOrgRecord | null;
  adultsOnly?: boolean;
  position?: string | null;
  availability?: string | null;
  country?: string | null;
  academyPlus?: boolean;
  notLevel?: string | null;
  createdSince?: number | null;
  ageAtLeast?: number | null;
  ageBelow?: number | null;
  exceptId?: string | null;
  /** The position is one of these (and with `orNoPosition`, or none is declared). */
  positions?: readonly string[] | null;
  orNoPosition?: boolean;
  /** The directory's search: name or country, or an adult's city. */
  text?: string | null;
};
/** One key of a keyset order: an SQL expression over `players p`, its direction and its parameters. */
export type OrderKey = [expr: string, dir: 'ASC' | 'DESC', args?: SQLInputValue[]];
/** A page request (domains/platform/paging.mjs readPage): `after` is the previous page's last key. */
export type PageRequest = { limit: number; after?: readonly SQLInputValue[] | null };
export type Page<T> = { items: T[]; nextCursor: string | null };

/** A list item, field by field. */
type Where = Record<string, unknown>;
const SCAN_BATCH = 500;

export const PLAYER_WRITES = Object.freeze([
  'create',
  'setAvailability',
  'setLevel',
  'setFootballCategory',
  'setAcademyPlus',
  'setFirstTeamSeeker',
  'setMedicalSharing',
  'setConditionStatus',
  'setLocation',
  'recordStats',
  'startProgramme',
  'setNotificationPrefs',
  'setPasswordHash',
  'addItem',
  'setItems',
  'patchItem',
  'ageUp',
  'erase',
  'link',
  'unlink',
] as const);

export const playerInvalid = (id: unknown, problems: string[]) =>
  refusal('PLAYER_RECORD_INVALID', `a player record was refused (player ${id}): ${problems.join('; ')}`, {
    problems,
  });
export const noPlayer = (id: unknown) => refusal('PLAYER_NOT_FOUND', `player ${id} does not exist`);

/** A guardian–player link, as the link acts return it. */
export type Link = { guardianId: string; playerId: string; role: 'primary' | 'co' };
/** The link acts (identity.ts): both sides of a link change together. */
export type LinkActs = {
  link(guardianId: string, playerId: string, role?: 'primary' | 'co'): Link;
  unlink(guardianId: string, playerId: string): Link;
};

/**
 * The players repository. `trialReportsOf(ids)` answers a Map player id → the trial reports naming the player (the
 * recruitment repository); without it every list is empty.
 */
export function createPlayers(
  { sqlite, q, operation, now }: IdentityKit,
  {
    links,
    trialReportsOf = null,
  }: {
    links: LinkActs;
    trialReportsOf?: ((ids: string[]) => Map<string, PlayerTrialReport[]>) | null;
  },
) {
  const st = prepareSubrecordStatements(sqlite);
  const reportsFor = (ids: string[]) => (trialReportsOf && ids.length ? trialReportsOf(ids) : new Map());
  registerPlayerFunctions(sqlite);
  let blocksTable = false; // remembered once true: a read before the safety migration asks again next time
  const hasBlocks = () =>
    (blocksTable ||= !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'").get());

  // ---------------------------------------------------------- decoding
  const decodePlayers = (rows: PlayerRow[]): Player[] => {
    if (!rows.length) return [];
    const ids = rows.map((d) => d.id);
    const children = rows.length === 1 ? new Map([[ids[0], readChildren(st, ids[0])]]) : readChildrenFor(sqlite, ids);
    const reports = reportsFor(ids);
    return rows.map((d) =>
      deepFreeze(playerFromDb(d, children.get(d.id) as PlayerLists, clone(reports.get(d.id) ?? []))),
    );
  };
  const playerById = (id: unknown): Player | null =>
    typeof id === 'string' && id
      ? (decodePlayers(q(`${P_SELECT} WHERE id = ? AND deleted_at IS NULL`).all(id) as PlayerRow[])[0] ?? null)
      : null;
  /** The player after an act that has just written it. */
  const stored = (id: string): Player => {
    const p = playerById(id);
    if (!p) throw noPlayer(id);
    return p;
  };
  const playerRow = (id: unknown) => livePlayerRow(q, id);
  const isRetainedId = (id: unknown) =>
    !!q('SELECT 1 FROM players WHERE id = ? AND deleted_at IS NOT NULL').get(id as string);
  const countOf = (sql: string) => (q(sql).get() as { n: number }).n;

  // ---------------------------------------------------------- filters for the scans
  const scanWhere = (f: PlayerFilter = {}, at: number = now()): SqlWhere | null => {
    const sql = ['p.deleted_at IS NULL'];
    const args: SQLInputValue[] = [];
    const adults = () => {
      const a = adultsSql(at);
      sql.push(a.sql);
      args.push(...a.args);
    };
    if (f.visibleTo) {
      const org = f.visibleTo;
      if (!seesMinors(org)) adults();
      if ((org.level ?? null) === 'grassroots') {
        if (!org.location) return null;
        // The box narrows by index; the exact radius is domain.ts haversineKm, as visibleToOrg applies it.
        const box = boxAround(org.location, GRASSROOTS_RADIUS_KM);
        const lngs = lngRanges(box);
        sql.push(
          "p.level <> 'pro'",
          `p.lat IS NOT NULL AND p.lat BETWEEN ? AND ? AND (${lngs.map(() => 'p.lng BETWEEN ? AND ?').join(' OR ')})`,
          'haversine_km(?, ?, p.lat, p.lng) <= ?',
        );
        args.push(box.minLat, box.maxLat, ...lngs.flat(), org.location.lat, org.location.lng, GRASSROOTS_RADIUS_KM);
      }
      // A player who blocked the organisation is not a candidate (isBlocked, the safety tables').
      if (hasBlocks()) {
        sql.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE b.player_id = p.id AND b.org_id = ?)');
        args.push(org.id);
      }
    }
    if (f.adultsOnly) adults();
    for (const k of ['position', 'availability', 'country'] as const) {
      const v = f[k];
      if (v !== undefined && v !== null) {
        sql.push(`p.${k} = ?`);
        args.push(v);
      }
    }
    if (f.academyPlus === true) sql.push('p.academy_plus = 1');
    if (typeof f.notLevel === 'string') {
      sql.push('p.level <> ?');
      args.push(f.notLevel);
    }
    if (Number.isFinite(f.createdSince)) {
      sql.push('p.created_at >= ?');
      args.push(f.createdSince as number);
    }
    if (Number.isSafeInteger(f.ageAtLeast)) {
      sql.push('p.birth_date <= ?');
      args.push(bornByForAge(f.ageAtLeast as number, at));
    }
    if (Number.isSafeInteger(f.ageBelow)) {
      sql.push('p.birth_date > ?');
      args.push(bornByForAge(f.ageBelow as number, at));
    }
    if (typeof f.exceptId === 'string') {
      sql.push('p.id <> ?');
      args.push(f.exceptId);
    }
    if (Array.isArray(f.positions)) {
      sql.push(`(p.position IN (SELECT value FROM json_each(?))${f.orNoPosition ? ' OR p.position IS NULL' : ''})`);
      args.push(JSON.stringify(f.positions));
    }
    if (typeof f.text === 'string' && f.text) {
      // The directory's search: name or country, and the city of an adult only (a minor's city is never shown to a club,
      // so it is never matched either), case-insensitively as JavaScript lowers text.
      const a = adultsSql(at);
      sql.push(
        `(instr(lower_js(p.name), ?) > 0 OR instr(lower_js(p.country), ?) > 0 OR (p.city IS NOT NULL AND instr(lower_js(p.city), ?) > 0 AND ${a.sql}))`,
      );
      const needle = f.text.toLowerCase();
      args.push(needle, needle, needle, ...a.args);
    }
    return { sql: sql.join(' AND '), args };
  };
  const P_COLS_OF_P = PLAYER_COLUMNS.map((c) => `p.${c}`).join(', ');
  const LIGHT_OF_P = LIGHT_COLS.map((c) => `p.${c}`).join(', ');
  /** Visit the players a filter admits, in creation order, decoding a batch at a time; `visit` returning false stops the scan. */
  const scan = (filter: PlayerFilter, visit: (p: Player) => unknown): void => {
    const w = scanWhere(filter);
    if (!w) return;
    let after = 0;
    for (;;) {
      const rows = q(
        `SELECT p.rowid AS rid, ${P_COLS_OF_P} FROM players p WHERE ${w.sql} AND p.rowid > ? ORDER BY p.rowid LIMIT ?`,
      ).all(...w.args, after, SCAN_BATCH) as (PlayerRow & { rid: number })[];
      if (!rows.length) return;
      after = rows[rows.length - 1].rid;
      for (const rec of decodePlayers(rows)) if (visit(rec) === false) return;
      if (rows.length < SCAN_BATCH) return;
    }
  };

  /**
   * Keyset paging over the admitted players. `order`'s last key is unique (the id); `after` is the previous page's
   * last key. Returns the rows (with `k0…kN`, the key) of one page plus one.
   */
  const keysetRows = (w: SqlWhere, order: readonly OrderKey[], { limit, after = null }: PageRequest) => {
    const keys = order.map(([expr], i) => `${expr} AS k${i}`).join(', ');
    const keyArgs = order.flatMap(([, , a = []]) => a);
    // (k0 beyond a0) OR (k0 = a0 AND k1 beyond a1) OR …: "beyond" is < for a descending key, > for an ascending one.
    // The leading key's bound is repeated on its own so the index can seek to the page instead of walking to it.
    const beyond = after
      ? ` WHERE k0 ${order[0][1] === 'DESC' ? '<=' : '>='} ? AND (${order.map((_, i) => `(${[...order.slice(0, i).map((__, j) => `k${j} = ?`), `k${i} ${order[i][1] === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`).join(' OR ')})`
      : '';
    const afterArgs = after ? [after[0], ...order.flatMap((_, i) => [...after.slice(0, i), after[i]])] : [];
    const sql = `SELECT * FROM (SELECT p.rowid AS rid, ${P_COLS_OF_P}, ${keys} FROM players p WHERE ${w.sql})${beyond} ORDER BY ${order.map(([, dir], i) => `k${i} ${dir}`).join(', ')} LIMIT ?`;
    return q(sql).all(...keyArgs, ...w.args, ...afterArgs, limit + 1) as (PlayerRow & Record<string, SQLInputValue>)[];
  };
  const keyOfRow = (n: number) => (r: Record<string, unknown>) => Array.from({ length: n }, (_, i) => r[`k${i}`]);
  /** The order of the org directory (wiring.mjs /org/players): declared in its X-ScoutBox-Ordering header. */
  const directoryOrder = (org: ViewingOrgRecord): OrderKey[] =>
    (org.level ?? null) === 'grassroots'
      ? [
          ['p.first_team_seeker', 'DESC'],
          ['distance_tenths(?, ?, p.lat, p.lng)', 'ASC', [org.location?.lat ?? null, org.location?.lng ?? null]],
          ['p.profile_signal', 'DESC'],
          ['p.id', 'ASC'],
        ]
      : [
          ['p.academy_plus', 'DESC'],
          ['p.profile_signal', 'DESC'],
          ['p.id', 'ASC'],
        ];

  // ---------------------------------------------------------- list operations (the rows of the player_* tables)
  const checkSubKey = (key: unknown): SubrecordKey => {
    if (!(SUBRECORD_KEYS as readonly unknown[]).includes(key))
      throw new TypeError(`"${key}" is not a player list; the lists are ${SUBRECORD_KEYS.join(', ')}`);
    return key as SubrecordKey;
  };
  const subRefusal = (message: string) => refusal('PLAYER_SUBRECORD_INVALID', message);
  const subTarget = <K extends SubrecordKey>(id: string, key: K) => {
    checkSubKey(key);
    const rec = playerById(id);
    if (!rec) throw noPlayer(id);
    if (key === 'programme.completed' && rec.programme === null)
      throw subRefusal(
        `player ${id}: programme is null, so programme.completed cannot be written (start a programme first with players.startProgramme)`,
      );
    return { rec, current: (getSubrecords(rec, key) ?? []) as readonly SubrecordItems[K][] };
  };
  const listOf = <K extends SubrecordKey>(id: string, key: K) =>
    getSubrecords(playerById(id), key) as readonly SubrecordItems[K][];

  /**
   * Write some columns of a live player. `cols` holds values, bound as parameters; `computed` holds SQL expressions of
   * the row's own columns, and comes from the act's code, never from a caller. A constraint failure (a CHECK, a STRICT
   * type) is a PLAYER_RECORD_INVALID naming the columns. Returns the stored record.
   */
  const setColumns = (id: string, cols: Record<string, unknown>, computed: Record<string, string> = {}): Player =>
    operation(() => {
      const names = [...Object.keys(cols), ...Object.keys(computed)];
      const bad = Object.keys(cols).filter((c) => cols[c] !== null && typeof cols[c] === 'object');
      if (bad.length)
        throw playerInvalid(
          id,
          bad.map((c) => `${c} must be a single value`),
        );
      const assign = [
        ...Object.keys(cols).map((c) => `${c} = @${c}`),
        ...Object.entries(computed).map(([c, sql]) => `${c} = ${sql}`),
      ].join(', ');
      // Anything else a column cannot hold is refused by its CHECK or STRICT type below.
      const params = Object.fromEntries(
        Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : (v as SQLInputValue)]),
      );
      let changes;
      try {
        changes = q(`UPDATE players SET ${assign} WHERE id = @id AND deleted_at IS NULL`).run({
          ...params,
          id,
        }).changes;
      } catch (e) {
        if (isConstraintError(e)) throw playerInvalid(id, [`${names.join(', ')}: ${e.message}`]);
        throw e;
      }
      if (changes !== 1) throw noPlayer(id);
      refreshProfileSignals(sqlite, [id]);
      return stored(id);
    });
  const flagOf = (id: string, field: string, v: unknown): 0 | 1 => {
    if (typeof v !== 'boolean') throw playerInvalid(id, [`${field} must be a boolean`]);
    return v ? 1 : 0;
  };

  const players = {
    /**
     * Create a player (`passwordHash` stored, never on the record). Absent optional fields take their defaults; junk is
     * refused by field. A record with `guardianId` is created with its primary link in the same unit; a minor (on
     * `now`) without one is refused. A retained id is never created again. Returns the stored record.
     */
    create: ({ passwordHash = null, ...fields }: PlayerInput & { passwordHash?: string | null }): Player =>
      operation(() => {
        const raw = playerWithDefaults(fields);
        const problems = playerRecordProblems(raw);
        const pw = passwordProblem(passwordHash);
        if (pw) problems.push(pw);
        if (problems.length) throw playerInvalid(raw.id, problems);
        const r = raw as PlayerDraft;
        if (isRetainedId(r.id))
          throw refusal(
            'PLAYER_ID_RETAINED',
            `player ${r.id} was deleted and its id is retained; a deleted account is not created again under its id`,
          );
        if (q('SELECT 1 FROM players WHERE id = ?').get(r.id))
          throw refusal('PLAYER_EXISTS', `player ${r.id} already exists`);
        if (r.guardianId !== null && !q('SELECT 1 FROM guardians WHERE id = ?').get(r.guardianId))
          throw refusal('GUARDIAN_NOT_FOUND', `player ${r.id} names guardian ${r.guardianId}, which does not exist`);
        if (r.guardianId === null && !isAdult(r, new Date(now())))
          throw refusal(
            'MINOR_WITHOUT_GUARDIAN',
            `player ${r.id} is a minor and has no guardianId: a child is created with its primary guardian and the link in the same transaction, never without`,
          );
        q(P_INSERT).run(playerParams(r, passwordHash));
        writeChildRows(st, r);
        if (r.guardianId !== null)
          q("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, 'primary')").run(
            r.guardianId,
            r.id,
          );
        refreshProfileSignals(sqlite, [r.id]);
        return stored(r.id);
      }),
    /*
     * The named acts, one per change a route makes. Each writes its own columns; the table's CHECKs judge the values,
     * and a refusal names the player and the field.
     */
    /** The availability, the contract status, or both (absent ones kept). */
    setAvailability: (
      id: string,
      {
        availability,
        contractStatus,
      }: { availability?: PlayerAvailability; contractStatus?: PlayerContractStatus } = {},
    ): Player => {
      const cols: Record<string, unknown> = {};
      if (availability !== undefined) cols.availability = availability;
      if (contractStatus !== undefined) cols.contract_status = contractStatus;
      if (!Object.keys(cols).length)
        throw new TypeError('players.setAvailability needs availability, contractStatus or both');
      return setColumns(id, cols);
    },
    setLevel: (id: string, level: PlayerLevel): Player => setColumns(id, { level }),
    /** The competition category, or null. */
    setFootballCategory: (id: string, category: string | null): Player =>
      setColumns(id, { football_category: category }),
    setAcademyPlus: (id: string, on: boolean): Player =>
      setColumns(id, { academy_plus: flagOf(id, 'academyPlus', on) }),
    setFirstTeamSeeker: (id: string, on: boolean): Player =>
      setColumns(id, { first_team_seeker: flagOf(id, 'firstTeamSeeker', on) }),
    setMedicalSharing: (id: string, shared: boolean): Player =>
      setColumns(id, { medical_shared: flagOf(id, 'medical.shared', shared) }),
    setConditionStatus: (id: string, status: string): Player => setColumns(id, { medical_condition_status: status }),
    /** `{ lat, lng }` and nothing else. */
    setLocation: (id: string, location: LatLng): Player => {
      if (!isPlainObject(location) || Object.keys(location).some((k) => k !== 'lat' && k !== 'lng'))
        throw playerInvalid(id, [`location must be { lat, lng } (got ${describe(location)})`]);
      return setColumns(id, { lat: location.lat, lng: location.lng });
    },
    /**
     * Record current-season stats: the fields given replace theirs, the others are kept, and the appearances, goals
     * and assists read 0 rather than unknown once anything is recorded.
     */
    recordStats: (id: string, stats: Partial<PlayerStats>): Player => {
      if (!isPlainObject(stats)) throw playerInvalid(id, [`stats must be an object (got ${describe(stats)})`]);
      const unknown = Object.keys(stats).filter((k) => !isStatsKey(k));
      if (unknown.length)
        throw playerInvalid(
          id,
          unknown.map((k) => `stats.${k} is not a stat`),
        );
      // An undefined stat is an absent one.
      const given = Object.entries(stats).filter(([, v]) => v !== undefined) as [keyof PlayerStats, unknown][];
      const cols = Object.fromEntries(given.map(([k, v]) => [STATS_COLUMN[k], v]));
      const zeroIfUnknown = Object.fromEntries(
        (['appearances', 'goals', 'assists'] as const)
          .filter((k) => stats[k] === undefined)
          .map((k) => [STATS_COLUMN[k], `COALESCE(${STATS_COLUMN[k]}, 0)`]),
      );
      return setColumns(id, cols, zeroIfUnknown);
    },
    /** Start (or switch to) a training track at `at`: the completed sessions of the previous track go in the same unit. */
    startProgramme: (id: string, track: string, at: number): Player =>
      operation(() => {
        if (!isClock(at))
          throw new TypeError('players.startProgramme: `at` must be a non-negative integer timestamp (ms)');
        const after = setColumns(id, { programme_track: track, programme_started_at: at });
        if (!after.programme?.completed.length) return after;
        st['programme.completed'].deleteAll.run(id);
        return stored(id);
      }),
    /** Replace the notification preferences, or clear them with null. */
    setNotificationPrefs: (id: string, prefs: NotificationPrefs | null): Player => {
      const n = prefs ?? NO_PREFS;
      const problems = prefsReplacementProblems(n);
      if (problems.length) throw playerInvalid(id, problems);
      return setColumns(id, {
        prefs_quiet_start: n.quietStart,
        prefs_quiet_end: n.quietEnd,
        prefs_school_hours_mute: nb(n.schoolHoursMute),
        prefs_timezone: n.timezone,
      });
    },
    /** Store a new password hash (or null). Returns the stored record. */
    setPasswordHash: (id: string, hash: string | null): Player =>
      operation(() => {
        const pw = passwordProblem(hash);
        if (pw) throw playerInvalid(id, [pw]);
        if (q('UPDATE players SET password_hash = ? WHERE id = ? AND deleted_at IS NULL').run(hash, id).changes !== 1)
          throw noPlayer(id);
        return stored(id);
      }),

    /** Append one item to a player's `key` list (validated with the whole list); returns the stored list. */
    addItem: <K extends SubrecordKey>(id: string, key: K, item: SubrecordInputs[K]) =>
      operation(() => {
        const { current } = subTarget(id, key);
        const items = [...current, clone(item)];
        const problems = validateSubrecordArray(key, items);
        if (problems.length) throw subRefusal(`adding to ${key} of player ${id} was refused: ${problems.join('; ')}`);
        const { row, tags } = itemRows(key, items[items.length - 1], items.length - 1, id);
        st[key].insert.run(row);
        if (tags) for (const t of tags) st.tags.insert.run(t);
        refreshProfileSignals(sqlite, [id]);
        return listOf(id, key);
      }),
    /** Replace a player's whole `key` list; returns the stored list. */
    setItems: <K extends SubrecordKey>(id: string, key: K, items: readonly SubrecordInputs[K][]) =>
      operation(() => {
        subTarget(id, key);
        if (!Array.isArray(items))
          throw new TypeError(`players.setItems needs an array for ${key} (got ${describe(items)})`);
        const next = clone(items);
        const problems = validateSubrecordArray(key, next);
        if (problems.length) throw subRefusal(`replacing ${key} of player ${id} was refused: ${problems.join('; ')}`);
        st[key].deleteAll.run(id); // a clip's tags cascade with the clip
        writeArrayRows(st, key, id, next);
        refreshProfileSignals(sqlite, [id]);
        return listOf(id, key);
      }),
    /** Change fields of the ONE item of `key` that `where` matches (`{ id }`, `{ season }`); returns the stored item. */
    patchItem: <K extends ObjectListKey>(
      id: string,
      key: K,
      where: Partial<SubrecordItems[K]>,
      patch: Partial<SubrecordInputs[K]>,
    ) =>
      operation(() => {
        const { current } = subTarget(id, key);
        if (SUBRECORD_SPECS[key].primitive)
          throw new TypeError(`${key} holds plain values; replace the list with players.setItems`);
        if (!isPlainObject(where) || !Object.keys(where).length)
          throw new TypeError('players.patchItem needs a where object ({ id } or another equality test)');
        if (!isPlainObject(patch)) throw new TypeError('players.patchItem needs a patch object');
        const items = current as readonly Where[];
        const test = where as Where;
        const change = patch as Where;
        const matches = items.map((_, i) => i).filter((i) => Object.keys(test).every((k) => items[i][k] === test[k]));
        if (matches.length !== 1)
          throw subRefusal(
            `players.patchItem: ${matches.length} item(s) of ${key} of player ${id} match ${JSON.stringify(where)}; exactly one must`,
          );
        const index = matches[0];
        const merged = clone(items[index]) as Where;
        for (const k of Object.keys(change)) if (change[k] !== undefined) merged[k] = clone(change[k]);
        const next = items.map((it, i) => (i === index ? merged : it));
        const problems = validateSubrecordArray(key, next);
        if (problems.length) throw subRefusal(`changing ${key} of player ${id} was refused: ${problems.join('; ')}`);
        const { row, tags } = itemRows(key, merged, index, id);
        if (st[key].update?.run(row).changes !== 1)
          throw new Error(`players.patchItem: the ${key} row of player ${id} at position ${index} is not in the table`);
        if (SUBRECORD_SPECS[key].children === 'tags' && Object.hasOwn(patch, 'tags')) {
          st.tags.deleteMedia.run(merged.id as string);
          for (const t of tags ?? []) st.tags.insert.run(t);
        }
        return deepFreeze(storedItem(key, merged));
      }),

    /** Aging-up: the PRIMARY link goes and `guardianId` becomes null, in one unit; co-guardians keep listing the player. */
    ageUp: (id: string): { playerId: string; guardianId: string } =>
      operation(() => {
        const p = playerRow(id);
        if (!p) throw noPlayer(id);
        if (p.guardian_id === null)
          throw refusal('NO_PRIMARY_GUARDIAN', `player ${id} has no primary guardian; nothing to age up`);
        links.unlink(p.guardian_id, id);
        return { playerId: id, guardianId: p.guardian_id };
      }),
    /**
     * The account deletion: the row stays, reduced to the retained record; the lists and links are deleted.
     * A retained id is refused. Sessions, codes and the media queue are the caller's acts in the same unit.
     */
    erase: (id: string, { at = now() }: { at?: number } = {}): { id: string; deletedAt: number } =>
      operation(() => {
        if (isRetainedId(id))
          throw refusal(
            'PLAYER_ID_RETAINED',
            `player ${id} was deleted and its id is retained; it cannot be erased again`,
          );
        const p = playerRow(id);
        if (!p) throw noPlayer(id);
        if (!isClock(at)) throw new TypeError('players.erase: `at` must be a non-negative integer timestamp (ms)');
        deleteChildRows(st, id);
        q('DELETE FROM guardian_children WHERE player_id = ?').run(id);
        if (
          q(ERASE_SQL).run(eraseParamsFor({ id, deletedAt: at, birthDate: p.birth_date, country: p.country }))
            .changes !== 1
        )
          throw noPlayer(id);
        return { id, deletedAt: at };
      }),
    link: (guardianId: string, playerId: string, role?: 'primary' | 'co'): Link =>
      links.link(guardianId, playerId, role),
    unlink: (guardianId: string, playerId: string): Link => links.unlink(guardianId, playerId),

    // ---------------------------------------------------------- reads
    byId: playerById,
    /** Many players by id, in the order given (missing ids are left out); their lists in one query per table. */
    byIds: (ids: readonly unknown[] | null | undefined): Player[] => {
      const list = [...new Set((ids ?? []).filter((x): x is string => typeof x === 'string' && !!x))];
      if (!list.length) return [];
      const rows = q(`${P_SELECT} WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`).all(
        JSON.stringify(list),
      ) as PlayerRow[];
      const byKey = new Map(decodePlayers(rows).map((r) => [r.id, r]));
      return list.map((x) => byKey.get(x)).filter((p): p is Player => !!p);
    },
    exists: (id: unknown): boolean => !!playerRow(id),
    /** The player whose media list holds this clip id (clip ids are unique across players), or null. */
    byMediaId: (mediaId: unknown): Player | null =>
      typeof mediaId === 'string' && mediaId
        ? playerById(
            (q('SELECT player_id FROM player_media WHERE id = ?').get(mediaId) as { player_id: string } | undefined)
              ?.player_id ?? null,
          )
        : null,
    /** Players whose PRIMARY guardian is this guardian. */
    byGuardian: (guardianId: string): Player[] =>
      decodePlayers(
        q(`${P_SELECT} WHERE guardian_id = ? AND deleted_at IS NULL ORDER BY rowid`).all(guardianId) as PlayerRow[],
      ),
    /** The first player (creation order) holding this provider's external id, or null (the import's identity match). */
    byExternalId: (provider: string, externalId: string): Player | null =>
      playerById(
        (
          q(
            'SELECT e.player_id FROM player_external_ids e JOIN players p ON p.id = e.player_id WHERE e.provider = ? AND e.external_id = ? ORDER BY p.rowid LIMIT 1',
          ).get(provider, externalId) as { player_id: string } | undefined
        )?.player_id ?? null,
      ),
    /** The first player (creation order) with this name (case-insensitive) and date of birth, or null. */
    byNameAndDob: (name: unknown, dob: unknown): Player | null => {
      if (typeof name !== 'string' || typeof dob !== 'string') return null;
      const key = name.toLowerCase();
      const hit = (
        q('SELECT id, name FROM players WHERE birth_date = ? AND deleted_at IS NULL ORDER BY rowid').all(dob) as {
          id: string;
          name: string;
        }[]
      ).find((r) => r.name.toLowerCase() === key);
      return hit ? playerById(hit.id) : null;
    },
    /** Visit the players a filter admits (see PlayerFilter), in creation order; `visit` returning false stops. */
    scan,
    /** The players a filter admits, in creation order (`limit` caps the count). */
    list: (filter: PlayerFilter = {}, { limit = Infinity }: { limit?: number } = {}): Player[] => {
      const out: Player[] = [];
      scan(filter, (r) => {
        out.push(r);
        return out.length < limit;
      });
      return out;
    },
    /** The live players the organisation may see (the whole visibility rule), with the further filters. */
    visibleCandidates: (org: ViewingOrgRecord, filter: PlayerFilter = {}, opts: { limit?: number } = {}): Player[] =>
      players.list({ ...filter, visibleTo: org }, opts),
    /**
     * The whole visibility rule for `org` as SQL over `players p` (the wall, the Grassroots radius, the blocks),
     * for a read that joins the players to another domain's rows (the match facts). `{ sql, args }`, or null when the
     * organisation can see nobody (a Grassroots club without a ground).
     */
    visibleWhere: (org: ViewingOrgRecord, at: number = now()): SqlWhere | null => scanWhere({ visibleTo: org }, at),
    /**
     * One page of the organisation's player directory, in the directory's declared order (directoryOrder), with
     * the scan filters plus `text`. `page` is `{ limit, after }` from readPage(query, directoryCursorShape(org)).
     */
    directoryPage: (org: ViewingOrgRecord, filter: PlayerFilter, page: PageRequest): Page<Player> => {
      const w = scanWhere({ ...filter, visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const order = directoryOrder(org);
      const out = pageOf(keysetRows(w, order, page), page.limit, keyOfRow(order.length));
      return { items: decodePlayers(out.items), nextCursor: out.nextCursor };
    },
    /**
     * One page of the players an organisation may see (the whole rule) in a caller's order: `order` as keysetRows takes
     * it (the last key unique), `where` further `{ sql, args }` conditions on `p`. Items are decoded.
     */
    visiblePage: (
      org: ViewingOrgRecord,
      filter: PlayerFilter,
      { order, where = [] }: { order: readonly OrderKey[]; where?: readonly { sql: string; args?: SQLInputValue[] }[] },
      page: PageRequest,
    ): Page<Player> & { keys?: unknown[][] } => {
      const w = scanWhere({ ...filter, visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      for (const c of where) {
        w.sql += ` AND (${c.sql})`;
        w.args.push(...(c.args ?? []));
      }
      const out = pageOf(keysetRows(w, order, page), page.limit, keyOfRow(order.length));
      return {
        items: decodePlayers(out.items),
        nextCursor: out.nextCursor,
        keys: out.items.map(keyOfRow(order.length)),
      };
    },
    /**
     * Visit the admitted players as LIGHT records, in creation order: the row's own fields (no lists, no trial
     * reports) plus `profileSignal`, for reads that rank every candidate and then decode only the winners (similar
     * players, the discovery rotation). `visit` returning false stops.
     */
    scanLight: (filter: PlayerFilter, visit: (p: LightPlayer) => unknown): void => {
      const w = scanWhere(filter);
      if (!w) return;
      let after = 0;
      for (;;) {
        const rows = q(
          `SELECT p.rowid AS rid, ${LIGHT_OF_P} FROM players p WHERE ${w.sql} AND p.rowid > ? ORDER BY p.rowid LIMIT ?`,
        ).all(...w.args, after, SCAN_BATCH * 10) as (LightRow & { rid: number })[];
        if (!rows.length) return;
        after = rows[rows.length - 1].rid;
        for (const d of rows) if (visit(lightFromRow(d)) === false) return;
        if (rows.length < SCAN_BATCH * 10) return;
      }
    },
    /**
     * The Film Room deck: one page of the playable clips (a url) of the players the organisation may see,
     * verified clips first, then the most viewed, then the player id and the clip's place in their list (player_media_deck).
     * Returns `{ items: [{ player, media }], nextCursor }`, the players decoded once per page.
     */
    clipPage: (org: ViewingOrgRecord, page: PageRequest): Page<{ player: Player; media: MediaItemOf<Player> }> => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const dirs = ['DESC', 'DESC', 'ASC', 'ASC'];
      // The leading key's bound is repeated so the index seeks to the page.
      const cols = ['(m.verified_clip_attendance_id IS NOT NULL)', 'm.views', 'm.player_id', 'm.position'];
      const after = page.after ?? null;
      const beyond = after
        ? ` AND ${cols[0]} <= ? AND (${dirs.map((_, i) => `(${[...cols.slice(0, i).map((c) => `${c} = ?`), `${cols[i]} ${dirs[i] === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`).join(' OR ')})`
        : '';
      const afterArgs = after ? [after[0], ...dirs.flatMap((_, i) => [...after.slice(0, i), after[i]])] : [];
      const rows =
        q(`SELECT m.player_id AS player_id, m.id AS media_id, ${cols.map((c, i) => `${c} AS k${i}`).join(', ')}
        FROM player_media m JOIN players p ON p.id = m.player_id WHERE m.url IS NOT NULL AND ${w.sql}${beyond}
        ORDER BY (m.verified_clip_attendance_id IS NOT NULL) DESC, m.views DESC, m.player_id, m.position LIMIT ?`).all(
          ...w.args,
          ...afterArgs,
          page.limit + 1,
        ) as { player_id: string; media_id: string; k0: number; k1: number; k2: string; k3: number }[];
      const out = pageOf(rows, page.limit, (r: (typeof rows)[number]) => [r.k0, r.k1, r.k2, r.k3]);
      const byPlayer = new Map(players.byIds(out.items.map((r) => r.player_id)).map((p) => [p.id, p]));
      const items: { player: Player; media: MediaItemOf<Player> }[] = [];
      for (const r of out.items) {
        const player = byPlayer.get(r.player_id);
        const media = player?.media.find((m) => m.id === r.media_id);
        if (player && media) items.push({ player, media });
      }
      return { items, nextCursor: out.nextCursor };
    },
    /**
     * The fixture graph: one page of the (fixture, date) groups of the attendances of the players the
     * organisation may see, the newest date first, then the fixture name. Each group lists its attendances in the
     * players' creation order (a player may appear twice), with the venue of the first. `{ items, nextCursor }`.
     */
    fixturePage: (org: ViewingOrgRecord, page: PageRequest): Page<FixtureGroup> => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const after = page.after ?? null;
      const beyond = after ? ' AND (a.match_date < ? OR (a.match_date = ? AND a.fixture > ?))' : '';
      const groups =
        q(`SELECT a.match_date AS date, a.fixture AS fixture FROM player_attendance a JOIN players p ON p.id = a.player_id
        WHERE ${w.sql}${beyond} GROUP BY a.match_date, a.fixture ORDER BY a.match_date DESC, a.fixture ASC LIMIT ?`).all(
          ...w.args,
          ...(after ? [after[0], after[0], after[1]] : []),
          page.limit + 1,
        ) as { date: string; fixture: string }[];
      const out = pageOf(groups, page.limit, (g: { date: string; fixture: string }) => [g.date, g.fixture]);
      if (!out.items.length) return { items: [], nextCursor: null };
      const members = q(`SELECT a.match_date AS date, a.fixture AS fixture, a.venue AS venue, ${LIGHT_OF_P}
        FROM json_each(?) j CROSS JOIN player_attendance a ON a.match_date = j.value ->> 0 AND a.fixture = j.value ->> 1 JOIN players p ON p.id = a.player_id
        WHERE ${w.sql} ORDER BY p.rowid, a.position`).all(
        JSON.stringify(out.items.map((g) => [g.date, g.fixture])),
        ...w.args,
      ) as (LightRow & { date: string; fixture: string; venue: string | null })[];
      const byKey = new Map<string, FixtureGroup>(
        out.items.map((g) => [
          `${g.fixture}|${g.date}`,
          { fixture: g.fixture, venue: undefined, date: g.date, players: [] },
        ]),
      );
      for (const m of members) {
        const g = byKey.get(`${m.fixture}|${m.date}`) as FixtureGroup;
        if (g.venue === undefined) g.venue = m.venue;
        g.players.push(lightFromRow(m));
      }
      return { items: [...byKey.values()], nextCursor: out.nextCursor };
    },
    /**
     * The club feed's player half: the admitted players created since `since` and the clips uploaded since
     * then, each newest first and at most `limit`.
     */
    recentFor: (
      org: ViewingOrgRecord,
      since: number,
      limit: number,
    ): { players: LightPlayer[]; clips: { player: Player; media: MediaItemOf<Player> }[] } => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { players: [], clips: [] };
      const fresh = (
        q(
          `SELECT ${LIGHT_OF_P} FROM players p WHERE ${w.sql} AND p.created_at >= ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
        ).all(...w.args, since, limit) as LightRow[]
      ).map(lightFromRow);
      const clipRows = q(`SELECT m.player_id, m.id AS media_id FROM player_media m JOIN players p ON p.id = m.player_id
        WHERE m.uploaded_at >= ? AND ${w.sql} ORDER BY m.uploaded_at DESC, m.rowid DESC LIMIT ?`).all(
        new Date(since).toISOString(),
        ...w.args,
        limit,
      ) as { player_id: string; media_id: string }[];
      const byPlayer = new Map(players.byIds(clipRows.map((r) => r.player_id)).map((p) => [p.id, p]));
      const clips: { player: Player; media: MediaItemOf<Player> }[] = [];
      for (const r of clipRows) {
        const player = byPlayer.get(r.player_id);
        const media = player?.media.find((m) => m.id === r.media_id);
        if (player && media) clips.push({ player, media });
      }
      return { players: fresh, clips };
    },
    /**
     * Every live player's best result per drill (the benchmarks' cohort), for the players a scan filter admits:
     * Map drill id → [{ playerId, max, min }]. One GROUP BY; no player is decoded.
     */
    drillBests: (filter: PlayerFilter = {}): Map<string, { playerId: string; max: number; min: number }[]> => {
      const w = scanWhere(filter);
      const out = new Map<string, { playerId: string; max: number; min: number }[]>();
      if (!w) return out;
      for (const r of q(
        `SELECT d.drill_id, d.player_id, MAX(d.value) AS max, MIN(d.value) AS min FROM player_drill_results d JOIN players p ON p.id = d.player_id WHERE ${w.sql} GROUP BY d.drill_id, d.player_id ORDER BY d.drill_id, p.rowid`,
      ).all(...w.args) as { drill_id: string; player_id: string; max: number; min: number }[]) {
        let list = out.get(r.drill_id);
        if (!list) out.set(r.drill_id, (list = []));
        list.push({ playerId: r.player_id, max: r.max, min: r.min });
      }
      return out;
    },
    /** The cursor's key types for the directory's order (readPage). */
    directoryCursorShape: (org: ViewingOrgRecord): ('string' | 'number')[] =>
      directoryOrder(org).map((_, i, all) => (i === all.length - 1 ? 'string' : 'number')),
    count: (): number => countOf('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NULL'),
    /** The stored password hash for the sign-in check (never on a record), or null. */
    passwordHashOf: (id: string): string | null =>
      (
        q('SELECT password_hash FROM players WHERE id = ? AND deleted_at IS NULL').get(id) as
          | { password_hash: string | null }
          | undefined
      )?.password_hash ?? null,
    /** Rows per list table (counts only), for reports. */
    subrecordRows: () => countChildRows(st),
    /** The narrow accessors of the retained records. No route serves one. */
    retained: (id: unknown): RetainedPlayer | null => {
      const r =
        typeof id === 'string'
          ? (q(`${RETAINED_SELECT} WHERE id = ? AND deleted_at IS NOT NULL`).get(id) as PlayerRow | undefined)
          : undefined;
      return r ? retainedRecordFromRow(r) : null;
    },
    isRetained: (id: unknown): boolean => isRetainedId(id),
    retainedRecords: (): RetainedPlayer[] =>
      (q(`${RETAINED_SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id`).all() as PlayerRow[]).map(
        retainedRecordFromRow,
      ),
    retainedCount: (): number => countOf('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NOT NULL'),
  };
  return players;
}
/** A clip of a player record. */
type MediaItemOf<P extends Player> = P['media'][number];
/** One (fixture, date) group of the fixture graph. */
export type FixtureGroup = { fixture: string; venue: string | null | undefined; date: string; players: LightPlayer[] };
