// The strongest claim Box Cam may make: "ScoutBox Box Cam observed activity consistent with this supported drill
// for X active minutes/repetitions during a live capture session." It observes, it doesn't rate a player, and
// elapsed clock time is not active-training time.
import crypto from 'node:crypto';

// --------------------------------------------------------------- states
export const SESSION_STATES = [
  'not_started',
  'setup_required',
  'ready',
  'recording',
  'processing',
  'verified',
  'partially_verified',
  'unable_to_verify',
  'completed_unverified',
  'cancelled',
  'invalidated',
];
export const TERMINAL_STATES = new Set([
  'verified',
  'partially_verified',
  'unable_to_verify',
  'completed_unverified',
  'cancelled',
  'invalidated',
]);
export const QUALITY = ['good', 'degraded', 'insufficient'];
export const TARGET_TYPES = ['duration', 'repetitions', 'sets', 'combined'];
export const OBSERVATION_KINDS = Object.freeze([
  'active',
  'presence',
  'ball',
  'rep',
  'set',
  'pause',
  'interruption',
  'multi_person',
]);

const isMs = (v) => typeof v === 'number' && Number.isFinite(v);
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v;
/** Types one observation from the events route; an event the engine cannot read is refused, naming the field. */
export function typeObservation(raw, at) {
  const bad = (field, what) => ({ ok: false, reason: `${at}.${field} ${what}` });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter(
    (k) => !['kind', 'fromMs', 'toMs', 'atMs', 'quality', 'confidence'].includes(k),
  );
  if (unknown.length)
    return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const { kind, fromMs = null, toMs = null, atMs = null, quality = null, confidence = null } = raw;
  if (!OBSERVATION_KINDS.includes(kind)) return bad('kind', `must be one of ${OBSERVATION_KINDS.join('|')}`);
  const interval = ['active', 'presence', 'ball', 'interruption', 'multi_person'].includes(kind);
  for (const [k, v] of [
    ['fromMs', fromMs],
    ['toMs', toMs],
    ['atMs', atMs],
  ])
    if (v !== null && !isMs(v)) return bad(k, `must be a number (got ${describe(v)})`);
  if (interval && (fromMs === null || toMs === null || atMs !== null))
    return bad('fromMs', 'and toMs are required on an interval (and atMs is not)');
  if ((kind === 'rep' || kind === 'set') && (atMs === null || fromMs !== null || toMs !== null))
    return bad('atMs', 'is required on a point observation (and fromMs/toMs are not)');
  if (kind === 'pause' && (fromMs === null || atMs !== null)) return bad('fromMs', 'is required on a pause');
  if (quality !== null && (!['active', 'presence'].includes(kind) || !QUALITY.includes(quality)))
    return bad('quality', `must be one of ${QUALITY.join('|')} on an active or presence interval`);
  if (confidence !== null && (kind !== 'rep' || !isMs(confidence) || confidence < 0 || confidence > 1))
    return bad('confidence', 'must be a number from 0 to 1 on a rep');
  return { ok: true, record: { kind, fromMs, toMs, atMs, quality, confidence } };
}

// Player copy per state: never "you didn't train" or "failed".
export const STATE_COPY = {
  verified: 'Box Cam observed activity consistent with this drill for the recorded duration.',
  partially_verified:
    'Box Cam verified part of this session. Some activity could not be reliably observed because the player or ball left the camera view.',
  unable_to_verify:
    'ScoutBox could not reliably verify this session. Your training is not being marked as Box Cam Verified.',
  completed_unverified:
    'This session was recorded without Box Cam verification requirements being met, so it is not Box Cam Verified.',
  cancelled: 'This Box Session was cancelled before completion.',
  invalidated: 'This Box Cam result was invalidated after review and no longer counts as Box Cam Verified evidence.',
};

// ------------------------------------------------------------- intervals
/** Normalise raw {fromMs,toMs} pairs: ordered and clamped to [0, maxMs]; invalid or empty spans are dropped. */
export function normIntervals(list, maxMs) {
  const out = [];
  for (const iv of list ?? []) {
    let from = Number(iv.fromMs);
    let to = Number(iv.toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (to < from) [from, to] = [to, from];
    from = Math.max(0, from);
    to = Math.min(Number.isFinite(maxMs) ? maxMs : to, to);
    if (to - from <= 0) continue;
    out.push({ fromMs: from, toMs: to, quality: QUALITY.includes(iv.quality) ? iv.quality : 'good' });
  }
  return out.sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
}

/** Quality-agnostic union: double-reported time doesn't double. */
export function mergeIntervals(list) {
  const sorted = [...(list ?? [])].sort((a, b) => a.fromMs - b.fromMs);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, iv.toMs);
    else out.push({ fromMs: iv.fromMs, toMs: iv.toMs });
  }
  return out;
}

export function subtractIntervals(base, cuts) {
  let current = mergeIntervals(base);
  for (const cut of mergeIntervals(cuts)) {
    const next = [];
    for (const iv of current) {
      if (cut.toMs <= iv.fromMs || cut.fromMs >= iv.toMs) {
        next.push(iv);
        continue;
      }
      if (cut.fromMs > iv.fromMs) next.push({ fromMs: iv.fromMs, toMs: cut.fromMs });
      if (cut.toMs < iv.toMs) next.push({ fromMs: cut.toMs, toMs: iv.toMs });
    }
    current = next;
  }
  return current;
}

export const sumIntervals = (list) => (list ?? []).reduce((s, iv) => s + (iv.toMs - iv.fromMs), 0);

export function intersectIntervals(a, b) {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out = [];
  for (const x of A) {
    for (const y of B) {
      const from = Math.max(x.fromMs, y.fromMs);
      const to = Math.min(x.toMs, y.toMs);
      if (to > from) out.push({ fromMs: from, toMs: to });
    }
  }
  return mergeIntervals(out);
}

/** Active intervals of acceptable quality, minus pauses and interruptions, clamped to the server-known session
 *  duration. */
export function verifiedActiveMs({
  activeIntervals = [],
  pauses = [],
  interruptions = [],
  sessionDurationMs = 0,
  requiredIntervals = null,
}) {
  let usable = normIntervals(activeIntervals, sessionDurationMs).filter((iv) => iv.quality !== 'insufficient');
  // Ball-required drills: activity only counts while the ball was also visible.
  if (requiredIntervals) usable = intersectIntervals(usable, normIntervals(requiredIntervals, sessionDurationMs));
  const cuts = [...normIntervals(pauses, sessionDurationMs), ...normIntervals(interruptions, sessionDurationMs)];
  return sumIntervals(subtractIntervals(usable, cuts));
}

// ------------------------------------------------------------------ reps
/** Confidence-gated, windowed reps with physically impossible rapid duplicates (under the drill's min gap)
 *  collapsed. */
export function dedupeReps(reps, { sessionDurationMs = Infinity, minGapMs = 250, minConfidence = 0.5 } = {}) {
  const valid = (reps ?? [])
    .map((r) => ({ atMs: Number(r.atMs), confidence: r.confidence == null ? 1 : Number(r.confidence) }))
    .filter(
      (r) => Number.isFinite(r.atMs) && r.atMs >= 0 && r.atMs <= sessionDurationMs && r.confidence >= minConfidence,
    )
    .sort((a, b) => a.atMs - b.atMs);
  const out = [];
  for (const r of valid) {
    if (out.length && r.atMs - out[out.length - 1].atMs < minGapMs) continue;
    out.push(r);
  }
  return out;
}

// ----------------------------------------------------------- completion
/** Strictly from verified values: near misses aren't rounded up. Null when the drill/provider cannot verify the
 *  target's metric. */
export function targetCompleted(target, { activeMs = 0, reps = null, setsCompleted = 0 }, capabilities = []) {
  switch (target?.type) {
    case 'duration':
      return activeMs >= target.value;
    case 'repetitions':
      if (!capabilities.includes('rep_count') || reps == null) return null;
      return reps >= target.value;
    case 'sets':
      if (!capabilities.includes('interval_completion')) return null;
      return setsCompleted >= target.value;
    case 'combined':
      if (!capabilities.includes('rep_count') || !capabilities.includes('interval_completion') || reps == null)
        return null;
      return setsCompleted >= (target.sets ?? 0) && reps >= (target.sets ?? 0) * (target.repsPerSet ?? 0);
    default:
      return null;
  }
}

// -------------------------------------------------------------- quality
export function detectionQuality({ observedMs = 0, sessionDurationMs = 0 }) {
  if (sessionDurationMs <= 0) return 'insufficient';
  const ratio = observedMs / sessionDurationMs;
  if (ratio >= 0.75) return 'good';
  if (ratio >= 0.2) return 'degraded';
  return 'insufficient';
}

// -------------------------------------------------- verification state
/** Partial observed work stays under partially_verified; only no reliable observation at all is unable_to_verify. */
export function deriveVerification({
  cancelled = false,
  livenessPassed = false,
  providerAvailable = true,
  activeMs = 0,
  sessionDurationMs = 0,
  completed,
  quality,
  interruptionsCount = 0,
  unsupportedTargetMetric = false,
}) {
  const reasons = [];
  if (cancelled) return { state: 'cancelled', reasons: ['SESSION_CANCELLED'] };
  if (!providerAvailable) reasons.push('PROVIDER_UNAVAILABLE');
  if (!livenessPassed) reasons.push('LIVENESS_NOT_ESTABLISHED');
  if (!livenessPassed || !providerAvailable) return { state: 'completed_unverified', reasons };
  if (quality === 'insufficient' || activeMs <= 0) {
    reasons.push(activeMs <= 0 ? 'NO_ACTIVITY_OBSERVED' : 'OBSERVATION_INSUFFICIENT');
    return { state: 'unable_to_verify', reasons };
  }
  if (unsupportedTargetMetric) reasons.push('TARGET_METRIC_NOT_SUPPORTED');
  if (interruptionsCount > 0) reasons.push('OBSERVATION_GAPS');
  if (quality === 'degraded') reasons.push('OBSERVATION_QUALITY_DEGRADED');
  if (completed === true && quality === 'good' && !unsupportedTargetMetric) {
    return { state: 'verified', reasons };
  }
  if (completed !== true) reasons.push('TARGET_NOT_YET_COMPLETED');
  return { state: 'partially_verified', reasons };
}

// -------------------------------------------------------------- streak
/** Consecutive weeks with verified activity, counting back from now. Rest days don't matter; only a whole week
 *  without a session ends a streak. */
export function boxStreakWeeks(sessions, now = Date.now()) {
  const WEEK = 7 * 86_400_000;
  const weekIndex = (t) => Math.floor(t / WEEK);
  const weeks = new Set(
    (sessions ?? [])
      .filter((s) => ['verified', 'partially_verified'].includes(s.verificationState) && s.verifiedActiveMs > 0)
      .map((s) => weekIndex(s.endedAt ?? s.startedAt)),
  );
  let streak = 0;
  let w = weekIndex(now);
  // The current week is still in progress, so an empty one doesn't break the streak.
  if (weeks.has(w)) streak++;
  w--;
  while (weeks.has(w)) {
    streak++;
    w--;
  }
  return streak;
}

// ------------------------------------------------------------ Box Best
/** Per drill@version: different detector versions are different measurements. */
export function boxBests(sessions) {
  const bests = new Map();
  for (const s of sessions ?? []) {
    if (!['verified', 'partially_verified'].includes(s.verificationState)) continue;
    const key = `${s.drillId}@${s.drillVersion}`;
    const b = bests.get(key) ?? { drillId: s.drillId, drillVersion: s.drillVersion, bestActiveMs: 0, bestReps: null };
    if (s.verifiedActiveMs > b.bestActiveMs) b.bestActiveMs = s.verifiedActiveMs;
    if (s.verifiedReps != null && (b.bestReps == null || s.verifiedReps > b.bestReps)) b.bestReps = s.verifiedReps;
    bests.set(key, b);
  }
  return [...bests.values()];
}

// ---------------------------------------------------- challenge progress
export function challengeProgress(challenge, sessions) {
  const seen = new Set();
  let total = 0;
  for (const s of sessions ?? []) {
    if (seen.has(s.id)) continue;
    if (s.drillId !== challenge.drillId) continue;
    if (!['verified', 'partially_verified'].includes(s.verificationState)) continue;
    const at = s.endedAt ?? s.startedAt;
    if (challenge.startsAt && at < challenge.startsAt) continue;
    if (challenge.endsAt && at > challenge.endsAt) continue;
    seen.add(s.id);
    total += challenge.metric === 'reps' ? (s.verifiedReps ?? 0) : Math.floor(s.verifiedActiveMs / 60_000);
  }
  return { total, completed: total >= challenge.targetTotal, sessionIds: [...seen] };
}

// ------------------------------------------- development activity summary
export const DEV_ACTIVITY_NOTE = 'This is evidence of recorded training activity. It is not proof of player ability.';
export function developmentActivity({
  sessions = [],
  assignments = [],
  drillsById = new Map(),
  days = 30,
  now = Date.now(),
}) {
  const since = now - days * 86_400_000;
  const recent = sessions.filter(
    (s) =>
      TERMINAL_STATES.has(s.verificationState) &&
      !['cancelled', 'invalidated'].includes(s.verificationState) &&
      (s.endedAt ?? s.startedAt) >= since,
  );
  const verified = recent.filter((s) => ['verified', 'partially_verified'].includes(s.verificationState));
  const byCategory = new Map();
  for (const s of verified) {
    const cat = drillsById.get(s.drillId)?.category ?? 'training';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + s.verifiedActiveMs);
  }
  const assignedRecent = assignments.filter(
    (a) => a.createdAt >= since && a.state !== 'cancelled' && a.state !== 'superseded',
  );
  return {
    days,
    boxSessions: recent.length,
    verifiedActiveMs: verified.reduce((t, s) => t + s.verifiedActiveMs, 0),
    assigned: assignedRecent.length,
    assignedCompleted: assignedRecent.filter((a) => a.state === 'completed').length,
    focus: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, ms]) => ({ category, activeMs: ms })),
    note: DEV_ACTIVITY_NOTE,
  };
}

// ----------------------------------------------------- result integrity
/** Integrity metadata for a finalized session. */
export function resultHash(session) {
  const canonical = JSON.stringify({
    id: session.id,
    playerId: session.playerId,
    drillId: session.drillId,
    drillVersion: session.drillVersion,
    target: session.target,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    sessionDurationMs: session.sessionDurationMs,
    verifiedActiveMs: session.verifiedActiveMs,
    verifiedReps: session.verifiedReps ?? null,
    setsCompleted: session.setsCompleted ?? 0,
    verificationState: session.verificationState,
    provider: session.provider,
    providerVersion: session.providerVersion,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function boxCamDetail(session) {
  const base = 'Recorded live through ScoutBox Box Cam.';
  if (session.verifiedReps != null) {
    return `${base} ScoutBox observed ${session.verifiedReps} repetitions consistent with the selected supported drill across ${fmtMs(session.verifiedActiveMs)} of active capture.`;
  }
  return `${base} ScoutBox observed activity consistent with the selected supported drill for ${fmtMs(session.verifiedActiveMs)}.`;
}

// ------------------------------------------------------------------- paging
/** Pages a list the route has already filtered by visibility. Returns null once it has answered a page error. */
export function pageNewestFirst(req, res, list, { readPage, pageOf, sendPageError }) {
  let page;
  try {
    page = readPage(req.query, ['number', 'string']);
  } catch (e) {
    sendPageError(res, e);
    return null;
  }
  const key = (r) => [r.createdAt, r.id];
  const after = page.after;
  const rest = after
    ? list.filter((r) => r.createdAt < after[0] || (r.createdAt === after[0] && r.id < after[1]))
    : list;
  return pageOf(rest.slice(0, page.limit + 1), page.limit, key);
}
