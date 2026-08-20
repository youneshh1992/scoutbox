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

export function ageOn(dob, onDate = new Date()) {
  const birth = new Date(dob);
  let age = onDate.getFullYear() - birth.getFullYear();
  const m = onDate.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && onDate.getDate() < birth.getDate())) age--;
  return age;
}

export function isAdult(player, onDate = new Date()) {
  return ageOn(player.dob, onDate) >= adultAgeFor(player.country);
}

// Minor visibility rules, applied at the source on every endpoint:
// - The under-18 wall: agencies can NEVER see a minor. Not a setting.
// - Verified clubs only: an unverified club cannot see a minor either.
// - Adults are visible to every org type.
export function visibleToOrg(player, org) {
  if (isAdult(player)) return true;
  if (org.type === 'agency') return false;
  return org.type === 'club' && org.verified === true;
}

// -------------------------------------------------------------- moderation
// Prototype AI moderation: children cannot share personal contact details
// through the platform, and club messages to guardians are screened too.
// Production swaps this for a real moderation model behind the same call.
const MODERATION_PATTERNS = [
  { flag: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { flag: 'phone_number', re: /(\+?\d[\d\s().-]{7,}\d)/ },
  { flag: 'social_handle', re: /(^|\s)@[a-z0-9_.]{3,}/i },
  { flag: 'social_platform', re: /\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|dm me|dms)\b/i },
  { flag: 'url', re: /\bhttps?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i },
  { flag: 'meet_off_platform', re: /\b(meet (me|us) (at|outside)|come alone|don'?t tell)\b/i },
];

export function moderateText(text) {
  const flags = MODERATION_PATTERNS.filter((p) => p.re.test(String(text ?? ''))).map((p) => p.flag);
  return { ok: flags.length === 0, flags };
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
