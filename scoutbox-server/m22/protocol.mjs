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
} = {}) {
  const events = [];
  const transitions = [];
  let state = 'READY';
  let lastEmitMs = -Infinity;
  let ambiguousIntervals = 0;
  // The sample that actually carried the contact impulse.
  let candidate = null;
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

    const inRange = m.distDiameters <= maxContact;
    const impulsive = m.impulseDiametersPerSec >= minImpulse;
    // Displacement from the last struck position, in ball diameters — OR
    // leaving contact range altogether, which is separation by any measure.
    const movedAway = contactAt
      ? Math.hypot(m.relX - contactAt.x, m.relY - contactAt.y) > minSeparation
      : false;
    const separated = movedAway || m.distDiameters > maxContact + minSeparation;

    switch (state) {
      case 'READY':
        if (inRange) go('APPROACHING', m.atMs, 'entered_contact_range');
        break;

      case 'APPROACHING':
        if (!inRange) { go('READY', m.atMs, 'left_range_without_contact'); break; }
        if (impulsive) {
          // Remember THIS sample. The machine confirms on the next
          // iteration, so without capturing the impulsive sample here the
          // event would be stamped — and scored — from the sample after the
          // contact, where the impulse has already decayed. That understated
          // every genuine touch's confidence and put the event a frame late.
          candidate = m;
          go('CONTACT_CANDIDATE', m.atMs, 'impulse_detected');
        }
        break;

      case 'CONTACT_CANDIDATE':
        if (!inRange) { go('READY', m.atMs, 'candidate_left_range'); break; }
        // Confirm only if the refractory window has genuinely elapsed. This
        // is the TEMPORAL half of the debounce; the spatial half is the
        // SEPARATING transition below. Both are required.
        if (m.atMs - lastEmitMs < refractoryMs) {
          go('CONTACT_CONFIRMED', m.atMs, 'suppressed_within_refractory');
          break;
        }
        {
          const k = candidate ?? m;          // the contact, not its successor
          go('CONTACT_CONFIRMED', m.atMs, 'contact_confirmed');
          contactAt = { x: k.relX, y: k.relY };
          events.push({
            atMs: k.atMs,
            confidence: Math.min(1,
              k.confidence * 0.7
              + Math.min(1, k.impulseDiametersPerSec / (minImpulse * 3)) * 0.2
              + (1 - Math.min(1, k.distDiameters / maxContact)) * 0.1),
          });
          lastEmitMs = k.atMs;
          candidate = null;
        }
        break;

      case 'CONTACT_CONFIRMED':
        // Sustained contact stays here. It cannot emit again: the only way
        // out is an observed displacement from the struck position.
        if (separated) go('SEPARATING', m.atMs, 'ball_separated');
        break;

      case 'SEPARATING':
        if (m.atMs - lastEmitMs >= refractoryMs) go('REFRACTORY', m.atMs, 'refractory_elapsed');
        break;

      case 'REFRACTORY':
        go('READY', m.atMs, 'ready_again');
        if (m.distDiameters <= maxContact) go('APPROACHING', m.atMs, 'entered_contact_range');
        break;

      default:
        go('READY', m.atMs, 'unknown_state');
    }
  }

  return { events, transitions, finalState: state, ambiguousIntervals };
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
  return { events, transitions: [], finalState: 'READY', ambiguousIntervals };
}

/** Dispatch by event kind. The ONLY place protocol identity is consulted. */
export function interpret(eventKind, motion, opts = {}) {
  if (eventKind === 'touch') return interpretTouches(motion, opts);
  if (eventKind === 'juggle') return interpretJuggles(motion, opts);
  return { events: [], transitions: [], finalState: 'READY', ambiguousIntervals: 0 };
}
