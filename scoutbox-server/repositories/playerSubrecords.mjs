/**
 * Player sub-records (migration plan step S5; docs/architecture/s5-player-subrecords.md).
 *
 * The eleven arrays a player record carries — `media`, `attendance`, `timeline`,
 * `badges`, `drills`, `drillResults`, `activityLog`, `externalIds`,
 * `seasonHistory`, `medical.records`, `programme.completed` — become rows of the
 * twelve `player_*` tables created by migration `0007_player_subrecords`
 * (`media[].tags{}` is the twelfth, `player_media_tags`). The record the server
 * sees keeps every array in place, read-only; the repository (identity.mjs) is
 * the one writer. `trialReports` is not stored at all: it is a duplicate of
 * `trials[].report` and is served as a DERIVED value (`trialReportsFor`).
 *
 * Decisions this module encodes (note §2):
 *   - no identifier is minted: a row without a client-visible id is keyed by
 *     `(player_id, position)`; every table carries `position` (the array index)
 *     and reads back in that order, so order and legal duplicates survive;
 *   - typed columns, valid input only (the S8d fidelity rule, 3 Nov 2026): an
 *     item is its columns. A write (the repository, a snapshot) stores the
 *     known fields and drops unknown ones; it keeps no key order, no explicit
 *     null and no absent/null distinction. An item reads back with its fields
 *     in the spec's order: a NULL column is `null` for the fields the writers
 *     set explicitly (`nullable`: a clip's url, verifiedClip and captions, an
 *     attendance's gps, a medical record's layoffWeeks and cleared) and
 *     omitted otherwise; a clip always carries `tags`. Every array is on every
 *     record (`[]` when it has no rows);
 *   - a value a column cannot hold is REFUSED with the field, the index and the
 *     reason (`media[2].title is absent`), never adjusted; a natural key the
 *     code enforces (season per player, drill per player, provider and
 *     external id per player, tag per clip, every item id) is refused when an
 *     array violates it, never deduplicated;
 *   - the one exception is the blob import of migration 0007
 *     (`importSubrecords`): an unknown field is dropped, a wrong-typed value is
 *     converted when the meaning is obvious (a number given as text, a text
 *     given as a number, 0/1 for a boolean) and dropped otherwise, each noted
 *     with the player id, the array, the index and the field; only an item it
 *     cannot use (no id, a required field missing, a repeated natural key) blocks
 *     the step.
 */
import {
  playerFromRow, validatePlayerRecord, PLAYER_SUBRECORD_KEYS, PLAYER_COMPOSITE_SUBRECORDS, PLAYER_COMPOSITE_SUBRECORD_TABLES, PLAYER_COLUMNS,
} from './identityMapping.mjs';
import { migrationApplied } from './database.mjs';

export const PLAYER_SUBRECORDS_MIGRATION = '0007_player_subrecords';
/** Is the S5 storage authoritative on this connection? Decided by the migration record, never by the tables existing. */
export const subrecordsLive = (sqlite) => migrationApplied(sqlite, PLAYER_SUBRECORDS_MIGRATION);

/** The array keys the repository writes, as the writers name them (`medical.records` and `programme.completed` are sub-keys of split composites). */
export const SUBRECORD_KEYS = Object.freeze([...PLAYER_SUBRECORD_KEYS, ...Object.entries(PLAYER_COMPOSITE_SUBRECORDS).flatMap(([k, subs]) => subs.map((s) => `${k}.${s}`))]);
export const SUBRECORD_TABLES = Object.freeze([
  'player_season_history', 'player_badges', 'player_drills', 'player_attendance', 'player_timeline', 'player_media', 'player_media_tags',
  'player_medical_records', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_programme_completions',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.hasOwn(o, k);
const setOwn = (o, k, v) => { Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); return o; };
const describe = (v) => (v === null ? 'null' : v === undefined ? 'absent' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v === 'bigint' ? 'a bigint' : `a ${typeof v}`);
const absentOrNull = (v) => v === null || v === undefined;
const isSafeInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isFinite_ = (v) => typeof v === 'number' && Number.isFinite(v);
const JSON_CHECK = (col) => `${col} TEXT CHECK (${col} IS NULL OR json_valid(${col}))`;

// ------------------------------------------------------------------ the DDL (what migration 0007 creates; 01_identity.sql documents it)
export const SUBRECORDS_DDL = `
CREATE TABLE player_season_history (
  player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  season              TEXT NOT NULL,
  appearances         REAL,
  goals               REAL,
  assists             REAL,
  pace_kmh            REAL,
  pass_completion_pct REAL,
  duel_success_pct    REAL,
  clean_sheets        REAL,
  PRIMARY KEY (player_id, season)
) STRICT;
CREATE UNIQUE INDEX player_season_history_position ON player_season_history (player_id, position);

CREATE TABLE player_badges (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  badge     TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_drills (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  drill_id  TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;
CREATE UNIQUE INDEX player_drills_drill ON player_drills (player_id, drill_id);

CREATE TABLE player_attendance (
  id               TEXT PRIMARY KEY,
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  fixture          TEXT NOT NULL,
  venue            TEXT,
  match_date       TEXT NOT NULL,
  lat              REAL,
  lng              REAL,
  device_confirmed INTEGER CHECK (device_confirmed IS NULL OR device_confirmed IN (0,1)),
  verified         INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  corroborated_by  TEXT,
  trial_id         TEXT,
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE UNIQUE INDEX player_attendance_player ON player_attendance (player_id, position);

CREATE TABLE player_timeline (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  year      TEXT NOT NULL,
  event     TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_media (
  id                          TEXT PRIMARY KEY,
  player_id                   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position                    INTEGER NOT NULL,
  title                       TEXT NOT NULL,
  kind                        TEXT,
  uploaded_at                 TEXT,
  url                         TEXT,
  views                       INTEGER NOT NULL DEFAULT 0,
  verified_clip_attendance_id TEXT,
  captions                    TEXT,
  size_bytes                  INTEGER,
  captured_by                 TEXT CHECK (captured_by IS NULL OR captured_by IN ('box_cam')),
  box_session_id              TEXT
) STRICT;
CREATE UNIQUE INDEX player_media_player ON player_media (player_id, position);

CREATE TABLE player_media_tags (
  media_id TEXT NOT NULL REFERENCES player_media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tag      TEXT NOT NULL,
  count    INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (media_id, tag)
) STRICT;
CREATE UNIQUE INDEX player_media_tags_position ON player_media_tags (media_id, position);

CREATE TABLE player_medical_records (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  record_date  TEXT CHECK (record_date IS NULL OR length(record_date) = 10),
  layoff_weeks REAL,
  cleared      INTEGER CHECK (cleared IS NULL OR cleared IN (0,1))
) STRICT;
CREATE UNIQUE INDEX player_medical_records_player ON player_medical_records (player_id, position);

CREATE TABLE player_drill_results (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  drill_id    TEXT NOT NULL,
  drill_name  TEXT,
  metric      TEXT NOT NULL,
  unit        TEXT,
  value       REAL NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX player_drill_results_player ON player_drill_results (player_id, position);

CREATE TABLE player_activity_log (
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_external_ids (
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  source         TEXT NOT NULL,
  linked_by_name TEXT,
  linked_at      INTEGER NOT NULL,
  ${JSON_CHECK('claim_json')},
  PRIMARY KEY (player_id, provider, external_id)
) STRICT;
CREATE UNIQUE INDEX player_external_ids_position ON player_external_ids (player_id, position);

CREATE TABLE player_programme_completions (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;
`;

// ------------------------------------------------------------------ specs
// One description per array: the table, how an item maps to a row (record key
// → column), the type each column holds (what the validator refuses), which
// keys the table requires, which optional keys read back as `null` when their
// column is NULL (`nullable`; the others are omitted), and the natural key the
// code enforces today (refused when an array violates it).
const itemSpec = ({ scalars, booleans = [], json = [], composites = {}, defaults = {}, columns }) => Object.freeze({
  scalars: Object.freeze(scalars), booleans: new Set(booleans), json: new Set(json), composites: Object.freeze(composites),
  defaults: Object.freeze(defaults), columns: Object.freeze(columns),
});
/** `types`: record key → 'text' | 'date' | 'int' | 'real' | 'bool' | 'json'; `required`: keys that must be present and non-null; `enums`: allowed values. */
export const SUBRECORD_SPECS = Object.freeze({
  media: Object.freeze({
    table: 'player_media', idKey: 'id', children: 'tags',
    spec: itemSpec({
      scalars: { id: 'id', title: 'title', kind: 'kind', uploadedAt: 'uploaded_at', url: 'url', views: 'views', verifiedClip: 'verified_clip_attendance_id', captions: 'captions', sizeBytes: 'size_bytes', capturedBy: 'captured_by', boxSessionId: 'box_session_id' },
      defaults: { views: 0 },
      columns: ['id', 'title', 'kind', 'uploaded_at', 'url', 'views', 'verified_clip_attendance_id', 'captions', 'size_bytes', 'captured_by', 'box_session_id'],
    }),
    types: { id: 'text', title: 'text', kind: 'text', uploadedAt: 'text', url: 'text', views: 'int', verifiedClip: 'text', captions: 'text', sizeBytes: 'int', capturedBy: 'text', boxSessionId: 'text' },
    required: ['id', 'title'], enums: { capturedBy: ['box_cam'] }, unique: [['id']], nullable: ['url', 'verifiedClip', 'captions'],
  }),
  attendance: Object.freeze({
    table: 'player_attendance', idKey: 'id',
    spec: itemSpec({
      scalars: { id: 'id', fixture: 'fixture', venue: 'venue', date: 'match_date', deviceConfirmed: 'device_confirmed', verified: 'verified', corroboratedBy: 'corroborated_by', trialId: 'trial_id' },
      booleans: ['deviceConfirmed', 'verified'], composites: { gps: { lat: 'lat', lng: 'lng' } }, defaults: { verified: 0 },
      columns: ['id', 'fixture', 'venue', 'match_date', 'lat', 'lng', 'device_confirmed', 'verified', 'corroborated_by', 'trial_id'],
    }),
    types: { id: 'text', fixture: 'text', venue: 'text', date: 'text', deviceConfirmed: 'bool', verified: 'bool', corroboratedBy: 'text', trialId: 'text' },
    required: ['id', 'fixture', 'date'], unique: [['id']], nullable: ['gps'],
  }),
  timeline: Object.freeze({
    table: 'player_timeline',
    spec: itemSpec({ scalars: { year: 'year', event: 'event' }, columns: ['year', 'event'] }),
    types: { year: 'text', event: 'text' }, required: ['year', 'event'],
  }),
  seasonHistory: Object.freeze({
    table: 'player_season_history',
    spec: itemSpec({
      scalars: { season: 'season', appearances: 'appearances', goals: 'goals', assists: 'assists', paceKmh: 'pace_kmh', passCompletionPct: 'pass_completion_pct', duelSuccessPct: 'duel_success_pct', cleanSheets: 'clean_sheets' },
      columns: ['season', 'appearances', 'goals', 'assists', 'pace_kmh', 'pass_completion_pct', 'duel_success_pct', 'clean_sheets'],
    }),
    // The stats route files any non-negative finite number into a season (the current-season `stats_*` columns are stricter): REAL columns, nothing coerced.
    types: { season: 'text', appearances: 'real', goals: 'real', assists: 'real', paceKmh: 'real', passCompletionPct: 'real', duelSuccessPct: 'real', cleanSheets: 'real' },
    required: ['season'], unique: [['season']],
  }),
  'medical.records': Object.freeze({
    table: 'player_medical_records', idKey: 'id',
    spec: itemSpec({
      scalars: { id: 'id', type: 'type', title: 'title', date: 'record_date', layoffWeeks: 'layoff_weeks', cleared: 'cleared' }, booleans: ['cleared'],
      columns: ['id', 'type', 'title', 'record_date', 'layoff_weeks', 'cleared'],
    }),
    types: { id: 'text', type: 'text', title: 'text', date: 'date', layoffWeeks: 'real', cleared: 'bool' },
    required: ['id', 'type', 'title'], unique: [['id']], nullable: ['layoffWeeks', 'cleared'],
  }),
  drillResults: Object.freeze({
    table: 'player_drill_results', idKey: 'id',
    spec: itemSpec({
      scalars: { id: 'id', drillId: 'drill_id', drillName: 'drill_name', metric: 'metric', unit: 'unit', value: 'value', verified: 'verified', ts: 'recorded_at' }, booleans: ['verified'], defaults: { verified: 0 },
      columns: ['id', 'drill_id', 'drill_name', 'metric', 'unit', 'value', 'verified', 'recorded_at'],
    }),
    types: { id: 'text', drillId: 'text', drillName: 'text', metric: 'text', unit: 'text', value: 'real', verified: 'bool', ts: 'int' },
    required: ['id', 'drillId', 'metric', 'value', 'ts'], unique: [['id']],
  }),
  externalIds: Object.freeze({
    table: 'player_external_ids',
    spec: itemSpec({
      scalars: { provider: 'provider', externalId: 'external_id', source: 'source', by: 'linked_by_name', at: 'linked_at', claim: 'claim_json' }, json: ['claim'],
      columns: ['provider', 'external_id', 'source', 'linked_by_name', 'linked_at', 'claim_json'],
    }),
    types: { provider: 'text', externalId: 'text', source: 'text', by: 'text', at: 'int', claim: 'json' },
    required: ['provider', 'externalId', 'source', 'at'], unique: [['provider', 'externalId']],
  }),
  'programme.completed': Object.freeze({
    table: 'player_programme_completions',
    spec: itemSpec({ scalars: { sessionId: 'session_id', ts: 'completed_at' }, columns: ['session_id', 'completed_at'] }),
    types: { sessionId: 'text', ts: 'int' }, required: ['sessionId', 'ts'],
  }),
  // Primitive arrays: the value IS the item.
  badges: Object.freeze({ table: 'player_badges', primitive: 'text', column: 'badge' }),
  drills: Object.freeze({ table: 'player_drills', primitive: 'text', column: 'drill_id', unique: true }),
  activityLog: Object.freeze({ table: 'player_activity_log', primitive: 'int', column: 'occurred_at' }),
});

// The decoder names a composite sub-key's table in its one refusal; the names must be the specs' (checked once, at load).
for (const [key, table] of Object.entries(PLAYER_COMPOSITE_SUBRECORD_TABLES)) if (SUBRECORD_SPECS[key]?.table !== table) throw new Error(`playerSubrecords: ${key} is stored in ${SUBRECORD_SPECS[key]?.table} here but identityMapping names ${table}`);

/** Read an array off a record by its writer name (`medical.records` → `rec.medical?.records`). */
export function getSubrecords(rec, key) {
  if (!key.includes('.')) return rec?.[key];
  const [k, sub] = key.split('.');
  const composite = rec?.[k];
  return isPlainObject(composite) ? composite[sub] : undefined;
}

// ------------------------------------------------------------------ validation (field, index and reason; nothing coerced)
const checkValue = (problems, label, v, type, { required = false, enums = null } = {}) => {
  if (v === undefined) { if (required) problems.push(`${label} is absent`); return; }
  if (v === null) { if (required) problems.push(`${label} is null`); return; }
  switch (type) {
    case 'text': if (typeof v !== 'string') problems.push(`${label} is ${describe(v)}, not text`); break;
    case 'date': if (typeof v !== 'string') problems.push(`${label} is ${describe(v)}, not text`); else if (v.length !== 10) problems.push(`${label} is not a 10-character date (YYYY-MM-DD)`); break;
    case 'int': if (!isSafeInt(v)) problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a safe integer`); break;
    case 'real': if (!isFinite_(v)) problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a finite number`); break;
    case 'bool': if (typeof v !== 'boolean') problems.push(`${label} is ${describe(v)}, not a boolean`); break;
    case 'json': try { JSON.stringify(v); } catch (err) { problems.push(`${label} cannot be stored as JSON (${String(err?.message ?? err).slice(0, 80)})`); } break;
    default: throw new Error(`unknown item type ${type}`);
  }
  if (enums && typeof v === 'string' && !enums.includes(v)) problems.push(`${label} is not one of ${enums.join('/')}`);
};

/** Validate one item of `key` (an index for the label); returns the problems. Unknown fields are not problems: they are not stored. */
export function validateSubrecordItem(key, item, index = null) {
  const def = SUBRECORD_SPECS[key];
  if (!def) return [`"${key}" is not a player sub-record`];
  const at = index === null ? key : `${key}[${index}]`;
  const problems = [];
  if (def.primitive) {
    if (def.primitive === 'text' && typeof item !== 'string') problems.push(`${at} is ${describe(item)}, not text`);
    if (def.primitive === 'int' && !isSafeInt(item)) problems.push(`${at} is ${typeof item === 'number' ? String(item) : describe(item)}, not a safe integer`);
    return problems;
  }
  if (!isPlainObject(item)) return [`${at} is ${describe(item)}, not an object`];
  for (const [k, type] of Object.entries(def.types)) checkValue(problems, `${at}.${k}`, item[k], type, { required: def.required.includes(k), enums: def.enums?.[k] ?? null });
  for (const [ck, subs] of Object.entries(def.spec.composites)) {
    const v = item[ck];
    if (absentOrNull(v)) continue;
    if (!isPlainObject(v)) { problems.push(`${at}.${ck} is ${describe(v)}, not an object`); continue; }
    const present = Object.keys(subs).filter((s) => !absentOrNull(v[s]));
    if (present.length && present.length !== Object.keys(subs).length) problems.push(`${at}.${ck} has ${present.join('/')} without ${Object.keys(subs).filter((s) => !present.includes(s)).join('/')}`);
    for (const s of Object.keys(subs)) if (!absentOrNull(v[s]) && !isFinite_(v[s])) problems.push(`${at}.${ck}.${s} is ${describe(v[s])}, not a finite number`);
  }
  if (def.children === 'tags' && !absentOrNull(item.tags)) {
    if (!isPlainObject(item.tags)) problems.push(`${at}.tags is ${describe(item.tags)}, not an object of tag → count`);
    else for (const [tag, n] of Object.entries(item.tags)) if (!isSafeInt(n) || n <= 0) problems.push(`${at}.tags.${tag} is ${typeof n === 'number' ? String(n) : describe(n)}, not a positive integer`);
  }
  return problems;
}

/** Validate a whole array of `key` (items and the natural keys the code enforces); `null`/absent is valid. */
export function validateSubrecordArray(key, items) {
  if (absentOrNull(items)) return [];
  if (!Array.isArray(items)) return [`${key} is ${describe(items)}, not an array`];
  const def = SUBRECORD_SPECS[key];
  const problems = [];
  items.forEach((item, i) => problems.push(...validateSubrecordItem(key, item, i)));
  if (problems.length) return problems;
  if (def.primitive) {
    if (def.unique) { const seen = new Map(); items.forEach((v, i) => { if (seen.has(v)) problems.push(`${key}[${i}] repeats ${JSON.stringify(v)} (first at [${seen.get(v)}]); the table keys ${key} by value and nothing is deduplicated`); else seen.set(v, i); }); }
    return problems;
  }
  for (const cols of def.unique ?? []) {
    const seen = new Map();
    items.forEach((item, i) => {
      const k = JSON.stringify(cols.map((c) => item[c]));
      if (seen.has(k)) problems.push(`${key}[${i}] repeats ${cols.join('+')} ${cols.map((c) => JSON.stringify(item[c])).join('/')} (first at [${seen.get(k)}]); the table keys ${key} by it and nothing is deduplicated`);
      else seen.set(k, i);
    });
  }
  return problems;
}

/** Every problem of every sub-record array of a record. */
export function validateSubrecords(rec) {
  const problems = [];
  for (const key of SUBRECORD_KEYS) problems.push(...validateSubrecordArray(key, getSubrecords(rec, key)));
  return problems;
}
/**
 * The whole player validator since S5: the record (identityMapping's
 * `validatePlayerRecord`: scalars, composites, the arrays as arrays) AND every
 * item of every array. The repository and the snapshot writer use this one;
 * nothing is coerced.
 */
export function validatePlayerRecordWithItems(rec) {
  const base = validatePlayerRecord(rec);
  const problems = base.ok ? [] : base.problems.slice();
  if (isPlainObject(rec)) problems.push(...validateSubrecords(rec));
  return problems.length ? { ok: false, problems } : { ok: true };
}

// ------------------------------------------------------------------ the blob import (migration 0007 only)
const NUMERIC_TEXT = /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;
/** The value `type` holds for `v`: `{ ok, value, converted }`; `ok: false` when there is no obvious meaning (the value is dropped). */
const typeForImport = (v, type, enums) => {
  let out;
  switch (type) {
    case 'text': case 'date':
      if (typeof v === 'string') out = { ok: true, value: v };
      else if (isFinite_(v) || typeof v === 'boolean') out = { ok: true, value: String(v), converted: true };
      else return { ok: false };
      if (type === 'date' && out.value.length !== 10) return { ok: false };
      break;
    case 'int': case 'real': {
      const n = typeof v === 'string' && NUMERIC_TEXT.test(v) ? Number(v) : v;
      if (!(type === 'int' ? isSafeInt(n) : isFinite_(n))) return { ok: false };
      out = { ok: true, value: n, converted: n !== v };
      break;
    }
    case 'bool':
      if (typeof v === 'boolean') out = { ok: true, value: v };
      else if (v === 0 || v === 1) out = { ok: true, value: v === 1, converted: true };
      else return { ok: false };
      break;
    case 'json': try { JSON.stringify(v); out = { ok: true, value: v }; } catch { return { ok: false }; } break;
    default: throw new Error(`unknown item type ${type}`);
  }
  if (enums && !enums.includes(out.value)) return { ok: false };
  return out;
};
/**
 * Type one array of a decoded player for the cutover. Returns `{ items, notes,
 * problems }`: `items` holds only what the columns store, `notes` says what was
 * converted or dropped (player id, array, index, item id, field: never a
 * value), `problems` the items the tables cannot take at all.
 */
function importArray(playerId, key, raw) {
  const notes = []; const problems = [];
  const at = (i, item) => `players ${playerId}: ${key}[${i}]${isPlainObject(item) && typeof item.id === 'string' ? ` (${item.id})` : ''}`;
  if (absentOrNull(raw)) return { items: [], notes, problems };
  if (!Array.isArray(raw)) { notes.push(`players ${playerId}: ${key} is ${describe(raw)}, not an array; dropped`); return { items: [], notes, problems }; }
  const def = SUBRECORD_SPECS[key];
  const items = [];
  raw.forEach((item, i) => {
    if (def.primitive) {
      const t = typeForImport(item, def.primitive);
      if (!t.ok) { notes.push(`${at(i, item)} is ${describe(item)}, not ${def.primitive === 'int' ? 'an integer' : 'text'}; the entry was dropped`); return; }
      if (t.converted) notes.push(`${at(i, item)} was ${describe(item)}; stored as ${def.primitive === 'int' ? 'an integer' : 'text'}`);
      items.push(t.value); return;
    }
    if (!isPlainObject(item)) { problems.push(`${at(i, item)} is ${describe(item)}, not an object`); return; }
    const out = {};
    for (const [k, type] of Object.entries(def.types)) {
      if (absentOrNull(item[k])) continue;
      const t = typeForImport(item[k], type, def.enums?.[k] ?? null);
      if (!t.ok) { notes.push(`${at(i, item)}.${k} is ${describe(item[k])}, which the ${type} column cannot hold; the value was dropped`); continue; }
      if (t.converted) notes.push(`${at(i, item)}.${k} was ${describe(item[k])}; stored as ${type}`);
      setOwn(out, k, t.value);
    }
    for (const [ck, subs] of Object.entries(def.spec.composites)) {
      const v = item[ck];
      if (absentOrNull(v)) continue;
      const parts = isPlainObject(v) ? Object.keys(subs).map((s) => typeForImport(v[s], 'real')) : [];
      if (!parts.length || parts.some((p) => !p.ok)) { notes.push(`${at(i, item)}.${ck} is not a pair of finite numbers; the value was dropped`); continue; }
      setOwn(out, ck, Object.fromEntries(Object.keys(subs).map((s, j) => [s, parts[j].value])));
    }
    if (def.children === 'tags' && !absentOrNull(item.tags)) {
      const tags = {};
      if (!isPlainObject(item.tags)) notes.push(`${at(i, item)}.tags is ${describe(item.tags)}, not an object of tag → count; dropped`);
      else for (const [tag, n] of Object.entries(item.tags)) { if (isSafeInt(n) && n > 0) setOwn(tags, tag, n); else notes.push(`${at(i, item)}.tags: a tag whose count is not a positive integer was dropped`); }
      out.tags = tags;
    }
    const known = new Set([...Object.keys(def.types), ...Object.keys(def.spec.composites), ...(def.children ? [def.children] : [])]);
    for (const k of Object.keys(item)) if (!known.has(k)) notes.push(`${at(i, item)}: unknown field ${k} dropped`);
    const missing = def.required.filter((k) => !hasOwn(out, k));
    if (missing.length) { problems.push(`${at(i, item)} has no usable ${missing.join(', ')} (required by ${def.table})`); return; }
    items.push(out);
  });
  if (!problems.length) problems.push(...validateSubrecordArray(key, items).map((p) => `players ${playerId}: ${p}`));
  return { items, notes, problems };
}
/**
 * The cutover's typing of every array of a decoded (S4a-layout) player record:
 * `{ record, notes, problems }` where `record` is the record with every array
 * replaced by what the tables will hold (the composite sub-keys only where the
 * composite is an object).
 */
export function importSubrecords(rec) {
  const record = { ...rec };
  const notes = []; const problems = [];
  for (const key of SUBRECORD_KEYS) {
    const [k, sub] = key.split('.');
    if (sub && !isPlainObject(record[k])) {
      if (!absentOrNull(getSubrecords(rec, key))) notes.push(`players ${rec.id}: ${key} has no ${k} to belong to; dropped`);
      continue;
    }
    const r = importArray(rec.id, key, sub ? rec[k][sub] : rec[key]);
    notes.push(...r.notes); problems.push(...r.problems);
    if (sub) record[k] = { ...record[k], [sub]: r.items }; else record[key] = r.items;
  }
  return { record: placeSubrecords(record), notes, problems };
}

// ------------------------------------------------------------------ item ⇄ row
const insertSql = (table, columns) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;

/** The row of a valid item: its known fields in their columns (unknown fields are not stored), the table defaults where it leaves a required column out. */
function itemToRow(def, item) {
  const s = def.spec;
  const row = {};
  for (const c of s.columns) row[c] = null;
  for (const [k, col] of Object.entries(s.scalars)) {
    const v = item[k];
    if (absentOrNull(v)) continue;
    row[col] = s.booleans.has(k) ? (v ? 1 : 0) : s.json.has(k) ? JSON.stringify(v) : v;
  }
  for (const [ck, subs] of Object.entries(s.composites)) {
    const v = item[ck];
    if (isPlainObject(v)) for (const [sub, col] of Object.entries(subs)) if (!absentOrNull(v[sub])) row[col] = v[sub];
  }
  for (const [col, dflt] of Object.entries(s.defaults)) if (row[col] === null) row[col] = dflt;
  return row;
}
/** The item a row holds: its fields in the spec's order; a NULL column is `null` for a `nullable` field and omitted otherwise. */
function itemFromRow(def, row, tagRows) {
  const s = def.spec;
  const nullable = def.nullable ?? [];
  const item = {};
  for (const [k, col] of Object.entries(s.scalars)) {
    const v = row[col];
    if (v === null || v === undefined) { if (nullable.includes(k)) item[k] = null; continue; }
    item[k] = s.booleans.has(k) ? v === 1 : s.json.has(k) ? JSON.parse(v) : v;
  }
  for (const [ck, subs] of Object.entries(s.composites)) {
    const cols = Object.entries(subs);
    if (cols.every(([, col]) => row[col] !== null && row[col] !== undefined)) item[ck] = Object.fromEntries(cols.map(([sub, col]) => [sub, row[col]]));
    else if (nullable.includes(ck)) item[ck] = null;
  }
  if (def.children === 'tags') {
    const tags = {};
    for (const t of tagRows ?? []) setOwn(tags, t.tag, t.count);
    item.tags = tags;
  }
  return item;
}

/** The rows an item becomes: `{ row, tags }` (tags only for media). */
export function itemRows(key, item, position, playerId) {
  const def = SUBRECORD_SPECS[key];
  if (def.primitive) return { row: { player_id: playerId, position, [def.column]: item }, tags: null };
  const row = itemToRow(def, item);
  row.player_id = playerId; row.position = position;
  let tags = null;
  if (def.children === 'tags' && isPlainObject(item.tags)) tags = Object.entries(item.tags).map(([tag, count], i) => ({ media_id: item.id, position: i, tag, count }));
  return { row, tags };
}
/** A valid item exactly as the tables will read it back (what the repository keeps in memory after a write). */
export function storedItem(key, item) {
  const def = SUBRECORD_SPECS[key];
  if (def.primitive) return item;
  const { row, tags } = itemRows(key, item, 0, null);
  return itemFromRow(def, row, tags);
}
/**
 * Put a valid record's arrays in their stored form, IN PLACE: every array on
 * every record (`[]` for an absent or null one; a composite's sub-array only
 * where the composite is an object), each item as the tables read it back, the
 * array keys after the record's other keys (the composite's sub-array after its
 * other sub-keys) — the order a read from the tables produces. Returns the record.
 */
export function placeSubrecords(rec) {
  for (const key of PLAYER_SUBRECORD_KEYS) {
    const items = Array.isArray(rec[key]) ? rec[key].map((it) => storedItem(key, it)) : [];
    delete rec[key]; setOwn(rec, key, items);
  }
  for (const [k, subs] of Object.entries(PLAYER_COMPOSITE_SUBRECORDS)) {
    if (!isPlainObject(rec[k])) continue;
    for (const sub of subs) {
      const items = Array.isArray(rec[k][sub]) ? rec[k][sub].map((it) => storedItem(`${k}.${sub}`, it)) : [];
      delete rec[k][sub]; setOwn(rec[k], sub, items);
    }
  }
  return rec;
}
const columnsOf = (key) => { const def = SUBRECORD_SPECS[key]; return def.primitive ? ['player_id', 'position', def.column] : ['player_id', 'position', ...def.spec.columns]; };

/** Prepared statements for every table (built once per connection by the callers below). */
export function prepareSubrecordStatements(sqlite) {
  const st = {};
  for (const key of SUBRECORD_KEYS) {
    const def = SUBRECORD_SPECS[key];
    st[key] = {
      insert: sqlite.prepare(insertSql(def.table, columnsOf(key))),
      deleteAll: sqlite.prepare(`DELETE FROM ${def.table} WHERE player_id = ?`),
      selectAll: sqlite.prepare(`SELECT ${columnsOf(key).join(', ')} FROM ${def.table} ORDER BY player_id, position`),
      selectPlayer: sqlite.prepare(`SELECT ${columnsOf(key).join(', ')} FROM ${def.table} WHERE player_id = ? ORDER BY position`),
      count: sqlite.prepare(`SELECT COUNT(*) AS n FROM ${def.table}`),
    };
    if (def.idKey) st[key].update = sqlite.prepare(`UPDATE ${def.table} SET ${columnsOf(key).filter((c) => c !== 'id' && c !== 'player_id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND player_id = @player_id`);
    else if (!def.primitive) st[key].update = sqlite.prepare(`UPDATE ${def.table} SET ${columnsOf(key).filter((c) => c !== 'player_id' && c !== 'position').map((c) => `${c} = @${c}`).join(', ')} WHERE player_id = @player_id AND position = @position`);
  }
  st.tags = {
    insert: sqlite.prepare('INSERT INTO player_media_tags (media_id, position, tag, count) VALUES (@media_id, @position, @tag, @count)'),
    deleteMedia: sqlite.prepare('DELETE FROM player_media_tags WHERE media_id = ?'),
    selectAll: sqlite.prepare('SELECT media_id, position, tag, count FROM player_media_tags ORDER BY media_id, position'),
    selectMedia: sqlite.prepare('SELECT position, tag, count FROM player_media_tags WHERE media_id = ? ORDER BY position'),
  };
  return st;
}

/** Write every row of one array of one player (positions 0..n−1), inside the caller's transaction. */
export function writeArrayRows(st, key, playerId, items) {
  if (!Array.isArray(items)) return 0;
  items.forEach((item, i) => {
    const { row, tags } = itemRows(key, item, i, playerId);
    st[key].insert.run(row);
    if (tags) for (const t of tags) st.tags.insert.run(t);
  });
  return items.length;
}
/** Write every array of a record (`players.insert`, the migration, the snapshot writer). Returns rows per table. */
export function writeChildRows(st, rec) {
  const counts = {};
  for (const key of SUBRECORD_KEYS) {
    const items = getSubrecords(rec, key);
    const n = writeArrayRows(st, key, rec.id, items);
    counts[SUBRECORD_SPECS[key].table] = (counts[SUBRECORD_SPECS[key].table] ?? 0) + n;
  }
  return counts;
}
/** Delete every child row of a player (the media tags cascade with their clips). */
export function deleteChildRows(st, playerId) {
  for (const key of SUBRECORD_KEYS) st[key].deleteAll.run(playerId);
}

const itemFromRows = (key, row, tagRows) => {
  const def = SUBRECORD_SPECS[key];
  return def.primitive ? row[def.column] : itemFromRow(def, row, tagRows);
};
const emptyChildren = () => {
  const c = {};
  for (const key of PLAYER_SUBRECORD_KEYS) c[key] = [];
  for (const [k, subs] of Object.entries(PLAYER_COMPOSITE_SUBRECORDS)) { c[k] = {}; for (const s of subs) c[k][s] = []; }
  return c;
};
const placeChild = (children, key, item) => {
  if (!key.includes('.')) { children[key].push(item); return; }
  const [k, sub] = key.split('.');
  children[k][sub].push(item);
};

/** Every player's arrays, read in one pass per table: Map player id → `{ media: [...], …, medical: { records }, programme: { completed } }`. */
export function readAllChildren(st) {
  const out = new Map();
  const of = (id) => { if (!out.has(id)) out.set(id, emptyChildren()); return out.get(id); };
  const tagsByMedia = new Map();
  for (const t of st.tags.selectAll.all()) { if (!tagsByMedia.has(t.media_id)) tagsByMedia.set(t.media_id, []); tagsByMedia.get(t.media_id).push(t); }
  for (const key of SUBRECORD_KEYS) {
    for (const row of st[key].selectAll.all()) placeChild(of(row.player_id), key, itemFromRows(key, row, tagsByMedia.get(row.id)));
  }
  return out;
}
/** One player's arrays (the same shape), for a re-read after a write. */
export function readChildren(st, playerId) {
  const children = emptyChildren();
  for (const key of SUBRECORD_KEYS) {
    for (const row of st[key].selectPlayer.all(playerId)) {
      const tagRows = SUBRECORD_SPECS[key].children === 'tags' ? st.tags.selectMedia.all(row.id) : null;
      placeChild(children, key, itemFromRows(key, row, tagRows));
    }
  }
  return children;
}
/** Rows per table, for reports (counts only). */
export function countChildRows(st) {
  const out = {};
  for (const key of SUBRECORD_KEYS) out[SUBRECORD_SPECS[key].table] = st[key].count.get().n;
  out.player_media_tags = st.tags.selectAll.all().length;
  return out;
}

// ------------------------------------------------------------------ the derived trial reports
/**
 * The trial reports of a player, from the authoritative `trials` collection:
 * every `trials[].report` whose trial names the player, in filing order
 * (ascending `filedAt`, the trials' order for a tie). The same objects the
 * trials hold, never copies.
 */
export function trialReportsFor(trials, playerId) {
  if (!Array.isArray(trials)) return [];
  const out = [];
  for (const t of trials) if (isPlainObject(t) && t.playerId === playerId && isPlainObject(t.report)) out.push(t.report);
  const at = (r) => (typeof r.filedAt === 'number' && Number.isFinite(r.filedAt) ? r.filedAt : 0);
  return out.sort((a, b) => at(a) - at(b));
}
/**
 * Reconcile a player's stored copy with the derived reports before the copy is
 * dropped (migration 0007). Returns `[]` when they agree entry for entry, else
 * one problem per discrepancy: a copy entry with no trial report of that id, an
 * entry whose content differs from the trial's report, a report the copy does
 * not carry, or the same entries in a different order. Nothing is repaired.
 */
export function reconcileTrialReports(copy, derived, { hint = 'resolve by hand before the cutover' } = {}) {
  if (copy === null || copy === undefined) return derived.length ? [`trialReports is ${describe(copy)} on the player but ${derived.length} trial report(s) name the player (${derived.map((r) => r.id).join(', ')}); the player would gain a report — ${hint}`] : [];
  if (!Array.isArray(copy)) return [`trialReports is ${describe(copy)}, not an array`];
  const problems = [];
  const byId = new Map(derived.map((r) => [r.id, r]));
  const seen = new Map();
  copy.forEach((entry, i) => {
    const id = isPlainObject(entry) ? entry.id : undefined;
    if (typeof id !== 'string') { problems.push(`trialReports[${i}] has no report id`); return; }
    if (seen.has(id)) { problems.push(`trialReports[${i}] (${id}) repeats the report listed at [${seen.get(id)}]; a report is filed once — ${hint}`); return; }
    seen.set(id, i);
    const source = byId.get(id);
    if (!source) { problems.push(`trialReports[${i}] (${id}) has no trial report with that id in the trials collection; the copy would be lost — ${hint}`); return; }
    if (JSON.stringify(entry) !== JSON.stringify(source)) problems.push(`trialReports[${i}] (${id}) differs from the trial's report; the copy would be replaced — ${hint}`);
  });
  for (const r of derived) if (!seen.has(r.id)) problems.push(`trial report ${r.id} names the player but the player's trialReports does not carry it; the player would gain a report — ${hint}`);
  if (!problems.length && JSON.stringify(copy.map((r) => r.id)) !== JSON.stringify(derived.map((r) => r.id))) problems.push(`trialReports lists the same reports in a different order than their filing order (${copy.map((r) => r.id).join(', ')} vs ${derived.map((r) => r.id).join(', ')}); ${hint}`);
  return problems;
}
/**
 * The rule every write path applies to a `trialReports` value that arrives WITH
 * a record (a snapshot replacement, initialize, insert, restore — review of
 * 132eda2, finding 1): an ARRAY is a claim about the trials collection and must
 * equal the derived list entry for entry (ids, content, order, no duplicate),
 * else the whole write is refused — the copy is never stored (0007 derives it),
 * so the only honest answers are "equal" or "refused", never a silent drop. An
 * absent key or a null is NO claim: the trials stand, and the record reads back
 * with whatever reports name it. Returns the problems, prefixed with the player.
 */
export function reconcileTrialReportCopy(playerId, copy, derived, { hint = 'resolve the record before writing it' } = {}) {
  if (copy === null || copy === undefined) return [];
  return reconcileTrialReports(copy, derived, { hint }).map((p) => `players ${playerId}: ${p}`);
}

/** Read the `trials` collection off a database file (a blob until its own step), for snapshot tools and the migration. */
export function readTrialsBlob(sqlite) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get()) return [];
  const row = sqlite.prepare("SELECT value FROM collections WHERE name = 'trials'").get();
  if (!row) return [];
  let v; try { v = JSON.parse(row.value); } catch { return null; }
  return Array.isArray(v) ? v : null;
}

/** Every player of the live tables as full records (the S5 read path), for snapshot tools and rollback: `[{ record, row }]` in rowid order. */
export function readPlayersWithChildren(sqlite, st, { trials } = {}) {
  const children = readAllChildren(st);
  return sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players WHERE deleted_at IS NULL ORDER BY rowid`).all().map((row) => ({ // S4b-R: a retained row is not a player record
    row,
    record: playerFromRow(row, { children: children.get(row.id) ?? emptyChildren(), trialReports: trials === undefined ? undefined : trialReportsFor(trials, row.id) }),
  }));
}
export { emptyChildren };
