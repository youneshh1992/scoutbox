// Orchestration only: session lifecycle, frame binding, bounded queueing, single-shot finalization, health. Observation
// logic stays in the engine modules, because a rule written here would be an unversioned copy the freeze in
// freeze.mjs doesn't cover.

import crypto from 'node:crypto';
import { ObservationRun } from './engine.mjs';
import { FrameQueue } from './frames.mjs';
import {
  CV_PROVIDER_ID, CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION,
  FRAME_LIMITS, CANDIDATE_PROTOCOLS,
} from './policy.mjs';
import {
  OBSERVATION_CAPABILITIES, NON_CAPABILITIES,
  combineEligibilityMatrix, combineVerifiedProtocols,
} from './eligibility.mjs';

/** The provider's own version, separate from the engine's. */
export const PROVIDER_VERSION = 1;

// =========================================================================
// The runtime state machine
// =========================================================================
// An explicit table so a test can read which transitions are illegal.

export const PROVIDER_STATES = Object.freeze([
  'created', 'ready', 'running', 'finalizing',
  'accepted', 'refused', 'cancelled', 'expired', 'failed',
]);

export const TERMINAL_PROVIDER_STATES = Object.freeze(['accepted', 'refused', 'cancelled', 'expired', 'failed']);

const TRANSITIONS = Object.freeze({
  created: ['ready', 'cancelled', 'expired', 'failed'],
  ready: ['running', 'finalizing', 'cancelled', 'expired', 'failed'],
  running: ['finalizing', 'cancelled', 'expired', 'failed'],
  finalizing: ['accepted', 'refused', 'failed'],
  accepted: [], refused: [], cancelled: [], expired: [], failed: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export const PROVIDER_ERRORS = Object.freeze({
  FRAME_TOO_LARGE: 'frame_too_large',
  UNSUPPORTED_FRAME_FORMAT: 'unsupported_frame_format',
  INVALID_FRAME_DIMENSIONS: 'invalid_frame_dimensions',
  DUPLICATE_FRAME: 'duplicate_frame',
  OUT_OF_ORDER_FRAME: 'out_of_order_frame',
  SESSION_EXPIRED: 'session_expired',
  NONCE_INVALID: 'nonce_invalid',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  QUEUE_OVERFLOW: 'queue_overflow',
  RATE_LIMITED: 'rate_limited',
  SESSION_NOT_FOUND: 'session_not_found',
  INVALID_STATE: 'invalid_state',
  ALREADY_FINALIZED: 'already_finalized',
  UNSUPPORTED_PROTOCOL: 'unsupported_protocol',
  PROVIDER_BUSY: 'provider_busy',
  ENGINE_FAILURE: 'engine_failure',
  CLIENT_FIELD_REFUSED: 'client_field_refused',
});

export const REORDER_WINDOW = 0;

// Load shedding is a decision rather than a memory profile.
export const MAX_CONCURRENT_SESSIONS = 16;

// =========================================================================
// One provider session
// =========================================================================

class ProviderSession {
  constructor({ providerSessionId, boxCamSessionId, playerId, protocolId, eventKind, nonce, createdAt, ttlMs }) {
    this.providerSessionId = providerSessionId;
    this.boxCamSessionId = boxCamSessionId;
    this.playerId = playerId;
    this.protocolId = protocolId;
    this.eventKind = eventKind;
    this.nonceBinding = nonce;
    this.createdAt = createdAt;
    this.expiresAt = createdAt + ttlMs;
    this.state = 'created';

    this.run = new ObservationRun({ eventKind });
    this.queue = new FrameQueue();

    // `seenSeqs` catches a replay of an old sequence, not only a repeat of the newest.
    this.lastSeq = 0;
    this.seenSeqs = new Set();

    this.framesAccepted = 0;
    this.framesRejected = 0;
    this.framesDroppedByServer = 0;
    this.duplicatesRejected = 0;
    this.outOfOrderRejected = 0;

    // Client timestamps are for diagnosis only; the server timeline is the clock.
    this.serverStartedAt = null;
    this.serverEndedAt = null;
    this.firstFrameAt = null;
    this.lastFrameAt = null;
    this.clientClockAnomalies = 0;

    this.result = null;
    this.failure = null;
    this.disposed = false;
  }

  get finalized() { return TERMINAL_PROVIDER_STATES.includes(this.state); }

  transition(to) {
    if (!canTransition(this.state, to)) {
      return { ok: false, error: PROVIDER_ERRORS.INVALID_STATE, from: this.state, to };
    }
    this.state = to;
    return { ok: true, state: to };
  }

  /** Release everything. Idempotent. */
  dispose() {
    if (this.disposed) return false;
    this.queue.clear();
    if (this.run && typeof this.run.dispose === 'function') {
      try { this.run.dispose(); } catch { /* disposal must never throw */ }
    }
    this.run = null;
    this.seenSeqs.clear();
    this.disposed = true;
    return true;
  }

  footprint() {
    return {
      queuedFrames: this.queue ? this.queue.size : 0,
      detections: this.run ? this.run.detections.length : 0,
      seenSeqs: this.seenSeqs.size,
      disposed: this.disposed,
    };
  }
}

// =========================================================================
// The provider
// =========================================================================

export class ProductionCvProvider {
  constructor({
    now = () => Date.now(),
    ttlMs = 5 * 60_000,
    maxConcurrent = MAX_CONCURRENT_SESSIONS,
    // A seam for a worker boundary, unused by default: a frame measured 0.31–0.92 ms and a batch is capped at 12, so a
    // worker would add more serialisation cost than it removes blocking.
    processFrame = null,
  } = {}) {
    this.id = CV_PROVIDER_ID;
    this.providerVersion = PROVIDER_VERSION;
    this.engineVersion = CV_ENGINE_VERSION;
    this.cvPolicyVersion = BOX_CAM_CV_POLICY_VERSION;

    this.now = now;
    this.ttlMs = ttlMs;
    this.maxConcurrent = maxConcurrent;
    this.customProcessFrame = processFrame;

    this.sessions = new Map();      // providerSessionId -> ProviderSession
    this.byBoxCamSession = new Map(); // boxCamSessionId -> providerSessionId

    this.healthState = 'ready';
    this.stats = {
      created: 0, accepted: 0, refused: 0, cancelled: 0, expired: 0, failed: 0,
      framesAccepted: 0, framesRejected: 0, framesDropped: 0, shed: 0,
    };
  }

  // ------------------------------------------------------------- health

  /** Whether the provider can observe; says so explicitly so `ready` isn't read as Combine eligibility. */
  health() {
    const load = this.sessions.size / this.maxConcurrent;
    let state = this.healthState;
    if (state === 'ready' && load >= 1) state = 'degraded';
    return {
      state,                                  // not_configured | warming | ready | degraded | unavailable
      providerId: this.id,
      providerVersion: this.providerVersion,
      engineVersion: this.engineVersion,
      cvPolicyVersion: this.cvPolicyVersion,
      activeSessions: this.sessions.size,
      maxConcurrentSessions: this.maxConcurrent,
      combineVerificationEligible: false,
      combineVerifiedProtocols: combineVerifiedProtocols(),
      note: 'Provider health describes observation capability only. It is not Combine verification eligibility.',
    };
  }

  /** `observation` (what it can see) and `combine` (what it may certify, currently empty) are kept apart. */
  capabilities() {
    const matrix = combineEligibilityMatrix();
    return {
      providerId: this.id,
      providerVersion: this.providerVersion,
      engineVersion: this.engineVersion,
      cvPolicyVersion: this.cvPolicyVersion,

      serverPixelObservation: true,
      personDetection: true,
      ballDetection: true,
      touchObservation: true,
      juggleObservation: true,

      exactCountSyntheticValidated: true,
      realWorldValidated: false,

      boxCamObservedEligible: true,
      combineVerifiedEligible: false,

      observation: [...OBSERVATION_CAPABILITIES],
      combine: combineVerifiedProtocols(),
      combineByProtocol: matrix,
      notCapableOf: { ...NON_CAPABILITIES },

      supportedProtocols: Object.keys(CANDIDATE_PROTOCOLS),
      frameLimits: { ...FRAME_LIMITS },
    };
  }

  // ------------------------------------------------------- begin session

  /** The Box Cam session id is a separate index, so a frame naming the wrong pair is caught, not routed. */
  beginSession({ boxCamSessionId, playerId, protocolId, nonce }) {
    if (this.healthState === 'unavailable' || this.healthState === 'not_configured') {
      return { ok: false, error: PROVIDER_ERRORS.PROVIDER_UNAVAILABLE };
    }
    const candidate = CANDIDATE_PROTOCOLS[protocolId];
    if (!candidate) {
      return { ok: false, error: PROVIDER_ERRORS.UNSUPPORTED_PROTOCOL, protocolId };
    }
    if (!boxCamSessionId || !playerId || !nonce) {
      return { ok: false, error: PROVIDER_ERRORS.INVALID_STATE, detail: 'binding incomplete' };
    }
    if (this.sessions.size >= this.maxConcurrent) {
      this.stats.shed += 1;
      return { ok: false, error: PROVIDER_ERRORS.PROVIDER_BUSY, activeSessions: this.sessions.size };
    }
    if (this.byBoxCamSession.has(boxCamSessionId)) {
      return { ok: false, error: PROVIDER_ERRORS.INVALID_STATE, detail: 'a provider session already exists for this Box Cam session' };
    }

    const s = new ProviderSession({
      providerSessionId: `pcv_${crypto.randomBytes(12).toString('base64url')}`,
      boxCamSessionId, playerId, protocolId,
      eventKind: candidate.eventKind,
      nonce,
      createdAt: this.now(),
      ttlMs: this.ttlMs,
    });
    s.transition('ready');
    s.serverStartedAt = s.createdAt;

    this.sessions.set(s.providerSessionId, s);
    this.byBoxCamSession.set(boxCamSessionId, s.providerSessionId);
    this.stats.created += 1;

    return {
      ok: true,
      providerSessionId: s.providerSessionId,
      state: s.state,
      protocolId,
      eventKind: candidate.eventKind,
      expiresAt: s.expiresAt,
      frameLimits: { ...FRAME_LIMITS },
      combineVerifiedEligible: false,
    };
  }

  get(providerSessionId) {
    const s = this.sessions.get(providerSessionId);
    if (!s || s.disposed) return null;
    return s;
  }

  // -------------------------------------------------------- ingest frame

  /** `frame` is already decoded at the transport boundary, so no base64 string reaches (or is retained by) this. */
  ingestFrame({ providerSessionId, boxCamSessionId, nonce, seq, frame, clientCapturedAtMs = null }) {
    const s = this.get(providerSessionId);
    if (!s) return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND };

    // Every element of the binding is checked, not just the one in the URL.
    if (s.boxCamSessionId !== boxCamSessionId) {
      return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND, detail: 'session binding mismatch' };
    }
    // A client-supplied nonce is only compared, never adopted.
    if (s.nonceBinding !== nonce) {
      return { ok: false, error: PROVIDER_ERRORS.NONCE_INVALID };
    }
    if (s.finalized) {
      return { ok: false, error: PROVIDER_ERRORS.ALREADY_FINALIZED, state: s.state };
    }
    const now = this.now();
    if (now > s.expiresAt) {
      this.#end(s, 'expired');
      return { ok: false, error: PROVIDER_ERRORS.SESSION_EXPIRED };
    }
    if (s.state !== 'ready' && s.state !== 'running') {
      return { ok: false, error: PROVIDER_ERRORS.INVALID_STATE, state: s.state };
    }

    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) {
      s.framesRejected += 1;
      return { ok: false, error: PROVIDER_ERRORS.OUT_OF_ORDER_FRAME, detail: 'sequence must be a positive integer' };
    }
    // A duplicate is rejected before it reaches the engine.
    if (s.seenSeqs.has(n)) {
      s.duplicatesRejected += 1;
      s.framesRejected += 1;
      return { ok: false, error: PROVIDER_ERRORS.DUPLICATE_FRAME, seq: n, lastSeq: s.lastSeq };
    }
    // REORDER_WINDOW is 0: anything not strictly ahead is refused. A reorder buffer has no demonstrated need.
    if (n <= s.lastSeq - REORDER_WINDOW) {
      s.outOfOrderRejected += 1;
      s.framesRejected += 1;
      return { ok: false, error: PROVIDER_ERRORS.OUT_OF_ORDER_FRAME, seq: n, lastSeq: s.lastSeq };
    }

    // An anomalous client clock is counted, then ignored.
    if (clientCapturedAtMs != null) {
      const drift = Math.abs(Number(clientCapturedAtMs) - now);
      if (!Number.isFinite(drift) || drift > 60_000) s.clientClockAnomalies += 1;
    }

    if (s.state === 'ready') s.transition('running');

    // The queue drops oldest and reports it; the drop count feeds observation quality at finalization.
    const before = s.queue.dropped;
    s.queue.push(frame);
    const drained = s.queue.drain();
    const droppedNow = s.queue.dropped - before;
    if (droppedNow > 0) {
      s.framesDroppedByServer += droppedNow;
      this.stats.framesDropped += droppedNow;
    }

    try {
      for (const f of drained) {
        if (this.customProcessFrame) this.customProcessFrame(s.run, f);
        else s.run.processFrame(f);
      }
    } catch (err) {
      // No raw stack reaches the caller; the message is kept server-side for logs.
      s.failure = { at: now, message: String(err && err.message ? err.message : err) };
      this.#end(s, 'failed');
      return { ok: false, error: PROVIDER_ERRORS.ENGINE_FAILURE };
    }

    s.seenSeqs.add(n);
    s.lastSeq = Math.max(s.lastSeq, n);
    s.framesAccepted += 1;
    this.stats.framesAccepted += 1;
    if (s.firstFrameAt == null) s.firstFrameAt = now;
    s.lastFrameAt = now;

    // Bound the replay set; anything older can't be accepted anyway, because `lastSeq` has moved past it.
    if (s.seenSeqs.size > FRAME_LIMITS.maxQueuedFrames * 8) {
      const keep = s.lastSeq - FRAME_LIMITS.maxQueuedFrames * 4;
      for (const v of s.seenSeqs) if (v < keep) s.seenSeqs.delete(v);
    }

    return {
      ok: true,
      seq: n,
      lastSeq: s.lastSeq,
      framesAccepted: s.framesAccepted,
      droppedByServer: s.framesDroppedByServer,
      queueDepth: s.queue.size,
      state: s.state,
    };
  }

  // ----------------------------------------------------------- finalize

  /**
   * Single-shot: a second call returns the same immutable result, or already-finalized for a session that ended some
   * other way.
   */
  finalize({ providerSessionId, boxCamSessionId = null, nonce = null, protocolWindowMs = null }) {
    const s = this.sessions.get(providerSessionId);
    if (!s) return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND };
    if (boxCamSessionId != null && s.boxCamSessionId !== boxCamSessionId) {
      return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND, detail: 'session binding mismatch' };
    }
    if (nonce != null && s.nonceBinding !== nonce) {
      return { ok: false, error: PROVIDER_ERRORS.NONCE_INVALID };
    }
    if (s.result) {
      // Flagged so a caller that persists on first finalize doesn't persist again.
      return { ok: true, alreadyFinalized: true, result: s.result };
    }
    if (s.finalized) {
      return { ok: false, error: PROVIDER_ERRORS.ALREADY_FINALIZED, state: s.state };
    }
    if (!s.transition('finalizing').ok) {
      return { ok: false, error: PROVIDER_ERRORS.INVALID_STATE, state: s.state };
    }

    const now = this.now();
    s.serverEndedAt = now;

    let observation;
    try {
      observation = s.run.finish({ protocolWindowMs });
    } catch (err) {
      s.failure = { at: now, message: String(err && err.message ? err.message : err) };
      this.#end(s, 'failed');
      return { ok: false, error: PROVIDER_ERRORS.ENGINE_FAILURE };
    }

    const result = this.#buildResult(s, observation);
    s.result = Object.freeze(result);
    s.state = result.outcome === 'accepted' ? 'accepted' : 'refused';
    this.stats[s.state] += 1;

    this.#release(s);
    return { ok: true, alreadyFinalized: false, result: s.result };
  }

  /** No raw frame content or anything pixel-wise derived from one: counts, presence, durations, bounded timestamps. */
  #buildResult(s, observation) {
    const accepted = observation.state === 'accepted';
    const conf = observation.confidence ?? {};
    const integrity = observation.integrity ?? {};
    const framesAnalysed = Number(integrity.framesAnalysed ?? 0) || 0;

    const MAX_TRACE = 256;
    const events = Array.isArray(observation.events) ? observation.events : [];
    const trace = events.slice(0, MAX_TRACE).map((e) => ({
      atMs: e.atMs ?? null,
      confidence: e.confidence ?? null,
    }));

    const activeDurationMs = Number(observation.activeMs ?? 0) || 0;

    return {
      sessionId: s.boxCamSessionId,
      providerSessionId: s.providerSessionId,
      protocolId: s.protocolId,
      providerId: this.id,
      providerVersion: this.providerVersion,
      engineVersion: this.engineVersion,
      cvPolicyVersion: this.cvPolicyVersion,

      outcome: accepted ? 'accepted' : 'refused',
      // Chosen by the engine's precedence table; the provider never picks a reason.
      refusalReason: accepted ? null : (observation.primaryReason ?? observation.state ?? 'unknown'),
      refusalDetail: accepted ? null : (observation.detail ?? null),

      observationQuality: {
        // A refused attempt may still carry a quality object; its reasons are the diagnosis.
        sufficient: (observation.observationQuality?.state ?? null) === 'sufficient',
        state: observation.observationQuality?.state ?? null,
        aggregateConfidence: conf.aggregate ?? null,
        coverage: conf.coverage ?? null,
        reasons: observation.observationQuality?.reasons ?? [],
        secondaryDiagnostics: observation.secondaryDiagnostics ?? [],
      },

      derived: {
        // From the engine's integrity counters rather than acceptance, so a refused attempt still reports what was seen.
        personPresent: framesAnalysed > 0 && (integrity.personDetectedFrames ?? 0) / framesAnalysed >= 0.5,
        ballPresent: framesAnalysed > 0 && (integrity.ballDetectedFrames ?? 0) / framesAnalysed >= 0.5,
        // Named so it doesn't read as a published measurement.
        touchCount: s.eventKind === 'touch' ? (observation.count ?? null) : null,
        juggleCount: s.eventKind === 'juggle' ? (observation.count ?? null) : null,
        activeDurationMs,
      },

      // Experimental until real-world validation passes; the label travels with the number.
      experimental: {
        exactCount: observation.count ?? null,
        status: 'experimental_unvalidated',
        note: 'Experimental observation. Not a standardised Combine measurement.',
      },

      integrity: {
        ok: !s.failure,
        framesAccepted: s.framesAccepted,
        framesRejected: s.framesRejected,
        framesDroppedByServer: s.framesDroppedByServer,
        duplicatesRejected: s.duplicatesRejected,
        outOfOrderRejected: s.outOfOrderRejected,
        clientClockAnomalies: s.clientClockAnomalies,
        framesAnalysed: framesAnalysed || null,
        duplicateFrames: integrity.duplicateFrames ?? null,
        effectiveFps: integrity.effectiveFps ?? null,
        maxBallGapMs: integrity.maxBallGapMs ?? null,
        nonceBound: true,
        serverTimeline: true,
      },

      trace,
      traceTruncated: events.length > MAX_TRACE,

      serverStartedAt: s.serverStartedAt,
      serverEndedAt: s.serverEndedAt,
      serverDurationMs: Math.max(0, (s.serverEndedAt ?? 0) - (s.serverStartedAt ?? 0)),

      combineVerified: false,
      combineVerifiedBlockedBy: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    };
  }

  // ------------------------------------------------------------- cancel

  cancel({ providerSessionId, boxCamSessionId = null }) {
    const s = this.sessions.get(providerSessionId);
    if (!s) return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND };
    if (boxCamSessionId != null && s.boxCamSessionId !== boxCamSessionId) {
      return { ok: false, error: PROVIDER_ERRORS.SESSION_NOT_FOUND };
    }
    if (s.finalized) return { ok: true, alreadyFinalized: true, state: s.state };
    this.#end(s, 'cancelled');
    // A cancelled attempt mints no result.
    return { ok: true, alreadyFinalized: false, state: s.state, result: null };
  }

  /** Session id lookup by Box Cam session, for route handlers. */
  forBoxCamSession(boxCamSessionId) {
    const id = this.byBoxCamSession.get(boxCamSessionId);
    return id ? this.get(id) : null;
  }

  /** Sweep whatever has outlived its TTL. */
  sweep(nowMs = this.now()) {
    let swept = 0;
    for (const [, s] of this.sessions) {
      if (!s.finalized && nowMs > s.expiresAt) { this.#end(s, 'expired'); swept += 1; }
    }
    return swept;
  }

  footprint() {
    let queued = 0, detections = 0, seqs = 0;
    for (const s of this.sessions.values()) {
      const f = s.footprint();
      queued += f.queuedFrames; detections += f.detections; seqs += f.seenSeqs;
    }
    return {
      activeSessions: this.sessions.size,
      boxCamIndexSize: this.byBoxCamSession.size,
      queuedFrames: queued, detections, seenSeqs: seqs,
      stats: { ...this.stats },
    };
  }

  disposeAll() {
    for (const s of [...this.sessions.values()]) this.#end(s, 'cancelled');
    this.sessions.clear();
    this.byBoxCamSession.clear();
  }

  #end(s, state) {
    if (s.finalized) return;
    s.state = state;
    s.result = null;
    if (this.stats[state] != null) this.stats[state] += 1;
    this.#release(s);
  }

  #release(s) {
    s.dispose();
    this.sessions.delete(s.providerSessionId);
    this.byBoxCamSession.delete(s.boxCamSessionId);
  }
}

/** Built in, with no model file or configuration, so it reports `ready`; Combine verification stays closed. */
let singleton = null;
export function productionCvProvider() {
  if (!singleton) singleton = new ProductionCvProvider();
  return singleton;
}
export function resetProductionCvProvider() {
  if (singleton) singleton.disposeAll();
  singleton = null;
}
