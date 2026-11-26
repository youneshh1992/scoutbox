/**
 * The player record: its values, its shape, the checks an incoming one passes, and how it maps to the `players` row.
 * The repository is players.ts.
 *
 * Player record (every key always present):
 *   { id, name, dob, country, city, position, foot, heightCm, weightKg, squadNumber, contractUntil, marketValueRange,
 *     agentName, academyPlus, firstTeamSeeker, availability, contractStatus, level, footballCategory, identityVerified,
 *     guardianId, createdAt,
 *     location: null | { lat, lng },
 *     stats: null | { appearances, goals, assists, paceKmh, passCompletionPct, duelSuccessPct, cleanSheets },
 *     medical: { shared, conditionStatus, records: [...] },
 *     notificationPrefs: null | { quietStart, quietEnd, schoolHoursMute, timezone },
 *     programme: null | { track, startedAt, completed: [...] },
 *     media, attendance, timeline, badges, drills, drillResults, activityLog, externalIds, seasonHistory,
 *     trialReports }
 * The lists are rows of the `player_*` tables (playerSubrecords.ts); `trialReports` is the trials' reports (the
 * recruitment tables), written nowhere here.
 *
 * The retained record (the full birth date and the country code are kept: Founder's decisions, docs/decisions.md):
 * an account deletion keeps the player's row reduced to its id, the deletion instant, the birth date and the country,
 * with fixed placeholders in the other required columns.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrationApplied } from './database.ts';
import { parseStrictDateOnly } from '../temporal.ts';
import { computeTrustScore, type LatLng } from '../domain.ts';
import type { DeepReadonly } from '../domains/platform/values.ts';
import {
  PLAYER_SUBRECORD_KEYS,
  validateSubrecordArray,
  type PlayerLists,
  type PlayerListKey,
  type SubrecordInputs,
  type MedicalRecordItem,
  type ProgrammeCompletionItem,
} from './playerSubrecords.ts';
import {
  IDENTITY_LIMITS as L,
  isPlainObject,
  isClock,
  describe,
  textOk,
  optTextOk,
  intIn,
  given,
  allNull,
  b,
  prefsWithDefaults,
  recordPrefsProblems,
  prefsFromRow,
  prefsParams,
  type NotificationPrefs,
} from './identityRules.ts';

export const PLAYER_ERASURE_MIGRATION = '0014_player_erasure';
/** The collection the retained records are read back in (never inside `players`). */
export const PLAYERS_RETAINED_COLLECTION = 'playersRetained';
export const RETAINED_PLAYER_NAME = 'Deleted player';

export const PLAYER_POSITIONS = Object.freeze([
  'GK',
  'CB',
  'RB',
  'LB',
  'RWB',
  'LWB',
  'CDM',
  'CM',
  'CAM',
  'RW',
  'LW',
  'ST',
  'CF',
] as const);
export const PLAYER_FEET = Object.freeze(['left', 'right'] as const);
export const PLAYER_AVAILABILITY = Object.freeze([
  'available_now',
  'end_of_season',
  'loan_open',
  'overseas_open',
  'not_seeking',
] as const);
export const PLAYER_CONTRACT_STATUS = Object.freeze([
  'under_contract',
  'expiring_summer',
  'scholarship_ending',
  'release_approaching',
  'free_agent',
  'unknown',
] as const);
export const PLAYER_LEVELS = Object.freeze(['amateur', 'semi_pro', 'pro'] as const);
export type PlayerPosition = (typeof PLAYER_POSITIONS)[number];
export type PlayerFoot = (typeof PLAYER_FEET)[number];
export type PlayerAvailability = (typeof PLAYER_AVAILABILITY)[number];
export type PlayerContractStatus = (typeof PLAYER_CONTRACT_STATUS)[number];
export type PlayerLevel = (typeof PLAYER_LEVELS)[number];
const oneOf = <T extends string>(xs: readonly T[], v: unknown): v is T => (xs as readonly unknown[]).includes(v);

// ------------------------------------------------------------------ the record's type
/** The current season's figures. The counts are whole numbers, the percentages 0–100. */
export type PlayerStats = {
  appearances: number | null;
  goals: number | null;
  assists: number | null;
  paceKmh: number | null;
  passCompletionPct: number | null;
  duelSuccessPct: number | null;
  cleanSheets: number | null;
};
/** A filed trial report naming the player, as the recruitment repository reads it. */
export type PlayerTrialReport = {
  id: string;
  trialId: string;
  playerId: string;
  orgId: string;
  orgName: string | null;
  userId: string | null;
  scoutName: string | null;
  filedAt: number;
  acceleration: number;
  sprintSpeedKmh: number;
  distanceKm: number;
  passCompletionPct: number;
  duelSuccessPct: number;
  coachRating: number;
  notes: string | null;
  strengthNote: string | null;
  focusNote: string | null;
};
type PlayerFields = {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  dob: string;
  country: string;
  city: string | null;
  position: PlayerPosition | null;
  foot: PlayerFoot | null;
  heightCm: number | null;
  weightKg: number | null;
  squadNumber: number | null;
  /** YYYY-MM-DD */
  contractUntil: string | null;
  marketValueRange: string | null;
  agentName: string | null;
  academyPlus: boolean;
  firstTeamSeeker: boolean;
  availability: PlayerAvailability;
  contractStatus: PlayerContractStatus;
  level: PlayerLevel;
  footballCategory: string | null;
  identityVerified: boolean;
  /** The primary guardian; a minor always has one. */
  guardianId: string | null;
  createdAt: number | null;
  location: LatLng | null;
  stats: PlayerStats | null;
  medical: { shared: boolean; conditionStatus: string; records: MedicalRecordItem[] };
  notificationPrefs: NotificationPrefs | null;
  programme: { track: string | null; startedAt: number | null; completed: ProgrammeCompletionItem[] } | null;
};
/** A player as written: the record without the trials' reports. */
export type PlayerDraft = PlayerFields & Omit<PlayerLists, 'medical' | 'programme'>;
/** A player as the repository reads it back, frozen at every level. */
export type Player = DeepReadonly<PlayerDraft & { trialReports: PlayerTrialReport[] }>;

type Nullable<T> = { [K in keyof T]?: T[K] | null };
/**
 * A new player as `players.create` and the seed take it: the identity fields, and any others (absent ones take their
 * defaults). The lists are given whole; `medical`, `programme`, `stats` and `notificationPrefs` may leave fields out.
 */
export type PlayerInput = Pick<PlayerFields, 'id' | 'name' | 'dob' | 'country'> &
  Partial<
    Omit<PlayerFields, 'id' | 'name' | 'dob' | 'country' | 'medical' | 'programme' | 'stats' | 'notificationPrefs'>
  > & {
    medical?: {
      shared?: boolean;
      conditionStatus?: string;
      records?: readonly SubrecordInputs['medical.records'][];
    } | null;
    programme?: {
      track?: string | null;
      startedAt?: number | null;
      completed?: readonly SubrecordInputs['programme.completed'][];
    } | null;
    stats?: Nullable<PlayerStats> | null;
    notificationPrefs?: Nullable<NotificationPrefs> | null;
  } & { [K in PlayerListKey]?: readonly SubrecordInputs[K][] | null };

/** A player's own facts without the lists (scanLight, the fixture graph, the feed), with the directory's `profileSignal`. */
export type LightPlayer = Readonly<{
  id: string;
  name: string;
  dob: string;
  country: string;
  city: string | null;
  position: PlayerPosition | null;
  foot: PlayerFoot | null;
  heightCm: number | null;
  weightKg: number | null;
  level: PlayerLevel;
  availability: PlayerAvailability;
  academyPlus: boolean;
  firstTeamSeeker: boolean;
  footballCategory: string | null;
  identityVerified: boolean;
  location: Readonly<LatLng> | null;
  createdAt: number | null;
  profileSignal: number;
  stats: Readonly<PlayerStats> | null;
  light: true;
}>;

// ------------------------------------------------------------------ the record's keys and defaults
const PLAYER_SCALAR_KEYS = Object.freeze([
  'id',
  'name',
  'dob',
  'country',
  'city',
  'position',
  'foot',
  'heightCm',
  'weightKg',
  'squadNumber',
  'contractUntil',
  'marketValueRange',
  'agentName',
  'academyPlus',
  'firstTeamSeeker',
  'availability',
  'contractStatus',
  'level',
  'footballCategory',
  'identityVerified',
  'guardianId',
  'createdAt',
] as const);
export const STATS_KEYS = Object.freeze([
  'appearances',
  'goals',
  'assists',
  'paceKmh',
  'passCompletionPct',
  'duelSuccessPct',
  'cleanSheets',
] as const);
export type StatsKey = (typeof STATS_KEYS)[number];
const STATS_COUNTS: readonly StatsKey[] = Object.freeze(['appearances', 'goals', 'assists', 'cleanSheets']);
export const STATS_COLUMN: Readonly<Record<StatsKey, string>> = Object.freeze({
  appearances: 'stats_appearances',
  goals: 'stats_goals',
  assists: 'stats_assists',
  paceKmh: 'stats_pace_kmh',
  passCompletionPct: 'stats_pass_completion_pct',
  duelSuccessPct: 'stats_duel_success_pct',
  cleanSheets: 'stats_clean_sheets',
});
export const isStatsKey = (k: string): k is StatsKey => (STATS_KEYS as readonly string[]).includes(k);
export const PLAYER_RECORD_KEYS: readonly string[] = Object.freeze([
  ...PLAYER_SCALAR_KEYS,
  'location',
  'stats',
  'medical',
  'notificationPrefs',
  'programme',
  ...PLAYER_SUBRECORD_KEYS,
  'trialReports',
]);
const PLAYER_BOOLEANS = Object.freeze(['academyPlus', 'firstTeamSeeker', 'identityVerified'] as const);
const PLAYER_DEFAULTS = Object.freeze({
  city: null,
  position: null,
  foot: null,
  heightCm: null,
  weightKg: null,
  squadNumber: null,
  contractUntil: null,
  marketValueRange: null,
  agentName: null,
  academyPlus: false,
  firstTeamSeeker: false,
  availability: 'not_seeking',
  contractStatus: 'unknown',
  level: 'amateur',
  footballCategory: null,
  identityVerified: false,
  guardianId: null,
  createdAt: null,
  location: null,
  stats: null,
  notificationPrefs: null,
  programme: null,
});

/**
 * An incoming player (create, the seed) with its defaults: every field present, the lists as given (or empty). Not yet
 * checked: `playerRecordProblems` decides whether it is a `PlayerDraft`.
 */
export function playerWithDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const g = given(raw);
  const r: Record<string, unknown> = { ...PLAYER_DEFAULTS, ...g };
  if (r.city === '') r.city = null;
  r.medical = isPlainObject(g.medical)
    ? { shared: false, conditionStatus: 'unknown', records: [], ...given(g.medical) }
    : g.medical === undefined || g.medical === null
      ? { shared: false, conditionStatus: 'unknown', records: [] }
      : g.medical;
  if (isPlainObject(r.programme)) r.programme = { track: null, startedAt: null, completed: [], ...given(r.programme) };
  if (isPlainObject(r.stats)) {
    const s = r.stats;
    r.stats = {
      ...Object.fromEntries(STATS_KEYS.map((k) => [k, s[k] === undefined ? null : s[k]])),
      ...Object.fromEntries(Object.entries(s).filter(([k]) => !isStatsKey(k))),
    };
  }
  if (isPlainObject(r.notificationPrefs)) r.notificationPrefs = prefsWithDefaults(r.notificationPrefs);
  for (const k of PLAYER_SUBRECORD_KEYS) if (r[k] === undefined || r[k] === null) r[k] = [];
  // The trials own the reports: an incoming record may carry none (null or an empty list is no claim and is not kept).
  if (r.trialReports === null || (Array.isArray(r.trialReports) && r.trialReports.length === 0)) delete r.trialReports;
  return Object.fromEntries([
    ...PLAYER_RECORD_KEYS.filter((k) => k !== 'trialReports').map((k) => [k, r[k]]),
    ...Object.entries(r).filter(([k]) => !PLAYER_RECORD_KEYS.includes(k) || k === 'trialReports'),
  ]);
}

/** The problems with a player record (an incoming one after its defaults, or a draft), by field; never a value. */
export function playerRecordProblems(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(r)) {
    if (k === 'trialReports') out.push("trialReports are the trials' reports and are not written with a player");
    else if (!PLAYER_RECORD_KEYS.includes(k)) out.push(`unknown field ${k}`);
  }
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters`);
  if (typeof r.dob !== 'string' || !parseStrictDateOnly(r.dob).ok) out.push('dob must be a YYYY-MM-DD date');
  if (!textOk(r.country, L.country)) out.push(`country must be text of 1 to ${L.country} characters`);
  if (!optTextOk(r.city, L.city)) out.push(`city must be text of 1 to ${L.city} characters or null`);
  if (r.position !== null && !oneOf(PLAYER_POSITIONS, r.position))
    out.push(`position must be one of ${PLAYER_POSITIONS.join(', ')} or null`);
  if (r.foot !== null && !oneOf(PLAYER_FEET, r.foot)) out.push(`foot must be one of ${PLAYER_FEET.join(', ')} or null`);
  for (const k of ['heightCm', 'weightKg', 'squadNumber'] as const)
    if (r[k] !== null && !intIn(r[k], L[k]))
      out.push(`${k} must be a whole number from ${L[k][0]} to ${L[k][1]} or null`);
  if (r.contractUntil !== null && (typeof r.contractUntil !== 'string' || !parseStrictDateOnly(r.contractUntil).ok))
    out.push('contractUntil must be a YYYY-MM-DD date or null');
  for (const k of ['marketValueRange', 'agentName', 'footballCategory'] as const)
    if (!optTextOk(r[k], L[k])) out.push(`${k} must be text of 1 to ${L[k]} characters or null`);
  for (const k of PLAYER_BOOLEANS) if (typeof r[k] !== 'boolean') out.push(`${k} must be a boolean`);
  if (!oneOf(PLAYER_AVAILABILITY, r.availability))
    out.push(`availability must be one of ${PLAYER_AVAILABILITY.join(', ')}`);
  if (!oneOf(PLAYER_CONTRACT_STATUS, r.contractStatus))
    out.push(`contractStatus must be one of ${PLAYER_CONTRACT_STATUS.join(', ')}`);
  if (!oneOf(PLAYER_LEVELS, r.level)) out.push(`level must be one of ${PLAYER_LEVELS.join(', ')}`);
  if (r.guardianId !== null && !textOk(r.guardianId, L.id)) out.push('guardianId must be a guardian id or null');
  if (r.createdAt !== null && !isClock(r.createdAt)) out.push('createdAt must be an integer timestamp or null');
  if (r.location !== null) {
    const loc = r.location;
    if (!isPlainObject(loc) || Object.keys(loc).some((k) => k !== 'lat' && k !== 'lng'))
      out.push(`location must be { lat, lng } or null (got ${describe(loc)})`);
    else if (!(isLatitude(loc.lat) && isLongitude(loc.lng)))
      out.push('location.lat and location.lng must be a latitude (-90 to 90) and a longitude (-180 to 180)');
  }
  if (r.stats !== null) {
    const s = r.stats;
    if (!isPlainObject(s)) out.push(`stats must be an object or null (got ${describe(s)})`);
    else {
      for (const k of Object.keys(s)) if (!isStatsKey(k)) out.push(`stats.${k} is not a stat`);
      for (const k of STATS_KEYS) {
        const v = s[k];
        if (v === null) continue;
        const count = STATS_COUNTS.includes(k);
        if (count ? !(Number.isSafeInteger(v) && (v as number) >= 0) : !(Number.isFinite(v) && (v as number) >= 0))
          out.push(`stats.${k} must be a non-negative ${count ? 'whole number' : 'number'} or null`);
        else if ((k === 'passCompletionPct' || k === 'duelSuccessPct') && (v as number) > 100)
          out.push(`stats.${k} must be a percentage from 0 to 100`);
      }
    }
  }
  const m = r.medical;
  if (!isPlainObject(m) || Object.keys(m).some((k) => !['shared', 'conditionStatus', 'records'].includes(k)))
    out.push(`medical must be { shared, conditionStatus, records } (got ${describe(m)})`);
  else {
    if (typeof m.shared !== 'boolean') out.push('medical.shared must be a boolean');
    if (!textOk(m.conditionStatus, L.conditionStatus))
      out.push(`medical.conditionStatus must be text of 1 to ${L.conditionStatus} characters`);
    out.push(...validateSubrecordArray('medical.records', m.records));
    if (!Array.isArray(m.records)) out.push('medical.records must be a list');
  }
  out.push(...recordPrefsProblems(r.notificationPrefs));
  if (r.programme !== null) {
    const p = r.programme;
    if (!isPlainObject(p) || Object.keys(p).some((k) => !['track', 'startedAt', 'completed'].includes(k)))
      out.push(`programme must be { track, startedAt, completed } or null (got ${describe(p)})`);
    else {
      if (!optTextOk(p.track, L.programmeTrack))
        out.push(`programme.track must be text of 1 to ${L.programmeTrack} characters or null`);
      if (p.startedAt !== null && !isClock(p.startedAt))
        out.push('programme.startedAt must be an integer timestamp or null');
      if (!Array.isArray(p.completed)) out.push('programme.completed must be a list');
      else out.push(...validateSubrecordArray('programme.completed', p.completed));
    }
  }
  for (const k of PLAYER_SUBRECORD_KEYS) {
    if (!Array.isArray(r[k])) out.push(`${k} must be a list`);
    else out.push(...validateSubrecordArray(k, r[k]));
  }
  return out;
}
const isLatitude = (v: unknown): v is number => Number.isFinite(v) && Math.abs(v as number) <= 90;
const isLongitude = (v: unknown): v is number => Number.isFinite(v) && Math.abs(v as number) <= 180;

// ------------------------------------------------------------------ the row
const P_COLS = [
  'id',
  'name',
  'birth_date',
  'country',
  'city',
  'position',
  'foot',
  'height_cm',
  'weight_kg',
  'squad_number',
  'contract_until_date',
  'market_value_range',
  'agent_name',
  'academy_plus',
  'first_team_seeker',
  'availability',
  'contract_status',
  'level',
  'football_category',
  'identity_verified',
  'guardian_id',
  'lat',
  'lng',
  'stats_appearances',
  'stats_goals',
  'stats_assists',
  'stats_pace_kmh',
  'stats_pass_completion_pct',
  'stats_duel_success_pct',
  'stats_clean_sheets',
  'medical_shared',
  'medical_condition_status',
  'prefs_quiet_start',
  'prefs_quiet_end',
  'prefs_school_hours_mute',
  'prefs_timezone',
  'programme_track',
  'programme_started_at',
  'password_hash',
  'profile_signal',
  'created_at',
  'deleted_at',
] as const;
export type PlayerColumn = (typeof P_COLS)[number];
export const PLAYER_COLUMNS: readonly PlayerColumn[] = Object.freeze(P_COLS);
/** A `players` row as SQLite reads it (the table's CHECKs and STRICT types guarantee these). */
export type PlayerRow = {
  id: string;
  name: string;
  birth_date: string;
  country: string;
  city: string | null;
  position: PlayerPosition | null;
  foot: PlayerFoot | null;
  height_cm: number | null;
  weight_kg: number | null;
  squad_number: number | null;
  contract_until_date: string | null;
  market_value_range: string | null;
  agent_name: string | null;
  academy_plus: 0 | 1;
  first_team_seeker: 0 | 1;
  availability: PlayerAvailability;
  contract_status: PlayerContractStatus;
  level: PlayerLevel;
  football_category: string | null;
  identity_verified: 0 | 1;
  guardian_id: string | null;
  lat: number | null;
  lng: number | null;
  stats_appearances: number | null;
  stats_goals: number | null;
  stats_assists: number | null;
  stats_pace_kmh: number | null;
  stats_pass_completion_pct: number | null;
  stats_duel_success_pct: number | null;
  stats_clean_sheets: number | null;
  medical_shared: 0 | 1;
  medical_condition_status: string;
  prefs_quiet_start: string | null;
  prefs_quiet_end: string | null;
  prefs_school_hours_mute: 0 | 1 | null;
  prefs_timezone: string | null;
  programme_track: string | null;
  programme_started_at: number | null;
  password_hash: string | null;
  profile_signal: number;
  created_at: number | null;
  deleted_at: number | null;
};
export const P_SELECT = `SELECT ${P_COLS.join(', ')} FROM players`;
export const P_INSERT = `INSERT INTO players (${P_COLS.join(', ')}) VALUES (${P_COLS.map((c) => `@${c}`).join(', ')})`;

/** A live player's row, or null. */
export const livePlayerRow = (q: (sql: string) => StatementSync, id: unknown): PlayerRow | null =>
  typeof id === 'string' && id
    ? ((q(`${P_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as PlayerRow | undefined) ?? null)
    : null;

export function playerParams(r: PlayerDraft, passwordHash: string | null = null): PlayerRow {
  const s: Partial<PlayerStats> = r.stats ?? {};
  return {
    id: r.id,
    name: r.name,
    birth_date: r.dob,
    country: r.country,
    city: r.city,
    position: r.position,
    foot: r.foot,
    height_cm: r.heightCm,
    weight_kg: r.weightKg,
    squad_number: r.squadNumber,
    contract_until_date: r.contractUntil,
    market_value_range: r.marketValueRange,
    agent_name: r.agentName,
    academy_plus: b(r.academyPlus),
    first_team_seeker: b(r.firstTeamSeeker),
    availability: r.availability,
    contract_status: r.contractStatus,
    level: r.level,
    football_category: r.footballCategory,
    identity_verified: b(r.identityVerified),
    guardian_id: r.guardianId,
    lat: r.location?.lat ?? null,
    lng: r.location?.lng ?? null,
    stats_appearances: s.appearances ?? null,
    stats_goals: s.goals ?? null,
    stats_assists: s.assists ?? null,
    stats_pace_kmh: s.paceKmh ?? null,
    stats_pass_completion_pct: s.passCompletionPct ?? null,
    stats_duel_success_pct: s.duelSuccessPct ?? null,
    stats_clean_sheets: s.cleanSheets ?? null,
    medical_shared: b(r.medical.shared),
    medical_condition_status: r.medical.conditionStatus,
    ...prefsParams(r.notificationPrefs),
    programme_track: r.programme?.track ?? null,
    programme_started_at: r.programme?.startedAt ?? null,
    password_hash: passwordHash,
    // A new row has no trial reports yet (the trials name it later and refresh the figure); refreshProfileSignals keeps it after.
    profile_signal: computeTrustScore({ ...r, trialReports: [] }),
    created_at: r.createdAt,
    deleted_at: null,
  };
}
type StatsColumns = Pick<
  PlayerRow,
  | 'stats_appearances'
  | 'stats_goals'
  | 'stats_assists'
  | 'stats_pace_kmh'
  | 'stats_pass_completion_pct'
  | 'stats_duel_success_pct'
  | 'stats_clean_sheets'
>;
/** The stats a row's `stats_*` columns hold; null when every one is NULL. */
const statsFromRow = (d: StatsColumns): PlayerStats | null =>
  allNull(
    d.stats_appearances,
    d.stats_goals,
    d.stats_assists,
    d.stats_pace_kmh,
    d.stats_pass_completion_pct,
    d.stats_duel_success_pct,
    d.stats_clean_sheets,
  )
    ? null
    : {
        appearances: d.stats_appearances,
        goals: d.stats_goals,
        assists: d.stats_assists,
        paceKmh: d.stats_pace_kmh,
        passCompletionPct: d.stats_pass_completion_pct,
        duelSuccessPct: d.stats_duel_success_pct,
        cleanSheets: d.stats_clean_sheets,
      };
/** The record for a live row, its lists and its trial reports (plain; the repository freezes what it hands out). A stats, prefs or programme block whose columns are all NULL is null. */
export function playerFromDb(
  d: PlayerRow,
  children: PlayerLists,
  trialReports: PlayerTrialReport[],
): PlayerDraft & { trialReports: PlayerTrialReport[] } {
  const programmed = !allNull(d.programme_track, d.programme_started_at) || children.programme.completed.length > 0;
  return {
    id: d.id,
    name: d.name,
    dob: d.birth_date,
    country: d.country,
    city: d.city,
    position: d.position,
    foot: d.foot,
    heightCm: d.height_cm,
    weightKg: d.weight_kg,
    squadNumber: d.squad_number,
    contractUntil: d.contract_until_date,
    marketValueRange: d.market_value_range,
    agentName: d.agent_name,
    academyPlus: d.academy_plus === 1,
    firstTeamSeeker: d.first_team_seeker === 1,
    availability: d.availability,
    contractStatus: d.contract_status,
    level: d.level,
    footballCategory: d.football_category,
    identityVerified: d.identity_verified === 1,
    guardianId: d.guardian_id,
    createdAt: d.created_at,
    location: d.lat === null || d.lng === null ? null : { lat: d.lat, lng: d.lng },
    stats: statsFromRow(d),
    medical: {
      shared: d.medical_shared === 1,
      conditionStatus: d.medical_condition_status,
      records: children.medical.records,
    },
    notificationPrefs: prefsFromRow(d),
    programme: programmed
      ? { track: d.programme_track, startedAt: d.programme_started_at, completed: children.programme.completed }
      : null,
    media: children.media,
    attendance: children.attendance,
    timeline: children.timeline,
    badges: children.badges,
    drills: children.drills,
    drillResults: children.drillResults,
    activityLog: children.activityLog,
    externalIds: children.externalIds,
    seasonHistory: children.seasonHistory,
    trialReports,
  };
}

/** The columns of a light record (scanLight, the fixture graph, the feed): the row's own facts, no lists. */
export const LIGHT_COLS = [
  'id',
  'name',
  'birth_date',
  'country',
  'city',
  'position',
  'foot',
  'height_cm',
  'weight_kg',
  'level',
  'availability',
  'academy_plus',
  'first_team_seeker',
  'football_category',
  'identity_verified',
  'lat',
  'lng',
  'created_at',
  'profile_signal',
  'stats_appearances',
  'stats_goals',
  'stats_assists',
  'stats_pace_kmh',
  'stats_pass_completion_pct',
  'stats_duel_success_pct',
  'stats_clean_sheets',
] as const satisfies readonly PlayerColumn[];
export type LightRow = Pick<PlayerRow, (typeof LIGHT_COLS)[number]>;
/** A light record: a player's own fields as the full record names them, `profileSignal`, and no lists (they are absent, not empty). */
export function lightFromRow(d: LightRow): LightPlayer {
  const stats = statsFromRow(d);
  return Object.freeze({
    id: d.id,
    name: d.name,
    dob: d.birth_date,
    country: d.country,
    city: d.city,
    position: d.position,
    foot: d.foot,
    heightCm: d.height_cm,
    weightKg: d.weight_kg,
    level: d.level,
    availability: d.availability,
    academyPlus: d.academy_plus === 1,
    firstTeamSeeker: d.first_team_seeker === 1,
    footballCategory: d.football_category,
    identityVerified: d.identity_verified === 1,
    location: d.lat === null || d.lng === null ? null : Object.freeze({ lat: d.lat, lng: d.lng }),
    createdAt: d.created_at,
    profileSignal: d.profile_signal,
    stats: stats && Object.freeze(stats),
    light: true,
  });
}

// ------------------------------------------------------------------ the retained record
/** What an account deletion keeps of a player. */
export type RetainedPlayer = { id: string; deletedAt: number; birthDate: string; country: string };
/** The fixed storage placeholders of a retained row: constants the table's constraints need, never read back as facts about the person. */
const RETAINED_PLACEHOLDERS = Object.freeze({
  name: RETAINED_PLAYER_NAME,
  profile_signal: 0,
  academy_plus: 0,
  first_team_seeker: 0,
  availability: 'not_seeking',
  contract_status: 'unknown',
  level: 'amateur',
  identity_verified: 0,
  medical_shared: 0,
  medical_condition_status: 'unknown',
} as const);
/** A retained record → the full row (the kept facts, the placeholders, NULL elsewhere). */
export function retainedRowFor(rec: RetainedPlayer): Record<PlayerColumn, string | number | null> {
  const p = Object.fromEntries(P_COLS.map((c) => [c, null])) as Record<PlayerColumn, string | number | null>;
  p.id = rec.id;
  p.birth_date = rec.birthDate;
  p.country = rec.country;
  p.deleted_at = rec.deletedAt;
  return Object.assign(p, RETAINED_PLACEHOLDERS);
}
export const RETAINED_SELECT = 'SELECT id, deleted_at, birth_date, country FROM players';
export const retainedRecordFromRow = (r: Pick<PlayerRow, 'id' | 'deleted_at' | 'birth_date' | 'country'>) =>
  ({
    id: r.id,
    deletedAt: r.deleted_at,
    birthDate: r.birth_date,
    country: r.country,
  }) as RetainedPlayer;
/** The retained records, read back (the test suites' read-back). */
export const PLAYERS_RETAINED = {
  name: PLAYERS_RETAINED_COLLECTION,
  cutOver: (sqlite: DatabaseSync) => migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION),
  read(sqlite: DatabaseSync): RetainedPlayer[] | null {
    if (!this.cutOver(sqlite)) return null;
    return (
      sqlite.prepare(`${RETAINED_SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id`).all() as PlayerRow[]
    ).map(retainedRecordFromRow);
  },
};
const ERASE_COLUMNS = Object.freeze(P_COLS.filter((c) => !['id', 'birth_date', 'country'].includes(c)));
export const ERASE_SQL = `UPDATE players SET ${ERASE_COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND deleted_at IS NULL`;
export const eraseParamsFor = (rec: RetainedPlayer): Record<string, string | number | null> => {
  const full = retainedRowFor(rec);
  const p: Record<string, string | number | null> = { id: rec.id };
  for (const c of ERASE_COLUMNS) p[c] = full[c];
  return p;
};
