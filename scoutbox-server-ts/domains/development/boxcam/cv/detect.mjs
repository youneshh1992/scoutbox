// Layer 1: one frame in, observed objects out. It is never passed a protocol id, so a learned detector could replace
// it without touching protocol semantics. A person is a bounding box and an area, nothing that could identify them.

import { DETECTION } from './policy.mjs';
import { frameStats, meanAbsDiff } from './frames.mjs';

/** Bright-blob threshold: only bright, round things are sought. */
export function brightThreshold(stats) {
  return Math.min(250, stats.mean + Math.max(DETECTION.ballMinContrast, stats.stdDev * 1.6));
}

/** Four-connected scan above `thr`, with a component cap so a pathological frame can't produce unbounded work. */
function components(frame, thr, { maxComponents = 64 } = {}) {
  const { w, h, pixels } = frame;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < pixels.length && out.length < maxComponents; i += 1) {
    if (seen[i] || pixels[i] < thr) continue;
    let sp = 0;
    stack[sp] = i;
    sp += 1;
    seen[i] = 1;
    let count = 0,
      sumX = 0,
      sumY = 0;
    let minX = w,
      maxX = -1,
      minY = h,
      maxY = -1;
    while (sp > 0) {
      sp -= 1;
      const p = stack[sp];
      const x = p % w;
      const y = (p - x) / w;
      count += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && pixels[p - 1] >= thr) {
        seen[p - 1] = 1;
        stack[sp] = p - 1;
        sp += 1;
      }
      if (x < w - 1 && !seen[p + 1] && pixels[p + 1] >= thr) {
        seen[p + 1] = 1;
        stack[sp] = p + 1;
        sp += 1;
      }
      if (y > 0 && !seen[p - w] && pixels[p - w] >= thr) {
        seen[p - w] = 1;
        stack[sp] = p - w;
        sp += 1;
      }
      if (y < h - 1 && !seen[p + w] && pixels[p + w] >= thr) {
        seen[p + w] = 1;
        stack[sp] = p + w;
        sp += 1;
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    out.push({
      count,
      cx: sumX / count,
      cy: sumY / count,
      bw,
      bh,
      roundness: (count / (bw * bh)) * (Math.min(bw, bh) / Math.max(bw, bh)),
    });
  }
  return out;
}

/** Ball candidate, plus the count of comparable rivals (the multiple-ball check needs that). */
export function detectBall(frame, stats) {
  const area = frame.w * frame.h;
  const comps = components(frame, brightThreshold(stats));
  const candidates = comps.filter((c) => {
    const frac = c.count / area;
    return (
      frac >= DETECTION.ballMinAreaFrac &&
      frac <= DETECTION.ballMaxAreaFrac &&
      c.roundness >= DETECTION.ballMinRoundness
    );
  });
  if (candidates.length === 0) return { ball: null, rivals: 0 };
  candidates.sort((a, b) => b.roundness * b.count - a.roundness * a.count || a.cx - b.cx || a.cy - b.cy);
  const best = candidates[0];
  const rivals = candidates.filter((c, i) => i > 0 && c.count >= best.count * 0.6).length;
  const r = Math.sqrt(best.count / Math.PI);
  return {
    ball: {
      x: best.cx,
      y: best.cy,
      r,
      diameter: r * 2, // the ruler every downstream threshold uses
      confidence: Math.max(0, Math.min(1, best.roundness * 0.8 + Math.min(1, stats.stdDev / 40) * 0.2)),
    },
    rivals,
  };
}

/**
 * Excludes ball-bright pixels, or the ball sits inside the region and every proximity test passes trivially. No
 * landmarks, keypoints or descriptor that could be matched against another person.
 */
export function detectPerson(frame, stats) {
  const area = frame.w * frame.h;
  const { w, h, pixels } = frame;
  const bright = brightThreshold(stats);
  const dev = Math.max(12, stats.stdDev * 0.8);
  let count = 0,
    sumX = 0,
    sumY = 0;
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1;
  for (let i = 0; i < pixels.length; i += 1) {
    if (pixels[i] >= bright) continue;
    if (Math.abs(pixels[i] - stats.mean) < dev) continue;
    const x = i % w;
    const y = (i - x) / w;
    count += 1;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count / area < DETECTION.personMinAreaFrac) return null;
  return {
    x0: minX,
    y0: minY,
    x1: maxX,
    y1: maxY,
    cx: sumX / count,
    cy: sumY / count,
    areaFrac: count / area,
    // Fill ratio: two separated people share one wide box they barely fill.
    fill: count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1)),
  };
}

/** `prevFrame` is used only for the inter-frame difference and isn't retained. */
export function detectFrame(frame, prevFrame = null) {
  const stats = frameStats(frame);
  const tooDark = stats.mean < DETECTION.minMeanLuma || stats.stdDev < DETECTION.minLumaStdDev;
  const diff = prevFrame ? meanAbsDiff(prevFrame, frame) : null;
  if (tooDark) {
    return {
      w: frame.w,
      h: frame.h,
      atMs: frame.atMs,
      seq: frame.seq,
      ball: null,
      person: null,
      rivals: 0,
      visibility: { usable: false, reason: 'too_dark', meanLuma: stats.mean, stdDev: stats.stdDev },
      interFrameDiff: diff,
    };
  }
  const { ball, rivals } = detectBall(frame, stats);
  const person = detectPerson(frame, stats);
  return {
    w: frame.w,
    h: frame.h,
    atMs: frame.atMs,
    seq: frame.seq,
    ball,
    person,
    rivals,
    visibility: { usable: true, reason: null, meanLuma: stats.mean, stdDev: stats.stdDev },
    interFrameDiff: diff,
  };
}
