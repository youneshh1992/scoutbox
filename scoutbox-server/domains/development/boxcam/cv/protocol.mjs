// M22 — LAYER 3: PROTOCOL INTERPRETATION (§25, §26).
//
//   input:  tracked observations (normalised: ball diameters, seconds)
//   output: touch events, juggle events, protocol violations
//
// Box Touch and Box Juggle semantics live HERE and nowhere else. Neither the
// detector nor the tracker contains `if (protocol === 'box_touch_60')`; they
// cannot, because neither is passed a protocol id.
//
// -------------------------------------------------------------------------
// THE CONTACT STATE MACHINE (§5)
//
// A touch is NOT a threshold comparison evaluated independently per frame.
// That design lets sustained proximity increment a counter forever, which is
// exactly the gaming vector §8 and §11 of the fix pack describe. Instead one
// physical contact walks a machine, and the machine can only emit once per
// traversal:
//
//     READY ──ball enters contact range──▶ APPROACHING
//       ▲                                      │
//       │                             impulse over threshold
//       │                                      ▼
//       │                              CONTACT_CANDIDATE
//       │                                      │
//       │                    still in range, impulse sustained/consistent
//       │                                      ▼
//       │                              CONTACT_CONFIRMED ──emit exactly one event
//       │                                      │
//       │                       ball moves away by minSeparation
//       │                                      ▼
//       │                                 SEPARATING
//       │                                      │
//       │                        refractoryMs elapsed since emit
//       │                                      ▼
//       └──────────────────────────────── REFRACTORY
//
// Properties this buys, each of which is a named regression:
//   * prolonged contact counts once — the machine sits in CONFIRMED and
//     cannot re-emit without passing through SEPARATING first;
//   * rapid legitimate touches stay distinct — separation is spatial, so a
//     genuinely re-struck ball leaves and returns and traverses again;
//   * a dropped frame around contact cannot double-count — re-entry to
//     APPROACHING requires an observed separation, not merely a gap.

import { EVENT_RULES } from './policy.mjs';

export const CONTACT_STATES = Object.freeze([
  'READY', 'APPROACHING', 'CONTACT_CANDIDATE', 'CONTACT_CONFIRMED', 'SEPARATING', 'REFRACTORY',
]);

/**
 * Box Touch: discrete ball-contact events.
 *
 * `motion` is the normalised stream from Layer 2. Everything below is in
 * ball diameters and seconds; there is not a pixel in this function.
 */
export function interpretTouches(motion, {
  refractoryMs = EVENT_RULES.touchRefractoryMs,
  minImpulse = EVENT_RULES.touchMinImpulseDiametersPerSec,
  maxContact = EVENT_RULES.touchMaxContactDiameters,
  minSeparation = EVENT_RULES.touchMinSeparationDiameters,
  maxGapMs = EVENT_RULES.maxBallGapMs,
  minApproachMs = EVENT_RULES.touchMinApproachMs,
} = {}) {
  const events = [];
  const transitions = [];
  // When the ball most recently entered contact range, so that a contact can
  // require a continuous approach rather than a sudden appearance.
  let inRangeSinceMs = null;
  let prevInRange = false;
  let state = 'READY';
  let lastEmitMs = -Infinity;
  let ambiguousIntervals = 0;
  // Contact-range impulses the refractory window had to discard. This is the
  // honest signal for §30: if the engine keeps seeing strikes it is not
  // allowed to count, the activity is running faster than it can resolve.
  // Derived from what the tracker OBSERVED, never from a player-reported
  // number and never from the count finally emitted.
  let suppressedByRefractory = 0;
  // Where the ball was, in the player's frame, at the moment of the last
  // confirmed contact. Separation is measured from HERE, not from the
  // player: in Box Touch the ball stays at the foot for the whole attempt,
  // so distance-from-player never grows and the machine would latch after a
  // single event. What actually distinguishes two touches is that the ball
  // was displaced from where it was last struck and then struck again.
  let contactAt = null;

  const go = (next, at, why) => {
    if (next !== state) {
      transitions.push({ atMs: at, from: state, to: next, why });
      state = next;
    }
  };

  for (const m of motion) {
    // A sample whose neighbours are separated by a long gap cannot support a
    // contact decision: the velocity either side is not comparable. The
    // machine drops to READY and the interval is recorded as ambiguous,
    // which the quality layer later counts against continuity (§13, §15).
    if (m.gapBeforeMs > maxGapMs || m.gapAfterMs > maxGapMs) {
      ambiguousIntervals += 1;
      go('READY', m.atMs, 'observation_gap');
      continue;
    }
    // A ball touching the frame edge has an unreliable centroid.
    if (m.edgeDiameters < 0.5) {
      go('READY', m.atMs, 'ball_at_frame_edge');
      continue;
    }
    // The player frame of reference moved discontinuously here, so the
    // relative velocities across this triple describe the detector changing
    // its mind about the silhouette, not the ball being struck.
    if (m.frameJump) {
      ambiguousIntervals += 1;
      go('READY', m.atMs, 'player_region_discontinuity');
      continue;
    }

    const inRange = m.distDiameters <= maxContact;
    // Dwell clock: starts when the ball ENTERS contact range and runs until
    // it leaves. It is deliberately independent of the machine's state — a
    // ball resting at the foot through several taps never leaves range, so
    // its approach is never in question and the clock must not restart.
    if (inRange && !prevInRange) inRangeSinceMs = m.atMs;
    if (!inRange) inRangeSinceMs = null;
    prevInRange = inRange;
    const impulsive = m.impulseDiametersPerSec >= minImpulse;
    // Displacement from the last struck position, in ball diameters — OR
    // leaving contact range altogether, which is separation by any measure.
    const movedAway = contactAt
      ? Math.hypot(m.relX - contactAt.x, m.relY - contactAt.y) > minSeparation
      : false;
    const separated = movedAway || m.distDiameters > maxContact + minSeparation;

    // The machine may need to traverse SEVERAL states within one sample:
    // after a contact it passes CONFIRMED → SEPARATING → REFRACTORY → READY →
    // APPROACHING, and if each of those consumed a sample, the effective
    // refractory would be the declared one PLUS four frame intervals — a
    // latency that varies with cadence and silently lengthens the debounce at
    // low frame rates. That is exactly the frame-rate dependence the
    // normalised units exist to eliminate, so transitions are allowed to
    // settle within the sample, bounded so a cycle cannot spin.
    let steps = 0;
    let settled = false;
    while (!settled && steps < CONTACT_STATES.length + 1) {
      steps += 1;
      const before = state;
      step();
      if (state === before) settled = true;
    }
    // eslint-disable-next-line no-inner-declarations
    function step() {
    switch (state) {
      case 'READY':
        if (inRange) go('APPROACHING', m.atMs, 'entered_contact_range');
        break;

      case 'APPROACHING':
        if (!inRange) { go('READY', m.atMs, 'left_range_without_contact'); break; }
        if (!impulsive) break;
        // A continuous approach is required. Without it, a ball that is
        // distant and then adjacent for a frame or two registers a contact on
        // the apparent velocity of its own arrival.
        if (inRangeSinceMs == null || m.atMs - inRangeSinceMs < minApproachMs) break;
        // The contact IS this sample: an impulse delivered while the ball is
        // within contact range. Candidate and confirmation therefore resolve
        // in the same iteration, and the event is stamped and scored here.
        //
        // An earlier cut waited one more sample before confirming AND
        // required the ball still to be adjacent then. That is backwards — a
        // struck ball is leaving. It dropped nearly every genuine touch, and
        // the counts fell as pace rose, because a faster touch clears contact
        // range sooner. The confidence fix that preceded this one (carrying
        // the impulsive sample forward) treated the symptom; the wait itself
        // was the defect.
        go('CONTACT_CANDIDATE', m.atMs, 'impulse_detected');
        if (m.atMs - lastEmitMs < refractoryMs) {
          // Temporal half of the debounce: too soon after the last contact to
          // be a separate one. Occupy CONFIRMED so it cannot re-trigger, and
          // emit nothing.
          suppressedByRefractory += 1;
          go('CONTACT_CONFIRMED', m.atMs, 'suppressed_within_refractory');
          break;
        }
        go('CONTACT_CONFIRMED', m.atMs, 'contact_confirmed');
        contactAt = { x: m.relX, y: m.relY };
        events.push({
          atMs: m.atMs,
          confidence: Math.min(1,
            m.confidence * 0.7
            + Math.min(1, m.impulseDiametersPerSec / (minImpulse * 3)) * 0.2
            + (1 - Math.min(1, m.distDiameters / maxContact)) * 0.1),
        });
        lastEmitMs = m.atMs;
        break;

      case 'CONTACT_CANDIDATE':
        // Retained for trace completeness; the machine passes straight
        // through it within a single iteration.
        go('CONTACT_CONFIRMED', m.atMs, 'contact_confirmed');
        break;

      case 'CONTACT_CONFIRMED':
        // Sustained contact stays here. It cannot emit again: the only way
        // out is an observed displacement from the struck position.
        //
        if (separated || !inRange) go('SEPARATING', m.atMs, 'ball_separated');
        break;

      case 'SEPARATING':
        // NOT counted here, and the reason is a real limitation rather than
        // an oversight (§31).
        //
        // `impulsive` is a velocity CHANGE threshold, and friction
        // deceleration immediately after a legitimate strike produces a
        // change of the same magnitude when sampled at video rates. Counting
        // impulses in this state therefore counts the decaying tail of every
        // genuine touch, and a perfectly valid attempt condemns itself as
        // running too fast — which is exactly what happened when it was
        // tried. There is no reliable way to separate "a new strike arriving
        // too soon" from "the previous strike still decaying" with this
        // detector, so the engine does not pretend to.
        //
        // Consequence, stated plainly: over-cadence detection is PARTIAL. It
        // fires when the machine has re-armed and a blocked strike reaches
        // APPROACHING, and it misses over-cadence activity that arrives while
        // the machine is still separating. That limitation is recorded in
        // M22_CV_EVALUATION.md and is one more reason the production gate
        // stays closed for exact Box Touch measurement.
        if (m.atMs - lastEmitMs >= refractoryMs) go('REFRACTORY', m.atMs, 'refractory_elapsed');
        break;

      case 'REFRACTORY':
        go('READY', m.atMs, 'ready_again');
        break;

      default:
        go('READY', m.atMs, 'unknown_state');
    }
    }
  }

  return { events, transitions, finalState: state, ambiguousIntervals, suppressedByRefractory };
}

/**
 * Box Juggle: contact → flight → contact.
 *
 * A juggle contact is a REVERSAL of vertical motion in the player's frame,
 * followed by a flight clearing `minFlight` ball diameters. Explicitly NOT
 * peak counting (§23): a peak is the top of a flight, and counting peaks
 * conflates apex with contact and double-counts a bouncing ball.
 */
export function interpretJuggles(motion, {
  refractoryMs = EVENT_RULES.juggleRefractoryMs,
  minFlight = EVENT_RULES.juggleMinFlightDiameters,
  maxGapMs = EVENT_RULES.maxBallGapMs,
} = {}) {
  const events = [];
  let lastEmitMs = -Infinity;
  let ambiguousIntervals = 0;

  for (let i = 1; i < motion.length - 1; i += 1) {
    const a = motion[i - 1], b = motion[i], c = motion[i + 1];
    if (b.gapBeforeMs > maxGapMs || b.gapAfterMs > maxGapMs) { ambiguousIntervals += 1; continue; }
    if (b.frameJump) { ambiguousIntervals += 1; continue; }
    // y grows downward: falling in, rising out.
    const fallingIn = b.relHeightDiameters > a.relHeightDiameters;
    const risingOut = c.relHeightDiameters < b.relHeightDiameters;
    if (!(fallingIn && risingOut)) continue;
    if (b.atMs - lastEmitMs < refractoryMs) continue;
    // Measure the flight that follows, in ball diameters.
    let apex = b.relHeightDiameters;
    for (let j = i + 1; j < motion.length; j += 1) {
      if (motion[j].relHeightDiameters > motion[j - 1].relHeightDiameters) break;
      apex = Math.min(apex, motion[j].relHeightDiameters);
    }
    const flight = b.relHeightDiameters - apex;
    if (flight < minFlight) continue;
    lastEmitMs = b.atMs;
    events.push({
      atMs: b.atMs,
      confidence: Math.min(1, b.confidence * 0.75 + Math.min(1, flight / (minFlight * 3)) * 0.25),
    });
  }
  return { events, transitions: [], finalState: 'READY', ambiguousIntervals, suppressedByRefractory: 0 };
}

/** Dispatch by event kind. The ONLY place protocol identity is consulted. */
export function interpret(eventKind, motion, opts = {}) {
  if (eventKind === 'touch') return interpretTouches(motion, opts);
  if (eventKind === 'juggle') return interpretJuggles(motion, opts);
  return { events: [], transitions: [], finalState: 'READY', ambiguousIntervals: 0, suppressedByRefractory: 0 };
}
