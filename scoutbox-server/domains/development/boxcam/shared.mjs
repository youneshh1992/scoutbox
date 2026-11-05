// M16 shared — Box Cam pure engine.
//
// Box Cam is ScoutBox's first-party observed training evidence system. The
// strongest statement it is ever allowed to make is: "ScoutBox Box Cam
// observed activity consistent with this supported drill for X active
// minutes/repetitions during a live capture session." Observation and
// evaluation are different concepts — nothing in this module rates a
// player, and elapsed clock time is NEVER active-training time.
//
// Everything here is a pure function over plain data so the engine is
// unit-testable to the millisecond without a server.
import crypto from 'node:crypto';

// --------------------------------------------------------------- states
export const SESSION_STATES = [
  'not_started', 'setup_required', 'ready', 'recording', 'processing',
  'verified', 'partially_verified', 'unable_to_verify',
  'completed_unverified', 'cancelled', 'invalidated',
];
export const TERMINAL_STATES = new Set(['verified', 'partially_verified', 'unable_to_verify', 'completed_unverified', 'cancelled', 'invalidated']);
export const QUALITY = ['good', 'degraded', 'insufficient'];
export const TARGET_TYPES = ['duration', 'repetitions', 'sets', 'combined'];

// Honest per-state player copy — never "you didn't train", never "failed".
export const STATE_COPY = {
  verified: 'Box Cam observed activity consistent with this drill for the recorded duration.',
  partially_verified: 'Box Cam verified part of this session. Some activity could not be reliably observed because the player or ball left the camera view.',
  unable_to_verify: 'ScoutBox could not reliably verify this session. Your training is not being marked as Box Cam Verified.',
  completed_unverified: 'This session was recorded without Box Cam verification requirements being met, so it is not Box Cam Verified.',
  cancelled: 'This Box Session was cancelled before completion.',
  invalidated: 'This Box Cam result was invalidated after review and no longer counts as Box Cam Verified evidence.',
};

// ------------------------------------------------------------- intervals
/** Normalise raw {fromMs,toMs} pairs: numeric, ordered, clamped to
 *  [0, maxMs]; invalid or empty spans vanish. Nothing outside the session
 *  window can ever count. */
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

/** Merge overlapping/adjacent intervals (quality-agnostic union). Duplicate
 *  and nested intervals collapse — double-reporting never doubles time. */
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

/** Subtract cut intervals (pauses, interruptions, multi-person periods)
 *  from base intervals. */
export function subtractIntervals(base, cuts) {
  let current = mergeIntervals(base);
  for (const cut of mergeIntervals(cuts)) {
    const next = [];
    for (const iv of current) {
      if (cut.toMs <= iv.fromMs || cut.fromMs >= iv.toMs) { next.push(iv); continue; }
      if (cut.fromMs > iv.fromMs) next.push({ fromMs: iv.fromMs, toMs: cut.fromMs });
      if (cut.toMs < iv.toMs) next.push({ fromMs: cut.toMs, toMs: iv.toMs });
    }
    current = next;
  }
  return current;
}

export const sumIntervals = (list) => (list ?? []).reduce((s, iv) => s + (iv.toMs - iv.fromMs), 0);

/** Intersection of two interval sets (e.g. active ∩ ball-visible for
 *  ball-required drills). */
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

/** Verified active-training time: the union of active observation intervals
 *  of acceptable quality, minus paused/interrupted/unreliable periods, all
 *  clamped to the SERVER-known session duration. Elapsed time is never a
 *  substitute. */
export function verifiedActiveMs({ activeIntervals = [], pauses = [], interruptions = [], sessionDurationMs = 0, requiredIntervals = null }) {
  let usable = normIntervals(activeIntervals, sessionDurationMs).filter((iv) => iv.quality !== 'insufficient');
  // Ball-required drills: activity only counts while the required
  // observation (e.g. the ball) was also visible.
  if (requiredIntervals) usable = intersectIntervals(usable, normIntervals(requiredIntervals, sessionDurationMs));
  const cuts = [...normIntervals(pauses, sessionDurationMs), ...normIntervals(interruptions, sessionDurationMs)];
  return sumIntervals(subtractIntervals(usable, cuts));
}

// ------------------------------------------------------------------ reps
/** Deduplicate repetition observations: sorted by time, confidence-gated,
 *  physically-impossible rapid duplicates collapsed (min gap per drill),
 *  anything outside the session window dropped. Two detectors reporting
 *  the same instant count once. */
export function dedupeReps(reps, { sessionDurationMs = Infinity, minGapMs = 250, minConfidence = 0.5 } = {}) {
  const valid = (reps ?? [])
    .map((r) => ({ atMs: Number(r.atMs), confidence: r.confidence == null ? 1 : Number(r.confidence) }))
    .filter((r) => Number.isFinite(r.atMs) && r.atMs >= 0 && r.atMs <= sessionDurationMs && r.confidence >= minConfidence)
    .sort((a, b) => a.atMs - b.atMs);
  const out = [];
  for (const r of valid) {
    if (out.length && r.atMs - out[out.length - 1].atMs < minGapMs) continue;
    out.push(r);
  }
  return out;
}

// ----------------------------------------------------------- completion
/** Target completion strictly from VERIFIED values. 1 ms / 1 rep under
 *  target is NOT completed — near misses are recorded, never rounded up.
 *  Returns null when the pinned drill/provider cannot verify the target's
 *  metric (honesty over fabrication). */
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
      if (!capabilities.includes('rep_count') || !capabilities.includes('interval_completion') || reps == null) return null;
      return setsCompleted >= (target.sets ?? 0) && reps >= (target.sets ?? 0) * (target.repsPerSet ?? 0);
    default:
      return null;
  }
}

// -------------------------------------------------------------- quality
/** Session-level detection quality from observed coverage of the session. */
export function detectionQuality({ observedMs = 0, sessionDurationMs = 0 }) {
  if (sessionDurationMs <= 0) return 'insufficient';
  const ratio = observedMs / sessionDurationMs;
  if (ratio >= 0.75) return 'good';
  if (ratio >= 0.2) return 'degraded';
  return 'insufficient';
}

// -------------------------------------------------- verification state
/** Derive the final verification state + machine-readable reasons.
 *  A session the player finished is never erased: partial observed work
 *  stays recorded under partially_verified; only a total absence of
 *  reliable observation becomes unable_to_verify. */
export function deriveVerification({ cancelled = false, livenessPassed = false, providerAvailable = true, activeMs = 0, sessionDurationMs = 0, completed, quality, interruptionsCount = 0, unsupportedTargetMetric = false }) {
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
/** Box Streak: consistency against PLANNED training weeks — at least one
 *  finalized session with verified activity in each consecutive training
 *  week counting back from the current week. Rest days never matter; only
 *  whole weeks with zero sessions end a streak. */
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
  // The current week counts if it already has a session; otherwise it is
  // still in progress and does not break the streak.
  if (weeks.has(w)) streak++;
  w--;
  while (weeks.has(w)) { streak++; w--; }
  return streak;
}

// ------------------------------------------------------------ Box Best
/** Personal bests per drill@version. Comparisons never cross detector
 *  versions — box-control@1 and @2 are different measurements. */
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
/** Deterministic challenge progress from distinct finalized sessions inside
 *  the challenge window. A replayed/duplicate session id never counts
 *  twice; sessions after the end date never count. */
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
/** Aggregate development activity — evidence of recorded training
 *  activity, explicitly NOT proof of player ability. */
export const DEV_ACTIVITY_NOTE = 'This is evidence of recorded training activity. It is not proof of player ability.';
export function developmentActivity({ sessions = [], assignments = [], drillsById = new Map(), days = 30, now = Date.now() }) {
  const since = now - days * 86_400_000;
  const recent = sessions.filter((s) => TERMINAL_STATES.has(s.verificationState) && !['cancelled', 'invalidated'].includes(s.verificationState) && (s.endedAt ?? s.startedAt) >= since);
  const verified = recent.filter((s) => ['verified', 'partially_verified'].includes(s.verificationState));
  const byCategory = new Map();
  for (const s of verified) {
    const cat = drillsById.get(s.drillId)?.category ?? 'training';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + s.verifiedActiveMs);
  }
  const assignedRecent = assignments.filter((a) => a.createdAt >= since && a.state !== 'cancelled' && a.state !== 'superseded');
  return {
    days,
    boxSessions: recent.length,
    verifiedActiveMs: verified.reduce((t, s) => t + s.verifiedActiveMs, 0),
    assigned: assignedRecent.length,
    assignedCompleted: assignedRecent.filter((a) => a.state === 'completed').length,
    focus: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, ms]) => ({ category, activeMs: ms })),
    note: DEV_ACTIVITY_NOTE,
  };
}

// ----------------------------------------------------- result integrity
/** Canonical result hash — integrity metadata for a finalized session.
 *  (Provenance plumbing, not a blockchain.) */
export function resultHash(session) {
  const canonical = JSON.stringify({
    id: session.id, playerId: session.playerId, drillId: session.drillId, drillVersion: session.drillVersion,
    target: session.target, startedAt: session.startedAt, endedAt: session.endedAt,
    sessionDurationMs: session.sessionDurationMs, verifiedActiveMs: session.verifiedActiveMs,
    verifiedReps: session.verifiedReps ?? null, setsCompleted: session.setsCompleted ?? 0,
    verificationState: session.verificationState, provider: session.provider, providerVersion: session.providerVersion,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The honest Box Cam provenance detail line for one session. */
export function boxCamDetail(session) {
  const base = 'Recorded live through ScoutBox Box Cam.';
  if (session.verifiedReps != null) {
    return `${base} ScoutBox observed ${session.verifiedReps} repetitions consistent with the selected supported drill across ${fmtMs(session.verifiedActiveMs)} of active capture.`;
  }
  return `${base} ScoutBox observed activity consistent with the selected supported drill for ${fmtMs(session.verifiedActiveMs)}.`;
}
