// M22 — the capability separation (§27, §28, §30, §58, §59).
//
// THE ONE IDEA THIS FILE EXISTS FOR
//
// Before this phase, `production_cv` had no capabilities, so nothing could be
// measured with it and the Combine blocker was enforced by absence. That is a
// weak kind of safety: it holds only while the provider does nothing.
//
// Now the provider genuinely observes. So the blocker has to be enforced by
// STRUCTURE rather than by emptiness, and the structure is this: a provider
// has TWO capability lists, and they are never the same object.
//
//   observationCapabilities()  what the engine can actually see. Drives Box
//                              Cam observed. Real, and honest about it.
//
//   combineCapabilities()      what may be used to mint a STANDARDISED,
//                              COMPARABLE Combine measurement. Filtered
//                              through the real-world validation record, per
//                              protocol. Currently empty for every protocol.
//
// `measurementSupported()` in m16/combineShared.mjs is set containment over
// whichever list it is handed. Hand it the observation list and a synthetic
// success mints Combine Verified. Hand it the combine list and it cannot,
// because the list is empty until a versioned real-world validation record
// exists for that specific protocol at this engine and policy version.
//
// So the governing rule of the phase —
//
//   "The transport may deliver evidence to the engine. It may never grant the
//    engine permission to claim more than the evidence justifies."
//
// — is implemented as: the transport feeds observationCapabilities, and only
// a validation record feeds combineCapabilities.
//
// WHY NOT A BOOLEAN FLAG
//
// A flag (`combineEnabled = false`) can be flipped by configuration, by an
// environment variable, or by someone who believes the synthetic numbers are
// good enough. This cannot: `combineCapabilities()` derives its answer from
// `realWorldValidationPass()`, which reads a versioned record that must name a
// matching engine version, policy version and dataset. There is no argument
// you can pass to this module to make it say yes.

import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION, CANDIDATE_PROTOCOLS } from './policy.mjs';
import { realWorldValidationPass, REAL_WORLD_VALIDATION } from './validation.mjs';

/**
 * What the v2 engine genuinely observes, in M16 capability vocabulary.
 *
 * Each entry is a claim this repository can defend with a measurement:
 *
 *   player_presence   detect.mjs finds a person region      (39/39 families)
 *   ball_presence     detect.mjs finds a ball blob           (39/39 families)
 *   active_motion     tracking produces player-relative motion
 *   active_duration   server-owned timeline over usable samples
 *   rep_count         protocol.mjs contact state machine     (0 false touches
 *                     across 56 adversarial scenes, 3 holdout generations)
 *
 * Deliberately absent, because the engine cannot do them and a claim here
 * would flow straight into a product surface:
 *
 *   foot_classification   no left/right foot discrimination exists
 *   technique_signals     no technique model exists
 *   interval_completion   no work/rest interval detection exists
 */
export const OBSERVATION_CAPABILITIES = Object.freeze([
  'player_presence', 'ball_presence', 'active_motion', 'active_duration', 'rep_count',
]);

/** Capabilities the engine explicitly does NOT have, stated so it is checkable. */
export const NON_CAPABILITIES = Object.freeze({
  foot_classification: 'No left/right foot discrimination exists in the engine.',
  technique_signals: 'No technique model exists. ScoutBox does not score how a touch looked.',
  interval_completion: 'No work/rest interval detection exists.',
  identity: 'No face, body or gait identity recognition. Prohibited, not merely absent.',
  emotion: 'No affect inference of any kind.',
  audio: 'Audio is never captured, transported or analysed.',
});

/**
 * The Combine-eligible capability list for one protocol.
 *
 * Returns `[]` unless a current, passing, versioned real-world validation
 * record exists for that protocol at THIS engine and policy version.
 *
 * `providerCapabilities` is the provider's observation list. Note it is
 * intersected, never unioned: validation can only ever permit a subset of
 * what the provider actually observes. A validation record for a capability
 * the provider does not have grants nothing.
 */
export function combineCapabilities(protocolId, {
  providerCapabilities = OBSERVATION_CAPABILITIES,
  table = REAL_WORLD_VALIDATION,
  engineVersion = CV_ENGINE_VERSION,
  policyVersion = BOX_CAM_CV_POLICY_VERSION,
} = {}) {
  const verdict = realWorldValidationPass(protocolId, { table, engineVersion, policyVersion });
  // DEFENSIVE, AND NOT PARANOIA — this exact line was wrong once.
  //
  // `realWorldValidationPass()` returns an OBJECT, `{ pass, status, problems }`,
  // which is always truthy. The first cut of this function read it as a
  // boolean, so `if (!verdict) return []` never fired and every protocol came
  // back Combine-eligible: the single most important gate in ScoutBox, open,
  // from a truthiness mistake that reviews well.
  //
  // So the test is not "is it truthy" but "is it EXACTLY the boolean true".
  // Anything else — an object, a string, undefined, a future refactor that
  // changes the return shape again — denies. The failure mode of this
  // function must be closed, and `=== true` is what makes the closed
  // direction the default rather than the exception.
  if (verdict?.pass !== true) return [];
  const candidate = CANDIDATE_PROTOCOLS[protocolId];
  if (!candidate) return [];
  // Only the capabilities this protocol's measurement actually requires, and
  // only those the provider genuinely has.
  return candidate.requires.filter((c) => providerCapabilities.includes(c));
}

/**
 * Why a protocol is not Combine-eligible, in machine-readable form.
 *
 * Returned alongside the empty list so no caller has to infer the reason, and
 * so the reason appears in the capability report and in the player-facing copy
 * rather than being a silent absence.
 */
export function combineEligibility(protocolId, opts = {}) {
  const candidate = CANDIDATE_PROTOCOLS[protocolId] ?? null;
  if (!candidate) {
    return { eligible: false, capabilities: [], reason: 'UNSUPPORTED_PROTOCOL', reasonDetail: 'This protocol is not a Box Cam CV candidate.' };
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

/** Every candidate protocol's eligibility, for the capability report. */
export function combineEligibilityMatrix(opts = {}) {
  const out = {};
  for (const id of Object.keys(CANDIDATE_PROTOCOLS)) out[id] = combineEligibility(id, opts);
  return out;
}

/** The protocols that are actually Combine-verified-capable right now. */
export function combineVerifiedProtocols(opts = {}) {
  return Object.entries(combineEligibilityMatrix(opts))
    .filter(([, v]) => v.eligible)
    .map(([id]) => id);
}

// =========================================================================
// §30 — Box Cam observed eligibility, evaluated INDEPENDENTLY
// =========================================================================
//
// Box Cam observed and Combine Verified are different claims with different
// evidence bars, and collapsing them is the mistake this whole phase guards
// against.
//
//   Box Cam observed  "this activity was genuinely observed happening"
//   Combine Verified  "this is a standardised, comparable measurement"
//
// The first is a statement about an event. The second is a statement about a
// NUMBER, and a number invites comparison between players, which is what
// makes it need real-world validation. Observation needs the activity to have
// been seen; it does not need the count to be exact, and M16 semantics never
// required an exact count for a Box Cam session.

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

/**
 * Decide Box Cam observed for one finalized provider result.
 *
 * Deliberately does NOT require an exact count: per §30, M16 semantics never
 * did, and requiring one here would silently import the Combine evidence bar
 * into a claim that does not need it — which would look conservative and
 * would in fact be a category error.
 */
export function boxCamObservedEligible({
  providerHealth,
  sessionLive,
  livenessPassed,
  result,
  drillRequiresBall = true,
  supportedDrill = true,
} = {}) {
  const failed = [];
  const add = (id, ok) => { if (!ok) failed.push(id); };

  add('provider_ready', providerHealth === 'ready' || providerHealth === 'degraded');
  add('live_session', !!sessionLive);
  add('liveness_passed', !!livenessPassed);
  add('supported_drill', !!supportedDrill);

  const d = result?.derived ?? {};
  add('person_present', !!d.personPresent);
  add('ball_present_if_drill_requires', drillRequiresBall ? !!d.ballPresent : true);
  // "Activity progressed" means the observation contains motion over time, not
  // that a target was met. A refused attempt has not progressed; an accepted
  // one with a positive active duration has.
  add('activity_progressed', result?.outcome === 'accepted' && Number(d.activeDurationMs) > 0);
  add('integrity_ok', result?.integrity?.ok !== false);
  add('observation_quality_sufficient', result?.observationQuality?.sufficient === true);

  return {
    eligible: failed.length === 0,
    failed,
    // Said explicitly on every result, passing or not, so no reader can infer
    // that a successful observation implies a verified measurement.
    combineVerified: false,
    combineVerifiedNote: 'Box Cam observed is not Combine Verified. Combine verification for CV protocols remains disabled pending real-world validation.',
  };
}

/**
 * The single sentence every surface uses for this. One string, so the product
 * cannot drift into four differently-worded explanations of the same fact.
 */
export const COMBINE_DISABLED_REASON = Object.freeze({
  code: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
  short: 'Combine verification is not available yet for this protocol.',
  detail: 'Real-world validation has not been completed, so ScoutBox will not publish a standardised Combine measurement from computer vision.',
});
