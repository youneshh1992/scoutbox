// The Box Cam rules behind the Box Cam battery (e2e/development/boxCam.mjs), checked in this process: the active-time
// and repetition engines, verification states, the streak, challenge progress and the provider registry.
import {
  verifiedActiveMs,
  dedupeReps,
  targetCompleted,
  detectionQuality,
  deriveVerification,
  boxStreakWeeks,
  challengeProgress,
  mergeIntervals,
  subtractIntervals,
  intersectIntervals,
} from '../../../domains/development/boxcam/shared.mjs';
import { drillByIdVersion, providerFor, PROVIDERS } from '../../../domains/development/boxcam/drills.mjs';
import { combineVerifiedProtocols, combineCapabilities } from '../../../domains/development/boxcam/cv/eligibility.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('development/boxCam');
const MIN = 60_000;

// ============================================================ U1 active time
section('U1 — active-time engine: observed active ≠ elapsed');
{
  ok(
    verifiedActiveMs({ activeIntervals: [{ fromMs: 0, toMs: 5 * MIN }], sessionDurationMs: 10 * MIN }) === 5 * MIN,
    'plain active interval sums',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [
        { fromMs: 0, toMs: 5 * MIN },
        { fromMs: 2 * MIN, toMs: 6 * MIN },
      ],
      sessionDurationMs: 10 * MIN,
    }) ===
      6 * MIN,
    'overlapping intervals union (no double count)',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [
        { fromMs: 0, toMs: 5 * MIN },
        { fromMs: 0, toMs: 5 * MIN },
      ],
      sessionDurationMs: 10 * MIN,
    }) ===
      5 * MIN,
    'duplicate interval counts once',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [
        { fromMs: 1 * MIN, toMs: 2 * MIN },
        { fromMs: 0, toMs: 5 * MIN },
      ],
      sessionDurationMs: 10 * MIN,
    }) ===
      5 * MIN,
    'nested interval absorbed',
  );
  neg(
    verifiedActiveMs({ activeIntervals: [{ fromMs: 8 * MIN, toMs: 20 * MIN }], sessionDurationMs: 10 * MIN }) ===
      2 * MIN,
    'interval clamped to session window — time outside the session never counts',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }],
      pauses: [{ fromMs: 3 * MIN, toMs: 5 * MIN }],
      sessionDurationMs: 10 * MIN,
    }) ===
      8 * MIN,
    'paused period removed',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }],
      interruptions: [{ fromMs: 3 * MIN, toMs: 5 * MIN }],
      sessionDurationMs: 10 * MIN,
    }) ===
      8 * MIN,
    'interruption removed',
  );
  neg(
    verifiedActiveMs({
      activeIntervals: [{ fromMs: 0, toMs: 10 * MIN, quality: 'insufficient' }],
      sessionDurationMs: 10 * MIN,
    }) === 0,
    'insufficient-quality observation never counts as active',
  );
  ok(
    verifiedActiveMs({
      activeIntervals: [{ fromMs: 0, toMs: 10 * MIN }],
      requiredIntervals: [{ fromMs: 0, toMs: 6 * MIN }],
      sessionDurationMs: 10 * MIN,
    }) ===
      6 * MIN,
    'ball-required drill: only active∩ball counts',
  );
  // exact / boundary
  ok(
    targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN }, []) === true,
    'exactly target = completed',
  );
  neg(
    targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN - 1 }, []) === false,
    '1 ms below target is NOT completed',
  );
  ok(
    targetCompleted({ type: 'duration', value: 20 * MIN }, { activeMs: 20 * MIN + 1 }, []) === true,
    '1 ms above target = completed',
  );
  ok(
    JSON.stringify(
      mergeIntervals([
        { fromMs: 0, toMs: 1 },
        { fromMs: 1, toMs: 2 },
      ]),
    ) === JSON.stringify([{ fromMs: 0, toMs: 2 }]),
    'adjacent intervals merge',
  );
  ok(intersectIntervals([{ fromMs: 0, toMs: 10 }], [{ fromMs: 5, toMs: 20 }])[0].toMs === 10, 'intersection clips');
  ok(
    subtractIntervals([{ fromMs: 0, toMs: 10 }], [{ fromMs: 4, toMs: 6 }]).length === 2,
    'subtract splits an interval',
  );
  ok(
    detectionQuality({ observedMs: 9 * MIN, sessionDurationMs: 10 * MIN }) === 'good' &&
      detectionQuality({ observedMs: 3 * MIN, sessionDurationMs: 10 * MIN }) === 'degraded' &&
      detectionQuality({ observedMs: 1 * MIN, sessionDurationMs: 10 * MIN }) === 'insufficient',
    'quality bands',
  );
}

// ============================================================ U2 reps
section('U2 — repetition engine: honest dedupe');
{
  ok(
    dedupeReps([{ atMs: 0 }, { atMs: 300 }, { atMs: 600 }], { minGapMs: 250 }).length === 3,
    'well-spaced reps counted',
  );
  neg(
    dedupeReps([{ atMs: 0 }, { atMs: 100 }], { minGapMs: 250 }).length === 1,
    'physically-impossible rapid duplicate collapsed',
  );
  neg(
    dedupeReps(
      [
        { atMs: 1000, confidence: 0.9 },
        { atMs: 1000, confidence: 0.8 },
      ],
      { minGapMs: 250 },
    ).length === 1,
    'two detectors on the same instant count once',
  );
  neg(dedupeReps([{ atMs: 500, confidence: 0.3 }], { minConfidence: 0.5 }).length === 0, 'low-confidence rep dropped');
  neg(
    dedupeReps([{ atMs: 99999 }], { sessionDurationMs: 5000 }).length === 0,
    'rep outside the session window dropped',
  );
  ok(
    dedupeReps([{ atMs: 600 }, { atMs: 0 }, { atMs: 300 }], { minGapMs: 250 }).length === 3,
    'out-of-order reps sorted then counted',
  );
  ok(
    targetCompleted({ type: 'repetitions', value: 100 }, { reps: 100 }, ['rep_count']) === true,
    '100/100 reps completed',
  );
  neg(
    targetCompleted({ type: 'repetitions', value: 150 }, { reps: 149 }, ['rep_count']) === false,
    '149/150 is NOT completed (never rounded up)',
  );
  neg(
    targetCompleted({ type: 'repetitions', value: 100 }, { reps: 100 }, []) === null,
    'rep target on a drill without rep_count capability → null (not fabricated)',
  );
}

// ================================================= U3 states / streak / challenge
section('U3 — verification states, streak, challenge progress');
{
  ok(
    deriveVerification({
      livenessPassed: true,
      providerAvailable: true,
      activeMs: 20 * MIN,
      sessionDurationMs: 20 * MIN,
      completed: true,
      quality: 'good',
    }).state === 'verified',
    'good + completed → verified',
  );
  ok(
    deriveVerification({
      livenessPassed: true,
      providerAvailable: true,
      activeMs: 13 * MIN,
      sessionDurationMs: 20 * MIN,
      completed: false,
      quality: 'good',
    }).state === 'partially_verified',
    'observed work but target missed → partially_verified (never erased)',
  );
  ok(
    deriveVerification({
      livenessPassed: true,
      providerAvailable: true,
      activeMs: 0,
      sessionDurationMs: 20 * MIN,
      completed: false,
      quality: 'insufficient',
    }).state === 'unable_to_verify',
    'no reliable observation → unable_to_verify',
  );
  neg(
    deriveVerification({
      livenessPassed: false,
      providerAvailable: true,
      activeMs: 20 * MIN,
      sessionDurationMs: 20 * MIN,
      completed: true,
      quality: 'good',
    }).state === 'completed_unverified',
    'no liveness → never Box Cam Verified',
  );
  neg(
    deriveVerification({
      livenessPassed: true,
      providerAvailable: false,
      activeMs: 20 * MIN,
      sessionDurationMs: 20 * MIN,
      completed: true,
      quality: 'good',
    }).state === 'completed_unverified',
    'provider unavailable → not verified',
  );
  ok(deriveVerification({ cancelled: true }).state === 'cancelled', 'cancelled state');
  // streak: rest days never break it
  const wk = 7 * 86_400_000;
  const now = 100 * wk;
  const sess = (w) => ({ verificationState: 'verified', verifiedActiveMs: 10 * MIN, endedAt: w * wk });
  ok(boxStreakWeeks([sess(100), sess(99), sess(98)], now) === 3, 'consecutive training weeks build a streak');
  ok(boxStreakWeeks([sess(99), sess(98)], now) === 2, 'current week still in progress does not break the streak');
  neg(
    boxStreakWeeks([sess(100), sess(98)], now) === 1,
    'an empty week ends the streak (only at week granularity — rest days never matter)',
  );
  const chal = { drillId: 'box-touches', metric: 'reps', targetTotal: 1000, startsAt: 0, endsAt: now };
  const cs = challengeProgress(chal, [
    { id: 's1', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 600, endedAt: wk },
    { id: 's1', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 600, endedAt: wk },
    { id: 's2', drillId: 'box-touches', verificationState: 'verified', verifiedReps: 500, endedAt: 2 * wk },
  ]);
  neg(cs.total === 1100 && cs.completed, 'duplicate session id counts once in challenge progress (replay-safe)');
  ok(
    providerFor('local_test', { testProviderEnabled: false }) === null &&
      providerFor('local_test', { testProviderEnabled: true }) !== null,
    'test provider hidden unless explicitly enabled',
  );
  // A real server-side CV provider exists, so the property asserted is that
  // the provider is genuinely configured AND still cannot mint a Combine
  // measurement, which is a harder property than "it does nothing".
  ok(
    PROVIDERS.production_cv.status === 'configured' && PROVIDERS.production_cv.capabilities.length > 0,
    'production CV is a real configured provider with genuine observation capabilities',
  );
  ok(
    combineVerifiedProtocols().length === 0,
    'and it still verifies NO Combine protocol — real-world validation is not completed',
  );
  ok(
    combineCapabilities('combine-box-touch-60').length === 0,
    'its Combine-eligible capability list is empty even though it can observe touches',
  );
  ok(
    drillByIdVersion('box-wall', 1).repSupport === 'not_configured' &&
      !drillByIdVersion('box-wall', 1).verificationCapabilities.includes('rep_count'),
    'Box Wall honestly declares rep counting not configured',
  );
}

done();
