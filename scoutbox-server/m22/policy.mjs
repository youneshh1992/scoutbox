// M22 — Real Box Cam CV v1: the policy surface.
//
// Every threshold the observation engine uses lives HERE, in one frozen
// object, for one reason: §15 of the threat model. A threshold that is
// scattered through the engine can be quietly relaxed to make a test pass.
// A threshold that sits in a single named policy object, is version-stamped,
// and is asserted by the evaluation harness cannot be moved without the move
// being visible in a diff and in a measured result.
//
// The rule this file serves:
//   Observe narrowly. Measure honestly. Refuse when uncertain.
//   A refused measurement is acceptable. A falsely verified one is not.

export const BOX_CAM_CV_POLICY_VERSION = 1;

// The engine's own version. Bumped whenever a rule changes in a way that
// could change a count. A stored result keeps the version that produced it —
// history is never re-derived under a new engine (§46).
export const CV_ENGINE_VERSION = 1;

// The provider that this engine backs. `production_cv` keeps its id: §6
// forbids renaming a test implementation into a production one.
export const CV_PROVIDER_ID = 'production_cv';

// ---------------------------------------------------------------- frames
//
// §83: support only documented formats; do not auto-decode arbitrary files.
//
// The transport accepts exactly ONE encoding: `gray8` — a raw 8-bit
// luminance plane, width × height bytes, row-major, no header, no
// compression, base64 in transit. This is a deliberate security decision as
// much as a simplicity one: there is no image parser, so there is no image
// parser to attack. A malformed payload is a length mismatch, not a decoder
// exploit. A browser produces it with canvas `getImageData` and a luminance
// reduction — the same thing any real client would do before inference.
export const FRAME_ENCODING = 'gray8';

export const FRAME_LIMITS = Object.freeze({
  minWidth: 160, minHeight: 120,
  maxWidth: 320, maxHeight: 240,
  // A frame is exactly w*h bytes. The cap is the largest legal frame plus
  // base64 expansion and JSON overhead, so an oversized body is refused on
  // size before anything tries to interpret it (§82).
  maxBytes: 320 * 240,
  maxFramesPerBatch: 12,
  maxBatchesPerSession: 120,
  // §76/§77: the in-process queue is bounded. Frames beyond it are dropped
  // according to the documented policy, never buffered indefinitely.
  maxQueuedFrames: 24,
});

// §35/§38: capture conditions the engine will accept at all. Anything
// outside these is refused at Ready Check rather than silently degraded.
export const CAPTURE_REQUIREMENTS = Object.freeze({
  minFps: 6,
  maxFps: 30,
  minWidth: FRAME_LIMITS.minWidth,
  minHeight: FRAME_LIMITS.minHeight,
  // §21 of the fix pack: below this sustained cadence an exact count cannot
  // be established, because contacts fall between observations.
  minSustainedFps: 12,
  // unit — fraction of the attempt that may sit below minSustainedFps before
  // exact measurement is refused.
  maxLowFpsFrac: 0.2,
  // Only orientations actually exercised by the evaluation fixtures (§37).
  supportedOrientations: Object.freeze(['landscape', 'portrait']),
  // Web only (§39/§40). No native device tests exist, so no native claim.
  supportedPlatforms: Object.freeze(['web']),
});

// ------------------------------------------------------------- detection
//
// These are the numbers the engine actually applies. Each says what it is
// for, because an unexplained constant is a threshold nobody can audit.
export const DETECTION = Object.freeze({
  // A ball candidate is a bright connected blob. These bound its size as a
  // fraction of frame area — too small is noise, too large is not a ball.
  ballMinAreaFrac: 0.0008,
  ballMaxAreaFrac: 0.05,
  // Luminance margin above the local background for a pixel to be ball-like.
  ballMinContrast: 40,
  // A blob must be roughly round: 1.0 is a perfect circle by the
  // area-to-bounding-box test. Anything flatter is a limb, a shadow or a line.
  ballMinRoundness: 0.55,
  // A person candidate is a large non-background region.
  personMinAreaFrac: 0.01,
  // §31: below this mean luminance the scene cannot be read reliably and the
  // attempt is refused as insufficient_visibility. It is never estimated.
  minMeanLuma: 28,
  // Below this, the frame has no usable structure at all (a covered lens, a
  // flat wall) even if it is bright. Deliberately LOW: a legitimate capture
  // against a plain background has little global variance, and an aggressive
  // value here reports a well-lit scene as "too dark", which is a wrong
  // refusal reason — refusing for the wrong stated reason is its own
  // dishonesty, even though the attempt is refused either way.
  minLumaStdDev: 3,
  // §8 of the threat model: a run of frames whose inter-frame difference is
  // under this floor is a static image or a frozen stream, not activity.
  staticFrameMaxMeanDiff: 1.2,
  // How many consecutive static frames before the sequence is called static.
  staticRunFrames: 6,
});

// ------------------------------------------------------------ event rules
//
// §21 (touch) and §23 (juggle), and §17 (normalized geometry).
//
// EVERY spatial threshold here is expressed in BALL DIAMETERS, and every
// velocity in ball diameters per second. That is the whole resolution- and
// frame-rate-invariance story in one sentence: the same physical scene shot
// at 240x180 or 960x720, at 15 fps or 60 fps, yields the same numbers,
// because the ball is the ruler and seconds are the clock. Pixel-space and
// per-frame constants are what make a detector silently resolution- and
// cadence-dependent, so there are none left in the event rules.
//
// Unit key:  d  = ball diameters        d/s = ball diameters per second
//            ms = milliseconds          —   = dimensionless ratio
export const EVENT_RULES = Object.freeze({
  // unit ms — §21 refractory. Two contacts closer together in TIME than this
  // are one contact observed twice. Milliseconds, never frames (§6), so the
  // rule means the same thing at every cadence.
  touchRefractoryMs: 180,
  juggleRefractoryMs: 300,

  // unit d — a juggle contact must be followed by a flight clearing this
  // many ball diameters, measured relative to the player. Stops a ball
  // resting on the ground with detector jitter producing counts.
  juggleMinFlightDiameters: 0.9,

  // unit d/s — a touch is an impulse: the ball's velocity vector, in the
  // player's frame of reference, must change by at least this much.
  touchMinImpulseDiametersPerSec: 4.5,

  // unit d — contact range between ball centroid and the nearest edge of the
  // player region. Beyond this the ball moved without anyone touching it.
  touchMaxContactDiameters: 5.5,

  // unit d — the ball must actually MOVE this far away from the player after
  // a contact before another contact can be counted. This is the spatial
  // half of the debounce (§6): the refractory timer alone cannot stop a ball
  // resting against a foot from re-triggering, because time keeps passing.
  touchMinSeparationDiameters: 1.2,

  // unit frames — the ball may be undetected for this many consecutive
  // frames and the track survives. Frame-based because it describes the
  // TRACKER's tolerance for missing observations, not a physical duration;
  // the physical limit is maxBallGapMs below and both apply.
  maxBallGapFrames: 4,
  // unit ms — the physical occlusion limit, cadence-independent.
  maxBallGapMs: 400,

  // unit — fraction of the attempt the ball may be missing in total.
  maxBallMissingFrac: 0.25,

  // unit — a rival blob this close in size to the primary is a second ball.
  secondBallMinAreaRatio: 0.6,
});
// ---------------------------------------------------------- confidence
//
// §19: this is MODEL CERTAINTY about an observation. It is never rendered as
// a football-quality figure, and `refusedConfidenceFields()` below exists to
// make that failure mode loud rather than subtle.
export const CONFIDENCE = Object.freeze({
  // Below this aggregate confidence the attempt is refused rather than
  // reported. §62: prefer refusal over false verification.
  minAcceptable: 0.62,
  // A single event below this does not count toward the total.
  minPerEvent: 0.5,
  // The fraction of frames in which the ball had to be detected with usable
  // confidence for the observation to be considered complete.
  minDetectionCoverage: 0.7,
});

// ------------------------------------------------------------- outcomes
//
// §20. `accepted` is one value among many, and deliberately not the default.
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
]);

// Reader-facing sentences. §94/§95: a refusal describes the OBSERVATION,
// never the player. "Could not verify", never "you failed".
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
});

// §67 provider health.
export const PROVIDER_HEALTH = Object.freeze([
  'not_configured', 'configured', 'warming', 'ready', 'degraded', 'unavailable',
]);

// ------------------------------------------------- client-supplied fields
//
// §22/§A4: the client may supply FRAMES. It may not supply a measurement.
// These names are refused BY NAME rather than ignored, so that an attempt to
// self-report is a loud 422 in a log rather than a silent no-op that someone
// later mistakes for acceptance.
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

// §19 again, from the other direction: confidence must never be rendered as
// a player-quality value. The suite scans copy for these shapes.
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
// §3: the smallest set that can be made genuinely reliable. Presence in this
// list means "the engine has a documented rule for it", NOT "it is enabled
// in production". Enablement is decided by measured evaluation in gate.mjs.
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

// The capabilities this engine can genuinely offer when it is healthy.
// `rep_count` appears here because the engine HAS a counting rule; whether
// any protocol may USE it in production is the gate's decision, not this
// list's (§129).
export const ENGINE_CAPABILITIES = Object.freeze([
  'player_presence', 'ball_presence', 'active_motion', 'active_duration', 'rep_count',
]);

// Capabilities the engine explicitly does NOT have, stated so that nothing
// silently assumes them (§12).
export const ENGINE_NON_CAPABILITIES = Object.freeze({
  foot_classification: 'Which foot touched the ball is not observed. No limb classification is attempted.',
  technique_signals: 'No technique judgement of any kind is produced.',
  interval_completion: 'Work/rest interval structure is not observed.',
  timing_gate: 'No timing gate exists. Sprint and agility protocols remain unsupported.',
  spatial_scale: 'No real-world distance is derived from camera geometry (§56). Jump and distance protocols remain unsupported.',
  target_zone: 'No target-zone geometry is observed.',
});

Object.freeze(FRAME_LIMITS);
