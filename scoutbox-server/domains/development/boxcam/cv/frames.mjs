// M22 — frame intake: validation, decoding, bounded buffering.
//
// This is the only place in ScoutBox where a pixel enters the server, so it
// is written defensively and kept small enough to read in one sitting.
//
// Two privacy invariants hold here and are asserted by the suite:
//   * a decoded frame NEVER leaves this module's caller chain, and
//   * no frame, and nothing derived pixel-wise from a frame, is persisted or
//     logged (§9, §112, §18/§19 of the threat model).
//
// A frame's entire lifetime is: validate → decode into a Uint8Array →
// hand to the engine → drop the reference. Nothing writes it anywhere.

import crypto from 'node:crypto';
import { FRAME_ENCODING, FRAME_LIMITS } from './policy.mjs';

export const FRAME_ERRORS = Object.freeze({
  ENCODING_UNSUPPORTED: 'ENCODING_UNSUPPORTED',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  FRAME_MALFORMED: 'FRAME_MALFORMED',
  FRAME_DIMENSIONS_INVALID: 'FRAME_DIMENSIONS_INVALID',
  FRAME_LENGTH_MISMATCH: 'FRAME_LENGTH_MISMATCH',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
});

/**
 * Validate and decode one frame envelope.
 *
 * Returns `{ ok: true, frame }` or `{ ok: false, error, detail }`. It never
 * throws on hostile input: a caller that has to wrap this in try/catch will
 * eventually forget to, and a decoder that throws is a decoder that can be
 * used to crash a route (§87).
 */
export function decodeFrame(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'frame is not an object' };
  }
  // §83: exactly one documented encoding. Anything else is refused by name
  // rather than sniffed — there is deliberately no format detection here.
  if (raw.encoding !== FRAME_ENCODING) {
    return {
      ok: false,
      error: FRAME_ERRORS.ENCODING_UNSUPPORTED,
      detail: `only "${FRAME_ENCODING}" is accepted`,
    };
  }
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isInteger(w) || !Number.isInteger(h)
    || w < FRAME_LIMITS.minWidth || h < FRAME_LIMITS.minHeight
    || w > FRAME_LIMITS.maxWidth || h > FRAME_LIMITS.maxHeight) {
    return {
      ok: false,
      error: FRAME_ERRORS.FRAME_DIMENSIONS_INVALID,
      detail: `w/h must be integers within ${FRAME_LIMITS.minWidth}x${FRAME_LIMITS.minHeight}..${FRAME_LIMITS.maxWidth}x${FRAME_LIMITS.maxHeight}`,
    };
  }
  const expected = w * h;
  if (expected > FRAME_LIMITS.maxBytes) {
    return { ok: false, error: FRAME_ERRORS.FRAME_TOO_LARGE, detail: `${expected} > ${FRAME_LIMITS.maxBytes}` };
  }
  if (typeof raw.data !== 'string') {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'data must be a base64 string' };
  }
  // Refuse on the ENCODED length before allocating, so an oversized payload
  // never becomes a large buffer (§82, §21 of the threat model).
  if (raw.data.length > Math.ceil(FRAME_LIMITS.maxBytes / 3) * 4 + 8) {
    return { ok: false, error: FRAME_ERRORS.FRAME_TOO_LARGE, detail: 'encoded frame exceeds the byte cap' };
  }
  let buf;
  try {
    buf = Buffer.from(raw.data, 'base64');
  } catch {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'data is not decodable base64' };
  }
  // Node's base64 decoder is lenient: it silently ignores characters outside
  // the alphabet instead of failing. The length check below is therefore the
  // real validation, and it is exact — a gray8 plane is w*h bytes, no more
  // and no less. This is what makes "there is no parser to attack" true.
  if (buf.length !== expected) {
    return {
      ok: false,
      error: FRAME_ERRORS.FRAME_LENGTH_MISMATCH,
      detail: `expected ${expected} bytes for ${w}x${h}, decoded ${buf.length}`,
    };
  }
  const atMs = Number(raw.atMs);
  if (!Number.isFinite(atMs) || atMs < 0) {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'atMs must be a non-negative number' };
  }
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq < 0) {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'seq must be a non-negative integer' };
  }
  return {
    ok: true,
    frame: {
      seq,
      atMs,
      w,
      h,
      pixels: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
      // Content hash: the defence against T7 (duplicate frames inflating a
      // count). It is a hash of PIXELS, which is derived data and not an
      // image — it cannot be inverted into a picture, and it is never stored
      // on the session record.
      hash: crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 22),
    },
  };
}

/**
 * A bounded, session-scoped frame queue.
 *
 * §76/§77: capacity is fixed. When full, the documented policy is to DROP
 * THE OLDEST and record the drop, never to grow. Dropping is visible in the
 * integrity record, so an attempt that was only partly observed cannot
 * quietly present itself as fully observed.
 *
 * Keyed by session id by construction: an instance belongs to exactly one
 * session and is discarded with it (§74/§75).
 */
export class FrameQueue {
  constructor({ capacity = FRAME_LIMITS.maxQueuedFrames } = {}) {
    this.capacity = capacity;
    this.items = [];
    this.dropped = 0;
    this.accepted = 0;
  }

  push(frame) {
    this.items.push(frame);
    this.accepted += 1;
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
    return this;
  }

  drain() {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Release every reference. Called on finalize and on teardown (§153). */
  clear() {
    this.items = [];
  }

  get size() { return this.items.length; }
}

/** Cheap whole-frame statistics, computed once and reused (§31 visibility). */
export function frameStats(frame) {
  const px = frame.pixels;
  let sum = 0;
  for (let i = 0; i < px.length; i += 1) sum += px[i];
  const mean = sum / px.length;
  let varSum = 0;
  for (let i = 0; i < px.length; i += 1) {
    const d = px[i] - mean;
    varSum += d * d;
  }
  return { mean, stdDev: Math.sqrt(varSum / px.length) };
}

/** Mean absolute inter-frame difference — the static/frozen detector (§T8). */
export function meanAbsDiff(a, b) {
  if (!a || !b || a.pixels.length !== b.pixels.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.pixels.length; i += 1) {
    sum += Math.abs(a.pixels[i] - b.pixels[i]);
  }
  return sum / a.pixels.length;
}
