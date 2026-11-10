// Layer 3: tracked observations (ball diameters, seconds) in; touch and juggle events out. The only layer that
// knows protocol semantics.
//
// A touch is not a per-frame threshold, which would let sustained proximity count forever. One physical contact
// walks this machine, which emits once per traversal:
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
// So prolonged contact counts once, rapid touches stay distinct (separation is spatial), and a dropped frame can't
// double-count (re-entry needs an observed separation, not a gap).

import { EVENT_RULES } from './policy.mjs';

export const CONTACT_STATES = Object.freeze([
  'READY',
  'APPROACHING',
  'CONTACT_CANDIDATE',
  'CONTACT_CONFIRMED',
  'SEPARATING',
  'REFRACTORY',
]);

/** Box Touch. `motion` is Layer 2's normalised stream: ball diameters and seconds, no pixels. */
export function interpretTouches(
  motion,
  {
    refractoryMs = EVENT_RULES.touchRefractoryMs,
    minImpulse = EVENT_RULES.touchMinImpulseDiametersPerSec,
    maxContact = EVENT_RULES.touchMaxContactDiameters,
    minSeparation = EVENT_RULES.touchMinSeparationDiameters,
    maxGapMs = EVENT_RULES.maxBallGapMs,
    minApproachMs = EVENT_RULES.touchMinApproachMs,
  } = {},
) {
  const events = [];
  const transitions = [];
  // So a contact can require a continuous approach rather than a sudden appearance.
  let inRangeSinceMs = null;
  let prevInRange = false;
  let state = 'READY';
  let lastEmitMs = -Infinity;
  let ambiguousIntervals = 0;
  // Impulses the refractory window discarded: the over-cadence signal, from what the tracker observed.
  let suppressedByRefractory = 0;
  // Separation is measured from the last struck position, not the player: in Box Touch the ball stays at the foot, so
  // distance from the player never grows and the machine would latch after one event.
  let contactAt = null;

  const go = (next, at, why) => {
    if (next !== state) {
      transitions.push({ atMs: at, from: state, to: next, why });
      state = next;
    }
  };

  for (const m of motion) {
    // Across a long gap the velocities either side aren't comparable: drop to READY and record the interval as
    // ambiguous, which counts against continuity.
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
    // The player frame jumped: these relative velocities describe the silhouette changing, not a strike.
    if (m.frameJump) {
      ambiguousIntervals += 1;
      go('READY', m.atMs, 'player_region_discontinuity');
      continue;
    }

    const inRange = m.distDiameters <= maxContact;
    // Dwell clock: independent of machine state, because a ball resting at the foot through several taps never leaves
    // range and the clock must not restart.
    if (inRange && !prevInRange) inRangeSinceMs = m.atMs;
    if (!inRange) inRangeSinceMs = null;
    prevInRange = inRange;
    const impulsive = m.impulseDiametersPerSec >= minImpulse;
    // Displaced from the last struck position, or out of contact range altogether.
    const movedAway = contactAt ? Math.hypot(m.relX - contactAt.x, m.relY - contactAt.y) > minSeparation : false;
    const separated = movedAway || m.distDiameters > maxContact + minSeparation;

    // Transitions settle within one sample (bounded, so a cycle cannot spin). If each consumed a sample, the refractory
    // would grow by four frame intervals, a cadence-dependent debounce.
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
          if (!inRange) {
            go('READY', m.atMs, 'left_range_without_contact');
            break;
          }
          if (!impulsive) break;
          // Without a continuous approach, a ball that jumps adjacent registers a contact on its own arrival velocity.
          if (inRangeSinceMs == null || m.atMs - inRangeSinceMs < minApproachMs) break;
          // The contact is this sample, so candidate and confirmation resolve together. Confirming a sample later, with the
          // ball still adjacent, drops genuine touches: a struck ball is leaving, and faster touches leave sooner.
          go('CONTACT_CANDIDATE', m.atMs, 'impulse_detected');
          if (m.atMs - lastEmitMs < refractoryMs) {
            // Temporal half of the debounce: too soon to be separate. Occupy CONFIRMED so it can't re-trigger.
            suppressedByRefractory += 1;
            go('CONTACT_CONFIRMED', m.atMs, 'suppressed_within_refractory');
            break;
          }
          go('CONTACT_CONFIRMED', m.atMs, 'contact_confirmed');
          contactAt = { x: m.relX, y: m.relY };
          events.push({
            atMs: m.atMs,
            confidence: Math.min(
              1,
              m.confidence * 0.7 +
                Math.min(1, m.impulseDiametersPerSec / (minImpulse * 3)) * 0.2 +
                (1 - Math.min(1, m.distDiameters / maxContact)) * 0.1,
            ),
          });
          lastEmitMs = m.atMs;
          break;

        case 'CONTACT_CANDIDATE':
          // Passed through within one iteration; kept for the trace.
          go('CONTACT_CONFIRMED', m.atMs, 'contact_confirmed');
          break;

        case 'CONTACT_CONFIRMED':
          // Sustained contact stays here; the only way out is displacement from the struck position.
          if (separated || !inRange) go('SEPARATING', m.atMs, 'ball_separated');
          break;

        case 'SEPARATING':
          // Impulses aren't counted as suppressed here: friction just after a strike changes velocity as much as a new
          // strike, so every touch's tail would count. Over-cadence detection is therefore partial (it misses strikes while
          // separating), one more reason the gate stays closed for exact Box Touch.
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
 * Box Juggle: a reversal of vertical motion in the player's frame followed by a flight of `minFlight` diameters. Not
 * peak counting, which conflates apex with contact and double-counts a bouncing ball.
 */
export function interpretJuggles(
  motion,
  {
    refractoryMs = EVENT_RULES.juggleRefractoryMs,
    minFlight = EVENT_RULES.juggleMinFlightDiameters,
    maxGapMs = EVENT_RULES.maxBallGapMs,
  } = {},
) {
  const events = [];
  let lastEmitMs = -Infinity;
  let ambiguousIntervals = 0;

  for (let i = 1; i < motion.length - 1; i += 1) {
    const a = motion[i - 1],
      b = motion[i],
      c = motion[i + 1];
    if (b.gapBeforeMs > maxGapMs || b.gapAfterMs > maxGapMs) {
      ambiguousIntervals += 1;
      continue;
    }
    if (b.frameJump) {
      ambiguousIntervals += 1;
      continue;
    }
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

/** The only place protocol identity is consulted. */
export function interpret(eventKind, motion, opts = {}) {
  if (eventKind === 'touch') return interpretTouches(motion, opts);
  if (eventKind === 'juggle') return interpretJuggles(motion, opts);
  return { events: [], transitions: [], finalState: 'READY', ambiguousIntervals: 0, suppressedByRefractory: 0 };
}
