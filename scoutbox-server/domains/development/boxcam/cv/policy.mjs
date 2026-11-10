// Every engine threshold lives here, version-stamped and asserted by the evaluation harness, so it cannot be relaxed
// to make a test pass without showing in a diff and a measured result. A refused measurement is acceptable; a falsely
// verified one is not.

export const BOX_CAM_CV_POLICY_VERSION = 1;

// Bumped whenever a rule change could change a count. A stored result keeps the version that produced it.
export const CV_ENGINE_VERSION = 2;

export const CV_PROVIDER_ID = 'production_cv';

// ---------------------------------------------------------------- frames
// The only encoding is `gray8`: a raw 8-bit luminance plane, width × height bytes, row-major, base64 in transit. With
// no image parser there is no parser to attack; a malformed payload is a length mismatch. A browser produces it with
// canvas `getImageData` and a luminance reduction.
export const FRAME_ENCODING = 'gray8';

export const FRAME_LIMITS = Object.freeze({
  minWidth: 160, minHeight: 120,
  maxWidth: 320, maxHeight: 240,
  // A frame is exactly w*h bytes, so an oversized body is refused on size before anything interprets it.
  maxBytes: 320 * 240,
  maxFramesPerBatch: 12,
  maxBatchesPerSession: 120,
  // Frames beyond the bounded queue are dropped, not buffered.
  maxQueuedFrames: 24,
});

// Anything outside these is refused at Ready Check rather than silently degraded.
export const CAPTURE_REQUIREMENTS = Object.freeze({
  minFps: 6,
  maxFps: 30,
  minWidth: FRAME_LIMITS.minWidth,
  minHeight: FRAME_LIMITS.minHeight,
  // Below this sustained cadence contacts fall between observations, so no exact count.
  minSustainedFps: 12,
  // Fraction of the attempt that may sit below minSustainedFps before exact measurement is refused.
  maxLowFpsFrac: 0.2,
  // An interval is "low" only if more than 15% over nominal. Without the band, 12 fps (83.33 ms) is condemned by
  // integer timestamps alternating 83/84 ms, every 84 reading as 11.9 fps.
  lowFpsIntervalTolerance: 1.15,
  // Only orientations exercised by the evaluation fixtures.
  supportedOrientations: Object.freeze(['landscape', 'portrait']),
  // No native device tests exist, so no native claim.
  supportedPlatforms: Object.freeze(['web']),
});

// ------------------------------------------------------------- detection
export const DETECTION = Object.freeze({
  // A ball candidate is a bright blob; its size as a fraction of frame area.
  ballMinAreaFrac: 0.0008,
  ballMaxAreaFrac: 0.05,
  // Luminance margin above the local background for a pixel to be ball-like.
  ballMinContrast: 40,
  // 1.0 is a perfect circle by the area-to-bounding-box test; flatter is a limb, shadow or line.
  ballMinRoundness: 0.55,
  personMinAreaFrac: 0.01,
  // Below this mean luminance the attempt is refused as insufficient_visibility.
  minMeanLuma: 28,
  // Below this the frame has no usable structure (covered lens, flat wall). Kept low because a capture against a
  // plain background has little variance, and a higher value refuses a well-lit scene as "too dark".
  minLumaStdDev: 3,
  // Inter-frame difference under this is a static image or frozen stream.
  staticFrameMaxMeanDiff: 1.2,
  staticRunFrames: 6,
});

// ------------------------------------------------------------ event rules
// Distances are in ball diameters and times in milliseconds, so the same scene at any resolution or frame rate
// yields the same numbers: the ball is the ruler and seconds are the clock.
//
// Unit key:  d  = ball diameters        d/s = ball diameters per second
//            ms = milliseconds          —   = dimensionless ratio
export const EVENT_RULES = Object.freeze({
  // ms: two contacts closer than this are one contact observed twice.
  touchRefractoryMs: 180,
  juggleRefractoryMs: 300,

  // d: a juggle contact must be followed by a flight this high relative to the player, so a resting ball's jitter
  // doesn't count.
  juggleMinFlightDiameters: 0.9,

  // d/s: a touch is a change in the ball's velocity, in the player's frame of reference, of at least this.
  touchMinImpulseDiametersPerSec: 4.5,

  // d: ball centroid to the nearest edge of the player region; about one ball width, allowing for silhouette
  // imprecision. At five widths the false-touch suite counted touches on a ball nobody went near.
  touchMaxContactDiameters: 1.2,

  // d: the ball must move this far from where it was last struck before another contact counts; the spatial half of
  // the debounce, since a ball resting against a foot outlasts any timer. A toe-tap only nudges the ball, so at 1.2
  // the state machine latched and a 14-touch attempt counted 1. The false-touch stress suite must stay at zero with
  // this value; if not, narrow the supported pace rather than raise it.
  touchMinSeparationDiameters: 0.35,

  // ms: continuously in contact range this long before an impulse reads as a contact. A ball that jumps from far to
  // adjacent is a detector artefact, not a strike.
  touchMinApproachMs: 120,

  // --- gap policy -------------------------------------------------------
  // A short gap is bridged; a long one refuses an exact measurement rather than interpolate. Both limits apply: the
  // frame count is the tracker's tolerance, the ms limit the physical one (four frames at 30 fps is 133 ms, at 8 fps
  // 500 ms).
  maxRecoverableMissingFrames: 4,
  maxRecoverableFrameGapMs: 400,
  // Aliases read by other call sites.
  maxBallGapFrames: 4,
  maxBallGapMs: 400,

  // --- supported cadence envelope ---------------------------------------
  // Measured: within tolerance down to 340 ms between touches, under-counts at 260 ms.
  minimumSupportedTouchIntervalMs: 340,
  // Fraction of contact-range impulses the refractory window may suppress before the attempt is judged too fast.
  // Derived from observed impulses, not from the touches finally emitted.
  maxRefractorySuppressedFrac: 0.25,

  // Fraction of the attempt the ball may be missing in total.
  maxBallMissingFrac: 0.25,

  // A rival blob this close in size to the primary is a second ball.
  secondBallMinAreaRatio: 0.6,

  // Largest per-sample change in the player region's apparent size still treated as the same frame of reference.
  // Scaling by s moves a stationary ball by (s-1)·|rel|, a fabricated velocity of (s-1)·(|rel|/d)/dt d/s. That must
  // stay under touchMinImpulseDiametersPerSec (4.5) at 30 fps with |rel|/d ≈ 3.5 (the fixtures' worst case):
  // (s-1)·3.5·30 < 4.5 ⇒ s-1 < 0.043. A one-pixel edge wobble is about 1.1%, so 0.04 sits between noise and danger.
  // An identity-style 1.4× test let an 18% zoom manufacture a touch.
  maxFrameScaleStepPerSample: 0.04,
});
// ---------------------------------------------------------- confidence
//
// Model certainty about an observation, never rendered as a football-quality figure.
export const CONFIDENCE = Object.freeze({
  // Below this aggregate confidence the attempt is refused.
  minAcceptable: 0.62,
  // A single event below this does not count toward the total.
  minPerEvent: 0.5,
  // Fraction of frames in which the ball must be detected with usable confidence.
  minDetectionCoverage: 0.7,
});

// ------------------------------------------------------------- outcomes
export const OBSERVATION_STATES = Object.freeze([
  'accepted',
  'insufficient_confidence',
  'insufficient_visibility',
  'ball_not_detected',
  'person_not_detected',
  'protocol_violation',
  'liveness_failed',
  'provider_unavailable',
  'unsupported_protocol',
  'unsupported_event_cadence',
]);

// A refusal describes the observation, not the player: "could not verify", never "you failed".
export const STATE_COPY = Object.freeze({
  accepted: 'This attempt was observed and measured.',
  insufficient_confidence: 'Could not verify this attempt — not enough visual confidence in what was observed.',
  insufficient_visibility: 'Could not verify this attempt — the lighting was too low to track the ball reliably.',
  ball_not_detected: 'Could not verify this attempt — the ball was not visible for enough of the attempt.',
  person_not_detected: 'Could not verify this attempt — no player was visible in the capture area.',
  protocol_violation: 'Could not verify this attempt — the capture did not follow the standardised protocol.',
  liveness_failed: 'Could not verify this attempt — the live-session check did not pass.',
  provider_unavailable: 'Production observation is not available right now, so this attempt was not verified.',
  unsupported_protocol: 'Production observation is not available for this test on this device.',
  unsupported_event_cadence: 'Could not verify this attempt — the touches came faster than ScoutBox can reliably count, so no exact result was produced.',
});

export const PROVIDER_HEALTH = Object.freeze([
  'not_configured', 'configured', 'warming', 'ready', 'degraded', 'unavailable',
]);

// ------------------------------------------------- client-supplied fields
//
// The client supplies frames, not a measurement. These names are refused with a 422 rather than ignored, so an
// attempt to self-report is visible in a log.
export const FORBIDDEN_CLIENT_FIELDS = Object.freeze([
  'touches', 'touchCount', 'reps', 'repCount', 'juggles', 'juggleCount',
  'count', 'measurement', 'value', 'result', 'verified', 'verifiedReps',
  'combineVerified', 'confidence', 'modelVersion', 'providerVersion',
  'productionEligible', 'accepted', 'observationState', 'score',
]);

export function refusedClientFields(body) {
  if (!body || typeof body !== 'object') return [];
  return FORBIDDEN_CLIENT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
}

// Confidence must not be rendered as a player-quality value; the suite scans copy for these shapes.
export const FORBIDDEN_CONFIDENCE_PHRASINGS = Object.freeze([
  /player\s+confidence/i,
  /confidence\s+(?:score|rating)\s*[:=]?\s*\d/i,
  /\d+\s*%\s*(?:player|ability|quality|talent)/i,
  /(?:ability|talent|quality)\s+confidence/i,
]);

export function scanCopyForConfidenceMisuse(pairs) {
  const hits = [];
  for (const [where, text] of pairs) {
    if (typeof text !== 'string') continue;
    for (const re of FORBIDDEN_CONFIDENCE_PHRASINGS) {
      if (re.test(text)) hits.push({ where, pattern: String(re) });
    }
  }
  return hits;
}

// ------------------------------------------------------- protocol scope
//
// Presence here means the engine has a rule for it, not that it is enabled; gate.mjs decides that by evaluation.
export const CANDIDATE_PROTOCOLS = Object.freeze({
  'combine-box-touch-60': Object.freeze({
    eventKind: 'touch',
    requires: Object.freeze(['player_presence', 'ball_presence', 'rep_count']),
    note: 'Discrete ball-contact events counted inside the standardised 60-second window.',
  }),
  'combine-box-juggle': Object.freeze({
    eventKind: 'juggle',
    requires: Object.freeze(['player_presence', 'ball_presence', 'rep_count']),
    note: 'Contact → flight → contact sequences; not vertical peak counting.',
  }),
  'combine-box-control-60': Object.freeze({
    eventKind: 'duration',
    requires: Object.freeze(['player_presence', 'ball_presence', 'active_duration']),
    note: 'Continuous close control. Needs no event counting — duration only.',
  }),
});

// What the engine can offer when healthy. Whether a protocol may use `rep_count` is the gate's decision.
export const ENGINE_CAPABILITIES = Object.freeze([
  'player_presence', 'ball_presence', 'active_motion', 'active_duration', 'rep_count',
]);

export const ENGINE_NON_CAPABILITIES = Object.freeze({
  foot_classification: 'Which foot touched the ball is not observed. No limb classification is attempted.',
  technique_signals: 'No technique judgement of any kind is produced.',
  interval_completion: 'Work/rest interval structure is not observed.',
  timing_gate: 'No timing gate exists. Sprint and agility protocols remain unsupported.',
  spatial_scale: 'No real-world distance is derived from camera geometry (§56). Jump and distance protocols remain unsupported.',
  target_zone: 'No target-zone geometry is observed.',
});

Object.freeze(FRAME_LIMITS);
