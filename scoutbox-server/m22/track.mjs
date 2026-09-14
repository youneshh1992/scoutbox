// M22 — LAYER 2: TRACKING (§24, §26).
//
//   input:  detections + trusted timestamps
//   output: ball track, person track, player-relative motion, continuity,
//           occlusion state
//
// No protocol-specific scoring happens here. This layer does not know what a
// touch is. It knows where things were, when, how reliably, and how long the
// gaps were.
//
// The one idea that makes the rest of M22 scale-free lives here: every
// spatial quantity is emitted in BALL DIAMETERS and every velocity in ball
// diameters per second. A scene at twice the resolution has a ball twice as
// wide, so the normalised numbers are identical — and a scene at four times
// the frame rate has quarter-length intervals, so the per-second numbers are
// identical too.

import { EVENT_RULES, CAPTURE_REQUIREMENTS } from './policy.mjs';

/**
 * Build tracks from a detection stream.
 *
 * Pure: same detections in, same tracks out. No clock, no randomness, no
 * module-level state — which is what makes session isolation structural
 * rather than a discipline someone has to remember (§11, §75).
 */
export function buildTracks(detections) {
  const samples = [];
  let lastDiameter = null;
  let lastPerson = null;
  let gapFrames = 0, maxGapFrames = 0;
  let gapStartMs = null, maxGapMs = 0;
  let resets = 0;

  for (const d of detections) {
    if (d.ball) {
      // A sudden implausible change in apparent ball size means we are no
      // longer tracking the same object; the track resets rather than
      // silently continuing with a different referent.
      if (lastDiameter && (d.ball.diameter > lastDiameter * 2.2 || d.ball.diameter < lastDiameter / 2.2)) {
        resets += 1;
      }
      lastDiameter = d.ball.diameter;
      if (gapStartMs != null) {
        maxGapMs = Math.max(maxGapMs, d.atMs - gapStartMs);
        gapStartMs = null;
      }
      gapFrames = 0;
    } else {
      gapFrames += 1;
      maxGapFrames = Math.max(maxGapFrames, gapFrames);
      if (gapStartMs == null) gapStartMs = d.atMs;
    }

    const person = d.person ?? null;
    const ball = d.ball ?? null;
    // A person region that jumps in size or position between frames is not
    // the same observation continued — it is a new one. Because motion is
    // measured in the player's frame, an unflagged jump shifts that frame and
    // reads as the BALL moving. Flag it so the protocol layer can drop the
    // affected samples rather than interpret them as a contact.
    let personJump = false;
    if (person && lastPerson) {
      const wPrev = lastPerson.x1 - lastPerson.x0, hPrev = lastPerson.y1 - lastPerson.y0;
      const wNow = person.x1 - person.x0, hNow = person.y1 - person.y0;
      const cPrev = { x: (lastPerson.x0 + lastPerson.x1) / 2, y: (lastPerson.y0 + lastPerson.y1) / 2 };
      const cNow = { x: (person.x0 + person.x1) / 2, y: (person.y0 + person.y1) / 2 };
      const scaleJump = wNow > wPrev * 1.4 || wNow < wPrev / 1.4 || hNow > hPrev * 1.4 || hNow < hPrev / 1.4;
      const shiftJump = Math.hypot(cNow.x - cPrev.x, cNow.y - cPrev.y) > Math.max(wPrev, 1) * 0.5;
      personJump = scaleJump || shiftJump;
      if (personJump) resets += 1;
    }
    if (person) lastPerson = person;
    // Player-relative position: cancels rigid camera motion, because the
    // ball and the player move together when the camera does.
    const rel = (ball && person)
      ? { x: ball.x - (person.x0 + person.x1) / 2, y: ball.y - (person.y0 + person.y1) / 2 }
      : null;

    samples.push({
      seq: d.seq, atMs: d.atMs, w: d.w, h: d.h,
      ball, person, rel,
      rivals: d.rivals ?? 0,
      personJump,
      usable: d.visibility.usable,
      visibilityReason: d.visibility.reason,
      interFrameDiff: d.interFrameDiff,
      diameter: ball ? ball.diameter : lastDiameter,
    });
  }
  if (gapStartMs != null && samples.length) {
    maxGapMs = Math.max(maxGapMs, samples[samples.length - 1].atMs - gapStartMs);
  }

  const withBall = samples.filter((s) => s.ball);
  const withPerson = samples.filter((s) => s.person);
  const withBoth = samples.filter((s) => s.ball && s.person);
  const n = samples.length || 1;

  // Cadence, measured from the trusted timestamps rather than assumed. §22
  // of the fix pack: input is never assumed to be perfectly periodic.
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) intervals.push(samples[i].atMs - samples[i - 1].atMs);
  const medianIntervalMs = median(intervals);
  const effectiveFps = medianIntervalMs > 0 ? 1000 / medianIntervalMs : 0;
  // An interval is "low" only if it exceeds the nominal minimum-cadence
  // interval by more than the documented jitter band (see policy).
  const lowIntervalMs = (1000 / CAPTURE_REQUIREMENTS.minSustainedFps)
    * CAPTURE_REQUIREMENTS.lowFpsIntervalTolerance;
  const lowFpsIntervals = intervals.filter((iv) => iv > lowIntervalMs).length;

  // Active duration counts only spans where BOTH were visible at both ends.
  let activeMs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1], b = samples[i];
    if (a.ball && a.person && b.ball && b.person) activeMs += Math.max(0, b.atMs - a.atMs);
  }

  return {
    samples,
    continuity: {
      frames: samples.length,
      ballFrames: withBall.length,
      personFrames: withPerson.length,
      bothFrames: withBoth.length,
      ballCoverage: withBall.length / n,
      personCoverage: withPerson.length / n,
      maxGapFrames,
      maxGapMs,
      trackResets: resets,
      rivalBallFrames: samples.filter((s) => s.rivals > 0).length,
      unusableFrames: samples.filter((s) => !s.usable).length,
    },
    cadence: {
      medianIntervalMs,
      effectiveFps: round2(effectiveFps),
      lowFpsIntervals,
      lowFpsFrac: intervals.length ? lowFpsIntervals / intervals.length : 0,
      intervalCount: intervals.length,
    },
    activeMs,
    // Occlusion state is a fact about the track, not a verdict about the
    // attempt. The protocol layer decides what to do about it.
    occlusion: {
      broken: maxGapFrames > EVENT_RULES.maxBallGapFrames || maxGapMs > EVENT_RULES.maxBallGapMs,
      maxGapFrames,
      maxGapMs,
    },
  };
}

/**
 * Player-relative motion in NORMALISED units, for the samples that have both
 * a ball and a player.
 *
 * Returns, per usable triple, the velocity change (impulse) in ball
 * diameters per second and the ball-to-player distance in ball diameters.
 * The protocol layer thresholds these; it never sees a pixel.
 */
export function relativeMotion(tracks) {
  const pts = tracks.samples.filter((s) => s.ball && s.person && s.rel);
  const out = [];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const dt1 = (b.atMs - a.atMs) / 1000;
    const dt2 = (c.atMs - b.atMs) / 1000;
    if (dt1 <= 0 || dt2 <= 0) continue;
    const d = b.ball.diameter || 1;                 // the ruler
    // Velocities in diameters per second, in the player's frame.
    const v1x = ((b.rel.x - a.rel.x) / d) / dt1, v1y = ((b.rel.y - a.rel.y) / d) / dt1;
    const v2x = ((c.rel.x - b.rel.x) / d) / dt2, v2y = ((c.rel.y - b.rel.y) / d) / dt2;
    out.push({
      seq: b.seq,
      atMs: b.atMs,
      // Ball position in the player's frame, in ball diameters. The protocol
      // layer measures displacement between contacts with this.
      relX: b.rel.x / d,
      relY: b.rel.y / d,
      // Distance to the player region, in ball diameters.
      distDiameters: distToBox(b.ball.x, b.ball.y, b.person) / d,
      // Height above the player centre, in ball diameters (negative = above).
      relHeightDiameters: b.rel.y / d,
      impulseDiametersPerSec: Math.hypot(v2x - v1x, v2y - v1y),
      speedDiametersPerSec: Math.hypot(v2x, v2y),
      confidence: (a.ball.confidence + b.ball.confidence + c.ball.confidence) / 3,
      // Frame-edge proximity, in diameters: a clipped blob has an unreliable
      // centroid and must not be allowed to manufacture an impulse.
      edgeDiameters: Math.min(
        b.ball.x, b.ball.y, b.w - b.ball.x, b.h - b.ball.y,
      ) / d,
      // The interval either side, so the protocol layer can tell a genuine
      // adjacency from one that spans a dropped-frame gap.
      gapBeforeMs: b.atMs - a.atMs,
      gapAfterMs: c.atMs - b.atMs,
      // True when the player frame of reference moved discontinuously across
      // this triple, which makes its relative velocities meaningless.
      frameJump: !!(a.personJump || b.personJump || c.personJump),
    });
  }
  return out;
}

function distToBox(px, py, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  return Math.hypot(dx, dy);
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;
