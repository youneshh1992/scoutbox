// A provider has two capability lists. observationCapabilities() is what the engine can see and drives Box Cam
// observed. combineCapabilities() is what may mint a comparable Combine measurement: filtered per protocol through
// the real-world validation record, and currently empty. `measurementSupported()` is set containment, so handing it
// the observation list would mint Combine Verified from synthetic success. This is not a flag because a flag can be
// flipped by configuration; no argument to this module makes it say yes without a matching versioned record.

import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION, CANDIDATE_PROTOCOLS } from './policy.mjs';
import { realWorldValidationPass, REAL_WORLD_VALIDATION } from './validation.mjs';

/** Each entry is backed by the recorded synthetic evaluation (cv/evaluation.json, cv/holdout.json). */
export const OBSERVATION_CAPABILITIES = Object.freeze([
  'player_presence',
  'ball_presence',
  'active_motion',
  'active_duration',
  'rep_count',
]);

export const NON_CAPABILITIES = Object.freeze({
  foot_classification: 'No left/right foot discrimination exists in the engine.',
  technique_signals: 'No technique model exists. ScoutBox does not score how a touch looked.',
  interval_completion: 'No work/rest interval detection exists.',
  identity: 'No face, body or gait identity recognition. Prohibited, not merely absent.',
  emotion: 'No affect inference of any kind.',
  audio: 'Audio is never captured, transported or analysed.',
});

/**
 * `[]` unless a passing real-world validation record exists for the protocol at this engine and policy version.
 * Intersected with the provider's observation list, so validation only permits a subset of what it observes.
 */
export function combineCapabilities(
  protocolId,
  {
    providerCapabilities = OBSERVATION_CAPABILITIES,
    table = REAL_WORLD_VALIDATION,
    engineVersion = CV_ENGINE_VERSION,
    policyVersion = BOX_CAM_CV_POLICY_VERSION,
  } = {},
) {
  const verdict = realWorldValidationPass(protocolId, { table, engineVersion, policyVersion });
  // The verdict is an always-truthy object; `=== true` makes any other shape deny.
  if (verdict?.pass !== true) return [];
  const candidate = CANDIDATE_PROTOCOLS[protocolId];
  if (!candidate) return [];
  return candidate.requires.filter((c) => providerCapabilities.includes(c));
}

/** Why a protocol is not Combine-eligible, so the reason reaches the report and player copy. */
export function combineEligibility(protocolId, opts = {}) {
  const candidate = CANDIDATE_PROTOCOLS[protocolId] ?? null;
  if (!candidate) {
    return {
      eligible: false,
      capabilities: [],
      reason: 'UNSUPPORTED_PROTOCOL',
      reasonDetail: 'This protocol is not a Box Cam CV candidate.',
    };
  }
  const caps = combineCapabilities(protocolId, opts);
  if (caps.length === 0) {
    const entry = (opts.table ?? REAL_WORLD_VALIDATION)[protocolId];
    const verdict = realWorldValidationPass(protocolId, {
      table: opts.table ?? REAL_WORLD_VALIDATION,
      engineVersion: opts.engineVersion ?? CV_ENGINE_VERSION,
      policyVersion: opts.policyVersion ?? BOX_CAM_CV_POLICY_VERSION,
    });
    return {
      eligible: false,
      capabilities: [],
      reason: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
      reasonDetail: 'Combine verification for this protocol is disabled pending real-world validation.',
      validationStatus: entry?.status ?? 'not_completed',
      validationProblems: verdict?.problems ?? [],
    };
  }
  const missing = candidate.requires.filter((c) => !caps.includes(c));
  if (missing.length) {
    return { eligible: false, capabilities: caps, reason: 'MEASUREMENT_NOT_SUPPORTED', missingCapabilities: missing };
  }
  return { eligible: true, capabilities: caps, reason: null };
}

export function combineEligibilityMatrix(opts = {}) {
  const out = {};
  for (const id of Object.keys(CANDIDATE_PROTOCOLS)) out[id] = combineEligibility(id, opts);
  return out;
}

export function combineVerifiedProtocols(opts = {}) {
  return Object.entries(combineEligibilityMatrix(opts))
    .filter(([, v]) => v.eligible)
    .map(([id]) => id);
}

// =========================================================================
// Box Cam observed eligibility, evaluated independently
// =========================================================================
// Box Cam observed is a claim about an event; Combine Verified is a comparable number, which is what needs
// real-world validation. Observation doesn't need an exact count.

export const BOX_CAM_OBSERVED_REQUIREMENTS = Object.freeze([
  'provider_ready',
  'live_session',
  'liveness_passed',
  'person_present',
  'ball_present_if_drill_requires',
  'activity_progressed',
  'integrity_ok',
  'observation_quality_sufficient',
  'supported_drill',
]);

/** Doesn't require an exact count: that would import the Combine evidence bar into a claim that doesn't need it. */
export function boxCamObservedEligible({
  providerHealth,
  sessionLive,
  livenessPassed,
  result,
  drillRequiresBall = true,
  supportedDrill = true,
} = {}) {
  const failed = [];
  const add = (id, ok) => {
    if (!ok) failed.push(id);
  };

  add('provider_ready', providerHealth === 'ready' || providerHealth === 'degraded');
  add('live_session', !!sessionLive);
  add('liveness_passed', !!livenessPassed);
  add('supported_drill', !!supportedDrill);

  const d = result?.derived ?? {};
  add('person_present', !!d.personPresent);
  add('ball_present_if_drill_requires', drillRequiresBall ? !!d.ballPresent : true);
  // Motion over time, not a target met.
  add('activity_progressed', result?.outcome === 'accepted' && Number(d.activeDurationMs) > 0);
  add('integrity_ok', result?.integrity?.ok !== false);
  add('observation_quality_sufficient', result?.observationQuality?.sufficient === true);

  return {
    eligible: failed.length === 0,
    failed,
    // On every result, so a successful observation isn't read as a verified measurement.
    combineVerified: false,
    combineVerifiedNote:
      'Box Cam observed is not Combine Verified. Combine verification for CV protocols remains disabled pending real-world validation.',
  };
}

/** The one wording every surface uses. */
export const COMBINE_DISABLED_REASON = Object.freeze({
  code: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
  short: 'Combine verification is not available yet for this protocol.',
  detail:
    'Real-world validation has not been completed, so ScoutBox will not publish a standardised Combine measurement from computer vision.',
});
