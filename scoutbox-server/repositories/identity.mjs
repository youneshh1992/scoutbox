/**
 * Players and guardians (`players`, `guardians`, `guardian_children`; the players' lists are playerSubrecords.mjs).
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
 * A player's columns change only through the named acts (`setAvailability`, `recordStats`, …). The lists are rows of the
 * `player_*` tables (playerSubrecords.mjs), written only through `addItem`, `setItems` and `patchItem`; `trialReports` is the trials' reports (the recruitment tables), written nowhere here.
 *
 * Guardian record: { id, name, email, emailVerified, idVerified, idvReference, disclaimerAccepted, disclaimerAcceptedAt,
 *   coGuardianOf, notificationPrefs, createdAt, childIds, coGuardians }
 * `childIds` is the guardian's link rows (in their order); `coGuardians` is the guardians whose `co_guardian_of` names
 * this one, as `{ id, name, email }`.
 *
 * Password and e-mail-code hashes are never on a record (`passwordHashOf`, `setPasswordHash`, `emailCodeHashOf`,
 * `setEmailCodeHash`). Responses are allowlists. Refusals carry a code and name the id and the field, never a value.
 *
 * Relationships. `players.guardian_id` and the `primary` row of `guardian_children` are written together and cannot
 * disagree; a minor is created with its primary link in the same transaction (an unlinked child cannot be created);
 * a guardian's e-mail is unique case-insensitively. `ageUp` clears the primary link only (co-guardians keep listing
 * the player).
 *
 * The retained record (the full birth date and the country code are kept: Founder's decisions, docs/decisions.md):
 * an account deletion keeps the player's row reduced to its id, the deletion instant, the
 * birth date and the country, with fixed placeholders in the other required columns; its lists and links are deleted
 * in the same unit. A retained row is served by nothing that serves accounts, only by the `retained*` accessors, and
 * its id is never created again. Not a retention policy.
 *
 * A first installation's players and guardians (the seed) are imported once by `initialize`, while
 * `meta.coreIdentityInit` is `pending` (set by the migration).
 */
import { transaction, migrationApplied } from './database.mjs';
import { isConstraintError } from './writes.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { isAdult, ADULT_AGE, GRASSROOTS_RADIUS_KM, TRUST, computeTrustScore, trustScoreFromFacts, haversineKm } from '../domain.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { boxAround } from './grassroots.mjs';
import { SUBRECORD_KEYS, SUBRECORD_SPECS, PLAYER_SUBRECORD_KEYS, subrecordsLive, getSubrecords, validateSubrecordArray, prepareSubrecordStatements, writeChildRows, writeArrayRows, deleteChildRows, readChildren, readChildrenFor, countChildRows, itemRows, storedItem, PLAYER_SUBRECORDS_MIGRATION } from './playerSubrecords.mjs';

export const CORE_IDENTITY_LIVE_MIGRATION = '0005_core_identity_live';
export const PLAYER_ERASURE_MIGRATION = '0014_player_erasure';
/** `meta` key holding the initialisation state (`pending` | `done`); absent reads as `done`. */
export const CORE_IDENTITY_INIT_META = 'coreIdentityInit';
/** The two collections the identity repositories own; coupled through the link rows. */
export const IDENTITY_COLLECTIONS = Object.freeze(['players', 'guardians']);
/** The collection the retained records are read back in (never inside `players`). */
export const PLAYERS_RETAINED_COLLECTION = 'playersRetained';
export const RETAINED_PLAYER_NAME = 'Deleted player';

export const PLAYER_POSITIONS = Object.freeze(['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF']);
export const PLAYER_FEET = Object.freeze(['left', 'right']);
export const PLAYER_AVAILABILITY = Object.freeze(['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking']);
export const PLAYER_CONTRACT_STATUS = Object.freeze(['under_contract', 'expiring_summer', 'scholarship_ending', 'release_approaching', 'free_agent', 'unknown']);
export const PLAYER_LEVELS = Object.freeze(['amateur', 'semi_pro', 'pro']);
/** Text lengths and number ranges, one definition for the typing, the DDL and the routes. */
export const IDENTITY_LIMITS = Object.freeze({
  id: 80, name: 120, country: 40, city: 80, marketValueRange: 60, agentName: 120, footballCategory: 40, conditionStatus: 40,
  programmeTrack: 60, timezone: 64, passwordHash: 512, email: 254, idvReference: 120,
  heightCm: [50, 250], weightKg: [15, 200], squadNumber: [0, 999], pct: [0, 100],
});
const L = IDENTITY_LIMITS;
const inList = (col, xs) => `CHECK (${col} IN (${xs.map((x) => `'${x}'`).join(', ')}))`;
const optList = (col, xs) => `CHECK (${col} IS NULL OR ${col} IN (${xs.map((x) => `'${x}'`).join(', ')}))`;
const optText = (col, max, min = 1) => `CHECK (${col} IS NULL OR length(${col}) BETWEEN ${min} AND ${max})`;
const flag = (col) => `INTEGER NOT NULL DEFAULT 0 CHECK (${col} IN (0,1))`;
const optFlag = (col) => `INTEGER CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const range = (col, [lo, hi]) => `CHECK (${col} IS NULL OR ${col} BETWEEN ${lo} AND ${hi})`;
const HHMM = (col) => `CHECK (${col} IS NULL OR (length(${col}) = 5 AND ${col} GLOB '[0-2][0-9]:[0-5][0-9]'))`;

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

// ------------------------------------------------------------------ small helpers
const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isClock = (v) => Number.isSafeInteger(v) && v >= 0;
const describe = (v) => (v === null ? 'null' : v === undefined ? 'absent' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const textOk = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const optTextOk = (v, max) => v === null || textOk(v, max);
const intIn = (v, [lo, hi]) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] === undefined ? null : o[k]]));
const given = (raw) => Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)); // an undefined field is an absent one

// ------------------------------------------------------------------ the player record
export const PLAYER_SCALAR_KEYS = Object.freeze(['id', 'name', 'dob', 'country', 'city', 'position', 'foot', 'heightCm', 'weightKg', 'squadNumber',
  'contractUntil', 'marketValueRange', 'agentName', 'academyPlus', 'firstTeamSeeker', 'availability', 'contractStatus', 'level',
  'footballCategory', 'identityVerified', 'guardianId', 'createdAt']);
const STATS_KEYS = Object.freeze(['appearances', 'goals', 'assists', 'paceKmh', 'passCompletionPct', 'duelSuccessPct', 'cleanSheets']);
const STATS_COUNTS = Object.freeze(['appearances', 'goals', 'assists', 'cleanSheets']);
const STATS_COLUMN = Object.freeze({ appearances: 'stats_appearances', goals: 'stats_goals', assists: 'stats_assists', paceKmh: 'stats_pace_kmh',
  passCompletionPct: 'stats_pass_completion_pct', duelSuccessPct: 'stats_duel_success_pct', cleanSheets: 'stats_clean_sheets' });
const PREFS_KEYS = Object.freeze(['quietStart', 'quietEnd', 'schoolHoursMute', 'timezone']);
export const PLAYER_RECORD_KEYS = Object.freeze([...PLAYER_SCALAR_KEYS, 'location', 'stats', 'medical', 'notificationPrefs', 'programme', ...PLAYER_SUBRECORD_KEYS, 'trialReports']);
const PLAYER_BOOLEANS = Object.freeze(['academyPlus', 'firstTeamSeeker', 'identityVerified']);
const PLAYER_DEFAULTS = Object.freeze({ city: null, position: null, foot: null, heightCm: null, weightKg: null, squadNumber: null, contractUntil: null,
  marketValueRange: null, agentName: null, academyPlus: false, firstTeamSeeker: false, availability: 'not_seeking', contractStatus: 'unknown',
  level: 'amateur', footballCategory: null, identityVerified: false, guardianId: null, createdAt: null, location: null, stats: null,
  notificationPrefs: null, programme: null });

/** An incoming player (create, the seed) with its defaults: every field present, the lists as given (or empty). */
function playerWithDefaults(raw) {
  const g = given(raw);
  const r = { ...PLAYER_DEFAULTS, ...g };
  if (r.city === '') r.city = null;
  r.medical = isPlainObject(g.medical) ? { shared: false, conditionStatus: 'unknown', records: [], ...given(g.medical) } : g.medical === undefined || g.medical === null ? { shared: false, conditionStatus: 'unknown', records: [] } : g.medical;
  if (isPlainObject(r.programme)) r.programme = { track: null, startedAt: null, completed: [], ...given(r.programme) };
  if (isPlainObject(r.stats)) r.stats = { ...pick(r.stats, STATS_KEYS), ...Object.fromEntries(Object.entries(r.stats).filter(([k]) => !STATS_KEYS.includes(k))) };
  if (isPlainObject(r.notificationPrefs)) r.notificationPrefs = { ...pick(r.notificationPrefs, PREFS_KEYS), ...Object.fromEntries(Object.entries(r.notificationPrefs).filter(([k]) => !PREFS_KEYS.includes(k))) };
  for (const k of PLAYER_SUBRECORD_KEYS) if (r[k] === undefined || r[k] === null) r[k] = [];
  // The trials own the reports: an incoming record may carry none (null or an empty list is no claim and is not kept).
  if (r.trialReports === null || (Array.isArray(r.trialReports) && r.trialReports.length === 0)) delete r.trialReports;
  return Object.fromEntries([...PLAYER_RECORD_KEYS.filter((k) => k !== 'trialReports').map((k) => [k, r[k]]), ...Object.entries(r).filter(([k]) => !PLAYER_RECORD_KEYS.includes(k) || k === 'trialReports')]);
}

/** The problems with a player record (an incoming one after its defaults, or a draft), by field; never a value. */
export function playerRecordProblems(r) {
  const out = [];
  for (const k of Object.keys(r)) {
    if (k === 'trialReports') out.push('trialReports are the trials\' reports and are not written with a player');
    else if (!PLAYER_RECORD_KEYS.includes(k)) out.push(`unknown field ${k}`);
  }
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters`);
  if (typeof r.dob !== 'string' || !parseStrictDateOnly(r.dob).ok) out.push('dob must be a YYYY-MM-DD date');
  if (!textOk(r.country, L.country)) out.push(`country must be text of 1 to ${L.country} characters`);
  if (!optTextOk(r.city, L.city)) out.push(`city must be text of 1 to ${L.city} characters or null`);
  if (r.position !== null && !PLAYER_POSITIONS.includes(r.position)) out.push(`position must be one of ${PLAYER_POSITIONS.join(', ')} or null`);
  if (r.foot !== null && !PLAYER_FEET.includes(r.foot)) out.push(`foot must be one of ${PLAYER_FEET.join(', ')} or null`);
  for (const k of ['heightCm', 'weightKg', 'squadNumber']) if (r[k] !== null && !intIn(r[k], L[k])) out.push(`${k} must be a whole number from ${L[k][0]} to ${L[k][1]} or null`);
  if (r.contractUntil !== null && (typeof r.contractUntil !== 'string' || !parseStrictDateOnly(r.contractUntil).ok)) out.push('contractUntil must be a YYYY-MM-DD date or null');
  for (const k of ['marketValueRange', 'agentName', 'footballCategory']) if (!optTextOk(r[k], L[k])) out.push(`${k} must be text of 1 to ${L[k]} characters or null`);
  for (const k of PLAYER_BOOLEANS) if (typeof r[k] !== 'boolean') out.push(`${k} must be a boolean`);
  if (!PLAYER_AVAILABILITY.includes(r.availability)) out.push(`availability must be one of ${PLAYER_AVAILABILITY.join(', ')}`);
  if (!PLAYER_CONTRACT_STATUS.includes(r.contractStatus)) out.push(`contractStatus must be one of ${PLAYER_CONTRACT_STATUS.join(', ')}`);
  if (!PLAYER_LEVELS.includes(r.level)) out.push(`level must be one of ${PLAYER_LEVELS.join(', ')}`);
  if (r.guardianId !== null && !textOk(r.guardianId, L.id)) out.push('guardianId must be a guardian id or null');
  if (r.createdAt !== null && !isClock(r.createdAt)) out.push('createdAt must be an integer timestamp or null');
  if (r.location !== null) {
    const loc = r.location;
    if (!isPlainObject(loc) || Object.keys(loc).some((k) => k !== 'lat' && k !== 'lng')) out.push(`location must be { lat, lng } or null (got ${describe(loc)})`);
    else if (!(Number.isFinite(loc.lat) && Math.abs(loc.lat) <= 90 && Number.isFinite(loc.lng) && Math.abs(loc.lng) <= 180)) out.push('location.lat and location.lng must be a latitude (-90 to 90) and a longitude (-180 to 180)');
  }
  if (r.stats !== null) {
    const s = r.stats;
    if (!isPlainObject(s)) out.push(`stats must be an object or null (got ${describe(s)})`);
    else {
      for (const k of Object.keys(s)) if (!STATS_KEYS.includes(k)) out.push(`stats.${k} is not a stat`);
      for (const k of STATS_KEYS) {
        const v = s[k];
        if (v === null) continue;
        if (STATS_COUNTS.includes(k) ? !(Number.isSafeInteger(v) && v >= 0) : !(Number.isFinite(v) && v >= 0)) out.push(`stats.${k} must be a non-negative ${STATS_COUNTS.includes(k) ? 'whole number' : 'number'} or null`);
        else if ((k === 'passCompletionPct' || k === 'duelSuccessPct') && v > 100) out.push(`stats.${k} must be a percentage from 0 to 100`);
      }
    }
  }
  const m = r.medical;
  if (!isPlainObject(m) || Object.keys(m).some((k) => !['shared', 'conditionStatus', 'records'].includes(k))) out.push(`medical must be { shared, conditionStatus, records } (got ${describe(m)})`);
  else {
    if (typeof m.shared !== 'boolean') out.push('medical.shared must be a boolean');
    if (!textOk(m.conditionStatus, L.conditionStatus)) out.push(`medical.conditionStatus must be text of 1 to ${L.conditionStatus} characters`);
    out.push(...validateSubrecordArray('medical.records', m.records));
    if (!Array.isArray(m.records)) out.push('medical.records must be a list');
  }
  if (r.notificationPrefs !== null) {
    const n = r.notificationPrefs;
    if (!isPlainObject(n) || Object.keys(n).some((k) => !PREFS_KEYS.includes(k))) out.push(`notificationPrefs must be { ${PREFS_KEYS.join(', ')} } or null (got ${describe(n)})`);
    else out.push(...prefsProblems(n));
  }
  if (r.programme !== null) {
    const p = r.programme;
    if (!isPlainObject(p) || Object.keys(p).some((k) => !['track', 'startedAt', 'completed'].includes(k))) out.push(`programme must be { track, startedAt, completed } or null (got ${describe(p)})`);
    else {
      if (!optTextOk(p.track, L.programmeTrack)) out.push(`programme.track must be text of 1 to ${L.programmeTrack} characters or null`);
      if (p.startedAt !== null && !isClock(p.startedAt)) out.push('programme.startedAt must be an integer timestamp or null');
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
function prefsProblems(n) {
  const out = [];
  for (const k of ['quietStart', 'quietEnd']) if (n[k] !== null && !(typeof n[k] === 'string' && HHMM_RE.test(n[k]))) out.push(`notificationPrefs.${k} must be HH:MM or null`);
  if (n.schoolHoursMute !== null && typeof n.schoolHoursMute !== 'boolean') out.push('notificationPrefs.schoolHoursMute must be a boolean or null');
  if (!optTextOk(n.timezone, L.timezone)) out.push(`notificationPrefs.timezone must be text of 1 to ${L.timezone} characters or null`);
  return out;
}
const NO_PREFS = Object.freeze({ quietStart: null, quietEnd: null, schoolHoursMute: null, timezone: null });
/** A whole replacement of the preferences: every key present, no other. */
const prefsReplacementProblems = (n) => (isPlainObject(n) && Object.keys(n).every((k) => PREFS_KEYS.includes(k)) && PREFS_KEYS.every((k) => k in n)
  ? prefsProblems(n) : [`notificationPrefs must be { ${PREFS_KEYS.join(', ')} } or null (got ${describe(n)})`]);
const passwordProblem = (h) => (h === null || textOk(h, L.passwordHash) ? null : `the password hash must be text of 1 to ${L.passwordHash} characters or null`);

const P_COLS = ['id', 'name', 'birth_date', 'country', 'city', 'position', 'foot', 'height_cm', 'weight_kg', 'squad_number', 'contract_until_date',
  'market_value_range', 'agent_name', 'academy_plus', 'first_team_seeker', 'availability', 'contract_status', 'level', 'football_category',
  'identity_verified', 'guardian_id', 'lat', 'lng', 'stats_appearances', 'stats_goals', 'stats_assists', 'stats_pace_kmh',
  'stats_pass_completion_pct', 'stats_duel_success_pct', 'stats_clean_sheets', 'medical_shared', 'medical_condition_status',
  'prefs_quiet_start', 'prefs_quiet_end', 'prefs_school_hours_mute', 'prefs_timezone', 'programme_track', 'programme_started_at',
  'password_hash', 'profile_signal', 'created_at', 'deleted_at'];
export const PLAYER_COLUMNS = Object.freeze(P_COLS);
const P_SELECT = `SELECT ${P_COLS.join(', ')} FROM players`;
const P_INSERT = `INSERT INTO players (${P_COLS.join(', ')}) VALUES (${P_COLS.map((c) => `@${c}`).join(', ')})`;
const P_UPDATE_COLS = P_COLS.filter((c) => !['id', 'guardian_id', 'password_hash', 'profile_signal', 'created_at', 'deleted_at'].includes(c));
const P_UPDATE = `UPDATE players SET ${P_UPDATE_COLS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND deleted_at IS NULL`;
const b = (v) => (v ? 1 : 0);
const nb = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
function playerParams(r, passwordHash = null) {
  const s = r.stats ?? {}; const n = r.notificationPrefs ?? {};
  return {
    id: r.id, name: r.name, birth_date: r.dob, country: r.country, city: r.city, position: r.position, foot: r.foot,
    height_cm: r.heightCm, weight_kg: r.weightKg, squad_number: r.squadNumber, contract_until_date: r.contractUntil,
    market_value_range: r.marketValueRange, agent_name: r.agentName, academy_plus: b(r.academyPlus), first_team_seeker: b(r.firstTeamSeeker),
    availability: r.availability, contract_status: r.contractStatus, level: r.level, football_category: r.footballCategory,
    identity_verified: b(r.identityVerified), guardian_id: r.guardianId, lat: r.location?.lat ?? null, lng: r.location?.lng ?? null,
    stats_appearances: s.appearances ?? null, stats_goals: s.goals ?? null, stats_assists: s.assists ?? null, stats_pace_kmh: s.paceKmh ?? null,
    stats_pass_completion_pct: s.passCompletionPct ?? null, stats_duel_success_pct: s.duelSuccessPct ?? null, stats_clean_sheets: s.cleanSheets ?? null,
    medical_shared: b(r.medical.shared), medical_condition_status: r.medical.conditionStatus,
    prefs_quiet_start: n.quietStart ?? null, prefs_quiet_end: n.quietEnd ?? null, prefs_school_hours_mute: nb(n.schoolHoursMute), prefs_timezone: n.timezone ?? null,
    programme_track: r.programme?.track ?? null, programme_started_at: r.programme?.startedAt ?? null,
    // A new row has no trial reports yet (the trials name it later and refresh the figure); refreshProfileSignals keeps it after.
    password_hash: passwordHash, profile_signal: computeTrustScore({ ...r, trialReports: [] }), created_at: r.createdAt, deleted_at: null,
  };
}
const allNull = (...vs) => vs.every((v) => v === null || v === undefined);
/** The record for a live row, its lists and its trial reports (plain; the repository freezes what it hands out). A stats, prefs or programme block whose columns are all NULL is null. */
function playerFromDb(d, children, trialReports) {
  const stats = allNull(d.stats_appearances, d.stats_goals, d.stats_assists, d.stats_pace_kmh, d.stats_pass_completion_pct, d.stats_duel_success_pct, d.stats_clean_sheets)
    ? null : { appearances: d.stats_appearances, goals: d.stats_goals, assists: d.stats_assists, paceKmh: d.stats_pace_kmh, passCompletionPct: d.stats_pass_completion_pct, duelSuccessPct: d.stats_duel_success_pct, cleanSheets: d.stats_clean_sheets };
  const prefs = allNull(d.prefs_quiet_start, d.prefs_quiet_end, d.prefs_school_hours_mute, d.prefs_timezone)
    ? null : { quietStart: d.prefs_quiet_start, quietEnd: d.prefs_quiet_end, schoolHoursMute: d.prefs_school_hours_mute === null ? null : d.prefs_school_hours_mute === 1, timezone: d.prefs_timezone };
  const programmed = !allNull(d.programme_track, d.programme_started_at) || children.programme.completed.length > 0;
  const rec = {
    id: d.id, name: d.name, dob: d.birth_date, country: d.country, city: d.city, position: d.position, foot: d.foot,
    heightCm: d.height_cm, weightKg: d.weight_kg, squadNumber: d.squad_number, contractUntil: d.contract_until_date,
    marketValueRange: d.market_value_range, agentName: d.agent_name, academyPlus: d.academy_plus === 1, firstTeamSeeker: d.first_team_seeker === 1,
    availability: d.availability, contractStatus: d.contract_status, level: d.level, footballCategory: d.football_category,
    identityVerified: d.identity_verified === 1, guardianId: d.guardian_id, createdAt: d.created_at,
    location: d.lat === null ? null : { lat: d.lat, lng: d.lng },
    stats,
    medical: { shared: d.medical_shared === 1, conditionStatus: d.medical_condition_status, records: children.medical.records },
    notificationPrefs: prefs,
    programme: programmed ? { track: d.programme_track, startedAt: d.programme_started_at, completed: children.programme.completed } : null,
  };
  for (const k of PLAYER_SUBRECORD_KEYS) rec[k] = children[k];
  rec.trialReports = trialReports;
  return rec;
}

/** The columns of a light record (scanLight, the fixture graph, the feed): the row's own facts, no lists. */
const LIGHT_COLS = ['id', 'name', 'birth_date', 'country', 'city', 'position', 'foot', 'height_cm', 'weight_kg', 'level', 'availability', 'academy_plus',
  'first_team_seeker', 'football_category', 'identity_verified', 'lat', 'lng', 'created_at', 'profile_signal',
  'stats_appearances', 'stats_goals', 'stats_assists', 'stats_pace_kmh', 'stats_pass_completion_pct', 'stats_duel_success_pct', 'stats_clean_sheets'];
/** A light record: a player's own fields as the full record names them, `profileSignal`, and no lists (they are absent, not empty). */
function lightFromRow(d) {
  const stats = allNull(d.stats_appearances, d.stats_goals, d.stats_assists, d.stats_pace_kmh, d.stats_pass_completion_pct, d.stats_duel_success_pct, d.stats_clean_sheets)
    ? null : { appearances: d.stats_appearances, goals: d.stats_goals, assists: d.stats_assists, paceKmh: d.stats_pace_kmh, passCompletionPct: d.stats_pass_completion_pct, duelSuccessPct: d.stats_duel_success_pct, cleanSheets: d.stats_clean_sheets };
  return Object.freeze({
    id: d.id, name: d.name, dob: d.birth_date, country: d.country, city: d.city, position: d.position, foot: d.foot, heightCm: d.height_cm, weightKg: d.weight_kg,
    level: d.level, availability: d.availability, academyPlus: d.academy_plus === 1, firstTeamSeeker: d.first_team_seeker === 1, footballCategory: d.football_category,
    identityVerified: d.identity_verified === 1, location: d.lat === null ? null : Object.freeze({ lat: d.lat, lng: d.lng }), createdAt: d.created_at,
    profileSignal: d.profile_signal, stats: stats && Object.freeze(stats), light: true,
  });
}

// ------------------------------------------------------------------ the guardian record
export const GUARDIAN_RECORD_KEYS = Object.freeze(['id', 'name', 'email', 'emailVerified', 'idVerified', 'idvReference', 'disclaimerAccepted',
  'disclaimerAcceptedAt', 'coGuardianOf', 'notificationPrefs', 'createdAt', 'childIds', 'coGuardians']);
const GUARDIAN_BOOLEANS = Object.freeze(['emailVerified', 'idVerified', 'disclaimerAccepted']);
const GUARDIAN_INPUT_KEYS = Object.freeze(GUARDIAN_RECORD_KEYS.filter((k) => k !== 'coGuardians'));
function guardianWithDefaults(raw) {
  const g = given(raw);
  const r = { emailVerified: false, idVerified: false, idvReference: null, disclaimerAccepted: false, disclaimerAcceptedAt: null, coGuardianOf: null, notificationPrefs: null, createdAt: null, childIds: [], ...g };
  if (isPlainObject(r.notificationPrefs)) r.notificationPrefs = { ...pick(r.notificationPrefs, PREFS_KEYS), ...Object.fromEntries(Object.entries(r.notificationPrefs).filter(([k]) => !PREFS_KEYS.includes(k))) };
  return r;
}
export function guardianRecordProblems(r) {
  const out = [];
  for (const k of Object.keys(r)) {
    if (GUARDIAN_INPUT_KEYS.includes(k)) continue;
    if (k === 'coGuardians') out.push('coGuardians is worked out from the co-guardians\' coGuardianOf and is not written');
    else out.push(`unknown field ${k}`);
  }
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters`);
  if (!(textOk(r.email, L.email, 3) && r.email.includes('@'))) out.push(`email must be an address of 3 to ${L.email} characters`);
  for (const k of GUARDIAN_BOOLEANS) if (typeof r[k] !== 'boolean') out.push(`${k} must be a boolean`);
  if (!optTextOk(r.idvReference, L.idvReference)) out.push(`idvReference must be text of 1 to ${L.idvReference} characters or null`);
  if (r.disclaimerAcceptedAt !== null && !isClock(r.disclaimerAcceptedAt)) out.push('disclaimerAcceptedAt must be an integer timestamp or null');
  if (r.coGuardianOf !== null && !textOk(r.coGuardianOf, L.id)) out.push('coGuardianOf must be a guardian id or null');
  if (r.coGuardianOf !== null && r.coGuardianOf === r.id) out.push('coGuardianOf cannot name the guardian itself');
  if (r.createdAt !== null && !isClock(r.createdAt)) out.push('createdAt must be an integer timestamp or null');
  if (!Array.isArray(r.childIds) || r.childIds.some((c) => !textOk(c, L.id))) out.push('childIds must be a list of player ids');
  else if (new Set(r.childIds).size !== r.childIds.length) out.push('childIds lists a player more than once');
  if (r.notificationPrefs !== null) {
    const n = r.notificationPrefs;
    if (!isPlainObject(n) || Object.keys(n).some((k) => !PREFS_KEYS.includes(k))) out.push(`notificationPrefs must be { ${PREFS_KEYS.join(', ')} } or null (got ${describe(n)})`);
    else out.push(...prefsProblems(n));
  }
  return out;
}
const codeHashProblem = (h) => (h === null || (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) ? null : 'the e-mail code hash must be a sha256 hex digest or null');
const G_COLS = ['id', 'name', 'email', 'password_hash', 'email_verified', 'email_code_hash', 'id_verified', 'idv_reference', 'disclaimer_accepted',
  'disclaimer_accepted_at', 'co_guardian_of', 'prefs_quiet_start', 'prefs_quiet_end', 'prefs_school_hours_mute', 'prefs_timezone', 'created_at'];
export const GUARDIAN_COLUMNS = Object.freeze(G_COLS);
const G_SELECT = `SELECT ${G_COLS.join(', ')} FROM guardians`;
const G_INSERT = `INSERT INTO guardians (${G_COLS.join(', ')}) VALUES (${G_COLS.map((c) => `@${c}`).join(', ')})`;
function guardianParams(r, { passwordHash = null, emailCodeHash = null } = {}) {
  const n = r.notificationPrefs ?? {};
  return {
    id: r.id, name: r.name, email: r.email, password_hash: passwordHash, email_verified: b(r.emailVerified), email_code_hash: emailCodeHash,
    id_verified: b(r.idVerified), idv_reference: r.idvReference, disclaimer_accepted: b(r.disclaimerAccepted), disclaimer_accepted_at: r.disclaimerAcceptedAt,
    co_guardian_of: r.coGuardianOf, prefs_quiet_start: n.quietStart ?? null, prefs_quiet_end: n.quietEnd ?? null,
    prefs_school_hours_mute: nb(n.schoolHoursMute), prefs_timezone: n.timezone ?? null, created_at: r.createdAt,
  };
}
function guardianFromDb(d, childIds, coGuardians) {
  return {
    id: d.id, name: d.name, email: d.email, emailVerified: d.email_verified === 1, idVerified: d.id_verified === 1, idvReference: d.idv_reference,
    disclaimerAccepted: d.disclaimer_accepted === 1, disclaimerAcceptedAt: d.disclaimer_accepted_at, coGuardianOf: d.co_guardian_of,
    notificationPrefs: allNull(d.prefs_quiet_start, d.prefs_quiet_end, d.prefs_school_hours_mute, d.prefs_timezone) ? null
      : { quietStart: d.prefs_quiet_start, quietEnd: d.prefs_quiet_end, schoolHoursMute: d.prefs_school_hours_mute === null ? null : d.prefs_school_hours_mute === 1, timezone: d.prefs_timezone },
    createdAt: d.created_at, childIds, coGuardians,
  };
}

// ------------------------------------------------------------------ visibility in SQL (a prefilter; the exact rule is domain.mjs visibleToOrg)
/** The latest birth date of someone at least `years` old on `nowMs` (YYYY-MM-DD; compared as text, exactly ageOn's rule). */
export function bornByForAge(years, nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${String(d.getUTCFullYear() - years).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** `birth_date <= <the adult cutoff of the player's country>`: the adults on `nowMs`, by the per-country age of majority. */
function adultsSql(nowMs) {
  const special = Object.entries(ADULT_AGE).filter(([k]) => k !== 'DEFAULT');
  const sql = `p.birth_date <= CASE p.country ${special.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ? END`;
  const args = [...special.flatMap(([c, age]) => [c, bornByForAge(age, nowMs)]), bornByForAge(ADULT_AGE.DEFAULT, nowMs)];
  return { sql, args };
}
/** Can this organisation ever see a minor (domain.mjs visibleToOrg: a verified club only)? */
const seesMinors = (org) => org?.type === 'club' && org.verified === true;
/**
 * The SQL functions the player reads use, registered on the connection from the JS rules themselves (one
 * definition each): `haversine_km` (domain.mjs haversineKm, the Grassroots radius), `distance_tenths` (the distance a
 * Grassroots club is shown, in tenths of a km, as views/playerViews.mjs rounds it) and `lower_js` (JavaScript's
 * toLowerCase, which also lowers accented letters; SQLite's lower() is ASCII only).
 */
const withFunctions = new WeakSet();
export function registerPlayerFunctions(sqlite) {
  if (withFunctions.has(sqlite)) return;
  const at = (lat, lng) => ({ lat, lng });
  const real = (...vs) => vs.every((v) => typeof v === 'number' && Number.isFinite(v));
  sqlite.function('haversine_km', { deterministic: true }, (aLat, aLng, bLat, bLng) => (real(aLat, aLng, bLat, bLng) ? haversineKm(at(aLat, aLng), at(bLat, bLng)) : null));
  sqlite.function('distance_tenths', { deterministic: true }, (aLat, aLng, bLat, bLng) => (real(aLat, aLng, bLat, bLng) ? Math.round(haversineKm(at(aLat, aLng), at(bLat, bLng)) * 10) : null));
  sqlite.function('lower_js', { deterministic: true }, (v) => (typeof v === 'string' ? v.toLowerCase() : v));
  withFunctions.add(sqlite);
}
/** The longitude ranges of a box, split in two where it crosses ±180° (so the far side of the antimeridian is kept). */
function lngRanges(box) {
  if (box.maxLng - box.minLng >= 360) return [[-180, 180]];
  if (box.minLng < -180) return [[box.minLng + 360, 180], [-180, box.maxLng]];
  if (box.maxLng > 180) return [[box.minLng, 180], [-180, box.maxLng - 360]];
  return [[box.minLng, box.maxLng]];
}

// ------------------------------------------------------------------ profile completeness
/**
 * `players.profile_signal`: the directory's sort figure, domain.mjs `trustScoreFromFacts` over the row's facts and its
 * list counts (attendance, clips, the trials' filed reports). Every write that can change a fact refreshes it in its own
 * transaction or unit: the player writes here, a trial write in the recruitment repository.
 * `ids` null refreshes every live player.
 */
const signalSqlCache = new WeakMap();
function signalSql(sqlite) {
  let sql = signalSqlCache.get(sqlite);
  if (sql) return sql;
  // Cached only once the trial reports table exists (a connection that reads before it does asks again next time).
  const hasTrials = !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trial_reports'").get();
  const reports = hasTrials ? '(SELECT COUNT(*) FROM trial_reports r JOIN trials t ON t.id = r.trial_id WHERE t.player_id = p.id)' : '0';
  const stats = ['stats_appearances', 'stats_goals', 'stats_assists', 'stats_pace_kmh', 'stats_pass_completion_pct', 'stats_duel_success_pct', 'stats_clean_sheets'].map((c) => `p.${c} IS NOT NULL`).join(' OR ');
  const select = `SELECT p.id, p.profile_signal, p.identity_verified, p.position, p.foot, p.height_cm, p.weight_kg, (${stats}) AS has_stats,
      (SELECT COUNT(*) FROM player_attendance a WHERE a.player_id = p.id) AS attendance,
      (SELECT COUNT(*) FROM player_media m WHERE m.player_id = p.id) AS media,
      ${reports} AS reports
      FROM players p WHERE p.deleted_at IS NULL`;
  sql = {
    all: sqlite.prepare(select),
    one: sqlite.prepare(`${select} AND p.id = ?`),
    many: sqlite.prepare(`${select} AND p.id IN (SELECT value FROM json_each(?))`),
    update: sqlite.prepare('UPDATE players SET profile_signal = ? WHERE id = ?'),
  };
  if (hasTrials) signalSqlCache.set(sqlite, sql);
  return sql;
}
export const signalOfRow = (d) => trustScoreFromFacts({
  identityVerified: d.identity_verified === 1, attendanceCount: d.attendance, trialReportCount: d.reports, mediaCount: d.media,
  profileComplete: !!(d.position && d.foot && d.height_cm && d.weight_kg && d.has_stats),
});
export function refreshProfileSignals(sqlite, ids = null) {
  const sql = signalSql(sqlite);
  const list = ids === null ? null : [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  if (list !== null && !list.length) return 0;
  const rows = list === null ? sql.all.all() : list.length === 1 ? sql.one.all(list[0]) : sql.many.all(JSON.stringify(list));
  let changed = 0;
  for (const d of rows) { const v = signalOfRow(d); if (v !== d.profile_signal) { sql.update.run(v, d.id); changed += 1; } }
  return changed;
}

// ------------------------------------------------------------------ the retained record
/** The fixed storage placeholders of a retained row: constants the table's constraints need, never read back as facts about the person. */
export const RETAINED_PLACEHOLDERS = Object.freeze({ name: RETAINED_PLAYER_NAME, profile_signal: 0, academy_plus: 0, first_team_seeker: 0, availability: 'not_seeking', contract_status: 'unknown', level: 'amateur', identity_verified: 0, medical_shared: 0, medical_condition_status: 'unknown' });
const RETAINED_KEYS = Object.freeze(['id', 'deletedAt', 'birthDate', 'country']);
/** A retained record `{ id, deletedAt, birthDate, country }` → the full row (the kept facts, the placeholders, NULL elsewhere). */
export function retainedRowFor(rec) {
  const p = {}; for (const c of P_COLS) p[c] = null;
  p.id = rec.id; p.birth_date = rec.birthDate; p.country = rec.country; p.deleted_at = rec.deletedAt;
  return Object.assign(p, RETAINED_PLACEHOLDERS);
}
export const retainedRecordFromRow = (r) => ({ id: r.id, deletedAt: r.deleted_at, birthDate: r.birth_date, country: r.country });
/** Problems of one retained record (field and reason; never a value): the shape is exactly the four keys. */
export function validateRetainedRecord(rec, index = null) {
  const at = `playersRetained ${typeof rec?.id === 'string' && rec.id ? rec.id : `#${index}`}`;
  if (!isPlainObject(rec)) return [`${at}: a retained record is an object (got ${describe(rec)})`];
  const problems = [];
  if (typeof rec.id !== 'string' || !rec.id) problems.push('id is not a non-empty string');
  if (!isClock(rec.deletedAt)) problems.push('deletedAt is not a non-negative integer (ms)');
  if (typeof rec.birthDate !== 'string' || !parseStrictDateOnly(rec.birthDate).ok) problems.push('birthDate is not a YYYY-MM-DD date');
  if (typeof rec.country !== 'string' || !rec.country) problems.push('country is not a non-empty string');
  const unknown = Object.keys(rec).filter((k) => !RETAINED_KEYS.includes(k));
  if (unknown.length) problems.push(`unknown field(s) ${unknown.join(', ')} (a retained record carries exactly id, deletedAt, birthDate, country)`);
  return problems.map((m) => `${at}: ${m}`);
}
/** The retained records, read back (the test suites' read-back). */
export const PLAYERS_RETAINED = {
  name: PLAYERS_RETAINED_COLLECTION,
  cutOver: (sqlite) => migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION),
  read(sqlite) {
    if (!this.cutOver(sqlite)) return null;
    return sqlite.prepare('SELECT id, deleted_at, birth_date, country FROM players WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id').all().map(retainedRecordFromRow);
  },
};
const ERASE_COLUMNS = Object.freeze(P_COLS.filter((c) => !['id', 'birth_date', 'country'].includes(c)));
const ERASE_SQL = `UPDATE players SET ${ERASE_COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND deleted_at IS NULL`;
const eraseParamsFor = (rec) => { const full = retainedRowFor(rec); const p = { id: rec.id }; for (const c of ERASE_COLUMNS) p[c] = full[c]; return p; };

// ------------------------------------------------------------------ typing a whole identity (the seed)
const blocked = (detail, extra = {}) => refusal('IDENTITY_IMPORT_BLOCKED', `${detail}; nothing was written`, extra);
/**
 * Type a pair `{ players, guardians }` (the records plus `password`, and a guardian's `emailCodeHash`): every
 * record typed, ids and e-mails unique, every reference and both sides of every link consistent, no minor on `now`
 * without a primary guardian. Returns the rows to write, or throws IDENTITY_IMPORT_BLOCKED naming the ids and fields.
 */
export function typeIdentitySnapshot({ players, guardians }, { now = Date.now(), retainedIds = new Set() } = {}) {
  for (const [name, value] of [['players', players], ['guardians', guardians]]) if (!Array.isArray(value)) throw blocked(`${name}: the snapshot collection must be an array of records (got ${describe(value)})`);
  const problems = [];
  const gRows = []; const gIds = new Set(); const emails = new Map();
  guardians.forEach((raw, i) => {
    if (!isPlainObject(raw)) { problems.push(`guardians #${i}: not an object (${describe(raw)})`); return; }
    const { password = null, emailCodeHash = null, ...rest } = raw;
    const r = guardianWithDefaults(rest);
    const at = `guardians ${typeof r.id === 'string' ? r.id : `#${i}`}`;
    const ps = guardianRecordProblems(r);
    const pw = passwordProblem(password); if (pw) ps.push(pw);
    const ch = codeHashProblem(emailCodeHash); if (ch) ps.push(ch);
    if (ps.length) { problems.push(`${at}: ${ps.join('; ')}`); return; }
    if (gIds.has(r.id)) { problems.push(`${at}: duplicate id`); return; }
    const key = r.email.toLowerCase();
    if (emails.has(key)) { problems.push(`${at}: the e-mail is already used by guardian ${emails.get(key)} (compared case-insensitively)`); return; }
    gIds.add(r.id); emails.set(key, r.id); gRows.push({ r, passwordHash: password, emailCodeHash });
  });
  const pRows = []; const pIds = new Set(); const byId = new Map();
  players.forEach((raw, i) => {
    if (!isPlainObject(raw)) { problems.push(`players #${i}: not an object (${describe(raw)})`); return; }
    const { password = null, ...rest } = raw;
    const r = playerWithDefaults(rest);
    const at = `players ${typeof r.id === 'string' ? r.id : `#${i}`}`;
    const ps = playerRecordProblems(r);
    const pw = passwordProblem(password); if (pw) ps.push(pw);
    if (ps.length) { problems.push(`${at}: ${ps.join('; ')}`); return; }
    if (pIds.has(r.id)) { problems.push(`${at}: duplicate id`); return; }
    if (retainedIds.has(r.id)) { problems.push(`${at}: the id is a deleted account whose record is retained; a deleted account is not created again`); return; }
    if (r.guardianId !== null && !gIds.has(r.guardianId)) { problems.push(`${at}: guardianId names guardian ${r.guardianId}, which the snapshot does not hold`); return; }
    if (r.guardianId === null && !isAdult(r, new Date(now))) { problems.push(`${at}: a minor without a primary guardian (guardianId)`); return; }
    pIds.add(r.id); byId.set(r.id, r); pRows.push({ r, passwordHash: password });
  });
  const links = [];
  for (const { r } of gRows) {
    if (r.coGuardianOf !== null && !gIds.has(r.coGuardianOf)) problems.push(`guardians ${r.id}: coGuardianOf names guardian ${r.coGuardianOf}, which the snapshot does not hold`);
    for (const childId of r.childIds) {
      const p = byId.get(childId);
      if (!p) { problems.push(`guardians ${r.id}: childIds names player ${childId}, which the snapshot does not hold`); continue; }
      links.push({ guardian_id: r.id, player_id: childId, role: p.guardianId === r.id ? 'primary' : 'co' });
    }
  }
  const listed = new Set(links.filter((l) => l.role === 'primary').map((l) => l.player_id));
  for (const { r } of pRows) if (r.guardianId !== null && !listed.has(r.id)) problems.push(`players ${r.id}: its guardian ${r.guardianId} does not list it in childIds`);
  if (problems.length) throw blocked(`identity snapshot: ${problems.length} record(s) or relationship(s) refused — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  return { guardians: gRows, players: pRows, links };
}
/** Write a typed identity (inside the caller's transaction): guardians (co-guardian keys in a second pass), players and their lists, then the links. */
function writeIdentity(sqlite, typed) {
  const insG = sqlite.prepare(G_INSERT);
  const coG = sqlite.prepare('UPDATE guardians SET co_guardian_of = ? WHERE id = ?');
  for (const { r, passwordHash, emailCodeHash } of typed.guardians) insG.run({ ...guardianParams(r, { passwordHash, emailCodeHash }), co_guardian_of: null });
  for (const { r } of typed.guardians) if (r.coGuardianOf !== null) coG.run(r.coGuardianOf, r.id);
  const insP = sqlite.prepare(P_INSERT);
  const st = prepareSubrecordStatements(sqlite);
  for (const { r, passwordHash } of typed.players) { insP.run(playerParams(r, passwordHash)); writeChildRows(st, r); }
  const insL = sqlite.prepare('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (@guardian_id, @player_id, @role)');
  for (const l of typed.links) insL.run(l);
  refreshProfileSignals(sqlite);
  return { players: typed.players.length, guardians: typed.guardians.length, links: typed.links.length };
}

const cutOver = (sqlite) => migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION);

/** Read every live player and guardian with their hashes (no trial reports, no coGuardians). */
function readIdentitySnapshot(sqlite) {
  const live = sqlite.prepare(`${P_SELECT} WHERE deleted_at IS NULL ORDER BY rowid`).all();
  const children = readChildrenFor(sqlite, live.map((d) => d.id));
  const players = live.map((d) => { const { trialReports: _derived, ...rec } = playerFromDb(d, children.get(d.id), []); return { ...rec, password: d.password_hash }; });
  const links = new Map();
  for (const l of sqlite.prepare('SELECT guardian_id, player_id FROM guardian_children ORDER BY rowid').all()) { if (!links.has(l.guardian_id)) links.set(l.guardian_id, []); links.get(l.guardian_id).push(l.player_id); }
  const guardians = sqlite.prepare(`${G_SELECT} ORDER BY rowid`).all().map((d) => { const { coGuardians: _derived, ...rec } = guardianFromDb(d, links.get(d.id) ?? [], []); return { ...rec, password: d.password_hash, emailCodeHash: d.email_code_hash }; });
  return { players, guardians };
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const IDENTITY_RECORDS = {
  names: IDENTITY_COLLECTIONS,
  cutOver,
  read(sqlite) { return cutOver(sqlite) ? readIdentitySnapshot(sqlite) : null; },
};

// ------------------------------------------------------------------ the repositories
const WRITES = new Set(['create', 'setPasswordHash', 'setEmailCodeHash', 'addItem', 'setItems', 'patchItem', 'link', 'unlink', 'ageUp', 'erase',
  'setAvailability', 'setLevel', 'setFootballCategory', 'setAcademyPlus', 'setFirstTeamSeeker', 'setMedicalSharing', 'setConditionStatus',
  'setLocation', 'recordStats', 'startProgramme', 'setNotificationPrefs',
  'verifyEmail', 'recordIdCheck', 'reviewIdCheck', 'acceptDisclaimer']);
const SCAN_BATCH = 500;

/**
 * `createIdentityRepositories({ sqlite, unit, now, log, trialReportsOf })`. `trialReportsOf(ids)` answers a Map player id
 * → the trial reports naming the player (the recruitment repository); without it every list is empty.
 */
export function createIdentityRepositories({ sqlite, log = () => {}, unit = null, now = Date.now, trialReportsOf = null }) {
  if (!sqlite) throw new TypeError('the identity repositories need a SQLite connection (node:sqlite); players and guardians have no in-memory fallback');
  if (!cutOver(sqlite)) throw new Error(`core identity: the cutover record ${CORE_IDENTITY_LIVE_MIGRATION} is missing from data_migrations; the players, guardians and guardian_children tables cannot be trusted as the source of truth`);
  if (!subrecordsLive(sqlite)) throw new Error(`core identity: the sub-record record ${PLAYER_SUBRECORDS_MIGRATION} is missing from data_migrations; the player lists have no storage on this connection`);
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the identity repositories need the store\'s participant API `unit` ({ active(), join(work) }) or null');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = prepareSubrecordStatements(sqlite);
  const reportsFor = (ids) => (trialReportsOf && ids.length ? trialReportsOf(ids) : new Map());
  registerPlayerFunctions(sqlite);
  let blocksTable = false; // remembered once true: a read before the safety migration asks again next time
  const hasBlocks = () => (blocksTable ||= !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'").get());

  // ---------------------------------------------------------- decoding
  const decodePlayers = (rows) => {
    if (!rows.length) return [];
    const ids = rows.map((d) => d.id);
    const children = rows.length === 1 ? new Map([[ids[0], readChildren(st, ids[0])]]) : readChildrenFor(sqlite, ids);
    const reports = reportsFor(ids);
    return rows.map((d) => deepFreeze(playerFromDb(d, children.get(d.id), clone(reports.get(d.id) ?? []))));
  };
  const playerById = (id) => (typeof id === 'string' && id ? decodePlayers(q(`${P_SELECT} WHERE id = ? AND deleted_at IS NULL`).all(id))[0] ?? null : null);
  const playerRow = (id) => (typeof id === 'string' && id ? q(`${P_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) ?? null : null);
  const decodeGuardians = (rows) => {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map((d) => d.id));
    const kids = new Map(); const cos = new Map();
    for (const l of q('SELECT guardian_id, player_id FROM guardian_children WHERE guardian_id IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(ids)) { if (!kids.has(l.guardian_id)) kids.set(l.guardian_id, []); kids.get(l.guardian_id).push(l.player_id); }
    for (const c of q('SELECT id, name, email, co_guardian_of FROM guardians WHERE co_guardian_of IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(ids)) { if (!cos.has(c.co_guardian_of)) cos.set(c.co_guardian_of, []); cos.get(c.co_guardian_of).push({ id: c.id, name: c.name, email: c.email }); }
    return rows.map((d) => deepFreeze(guardianFromDb(d, kids.get(d.id) ?? [], cos.get(d.id) ?? [])));
  };
  const guardianById = (id) => (typeof id === 'string' && id ? decodeGuardians(q(`${G_SELECT} WHERE id = ?`).all(id))[0] ?? null : null);
  const playerInvalid = (id, problems) => refusal('PLAYER_RECORD_INVALID', `a player record was refused (player ${id}): ${problems.join('; ')}`, { problems });
  const guardianInvalid = (id, problems) => refusal('GUARDIAN_RECORD_INVALID', `a guardian record was refused (guardian ${id}): ${problems.join('; ')}`, { problems });
  const noPlayer = (id) => refusal('PLAYER_NOT_FOUND', `player ${id} does not exist`);
  const noGuardian = (id) => refusal('GUARDIAN_NOT_FOUND', `guardian ${id} does not exist`);
  const emailOwner = (email, exceptId = null) => (typeof email === 'string' ? q('SELECT id FROM guardians WHERE lower(email) = lower(?) AND id IS NOT ?').get(email, exceptId)?.id ?? null : null);
  const isRetainedId = (id) => !!q('SELECT 1 FROM players WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  const readInitState = () => {
    const row = q('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META);
    if (!row) return 'done';
    if (row.value !== 'pending' && row.value !== 'done') throw new Error(`core identity: meta.${CORE_IDENTITY_INIT_META} holds ${JSON.stringify(row.value)}, which is neither "pending" nor "done"`);
    return row.value;
  };

  // ---------------------------------------------------------- filters for the scans (SQL prefilters; callers keep the exact rules)
  /**
   * `{ visibleTo: org, adultsOnly, position, availability, country, academyPlus, notLevel, createdSince, ageAtLeast, ageBelow, exceptId }`.
   * `visibleTo` applies what SQL can of the visibility rule: the under-18 wall (by the country's age of majority) for an
   * organisation that cannot see minors, and for a grassroots club "not pro, inside the box around the ground" (a club
   * without a ground sees nobody). The caller still applies visibleToOrg and the blocks.
   */
  const scanWhere = (f = {}, at = now()) => {
    const sql = ['p.deleted_at IS NULL']; const args = [];
    const adults = () => { const a = adultsSql(at); sql.push(a.sql); args.push(...a.args); };
    if (f.visibleTo) {
      const org = f.visibleTo;
      if (!seesMinors(org)) adults();
      if ((org.level ?? null) === 'grassroots') {
        if (!org.location) return null;
        // The box narrows by index; the exact radius is domain.mjs haversineKm, as visibleToOrg applies it.
        const box = boxAround(org.location, GRASSROOTS_RADIUS_KM); const lngs = lngRanges(box);
        sql.push("p.level <> 'pro'", `p.lat IS NOT NULL AND p.lat BETWEEN ? AND ? AND (${lngs.map(() => 'p.lng BETWEEN ? AND ?').join(' OR ')})`, 'haversine_km(?, ?, p.lat, p.lng) <= ?');
        args.push(box.minLat, box.maxLat, ...lngs.flat(), org.location.lat, org.location.lng, GRASSROOTS_RADIUS_KM);
      }
      // A player who blocked the organisation is not a candidate (isBlocked, the safety tables').
      if (hasBlocks()) { sql.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE b.player_id = p.id AND b.org_id = ?)'); args.push(org.id); }
    }
    if (f.adultsOnly) adults();
    for (const [k, col] of [['position', 'position'], ['availability', 'availability'], ['country', 'country']]) if (f[k] !== undefined && f[k] !== null) { sql.push(`p.${col} = ?`); args.push(f[k]); }
    if (f.academyPlus === true) sql.push('p.academy_plus = 1');
    if (typeof f.notLevel === 'string') { sql.push('p.level <> ?'); args.push(f.notLevel); }
    if (Number.isFinite(f.createdSince)) { sql.push('p.created_at >= ?'); args.push(f.createdSince); }
    if (Number.isSafeInteger(f.ageAtLeast)) { sql.push('p.birth_date <= ?'); args.push(bornByForAge(f.ageAtLeast, at)); }
    if (Number.isSafeInteger(f.ageBelow)) { sql.push('p.birth_date > ?'); args.push(bornByForAge(f.ageBelow, at)); }
    if (typeof f.exceptId === 'string') { sql.push('p.id <> ?'); args.push(f.exceptId); }
    // `positions`: the position is one of these (and `orNoPosition`: or none is declared).
    if (Array.isArray(f.positions)) { sql.push(`(p.position IN (SELECT value FROM json_each(?))${f.orNoPosition ? ' OR p.position IS NULL' : ''})`); args.push(JSON.stringify(f.positions)); }
    if (typeof f.text === 'string' && f.text) {
      // The directory's search: name or country, and the city of an adult only (a minor's city is never shown to a club,
      // so it is never matched either), case-insensitively as JavaScript lowers text.
      const a = adultsSql(at);
      sql.push(`(instr(lower_js(p.name), ?) > 0 OR instr(lower_js(p.country), ?) > 0 OR (p.city IS NOT NULL AND instr(lower_js(p.city), ?) > 0 AND ${a.sql}))`);
      const needle = f.text.toLowerCase(); args.push(needle, needle, needle, ...a.args);
    }
    return { sql: sql.join(' AND '), args };
  };
  /** Visit the players a filter admits, in creation order, decoding a batch at a time; `visit` returning false stops the scan. */
  const scan = (filter, visit) => {
    const w = scanWhere(filter);
    if (!w) return;
    let after = 0;
    for (;;) {
      const rows = q(`SELECT p.rowid AS rid, ${P_COLS.map((c) => `p.${c}`).join(', ')} FROM players p WHERE ${w.sql} AND p.rowid > ? ORDER BY p.rowid LIMIT ?`).all(...w.args, after, SCAN_BATCH);
      if (!rows.length) return;
      after = rows[rows.length - 1].rid;
      for (const rec of decodePlayers(rows)) if (visit(rec) === false) return;
      if (rows.length < SCAN_BATCH) return;
    }
  };

  /**
   * Keyset paging over the admitted players. `order` lists `[sqlExpression, 'ASC' | 'DESC', args?]`, the last one unique
   * (the id); `after` is the previous page's last key. Returns the rows (with `k0…kN`, the key) of one page plus one.
   */
  const keysetRows = (w, order, { limit, after = null }) => {
    const keys = order.map(([expr], i) => `${expr} AS k${i}`).join(', ');
    const keyArgs = order.flatMap(([, , a = []]) => a);
    // (k0 beyond a0) OR (k0 = a0 AND k1 beyond a1) OR …: "beyond" is < for a descending key, > for an ascending one.
    // The leading key's bound is repeated on its own so the index can seek to the page instead of walking to it.
    const beyond = after ? ` WHERE k0 ${order[0][1] === 'DESC' ? '<=' : '>='} ? AND (${order.map((_, i) => `(${[...order.slice(0, i).map((__, j) => `k${j} = ?`), `k${i} ${order[i][1] === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`).join(' OR ')})` : '';
    const afterArgs = after ? [after[0], ...order.flatMap((_, i) => [...after.slice(0, i), after[i]])] : [];
    const sql = `SELECT * FROM (SELECT p.rowid AS rid, ${P_COLS.map((c) => `p.${c}`).join(', ')}, ${keys} FROM players p WHERE ${w.sql})${beyond} ORDER BY ${order.map(([, dir], i) => `k${i} ${dir}`).join(', ')} LIMIT ?`;
    return q(sql).all(...keyArgs, ...w.args, ...afterArgs, limit + 1);
  };
  const keyOfRow = (n) => (r) => Array.from({ length: n }, (_, i) => r[`k${i}`]);
  /** The order of the org directory (server.mjs /org/players): declared in its X-ScoutBox-Ordering header. */
  const directoryOrder = (org) => ((org.level ?? null) === 'grassroots'
    ? [['p.first_team_seeker', 'DESC'], ['distance_tenths(?, ?, p.lat, p.lng)', 'ASC', [org.location?.lat ?? null, org.location?.lng ?? null]], ['p.profile_signal', 'DESC'], ['p.id', 'ASC']]
    : [['p.academy_plus', 'DESC'], ['p.profile_signal', 'DESC'], ['p.id', 'ASC']]);

  // ---------------------------------------------------------- list operations (the rows of the player_* tables)
  const checkSubKey = (key) => { if (!SUBRECORD_KEYS.includes(key)) throw new TypeError(`"${key}" is not a player list; the lists are ${SUBRECORD_KEYS.join(', ')}`); };
  const subRefusal = (message) => refusal('PLAYER_SUBRECORD_INVALID', message);
  const subTarget = (id, key) => {
    checkSubKey(key);
    const rec = playerById(id);
    if (!rec) throw noPlayer(id);
    if (key === 'programme.completed' && rec.programme === null) throw subRefusal(`player ${id}: programme is null, so programme.completed cannot be written (start a programme first with players.startProgramme)`);
    return { rec, current: getSubrecords(rec, key) ?? [] };
  };
  const listOf = (id, key) => getSubrecords(playerById(id), key);

  /**
   * Write some columns of a live player. `cols` holds values, bound as parameters; `computed` holds SQL expressions of
   * the row's own columns, and comes from the act's code, never from a caller. A constraint failure (a CHECK, a STRICT
   * type) is a PLAYER_RECORD_INVALID naming the columns. Returns the stored record.
   */
  const setColumns = (id, cols, computed = {}) => operation(() => {
    const names = [...Object.keys(cols), ...Object.keys(computed)];
    const bad = Object.keys(cols).filter((c) => cols[c] !== null && typeof cols[c] === 'object');
    if (bad.length) throw playerInvalid(id, bad.map((c) => `${c} must be a single value`));
    const assign = [...Object.keys(cols).map((c) => `${c} = @${c}`), ...Object.entries(computed).map(([c, sql]) => `${c} = ${sql}`)].join(', ');
    const params = Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : v]));
    let changes;
    try { changes = q(`UPDATE players SET ${assign} WHERE id = @id AND deleted_at IS NULL`).run({ ...params, id }).changes; } catch (e) {
      if (isConstraintError(e)) throw playerInvalid(id, [`${names.join(', ')}: ${e.message}`]);
      throw e;
    }
    if (changes !== 1) throw noPlayer(id);
    refreshProfileSignals(sqlite, [id]);
    return playerById(id);
  });
  const flagOf = (id, field, v) => { if (typeof v !== 'boolean') throw playerInvalid(id, [`${field} must be a boolean`]); return v ? 1 : 0; };

  // ---------------------------------------------------------- link operations (both sides, one unit)
  const link = (guardianId, playerId, role = 'co') => operation(() => {
    if (role !== 'primary' && role !== 'co') throw new TypeError(`a link role is "primary" or "co", not ${JSON.stringify(role)}`);
    const g = guardianById(guardianId); const p = playerRow(playerId);
    if (!g) throw noGuardian(guardianId);
    if (!p) throw noPlayer(playerId);
    if (g.childIds.includes(playerId)) throw refusal('LINK_EXISTS', `guardian ${guardianId} already lists player ${playerId}`);
    if (role === 'primary' && p.guardian_id !== null) throw refusal('PRIMARY_EXISTS', `player ${playerId} already has a primary guardian (${p.guardian_id}); a second primary is refused — unlink or ageUp first`);
    q('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)').run(guardianId, playerId, role);
    if (role === 'primary') q('UPDATE players SET guardian_id = ? WHERE id = ?').run(guardianId, playerId);
    return { guardianId, playerId, role };
  });
  const unlink = (guardianId, playerId) => operation(() => {
    const p = playerRow(playerId);
    if (!q('SELECT 1 FROM guardians WHERE id = ?').get(guardianId)) throw noGuardian(guardianId);
    if (!p) throw noPlayer(playerId);
    const row = q('SELECT role FROM guardian_children WHERE guardian_id = ? AND player_id = ?').get(guardianId, playerId);
    if (!row) throw refusal('LINK_NOT_FOUND', `guardian ${guardianId} does not list player ${playerId}`);
    if (row.role === 'primary') q('UPDATE players SET guardian_id = NULL WHERE id = ?').run(playerId);
    q('DELETE FROM guardian_children WHERE guardian_id = ? AND player_id = ?').run(guardianId, playerId);
    return { guardianId, playerId, role: row.role };
  });

  // ---------------------------------------------------------- players
  const players = {
    /**
     * Create a player (`passwordHash` stored, never on the record). Absent optional fields take their defaults; junk is
     * refused by field. A record with `guardianId` is created with its primary link in the same unit; a minor (on
     * `now`) without one is refused. A retained id is never created again. Returns the stored record.
     */
    create: ({ passwordHash = null, ...fields } = {}) => operation(() => {
      const r = playerWithDefaults(fields);
      const problems = playerRecordProblems(r);
      const pw = passwordProblem(passwordHash); if (pw) problems.push(pw);
      if (problems.length) throw playerInvalid(r.id, problems);
      if (isRetainedId(r.id)) throw refusal('PLAYER_ID_RETAINED', `player ${r.id} was deleted and its id is retained; a deleted account is not created again under its id`);
      if (q('SELECT 1 FROM players WHERE id = ?').get(r.id)) throw refusal('PLAYER_EXISTS', `player ${r.id} already exists`);
      if (r.guardianId !== null && !q('SELECT 1 FROM guardians WHERE id = ?').get(r.guardianId)) throw refusal('GUARDIAN_NOT_FOUND', `player ${r.id} names guardian ${r.guardianId}, which does not exist`);
      if (r.guardianId === null && !isAdult(r, new Date(now()))) throw refusal('MINOR_WITHOUT_GUARDIAN', `player ${r.id} is a minor and has no guardianId: a child is created with its primary guardian and the link in the same transaction, never without`);
      q(P_INSERT).run(playerParams(r, passwordHash));
      writeChildRows(st, r);
      if (r.guardianId !== null) q("INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, 'primary')").run(r.guardianId, r.id);
      refreshProfileSignals(sqlite, [r.id]);
      return playerById(r.id);
    }),
    /*
     * The named acts, one per change a route makes. Each writes its own columns; the table's CHECKs judge the values,
     * and a refusal names the player and the field.
     */
    /** The availability, the contract status, or both (`{ availability, contractStatus }`, absent ones kept). */
    setAvailability: (id, { availability, contractStatus } = {}) => {
      const cols = {};
      if (availability !== undefined) cols.availability = availability;
      if (contractStatus !== undefined) cols.contract_status = contractStatus;
      if (!Object.keys(cols).length) throw new TypeError('players.setAvailability needs availability, contractStatus or both');
      return setColumns(id, cols);
    },
    setLevel: (id, level) => setColumns(id, { level }),
    /** The competition category, or null. */
    setFootballCategory: (id, category) => setColumns(id, { football_category: category }),
    setAcademyPlus: (id, on) => setColumns(id, { academy_plus: flagOf(id, 'academyPlus', on) }),
    setFirstTeamSeeker: (id, on) => setColumns(id, { first_team_seeker: flagOf(id, 'firstTeamSeeker', on) }),
    setMedicalSharing: (id, shared) => setColumns(id, { medical_shared: flagOf(id, 'medical.shared', shared) }),
    setConditionStatus: (id, status) => setColumns(id, { medical_condition_status: status }),
    /** `{ lat, lng }` and nothing else. */
    setLocation: (id, location) => {
      if (!isPlainObject(location) || Object.keys(location).some((k) => k !== 'lat' && k !== 'lng')) throw playerInvalid(id, [`location must be { lat, lng } (got ${describe(location)})`]);
      return setColumns(id, { lat: location.lat, lng: location.lng });
    },
    /**
     * Record current-season stats: the fields given replace theirs, the others are kept, and the appearances, goals
     * and assists read 0 rather than unknown once anything is recorded.
     */
    recordStats: (id, stats) => {
      if (!isPlainObject(stats)) throw playerInvalid(id, [`stats must be an object (got ${describe(stats)})`]);
      const unknown = Object.keys(stats).filter((k) => !STATS_KEYS.includes(k));
      if (unknown.length) throw playerInvalid(id, unknown.map((k) => `stats.${k} is not a stat`));
      const given = Object.entries(stats).filter(([, v]) => v !== undefined); // an undefined stat is an absent one
      const cols = Object.fromEntries(given.map(([k, v]) => [STATS_COLUMN[k], v]));
      const zeroIfUnknown = Object.fromEntries(['appearances', 'goals', 'assists'].filter((k) => stats[k] === undefined).map((k) => [STATS_COLUMN[k], `COALESCE(${STATS_COLUMN[k]}, 0)`]));
      return setColumns(id, cols, zeroIfUnknown);
    },
    /** Start (or switch to) a training track at `at`: the completed sessions of the previous track go in the same unit. */
    startProgramme: (id, track, at) => operation(() => {
      if (!isClock(at)) throw new TypeError('players.startProgramme: `at` must be a non-negative integer timestamp (ms)');
      const stored = setColumns(id, { programme_track: track, programme_started_at: at });
      if (!stored.programme.completed.length) return stored;
      st['programme.completed'].deleteAll.run(id);
      return playerById(id);
    }),
    /** Replace the notification preferences (`{ quietStart, quietEnd, schoolHoursMute, timezone }`), or clear them with null. */
    setNotificationPrefs: (id, prefs) => {
      const n = prefs ?? NO_PREFS;
      const problems = prefsReplacementProblems(n);
      if (problems.length) throw playerInvalid(id, problems);
      return setColumns(id, { prefs_quiet_start: n.quietStart, prefs_quiet_end: n.quietEnd, prefs_school_hours_mute: nb(n.schoolHoursMute), prefs_timezone: n.timezone });
    },
    /** Store a new password hash (or null). Returns the stored record. */
    setPasswordHash: (id, hash) => operation(() => {
      const pw = passwordProblem(hash); if (pw) throw playerInvalid(id, [pw]);
      if (q('UPDATE players SET password_hash = ? WHERE id = ? AND deleted_at IS NULL').run(hash, id).changes !== 1) throw noPlayer(id);
      return playerById(id);
    }),

    /** Append one item to a player's `key` list (validated with the whole list); returns the stored list. */
    addItem: (id, key, item) => operation(() => {
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
    setItems: (id, key, items) => operation(() => {
      subTarget(id, key);
      if (!Array.isArray(items)) throw new TypeError(`players.setItems needs an array for ${key} (got ${describe(items)})`);
      const next = clone(items);
      const problems = validateSubrecordArray(key, next);
      if (problems.length) throw subRefusal(`replacing ${key} of player ${id} was refused: ${problems.join('; ')}`);
      st[key].deleteAll.run(id); // a clip's tags cascade with the clip
      writeArrayRows(st, key, id, next);
      refreshProfileSignals(sqlite, [id]);
      return listOf(id, key);
    }),
    /** Change fields of the ONE item of `key` that `where` matches (`{ id }`, `{ season }`); returns the stored item. */
    patchItem: (id, key, where, patch) => operation(() => {
      const { current } = subTarget(id, key);
      if (SUBRECORD_SPECS[key].primitive) throw new TypeError(`${key} holds plain values; replace the list with players.setItems`);
      if (!isPlainObject(where) || !Object.keys(where).length) throw new TypeError('players.patchItem needs a where object ({ id } or another equality test)');
      if (!isPlainObject(patch)) throw new TypeError('players.patchItem needs a patch object');
      const matches = current.map((_, i) => i).filter((i) => Object.keys(where).every((k) => current[i][k] === where[k]));
      if (matches.length !== 1) throw subRefusal(`players.patchItem: ${matches.length} item(s) of ${key} of player ${id} match ${JSON.stringify(where)}; exactly one must`);
      const index = matches[0];
      const merged = clone(current[index]);
      for (const k of Object.keys(patch)) if (patch[k] !== undefined) merged[k] = clone(patch[k]);
      const items = current.map((it, i) => (i === index ? merged : it));
      const problems = validateSubrecordArray(key, items);
      if (problems.length) throw subRefusal(`changing ${key} of player ${id} was refused: ${problems.join('; ')}`);
      const { row, tags } = itemRows(key, merged, index, id);
      if (st[key].update.run(row).changes !== 1) throw new Error(`players.patchItem: the ${key} row of player ${id} at position ${index} is not in the table`);
      if (SUBRECORD_SPECS[key].children === 'tags' && Object.hasOwn(patch, 'tags')) { st.tags.deleteMedia.run(merged.id); for (const t of tags ?? []) st.tags.insert.run(t); }
      return deepFreeze(storedItem(key, merged));
    }),

    /** Aging-up: the PRIMARY link goes and `guardianId` becomes null, in one unit; co-guardians keep listing the player. */
    ageUp: (id) => operation(() => {
      const p = playerRow(id);
      if (!p) throw noPlayer(id);
      if (p.guardian_id === null) throw refusal('NO_PRIMARY_GUARDIAN', `player ${id} has no primary guardian; nothing to age up`);
      unlink(p.guardian_id, id);
      return { playerId: id, guardianId: p.guardian_id };
    }),
    /**
     * The account deletion: the row stays, reduced to the retained record; the lists and links are deleted.
     * A retained id is refused. Sessions, codes and the media queue are the caller's acts in the same unit.
     */
    erase: (id, { at = now() } = {}) => operation(() => {
      if (isRetainedId(id)) throw refusal('PLAYER_ID_RETAINED', `player ${id} was deleted and its id is retained; it cannot be erased again`);
      const p = playerRow(id);
      if (!p) throw noPlayer(id);
      if (!isClock(at)) throw new TypeError('players.erase: `at` must be a non-negative integer timestamp (ms)');
      deleteChildRows(st, id);
      q('DELETE FROM guardian_children WHERE player_id = ?').run(id);
      if (q(ERASE_SQL).run(eraseParamsFor({ id, deletedAt: at, birthDate: p.birth_date, country: p.country })).changes !== 1) throw noPlayer(id);
      return { id, deletedAt: at };
    }),
    link: (guardianId, playerId, role) => link(guardianId, playerId, role),
    unlink,

    // ---------------------------------------------------------- reads
    byId: playerById,
    /** Many players by id, in the order given (missing ids are left out); their lists in one query per table. */
    byIds: (ids) => {
      const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))];
      if (!list.length) return [];
      const rows = q(`${P_SELECT} WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list));
      const byKey = new Map(decodePlayers(rows).map((r) => [r.id, r]));
      return list.map((x) => byKey.get(x)).filter(Boolean);
    },
    exists: (id) => !!playerRow(id),
    /** The player whose media list holds this clip id (clip ids are unique across players), or null. */
    byMediaId: (mediaId) => (typeof mediaId === 'string' && mediaId ? playerById(q('SELECT player_id FROM player_media WHERE id = ?').get(mediaId)?.player_id ?? null) : null),
    /** Players whose PRIMARY guardian is this guardian. */
    byGuardian: (guardianId) => decodePlayers(q(`${P_SELECT} WHERE guardian_id = ? AND deleted_at IS NULL ORDER BY rowid`).all(guardianId)),
    /** The first player (creation order) holding this provider's external id, or null (the import's identity match). */
    byExternalId: (provider, externalId) => playerById(q('SELECT e.player_id FROM player_external_ids e JOIN players p ON p.id = e.player_id WHERE e.provider = ? AND e.external_id = ? ORDER BY p.rowid LIMIT 1').get(provider, externalId)?.player_id ?? null),
    /** The first player (creation order) with this name (case-insensitive) and date of birth, or null. */
    byNameAndDob: (name, dob) => {
      if (typeof name !== 'string' || typeof dob !== 'string') return null;
      const key = name.toLowerCase();
      const hit = q('SELECT id, name FROM players WHERE birth_date = ? AND deleted_at IS NULL ORDER BY rowid').all(dob).find((r) => r.name.toLowerCase() === key);
      return hit ? playerById(hit.id) : null;
    },
    /** Visit the players a filter admits (see scanWhere), in creation order; `visit` returning false stops. */
    scan,
    /** The players a filter admits, in creation order (`limit` caps the count). */
    list: (filter = {}, { limit = Infinity } = {}) => { const out = []; scan(filter, (r) => { out.push(r); return out.length < limit; }); return out; },
    /** The live players the organisation may see (see scanWhere: the whole visibility rule), with the further filters. */
    visibleCandidates: (org, filter = {}, opts = {}) => players.list({ ...filter, visibleTo: org }, opts),
    /**
     * The whole visibility rule for `org` as SQL over `players p` (the wall, the Grassroots radius, the blocks),
     * for a read that joins the players to another domain's rows (the match facts). `{ sql, args }`, or null when the
     * organisation can see nobody (a Grassroots club without a ground).
     */
    visibleWhere: (org, at = now()) => scanWhere({ visibleTo: org }, at),
    /**
     * One page of the organisation's player directory, in the directory's declared order (directoryOrder), with
     * the scan filters plus `text`. `page` is `{ limit, after }` from readPage(query, directoryCursorShape(org)).
     */
    directoryPage: (org, filter = {}, page) => {
      const w = scanWhere({ ...filter, visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const order = directoryOrder(org);
      const rows = keysetRows(w, order, page);
      const out = pageOf(rows, page.limit, keyOfRow(order.length));
      return { items: decodePlayers(out.items), nextCursor: out.nextCursor };
    },
    /**
     * One page of the players an organisation may see (the whole rule, see scanWhere) in a caller's order: `order` as
     * keysetRows takes it (the last key unique), `where` further `{ sql, args }` conditions on `p`. Items are decoded.
     */
    visiblePage: (org, filter = {}, { order, where = [] }, page) => {
      const w = scanWhere({ ...filter, visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      for (const c of where) { w.sql += ` AND (${c.sql})`; w.args.push(...(c.args ?? [])); }
      const out = pageOf(keysetRows(w, order, page), page.limit, keyOfRow(order.length));
      return { items: decodePlayers(out.items), nextCursor: out.nextCursor, keys: out.items.map(keyOfRow(order.length)) };
    },
    /**
     * Visit the admitted players as LIGHT records, in creation order: the row's own fields (no lists, no trial
     * reports) plus `profileSignal`, for reads that rank every candidate and then decode only the winners (similar
     * players, the discovery rotation). `visit` returning false stops.
     */
    scanLight: (filter, visit) => {
      const w = scanWhere(filter);
      if (!w) return;
      let after = 0;
      for (;;) {
        const rows = q(`SELECT p.rowid AS rid, ${LIGHT_COLS.map((c) => `p.${c}`).join(', ')} FROM players p WHERE ${w.sql} AND p.rowid > ? ORDER BY p.rowid LIMIT ?`).all(...w.args, after, SCAN_BATCH * 10);
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
    clipPage: (org, page) => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const order = [['k0', 'DESC'], ['k1', 'DESC'], ['k2', 'ASC'], ['k3', 'ASC']];
      // The leading key's bound is repeated so the index seeks to the page.
      const cols = ['(m.verified_clip_attendance_id IS NOT NULL)', 'm.views', 'm.player_id', 'm.position'];
      const beyond = page.after ? ` AND ${cols[0]} <= ? AND (${order.map((_, i) => `(${[...cols.slice(0, i).map((c) => `${c} = ?`), `${cols[i]} ${order[i][1] === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`).join(' OR ')})` : '';
      const afterArgs = page.after ? [page.after[0], ...order.flatMap((_, i) => [...page.after.slice(0, i), page.after[i]])] : [];
      const rows = q(`SELECT m.player_id AS player_id, m.id AS media_id, ${cols.map((c, i) => `${c} AS k${i}`).join(', ')}
        FROM player_media m JOIN players p ON p.id = m.player_id WHERE m.url IS NOT NULL AND ${w.sql}${beyond}
        ORDER BY (m.verified_clip_attendance_id IS NOT NULL) DESC, m.views DESC, m.player_id, m.position LIMIT ?`).all(...w.args, ...afterArgs, page.limit + 1);
      const out = pageOf(rows, page.limit, (r) => [r.k0, r.k1, r.k2, r.k3]);
      const byPlayer = new Map(players.byIds(out.items.map((r) => r.player_id)).map((p) => [p.id, p]));
      return {
        items: out.items.map((r) => { const player = byPlayer.get(r.player_id); return player ? { player, media: player.media.find((m) => m.id === r.media_id) } : null; }).filter((x) => x?.media),
        nextCursor: out.nextCursor,
      };
    },
    /**
     * The fixture graph: one page of the (fixture, date) groups of the attendances of the players the
     * organisation may see, the newest date first, then the fixture name. Each group lists its attendances in the
     * players' creation order (a player may appear twice), with the venue of the first. `{ items, nextCursor }`.
     */
    fixturePage: (org, page) => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { items: [], nextCursor: null };
      const beyond = page.after ? ' AND (a.match_date < ? OR (a.match_date = ? AND a.fixture > ?))' : '';
      const groups = q(`SELECT a.match_date AS date, a.fixture AS fixture FROM player_attendance a JOIN players p ON p.id = a.player_id
        WHERE ${w.sql}${beyond} GROUP BY a.match_date, a.fixture ORDER BY a.match_date DESC, a.fixture ASC LIMIT ?`).all(...w.args, ...(page.after ? [page.after[0], page.after[0], page.after[1]] : []), page.limit + 1);
      const out = pageOf(groups, page.limit, (g) => [g.date, g.fixture]);
      if (!out.items.length) return { items: [], nextCursor: null };
      const members = q(`SELECT a.match_date AS date, a.fixture AS fixture, a.venue AS venue, ${LIGHT_COLS.map((c) => `p.${c}`).join(', ')}
        FROM json_each(?) j CROSS JOIN player_attendance a ON a.match_date = j.value ->> 0 AND a.fixture = j.value ->> 1 JOIN players p ON p.id = a.player_id
        WHERE ${w.sql} ORDER BY p.rowid, a.position`).all(JSON.stringify(out.items.map((g) => [g.date, g.fixture])), ...w.args);
      const byKey = new Map(out.items.map((g) => [`${g.fixture}|${g.date}`, { fixture: g.fixture, venue: undefined, date: g.date, players: [] }]));
      for (const m of members) { const g = byKey.get(`${m.fixture}|${m.date}`); if (g.venue === undefined) g.venue = m.venue; g.players.push(lightFromRow(m)); }
      return { items: [...byKey.values()], nextCursor: out.nextCursor };
    },
    /**
     * The club feed's player half: the admitted players created since `since` and the clips uploaded since
     * then, each newest first and at most `limit`: `{ players: [light], clips: [{ player: light, media }] }`.
     */
    recentFor: (org, since, limit) => {
      const w = scanWhere({ visibleTo: org });
      if (!w) return { players: [], clips: [] };
      const fresh = q(`SELECT ${LIGHT_COLS.map((c) => `p.${c}`).join(', ')} FROM players p WHERE ${w.sql} AND p.created_at >= ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`).all(...w.args, since, limit).map(lightFromRow);
      const clipRows = q(`SELECT m.player_id, m.id AS media_id FROM player_media m JOIN players p ON p.id = m.player_id
        WHERE m.uploaded_at >= ? AND ${w.sql} ORDER BY m.uploaded_at DESC, m.rowid DESC LIMIT ?`).all(new Date(since).toISOString(), ...w.args, limit);
      const byPlayer = new Map(players.byIds(clipRows.map((r) => r.player_id)).map((p) => [p.id, p]));
      const clips = clipRows.map((r) => { const player = byPlayer.get(r.player_id); const media = player?.media.find((m) => m.id === r.media_id); return media ? { player, media } : null; }).filter(Boolean);
      return { players: fresh, clips };
    },
    /**
     * Every live player's best result per drill (the benchmarks' cohort), for the players a scan filter admits:
     * Map drill id → [{ playerId, max, min }]. One GROUP BY; no player is decoded.
     */
    drillBests: (filter = {}) => {
      const w = scanWhere(filter);
      const out = new Map();
      if (!w) return out;
      for (const r of q(`SELECT d.drill_id, d.player_id, MAX(d.value) AS max, MIN(d.value) AS min FROM player_drill_results d JOIN players p ON p.id = d.player_id WHERE ${w.sql} GROUP BY d.drill_id, d.player_id ORDER BY d.drill_id, p.rowid`).all(...w.args)) {
        if (!out.has(r.drill_id)) out.set(r.drill_id, []);
        out.get(r.drill_id).push({ playerId: r.player_id, max: r.max, min: r.min });
      }
      return out;
    },
    directoryCursorShape: (org) => directoryOrder(org).map((_, i, all) => (i === all.length - 1 ? 'string' : 'number')),
    count: () => q('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NULL').get().n,
    /** The stored password hash for the sign-in check (never on a record), or null. */
    passwordHashOf: (id) => q('SELECT password_hash FROM players WHERE id = ? AND deleted_at IS NULL').get(id)?.password_hash ?? null,
    /** Rows per list table (counts only), for reports. */
    subrecordRows: () => countChildRows(st),
    /** The narrow accessors of the retained records. No route serves one. */
    retained: (id) => { const r = typeof id === 'string' ? q('SELECT id, deleted_at, birth_date, country FROM players WHERE id = ? AND deleted_at IS NOT NULL').get(id) : null; return r ? retainedRecordFromRow(r) : null; },
    isRetained: (id) => isRetainedId(id),
    retainedRecords: () => q('SELECT id, deleted_at, birth_date, country FROM players WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id').all().map(retainedRecordFromRow),
    retainedCount: () => q('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NOT NULL').get().n,
  };

  // ---------------------------------------------------------- guardians
  const guardians = {
    /**
     * Create a guardian (`passwordHash` and `emailCodeHash` stored, never on the record). `childIds` given here become
     * link rows in the same unit (`primary` where the child's guardianId names this guardian, `co` otherwise); the
     * e-mail must be unique case-insensitively and `coGuardianOf` must name an existing guardian. Returns the record.
     */
    create: ({ passwordHash = null, emailCodeHash = null, ...fields } = {}) => operation(() => {
      const r = guardianWithDefaults(fields);
      const problems = guardianRecordProblems(r);
      const pw = passwordProblem(passwordHash); if (pw) problems.push(pw);
      const ch = codeHashProblem(emailCodeHash); if (ch) problems.push(ch);
      if (problems.length) throw guardianInvalid(r.id, problems);
      if (q('SELECT 1 FROM guardians WHERE id = ?').get(r.id)) throw refusal('GUARDIAN_EXISTS', `guardian ${r.id} already exists`);
      const taken = emailOwner(r.email);
      if (taken) throw refusal('EMAIL_IN_USE', `another guardian (${taken}) already uses this e-mail (compared case-insensitively)`);
      if (r.coGuardianOf !== null && !q('SELECT 1 FROM guardians WHERE id = ?').get(r.coGuardianOf)) throw refusal('GUARDIAN_NOT_FOUND', `coGuardianOf names guardian ${r.coGuardianOf}, which does not exist`);
      const kids = r.childIds.map((childId) => { const p = playerRow(childId); if (!p) throw refusal('PLAYER_NOT_FOUND', `childIds names player ${childId}, which does not exist`); return p; });
      q(G_INSERT).run(guardianParams(r, { passwordHash, emailCodeHash }));
      for (const p of kids) q('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)').run(r.id, p.id, p.guardian_id === r.id ? 'primary' : 'co');
      return guardianById(r.id);
    }),
    /*
     * The safeguarding gates. No act un-verifies an e-mail or withdraws an accepted disclaimer, and the first
     * acceptance time is kept. Only Trust & Safety's ID review (`reviewIdCheck`) turns `idVerified` off again.
     */
    /** Mark the e-mail verified and clear the spent code's hash. A second call changes nothing. */
    verifyEmail: (id) => operation(() => {
      if (!q('UPDATE guardians SET email_verified = 1, email_code_hash = NULL WHERE id = ? AND email_verified = 0').run(id).changes && !guardianById(id)) throw noGuardian(id);
      return guardianById(id);
    }),
    /** A passed ID check from the provider: verified, with the provider's reference. */
    recordIdCheck: (id, { reference }) => operation(() => {
      if (!textOk(reference, L.idvReference)) throw guardianInvalid(id, [`idvReference must be text of 1 to ${L.idvReference} characters`]);
      if (q('UPDATE guardians SET id_verified = 1, idv_reference = ? WHERE id = ?').run(reference, id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    /** Trust & Safety's review of the ID check: approve, or revoke. */
    reviewIdCheck: (id, approved) => operation(() => {
      if (typeof approved !== 'boolean') throw guardianInvalid(id, ['approved must be a boolean']);
      if (q('UPDATE guardians SET id_verified = ? WHERE id = ?').run(b(approved), id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    /** Accept the safeguarding disclaimer at `at`; a later acceptance keeps the first time. */
    acceptDisclaimer: (id, at) => operation(() => {
      if (!isClock(at)) throw new TypeError('guardians.acceptDisclaimer: `at` must be a non-negative integer timestamp (ms)');
      if (q('UPDATE guardians SET disclaimer_accepted = 1, disclaimer_accepted_at = COALESCE(disclaimer_accepted_at, ?) WHERE id = ?').run(at, id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    /** Replace the notification preferences (`{ quietStart, quietEnd, schoolHoursMute, timezone }`), or clear them with null. */
    setNotificationPrefs: (id, prefs) => operation(() => {
      const n = prefs ?? NO_PREFS;
      const problems = prefsReplacementProblems(n);
      if (problems.length) throw guardianInvalid(id, problems);
      if (q('UPDATE guardians SET prefs_quiet_start = ?, prefs_quiet_end = ?, prefs_school_hours_mute = ?, prefs_timezone = ? WHERE id = ?')
        .run(n.quietStart, n.quietEnd, nb(n.schoolHoursMute), n.timezone, id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    setPasswordHash: (id, hash) => operation(() => {
      const pw = passwordProblem(hash); if (pw) throw guardianInvalid(id, [pw]);
      if (q('UPDATE guardians SET password_hash = ? WHERE id = ?').run(hash, id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    setEmailCodeHash: (id, hash) => operation(() => {
      const ch = codeHashProblem(hash); if (ch) throw guardianInvalid(id, [ch]);
      if (q('UPDATE guardians SET email_code_hash = ? WHERE id = ?').run(hash, id).changes !== 1) throw noGuardian(id);
      return guardianById(id);
    }),
    link: (guardianId, playerId, role) => link(guardianId, playerId, role),
    unlink,

    byId: guardianById,
    byIds: (ids) => {
      const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))];
      if (!list.length) return [];
      const byKey = new Map(decodeGuardians(q(`${G_SELECT} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list))).map((g) => [g.id, g]));
      return list.map((x) => byKey.get(x)).filter(Boolean);
    },
    /** The guardian with this e-mail (case-insensitive), or null. */
    byEmail: (email) => { const id = emailOwner(email); return id ? guardianById(id) : null; },
    emailTaken: (email, exceptId = null) => emailOwner(email, exceptId) !== null,
    /** The guardians listing this player, with their role. */
    linksOf: (playerId) => q('SELECT guardian_id, role FROM guardian_children WHERE player_id = ? ORDER BY rowid').all(playerId).map((l) => ({ guardianId: l.guardian_id, role: l.role })),
    /** The guardians listing this player (records), primary first. */
    forPlayer: (playerId) => guardians.byIds(q("SELECT guardian_id FROM guardian_children WHERE player_id = ? ORDER BY role = 'primary' DESC, rowid").all(playerId).map((l) => l.guardian_id)),
    childIds: (id) => q('SELECT player_id FROM guardian_children WHERE guardian_id = ? ORDER BY rowid').all(id).map((l) => l.player_id),
    /** One page of every guardian, oldest first; `page` is the route's `readPage(query, ['number'])`: `{ items, nextCursor }`. */
    page: ({ limit, after = null }) => {
      const rows = q(`SELECT rowid AS rid, ${G_COLS.join(', ')} FROM guardians WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(after ? after[0] : 0, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.rid]);
      return { items: decodeGuardians(page.items), nextCursor: page.nextCursor };
    },
    count: () => q('SELECT COUNT(*) AS n FROM guardians').get().n,
    passwordHashOf: (id) => q('SELECT password_hash FROM guardians WHERE id = ?').get(id)?.password_hash ?? null,
    emailCodeHashOf: (id) => q('SELECT email_code_hash FROM guardians WHERE id = ?').get(id)?.email_code_hash ?? null,
  };

  const identity = {
    players,
    guardians,
    link,
    unlink,
    initState: () => readInitState(),
    cutOver: () => cutOver(sqlite),
    attach() {
      if (readInitState() === 'pending') throw new Error(`core identity: initialisation is pending (meta.${CORE_IDENTITY_INIT_META}); call initialize() with the first installation's records instead of attach()`);
      const counts = identity.report();
      log(`core identity: ${counts.players} player(s), ${counts.guardians} guardian(s) in the tables`);
      return { engine: 'sqlite', players: counts.players, guardians: counts.guardians, links: counts.links, imported: 0 };
    },
    /**
     * First-installation initialisation: type the given records (the seed, with their hashes) and write them with the
     * state `done` in one transaction. Allowed only while the state is `pending` and the tables are empty; a refused
     * seed writes nothing and the state stays `pending`.
     */
    initialize(seed, { now: at = now() } = {}) {
      if (readInitState() !== 'pending') throw new Error(`core identity: already initialised (meta.${CORE_IDENTITY_INIT_META} is "done"); the tables are authoritative and nothing is imported`);
      const stored = q('SELECT (SELECT COUNT(*) FROM players) + (SELECT COUNT(*) FROM guardians) AS n').get().n;
      if (stored) throw new Error(`core identity: initialisation is pending but the tables already hold ${stored} row(s) written outside the repositories; refusing to initialise over them`);
      if (sqlite.isTransaction) throw new Error('core identity: initialize() runs in a transaction of its own and cannot start inside an open transaction');
      if (!isPlainObject(seed)) throw new TypeError(`core identity: initialize() needs { players, guardians } (got ${describe(seed)}); nothing was written and initialisation stays pending`);
      let typed;
      try { typed = typeIdentitySnapshot(seed, { now: at }); } catch (err) {
        throw Object.assign(new Error(`CORE_IDENTITY_CUTOVER_BLOCKED: ${err.message}; initialisation stays pending`), { code: 'CORE_IDENTITY_CUTOVER_BLOCKED', problems: err.problems ?? [] });
      }
      const counts = transaction(sqlite, () => { const c = writeIdentity(sqlite, typed); q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CORE_IDENTITY_INIT_META, 'done'); return c; });
      log(`core identity: initialised ${counts.players} player(s), ${counts.guardians} guardian(s) and ${counts.links} link(s) from the first installation's records`);
      return { engine: 'sqlite', ...counts, imported: counts.players + counts.guardians };
    },
    report: () => ({ players: players.count(), retained: players.retainedCount(), guardians: guardians.count(), links: q('SELECT COUNT(*) AS n FROM guardian_children').get().n, initState: readInitState() }),
  };
  const readsOf = (repo) => Object.freeze(Object.fromEntries(Object.entries(repo).filter(([k, v]) => typeof v === 'function' && !WRITES.has(k))));
  players.reads = readsOf(players);
  guardians.reads = readsOf(guardians);
  return identity;
}
