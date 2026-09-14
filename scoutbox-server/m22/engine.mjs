// M22 — the deterministic Box Cam observation engine.
//
// This is the thing that actually looks at pixels. It is deliberately a set
// of readable rules with named thresholds rather than a learned model: see
// M22_MATRIX.md §C7 for why that was chosen and, more importantly, what it
// costs.
//
// Everything here is PURE and deterministic: the same frames in the same
// order produce byte-identical output, every time, with no clock, no
// randomness and no shared state. That property is asserted by the
// evaluation harness and is what makes the acceptance gate meaningful.
//
// What it observes (§12): ball present, person present, ball trajectory,
// relative location, discrete touch, juggle event, activity duration,
// protocol boundary compliance.
//
// What it does NOT do, ever: faces, identity, bodies, emotion, audio, or any
// judgement about how well the player played.

import { DETECTION, EVENT_RULES, CONFIDENCE, CV_ENGINE_VERSION } from './policy.mjs';
import { frameStats, meanAbsDiff } from './frames.mjs';

// --------------------------------------------------------------- helpers

/** Otsu-style split, but bounded: we only ever look for BRIGHT blobs. */
function brightThreshold(stats) {
  return Math.min(250, stats.mean + Math.max(DETECTION.ballMinContrast, stats.stdDev * 1.6));
}

/**
 * Connected-component scan over pixels above `thr`, four-connected, with an
 * explicit component cap so a pathological frame cannot produce unbounded
 * work (§21 of the threat model).
 */
function components(frame, thr, { maxComponents = 64 } = {}) {
  const { w, h, pixels } = frame;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < pixels.length && out.length < maxComponents; i += 1) {
    if (seen[i] || pixels[i] < thr) continue;
    let sp = 0;
    stack[sp] = i; sp += 1;
    seen[i] = 1;
    let count = 0, sumX = 0, sumY = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    while (sp > 0) {
      sp -= 1;
      const p = stack[sp];
      const x = p % w;
      const y = (p - x) / w;
      count += 1; sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && pixels[p - 1] >= thr) { seen[p - 1] = 1; stack[sp] = p - 1; sp += 1; }
      if (x < w - 1 && !seen[p + 1] && pixels[p + 1] >= thr) { seen[p + 1] = 1; stack[sp] = p + 1; sp += 1; }
      if (y > 0 && !seen[p - w] && pixels[p - w] >= thr) { seen[p - w] = 1; stack[sp] = p - w; sp += 1; }
      if (y < h - 1 && !seen[p + w] && pixels[p + w] >= thr) { seen[p + w] = 1; stack[sp] = p + w; sp += 1; }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    out.push({
      count,
      cx: sumX / count,
      cy: sumY / count,
      bw,
      bh,
      // Fill ratio against the bounding box. A disc fills ~pi/4 = 0.785 of
      // its box; a limb or a shadow fills far less or is far from square.
      roundness: (count / (bw * bh)) * (Math.min(bw, bh) / Math.max(bw, bh)),
    });
  }
  return out;
}

/**
 * Ball detection. Returns the single best candidate, plus how many rival
 * candidates of comparable size exist — §34 needs that count, because more
 * than one ball is a protocol violation and NOT an attribution problem to be
 * guessed at.
 */
export function detectBall(frame, stats) {
  const area = frame.w * frame.h;
  const thr = brightThreshold(stats);
  const comps = components(frame, thr);
  const candidates = comps.filter((c) => {
    const frac = c.count / area;
    return frac >= DETECTION.ballMinAreaFrac
      && frac <= DETECTION.ballMaxAreaFrac
      && c.roundness >= DETECTION.ballMinRoundness;
  });
  if (candidates.length === 0) return { ball: null, rivals: 0 };
  candidates.sort((a, b) => (b.roundness * b.count) - (a.roundness * a.count));
  const best = candidates[0];
  const rivals = candidates.filter((c, i) => i > 0 && c.count >= best.count * EVENT_RULES.secondBallMinAreaRatio).length;
  return {
    ball: {
      x: best.cx,
      y: best.cy,
      r: Math.sqrt(best.count / Math.PI),
      // Detection confidence: roundness is the dominant term because a round
      // bright blob is what a ball looks like; contrast contributes the rest.
      confidence: Math.max(0, Math.min(1, best.roundness * 0.8 + Math.min(1, stats.stdDev / 40) * 0.2)),
    },
    rivals,
  };
}

/**
 * Person detection — a LARGE non-background region. Deliberately crude, and
 * deliberately anonymous: it yields a bounding box and nothing else. There
 * is no landmark, no keypoint, no descriptor and no identity (§10, §110).
 */
export function detectPerson(frame, stats) {
  const area = frame.w * frame.h;
  // People are darker-than-background or brighter-than-background masses;
  // we take deviation from the mean rather than a one-sided threshold.
  //
  // Ball-bright pixels are EXCLUDED. Without this the ball — which is by
  // construction the brightest thing in frame — falls inside the person
  // region, the ball-to-player distance becomes 0 for every frame, and the
  // §21 contact test passes trivially. That would not be a detector; it
  // would be a rubber stamp with extra steps.
  const { w, h, pixels } = frame;
  const bright = brightThreshold(stats);
  const dev = Math.max(12, stats.stdDev * 0.8);
  let count = 0, sumX = 0, sumY = 0;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let i = 0; i < pixels.length; i += 1) {
    if (pixels[i] >= bright) continue;
    if (Math.abs(pixels[i] - stats.mean) < dev) continue;
    const x = i % w;
    const y = (i - x) / w;
    count += 1; sumX += x; sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count / area < DETECTION.personMinAreaFrac) return null;
  return {
    x0: minX, y0: minY, x1: maxX, y1: maxY,
    cx: sumX / count, cy: sumY / count,
    areaFrac: count / area,
  };
}

/** Distance from a point to the nearest edge of a box (0 if inside). */
function distToBox(px, py, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------- engine

/**
 * A per-session observation run.
 *
 * State is instance-local and keyed by nothing at all — the OWNER holds it
 * against a session id. Two concurrent sessions cannot interfere because
 * they cannot reach each other's instance (§74/§75).
 */
export class ObservationRun {
  constructor({ eventKind, frameW = 0, frameH = 0 } = {}) {
    this.eventKind = eventKind;      // 'touch' | 'juggle' | 'duration'
    this.frameW = frameW;
    this.frameH = frameH;
    this.samples = [];               // per-frame derived observations only
    this.prev = null;                // previous frame, for diffing only
    this.seenHashes = new Set();     // duplicate-frame defence (T7)
    this.duplicates = 0;
    this.staticRun = 0;
    this.maxStaticRun = 0;
    this.framesSeen = 0;
    this.rivalBallFrames = 0;
    this.lowLightFrames = 0;
    this.finished = false;
  }

  /**
   * Ingest one decoded frame. Returns a small per-frame record for the
   * integrity trace; the frame itself is not retained beyond `this.prev`,
   * which holds exactly one frame and is released on `finish()`.
   */
  processFrame(frame) {
    if (this.finished) throw new Error('ObservationRun already finished');
    this.framesSeen += 1;
    if (!this.frameW) { this.frameW = frame.w; this.frameH = frame.h; }

    // T7 — an identical frame is the same observation submitted twice. It
    // advances nothing: not the tracker, not the count, not the clock.
    //
    // It DOES advance the staleness accounting, though. An earlier cut
    // returned here immediately, which meant a still photograph held to the
    // lens — every frame byte-identical — was silently reduced to a single
    // analysed frame and then accepted with a count of zero. A repeated
    // still is the most static capture possible; it must feed the static
    // detector, not bypass it.
    if (this.seenHashes.has(frame.hash)) {
      this.duplicates += 1;
      this.staticRun += 1;
      this.maxStaticRun = Math.max(this.maxStaticRun, this.staticRun);
      return { seq: frame.seq, duplicate: true };
    }
    this.seenHashes.add(frame.hash);

    const stats = frameStats(frame);
    const dark = stats.mean < DETECTION.minMeanLuma || stats.stdDev < DETECTION.minLumaStdDev;
    if (dark) this.lowLightFrames += 1;

    // T8 — a frozen stream. Near-identical consecutive frames are not
    // activity, even when each one is individually unique.
    const diff = this.prev ? meanAbsDiff(this.prev, frame) : Infinity;
    if (Number.isFinite(diff) && diff < DETECTION.staticFrameMaxMeanDiff) {
      this.staticRun += 1;
      this.maxStaticRun = Math.max(this.maxStaticRun, this.staticRun);
    } else {
      this.staticRun = 0;
    }

    const { ball, rivals } = dark ? { ball: null, rivals: 0 } : detectBall(frame, stats);
    if (rivals > 0) this.rivalBallFrames += 1;
    const person = dark ? null : detectPerson(frame, stats);

    this.samples.push({
      seq: frame.seq,
      atMs: frame.atMs,
      ball: ball ? { x: ball.x, y: ball.y, r: ball.r, c: ball.confidence } : null,
      person: person ? { x0: person.x0, y0: person.y0, x1: person.x1, y1: person.y1 } : null,
      dark,
      diff: Number.isFinite(diff) ? diff : null,
    });

    this.prev = frame;
    return { seq: frame.seq, duplicate: false, ball: !!ball, person: !!person, dark };
  }

  /**
   * Derive the measurement. Returns a structured observation (§18) — never a
   * bare number, and never a number at all when the evidence is too weak.
   */
  finish({ protocolWindowMs = null } = {}) {
    this.finished = true;
    this.prev = null;                 // release the last frame reference
    const s = this.samples;
    const frames = s.length;
    const diag = Math.hypot(this.frameW || 1, this.frameH || 1);

    const integrity = {
      framesSeen: this.framesSeen,
      framesAnalysed: frames,
      duplicateFrames: this.duplicates,
      maxStaticRunFrames: this.maxStaticRun,
      lowLightFrames: this.lowLightFrames,
      rivalBallFrames: this.rivalBallFrames,
      ballDetectedFrames: s.filter((x) => x.ball).length,
      personDetectedFrames: s.filter((x) => x.person).length,
    };

    const refuse = (state, detail) => ({
      state, detail, events: [], count: null, activeMs: 0,
      confidence: { aggregate: 0, coverage: 0 }, integrity,
      engineVersion: CV_ENGINE_VERSION,
    });

    if (frames === 0) return refuse('ball_not_detected', 'no frames were analysed');

    // A capture must actually contain enough DISTINCT frames to be an
    // observation at all. Without this, a handful of unique frames padded
    // with duplicates reaches the acceptance path and is accepted with a
    // count of zero — which reads as a successful observation of nothing.
    if (frames < MIN_ANALYSED_FRAMES) {
      return refuse('protocol_violation', 'too few distinct frames were captured to observe the attempt');
    }
    if (this.duplicates / Math.max(1, this.framesSeen) > MAX_DUPLICATE_FRAC) {
      return refuse('protocol_violation', 'most of the capture was the same frame submitted repeatedly');
    }

    // §31 — visibility first. A dark capture is refused, never estimated.
    if (integrity.lowLightFrames / frames > 0.3) {
      return refuse('insufficient_visibility', 'too many frames were too dark to track the ball');
    }
    // T8 — a static or frozen sequence is not activity.
    if (this.maxStaticRun >= DETECTION.staticRunFrames) {
      return refuse('protocol_violation', 'the capture contained a static image sequence');
    }
    // §24 — person and ball must both be established.
    if (integrity.personDetectedFrames / frames < 0.5) {
      return refuse('person_not_detected', 'no player was visible for enough of the attempt');
    }
    const coverage = integrity.ballDetectedFrames / frames;
    if (coverage < 1 - EVENT_RULES.maxBallMissingFrac) {
      return refuse('ball_not_detected', 'the ball was not visible for enough of the attempt');
    }
    // §34 — a second ball is a protocol violation, not a choice to make.
    if (this.rivalBallFrames / frames > 0.1) {
      return refuse('protocol_violation', 'more than one ball was visible in the capture area');
    }
    // §32 — a long occlusion breaks the track outright.
    let gap = 0, maxGap = 0;
    for (const x of s) {
      if (x.ball) gap = 0; else { gap += 1; maxGap = Math.max(maxGap, gap); }
    }
    integrity.maxBallGapFrames = maxGap;
    if (maxGap > EVENT_RULES.maxBallGapFrames) {
      return refuse('ball_not_detected', 'the ball left the visible area for too long');
    }

    // Active duration: frames where both the ball and a player were visible.
    const withBoth = s.filter((x) => x.ball && x.person);
    let activeMs = 0;
    for (let i = 1; i < s.length; i += 1) {
      if (s[i].ball && s[i].person && s[i - 1].ball && s[i - 1].person) {
        activeMs += Math.max(0, s[i].atMs - s[i - 1].atMs);
      }
    }

    if (this.eventKind === 'duration') {
      const aggregate = withBoth.length ? withBoth.reduce((a, x) => a + x.ball.c, 0) / withBoth.length : 0;
      if (aggregate < CONFIDENCE.minAcceptable) {
        return refuse('insufficient_confidence', 'ball tracking confidence was below the acceptance threshold');
      }
      return {
        state: 'accepted', detail: null, events: [], count: null, activeMs,
        confidence: { aggregate: round3(aggregate), coverage: round3(coverage) },
        integrity, engineVersion: CV_ENGINE_VERSION,
      };
    }

    const events = this.eventKind === 'juggle' ? this.#juggles(s) : this.#touches(s, diag);
    const usable = events.filter((e) => e.confidence >= CONFIDENCE.minPerEvent);
    const aggregate = usable.length
      ? usable.reduce((a, e) => a + e.confidence, 0) / usable.length
      : (withBoth.length ? withBoth.reduce((a, x) => a + x.ball.c, 0) / withBoth.length : 0);

    if (coverage < CONFIDENCE.minDetectionCoverage) {
      return refuse('insufficient_confidence', 'the ball was tracked in too few frames to count events');
    }
    if (aggregate < CONFIDENCE.minAcceptable) {
      return refuse('insufficient_confidence', 'observation confidence was below the acceptance threshold');
    }
    // §28 — the protocol window is the server's, and events outside it do
    // not count. The caller supplies the window; the engine never invents it.
    const inWindow = protocolWindowMs == null ? usable : usable.filter((e) => e.atMs <= protocolWindowMs);

    return {
      state: 'accepted', detail: null,
      events: inWindow.map((e) => ({ atMs: e.atMs, confidence: round3(e.confidence) })),
      count: inWindow.length,
      activeMs,
      confidence: { aggregate: round3(aggregate), coverage: round3(coverage) },
      integrity, engineVersion: CV_ENGINE_VERSION,
    };
  }

  /**
   * §23 — JUGGLE RULE.
   *
   * A juggle is a CONTACT, identified as a reversal in the ball's vertical
   * motion: falling (y increasing, since y grows downward) then rising. The
   * flight that follows must clear `juggleMinFlightFrac` of the frame
   * height, which is what stops a ball resting on the ground with a few
   * pixels of detector jitter from producing a count.
   *
   * This is explicitly NOT "count the vertical peaks", which §23 warns
   * against: a peak is the top of a flight, and counting peaks conflates the
   * apex with the contact and double-counts a bouncing ball.
   */
  #juggles(s) {
    // Height is measured relative to the player for the same reason the
    // touch rule uses a relative frame: a shaking camera must not be able to
    // manufacture a flight the ball never made.
    const pts = s.filter((x) => x.ball && x.person).map((x) => ({
      atMs: x.atMs,
      ball: { ...x.ball, y: x.ball.y - (x.person.y0 + x.person.y1) / 2 },
    }));
    const out = [];
    let lastAt = -Infinity;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const fallingIn = b.ball.y > a.ball.y;
      const risingOut = c.ball.y < b.ball.y;
      if (!(fallingIn && risingOut)) continue;          // not a reversal
      if (b.atMs - lastAt < EVENT_RULES.juggleRefractoryMs) continue;  // §23 refractory
      // Measure the flight that follows this contact.
      let apex = b.ball.y;
      for (let j = i + 1; j < pts.length; j += 1) {
        if (pts[j].ball.y > pts[j - 1].ball.y) break;   // started falling again
        apex = Math.min(apex, pts[j].ball.y);
      }
      const flight = (b.ball.y - apex) / (this.frameH || 1);
      if (flight < EVENT_RULES.juggleMinFlightFrac) continue;
      lastAt = b.atMs;
      out.push({
        atMs: b.atMs,
        // Confidence blends detector certainty around the contact with how
        // decisively the flight cleared the minimum.
        confidence: Math.min(1, ((a.ball.c + b.ball.c + c.ball.c) / 3) * 0.75
          + Math.min(1, flight / (EVENT_RULES.juggleMinFlightFrac * 3)) * 0.25),
      });
    }
    return out;
  }

  /**
   * §21 — TOUCH RULE.
   *
   * A touch is an IMPULSE: the ball's velocity vector changes by at least
   * `touchMinImpulsePxPerSec`, while the ball is within
   * `touchMaxContactDistFrac` of the detected player region. Both halves
   * matter — an impulse with nobody near it is the ball hitting something
   * else, and proximity without an impulse is the player simply standing
   * near a stationary ball.
   *
   * Ambiguity behaviour: where contact cannot be attributed (no person
   * region in either adjacent frame) the candidate is DROPPED, not counted
   * with lower confidence. Edge-of-frame behaviour: a ball whose centroid
   * sits within its own radius of any frame edge is not eligible, because a
   * partially visible blob has an unreliable centroid and would manufacture
   * a false impulse as it clips.
   */
  #touches(s, diag) {
    // Only frames where the player was also located can contribute: the
    // impulse is measured in the PLAYER'S frame of reference, not the
    // camera's. A handheld camera shaking produces large absolute ball
    // velocities and violent apparent reversals while the ball is in fact
    // sitting still on the ground — an earlier cut counted eleven touches
    // from exactly that. Subtracting the player's position cancels rigid
    // camera motion, because the ball and the player shake together.
    const pts = s.filter((x) => x.ball && x.person).map((x) => ({
      atMs: x.atMs,
      ball: x.ball,
      person: x.person,
      // Relative to the player region's centre.
      rx: x.ball.x - (x.person.x0 + x.person.x1) / 2,
      ry: x.ball.y - (x.person.y0 + x.person.y1) / 2,
    }));
    const out = [];
    let lastAt = -Infinity;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      // Edge-of-frame guard.
      const r = b.ball.r;
      if (b.ball.x < r || b.ball.y < r || b.ball.x > this.frameW - r || b.ball.y > this.frameH - r) continue;
      const dt1 = (b.atMs - a.atMs) / 1000;
      const dt2 = (c.atMs - b.atMs) / 1000;
      if (dt1 <= 0 || dt2 <= 0) continue;
      const v1x = (b.rx - a.rx) / dt1, v1y = (b.ry - a.ry) / dt1;
      const v2x = (c.rx - b.rx) / dt2, v2y = (c.ry - b.ry) / dt2;
      const impulse = Math.hypot(v2x - v1x, v2y - v1y);
      if (impulse < EVENT_RULES.touchMinImpulsePxPerSec) continue;
      if (b.atMs - lastAt < EVENT_RULES.touchRefractoryMs) continue;   // §21 refractory
      // Contact attribution — ambiguous means dropped, never guessed. The
      // player region is present by construction here (see the filter above).
      const box = b.person;
      const dist = distToBox(b.ball.x, b.ball.y, box) / diag;
      if (dist > EVENT_RULES.touchMaxContactDistFrac) continue;
      lastAt = b.atMs;
      out.push({
        atMs: b.atMs,
        confidence: Math.min(1, ((a.ball.c + b.ball.c + c.ball.c) / 3) * 0.7
          + Math.min(1, impulse / (EVENT_RULES.touchMinImpulsePxPerSec * 3)) * 0.2
          + (1 - Math.min(1, dist / EVENT_RULES.touchMaxContactDistFrac)) * 0.1),
      });
    }
    return out;
  }
}

// A capture must contain at least this many DISTINCT frames to be an
// observation at all, and no more than this fraction may be duplicates.
// Both exist because a still photograph repeated is otherwise reducible to a
// single analysed frame, which then sails through every later check.
const MIN_ANALYSED_FRAMES = 10;
const MAX_DUPLICATE_FRAC = 0.5;

const round3 = (n) => Math.round(n * 1000) / 1000;
