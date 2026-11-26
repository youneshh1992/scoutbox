// Observation quality and refusal precedence: both stop a number being trusted more than its observation deserves.

import { CAPTURE_REQUIREMENTS, DETECTION, EVENT_RULES, CONFIDENCE } from './policy.mjs';

// =========================================================================
// 1. OBSERVATION QUALITY
// Not a player score: is this attempt observable enough to support the measurement? A state with reasons, from
// properties of the capture (continuity, cadence, lighting, occlusion, duplicates), never the count or the player.

export const QUALITY_THRESHOLDS = Object.freeze({
  minUsableFrameFrac: 0.8, // unit — frames the detector could read at all
  minBallContinuity: 0.75, // unit — frames with a tracked ball
  minPersonContinuity: 0.6, // unit — frames with a located player
  maxDuplicateFrac: 0.35, // unit — repeated frames
  maxTrackResets: 3, // unit count — apparent-size discontinuities
  maxAmbiguousIntervalFrac: 0.15, // unit — contact decisions spanning a gap
  minEffectiveFps: CAPTURE_REQUIREMENTS.minSustainedFps,
  maxLowFpsFrac: CAPTURE_REQUIREMENTS.maxLowFpsFrac,
});

/** The count is not an input, so it cannot rescue a bad capture. */
export function observationQuality({
  continuity,
  cadence,
  duplicates = 0,
  framesSeen = 0,
  ambiguousIntervals = 0,
  eventCount = 0,
}) {
  const reasons = [];
  const n = Math.max(1, continuity.frames);

  const usableFrac = 1 - continuity.unusableFrames / n;
  if (usableFrac < QUALITY_THRESHOLDS.minUsableFrameFrac) {
    reasons.push({
      code: 'low_usable_frame_ratio',
      value: round3(usableFrac),
      threshold: QUALITY_THRESHOLDS.minUsableFrameFrac,
    });
  }
  if (continuity.ballCoverage < QUALITY_THRESHOLDS.minBallContinuity) {
    reasons.push({
      code: 'low_ball_continuity',
      value: round3(continuity.ballCoverage),
      threshold: QUALITY_THRESHOLDS.minBallContinuity,
    });
  }
  if (continuity.personCoverage < QUALITY_THRESHOLDS.minPersonContinuity) {
    reasons.push({
      code: 'low_person_continuity',
      value: round3(continuity.personCoverage),
      threshold: QUALITY_THRESHOLDS.minPersonContinuity,
    });
  }
  if (continuity.maxGapFrames > EVENT_RULES.maxBallGapFrames || continuity.maxGapMs > EVENT_RULES.maxBallGapMs) {
    reasons.push({ code: 'long_occlusion', value: continuity.maxGapMs, threshold: EVENT_RULES.maxBallGapMs });
  }
  const dupFrac = framesSeen ? duplicates / framesSeen : 0;
  if (dupFrac > QUALITY_THRESHOLDS.maxDuplicateFrac) {
    reasons.push({
      code: 'high_duplicate_frame_rate',
      value: round3(dupFrac),
      threshold: QUALITY_THRESHOLDS.maxDuplicateFrac,
    });
  }
  if (continuity.trackResets > QUALITY_THRESHOLDS.maxTrackResets) {
    reasons.push({
      code: 'excessive_track_resets',
      value: continuity.trackResets,
      threshold: QUALITY_THRESHOLDS.maxTrackResets,
    });
  }
  // A capture collapsed to a couple of distinct frames has no meaningful frame rate; claiming one would hide the
  // real finding.
  if (cadence.intervalCount >= 3 && cadence.effectiveFps < QUALITY_THRESHOLDS.minEffectiveFps) {
    reasons.push({
      code: 'insufficient_frame_rate',
      value: cadence.effectiveFps,
      threshold: QUALITY_THRESHOLDS.minEffectiveFps,
    });
  }
  if (cadence.lowFpsFrac > QUALITY_THRESHOLDS.maxLowFpsFrac) {
    reasons.push({
      code: 'frame_rate_dropped_too_often',
      value: round3(cadence.lowFpsFrac),
      threshold: QUALITY_THRESHOLDS.maxLowFpsFrac,
    });
  }
  // Against decisions made, so a short attempt isn't flattered by a small absolute count.
  const decisions = Math.max(1, eventCount + ambiguousIntervals);
  const ambFrac = ambiguousIntervals / decisions;
  if (ambFrac > QUALITY_THRESHOLDS.maxAmbiguousIntervalFrac) {
    reasons.push({
      code: 'ambiguous_contact_intervals',
      value: round3(ambFrac),
      threshold: QUALITY_THRESHOLDS.maxAmbiguousIntervalFrac,
    });
  }

  return {
    state: reasons.length === 0 ? 'sufficient' : 'insufficient',
    reasons,
    // For diagnostics; not player-facing.
    measured: {
      usableFrameFrac: round3(usableFrac),
      ballContinuity: round3(continuity.ballCoverage),
      personContinuity: round3(continuity.personCoverage),
      maxOcclusionMs: continuity.maxGapMs,
      duplicateFrac: round3(dupFrac),
      trackResets: continuity.trackResets,
      effectiveFps: cadence.effectiveFps,
      ambiguousIntervalFrac: round3(ambFrac),
    },
  };
}

// =========================================================================
// 2. REFUSAL PRECEDENCE
//
// Failures coexist (a dark capture usually has no ball either), so the reported reason comes from an explicit order,
// not whichever check ran first. It runs in the order a person can act: provider, device, light, scene, technique.

export const REFUSAL_PRECEDENCE = Object.freeze([
  'provider_unavailable', // nothing could have been observed at all
  'unsupported_protocol', // this test is not observable here
  'session_invalid', // the session was not usable
  'liveness_failed', // live-session check did not pass
  'unsupported_device', // resolution/orientation outside support
  'unsupported_event_cadence', // the activity is faster than we can resolve
  'insufficient_frame_rate', // cadence too low to see contacts
  'insufficient_visibility', // too dark to read the scene
  'protocol_violation', // static image, duplicates, second ball/person
  'person_not_detected', // scene readable, no player
  'ball_not_detected', // scene readable, no ball
  'observation_discontinuity', // tracked, but not continuously enough
  'insufficient_confidence', // observed, but not confidently enough
]);

const PRECEDENCE_INDEX = new Map(REFUSAL_PRECEDENCE.map((c, i) => [c, i]));

/** One primary reason by a total order on the codes; the rest are secondary diagnostics. */
export function primaryRefusal(conditions) {
  const known = [...new Set(conditions)].filter((c) => PRECEDENCE_INDEX.has(c));
  if (known.length === 0) return { primaryReason: null, secondaryDiagnostics: [] };
  known.sort((a, b) => PRECEDENCE_INDEX.get(a) - PRECEDENCE_INDEX.get(b));
  return { primaryReason: known[0], secondaryDiagnostics: known.slice(1) };
}

/** Map quality reason codes onto the canonical refusal vocabulary. */
export function qualityToRefusalConditions(quality) {
  const out = [];
  for (const r of quality.reasons) {
    switch (r.code) {
      case 'insufficient_frame_rate':
      case 'frame_rate_dropped_too_often':
        out.push('insufficient_frame_rate');
        break;
      case 'low_usable_frame_ratio':
        out.push('insufficient_visibility');
        break;
      case 'high_duplicate_frame_rate':
        out.push('protocol_violation');
        break;
      case 'low_person_continuity':
        out.push('person_not_detected');
        break;
      case 'low_ball_continuity':
        out.push('ball_not_detected');
        break;
      case 'long_occlusion':
      case 'excessive_track_resets':
      case 'ambiguous_contact_intervals':
        out.push('observation_discontinuity');
        break;
      default:
        out.push('insufficient_confidence');
    }
  }
  return out;
}

export { CONFIDENCE, DETECTION };

const round3 = (n) => Math.round(n * 1000) / 1000;
