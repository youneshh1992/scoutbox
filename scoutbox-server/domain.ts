// Shared domain logic: safeguarding + trust score.
// The player app mirrors this in src/domain/ — keep the two in sync.

import { parseStrictDateOnly, ageOnMs } from './temporal.ts';

// The records these rules read are typed by the fields each one reads, so any record that has them can be passed.
export type LatLng = { lat: number; lng: number };
/** What the age rules read off a person. */
export type Dated = { dob?: unknown; country?: string | null };
/** What the visibility rule reads off a player and an organisation. */
export type VisiblePlayer = Dated & { level?: string | null; location?: LatLng | null };
export type ViewingOrg = {
  type?: string | null;
  verified?: boolean | null;
  level?: string | null;
  location?: LatLng | null;
};
/** What the profile-completeness figure reads off a player. */
export type ProfileFacts = {
  identityVerified?: unknown;
  attendance?: readonly unknown[] | null;
  trialReports?: readonly unknown[] | null;
  media?: readonly { verifiedClip?: unknown }[] | null;
  position?: unknown;
  foot?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
  stats?: unknown;
};
type PlayingStats = { appearances?: number | null; goals?: number | null; assists?: number | null };
/** What the similarity engine compares. */
export type PlayingProfile = Dated & {
  position?: string | null;
  foot?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  stats?: PlayingStats | null;
};

// Age of majority per country (ISO alpha-2). Anything not listed: 18.
export const ADULT_AGE: { readonly DEFAULT: number; readonly [country: string]: number } = {
  DEFAULT: 18,
  KR: 19,
  TH: 20,
  EG: 21,
  SG: 21,
  NZ: 18,
};

export function adultAgeFor(country: string | null | undefined): number {
  return ADULT_AGE[country ?? ''] ?? ADULT_AGE.DEFAULT;
}

/**
 * Age in completed years on a given instant.
 *
 * Computed in UTC throughout. A date of birth is stored as a calendar day
 * ('YYYY-MM-DD'), which `new Date()` parses as UTC midnight; reading it back
 * through LOCAL getters would put every birthday a day out in a
 * negative-offset timezone. The suites run in UTC, so they would not notice.
 * Birthday semantics: the player turns N at 00:00 UTC on the
 * birthday; a 29 February birthday counts on 1 March in a non-leap year.
 */
/**
 * Age on a date, or NaN when the date of birth cannot be read.
 *
 * `new Date(null)` is not an invalid date — it is the epoch, so a naive reading
 * of `dob: null` (or `0`, or `false`) computes a 56-year-old who passes every
 * adult gate on the platform. Unreadable must fail closed by rule.
 *
 * A missing date of birth is exactly the shape an IMPORTED record has: the
 * prospect import treats dob as optional (domains/integrations/imports.mjs) and projects a
 * missing one as `dob: null`. So "age unknown" is a real state, and the only
 * safe reading of it is NOT "adult".
 *
 * NaN is deliberate rather than a thrown error: every caller either compares it
 * (`>= adultAge`, `< required` — both false for NaN, which is the closed answer)
 * or renders it (JSON null, i.e. "unknown"). A record whose age cannot be
 * established is never treated as an adult.
 */
/**
 * The one reading of a date of birth the platform accepts: a `YYYY-MM-DD`
 * string that names a day which EXISTS. Returns the normalised string, or null.
 *
 * `new Date('2010-02-30')` is not an invalid date in V8 — it rolls over to 2
 * March — so a format check alone would let 30 February, 31 April and 29
 * February in a non-leap year through as birthdays that do not exist. The
 * round-trip (`parse`, then print, then compare) is what catches a day that
 * only exists because the engine was polite about it.
 */
export function parseDob(dob: unknown): string | null {
  // The shape, calendar and year-bound checks live in ONE place
  // (temporal.ts). This is the DOB name for that rule.
  const p = parseStrictDateOnly(dob);
  return p.ok ? p.value : null;
}

export function ageOn(dob: unknown, onDate: Date | number = new Date()): number {
  const nowMs = onDate instanceof Date ? onDate.getTime() : Number(onDate);
  return ageOnMs(dob, nowMs);
}

/** Adult only when the age is KNOWN and reaches the threshold. Unknown is not adult. */
export function isAdult(player: Dated | null | undefined, onDate: Date | number = new Date()): boolean {
  const age = ageOn(player?.dob, onDate);
  return Number.isFinite(age) && age >= adultAgeFor(player?.country);
}

// ---------------------------------------------------- platform separation
// ScoutBox Grassroots is a separate club platform for federation-registered
// semi-pro clubs and below. Its walls are enforced here, at the same choke
// point as the under-18 rules — never in a frontend.
export const GRASSROOTS_RADIUS_KM = 50;

/** Great-circle distance between two {lat, lng} points, in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A signing sets the player's level from the signing club's level. */
export function playerLevelAfterSigning(orgLevel: string | null | undefined): 'semi_pro' | 'pro' {
  return orgLevel === 'grassroots' ? 'semi_pro' : 'pro';
}

// Visibility rules, applied at the source on every endpoint:
// - The under-18 wall: agencies can NEVER see a minor. Not a setting.
// - Verified clubs only: an unverified club cannot see a minor either.
// - Adults are visible to every org type on the main platform.
// - Grassroots clubs additionally see ONLY semi-pro-and-below players within
//   50km of their registered ground. Missing location data fails closed.
export function visibleToOrg(player: VisiblePlayer, org: ViewingOrg): boolean {
  if (!isAdult(player)) {
    if (org.type === 'agency') return false;
    if (!(org.type === 'club' && org.verified === true)) return false;
  }
  if ((org.level ?? null) === 'grassroots') {
    if (player.level === 'pro') return false; // pro players live on ScoutBox, not Grassroots
    if (!org.location || !player.location) return false; // fail closed, never open
    if (haversineKm(org.location, player.location) > GRASSROOTS_RADIUS_KM) return false;
  }
  return true;
}

// -------------------------------------------------------------- moderation
// Prototype AI moderation: children cannot share personal contact details
// through the platform, and club messages to guardians are screened too.
// Production swaps this for a real moderation model behind the same call.
// Severity: 'contact' = trying to move off-platform or share contact details;
// 'grooming' = steering language that must land in front of a human reviewer
// immediately, not just be blocked.
type ModerationSeverity = 'contact' | 'grooming';
const MODERATION_PATTERNS: { flag: string; severity: ModerationSeverity; re: RegExp }[] = [
  { flag: 'email', severity: 'contact', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  {
    flag: 'email_obfuscated',
    severity: 'contact',
    re: /\b[a-z0-9._%+-]{2,}\s*(\(|\[)?\s*at\s*(\)|\])?\s*[a-z0-9-]{2,}\s*(\(|\[)?\s*dot\s*(\)|\])?\s*[a-z]{2,}\b/i,
  },
  { flag: 'phone_number', severity: 'contact', re: /(\+?\d[\d\s().-]{7,}\d)/ },
  {
    flag: 'phone_spelled',
    severity: 'contact',
    re: /\b(zero|one|two|three|four|five|six|seven|eight|nine)([\s-]+(zero|one|two|three|four|five|six|seven|eight|nine)){6,}\b/i,
  },
  { flag: 'social_handle', severity: 'contact', re: /(^|\s)@[a-z0-9_.]{3,}/i },
  {
    flag: 'social_platform',
    severity: 'contact',
    re: /\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|signal|wickr|kik|viber|dm me|dms)\b/i,
  },
  { flag: 'url', severity: 'contact', re: /\bhttps?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i },
  {
    flag: 'meet_off_platform',
    severity: 'contact',
    re: /\b(meet (me|us) (at|outside)|off the app|off[- ]platform)\b/i,
  },
  // Steering / grooming red flags. False positives are acceptable here —
  // a human reviews everything this catches, nothing is auto-punished.
  {
    flag: 'secrecy',
    severity: 'grooming',
    re: /\b(don'?t tell (your|ur|any)|keep (this|it) (between us|a? ?secret|quiet)|(our|a) little secret|come alone)\b/i,
  },
  {
    flag: 'personal_probing',
    severity: 'grooming',
    re: /\b(what school (do|does)|home alone|are you alone|where do you live|send (me )?(more )?(photos|pictures|pics) of (you|yourself))\b/i,
  },
];
/** Every flag a moderation hit can carry, and the two severities (one definition: the moderation log's CHECKs). */
export const MODERATION_FLAGS = Object.freeze(MODERATION_PATTERNS.map((p) => p.flag));
export const MODERATION_SEVERITIES: readonly ModerationSeverity[] = Object.freeze(['contact', 'grooming']);

export function moderateText(text: unknown): { ok: boolean; flags: string[]; severity: ModerationSeverity | null } {
  const hits = MODERATION_PATTERNS.filter((p) => p.re.test(String(text ?? '')));
  return {
    ok: hits.length === 0,
    flags: hits.map((p) => p.flag),
    severity: hits.some((p) => p.severity === 'grooming') ? 'grooming' : hits.length ? 'contact' : null,
  };
}

// Trust Score — 0..99. Institutional corroboration (filed trial reports,
// verified attendance) moves it most; self-reported data moves it least.
// Medical sharing deliberately has NO effect: privacy is never penalised.
export const TRUST = {
  BASE: 30,
  IDENTITY_VERIFIED: 10,
  PER_ATTENDANCE: 5,
  ATTENDANCE_CAP: 20,
  PER_TRIAL_REPORT: 8,
  TRIAL_REPORT_CAP: 24,
  PER_MEDIA: 2,
  MEDIA_CAP: 10,
  PROFILE_COMPLETE: 5,
  MAX: 99,
};

/**
 * The profile-completeness figure ("profileSignal", served as the deprecated `trustScore`) from its five facts. The ONE
 * definition: `computeTrustScore` reads them off a record, and the identity repository off row counts to keep
 * `players.profile_signal`, which the directory sorts by.
 */
export function trustScoreFromFacts({
  identityVerified,
  attendanceCount,
  trialReportCount,
  mediaCount,
  profileComplete,
}: {
  identityVerified: boolean;
  attendanceCount: number;
  trialReportCount: number;
  mediaCount: number;
  profileComplete: boolean;
}): number {
  const t = TRUST;
  let score = t.BASE;
  if (identityVerified) score += t.IDENTITY_VERIFIED;
  score += Math.min(attendanceCount * t.PER_ATTENDANCE, t.ATTENDANCE_CAP);
  score += Math.min(trialReportCount * t.PER_TRIAL_REPORT, t.TRIAL_REPORT_CAP);
  score += Math.min(mediaCount * t.PER_MEDIA, t.MEDIA_CAP);
  if (profileComplete) score += t.PROFILE_COMPLETE;
  return Math.min(score, t.MAX);
}
/** Is the profile complete for the figure: position, foot, height, weight and some statistics. */
export const profileIsComplete = (player: ProfileFacts): boolean =>
  !!(player.position && player.foot && player.heightCm && player.weightKg && player.stats);

export function computeTrustScore(player: ProfileFacts): number {
  return trustScoreFromFacts({
    identityVerified: !!player.identityVerified,
    attendanceCount: player.attendance?.length ?? 0,
    trialReportCount: player.trialReports?.length ?? 0,
    mediaCount: player.media?.length ?? 0,
    profileComplete: profileIsComplete(player),
  });
}

export function trustBreakdown(player: ProfileFacts) {
  const t = TRUST;
  return {
    base: t.BASE,
    identityVerified: player.identityVerified ? t.IDENTITY_VERIFIED : 0,
    verifiedAttendance: Math.min((player.attendance?.length ?? 0) * t.PER_ATTENDANCE, t.ATTENDANCE_CAP),
    trialReports: Math.min((player.trialReports?.length ?? 0) * t.PER_TRIAL_REPORT, t.TRIAL_REPORT_CAP),
    media: Math.min((player.media?.length ?? 0) * t.PER_MEDIA, t.MEDIA_CAP),
    profileComplete: profileIsComplete(player) ? t.PROFILE_COMPLETE : 0,
    total: computeTrustScore(player),
  };
}

// Trial Performance Report — every field is mandatory. Partial reports are rejected.
export const TRIAL_REPORT_FIELDS = [
  'acceleration', // 0-10
  'sprintSpeedKmh', // top speed
  'distanceKm', // total distance covered
  'passCompletionPct', // 0-100
  'duelSuccessPct', // 0-100
  'coachRating', // 1-10
] as const;

export function validateTrialReport(input: unknown): { ok: boolean; missing: string[]; invalid: string[] } {
  const report = input as Record<string, unknown> | null | undefined;
  const missing = TRIAL_REPORT_FIELDS.filter(
    (f) => report?.[f] === undefined || report[f] === null || report[f] === '',
  );
  const invalid = TRIAL_REPORT_FIELDS.filter(
    (f) =>
      report?.[f] !== undefined &&
      report[f] !== null &&
      report[f] !== '' &&
      (typeof report[f] !== 'number' || Number.isNaN(report[f] as number)),
  );
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

// --------------------------------------------------------------- Trial dates
//
// ONE validator for every date a Trial carries — the proposed
// date, the alternative slots, the slot a family picks, a postponement. The
// accepted syntax is a calendar date only, `YYYY-MM-DD`: a trial is booked on
// a day, and the day is what the club, the family and the calendar export all
// agree on. There is no time-of-day, no timezone and no coercion: a value is
// either exactly that syntax and a real calendar day in a sane range, or it is
// refused before anything is written. `''`, `null` and `undefined` all mean
// "no date given" (a trial can be accepted with the date to be confirmed) and
// are the only inputs that are neither a date nor an error.
//
// The report deadline is DERIVED from the trial date here, in one place, from
// one clock: seven days after the trial day (UTC midnight), or seven days
// after acceptance when no day has been agreed. Nothing else computes it.

export const TRIAL_DATE_SYNTAX = 'YYYY-MM-DD';
export const TRIAL_DATE_YEAR_MIN = 2000;
export const TRIAL_DATE_YEAR_MAX = 2100;
export const TRIAL_REPORT_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const TRIAL_DETAIL_LIMITS = Object.freeze({ venue: 200, notes: 500, altSlots: 2 });

export type TrialDate = { ok: true; value: string; t: number } | { ok: true; value: null; t: null };
export type TrialDateRefusal = { ok: false; error: 'TRIAL_DATE_INVALID'; message: string; expected: string };

/**
 * `value` is the canonical string (or null for "no date"); `t` is the UTC midnight instant of that day (or null).
 */
export function parseTrialDate(input: unknown): TrialDate | TrialDateRefusal {
  if (input === undefined || input === null || input === '') return { ok: true, value: null, t: null };
  const invalid = (why: string) => ({
    ok: false as const,
    error: 'TRIAL_DATE_INVALID' as const,
    message: `A trial date must be a calendar day written ${TRIAL_DATE_SYNTAX} (${why}).`,
    expected: TRIAL_DATE_SYNTAX,
  });
  // One DATE_ONLY parser for the platform (temporal.ts); this keeps the Trial
  // vocabulary (its error code and its 2000–2100 bound) at the edge.
  const p = parseStrictDateOnly(input, { yearMin: TRIAL_DATE_YEAR_MIN, yearMax: TRIAL_DATE_YEAR_MAX });
  if (!p.ok) return invalid(p.why);
  return { ok: true, value: p.value, t: p.t };
}

/** True only for a stored value that is a valid trial date (never for "no date"). */
export const isTrialDate = (v: unknown): boolean => {
  const p = parseTrialDate(v);
  return p.ok && p.value !== null;
};

/**
 * The one report-deadline derivation. `acceptedAt` is the clock the caller
 * already holds for the acceptance — passed in, never read here, so the trial
 * row's `acceptedAt` and its `reportDueAt` come from the same instant.
 * Returns null (never NaN) when neither a valid date nor a finite acceptance
 * instant is available; readers treat null as "no deadline known".
 */
export function trialReportDueAt(trialDate: unknown, acceptedAt: number | null | undefined): number | null {
  const p = parseTrialDate(trialDate);
  const base = p.ok && p.t !== null ? p.t : acceptedAt;
  return typeof base === 'number' && Number.isFinite(base) ? base + TRIAL_REPORT_WINDOW_MS : null;
}

/**
 * Validate the logistics a club attaches to a trial request. Returns the
 * canonical `trialDetails` object or the first refusal, in field order. Text
 * is refused over its limit rather than truncated (nothing the club wrote is
 * silently changed), and the venue may not carry line breaks or control
 * characters — it is written into a calendar file verbatim.
 */
export type TrialDetails = { proposedDate: string | null; altSlots: string[]; venue: string | null; notes: string };
export type TrialDetailsRefusal =
  | (TrialDateRefusal & { field: 'proposedDate' | 'altSlots' })
  | { ok: false; error: string; field: string; message: string };

export function validateTrialDetails(input: unknown): { ok: true; details: TrialDetails } | TrialDetailsRefusal {
  const src = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const bad = (error: string, field: string, message: string) => ({ ok: false as const, error, field, message });

  const proposed = parseTrialDate(src.proposedDate);
  if (!proposed.ok) return { ...proposed, field: 'proposedDate' as const };

  const rawSlots = src.altSlots;
  const altSlots: string[] = [];
  if (rawSlots !== undefined && rawSlots !== null) {
    if (!Array.isArray(rawSlots))
      return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'Alternative slots must be a list of dates.');
    if (rawSlots.length > TRIAL_DETAIL_LIMITS.altSlots)
      return bad('TRIAL_SLOTS_INVALID', 'altSlots', `Offer at most ${TRIAL_DETAIL_LIMITS.altSlots} alternative slots.`);
    for (const s of rawSlots) {
      const p = parseTrialDate(s);
      if (!p.ok) return { ...p, field: 'altSlots' as const };
      if (p.value === null) return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'An alternative slot cannot be empty.');
      if (p.value === proposed.value || altSlots.includes(p.value))
        return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'Each offered slot must be a different day.');
      altSlots.push(p.value);
    }
  }

  let venue: string | null = null;
  if (src.venue !== undefined && src.venue !== null && src.venue !== '') {
    if (typeof src.venue !== 'string') return bad('TRIAL_VENUE_INVALID', 'venue', 'The venue must be text.');
    if (src.venue.length > TRIAL_DETAIL_LIMITS.venue)
      return bad('TRIAL_VENUE_INVALID', 'venue', `Keep the venue under ${TRIAL_DETAIL_LIMITS.venue} characters.`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(src.venue))
      return bad('TRIAL_VENUE_INVALID', 'venue', 'The venue is one line of text.');
    venue = src.venue;
  }

  let notes = '';
  if (src.notes !== undefined && src.notes !== null) {
    if (typeof src.notes !== 'string') return bad('TRIAL_NOTES_INVALID', 'notes', 'Notes must be text.');
    if (src.notes.length > TRIAL_DETAIL_LIMITS.notes)
      return bad('TRIAL_NOTES_INVALID', 'notes', `Keep the notes under ${TRIAL_DETAIL_LIMITS.notes} characters.`);
    notes = src.notes;
  }

  return { ok: true, details: { proposedDate: proposed.value, altSlots, venue, notes } };
}

/**
 * The slot a family picks when accepting. Absent means "the proposed date";
 * anything else must be exactly one of the days the club offered (an unknown
 * slot is refused, never silently swapped for the proposal). A stored date
 * that does not parse yields no date rather than a fabricated one.
 */
export function chooseTrialSlot(
  details: unknown,
  chosenSlot: unknown,
): { ok: true; date: string | null } | { ok: false; error: 'TRIAL_SLOT_INVALID'; message: string; offered: string[] } {
  const d: { proposedDate?: unknown; altSlots?: unknown } = details && typeof details === 'object' ? details : {};
  const offered = [d.proposedDate, ...(Array.isArray(d.altSlots) ? d.altSlots : [])].filter(
    (s): s is string => typeof s === 'string' && s !== '',
  );
  const refuse = {
    ok: false as const,
    error: 'TRIAL_SLOT_INVALID' as const,
    message: 'Pick one of the dates the club offered.',
    offered: offered.filter(isTrialDate),
  };
  if (chosenSlot === undefined || chosenSlot === null || chosenSlot === '') {
    return { ok: true, date: isTrialDate(d.proposedDate) ? (d.proposedDate as string) : null };
  }
  if (typeof chosenSlot !== 'string' || !offered.includes(chosenSlot)) return refuse;
  return { ok: true, date: isTrialDate(chosenSlot) ? chosenSlot : null };
}

// AI Similar Players Engine — statistical similarity to reference playing
// profiles. Position, foot, age, output, physique. A lead, not a verdict.

/**
 * The similarity score's numbers (similarityScore, and the SQL players.mostSimilar ranks by): the most each part
 * earns, what costs a point of it, and the build assumed when one is missing.
 */
export const SIMILARITY = Object.freeze({
  position: 35,
  positionGroup: 18,
  foot: 10,
  age: 15,
  perYearApart: 3,
  output: 25,
  perOutputApart: 25,
  build: 15,
  cmPerPoint: 2,
  kgPerPoint: 3,
  defaultHeightCm: 180,
  defaultWeightKg: 75,
});

/**
 * The most a candidate outside the base's position group can score: everything but the position part. A ranking
 * whose top `k` from the group all beat it needs no other candidate.
 */
export const SIMILARITY_WITHOUT_POSITION = SIMILARITY.foot + SIMILARITY.age + SIMILARITY.output + SIMILARITY.build;

export function similarityScore(a: PlayingProfile, b: PlayingProfile, onDate: Date | number = new Date()): number {
  const S = SIMILARITY;
  let score = 0;
  if (a.position === b.position) score += S.position;
  else if (samePositionGroup(a.position, b.position)) score += S.positionGroup;
  if (a.foot === b.foot) score += S.foot;
  const ageDiff = Math.abs(ageOn(a.dob, onDate) - ageOn(b.dob, onDate));
  score += Math.max(0, S.age - ageDiff * S.perYearApart);
  const outA = outputPer90(a),
    outB = outputPer90(b);
  score += Math.max(0, S.output - Math.abs(outA - outB) * S.perOutputApart);
  const hDiff = Math.abs((a.heightCm ?? S.defaultHeightCm) - (b.heightCm ?? S.defaultHeightCm));
  const wDiff = Math.abs((a.weightKg ?? S.defaultWeightKg) - (b.weightKg ?? S.defaultWeightKg));
  score += Math.max(0, S.build - (hDiff / S.cmPerPoint + wDiff / S.kgPerPoint));
  return Math.round(Math.min(score, 100));
}

export const POSITION_GROUPS: readonly (readonly string[])[] = [
  ['GK'],
  ['CB', 'RB', 'LB', 'RWB', 'LWB'],
  ['CDM', 'CM', 'CAM'],
  ['RW', 'LW', 'ST', 'CF'],
];

function samePositionGroup(p1: string | null | undefined, p2: string | null | undefined): boolean {
  return POSITION_GROUPS.some((g) => g.includes(p1 ?? '') && g.includes(p2 ?? ''));
}

export function outputPer90(p: { stats?: PlayingStats | null }): number {
  const apps = p.stats?.appearances || 1;
  return ((p.stats?.goals ?? 0) + (p.stats?.assists ?? 0)) / apps;
}

// ------------------------------------------------------------ habit loops
// Streaks compare a player to THEMSELVES — deliberately no leaderboards and
// no comparisons to other players (kid-safe gamification).

export const TRUST_TIERS = [
  { min: 80, name: 'Elite' },
  { min: 60, name: 'Established' },
  { min: 40, name: 'Rising' },
  { min: 0, name: 'Prospect' },
];

export function trustTier(score: number): string {
  // Unmatched only for a negative or NaN score, which the figure never is; it throws, as it always has.
  return TRUST_TIERS.find((t) => score >= t.min)!.name;
}

const DAY_MS = 24 * 3600 * 1000;
const dayKey = (ts: number) => Math.floor(ts / DAY_MS);

// Streak = consecutive days (ending today or yesterday) with any football
// activity: upload, drill, attendance, stats edit.
export function computeStreak(activityLog: readonly number[] | null | undefined, now = Date.now()): number {
  const days = new Set((activityLog ?? []).map(dayKey));
  let start = dayKey(now);
  if (!days.has(start)) start -= 1; // yesterday keeps the streak alive
  let streak = 0;
  while (days.has(start - streak)) streak++;
  return streak;
}

export const WEEKLY_GOAL_TARGET = 3; // activities per week

export function weeklyGoal(activityLog: readonly number[] | null | undefined, now = Date.now()) {
  const weekStart = now - 7 * DAY_MS;
  const done = (activityLog ?? []).filter((ts) => ts >= weekStart).length;
  return { done: Math.min(done, WEEKLY_GOAL_TARGET * 5), target: WEEKLY_GOAL_TARGET, met: done >= WEEKLY_GOAL_TARGET };
}

// Profile strength: the next best actions, derived from the trust breakdown.
export function nextActions(player: ProfileFacts): { id: string; label: string; gain: number }[] {
  const t = TRUST;
  const actions: { id: string; label: string; gain: number }[] = [];
  const complete = player.position && player.foot && player.heightCm && player.weightKg && player.stats;
  if (!complete)
    actions.push({
      id: 'complete_profile',
      label: 'Complete your profile (position, foot, height, weight, stats)',
      gain: t.PROFILE_COMPLETE,
    });
  if ((player.media?.length ?? 0) === 0)
    actions.push({ id: 'first_clip', label: 'Upload your first clip', gain: t.PER_MEDIA });
  else if ((player.media?.length ?? 0) * t.PER_MEDIA < t.MEDIA_CAP)
    actions.push({ id: 'more_clips', label: 'Add another clip', gain: t.PER_MEDIA });
  if ((player.attendance?.length ?? 0) * t.PER_ATTENDANCE < t.ATTENDANCE_CAP)
    actions.push({ id: 'attendance', label: 'Log a verified match attendance', gain: t.PER_ATTENDANCE });
  if (!player.media?.some((m) => m.verifiedClip))
    actions.push({
      id: 'verified_clip',
      label: 'Link a clip to a verified attendance for the Verified Clip seal',
      gain: 0,
    });
  return actions.slice(0, 3);
}
