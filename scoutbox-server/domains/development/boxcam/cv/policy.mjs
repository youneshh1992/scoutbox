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

// The engine's own version. v2 = the robustness fix pack: three-layer split,
// contact state machine, normalised units, quality gate, refusal precedence.
// Event semantics changed materially, so the version moves (§55) rather than
// pretending one version produced two behaviours. BOX_CAM_CV_POLICY_VERSION
// stays at 1: version 1 encompasses pre-release development of this policy,
// and no released result exists under it.
// Bumped whenever a rule changes in a way that
// could change a count. A stored result keeps the version that produced it —
// history is never re-derived under a new engine (§46).
export const CV_ENGINE_VERSION = 2;

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
  // unit — jitter band on the per-interval cadence test. An interval counts
  // as "low" only if it is more than 15% longer than the nominal minimum.
  // Without this band a capture held at exactly minSustainedFps is condemned
  // by millisecond timestamp rounding alone: 12 fps is an 83.33 ms interval,
  // integer timestamps alternate 83/84 ms, and every 84 reads as 11.9 fps.
  // Real cadence loss is a sustained gap, not a rounding artefact.
  lowFpsIntervalTolerance: 1.15,
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

  // unit d — contact range: distance from the ball centroid to the NEAREST
  // EDGE of the player region. Contact means touching, so this is about one
  // ball width, allowing for the silhouette's imprecision.
  //
  // An earlier cut used 5.5, inherited from an arbitrary frame-diagonal
  // fraction and never justified physically. At five ball-widths a ball
  // bouncing on its own across the room counts as "in contact with the
  // player", and the false-touch suite duly scored nine touches on a ball
  // nobody went near. Contact range is not "somewhere in the same scene".
  touchMaxContactDiameters: 1.2,

  // unit d — the ball must be DISPLACED this far from where it was last
  // struck before another contact can be counted. This is the spatial half
  // of the debounce (§6): the refractory timer alone cannot stop a ball
  // resting against a foot from re-triggering, because time keeps passing.
  //
  // The value is a fraction of a ball width because that is what a ball
  // mastery touch physically does — a toe-tap nudges the ball a little, it
  // does not send it a ball-and-a-bit away. An earlier cut used 1.2, chosen
  // with no physical justification, and it silently suppressed genuine
  // touches at anything above a slow pace: the ball never travelled far
  // enough to "separate", so the state machine latched after the first
  // contact and a 14-touch attempt counted 1.
  //
  // Lowering a debounce is exactly the move §56 warns about, so it is
  // justified against measurement rather than convenience: with this value
  // the 20-case false-touch stress suite must remain at ZERO false touches.
  // If it ever does not, this number is wrong again and the answer is to
  // narrow supported pace, not to raise it back and lose real touches.
  touchMinSeparationDiameters: 0.35,

  // unit ms — the ball must have been continuously within contact range for
  // at least this long before an impulse can be read as a contact. A real
  // approach is continuous: the ball arrives, it does not materialise. A ball
  // that is far away and then adjacent for two frames has jumped, and the
  // apparent velocity change on arrival is a detector artefact, not a strike.
  touchMinApproachMs: 120,

  // --- gap policy (§23) -------------------------------------------------
  // A SHORT gap may be bridged: the track survives and the count stays exact.
  // A LONG gap may not: continuity is broken, and an exact measurement is
  // refused rather than interpolated across the missing evidence.
  //
  // Both limits apply, because they describe different things. The frame
  // count is the TRACKER's tolerance for consecutive missing observations;
  // the millisecond limit is the physical one and is cadence-independent, so
  // four dropped frames at 30 fps (133 ms) and four at 8 fps (500 ms) are not
  // treated as the same event.
  maxRecoverableMissingFrames: 4,
  maxRecoverableFrameGapMs: 400,
  // Retained names, same values — read by existing call sites.
  maxBallGapFrames: 4,
  maxBallGapMs: 400,

  // --- supported cadence envelope (§29) ---------------------------------
  // Measured, not aspired to: the engine counts within tolerance down to
  // 340 ms between touches and under-counts at 260 ms. Anything faster is
  // outside the validated envelope and must not be certified as exact.
  minimumSupportedTouchIntervalMs: 340,
  // unit — fraction of contact-range impulses that may be suppressed by the
  // refractory window before the attempt is judged to be running faster than
  // the engine can resolve. Derived from OBSERVATION (impulses the tracker
  // saw and the protocol layer had to discard), never from a player-reported
  // count and never from the number of touches finally emitted.
  maxRefractorySuppressedFrac: 0.25,

  // unit — fraction of the attempt the ball may be missing in total.
  maxBallMissingFrac: 0.25,

  // unit — a rival blob this close in size to the primary is a second ball.
  secondBallMinAreaRatio: 0.6,

  // unit — the largest per-sample change in the apparent size of the player
  // region that can be treated as the SAME frame of reference continuing.
  //
  // This value is derived, not chosen. Motion is measured in the player's
  // frame, so when the whole image scales by a factor s between two samples,
  // the player-relative position of a completely stationary ball appears to
  // change by (s-1) * |rel|. Expressed in the units the protocol layer
  // actually thresholds, that is a fabricated velocity of
  //
  //     (s - 1) * (|rel| / d) / dt      diameters per second
  //
  // The budget: it must stay below `touchMinImpulseDiametersPerSec` (4.5) at
  // the worst case, which is the highest supported cadence (30 fps, dt = 1/30)
  // and a ball at the far side of its working range from the player centre.
  // Measured across the fixture set, |rel| / d runs to about 3.5 diameters
  // there. So
  //
  //     (s - 1) * 3.5 * 30 < 4.5   =>   s - 1 < 0.043
  //
  // and 0.04 is that bound rounded down. The floor underneath it is detector
  // noise: the player region is hundreds of pixels tall even in the smallest
  // supported frame, so a one-pixel edge wobble is about 1.1%. The threshold
  // therefore sits between a 1% noise floor and a 4.3% danger point, which is
  // why it is stable rather than lucky.
  //
  // This replaced a 1.4x test, and the replacement is the whole point. 1.4x
  // asked "is this a different person?" — an identity question. The question
  // that matters for counting is "did the frame of reference move enough to
  // fabricate an impulse?", and the answer to that is thirty times smaller.
  // A holdout case found the gap: an 18% zoom sailed under the identity test
  // and manufactured a touch.
  maxFrameScaleStepPerSample: 0.04,
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
  'unsupported_event_cadence',
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
  unsupported_event_cadence: 'Could not verify this attempt — the touches came faster than ScoutBox can reliably count, so no exact result was produced.',
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
