/**
 * Player sub-records: the eleven lists a player record carries — `media`, `attendance`, `timeline`, `badges`,
 * `drills`, `drillResults`, `activityLog`, `externalIds`, `seasonHistory`, `medical.records`,
 * `programme.completed` — are rows of the twelve `player_*` tables created by migration `0007_player_subrecords`
 * (`media[].tags{}` is the twelfth, `player_media_tags`). The players repository (players.ts) is the one writer.
 * `trialReports` is not stored here: it is the trials' reports, read from the recruitment tables.
 *
 *   - no identifier is minted: a row without a client-visible id is keyed by `(player_id, position)`; every table
 *     carries `position` (the list index) and reads back in that order, so order and legal duplicates survive;
 *   - typed columns, valid input only: an item is its columns. A write stores the known fields (an unknown one is not
 *     stored). An item reads back with its fields in the spec's order: a NULL column is `null` for the fields the
 *     writers set explicitly (`nullable`) and omitted otherwise; a clip always carries `tags`;
 *   - a value a column cannot hold is REFUSED with the field, the index and the reason (`media[2].title is
 *     absent`); a natural key the code enforces (season, drill, provider and external id, tag, every item id) is
 *     refused when a list repeats it, never deduplicated.
 *
 * An external id's `reviewId` names the identity review it was linked from (the review keeps the imported row).
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { migrationApplied, childRowsOf, type Row } from './database.ts';

export const PLAYER_SUBRECORDS_MIGRATION = '0007_player_subrecords';
/** The top-level lists stored as rows. */
export const PLAYER_SUBRECORD_KEYS = Object.freeze([
  'media',
  'attendance',
  'timeline',
  'badges',
  'drills',
  'drillResults',
  'activityLog',
  'externalIds',
  'seasonHistory',
] as const);
/** Are the sub-record tables in use on this connection? Decided by the migration record, never by the tables existing. */
export const subrecordsLive = (sqlite: DatabaseSync): boolean => migrationApplied(sqlite, PLAYER_SUBRECORDS_MIGRATION);

/** The array keys the repository writes, as the writers name them: `medical.records` and `programme.completed` are the lists inside the `medical` and `programme` blocks. */
export const SUBRECORD_KEYS = Object.freeze([
  ...PLAYER_SUBRECORD_KEYS,
  'medical.records',
  'programme.completed',
] as const);
export type PlayerListKey = (typeof PLAYER_SUBRECORD_KEYS)[number];
export type SubrecordKey = (typeof SUBRECORD_KEYS)[number];

export const SUBRECORD_TABLES = Object.freeze([
  'player_season_history',
  'player_badges',
  'player_drills',
  'player_attendance',
  'player_timeline',
  'player_media',
  'player_media_tags',
  'player_medical_records',
  'player_drill_results',
  'player_activity_log',
  'player_external_ids',
  'player_programme_completions',
] as const);

// ------------------------------------------------------------------ the items, as they read back
/** A clip. `tags` is tag → count, in the order they were written. */
export type MediaItem = {
  id: string;
  title: string;
  kind?: string;
  /** A UTC instant as toISOString writes it. */
  uploadedAt?: string;
  url: string | null;
  views: number;
  /** The attendance that verified the clip. */
  verifiedClip: string | null;
  captions: string | null;
  sizeBytes?: number;
  capturedBy?: 'box_cam';
  boxSessionId?: string;
  tags: Record<string, number>;
};
export type AttendanceItem = {
  id: string;
  fixture: string;
  venue?: string;
  date: string;
  gps: { lat: number; lng: number } | null;
  deviceConfirmed?: boolean;
  verified: boolean;
  corroboratedBy?: string;
  trialId?: string;
};
export type TimelineItem = { year: string; event: string };
export type SeasonItem = {
  season: string;
  appearances?: number;
  goals?: number;
  assists?: number;
  paceKmh?: number;
  passCompletionPct?: number;
  duelSuccessPct?: number;
  cleanSheets?: number;
};
export type MedicalRecordItem = {
  id: string;
  type: string;
  title: string;
  date?: string;
  layoffWeeks: number | null;
  cleared: boolean | null;
};
export type DrillResultItem = {
  id: string;
  drillId: string;
  drillName?: string;
  metric: string;
  unit?: string;
  value: number;
  verified: boolean;
  ts: number;
};
export type ExternalIdItem = {
  provider: string;
  externalId: string;
  source: string;
  by?: string;
  at: number;
  reviewId?: string;
};
export type ProgrammeCompletionItem = { sessionId: string; ts: number };

/** The item each list holds, by the writers' key. */
export type SubrecordItems = {
  media: MediaItem;
  attendance: AttendanceItem;
  timeline: TimelineItem;
  badges: string;
  drills: string;
  drillResults: DrillResultItem;
  activityLog: number;
  externalIds: ExternalIdItem;
  seasonHistory: SeasonItem;
  'medical.records': MedicalRecordItem;
  'programme.completed': ProgrammeCompletionItem;
};
/**
 * An item as a writer hands it in: the required fields, and the others optional or null. Fields the list does not
 * store may ride along and are not stored.
 */
type Given<T, Req extends keyof T> = { [K in Req]: T[K] } & { [K in Exclude<keyof T, Req>]?: T[K] | null };
export type SubrecordInputs = {
  media: Given<MediaItem, 'id' | 'title'>;
  attendance: Given<AttendanceItem, 'id' | 'fixture' | 'date'>;
  timeline: TimelineItem;
  badges: string;
  drills: string;
  drillResults: Given<DrillResultItem, 'id' | 'drillId' | 'metric' | 'value' | 'ts'>;
  activityLog: number;
  externalIds: Given<ExternalIdItem, 'provider' | 'externalId' | 'source' | 'at'>;
  seasonHistory: Given<SeasonItem, 'season'>;
  'medical.records': Given<MedicalRecordItem, 'id' | 'type' | 'title'>;
  'programme.completed': ProgrammeCompletionItem;
};
/** The keys whose items are objects (the ones `patchItem` can change). */
export type ObjectListKey = { [K in SubrecordKey]: SubrecordItems[K] extends object ? K : never }[SubrecordKey];

/** One player's lists, as a record carries them. */
export type PlayerLists = { [K in PlayerListKey]: SubrecordItems[K][] } & {
  medical: { records: MedicalRecordItem[] };
  programme: { completed: ProgrammeCompletionItem[] };
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const setOwn = <T extends object>(o: T, k: string, v: unknown): T => {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  return o;
};
const describe = (v: unknown) =>
  v === null
    ? 'null'
    : v === undefined
      ? 'absent'
      : Array.isArray(v)
        ? 'an array'
        : typeof v === 'object'
          ? 'an object'
          : typeof v === 'bigint'
            ? 'a bigint'
            : `a ${typeof v}`;
const absentOrNull = (v: unknown): v is null | undefined => v === null || v === undefined;
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------ the DDL (what migration 0007 creates)
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
CREATE INDEX player_attendance_fixture ON player_attendance (match_date DESC, fixture);

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
  uploaded_at                 TEXT CHECK (uploaded_at IS NULL OR (length(uploaded_at) = 24 AND uploaded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  url                         TEXT,
  views                       INTEGER NOT NULL DEFAULT 0,
  verified_clip_attendance_id TEXT,
  captions                    TEXT,
  size_bytes                  INTEGER,
  captured_by                 TEXT CHECK (captured_by IS NULL OR captured_by IN ('box_cam')),
  box_session_id              TEXT
) STRICT;
CREATE UNIQUE INDEX player_media_player ON player_media (player_id, position);
CREATE INDEX player_media_uploaded ON player_media (uploaded_at) WHERE uploaded_at IS NOT NULL;
CREATE INDEX player_media_deck ON player_media ((verified_clip_attendance_id IS NOT NULL) DESC, views DESC, player_id, position) WHERE url IS NOT NULL;

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
  review_id      TEXT,
  PRIMARY KEY (player_id, provider, external_id)
) STRICT;
CREATE UNIQUE INDEX player_external_ids_position ON player_external_ids (player_id, position);
CREATE INDEX player_external_ids_lookup ON player_external_ids (provider, external_id);

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
// code enforces (refused when an array violates it).
type ItemType = 'text' | 'date' | 'instant' | 'int' | 'real' | 'bool' | 'json';
type ItemSpec = {
  scalars: Readonly<Record<string, string>>;
  booleans: ReadonlySet<string>;
  json: ReadonlySet<string>;
  composites: Readonly<Record<string, Readonly<Record<string, string>>>>;
  defaults: Readonly<Record<string, SQLInputValue>>;
  columns: readonly string[];
};
/** A list of objects, one row each. */
type ObjectListSpec = {
  table: string;
  primitive?: undefined;
  idKey?: string;
  children?: 'tags';
  spec: ItemSpec;
  /** Record key → the type its column holds. */
  types: Readonly<Record<string, ItemType>>;
  /** Keys that must be present and non-null. */
  required: readonly string[];
  enums?: Readonly<Record<string, readonly string[]>>;
  unique?: readonly (readonly string[])[];
  nullable?: readonly string[];
};
/** A list of plain values: the value IS the item. */
type PrimitiveListSpec = { table: string; primitive: 'text' | 'int'; column: string; unique?: boolean };
type ListSpec = ObjectListSpec | PrimitiveListSpec;

const itemSpec = ({
  scalars,
  booleans = [],
  json = [],
  composites = {},
  defaults = {},
  columns,
}: {
  scalars: Record<string, string>;
  booleans?: string[];
  json?: string[];
  composites?: Record<string, Record<string, string>>;
  defaults?: Record<string, SQLInputValue>;
  columns: string[];
}): ItemSpec =>
  Object.freeze({
    scalars: Object.freeze(scalars),
    booleans: new Set(booleans),
    json: new Set(json),
    composites: Object.freeze(composites),
    defaults: Object.freeze(defaults),
    columns: Object.freeze(columns),
  });
/** A clip's upload instant, as every writer stores it (toISOString), so the feed compares it as text in SQL. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const listSpec = (s: ListSpec): ListSpec => Object.freeze(s);
export const SUBRECORD_SPECS: Readonly<Record<SubrecordKey, ListSpec>> = Object.freeze({
  media: listSpec({
    table: 'player_media',
    idKey: 'id',
    children: 'tags',
    spec: itemSpec({
      scalars: {
        id: 'id',
        title: 'title',
        kind: 'kind',
        uploadedAt: 'uploaded_at',
        url: 'url',
        views: 'views',
        verifiedClip: 'verified_clip_attendance_id',
        captions: 'captions',
        sizeBytes: 'size_bytes',
        capturedBy: 'captured_by',
        boxSessionId: 'box_session_id',
      },
      defaults: { views: 0 },
      columns: [
        'id',
        'title',
        'kind',
        'uploaded_at',
        'url',
        'views',
        'verified_clip_attendance_id',
        'captions',
        'size_bytes',
        'captured_by',
        'box_session_id',
      ],
    }),
    types: {
      id: 'text',
      title: 'text',
      kind: 'text',
      uploadedAt: 'instant',
      url: 'text',
      views: 'int',
      verifiedClip: 'text',
      captions: 'text',
      sizeBytes: 'int',
      capturedBy: 'text',
      boxSessionId: 'text',
    },
    required: ['id', 'title'],
    enums: { capturedBy: ['box_cam'] },
    unique: [['id']],
    nullable: ['url', 'verifiedClip', 'captions'],
  }),
  attendance: listSpec({
    table: 'player_attendance',
    idKey: 'id',
    spec: itemSpec({
      scalars: {
        id: 'id',
        fixture: 'fixture',
        venue: 'venue',
        date: 'match_date',
        deviceConfirmed: 'device_confirmed',
        verified: 'verified',
        corroboratedBy: 'corroborated_by',
        trialId: 'trial_id',
      },
      booleans: ['deviceConfirmed', 'verified'],
      composites: { gps: { lat: 'lat', lng: 'lng' } },
      defaults: { verified: 0 },
      columns: [
        'id',
        'fixture',
        'venue',
        'match_date',
        'lat',
        'lng',
        'device_confirmed',
        'verified',
        'corroborated_by',
        'trial_id',
      ],
    }),
    types: {
      id: 'text',
      fixture: 'text',
      venue: 'text',
      date: 'text',
      deviceConfirmed: 'bool',
      verified: 'bool',
      corroboratedBy: 'text',
      trialId: 'text',
    },
    required: ['id', 'fixture', 'date'],
    unique: [['id']],
    nullable: ['gps'],
  }),
  timeline: listSpec({
    table: 'player_timeline',
    spec: itemSpec({ scalars: { year: 'year', event: 'event' }, columns: ['year', 'event'] }),
    types: { year: 'text', event: 'text' },
    required: ['year', 'event'],
  }),
  seasonHistory: listSpec({
    table: 'player_season_history',
    spec: itemSpec({
      scalars: {
        season: 'season',
        appearances: 'appearances',
        goals: 'goals',
        assists: 'assists',
        paceKmh: 'pace_kmh',
        passCompletionPct: 'pass_completion_pct',
        duelSuccessPct: 'duel_success_pct',
        cleanSheets: 'clean_sheets',
      },
      columns: [
        'season',
        'appearances',
        'goals',
        'assists',
        'pace_kmh',
        'pass_completion_pct',
        'duel_success_pct',
        'clean_sheets',
      ],
    }),
    // The stats route files any non-negative finite number into a season (the current-season `stats_*` columns are stricter): REAL columns, nothing coerced.
    types: {
      season: 'text',
      appearances: 'real',
      goals: 'real',
      assists: 'real',
      paceKmh: 'real',
      passCompletionPct: 'real',
      duelSuccessPct: 'real',
      cleanSheets: 'real',
    },
    required: ['season'],
    unique: [['season']],
  }),
  'medical.records': listSpec({
    table: 'player_medical_records',
    idKey: 'id',
    spec: itemSpec({
      scalars: {
        id: 'id',
        type: 'type',
        title: 'title',
        date: 'record_date',
        layoffWeeks: 'layoff_weeks',
        cleared: 'cleared',
      },
      booleans: ['cleared'],
      columns: ['id', 'type', 'title', 'record_date', 'layoff_weeks', 'cleared'],
    }),
    types: { id: 'text', type: 'text', title: 'text', date: 'date', layoffWeeks: 'real', cleared: 'bool' },
    required: ['id', 'type', 'title'],
    unique: [['id']],
    nullable: ['layoffWeeks', 'cleared'],
  }),
  drillResults: listSpec({
    table: 'player_drill_results',
    idKey: 'id',
    spec: itemSpec({
      scalars: {
        id: 'id',
        drillId: 'drill_id',
        drillName: 'drill_name',
        metric: 'metric',
        unit: 'unit',
        value: 'value',
        verified: 'verified',
        ts: 'recorded_at',
      },
      booleans: ['verified'],
      defaults: { verified: 0 },
      columns: ['id', 'drill_id', 'drill_name', 'metric', 'unit', 'value', 'verified', 'recorded_at'],
    }),
    types: {
      id: 'text',
      drillId: 'text',
      drillName: 'text',
      metric: 'text',
      unit: 'text',
      value: 'real',
      verified: 'bool',
      ts: 'int',
    },
    required: ['id', 'drillId', 'metric', 'value', 'ts'],
    unique: [['id']],
  }),
  externalIds: listSpec({
    table: 'player_external_ids',
    spec: itemSpec({
      scalars: {
        provider: 'provider',
        externalId: 'external_id',
        source: 'source',
        by: 'linked_by_name',
        at: 'linked_at',
        reviewId: 'review_id',
      },
      columns: ['provider', 'external_id', 'source', 'linked_by_name', 'linked_at', 'review_id'],
    }),
    types: { provider: 'text', externalId: 'text', source: 'text', by: 'text', at: 'int', reviewId: 'text' },
    required: ['provider', 'externalId', 'source', 'at'],
    unique: [['provider', 'externalId']],
  }),
  'programme.completed': listSpec({
    table: 'player_programme_completions',
    spec: itemSpec({
      scalars: { sessionId: 'session_id', ts: 'completed_at' },
      columns: ['session_id', 'completed_at'],
    }),
    types: { sessionId: 'text', ts: 'int' },
    required: ['sessionId', 'ts'],
  }),
  // Primitive arrays: the value IS the item.
  badges: listSpec({ table: 'player_badges', primitive: 'text', column: 'badge' }),
  drills: listSpec({ table: 'player_drills', primitive: 'text', column: 'drill_id', unique: true }),
  activityLog: listSpec({ table: 'player_activity_log', primitive: 'int', column: 'occurred_at' }),
});

/** Read an array off a record by its writer name (`medical.records` → `rec.medical?.records`). */
export function getSubrecords(rec: unknown, key: string): unknown {
  if (!isPlainObject(rec)) return undefined;
  if (!key.includes('.')) return rec[key];
  const [k, sub] = key.split('.');
  const composite = rec[k];
  return isPlainObject(composite) ? composite[sub] : undefined;
}

// ------------------------------------------------------------------ validation (field, index and reason; nothing coerced)
const checkValue = (
  problems: string[],
  label: string,
  v: unknown,
  type: ItemType,
  { required = false, enums = null }: { required?: boolean; enums?: readonly string[] | null } = {},
) => {
  if (v === undefined) {
    if (required) problems.push(`${label} is absent`);
    return;
  }
  if (v === null) {
    if (required) problems.push(`${label} is null`);
    return;
  }
  switch (type) {
    case 'text':
      if (typeof v !== 'string') problems.push(`${label} is ${describe(v)}, not text`);
      break;
    case 'date':
      if (typeof v !== 'string') problems.push(`${label} is ${describe(v)}, not text`);
      else if (v.length !== 10) problems.push(`${label} is not a 10-character date (YYYY-MM-DD)`);
      break;
    case 'instant':
      if (typeof v !== 'string') problems.push(`${label} is ${describe(v)}, not text`);
      else if (!INSTANT_RE.test(v) || Number.isNaN(Date.parse(v)))
        problems.push(`${label} is not a UTC instant as toISOString writes it (YYYY-MM-DDTHH:MM:SS.sssZ)`);
      break;
    case 'int':
      if (!isSafeInt(v))
        problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a safe integer`);
      break;
    case 'real':
      if (!isFinite_(v))
        problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a finite number`);
      break;
    case 'bool':
      if (typeof v !== 'boolean') problems.push(`${label} is ${describe(v)}, not a boolean`);
      break;
    case 'json':
      try {
        JSON.stringify(v);
      } catch (err) {
        problems.push(`${label} cannot be stored as JSON (${String((err as Error)?.message ?? err).slice(0, 80)})`);
      }
      break;
    default:
      throw new Error(`unknown item type ${type}`);
  }
  if (enums && typeof v === 'string' && !enums.includes(v)) problems.push(`${label} is not one of ${enums.join('/')}`);
};

const specOf = (key: string): ListSpec | undefined =>
  Object.hasOwn(SUBRECORD_SPECS, key) ? SUBRECORD_SPECS[key as SubrecordKey] : undefined;

/** Validate one item of `key` (an index for the label); returns the problems. Unknown fields are not problems: they are not stored. */
export function validateSubrecordItem(key: string, item: unknown, index: number | null = null): string[] {
  const def = specOf(key);
  if (!def) return [`"${key}" is not a player sub-record`];
  const at = index === null ? key : `${key}[${index}]`;
  const problems: string[] = [];
  if (def.primitive) {
    if (def.primitive === 'text' && typeof item !== 'string') problems.push(`${at} is ${describe(item)}, not text`);
    if (def.primitive === 'int' && !isSafeInt(item))
      problems.push(`${at} is ${typeof item === 'number' ? String(item) : describe(item)}, not a safe integer`);
    return problems;
  }
  if (!isPlainObject(item)) return [`${at} is ${describe(item)}, not an object`];
  for (const [k, type] of Object.entries(def.types))
    checkValue(problems, `${at}.${k}`, item[k], type, {
      required: def.required.includes(k),
      enums: def.enums?.[k] ?? null,
    });
  for (const [ck, subs] of Object.entries(def.spec.composites)) {
    const v = item[ck];
    if (absentOrNull(v)) continue;
    if (!isPlainObject(v)) {
      problems.push(`${at}.${ck} is ${describe(v)}, not an object`);
      continue;
    }
    const present = Object.keys(subs).filter((s) => !absentOrNull(v[s]));
    if (present.length && present.length !== Object.keys(subs).length)
      problems.push(
        `${at}.${ck} has ${present.join('/')} without ${Object.keys(subs)
          .filter((s) => !present.includes(s))
          .join('/')}`,
      );
    for (const s of Object.keys(subs))
      if (!absentOrNull(v[s]) && !isFinite_(v[s]))
        problems.push(`${at}.${ck}.${s} is ${describe(v[s])}, not a finite number`);
  }
  if (def.children === 'tags' && !absentOrNull(item.tags)) {
    if (!isPlainObject(item.tags)) problems.push(`${at}.tags is ${describe(item.tags)}, not an object of tag → count`);
    else
      for (const [tag, n] of Object.entries(item.tags))
        if (!isSafeInt(n) || n <= 0)
          problems.push(
            `${at}.tags.${tag} is ${typeof n === 'number' ? String(n) : describe(n)}, not a positive integer`,
          );
  }
  return problems;
}

/** Validate a whole array of `key` (items and the natural keys the code enforces); `null`/absent is valid. */
export function validateSubrecordArray(key: string, items: unknown): string[] {
  if (absentOrNull(items)) return [];
  if (!Array.isArray(items)) return [`${key} is ${describe(items)}, not an array`];
  const problems: string[] = [];
  items.forEach((item, i) => problems.push(...validateSubrecordItem(key, item, i)));
  if (problems.length) return problems;
  // Every item passed validateSubrecordItem, so the key names a list.
  const def = specOf(key) as ListSpec;
  if (def.primitive) {
    if (def.unique) {
      const seen = new Map<unknown, number>();
      items.forEach((v, i) => {
        if (seen.has(v))
          problems.push(
            `${key}[${i}] repeats ${JSON.stringify(v)} (first at [${seen.get(v)}]); the table keys ${key} by value and nothing is deduplicated`,
          );
        else seen.set(v, i);
      });
    }
    return problems;
  }
  for (const cols of def.unique ?? []) {
    const seen = new Map<string, number>();
    items.forEach((item: Record<string, unknown>, i) => {
      const k = JSON.stringify(cols.map((c) => item[c]));
      if (seen.has(k))
        problems.push(
          `${key}[${i}] repeats ${cols.join('+')} ${cols.map((c) => JSON.stringify(item[c])).join('/')} (first at [${seen.get(k)}]); the table keys ${key} by it and nothing is deduplicated`,
        );
      else seen.set(k, i);
    });
  }
  return problems;
}

// ------------------------------------------------------------------ item ⇄ row
type Params = Record<string, SQLInputValue>;
type TagRow = { media_id: string; position: number; tag: string; count: number };
const insertSql = (table: string, columns: readonly string[]) =>
  `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;

/** The row of a valid item: its known fields in their columns (unknown fields are not stored), the table defaults where it leaves a required column out. */
function itemToRow(def: ObjectListSpec, item: Record<string, unknown>): Params {
  const s = def.spec;
  const row: Params = {};
  for (const c of s.columns) row[c] = null;
  for (const [k, col] of Object.entries(s.scalars)) {
    const v = item[k];
    if (absentOrNull(v)) continue;
    row[col] = s.booleans.has(k) ? (v ? 1 : 0) : s.json.has(k) ? JSON.stringify(v) : (v as SQLInputValue);
  }
  for (const [ck, subs] of Object.entries(s.composites)) {
    const v = item[ck];
    if (isPlainObject(v))
      for (const [sub, col] of Object.entries(subs)) if (!absentOrNull(v[sub])) row[col] = v[sub] as SQLInputValue;
  }
  for (const [col, dflt] of Object.entries(s.defaults)) if (row[col] === null) row[col] = dflt;
  return row;
}
/** The item a row holds: its fields in the spec's order; a NULL column is `null` for a `nullable` field and omitted otherwise. */
function itemFromRow(
  def: ObjectListSpec,
  row: Readonly<Record<string, unknown>>,
  tagRows: readonly { tag: unknown; count: unknown }[] | undefined | null,
): Record<string, unknown> {
  const s = def.spec;
  const nullable = def.nullable ?? [];
  const item: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(s.scalars)) {
    const v = row[col];
    if (v === null || v === undefined) {
      if (nullable.includes(k)) item[k] = null;
      continue;
    }
    item[k] = s.booleans.has(k) ? v === 1 : s.json.has(k) ? JSON.parse(v as string) : v;
  }
  for (const [ck, subs] of Object.entries(s.composites)) {
    const cols = Object.entries(subs);
    if (cols.every(([, col]) => row[col] !== null && row[col] !== undefined))
      item[ck] = Object.fromEntries(cols.map(([sub, col]) => [sub, row[col]]));
    else if (nullable.includes(ck)) item[ck] = null;
  }
  if (def.children === 'tags') {
    const tags = {};
    for (const t of tagRows ?? []) setOwn(tags, t.tag as string, t.count);
    item.tags = tags;
  }
  return item;
}

/** The rows an item becomes: `{ row, tags }` (tags only for media). */
export function itemRows(
  key: SubrecordKey,
  item: unknown,
  position: number,
  playerId: string | null,
): { row: Params; tags: TagRow[] | null } {
  const def = SUBRECORD_SPECS[key];
  if (def.primitive) return { row: { player_id: playerId, position, [def.column]: item as SQLInputValue }, tags: null };
  const it = item as Record<string, unknown>;
  const row = itemToRow(def, it);
  row.player_id = playerId;
  row.position = position;
  let tags: TagRow[] | null = null;
  if (def.children === 'tags' && isPlainObject(it.tags))
    tags = Object.entries(it.tags).map(([tag, count], i) => ({
      media_id: it.id as string,
      position: i,
      tag,
      count: count as number,
    }));
  return { row, tags };
}
/** A valid item exactly as the tables will read it back. */
export function storedItem<K extends SubrecordKey>(key: K, item: unknown): SubrecordItems[K] {
  const def = SUBRECORD_SPECS[key];
  if (def.primitive) return item as SubrecordItems[K];
  const { row, tags } = itemRows(key, item, 0, null);
  return itemFromRow(def, row, tags) as SubrecordItems[K];
}
const columnsOf = (key: SubrecordKey): string[] => {
  const def = SUBRECORD_SPECS[key];
  return def.primitive ? ['player_id', 'position', def.column] : ['player_id', 'position', ...def.spec.columns];
};

type ListStatements = {
  insert: StatementSync;
  deleteAll: StatementSync;
  selectPlayer: StatementSync;
  count: StatementSync;
  /** By the item's id, or by its position for a list without ids; a list of plain values has none. */
  update?: StatementSync;
};
/** The prepared statements of every list table, and of the clips' tags. */
export type SubrecordStatements = Record<SubrecordKey, ListStatements> & {
  tags: { insert: StatementSync; deleteMedia: StatementSync; selectPlayer: StatementSync; count: StatementSync };
};

/** Prepared statements for every table (built once per connection by the callers below). */
export function prepareSubrecordStatements(sqlite: DatabaseSync): SubrecordStatements {
  const lists = {} as Record<SubrecordKey, ListStatements>;
  for (const key of SUBRECORD_KEYS) {
    const def = SUBRECORD_SPECS[key];
    const s: ListStatements = {
      insert: sqlite.prepare(insertSql(def.table, columnsOf(key))),
      deleteAll: sqlite.prepare(`DELETE FROM ${def.table} WHERE player_id = ?`),
      selectPlayer: sqlite.prepare(
        `SELECT ${columnsOf(key).join(', ')} FROM ${def.table} WHERE player_id = ? ORDER BY position`,
      ),
      count: sqlite.prepare(`SELECT COUNT(*) AS n FROM ${def.table}`),
    };
    if (!def.primitive && def.idKey)
      s.update = sqlite.prepare(
        `UPDATE ${def.table} SET ${columnsOf(key)
          .filter((c) => c !== 'id' && c !== 'player_id')
          .map((c) => `${c} = @${c}`)
          .join(', ')} WHERE id = @id AND player_id = @player_id`,
      );
    else if (!def.primitive)
      s.update = sqlite.prepare(
        `UPDATE ${def.table} SET ${columnsOf(key)
          .filter((c) => c !== 'player_id' && c !== 'position')
          .map((c) => `${c} = @${c}`)
          .join(', ')} WHERE player_id = @player_id AND position = @position`,
      );
    lists[key] = s;
  }
  return Object.assign(lists, {
    tags: {
      insert: sqlite.prepare(
        'INSERT INTO player_media_tags (media_id, position, tag, count) VALUES (@media_id, @position, @tag, @count)',
      ),
      deleteMedia: sqlite.prepare('DELETE FROM player_media_tags WHERE media_id = ?'),
      selectPlayer: sqlite.prepare(
        'SELECT t.media_id, t.position, t.tag, t.count FROM player_media_tags t JOIN player_media m ON m.id = t.media_id WHERE m.player_id = ? ORDER BY t.media_id, t.position',
      ),
      count: sqlite.prepare('SELECT COUNT(*) AS n FROM player_media_tags'),
    },
  });
}

/** Write every row of one array of one player (positions 0..n−1), inside the caller's transaction. */
export function writeArrayRows(st: SubrecordStatements, key: SubrecordKey, playerId: string, items: unknown): number {
  if (!Array.isArray(items)) return 0;
  items.forEach((item, i) => {
    const { row, tags } = itemRows(key, item, i, playerId);
    st[key].insert.run(row);
    if (tags) for (const t of tags) st.tags.insert.run(t);
  });
  return items.length;
}
/** Write every array of a record (`players.insert`). Returns rows per table. */
export function writeChildRows(st: SubrecordStatements, rec: { id: string }): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of SUBRECORD_KEYS) {
    const items = getSubrecords(rec, key);
    const n = writeArrayRows(st, key, rec.id, items);
    counts[SUBRECORD_SPECS[key].table] = (counts[SUBRECORD_SPECS[key].table] ?? 0) + n;
  }
  return counts;
}
/** Delete every child row of a player (the media tags cascade with their clips). */
export function deleteChildRows(st: SubrecordStatements, playerId: string): void {
  for (const key of SUBRECORD_KEYS) st[key].deleteAll.run(playerId);
}

const itemFromRows = (key: SubrecordKey, row: Row, tagRows: Row[] | undefined): unknown => {
  const def = SUBRECORD_SPECS[key];
  return def.primitive ? row[def.column] : itemFromRow(def, row, tagRows as { tag: unknown; count: unknown }[]);
};
const emptyChildren = (): PlayerLists => ({
  media: [],
  attendance: [],
  timeline: [],
  badges: [],
  drills: [],
  drillResults: [],
  activityLog: [],
  externalIds: [],
  seasonHistory: [],
  medical: { records: [] },
  programme: { completed: [] },
});
const placeChild = (children: PlayerLists, key: SubrecordKey, item: unknown) => {
  if (key === 'medical.records') children.medical.records.push(item as MedicalRecordItem);
  else if (key === 'programme.completed') children.programme.completed.push(item as ProgrammeCompletionItem);
  else (children[key] as unknown[]).push(item);
};
const tagsByMedia = (rows: Row[]) => {
  const tags = new Map<unknown, Row[]>();
  for (const t of rows) {
    let list = tags.get(t.media_id);
    if (!list) tags.set(t.media_id, (list = []));
    list.push(t);
  }
  return tags;
};

/** One player's lists (`{ media: [...], …, medical: { records }, programme: { completed } }`). */
export function readChildren(st: SubrecordStatements, playerId: string): PlayerLists {
  const children = emptyChildren();
  const tags = tagsByMedia(st.tags.selectPlayer.all(playerId));
  for (const key of SUBRECORD_KEYS)
    for (const row of st[key].selectPlayer.all(playerId))
      placeChild(children, key, itemFromRows(key, row, tags.get(row.id)));
  return children;
}
/** The lists of many players in one query per table (never a query per player): Map player id → lists. */
export function readChildrenFor(sqlite: DatabaseSync, ids: readonly string[]): Map<string, PlayerLists> {
  const out = new Map(ids.map((id) => [id, emptyChildren()]));
  if (!ids.length) return out;
  const tags = tagsByMedia(
    sqlite
      .prepare(
        'SELECT t.media_id, t.position, t.tag, t.count FROM player_media_tags t JOIN player_media m ON m.id = t.media_id WHERE m.player_id IN (SELECT value FROM json_each(?)) ORDER BY t.media_id, t.position',
      )
      .all(JSON.stringify(ids)),
  );
  for (const key of SUBRECORD_KEYS) {
    const rows = childRowsOf(sqlite, SUBRECORD_SPECS[key].table, 'player_id', ids, { order: 'position' });
    for (const id of ids)
      for (const row of rows.all(id))
        placeChild(out.get(id) as PlayerLists, key, itemFromRows(key, row, tags.get(row.id)));
  }
  return out;
}
/** Rows per table, for reports (counts only). */
export function countChildRows(st: SubrecordStatements): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of SUBRECORD_KEYS) out[SUBRECORD_SPECS[key].table] = (st[key].count.get() as { n: number }).n;
  out.player_media_tags = (st.tags.count.get() as { n: number }).n;
  return out;
}
