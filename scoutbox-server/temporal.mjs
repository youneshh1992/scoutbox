/**
 * M23 P5.7 — the platform's ONE temporal layer.
 *
 * Every date or time a security, lifecycle or compliance decision depends on
 * is read through this module. It exists because P5.6F found the same defect
 * five times under five names (F-2, F-3, F-8, F-12, F-12b): a value that could
 * not be read was treated as ABSENT or as VALID, and the decision that
 * depended on it failed open. The engine is polite — `new Date(null)` is the
 * epoch, `new Date('2010-02-30')` is 2 March, `Date.parse('2026-03-01T10:00')`
 * is whatever zone the server happens to run in — and politeness is exactly
 * what a permission check cannot afford.
 *
 * The principles this file freezes (M23_P57_TEMPORAL_TYPE_CONTRACT.md):
 *
 *   A. A value is one of FOUR types and never two: DATE_ONLY (`YYYY-MM-DD`,
 *      a calendar day, no zone), UTC_INSTANT (finite integer milliseconds, or
 *      ISO 8601 with an explicit offset or Z), LOCAL_DATETIME + IANA_ZONE
 *      (a wall-clock time that means nothing until a zone resolves it), and
 *      HISTORICAL_PARTIAL_DATE (year or year-month, display only, never a gate).
 *   B. Parsing is STRICT and ROUND-TRIPPED: the shape must match, the calendar
 *      day must exist, the time of day must exist. Nothing is repaired.
 *   C. An unreadable value in a decision is a REFUSAL, never "no bound".
 *      `null`/`undefined` may mean "no bound" where the field is optional;
 *      `NaN`, a string, an object, `false` and `0` never do.
 *   D. Boundaries: a start is INCLUSIVE, an end/expiry is EXCLUSIVE — the end
 *      instant is the first instant at which the thing no longer applies. A
 *      DATE_ONLY end means the whole of that day, so its instant is the start
 *      of the NEXT UTC day.
 *   E. Intervals are ordered: start < end, or the interval is refused.
 *   F. Every predicate takes an injected `now`; nothing here reads a clock.
 *   G. Every calculation is in UTC. Local getters (`getHours`, `getMonth`)
 *      are never used on a stored value.
 *   H. A zone is an exact IANA name this runtime knows; nothing guesses.
 *   I. Storage is normalised: DATE_ONLY as its string, instants as finite
 *      integer milliseconds. Values are re-validated at read, not trusted.
 *   J. Historical data is not over-hardened: a partial date stays partial.
 *   K. Authorization is decided BEFORE a date is validated, so a date error
 *      never reveals whether a record exists.
 *
 * Error codes (reused, not invented): DATE_INVALID, DOB_INVALID,
 * TIMESTAMP_INVALID, TIMEZONE_INVALID, INTERVAL_INVALID. Domain modules with
 * a frozen contract (Trial, Contact, Development Hub) map these onto their own
 * codes at the edge; the parsing is still this module's.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const TEMPORAL_ERRORS = Object.freeze({
  DATE_INVALID: 'DATE_INVALID',
  DOB_INVALID: 'DOB_INVALID',
  TIMESTAMP_INVALID: 'TIMESTAMP_INVALID',
  TIMEZONE_INVALID: 'TIMEZONE_INVALID',
  INTERVAL_INVALID: 'INTERVAL_INVALID',
  LOCAL_TIME_NONEXISTENT: 'LOCAL_TIME_NONEXISTENT',
  LOCAL_TIME_AMBIGUOUS: 'LOCAL_TIME_AMBIGUOUS',
});

/** Reasonableness bounds (§24). Nothing on this platform is dated before 1900 or after 2100. */
export const YEAR_MIN = 1900;
export const YEAR_MAX = 2100;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** True for a value that reads as "no value given" on an OPTIONAL field. Never true for 0, false, NaN. */
export const isAbsent = (v) => v === undefined || v === null || v === '';

/**
 * A finite millisecond instant, or null. The reader for STORED instants — the
 * same rule as the F-2/F-3 `readBoundary`: a finite number reads, anything
 * else (NaN, ±Infinity, a string, a boolean, an object) does not. Input
 * parsing is stricter (`parseInstant` refuses fractions); a stored fraction
 * is odd but unambiguous.
 */
export function readInstant(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The UTC calendar day of an instant, as DATE_ONLY. */
export const utcDayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// --------------------------------------------------------------- DATE_ONLY

/**
 * The one DATE_ONLY parser. `YYYY-MM-DD`, a day that exists, a year in
 * bounds. Returns the canonical string and the UTC-midnight instant of that
 * day, or a refusal that says why. `''`, `null`, `undefined` are refused here:
 * optional fields decide absence BEFORE they call this.
 */
export function parseStrictDateOnly(input, { yearMin = YEAR_MIN, yearMax = YEAR_MAX } = {}) {
  const bad = (why) => ({ ok: false, error: TEMPORAL_ERRORS.DATE_INVALID, why, expected: 'YYYY-MM-DD' });
  if (typeof input !== 'string') return bad('not text');
  const m = DATE_ONLY_RE.exec(input);
  if (!m) return bad('wrong shape');
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < yearMin || y > yearMax) return bad(`year outside ${yearMin}–${yearMax}`);
  if (mo < 1 || mo > 12) return bad('no such month');
  if (d < 1 || d > 31) return bad('no such day');
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // The round-trip: 30 February "parses" as 2 March. A day that only exists
  // because the engine rolled it over is not a day anyone was born on.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return bad('no such day in that month');
  return { ok: true, value: input, t };
}

/** A stored DATE_ONLY, or null when it cannot be read. */
export const readDateOnly = (v) => { const p = parseStrictDateOnly(v); return p.ok ? p.value : null; };

/** The first instant AFTER a DATE_ONLY day (principle D: a day-precision end covers the whole day). */
export function endOfDayExclusive(dateOnly) {
  const p = parseStrictDateOnly(dateOnly);
  return p.ok ? p.t + DAY_MS : null;
}

// ------------------------------------------------------------- UTC_INSTANT

/**
 * The one UTC_INSTANT parser. Accepts a finite integer millisecond timestamp
 * or an ISO 8601 date-time WITH an explicit offset or `Z`. A bare local time
 * (`2026-03-01T10:00`) is refused: its meaning depends on where the server
 * runs. A date-only string is refused: it is a DATE_ONLY, not an instant.
 * A numeric string is refused: "1700000000000" is text until someone says
 * what it is. Calendar day and time of day are both round-tripped.
 */
export function parseInstant(v, { yearMin = YEAR_MIN, yearMax = YEAR_MAX } = {}) {
  const bad = (why) => ({ ok: false, error: TEMPORAL_ERRORS.TIMESTAMP_INVALID, why, expected: 'ISO 8601 with offset or Z, or integer milliseconds' });
  let ms;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) return bad('not a whole number');
    ms = v;
  } else if (typeof v === 'string') {
    const m = ISO_INSTANT_RE.exec(v);
    if (!m) return bad('wrong shape');
    const day = parseStrictDateOnly(`${m[1]}-${m[2]}-${m[3]}`, { yearMin, yearMax });
    if (!day.ok) return bad('no such calendar day');
    const hh = Number(m[4]); const mm = Number(m[5]); const ss = Number(m[6] ?? 0);
    if (hh > 23 || mm > 59 || ss > 59) return bad('no such time of day');
    if (m[8] !== 'Z') {
      const oh = Number(m[8].slice(1, 3)); const om = Number(m[8].slice(4, 6));
      if (oh > 14 || om > 59) return bad('no such offset');
    }
    ms = Date.parse(v);
    if (!Number.isFinite(ms)) return bad('not a real date-time');
  } else {
    return bad('not a date-time');
  }
  const y = new Date(ms).getUTCFullYear();
  if (y < yearMin || y > yearMax) return bad(`year outside ${yearMin}–${yearMax}`);
  return { ok: true, ms };
}

/**
 * A field that a form may fill from `<input type="date">` OR from an instant.
 * DATE_ONLY resolves to the start of that UTC day (`dayEdge: 'start'`) or to
 * the first instant after it (`dayEdge: 'end'`, for expiries and deadlines).
 * Returns the instant AND which type it was, so storage can keep the
 * precision the person gave.
 */
export function parseDateOrInstant(v, { dayEdge = 'start', yearMin = YEAR_MIN, yearMax = YEAR_MAX } = {}) {
  if (typeof v === 'string' && DATE_ONLY_RE.test(v)) {
    const d = parseStrictDateOnly(v, { yearMin, yearMax });
    if (!d.ok) return d;
    return { ok: true, ms: dayEdge === 'end' ? d.t + DAY_MS : d.t, precision: 'day', value: d.value };
  }
  const i = parseInstant(v, { yearMin, yearMax });
  if (!i.ok) return { ok: false, error: TEMPORAL_ERRORS.DATE_INVALID, why: i.why, expected: 'YYYY-MM-DD, ISO 8601 with offset or Z, or integer milliseconds' };
  return { ok: true, ms: i.ms, precision: 'instant', value: i.ms };
}

// ------------------------------------------------------------------- zones

let supportedZones = null;
function zoneSet() {
  if (supportedZones) return supportedZones;
  let list = [];
  try { list = Intl.supportedValuesOf('timeZone'); } catch { list = []; }
  supportedZones = new Set([...list, 'UTC']);
  return supportedZones;
}

/**
 * Current IANA names that older ICU builds still canonicalise to a legacy
 * alias. The runtime formats them correctly; it only REPORTS the old name
 * (Asia/Kolkata → Asia/Calcutta), which would fail an exact-name check and
 * refuse a real city (P4B defect D-P4B-1). Exact case on both sides.
 */
export const MODERN_ZONE_ALIASES = Object.freeze({
  'Asia/Kolkata': 'Asia/Calcutta', 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Ho_Chi_Minh': 'Asia/Saigon', 'Asia/Kathmandu': 'Asia/Katmandu',
  'Asia/Yangon': 'Asia/Rangoon', 'America/Nuuk': 'America/Godthab', 'Atlantic/Faroe': 'Atlantic/Faeroe', 'Pacific/Chuuk': 'Pacific/Truk',
  'Pacific/Pohnpei': 'Pacific/Ponape', 'Pacific/Kanton': 'Pacific/Enderbury', 'Asia/Dhaka': 'Asia/Dacca', 'Asia/Thimphu': 'Asia/Thimbu',
  'Asia/Macau': 'Asia/Macao', 'Asia/Ulaanbaatar': 'Asia/Ulan_Bator', 'Africa/Asmara': 'Africa/Asmera', 'America/Argentina/Buenos_Aires': 'America/Buenos_Aires',
  'America/Argentina/Catamarca': 'America/Catamarca', 'America/Argentina/Cordoba': 'America/Cordoba', 'America/Argentina/Jujuy': 'America/Jujuy',
  'America/Argentina/Mendoza': 'America/Mendoza', 'America/Indiana/Indianapolis': 'America/Indianapolis', 'America/Kentucky/Louisville': 'America/Louisville',
});

/**
 * An IANA zone this runtime knows, exact case. No folding (`europe/london`
 * is refused), no alias resolution beyond the ICU legacy table above, no
 * fallback to the server's zone. The Trial engine's `validateTimezone` is a
 * thin rename of this.
 */
export function validateIanaZone(tz) {
  const bad = { ok: false, error: TEMPORAL_ERRORS.TIMEZONE_INVALID, message: 'timezone must be an IANA time zone name, for example Europe/London.' };
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return bad;
  const known = zoneSet().has(tz);
  const modern = Object.prototype.hasOwnProperty.call(MODERN_ZONE_ALIASES, tz) ? MODERN_ZONE_ALIASES[tz] : null;
  if (!known && !modern) return bad;
  try {
    const resolved = new Intl.DateTimeFormat('en-GB', { timeZone: tz }).resolvedOptions().timeZone;
    if (resolved !== tz && resolved !== modern) return bad;
  } catch { return bad; }
  return { ok: true, timezone: tz };
}

const partsFormatter = new Map();
function formatterFor(zone) {
  let f = partsFormatter.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatter.set(zone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. Deterministic; Intl-backed; throws for an unknown zone. */
export function localParts(ms, zone) {
  const p = Object.fromEntries(formatterFor(zone).formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === '24' ? '00' : p.hour, minute: p.minute, second: p.second };
}

/** The zone's UTC offset at an instant, in minutes (east positive). */
export function zoneOffsetMinutes(ms, zone) {
  const p = localParts(ms, zone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * LOCAL_DATETIME + IANA_ZONE → UTC_INSTANT, honestly. A wall-clock time in a
 * zone has exactly one instant on an ordinary day, NO instant inside a DST
 * spring-forward gap (02:30 on 8 March 2026 in America/New_York never
 * happens) and TWO instants inside a fall-back overlap (01:30 on 1 November
 * 2026 happens twice). The first is refused as LOCAL_TIME_NONEXISTENT and the
 * second as LOCAL_TIME_AMBIGUOUS unless the caller states `resolve:
 * 'earlier' | 'later'` — nothing picks silently.
 */
export function parseLocalDateTimeWithZone(local, zone, { resolve = null, yearMin = YEAR_MIN, yearMax = YEAR_MAX } = {}) {
  const tz = validateIanaZone(zone);
  if (!tz.ok) return tz;
  const bad = (why) => ({ ok: false, error: TEMPORAL_ERRORS.TIMESTAMP_INVALID, why, expected: 'YYYY-MM-DDTHH:MM[:SS] with an IANA zone' });
  if (typeof local !== 'string') return bad('not text');
  const m = LOCAL_WALL_RE.exec(local);
  if (!m) return bad('wrong shape');
  const day = parseStrictDateOnly(`${m[1]}-${m[2]}-${m[3]}`, { yearMin, yearMax });
  if (!day.ok) return bad('no such calendar day');
  const hh = Number(m[4]); const mm = Number(m[5]); const ss = Number(m[6] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return bad('no such time of day');
  const wallAsUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, ss);
  // Every offset the zone uses within a day either side of the wall time is a
  // candidate; a candidate is real only if it prints back as the same wall time.
  const offsets = new Set([zoneOffsetMinutes(wallAsUtc - DAY_MS, zone), zoneOffsetMinutes(wallAsUtc, zone), zoneOffsetMinutes(wallAsUtc + DAY_MS, zone)]);
  const wanted = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(ss).padStart(2, '0')}`;
  const candidates = [];
  for (const off of offsets) {
    const ms = wallAsUtc - off * 60_000;
    const p = localParts(ms, zone);
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === wanted) candidates.push({ ms, offsetMinutes: off });
  }
  candidates.sort((a, b) => a.ms - b.ms);
  if (candidates.length === 0) return { ok: false, error: TEMPORAL_ERRORS.LOCAL_TIME_NONEXISTENT, why: 'this wall-clock time does not occur in this zone (clocks go forward)', zone };
  if (candidates.length > 1) {
    if (resolve === 'earlier') return { ok: true, ...candidates[0], ambiguous: true };
    if (resolve === 'later') return { ok: true, ...candidates[candidates.length - 1], ambiguous: true };
    return { ok: false, error: TEMPORAL_ERRORS.LOCAL_TIME_AMBIGUOUS, why: 'this wall-clock time occurs twice in this zone (clocks go back)', zone, candidates: candidates.map((c) => c.ms) };
  }
  return { ok: true, ...candidates[0], ambiguous: false };
}

// -------------------------------------------------------------- predicates

/** Both ends readable and start strictly before end (principle E). */
export function isOrderedInterval(startMs, endMs, { allowEqual = false } = {}) {
  const s = readInstant(startMs); const e = readInstant(endMs);
  if (s === null || e === null) return false;
  return allowEqual ? s <= e : s < e;
}

/**
 * Is an expiry PASSED at `now`? `null`/`undefined` means "no expiry" (false);
 * an UNREADABLE expiry is treated as passed (true) — principle C. The
 * boundary is exclusive: expired at exactly `until`.
 */
export function isExpiredAt(until, now) {
  if (until === null || until === undefined) return false;
  const u = readInstant(until);
  if (u === null) return true;
  return now >= u;
}

/**
 * Is a windowed thing in force at `now`? The start must be readable and
 * reached; the end, when present, must be readable and not yet reached.
 * An unreadable start is "not yet started"; an unreadable end is "already
 * ended". Both are the closed answer.
 */
export function isEffectiveAt(from, to, now) {
  const f = readInstant(from);
  if (f === null || f > now) return false;
  if (to === null || to === undefined) return true;
  const t = readInstant(to);
  return t !== null && now < t;
}

/** `isEffectiveAt` for a record shaped `{ startsAt, endsAt }`. */
export const isActiveAt = (rec, now) => !!rec && isEffectiveAt(rec.startsAt, rec.endsAt, now);

/** DATE_ONLY window (inclusive both ends, UTC days): is `dayOnly` inside it? Unreadable bounds close the window. */
export function isDayWithin(dayOnly, from, to) {
  const d = readDateOnly(dayOnly);
  if (d === null) return false;
  if (!isAbsent(from)) { const f = readDateOnly(from); if (f === null || d < f) return false; }
  if (!isAbsent(to)) { const t = readDateOnly(to); if (t === null || d > t) return false; }
  return true;
}

// ------------------------------------------------------------------- age

/**
 * Age in completed UTC years on an instant, or NaN when the birth day cannot
 * be read. THE age rule; `domain.mjs` re-exports it. Turning N happens at
 * 00:00 UTC on the birthday; a 29 February birthday counts on 1 March in a
 * non-leap year.
 */
export function ageOnMs(dob, nowMs) {
  const day = parseStrictDateOnly(dob);
  if (!day.ok || !Number.isFinite(nowMs)) return NaN;
  const on = new Date(nowMs); const b = new Date(day.t);
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

/** A finite age or null — the reader for a JSON projection. */
export const ageOrNull = (dob, nowMs) => { const a = ageOnMs(dob, nowMs); return Number.isFinite(a) ? a : null; };

/** The oldest a living person plausibly is (§24). */
export const DOB_MAX_AGE_YEARS = 120;

/**
 * A date of birth that is a real day, not in the future and not implausibly
 * old. Returns the canonical string or a DOB_INVALID refusal.
 */
export function parseDobStrict(dob, nowMs) {
  const p = parseStrictDateOnly(dob);
  if (!p.ok) return { ok: false, error: TEMPORAL_ERRORS.DOB_INVALID, why: p.why, expected: 'YYYY-MM-DD' };
  if (Number.isFinite(nowMs)) {
    if (p.t > nowMs) return { ok: false, error: TEMPORAL_ERRORS.DOB_INVALID, why: 'in the future', expected: 'YYYY-MM-DD' };
    if (ageOnMs(p.value, nowMs) > DOB_MAX_AGE_YEARS) return { ok: false, error: TEMPORAL_ERRORS.DOB_INVALID, why: 'implausibly old', expected: 'YYYY-MM-DD' };
  }
  return { ok: true, value: p.value, t: p.t };
}
