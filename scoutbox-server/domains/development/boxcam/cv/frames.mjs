// The only place a pixel enters the server. A frame is validated, decoded into a Uint8Array, handed to the engine and
// dropped; no frame, or anything derived pixel-wise from one, is persisted or logged.

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

/** Never throws on hostile input, so it can't be used to crash a route. */
export function decodeFrame(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'frame is not an object' };
  }
  // One encoding; anything else is refused by name, not sniffed.
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
  // Refuse on the encoded length before allocating.
  if (raw.data.length > Math.ceil(FRAME_LIMITS.maxBytes / 3) * 4 + 8) {
    return { ok: false, error: FRAME_ERRORS.FRAME_TOO_LARGE, detail: 'encoded frame exceeds the byte cap' };
  }
  let buf;
  try {
    buf = Buffer.from(raw.data, 'base64');
  } catch {
    return { ok: false, error: FRAME_ERRORS.FRAME_MALFORMED, detail: 'data is not decodable base64' };
  }
  // Node's base64 decoder silently ignores characters outside the alphabet, so the exact w*h length check below is
  // the real validation.
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
      // Defends against duplicates inflating a count. A pixel hash can't be inverted into a picture and isn't stored.
      hash: crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 22),
    },
  };
}

/** When full it drops the oldest and records the drop, so a partly observed attempt can't pass as fully observed. */
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

  clear() {
    this.items = [];
  }

  get size() { return this.items.length; }
}

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

/** Mean absolute inter-frame difference: the static/frozen detector. */
export function meanAbsDiff(a, b) {
  if (!a || !b || a.pixels.length !== b.pixels.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.pixels.length; i += 1) {
    sum += Math.abs(a.pixels[i] - b.pixels[i]);
  }
  return sum / a.pixels.length;
}
