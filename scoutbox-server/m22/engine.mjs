// M22 — the observation engine: an ORCHESTRATOR over three separated layers.
//
//   frames ─▶ [1] detect.mjs ─▶ [2] track.mjs ─▶ [3] protocol.mjs ─▶ result
//                                     │
//                                     └──▶ quality.mjs ─▶ sufficient? refuse?
//
// Almost nothing is decided in this file. That is deliberate: after the fix
// pack, detection, tracking and protocol interpretation are independently
// testable and independently replaceable (§23–§27), and this file's only job
// is to run them in order, apply the quality gate, and choose one refusal
// reason deterministically.
//
// Determinism: no clock, no randomness, no module-level mutable state. The
// same frames in the same order produce byte-identical output. Session
// isolation is therefore structural — two runs cannot interfere because
// there is nothing shared for them to interfere through (§10, §11).

import { CV_ENGINE_VERSION, CONFIDENCE, DETECTION, EVENT_RULES, CAPTURE_REQUIREMENTS } from './policy.mjs';
import { detectFrame } from './detect.mjs';
import { buildTracks, relativeMotion } from './track.mjs';
import { interpret } from './protocol.mjs';
import { observationQuality, primaryRefusal, qualityToRefusalConditions } from './quality.mjs';

// A capture must contain at least this many DISTINCT frames to be an
// observation at all, and no more than this fraction may be duplicates.
// Both exist because a still photograph repeated is otherwise reducible to a
// single analysed frame, which then sails through every later check.
const MIN_ANALYSED_FRAMES = 10;
const MAX_DUPLICATE_FRAC = 0.5;

export class ObservationRun {
  constructor({ eventKind } = {}) {
    this.eventKind = eventKind;          // 'touch' | 'juggle' | 'duration'
    this.detections = [];                // Layer 1 output only — no pixels
    this.prev = null;                    // exactly one frame, for diffing
    this.seenHashes = new Set();
    this.duplicates = 0;
    this.framesSeen = 0;
    this.staticRun = 0;
    this.maxStaticRun = 0;
    this.finished = false;
  }

  /** Ingest one decoded frame. The frame is not retained beyond `prev`. */
  processFrame(frame) {
    if (this.finished) throw new Error('ObservationRun already finished');
    this.framesSeen += 1;

    // An identical frame is the same observation submitted twice. It
    // advances nothing except the staleness accounting — which it MUST
    // advance, or a repeated still photograph collapses to one analysed
    // frame and sails through every later check.
    if (this.seenHashes.has(frame.hash)) {
      this.duplicates += 1;
      this.staticRun += 1;
      this.maxStaticRun = Math.max(this.maxStaticRun, this.staticRun);
      return { seq: frame.seq, duplicate: true };
    }
    this.seenHashes.add(frame.hash);

    const det = detectFrame(frame, this.prev);
    if (det.interFrameDiff != null && det.interFrameDiff < DETECTION.staticFrameMaxMeanDiff) {
      this.staticRun += 1;
      this.maxStaticRun = Math.max(this.maxStaticRun, this.staticRun);
    } else {
      this.staticRun = 0;
    }
    this.detections.push(det);
    this.prev = frame;
    return {
      seq: frame.seq, duplicate: false,
      ball: !!det.ball, person: !!det.person, usable: det.visibility.usable,
    };
  }

  /** Release every retained reference (§12, §153). */
  dispose() {
    this.prev = null;
    this.detections = [];
    this.seenHashes.clear();
    this.finished = true;
  }

  /**
   * Derive the measurement.
   *
   * Conditions are COLLECTED, then one primary reason is chosen by the
   * precedence table — rather than returning at the first failing check,
   * which would make the reported reason depend on check order (§34, §36).
   */
  finish({ protocolWindowMs = null } = {}) {
    this.finished = true;
    this.prev = null;

    const tracks = buildTracks(this.detections);
    const c = tracks.continuity;
    const frames = c.frames;

    const conditions = [];
    const base = {
      engineVersion: CV_ENGINE_VERSION,
      integrity: {
        framesSeen: this.framesSeen,
        framesAnalysed: frames,
        duplicateFrames: this.duplicates,
        maxStaticRunFrames: this.maxStaticRun,
        ballDetectedFrames: c.ballFrames,
        personDetectedFrames: c.personFrames,
        unusableFrames: c.unusableFrames,
        rivalBallFrames: c.rivalBallFrames,
        maxBallGapFrames: c.maxGapFrames,
        maxBallGapMs: c.maxGapMs,
        trackResets: c.trackResets,
        effectiveFps: tracks.cadence.effectiveFps,
      },
    };

    if (frames === 0) {
      return refusal(['ball_not_detected'], 'no frames were analysed', base, null);
    }
    if (frames < MIN_ANALYSED_FRAMES) {
      conditions.push('protocol_violation');
    }
    if (this.duplicates / Math.max(1, this.framesSeen) > MAX_DUPLICATE_FRAC) {
      conditions.push('protocol_violation');
    }
    if (this.maxStaticRun >= DETECTION.staticRunFrames) {
      conditions.push('protocol_violation');
    }
    if (c.unusableFrames / frames > 0.3) conditions.push('insufficient_visibility');
    if (c.personCoverage < 0.5) conditions.push('person_not_detected');
    if (c.ballCoverage < 1 - EVENT_RULES.maxBallMissingFrac) conditions.push('ball_not_detected');
    if (c.rivalBallFrames / frames > 0.1) conditions.push('protocol_violation');
    if (tracks.occlusion.broken) conditions.push('observation_discontinuity');
    // Cadence is only diagnosable with enough intervals to measure one. A
    // capture collapsed to a couple of distinct frames by duplication has no
    // meaningful frame rate, and reporting "insufficient frame rate" there
    // outranks — and hides — the real finding, which is that someone held a
    // still image to the lens.
    if (tracks.cadence.intervalCount >= 3
      && tracks.cadence.effectiveFps > 0
      && tracks.cadence.effectiveFps < CAPTURE_REQUIREMENTS.minSustainedFps) {
      conditions.push('insufficient_frame_rate');
    }

    // Layers 2→3. Interpretation runs even when conditions exist, because
    // the quality projection needs the ambiguous-interval count — but its
    // output is discarded unless everything passes.
    const motion = relativeMotion(tracks);
    const interpreted = this.eventKind === 'duration'
      ? { events: [], ambiguousIntervals: 0, transitions: [], finalState: 'READY' }
      : interpret(this.eventKind, motion);

    const usable = interpreted.events.filter((e) => e.confidence >= CONFIDENCE.minPerEvent);
    const withBoth = tracks.samples.filter((s) => s.ball && s.person);
    const aggregate = usable.length
      ? usable.reduce((a, e) => a + e.confidence, 0) / usable.length
      : (withBoth.length ? withBoth.reduce((a, x) => a + x.ball.confidence, 0) / withBoth.length : 0);

    // §28–§33 — observation quality. Its inputs are properties of the
    // CAPTURE; the count is not among them and cannot rescue a bad capture.
    const quality = observationQuality({
      continuity: c,
      cadence: tracks.cadence,
      duplicates: this.duplicates,
      framesSeen: this.framesSeen,
      ambiguousIntervals: interpreted.ambiguousIntervals,
      eventCount: usable.length,
    });
    if (quality.state !== 'sufficient') conditions.push(...qualityToRefusalConditions(quality));

    if (aggregate < CONFIDENCE.minAcceptable) conditions.push('insufficient_confidence');
    if (this.eventKind !== 'duration' && c.ballCoverage < CONFIDENCE.minDetectionCoverage) {
      conditions.push('insufficient_confidence');
    }

    if (conditions.length > 0) {
      return refusal(conditions, null, base, quality);
    }

    const inWindow = protocolWindowMs == null ? usable : usable.filter((e) => e.atMs <= protocolWindowMs);
    return {
      state: 'accepted',
      primaryReason: null,
      secondaryDiagnostics: [],
      detail: null,
      events: inWindow.map((e) => ({ atMs: e.atMs, confidence: round3(e.confidence) })),
      count: this.eventKind === 'duration' ? null : inWindow.length,
      activeMs: tracks.activeMs,
      confidence: { aggregate: round3(aggregate), coverage: round3(c.ballCoverage) },
      observationQuality: quality,
      contactStates: interpreted.finalState,
      integrity: base.integrity,
      engineVersion: CV_ENGINE_VERSION,
    };
  }
}

function refusal(conditions, detail, base, quality) {
  const { primaryReason, secondaryDiagnostics } = primaryRefusal(conditions);
  return {
    state: primaryReason ?? 'insufficient_confidence',
    primaryReason: primaryReason ?? 'insufficient_confidence',
    secondaryDiagnostics,
    detail,
    events: [],
    count: null,
    activeMs: 0,
    confidence: { aggregate: 0, coverage: 0 },
    observationQuality: quality,
    integrity: base.integrity,
    engineVersion: base.engineVersion,
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export { detectFrame } from './detect.mjs';
export { buildTracks, relativeMotion } from './track.mjs';
export { interpret, interpretTouches, interpretJuggles } from './protocol.mjs';
