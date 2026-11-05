// M22 — observation session runtime: creation, reset, isolation, cleanup.
//
// The rule this file exists to enforce:
//
//   Before ScoutBox learns to verify more, prove that each attempt starts
//   clean, ends clean, and cannot inherit certainty from missing observations
//   or another session.
//
// Two failure modes are guarded here, and they are different:
//
//   1. STATE LEAK BETWEEN SESSIONS. The obvious defence is "make a new
//      object", and it is not enough: a runtime that pools or recycles
//      tracker instances silently defeats it. So the reset contract is
//      explicit, single-entry, and tested by comparing a RESET instance
//      against a FRESH one field by field (§3, §5).
//
//   2. RESOURCE LEAK. A session that is cancelled, expires or whose client
//      vanishes must release everything it holds, and releasing twice must
//      be harmless (§11–§14).
//
// Runtime state is keyed by session id ONLY (§7). Never by player, protocol
// or organisation — one player may legitimately have two sessions open, and
// keying by anything coarser silently merges them.

import { ObservationRun } from './engine.mjs';
import { FrameQueue } from './frames.mjs';
import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from './policy.mjs';

/**
 * The canonical initial value of every mutable field an observation run
 * holds. `resetRun()` restores exactly this, and the completeness test
 * compares a reset instance against a fresh one using these keys.
 *
 * Adding a mutable field to ObservationRun without adding it here makes
 * `assertResetStateEqualsFreshState()` fail — which is the point (§5).
 */
export const MUTABLE_RUN_KEYS = Object.freeze([
  'detections', 'prev', 'seenHashes', 'duplicates', 'framesSeen',
  'staticRun', 'maxStaticRun', 'finished',
]);

/** Fields that deliberately survive a reset: identity and configuration. */
export const PERSISTENT_RUN_KEYS = Object.freeze(['eventKind']);

/**
 * THE reset contract (§4). One function, not scattered assignments.
 *
 * Restores every mutable field to its canonical initial value while leaving
 * configuration alone, so a recycled instance is indistinguishable from a
 * new one.
 */
export function resetRun(run) {
  run.detections = [];
  run.prev = null;
  run.seenHashes = new Set();
  run.duplicates = 0;
  run.framesSeen = 0;
  run.staticRun = 0;
  run.maxStaticRun = 0;
  run.finished = false;
  return run;
}

/**
 * A comparable snapshot of a run's mutable state.
 *
 * Sets and arrays are reduced to sizes and contents so that a fresh instance
 * and a reset instance can be deep-compared without object identity getting
 * in the way.
 */
export function runStateSnapshot(run) {
  return {
    detections: run.detections.length,
    prev: run.prev === null ? null : 'frame',
    seenHashes: run.seenHashes.size,
    duplicates: run.duplicates,
    framesSeen: run.framesSeen,
    staticRun: run.staticRun,
    maxStaticRun: run.maxStaticRun,
    finished: run.finished,
  };
}

// =========================================================================
// Session runtime
// =========================================================================

export const SESSION_RUNTIME_STATES = Object.freeze([
  'active', 'finalized', 'cancelled', 'expired', 'disconnected',
]);

/**
 * One session's runtime footprint. Everything the observation of a single
 * attempt allocates lives on this object and nowhere else, so cleanup is a
 * matter of releasing one thing rather than remembering seven.
 */
class SessionRuntime {
  constructor({ sessionId, eventKind, createdAtMs, ttlMs }) {
    this.sessionId = sessionId;
    this.eventKind = eventKind;
    this.createdAtMs = createdAtMs;
    this.ttlMs = ttlMs;
    this.state = 'active';
    this.run = new ObservationRun({ eventKind });
    this.queue = new FrameQueue();
    this.diagnostics = [];
    this.timers = new Set();
    this.disposed = false;
    this.result = null;
  }

  /**
   * Release everything. Idempotent by construction (§14): a second call
   * finds the fields already empty and changes nothing, and must not throw,
   * double-resolve or corrupt a counter.
   */
  dispose() {
    if (this.disposed) return false;      // already clean; report "no work done"
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue.clear();
    if (this.run && typeof this.run.dispose === 'function') this.run.dispose();
    this.run = null;
    this.diagnostics = [];
    this.disposed = true;
    return true;
  }

  footprint() {
    return {
      queuedFrames: this.queue ? this.queue.size : 0,
      detections: this.run ? this.run.detections.length : 0,
      diagnostics: this.diagnostics.length,
      timers: this.timers.size,
      disposed: this.disposed,
    };
  }
}

/**
 * The registry.
 *
 * `pool` exists so the reuse hazard can be TESTED rather than assumed away
 * (§3). When pooling is enabled, finished runs are recycled through
 * `resetRun()` instead of discarded — which is exactly the arrangement that
 * would leak state if the reset contract were incomplete.
 */
export class ObservationSessions {
  constructor({ ttlMs = 5 * 60_000, pool = false, maxPool = 8 } = {}) {
    this.sessions = new Map();          // sessionId -> SessionRuntime
    this.ttlMs = ttlMs;
    this.poolEnabled = pool;
    this.pool = [];
    this.maxPool = maxPool;
    this.stats = { created: 0, finalized: 0, cancelled: 0, expired: 0, disconnected: 0, pooledReuses: 0 };
  }

  /** §7/§8 — keyed by session id only. */
  create({ sessionId, eventKind, nowMs = Date.now() }) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`);
    }
    const rt = new SessionRuntime({ sessionId, eventKind, createdAtMs: nowMs, ttlMs: this.ttlMs });
    if (this.poolEnabled && this.pool.length) {
      // Recycle a previously used run object through the reset contract.
      const recycled = this.pool.pop();
      recycled.eventKind = eventKind;
      resetRun(recycled);
      rt.run = recycled;
      this.stats.pooledReuses += 1;
    }
    this.sessions.set(sessionId, rt);
    this.stats.created += 1;
    return rt;
  }

  get(sessionId) {
    const rt = this.sessions.get(sessionId);
    if (!rt || rt.disposed) return null;
    return rt;
  }

  /**
   * §9 — an id that is not currently live is simply not found. There is no
   * path that resurrects a disposed runtime, and none that attaches a frame
   * to a session other than the one named.
   */
  ingest({ sessionId, frame, nowMs = Date.now() }) {
    const rt = this.get(sessionId);
    if (!rt) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (rt.state !== 'active') return { ok: false, error: 'SESSION_NOT_ACTIVE', state: rt.state };
    if (nowMs - rt.createdAtMs > rt.ttlMs) {
      this.expire(sessionId);
      return { ok: false, error: 'SESSION_EXPIRED' };
    }
    rt.queue.push(frame);
    const drained = rt.queue.drain();
    const acks = drained.map((f) => rt.run.processFrame(f));
    return { ok: true, acks, droppedByBackpressure: rt.queue.dropped };
  }

  finalize({ sessionId, protocolWindowMs = null }) {
    const rt = this.get(sessionId);
    if (!rt) return { ok: false, error: 'SESSION_NOT_FOUND' };
    const result = rt.run.finish({ protocolWindowMs });
    rt.result = result;
    rt.state = 'finalized';
    this.stats.finalized += 1;
    this.#release(rt);
    return { ok: true, result };
  }

  cancel(sessionId) { return this.#end(sessionId, 'cancelled'); }
  expire(sessionId) { return this.#end(sessionId, 'expired'); }
  disconnect(sessionId) { return this.#end(sessionId, 'disconnected'); }

  /** §12 — sweep whatever has outlived its TTL. No stale object lingers. */
  sweep(nowMs = Date.now()) {
    let swept = 0;
    for (const [id, rt] of this.sessions) {
      if (rt.state === 'active' && nowMs - rt.createdAtMs > rt.ttlMs) {
        this.expire(id);
        swept += 1;
      }
    }
    return swept;
  }

  #end(sessionId, state) {
    const rt = this.sessions.get(sessionId);
    if (!rt) return { ok: false, error: 'SESSION_NOT_FOUND' };
    // §14: ending twice is harmless and reports that nothing more was done.
    if (rt.disposed) return { ok: true, alreadyClean: true };
    rt.state = state;
    // A cancelled, expired or disconnected attempt mints NO result (§47).
    rt.result = null;
    this.stats[state] += 1;
    this.#release(rt);
    return { ok: true, alreadyClean: false };
  }

  #release(rt) {
    const run = rt.run;
    rt.dispose();
    if (this.poolEnabled && run && this.pool.length < this.maxPool) {
      this.pool.push(resetRun(run));
    }
    this.sessions.delete(rt.sessionId);
  }

  /** What the runtime is currently holding — the leak test reads this. */
  footprint() {
    let queued = 0, detections = 0, timers = 0;
    for (const rt of this.sessions.values()) {
      const f = rt.footprint();
      queued += f.queuedFrames; detections += f.detections; timers += f.timers;
    }
    return {
      activeSessions: this.sessions.size,
      queuedFrames: queued,
      detections,
      timers,
      pooled: this.pool.length,
      stats: { ...this.stats },
    };
  }

  /** Release everything, for teardown. */
  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.#end(id, 'cancelled');
    this.pool = [];
  }
}

export const RUNTIME_VERSIONS = Object.freeze({
  engineVersion: CV_ENGINE_VERSION,
  policyVersion: BOX_CAM_CV_POLICY_VERSION,
});
