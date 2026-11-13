/**
 * What the players and guardians repositories (players.ts, guardians.ts) share: the text and number limits, the
 * notification preferences both carry, the stored password hash, and the refusals. Refusals carry a code and name the
 * id and the field, never a value. The organisations repository (orgs.ts) is built on the same refusals, statement
 * cache, reads and paging, and the staff repository (users.ts) on its refusals, statement cache and reads.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { operationOn, type Operation, type UnitParticipant } from './database.ts';
import { pageOf as pageOfRows } from '../domains/platform/paging.mjs';
import { isPlainObject } from './fieldSpecs.ts';

/** Text lengths and number ranges, one definition for the typing, the DDL and the routes. */
export const IDENTITY_LIMITS = Object.freeze({
  id: 80,
  name: 120,
  country: 40,
  city: 80,
  marketValueRange: 60,
  agentName: 120,
  footballCategory: 40,
  conditionStatus: 40,
  programmeTrack: 60,
  timezone: 64,
  passwordHash: 512,
  email: 254,
  idvReference: 120,
  heightCm: [50, 250] as const,
  weightKg: [15, 200] as const,
  squadNumber: [0, 999] as const,
  pct: [0, 100] as const,
});
const L = IDENTITY_LIMITS;

/**
 * A refusal: an Error with a `code` (`PLAYER_NOT_FOUND`, …) and, for a refused record, its `problems`, or the `field`
 * a uniqueness rule refused.
 */
export type IdentityRefusal = Error & { code: string; problems?: string[]; field?: string };
export const refusal = (
  code: string,
  message: string,
  extra: { problems?: string[]; field?: string } = {},
): IdentityRefusal => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });

export { isPlainObject };
/** A stored instant: a non-negative whole number of milliseconds. */
export const isClock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const describe = (v: unknown) =>
  v === null
    ? 'null'
    : v === undefined
      ? 'absent'
      : Array.isArray(v)
        ? 'an array'
        : typeof v === 'object'
          ? 'an object'
          : `a ${typeof v}`;
export const textOk = (v: unknown, max: number, min = 1): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;
export const optTextOk = (v: unknown, max: number): v is string | null => v === null || textOk(v, max);
export const intIn = (v: unknown, [lo, hi]: readonly [number, number]): v is number =>
  Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
export const clone = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
/** The fields given: an undefined field is an absent one. */
export const given = (raw: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
export const allNull = (...vs: unknown[]) => vs.every((v) => v === null || v === undefined);
/** A stored flag. */
export const b = (v: unknown): 0 | 1 => (v ? 1 : 0);
/** A stored flag that may be unset. */
export const nb = (v: unknown): 0 | 1 | null => (v === null || v === undefined ? null : v ? 1 : 0);

// ------------------------------------------------------------------ the DDL's column checks
export const inList = (col: string, xs: readonly string[]) =>
  `CHECK (${col} IN (${xs.map((x) => `'${x}'`).join(', ')}))`;
export const optList = (col: string, xs: readonly string[]) =>
  `CHECK (${col} IS NULL OR ${col} IN (${xs.map((x) => `'${x}'`).join(', ')}))`;
export const optText = (col: string, max: number, min = 1) =>
  `CHECK (${col} IS NULL OR length(${col}) BETWEEN ${min} AND ${max})`;
export const flag = (col: string) => `INTEGER NOT NULL DEFAULT 0 CHECK (${col} IN (0,1))`;
export const optFlag = (col: string) => `INTEGER CHECK (${col} IS NULL OR ${col} IN (0,1))`;
export const range = (col: string, [lo, hi]: readonly [number, number]) =>
  `CHECK (${col} IS NULL OR ${col} BETWEEN ${lo} AND ${hi})`;
export const HHMM = (col: string) =>
  `CHECK (${col} IS NULL OR (length(${col}) = 5 AND ${col} GLOB '[0-2][0-9]:[0-5][0-9]'))`;

// ------------------------------------------------------------------ notification preferences
/** A player's or guardian's quiet hours and school-hours mute. */
export type NotificationPrefs = {
  /** HH:MM */
  quietStart: string | null;
  /** HH:MM */
  quietEnd: string | null;
  schoolHoursMute: boolean | null;
  timezone: string | null;
};
export const PREFS_KEYS = Object.freeze(['quietStart', 'quietEnd', 'schoolHoursMute', 'timezone'] as const);
export const NO_PREFS: Readonly<NotificationPrefs> = Object.freeze({
  quietStart: null,
  quietEnd: null,
  schoolHoursMute: null,
  timezone: null,
});
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isPrefsKey = (k: string) => (PREFS_KEYS as readonly string[]).includes(k);

/** Incoming preferences with every key present (absent ones null), unknown keys kept for the check to refuse. */
export const prefsWithDefaults = (n: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(PREFS_KEYS.map((k) => [k, n[k] === undefined ? null : n[k]])),
  ...Object.fromEntries(Object.entries(n).filter(([k]) => !isPrefsKey(k))),
});
export function prefsProblems(n: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['quietStart', 'quietEnd'] as const) {
    const v = n[k];
    if (v !== null && !(typeof v === 'string' && HHMM_RE.test(v)))
      out.push(`notificationPrefs.${k} must be HH:MM or null`);
  }
  if (n.schoolHoursMute !== null && typeof n.schoolHoursMute !== 'boolean')
    out.push('notificationPrefs.schoolHoursMute must be a boolean or null');
  if (!optTextOk(n.timezone, L.timezone))
    out.push(`notificationPrefs.timezone must be text of 1 to ${L.timezone} characters or null`);
  return out;
}
/** The problems of a record's `notificationPrefs` (null, or exactly the four keys). */
export function recordPrefsProblems(n: unknown): string[] {
  if (n === null) return [];
  if (!isPlainObject(n) || Object.keys(n).some((k) => !isPrefsKey(k)))
    return [`notificationPrefs must be { ${PREFS_KEYS.join(', ')} } or null (got ${describe(n)})`];
  return prefsProblems(n);
}
/** A whole replacement of the preferences: every key present, no other. */
export const prefsReplacementProblems = (n: unknown): string[] =>
  isPlainObject(n) && Object.keys(n).every(isPrefsKey) && PREFS_KEYS.every((k) => k in n)
    ? prefsProblems(n)
    : [`notificationPrefs must be { ${PREFS_KEYS.join(', ')} } or null (got ${describe(n)})`];
/** The preferences a row's `prefs_*` columns hold; null when every one is NULL. */
export const prefsFromRow = (d: {
  prefs_quiet_start: unknown;
  prefs_quiet_end: unknown;
  prefs_school_hours_mute: unknown;
  prefs_timezone: unknown;
}): NotificationPrefs | null =>
  allNull(d.prefs_quiet_start, d.prefs_quiet_end, d.prefs_school_hours_mute, d.prefs_timezone)
    ? null
    : {
        quietStart: d.prefs_quiet_start as string | null,
        quietEnd: d.prefs_quiet_end as string | null,
        schoolHoursMute: d.prefs_school_hours_mute === null ? null : d.prefs_school_hours_mute === 1,
        timezone: d.prefs_timezone as string | null,
      };
/** The `prefs_*` columns of some preferences (all NULL for none). */
export const prefsParams = (n: Partial<NotificationPrefs> | null) => ({
  prefs_quiet_start: n?.quietStart ?? null,
  prefs_quiet_end: n?.quietEnd ?? null,
  prefs_school_hours_mute: nb(n?.schoolHoursMute),
  prefs_timezone: n?.timezone ?? null,
});

export const passwordProblem = (h: unknown): string | null =>
  h === null || textOk(h, L.passwordHash)
    ? null
    : `the password hash must be text of 1 to ${L.passwordHash} characters or null`;

// ------------------------------------------------------------------ what each repository is built on
/** The connection, its statements (prepared once each), the repository's transactional boundary and its clock. */
export type IdentityKit = {
  sqlite: DatabaseSync;
  q: (sql: string) => StatementSync;
  operation: Operation;
  now: () => number;
};
export function identityKit(sqlite: DatabaseSync, unit: UnitParticipant | null, now: () => number): IdentityKit {
  const cache = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  return { sqlite, q, operation: operationOn(sqlite, unit), now };
}
/** A repository's reads: every function of it except its writes, frozen. */
export const readsOf = <T extends object, W extends keyof T>(repo: T, writes: readonly W[]) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(repo).filter(
        ([k, v]) => typeof v === 'function' && !(writes as readonly PropertyKey[]).includes(k),
      ),
    ),
  ) as Readonly<Omit<T, W>>;

/** One page of `rows` (up to `limit + 1` in page order), with the cursor after its last row's key. */
export const pageOf = <T>(rows: T[], limit: number, keyOf: (row: T) => unknown[]) =>
  pageOfRows(rows, limit, keyOf) as { items: T[]; nextCursor: string | null };
