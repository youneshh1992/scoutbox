// Each attempt must start and end clean. A new object isn't enough if runs are pooled, so reset is one explicit
// function, tested against a fresh instance field by field. Runtime state is keyed by session id only: one player
// may have two sessions open.

import { ObservationRun } from './engine.mjs';
import { FrameQueue } from './frames.mjs';
import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from './policy.mjs';

/** Every mutable field of a run; adding one to ObservationRun without adding it here fails the reset test. */
export const MUTABLE_RUN_KEYS = Object.freeze([
  'detections',
  'prev',
  'seenHashes',
  'duplicates',
  'framesSeen',
  'staticRun',
  'maxStaticRun',
  'finished',
]);

/** Identity and configuration survive a reset. */
export const PERSISTENT_RUN_KEYS = Object.freeze(['eventKind']);

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

/** Sets and arrays reduced to contents, so fresh and reset instances deep-compare without object identity. */
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

export const SESSION_RUNTIME_STATES = Object.freeze(['active', 'finalized', 'cancelled', 'expired', 'disconnected']);

/** Everything one attempt allocates lives here, so cleanup releases one thing. */
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

  /** Idempotent: a second call changes nothing and must not throw or corrupt a counter. */
  dispose() {
    if (this.disposed) return false; // already clean; report "no work done"
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

/** `pool` recycles finished runs through `resetRun()`, so the reuse hazard can be tested. */
export class ObservationSessions {
  constructor({ ttlMs = 5 * 60_000, pool = false, maxPool = 8 } = {}) {
    this.sessions = new Map(); // sessionId -> SessionRuntime
    this.ttlMs = ttlMs;
    this.poolEnabled = pool;
    this.pool = [];
    this.maxPool = maxPool;
    this.stats = { created: 0, finalized: 0, cancelled: 0, expired: 0, disconnected: 0, pooledReuses: 0 };
  }

  create({ sessionId, eventKind, nowMs = Date.now() }) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`);
    }
    const rt = new SessionRuntime({ sessionId, eventKind, createdAtMs: nowMs, ttlMs: this.ttlMs });
    if (this.poolEnabled && this.pool.length) {
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

  cancel(sessionId) {
    return this.#end(sessionId, 'cancelled');
  }
  expire(sessionId) {
    return this.#end(sessionId, 'expired');
  }
  disconnect(sessionId) {
    return this.#end(sessionId, 'disconnected');
  }

  /** Sweep whatever has outlived its TTL. */
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
    // Ending twice is harmless and reports that nothing more was done.
    if (rt.disposed) return { ok: true, alreadyClean: true };
    rt.state = state;
    // A cancelled, expired or disconnected attempt mints no result.
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

  /** The leak test reads this. */
  footprint() {
    let queued = 0,
      detections = 0,
      timers = 0;
    for (const rt of this.sessions.values()) {
      const f = rt.footprint();
      queued += f.queuedFrames;
      detections += f.detections;
      timers += f.timers;
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
