// M22 — parametric synthetic scene generator (Fix A, §2).
//
// The first fixture set hard-coded one geometry at one size at one cadence.
// That is exactly how a detector gets overfitted to its own test data: every
// threshold quietly tuned to 240x180 with a 6-pixel ball at 12 fps, and no
// way to tell because nothing else was ever rendered.
//
// So geometry here is defined in NORMALISED coordinates — 0..1 across the
// frame, ball radius as a fraction of the short side — and resolution,
// cadence, contrast, camera behaviour and motion are independent parameters.
// The same physical scene can then be rendered at any supported size and
// frame rate, which is what makes the invariance families meaningful rather
// than decorative.
//
// Still synthetic. Still rendered geometry. Varying a rendering twelve ways
// does not make it football, and nothing here changes the real-world
// validation blocker.

/** Deterministic PRNG — every fixture must be byte-identical on every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * Render one frame from normalised geometry.
 *
 * `ballsN`  : [{x, y, rN}]   x,y in 0..1; rN = radius / min(w,h)
 * `peopleN` : [{x0,y0,x1,y1, luma}] all in 0..1
 */
export function renderNormalised({
  w, h, bgLuma = 130, noise = 6, ballsN = [], peopleN = [],
  ballLuma = 242, gain = 1, rng, textureBands = 0,
}) {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i += 1) {
    px[i] = clamp8((bgLuma + (rng() - 0.5) * 2 * noise) * gain);
  }
  // Optional high-contrast background structure, well away from the player,
  // to prove the detector is not simply finding "the brightest thing".
  if (textureBands > 0) {
    for (let b = 0; b < textureBands; b += 1) {
      const x0 = Math.floor((b + 0.5) * (w * 0.18) / textureBands);
      for (let y = 0; y < Math.floor(h * 0.35); y += 1) {
        for (let x = x0; x < Math.min(w, x0 + 3); x += 1) {
          px[y * w + x] = clamp8(210 * gain);
        }
      }
    }
  }
  for (const p of peopleN) {
    const x0 = Math.round(p.x0 * w), x1 = Math.round(p.x1 * w);
    const y0 = Math.round(p.y0 * h), y1 = Math.round(p.y1 * h);
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y += 1) {
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x += 1) {
        px[y * w + x] = clamp8((p.luma ?? 55) * gain + (rng() - 0.5) * 4);
      }
    }
  }
  const short = Math.min(w, h);
  for (const b of ballsN) {
    const r = Math.max(2, b.rN * short);
    const cx = b.x * w, cy = b.y * h;
    const luma = b.luma ?? ballLuma;
    // `blur` approximates motion blur by fading the rim, which lowers the
    // effective contrast and roundness exactly as a fast-moving ball does.
    const blur = b.blur ?? 0;
    for (let y = Math.max(0, Math.floor(cy - r - blur)); y <= Math.min(h - 1, Math.ceil(cy + r + blur)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - r - blur)); x <= Math.min(w - 1, Math.ceil(cx + r + blur)); x += 1) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) {
          px[y * w + x] = clamp8(luma * gain);
        } else if (blur > 0 && d <= r + blur) {
          const f = 1 - (d - r) / blur;
          px[y * w + x] = clamp8((px[y * w + x] * (1 - f) + luma * f) * (gain === 1 ? 1 : gain));
        }
      }
    }
  }
  return { w, h, px };
}

export function envelope(scene, seq, atMs) {
  return {
    encoding: 'gray8', seq, atMs, w: scene.w, h: scene.h,
    data: Buffer.from(scene.px).toString('base64'),
  };
}

// ------------------------------------------------------- default geometry
// Normalised, so it renders identically at any supported size.
export const DEFAULT_PERSON = Object.freeze({ x0: 0.40, y0: 0.32, x1: 0.54, y1: 0.93, luma: 55 });
export const DEFAULT_BALL_RN = 0.033;      // ~6 px at 180 high, ~8 px at 240

/**
 * Build a frame sequence from a normalised motion function.
 *
 * `path(tMs)` returns `{x, y}` in normalised coordinates, or `null` when the
 * ball should be absent (occlusion).
 */
export function sequence({
  w = 240, h = 180, fps = 12, durationMs = 4800,
  path, rN = DEFAULT_BALL_RN, ballLuma = 242, bgLuma = 130, noise = 6,
  person = DEFAULT_PERSON, personAt = null,
  cameraShakeN = 0, cameraDrift = null, cameraScale = null,
  gain = 1, textureBands = 0, seed = 7, blur = 0,
  dropFrame = null, jitterMs = 0, extraBalls = null, extraPeople = null,
} = {}) {
  const rng = mulberry32(seed);
  const jitterRng = mulberry32(seed ^ 0x9e3779b9);
  const dtMs = 1000 / fps;
  const frames = [];
  let seq = 0;
  let i = 0;
  for (let t = 0; t <= durationMs; t += dtMs) {
    const idx = i; i += 1;
    if (dropFrame && dropFrame(idx, t)) continue;
    // Cadence jitter: real capture is never perfectly periodic (§22).
    const at = Math.round(t + (jitterMs ? (jitterRng() - 0.5) * 2 * jitterMs : 0));

    // Rigid camera motion applies to EVERYTHING in frame, which is what
    // makes it cancel in the player-relative frame.
    const shake = cameraShakeN
      ? { dx: (rng() - 0.5) * 2 * cameraShakeN, dy: (rng() - 0.5) * 2 * cameraShakeN }
      : { dx: 0, dy: 0 };
    const drift = cameraDrift ? cameraDrift(t) : { dx: 0, dy: 0 };
    const scale = cameraScale ? cameraScale(t) : 1;

    const p = personAt ? personAt(t) : person;
    const pShift = {
      x0: (p.x0 - 0.5) * scale + 0.5 + shake.dx + drift.dx,
      x1: (p.x1 - 0.5) * scale + 0.5 + shake.dx + drift.dx,
      y0: (p.y0 - 0.5) * scale + 0.5 + shake.dy + drift.dy,
      y1: (p.y1 - 0.5) * scale + 0.5 + shake.dy + drift.dy,
      luma: p.luma,
    };
    const peopleN = [pShift, ...(extraPeople ? extraPeople(t) : [])];

    const pos = path ? path(t) : null;
    const ballsN = [];
    if (pos) {
      ballsN.push({
        x: (pos.x - 0.5) * scale + 0.5 + shake.dx + drift.dx,
        y: (pos.y - 0.5) * scale + 0.5 + shake.dy + drift.dy,
        rN: (pos.rN ?? rN) * scale,
        luma: pos.luma ?? ballLuma,
        blur: pos.blur ?? blur,
      });
    }
    if (extraBalls) ballsN.push(...extraBalls(t, { shake, drift, scale }));

    frames.push(envelope(
      renderNormalised({ w, h, bgLuma, noise, ballsN, peopleN, ballLuma, gain, rng, textureBands }),
      seq, at,
    ));
    seq += 1;
  }
  return frames;
}

// ------------------------------------------------------------ motion paths
//
// Each returns a `path(tMs)` in normalised coordinates. Ground truth is the
// number of contacts the path CONTAINS by construction, declared by the
// caller — never read back out of the engine (§3).

/** Juggling: parabolic flights between contacts at a fixed period. */
export function jugglePath({ contacts = 8, periodMs = 600, apexFrac = 0.30, x = 0.47, contactY = 0.83 }) {
  const apexY = contactY - apexFrac;
  return (t) => {
    if (t > contacts * periodMs) return { x, y: contactY };
    const phase = (t % periodMs) / periodMs;
    return { x, y: contactY - 4 * (contactY - apexY) * phase * (1 - phase) };
  };
}

/**
 * Ground touches, modelled the way a touch physically works.
 *
 * At each contact the ball receives an IMPULSE — its velocity changes
 * abruptly — and then decays smoothly to rest under friction before the next
 * contact. Direction alternates, so the ball stays beside the player.
 *
 * This replaced a triangle-wave path, and the reason matters. A triangle wave
 * contains TWO velocity reversals per cycle: the strike near the player, and
 * the turn at the far end of the excursion. With a small excursion both fall
 * inside contact range, so "ten touches" was never an unambiguous ground
 * truth — the path contained ten strikes and ten returns, and the engine was
 * being marked against a number the geometry did not actually encode. A
 * fixture whose own ground truth is ambiguous cannot judge a detector, and
 * the temptation when it disagrees is to adjust the detector.
 *
 * Here each touch contributes exactly one sharp velocity change. The decay is
 * gradual by construction, so friction cannot be mistaken for a second
 * contact.
 *
 * `periodMs`  — the pace: time between contacts.
 * `impulseN`  — velocity imparted, in normalised units per second.
 * `tauMs`     — friction time constant; the ball travels impulseN * tau and
 *               settles within roughly 4*tau. Kept short enough that the ball
 *               is at rest before the next contact even at the fastest
 *               supported pace, so displacement cannot accumulate and walk
 *               the ball out of the capture area over a long attempt.
 *
 * impulseN * tau is the displacement per tap — about ONE ball width, which
 * is what a ball-mastery touch does. It is derived, not guessed: strikes
 * alternate direction, so the ball occupies two positions, and BOTH must sit
 * inside the engine's contact range for both strikes to be observable. With
 * contact range at 1.2 diameters and the anchor 0.1 diameters off the
 * silhouette, a 1.0-diameter tap keeps the far position at 1.1.
 *
 * Two earlier cuts bracketed this. A 1.26-diameter tap put the far position
 * outside contact range, so every second strike happened while the ball was
 * already out of range and went uncounted — counts landed at almost exactly
 * half of truth, at every pace. A 0.4-diameter tap was then too small to
 * clear the separation requirement and counts collapsed altogether. Neither
 * was an engine defect; both were the fixture asserting physics the protocol
 * rules do not describe.
 */
export function touchPath({
  touches = 10, periodMs = 500, impulseN = 0.833, tauMs = 60, x0 = 0.545, y = 0.83,
}) {
  const tau = tauMs / 1000;
  return (t) => {
    // Sum the settled displacement of every completed contact, plus the
    // in-flight displacement of the current one. Closed form, so the path is
    // exact at any sampling rate — no integration error that would vary with
    // frame rate and quietly break invariance.
    let x = x0;
    const n = Math.min(touches, Math.floor(t / periodMs) + 1);
    for (let k = 0; k < n; k += 1) {
      const dt = (t - k * periodMs) / 1000;
      if (dt < 0) break;
      const dir = k % 2 === 0 ? 1 : -1;
      x += dir * impulseN * tau * (1 - Math.exp(-dt / tau));
    }
    return { x, y };
  };
}

/** A ball that simply sits there. */
export function stationaryPath({ x = 0.567, y = 0.83 }) {
  return () => ({ x, y });
}

/** A ball rolling steadily across frame. */
export function rollPath({ x0 = 0.05, x1 = 0.95, y = 0.83, durationMs = 4000 }) {
  return (t) => ({ x: x0 + (x1 - x0) * Math.min(1, t / durationMs), y });
}

/** A ball bouncing on its own, away from the player. */
export function independentBouncePath({ x = 0.18, periodMs = 500, contactY = 0.86, apexFrac = 0.22 }) {
  const apexY = contactY - apexFrac;
  return (t) => {
    const phase = (t % periodMs) / periodMs;
    return { x, y: contactY - 4 * (contactY - apexY) * phase * (1 - phase) };
  };
}

/** A ball oscillating just outside contact range without ever arriving. */
export function nearMissPath({ x0 = 0.70, y = 0.83, amplitude = 0.02, periodMs = 600 }) {
  return (t) => ({ x: x0 + Math.sin((t / periodMs) * Math.PI * 2) * amplitude, y });
}
