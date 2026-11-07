/**
 * Players and guardians: typed tables with explicit writes (S4a, migration `0005_core_identity_live`; explicit since
 * S14h, docs/architecture/migration.md §4.6; sql/01_identity.sql).
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
 * The lists are rows of the `player_*` tables (playerSubrecords.mjs), written only through `addItem`, `setItems` and
 * `patchItem`; `trialReports` is the trials' reports (the recruitment tables), written nowhere here.
 *
 * Guardian record: { id, name, email, emailVerified, idVerified, idvReference, disclaimerAccepted, disclaimerAcceptedAt,
 *   coGuardianOf, notificationPrefs, createdAt, childIds, coGuardians }
 * `childIds` is the guardian's link rows (in their order); `coGuardians` is the guardians whose `co_guardian_of` names
 * this one, as `{ id, name, email }`.
 *
 * Password and e-mail-code hashes are never on a record (`passwordHashOf`, `setPasswordHash`, `emailCodeHashOf`,
 * `setEmailCodeHash`). Responses are allowlists.
 *
 * WRITES are explicit operations, each joining the open unit of work, the caller's transaction or its own: `create`,
 * `update(id, draft => …)`, the list operations, the link operations (`link`, `unlink`, `ageUp`) and the account
 * deletion (`erase`). READS are SQL: no mirror, no db.* view (`db.players` and `db.guardians` throw); fresh,
 * deep-frozen records; a list decodes its players' rows in one query per table. Refusals carry a code and name the
 * id and the field, never a value.
 *
 * Relationships. `players.guardian_id` and the `primary` row of `guardian_children` are written together and cannot
 * disagree; a minor is created with its primary link in the same transaction (an unlinked child cannot be created);
 * a guardian's e-mail is unique case-insensitively. `ageUp` clears the primary link only (co-guardians keep listing
 * the player, as before).
 *
 * The retained record (S4b-R; the Founder's decisions: the full birth date, 12 October 2026, and the country code
 * kept, 21 October 2026): an account deletion keeps the player's row reduced to its id, the deletion instant, the
 * birth date and the country, with fixed placeholders in the other required columns; its lists and links are deleted
 * in the same unit. A retained row is served by nothing that serves accounts, only by the `retained*` accessors, and
 * its id is never created again. Not a retention policy.
 *
 * A first installation's players and guardians (the seed) are imported once by `initialize`, while
 * `meta.coreIdentityInit` is `pending` (set by the migration); a snapshot save settles it.
 */
import { transaction, migrationApplied } from './database.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { isAdult, ADULT_AGE, GRASSROOTS_RADIUS_KM } from '../domain.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { boxAround } from './grassroots.mjs';
import {
  SUBRECORD_KEYS, SUBRECORD_SPECS, PLAYER_SUBRECORD_KEYS, PLAYER_COMPOSITE_SUBRECORDS, subrecordsLive, getSubrecords,
  validateSubrecordArray, prepareSubrecordStatements, writeChildRows, writeArrayRows, deleteChildRows, readChildren,
  readChildrenFor, countChildRows, itemRows, storedItem, PLAYER_SUBRECORDS_MIGRATION,
} from './playerSubrecords.mjs';

export const CORE_IDENTITY_LIVE_MIGRATION = '0005_core_identity_live';
export const PLAYER_ERASURE_MIGRATION = '0014_player_erasure';
/** `meta` key holding the initialisation state (`pending` | `done`); absent reads as `done`. */
export const CORE_IDENTITY_INIT_META = 'coreIdentityInit';
/** The two snapshot collections the identity repositories own; coupled through the link rows. */
export const IDENTITY_COLLECTIONS = Object.freeze(['players', 'guardians']);
/** The backup / snapshot collection the retained records travel in (never inside `players`). */
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sqlReason = (err) => String(err?.message ?? err).replace(/^SQLITE_\w+:\s*/, '');
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] === undefined ? null : o[k]]));
const given = (raw) => Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)); // an undefined field is an absent one

// ------------------------------------------------------------------ the player record
export const PLAYER_SCALAR_KEYS = Object.freeze(['id', 'name', 'dob', 'country', 'city', 'position', 'foot', 'heightCm', 'weightKg', 'squadNumber',
  'contractUntil', 'marketValueRange', 'agentName', 'academyPlus', 'firstTeamSeeker', 'availability', 'contractStatus', 'level',
  'footballCategory', 'identityVerified', 'guardianId', 'createdAt']);
const STATS_KEYS = Object.freeze(['appearances', 'goals', 'assists', 'paceKmh', 'passCompletionPct', 'duelSuccessPct', 'cleanSheets']);
const STATS_COUNTS = Object.freeze(['appearances', 'goals', 'assists', 'cleanSheets']);
const PREFS_KEYS = Object.freeze(['quietStart', 'quietEnd', 'schoolHoursMute', 'timezone']);
export const PLAYER_RECORD_KEYS = Object.freeze([...PLAYER_SCALAR_KEYS, 'location', 'stats', 'medical', 'notificationPrefs', 'programme', ...PLAYER_SUBRECORD_KEYS, 'trialReports']);
const PLAYER_BOOLEANS = Object.freeze(['academyPlus', 'firstTeamSeeker', 'identityVerified']);
/** The fields `update` may change (the lists have their own operations, the guardian link its link operations). */
const PLAYER_EDITABLE = Object.freeze(['name', 'dob', 'country', 'city', 'position', 'foot', 'heightCm', 'weightKg', 'squadNumber', 'contractUntil',
  'marketValueRange', 'agentName', 'academyPlus', 'firstTeamSeeker', 'availability', 'contractStatus', 'level', 'footballCategory',
  'identityVerified', 'location', 'stats', 'medical', 'notificationPrefs', 'programme']);
const PLAYER_DEFAULTS = Object.freeze({ city: null, position: null, foot: null, heightCm: null, weightKg: null, squadNumber: null, contractUntil: null,
  marketValueRange: null, agentName: null, academyPlus: false, firstTeamSeeker: false, availability: 'not_seeking', contractStatus: 'unknown',
  level: 'amateur', footballCategory: null, identityVerified: false, guardianId: null, createdAt: null, location: null, stats: null,
  notificationPrefs: null, programme: null });

/** An incoming player (create, a snapshot, the seed) with its defaults: every field present, the lists as given (or empty). */
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
const passwordProblem = (h) => (h === null || textOk(h, L.passwordHash) ? null : `the password hash must be text of 1 to ${L.passwordHash} characters or null`);

const P_COLS = ['id', 'name', 'birth_date', 'country', 'city', 'position', 'foot', 'height_cm', 'weight_kg', 'squad_number', 'contract_until_date',
  'market_value_range', 'agent_name', 'academy_plus', 'first_team_seeker', 'availability', 'contract_status', 'level', 'football_category',
  'identity_verified', 'guardian_id', 'lat', 'lng', 'stats_appearances', 'stats_goals', 'stats_assists', 'stats_pace_kmh',
  'stats_pass_completion_pct', 'stats_duel_success_pct', 'stats_clean_sheets', 'medical_shared', 'medical_condition_status',
  'prefs_quiet_start', 'prefs_quiet_end', 'prefs_school_hours_mute', 'prefs_timezone', 'programme_track', 'programme_started_at',
  'password_hash', 'created_at', 'deleted_at'];
export const PLAYER_COLUMNS = Object.freeze(P_COLS);
const P_SELECT = `SELECT ${P_COLS.join(', ')} FROM players`;
const P_INSERT = `INSERT INTO players (${P_COLS.join(', ')}) VALUES (${P_COLS.map((c) => `@${c}`).join(', ')})`;
const P_UPDATE_COLS = P_COLS.filter((c) => !['id', 'guardian_id', 'password_hash', 'created_at', 'deleted_at'].includes(c));
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
    password_hash: passwordHash, created_at: r.createdAt, deleted_at: null,
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

// ------------------------------------------------------------------ the guardian record
export const GUARDIAN_RECORD_KEYS = Object.freeze(['id', 'name', 'email', 'emailVerified', 'idVerified', 'idvReference', 'disclaimerAccepted',
  'disclaimerAcceptedAt', 'coGuardianOf', 'notificationPrefs', 'createdAt', 'childIds', 'coGuardians']);
const GUARDIAN_BOOLEANS = Object.freeze(['emailVerified', 'idVerified', 'disclaimerAccepted']);
const GUARDIAN_EDITABLE = Object.freeze(['name', 'email', 'emailVerified', 'idVerified', 'idvReference', 'disclaimerAccepted', 'disclaimerAcceptedAt', 'notificationPrefs']);
const GUARDIAN_INPUT_KEYS = Object.freeze(GUARDIAN_RECORD_KEYS.filter((k) => k !== 'coGuardians'));
function guardianWithDefaults(raw) {
  const g = given(raw);
  const r = { emailVerified: false, idVerified: false, idvReference: null, disclaimerAccepted: false, disclaimerAcceptedAt: null, coGuardianOf: null, notificationPrefs: null, createdAt: null, childIds: [], ...g };
  if (isPlainObject(r.notificationPrefs)) r.notificationPrefs = { ...pick(r.notificationPrefs, PREFS_KEYS), ...Object.fromEntries(Object.entries(r.notificationPrefs).filter(([k]) => !PREFS_KEYS.includes(k))) };
  return r;
}
export function guardianRecordProblems(r, { input = true } = {}) {
  const out = [];
  const keys = input ? GUARDIAN_INPUT_KEYS : GUARDIAN_RECORD_KEYS;
  for (const k of Object.keys(r)) {
    if (keys.includes(k)) continue;
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
const G_UPDATE_COLS = ['name', 'email', 'email_verified', 'id_verified', 'idv_reference', 'disclaimer_accepted', 'disclaimer_accepted_at', 'prefs_quiet_start', 'prefs_quiet_end', 'prefs_school_hours_mute', 'prefs_timezone'];
const G_UPDATE = `UPDATE guardians SET ${G_UPDATE_COLS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`;
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

// ------------------------------------------------------------------ the retained record (S4b-R)
/** The fixed storage placeholders of a retained row: constants the table's constraints need, never read back as facts about the person. */
export const RETAINED_PLACEHOLDERS = Object.freeze({ name: RETAINED_PLAYER_NAME, academy_plus: 0, first_team_seeker: 0, availability: 'not_seeking', contract_status: 'unknown', level: 'amateur', identity_verified: 0, medical_shared: 0, medical_condition_status: 'unknown' });
const RETAINED_KEYS = Object.freeze(['id', 'deletedAt', 'birthDate', 'country']);
/** A retained record `{ id, deletedAt, birthDate, country }` → the full row (the kept facts, the placeholders, NULL elsewhere). */
export function retainedRowFor(rec) {
  const p = {}; for (const c of P_COLS) p[c] = null;
  p.id = rec.id; p.birth_date = rec.birthDate; p.country = rec.country; p.deleted_at = rec.deletedAt;
  return Object.assign(p, RETAINED_PLACEHOLDERS);
}
export const retainedRecordFromRow = (r) => ({ id: r.id, deletedAt: r.deleted_at, birthDate: r.birth_date, country: r.country });
const retainedRefusal = (message) => refusal('PLAYER_ERASURE_IMPORT_BLOCKED', message);
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
/** Validate a `playersRetained` collection against the live player ids; throws PLAYER_ERASURE_IMPORT_BLOCKED (ids and reasons only). */
export function checkRetainedCollection(list, { liveIds = new Set(), label = 'playersRetained' } = {}) {
  if (!Array.isArray(list)) throw retainedRefusal(`${label}: the playersRetained collection must be an array of retained records (got ${describe(list)}); nothing was written`);
  const problems = []; const seen = new Set(); const records = [];
  list.forEach((rec, i) => {
    const p = validateRetainedRecord(rec, i); if (p.length) { problems.push(...p); return; }
    if (seen.has(rec.id)) { problems.push(`playersRetained ${rec.id}: duplicate id`); return; }
    seen.add(rec.id);
    if (liveIds.has(rec.id)) { problems.push(`playersRetained ${rec.id}: the id is a live player; a retained record and an account never share an id`); return; }
    records.push(Object.freeze({ id: rec.id, deletedAt: rec.deletedAt, birthDate: rec.birthDate, country: rec.country }));
  });
  if (problems.length) throw retainedRefusal(`${label}: ${problems.length} retained record(s) refused (${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}); nothing was written`);
  return records;
}
/**
 * The retained records as a snapshot collection (null before migration 0014). `replace` may only ADD records: a stored
 * record that is not listed, or listed with a changed birth date, country or deletion instant, refuses the whole save
 * (RETAINED_RECORD_PROTECTED, ids only). An omitted collection keeps the rows as they are.
 */
export const PLAYERS_RETAINED = {
  name: PLAYERS_RETAINED_COLLECTION,
  cutOver: (sqlite) => migrationApplied(sqlite, PLAYER_ERASURE_MIGRATION),
  read(sqlite) {
    if (!this.cutOver(sqlite)) return null;
    return sqlite.prepare('SELECT id, deleted_at, birth_date, country FROM players WHERE deleted_at IS NOT NULL ORDER BY deleted_at, id').all().map(retainedRecordFromRow);
  },
  replace(sqlite, list) {
    if (!this.cutOver(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('playersRetained: replace() runs inside the caller\'s transaction');
    const liveIds = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NULL').all().map((r) => r.id));
    const records = checkRetainedCollection(list, { liveIds, label: 'the snapshot' });
    const stored = new Map(sqlite.prepare('SELECT id, deleted_at, birth_date, country FROM players WHERE deleted_at IS NOT NULL').all().map((r) => [r.id, retainedRecordFromRow(r)]));
    const supplied = new Map(records.map((r) => [r.id, r]));
    const missing = []; const amended = [];
    for (const [id, rec] of stored) {
      const g = supplied.get(id);
      if (!g) { missing.push(id); continue; }
      if (g.deletedAt !== rec.deletedAt || g.birthDate !== rec.birthDate || g.country !== rec.country) amended.push(id);
    }
    if (missing.length || amended.length) {
      const parts = [];
      if (missing.length) parts.push(`${missing.length} stored retained record(s) are not listed (${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''})`);
      if (amended.length) parts.push(`${amended.length} would be amended — the stored birth date, country or deletion instant differs from the listed one (${amended.slice(0, 20).join(', ')}${amended.length > 20 ? ', …' : ''})`);
      throw Object.assign(new Error(`RETAINED_RECORD_PROTECTED: the snapshot's playersRetained collection — ${parts.join('; ')}; a retained deletion record is never removed or amended by a save (a supplied collection may only add records); the save was rolled back and nothing was written`), { code: 'RETAINED_RECORD_PROTECTED', missing, amended });
    }
    const ins = sqlite.prepare(P_INSERT);
    for (const rec of records) if (!stored.has(rec.id)) ins.run(retainedRowFor(rec));
    return true;
  },
};
const ERASE_COLUMNS = Object.freeze(P_COLS.filter((c) => !['id', 'birth_date', 'country'].includes(c)));
const ERASE_SQL = `UPDATE players SET ${ERASE_COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND deleted_at IS NULL`;
const eraseParamsFor = (rec) => { const full = retainedRowFor(rec); const p = { id: rec.id }; for (const c of ERASE_COLUMNS) p[c] = full[c]; return p; };

// ------------------------------------------------------------------ typing a whole identity (the seed, a snapshot)
const blocked = (detail, extra = {}) => refusal('IDENTITY_IMPORT_BLOCKED', `${detail}; nothing was written`, extra);
/**
 * Type a snapshot pair `{ players, guardians }` (the records plus `password`, and a guardian's `emailCodeHash`): every
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
  return { players: typed.players.length, guardians: typed.guardians.length, links: typed.links.length };
}

const cutOver = (sqlite) => migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION);

/** Read every live player and guardian in snapshot form (the records plus their hashes; no trial reports, no coGuardians). */
function readIdentitySnapshot(sqlite) {
  const live = sqlite.prepare(`${P_SELECT} WHERE deleted_at IS NULL ORDER BY rowid`).all();
  const children = readChildrenFor(sqlite, live.map((d) => d.id));
  const players = live.map((d) => { const { trialReports: _derived, ...rec } = playerFromDb(d, children.get(d.id), []); return { ...rec, password: d.password_hash }; });
  const links = new Map();
  for (const l of sqlite.prepare('SELECT guardian_id, player_id FROM guardian_children ORDER BY rowid').all()) { if (!links.has(l.guardian_id)) links.set(l.guardian_id, []); links.get(l.guardian_id).push(l.player_id); }
  const guardians = sqlite.prepare(`${G_SELECT} ORDER BY rowid`).all().map((d) => { const { coGuardians: _derived, ...rec } = guardianFromDb(d, links.get(d.id) ?? [], []); return { ...rec, password: d.password_hash, emailCodeHash: d.email_code_hash }; });
  return { players, guardians };
}

/**
 * Whole-snapshot access for snapshot mode (tools, fixtures, the persistence suites). The two collections are coupled:
 * a snapshot carries both or neither. `replace` types the whole pair first (IDENTITY_IMPORT_BLOCKED, naming ids and
 * fields) and then rewrites the three tables; the retained rows stay as they are and their ids are refused as live
 * players.
 */
export const IDENTITY_SNAPSHOT = {
  names: IDENTITY_COLLECTIONS,
  cutOver,
  read(sqlite) { return cutOver(sqlite) ? readIdentitySnapshot(sqlite) : null; },
  replace(sqlite, { players, guardians }, { now = Date.now() } = {}) {
    if (!cutOver(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('identity snapshot: replace() runs inside the caller\'s transaction');
    const retainedIds = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL').all().map((r) => r.id));
    const typed = typeIdentitySnapshot({ players, guardians }, { now, retainedIds });
    sqlite.exec('DELETE FROM guardian_children');
    sqlite.exec('DELETE FROM players WHERE deleted_at IS NULL'); // the lists cascade
    sqlite.exec('UPDATE guardians SET co_guardian_of = NULL'); // RESTRICT is checked row by row
    sqlite.exec('DELETE FROM guardians');
    try { writeIdentity(sqlite, typed); } catch (err) { throw blocked(`the identity snapshot could not be stored (${sqlReason(err)})`); }
    const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`identity snapshot: foreign_key_check found ${broken.length} broken reference(s) after the write; the save was rolled back`);
    return true;
  },
};

// ------------------------------------------------------------------ the repositories
const WRITES = new Set(['create', 'update', 'setPasswordHash', 'setEmailCodeHash', 'addItem', 'setItems', 'patchItem', 'link', 'unlink', 'ageUp', 'erase']);
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
        const box = boxAround(org.location, GRASSROOTS_RADIUS_KM);
        sql.push("p.level <> 'pro'", 'p.lat IS NOT NULL AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?'); args.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
      }
    }
    if (f.adultsOnly) adults();
    for (const [k, col] of [['position', 'position'], ['availability', 'availability'], ['country', 'country']]) if (f[k] !== undefined && f[k] !== null) { sql.push(`p.${col} = ?`); args.push(f[k]); }
    if (f.academyPlus === true) sql.push('p.academy_plus = 1');
    if (typeof f.notLevel === 'string') { sql.push('p.level <> ?'); args.push(f.notLevel); }
    if (Number.isFinite(f.createdSince)) { sql.push('p.created_at >= ?'); args.push(f.createdSince); }
    if (Number.isSafeInteger(f.ageAtLeast)) { sql.push('p.birth_date <= ?'); args.push(bornByForAge(f.ageAtLeast, at)); }
    if (Number.isSafeInteger(f.ageBelow)) { sql.push('p.birth_date > ?'); args.push(bornByForAge(f.ageBelow, at)); }
    if (typeof f.exceptId === 'string') { sql.push('p.id <> ?'); args.push(f.exceptId); }
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

  // ---------------------------------------------------------- list operations (the rows of the player_* tables)
  const checkSubKey = (key) => { if (!SUBRECORD_KEYS.includes(key)) throw new TypeError(`"${key}" is not a player list; the lists are ${SUBRECORD_KEYS.join(', ')}`); };
  const subRefusal = (message) => refusal('PLAYER_SUBRECORD_INVALID', message);
  const subTarget = (id, key) => {
    checkSubKey(key);
    const rec = playerById(id);
    if (!rec) throw noPlayer(id);
    if (key === 'programme.completed' && rec.programme === null) throw subRefusal(`player ${id}: programme is null, so programme.completed cannot be written (start a programme first with players.update)`);
    return { rec, current: getSubrecords(rec, key) ?? [] };
  };
  const listOf = (id, key) => getSubrecords(playerById(id), key);

  let updatingPlayer = null; let updatingGuardian = null;

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
      return playerById(r.id);
    }),
    /**
     * `update(id, (draft) => …)`: the draft is a plain copy of the record; the change is typed whole and written at
     * once. The id, the guardian link, the creation time, the lists (`addItem` / `setItems` / `patchItem`) and the trial
     * reports never change here; an unknown field is refused. Returns the stored record.
     */
    update: (id, edit) => operation(() => {
      if (typeof edit !== 'function') throw new TypeError('players.update(id, (draft) => …) takes a function');
      if (updatingPlayer === id) throw refusal('PLAYER_UPDATE_REENTRANT', `player ${id} is already being updated`);
      const before = playerById(id);
      if (!before) throw noPlayer(id);
      const draft = clone(before);
      updatingPlayer = id;
      try { edit(draft); } finally { updatingPlayer = null; }
      const problems = [];
      for (const k of ['id', 'guardianId', 'createdAt', ...PLAYER_SUBRECORD_KEYS, 'trialReports']) if (!same(draft[k], before[k])) problems.push(`${k} does not change through update${PLAYER_SUBRECORD_KEYS.includes(k) ? ` (use players.addItem / setItems / patchItem)` : k === 'guardianId' ? ' (use link / unlink / ageUp)' : ''}`);
      // A composite's list is its rows: set whole or left out, it keeps the rows; a different list is refused.
      if (isPlainObject(draft.medical)) { if (draft.medical.records === undefined) draft.medical.records = before.medical.records; else if (!same(draft.medical.records, before.medical.records)) problems.push('medical.records does not change through update (use players.addItem / setItems)'); }
      if (isPlainObject(draft.programme)) {
        const was = before.programme?.completed ?? [];
        draft.programme = { track: null, startedAt: null, ...draft.programme };
        if (draft.programme.completed === undefined) draft.programme.completed = was; else if (!same(draft.programme.completed, was)) problems.push('programme.completed does not change through update (use players.addItem / setItems)');
      } else if (draft.programme === null && (before.programme?.completed ?? []).length) problems.push(`programme cannot be set to null while ${before.programme.completed.length} programme.completed row(s) exist; clear them first with players.setItems(id, 'programme.completed', [])`);
      if (isPlainObject(draft.stats)) draft.stats = { ...pick(draft.stats, STATS_KEYS), ...Object.fromEntries(Object.entries(draft.stats).filter(([k]) => !STATS_KEYS.includes(k))) };
      if (isPlainObject(draft.notificationPrefs)) draft.notificationPrefs = { ...pick(draft.notificationPrefs, PREFS_KEYS), ...Object.fromEntries(Object.entries(draft.notificationPrefs).filter(([k]) => !PREFS_KEYS.includes(k))) };
      if (draft.city === '') draft.city = null;
      const { trialReports: _derived, ...typed } = draft;
      if (!problems.length) problems.push(...playerRecordProblems(typed));
      if (problems.length) throw playerInvalid(id, problems);
      const params = playerParams(typed);
      q(P_UPDATE).run(Object.fromEntries(['id', ...P_UPDATE_COLS].map((c) => [c, params[c]])));
      return playerById(id);
    }),
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
     * The account deletion (S4b-R): the row stays, reduced to the retained record; the lists and links are deleted.
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
    /** The live players the organisation may see by the SQL part of the rule (see scanWhere), with the further filters. */
    visibleCandidates: (org, filter = {}, opts = {}) => players.list({ ...filter, visibleTo: org }, opts),
    count: () => q('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NULL').get().n,
    /** The stored password hash for the sign-in check (never on a record), or null. */
    passwordHashOf: (id) => q('SELECT password_hash FROM players WHERE id = ? AND deleted_at IS NULL').get(id)?.password_hash ?? null,
    /** Rows per list table (counts only), for reports. */
    subrecordRows: () => countChildRows(st),
    /** The narrow accessors of the retained records (S4b-R). No route serves one. */
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
    /** `update(id, (draft) => …)`: the id, the links (`childIds`), `coGuardians`, `coGuardianOf` and the creation time never change here. */
    update: (id, edit) => operation(() => {
      if (typeof edit !== 'function') throw new TypeError('guardians.update(id, (draft) => …) takes a function');
      if (updatingGuardian === id) throw refusal('GUARDIAN_UPDATE_REENTRANT', `guardian ${id} is already being updated`);
      const before = guardianById(id);
      if (!before) throw noGuardian(id);
      const draft = clone(before);
      updatingGuardian = id;
      try { edit(draft); } finally { updatingGuardian = null; }
      const problems = [];
      for (const k of GUARDIAN_RECORD_KEYS) if (!GUARDIAN_EDITABLE.includes(k) && !same(draft[k], before[k])) problems.push(`${k} does not change through update${k === 'childIds' ? ' (use link / unlink / ageUp)' : ''}`);
      if (isPlainObject(draft.notificationPrefs)) draft.notificationPrefs = { ...pick(draft.notificationPrefs, PREFS_KEYS), ...Object.fromEntries(Object.entries(draft.notificationPrefs).filter(([k]) => !PREFS_KEYS.includes(k))) };
      if (!problems.length) problems.push(...guardianRecordProblems(draft, { input: false }));
      if (problems.length) throw guardianInvalid(id, problems);
      const taken = emailOwner(draft.email, id);
      if (taken) throw refusal('EMAIL_IN_USE', `another guardian (${taken}) already uses this e-mail (compared case-insensitively)`);
      const params = guardianParams(draft);
      q(G_UPDATE).run(Object.fromEntries(['id', ...G_UPDATE_COLS].map((c) => [c, params[c]])));
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
     * First-installation initialisation: type the given records (the seed, in snapshot form) and write them with the
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
