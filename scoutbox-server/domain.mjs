// Shared domain logic: safeguarding + trust score.
// The player app mirrors this in src/domain/ — keep the two in sync.

// Age of majority per country (ISO alpha-2). Anything not listed: 18.
export const ADULT_AGE = {
  DEFAULT: 18,
  KR: 19,
  TH: 20,
  EG: 21,
  SG: 21,
  NZ: 18,
};

export function adultAgeFor(country) {
  return ADULT_AGE[country] ?? ADULT_AGE.DEFAULT;
}

/**
 * Age in completed years on a given instant.
 *
 * M18.2: computed in UTC throughout. A date of birth is stored as a calendar
 * day ('YYYY-MM-DD'), which `new Date()` parses as UTC midnight; the previous
 * implementation then read it back through LOCAL getters, so in any
 * negative-offset timezone `getDate()` returned the day BEFORE the birthday
 * and every player was a day older or younger than they are around their
 * birthday. The container that runs the suites is UTC, which is why nothing
 * caught it. Birthday semantics: the player turns N at 00:00 UTC on the
 * birthday; a 29 February birthday counts on 1 March in a non-leap year.
 */
export function ageOn(dob, onDate = new Date()) {
  const birth = new Date(dob);
  let age = onDate.getUTCFullYear() - birth.getUTCFullYear();
  const m = onDate.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && onDate.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

export function isAdult(player, onDate = new Date()) {
  return ageOn(player.dob, onDate) >= adultAgeFor(player.country);
}

// ---------------------------------------------------- platform separation
// ScoutBox Grassroots is a separate club platform for federation-registered
// semi-pro clubs and below. Its walls are enforced here, at the same choke
// point as the under-18 rules — never in a frontend.
export const GRASSROOTS_RADIUS_KM = 50;

/** Great-circle distance between two {lat, lng} points, in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A signing sets the player's level from the signing club's level. */
export function playerLevelAfterSigning(orgLevel) {
  return orgLevel === 'grassroots' ? 'semi_pro' : 'pro';
}

// Visibility rules, applied at the source on every endpoint:
// - The under-18 wall: agencies can NEVER see a minor. Not a setting.
// - Verified clubs only: an unverified club cannot see a minor either.
// - Adults are visible to every org type on the main platform.
// - Grassroots clubs additionally see ONLY semi-pro-and-below players within
//   50km of their registered ground. Missing location data fails closed.
export function visibleToOrg(player, org) {
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
const MODERATION_PATTERNS = [
  { flag: 'email', severity: 'contact', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { flag: 'email_obfuscated', severity: 'contact', re: /\b[a-z0-9._%+-]{2,}\s*(\(|\[)?\s*at\s*(\)|\])?\s*[a-z0-9-]{2,}\s*(\(|\[)?\s*dot\s*(\)|\])?\s*[a-z]{2,}\b/i },
  { flag: 'phone_number', severity: 'contact', re: /(\+?\d[\d\s().-]{7,}\d)/ },
  { flag: 'phone_spelled', severity: 'contact', re: /\b(zero|one|two|three|four|five|six|seven|eight|nine)([\s-]+(zero|one|two|three|four|five|six|seven|eight|nine)){6,}\b/i },
  { flag: 'social_handle', severity: 'contact', re: /(^|\s)@[a-z0-9_.]{3,}/i },
  { flag: 'social_platform', severity: 'contact', re: /\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|signal|wickr|kik|viber|dm me|dms)\b/i },
  { flag: 'url', severity: 'contact', re: /\bhttps?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i },
  { flag: 'meet_off_platform', severity: 'contact', re: /\b(meet (me|us) (at|outside)|off the app|off[- ]platform)\b/i },
  // Steering / grooming red flags. False positives are acceptable here —
  // a human reviews everything this catches, nothing is auto-punished.
  { flag: 'secrecy', severity: 'grooming', re: /\b(don'?t tell (your|ur|any)|keep (this|it) (between us|a? ?secret|quiet)|(our|a) little secret|come alone)\b/i },
  { flag: 'personal_probing', severity: 'grooming', re: /\b(what school (do|does)|home alone|are you alone|where do you live|send (me )?(more )?(photos|pictures|pics) of (you|yourself))\b/i },
];

export function moderateText(text) {
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

export function computeTrustScore(player) {
  const t = TRUST;
  let score = t.BASE;
  if (player.identityVerified) score += t.IDENTITY_VERIFIED;
  score += Math.min((player.attendance?.length ?? 0) * t.PER_ATTENDANCE, t.ATTENDANCE_CAP);
  score += Math.min((player.trialReports?.length ?? 0) * t.PER_TRIAL_REPORT, t.TRIAL_REPORT_CAP);
  score += Math.min((player.media?.length ?? 0) * t.PER_MEDIA, t.MEDIA_CAP);
  const complete = player.position && player.foot && player.heightCm && player.weightKg && player.stats;
  if (complete) score += t.PROFILE_COMPLETE;
  return Math.min(score, t.MAX);
}

export function trustBreakdown(player) {
  const t = TRUST;
  return {
    base: t.BASE,
    identityVerified: player.identityVerified ? t.IDENTITY_VERIFIED : 0,
    verifiedAttendance: Math.min((player.attendance?.length ?? 0) * t.PER_ATTENDANCE, t.ATTENDANCE_CAP),
    trialReports: Math.min((player.trialReports?.length ?? 0) * t.PER_TRIAL_REPORT, t.TRIAL_REPORT_CAP),
    media: Math.min((player.media?.length ?? 0) * t.PER_MEDIA, t.MEDIA_CAP),
    profileComplete: (player.position && player.foot && player.heightCm && player.weightKg && player.stats) ? t.PROFILE_COMPLETE : 0,
    total: computeTrustScore(player),
  };
}

// Trial Performance Report — every field is mandatory. Partial reports are rejected.
export const TRIAL_REPORT_FIELDS = [
  'acceleration',      // 0-10
  'sprintSpeedKmh',    // top speed
  'distanceKm',        // total distance covered
  'passCompletionPct', // 0-100
  'duelSuccessPct',    // 0-100
  'coachRating',       // 1-10
];

export function validateTrialReport(report) {
  const missing = TRIAL_REPORT_FIELDS.filter(
    (f) => report?.[f] === undefined || report[f] === null || report[f] === ''
  );
  const invalid = TRIAL_REPORT_FIELDS.filter(
    (f) => report?.[f] !== undefined && report[f] !== null && report[f] !== '' && (typeof report[f] !== 'number' || Number.isNaN(report[f]))
  );
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

// --------------------------------------------------------------- Trial dates
//
// M23 P4A-D1. ONE validator for every date a Trial carries — the proposed
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

const TRIAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @returns {{ok:true, value:string|null, t:number|null} | {ok:false, error:'TRIAL_DATE_INVALID', message:string, expected:string}}
 *   `value` is the canonical string (or null for "no date"); `t` is the UTC
 *   midnight instant of that day (or null).
 */
export function parseTrialDate(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null, t: null };
  const invalid = (why) => ({ ok: false, error: 'TRIAL_DATE_INVALID', message: `A trial date must be a calendar day written ${TRIAL_DATE_SYNTAX} (${why}).`, expected: TRIAL_DATE_SYNTAX });
  if (typeof input !== 'string') return invalid('not text');
  const m = TRIAL_DATE_RE.exec(input);
  if (!m) return invalid('wrong shape');
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < TRIAL_DATE_YEAR_MIN || y > TRIAL_DATE_YEAR_MAX) return invalid(`year outside ${TRIAL_DATE_YEAR_MIN}–${TRIAL_DATE_YEAR_MAX}`);
  if (mo < 1 || mo > 12) return invalid('no such month');
  if (d < 1 || d > 31) return invalid('no such day');
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return invalid('no such day in that month');
  return { ok: true, value: input, t };
}

/** True only for a stored value that is a valid trial date (never for "no date"). */
export const isTrialDate = (v) => { const p = parseTrialDate(v); return p.ok && p.value !== null; };

/**
 * The one report-deadline derivation. `acceptedAt` is the clock the caller
 * already holds for the acceptance — passed in, never read here, so the trial
 * row's `acceptedAt` and its `reportDueAt` come from the same instant.
 * Returns null (never NaN) when neither a valid date nor a finite acceptance
 * instant is available; readers treat null as "no deadline known".
 */
export function trialReportDueAt(trialDate, acceptedAt) {
  const p = parseTrialDate(trialDate);
  const base = p.ok && p.t !== null ? p.t : acceptedAt;
  return Number.isFinite(base) ? base + TRIAL_REPORT_WINDOW_MS : null;
}

/**
 * Validate the logistics a club attaches to a trial request. Returns the
 * canonical `trialDetails` object or the first refusal, in field order. Text
 * is refused over its limit rather than truncated (nothing the club wrote is
 * silently changed), and the venue may not carry line breaks or control
 * characters — it is written into a calendar file verbatim.
 */
export function validateTrialDetails(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bad = (error, field, message) => ({ ok: false, error, field, message });

  const proposed = parseTrialDate(src.proposedDate);
  if (!proposed.ok) return { ...proposed, field: 'proposedDate' };

  const rawSlots = src.altSlots;
  let altSlots = [];
  if (rawSlots !== undefined && rawSlots !== null) {
    if (!Array.isArray(rawSlots)) return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'Alternative slots must be a list of dates.');
    if (rawSlots.length > TRIAL_DETAIL_LIMITS.altSlots) return bad('TRIAL_SLOTS_INVALID', 'altSlots', `Offer at most ${TRIAL_DETAIL_LIMITS.altSlots} alternative slots.`);
    for (const s of rawSlots) {
      const p = parseTrialDate(s);
      if (!p.ok) return { ...p, field: 'altSlots' };
      if (p.value === null) return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'An alternative slot cannot be empty.');
      if (p.value === proposed.value || altSlots.includes(p.value)) return bad('TRIAL_SLOTS_INVALID', 'altSlots', 'Each offered slot must be a different day.');
      altSlots.push(p.value);
    }
  }

  let venue = null;
  if (src.venue !== undefined && src.venue !== null && src.venue !== '') {
    if (typeof src.venue !== 'string') return bad('TRIAL_VENUE_INVALID', 'venue', 'The venue must be text.');
    if (src.venue.length > TRIAL_DETAIL_LIMITS.venue) return bad('TRIAL_VENUE_INVALID', 'venue', `Keep the venue under ${TRIAL_DETAIL_LIMITS.venue} characters.`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(src.venue)) return bad('TRIAL_VENUE_INVALID', 'venue', 'The venue is one line of text.');
    venue = src.venue;
  }

  let notes = '';
  if (src.notes !== undefined && src.notes !== null) {
    if (typeof src.notes !== 'string') return bad('TRIAL_NOTES_INVALID', 'notes', 'Notes must be text.');
    if (src.notes.length > TRIAL_DETAIL_LIMITS.notes) return bad('TRIAL_NOTES_INVALID', 'notes', `Keep the notes under ${TRIAL_DETAIL_LIMITS.notes} characters.`);
    notes = src.notes;
  }

  return { ok: true, details: { proposedDate: proposed.value, altSlots, venue, notes } };
}

/**
 * The slot a family picks when accepting. Absent means "the proposed date";
 * anything else must be exactly one of the days the club offered (P4A-D12:
 * an unknown slot is refused, never silently swapped for the proposal). A
 * stored date that no longer parses (legacy rows written before the
 * validator existed) yields no date rather than a fabricated one.
 */
export function chooseTrialSlot(details, chosenSlot) {
  const d = details && typeof details === 'object' ? details : {};
  const offered = [d.proposedDate, ...(Array.isArray(d.altSlots) ? d.altSlots : [])].filter((s) => typeof s === 'string' && s !== '');
  const refuse = { ok: false, error: 'TRIAL_SLOT_INVALID', message: 'Pick one of the dates the club offered.', offered: offered.filter(isTrialDate) };
  if (chosenSlot === undefined || chosenSlot === null || chosenSlot === '') {
    return { ok: true, date: isTrialDate(d.proposedDate) ? d.proposedDate : null };
  }
  if (typeof chosenSlot !== 'string' || !offered.includes(chosenSlot)) return refuse;
  return { ok: true, date: isTrialDate(chosenSlot) ? chosenSlot : null };
}

// AI Similar Players Engine — statistical similarity to reference playing
// profiles. Position, foot, age, output, physique. A lead, not a verdict.
export function similarityScore(a, b) {
  let score = 0;
  if (a.position === b.position) score += 35;
  else if (samePositionGroup(a.position, b.position)) score += 18;
  if (a.foot === b.foot) score += 10;
  const ageDiff = Math.abs(ageOn(a.dob) - ageOn(b.dob));
  score += Math.max(0, 15 - ageDiff * 3);
  const outA = outputPer90(a), outB = outputPer90(b);
  score += Math.max(0, 25 - Math.abs(outA - outB) * 25);
  const hDiff = Math.abs((a.heightCm ?? 180) - (b.heightCm ?? 180));
  const wDiff = Math.abs((a.weightKg ?? 75) - (b.weightKg ?? 75));
  score += Math.max(0, 15 - (hDiff / 2 + wDiff / 3));
  return Math.round(Math.min(score, 100));
}

const POSITION_GROUPS = [
  ['GK'],
  ['CB', 'RB', 'LB', 'RWB', 'LWB'],
  ['CDM', 'CM', 'CAM'],
  ['RW', 'LW', 'ST', 'CF'],
];

function samePositionGroup(p1, p2) {
  return POSITION_GROUPS.some((g) => g.includes(p1) && g.includes(p2));
}

export function outputPer90(p) {
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

export function trustTier(score) {
  return TRUST_TIERS.find((t) => score >= t.min).name;
}

const DAY_MS = 24 * 3600 * 1000;
const dayKey = (ts) => Math.floor(ts / DAY_MS);

// Streak = consecutive days (ending today or yesterday) with any football
// activity: upload, drill, attendance, stats edit.
export function computeStreak(activityLog, now = Date.now()) {
  const days = new Set((activityLog ?? []).map(dayKey));
  let start = dayKey(now);
  if (!days.has(start)) start -= 1; // yesterday keeps the streak alive
  let streak = 0;
  while (days.has(start - streak)) streak++;
  return streak;
}

export const WEEKLY_GOAL_TARGET = 3; // activities per week

export function weeklyGoal(activityLog, now = Date.now()) {
  const weekStart = now - 7 * DAY_MS;
  const done = (activityLog ?? []).filter((ts) => ts >= weekStart).length;
  return { done: Math.min(done, WEEKLY_GOAL_TARGET * 5), target: WEEKLY_GOAL_TARGET, met: done >= WEEKLY_GOAL_TARGET };
}

// Profile strength: the next best actions, derived from the trust breakdown.
export function nextActions(player) {
  const t = TRUST;
  const actions = [];
  const complete = player.position && player.foot && player.heightCm && player.weightKg && player.stats;
  if (!complete) actions.push({ id: 'complete_profile', label: 'Complete your profile (position, foot, height, weight, stats)', gain: t.PROFILE_COMPLETE });
  if ((player.media?.length ?? 0) === 0) actions.push({ id: 'first_clip', label: 'Upload your first clip', gain: t.PER_MEDIA });
  else if ((player.media?.length ?? 0) * t.PER_MEDIA < t.MEDIA_CAP) actions.push({ id: 'more_clips', label: 'Add another clip', gain: t.PER_MEDIA });
  if ((player.attendance?.length ?? 0) * t.PER_ATTENDANCE < t.ATTENDANCE_CAP) actions.push({ id: 'attendance', label: 'Log a verified match attendance', gain: t.PER_ATTENDANCE });
  if (!player.media?.some((m) => m.verifiedClip)) actions.push({ id: 'verified_clip', label: 'Link a clip to a verified attendance for the Verified Clip seal', gain: 0 });
  return actions.slice(0, 3);
}
