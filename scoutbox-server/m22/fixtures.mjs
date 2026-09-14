// M22 — golden observation fixtures (§57, §58, §59).
//
// HONESTY NOTE, first, because everything below depends on it:
//
//   These fixtures are SYNTHETIC. They are rendered geometry — a bright disc
//   and a dark rectangle on a noisy background — not football. They can
//   demonstrate that the engine is deterministic, that its rules fire on the
//   structure they claim to fire on, and above all that it REFUSES the cases
//   it promises to refuse. They cannot demonstrate that it counts touches
//   correctly on real video of a real player, and nothing in this repository
//   can, because there is no real football video here and §57 forbids adding
//   private user media.
//
//   That gap is not a caveat to be buried. It is the reason the production
//   enablement gate in gate.mjs requires real-world validation evidence that
//   this environment cannot supply.
//
// Every fixture declares its EXPECTED outcome (§59) as data, before any
// measurement is taken, so that tuning against a result is visible as a diff
// to a ground-truth constant rather than invisible as a threshold nudge.

import { FRAME_LIMITS } from './policy.mjs';
import { sequence, touchPath } from './scenes.mjs';

// Deterministic PRNG — fixtures must be byte-identical on every run (§76 of
// the negative list: "count differs nondeterministically for same fixture").
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 240;
const H = 180;

/**
 * Render one gray8 scene. Everything is drawn from explicit geometry: there
 * is no image asset anywhere in ScoutBox, and none is introduced here.
 */
function render({ w = W, h = H, bg = 130, noise = 6, ball = null, balls = null,
  people = [], gain = 1, rng }) {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i += 1) {
    px[i] = clamp8((bg + (rng() - 0.5) * 2 * noise) * gain);
  }
  for (const p of people) {
    for (let y = Math.max(0, p.y0 | 0); y <= Math.min(h - 1, p.y1 | 0); y += 1) {
      for (let x = Math.max(0, p.x0 | 0); x <= Math.min(w - 1, p.x1 | 0); x += 1) {
        px[y * w + x] = clamp8((p.luma ?? 55) * gain + (rng() - 0.5) * 4);
      }
    }
  }
  const list = balls ?? (ball ? [ball] : []);
  for (const b of list) {
    const r = b.r ?? 6;
    for (let y = Math.max(0, (b.y - r) | 0); y <= Math.min(h - 1, (b.y + r) | 0); y += 1) {
      for (let x = Math.max(0, (b.x - r) | 0); x <= Math.min(w - 1, (b.x + r) | 0); x += 1) {
        if ((x - b.x) ** 2 + (y - b.y) ** 2 <= r * r) {
          px[y * w + x] = clamp8((b.luma ?? 242) * gain);
        }
      }
    }
  }
  return { w, h, px };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Wrap a rendered scene in the wire envelope the frame route accepts. */
function envelope(scene, seq, atMs) {
  return {
    encoding: 'gray8',
    seq,
    atMs,
    w: scene.w,
    h: scene.h,
    data: Buffer.from(scene.px).toString('base64'),
  };
}

// ------------------------------------------------------------- scenarios

const PERSON = { x0: 96, y0: 58, x1: 130, y1: 168, luma: 55 };

/**
 * A juggling ball: parabolic flights between contacts at a fixed cadence.
 * Contacts are the ground truth — `bounces` of them, by construction.
 */
function juggleFrames({ bounces = 8, fps = 12, seed = 11, apexFrac = 0.30 }) {
  const rng = mulberry32(seed);
  const frames = [];
  const periodMs = 600;                         // one contact every 600 ms
  const dtMs = Math.round(1000 / fps);
  const contactY = 150;                         // ball's lowest point
  const apex = contactY - H * apexFrac;
  const totalMs = bounces * periodMs;
  let seq = 0;
  for (let t = 0; t <= totalMs; t += dtMs) {
    const phase = (t % periodMs) / periodMs;    // 0 at contact, 1 at next
    // Symmetric parabola: y = contactY - 4*A*phase*(1-phase)
    const y = contactY - 4 * (contactY - apex) * phase * (1 - phase);
    const x = 113 + Math.sin(t / 900) * 5;
    frames.push(envelope(render({ ball: { x, y, r: 6 }, people: [PERSON], rng }), seq, t));
    seq += 1;
  }
  return frames;
}

/**
 * Ground touches — delegated to the shared physics model in scenes.mjs.
 *
 * This file previously carried its OWN touch generator, a triangle wave at a
 * fixed size. Two descriptions of what a touch is, in one repository, is one
 * too many: when the shared model was corrected the local copy silently kept
 * asserting the old physics, and the fixture failed for a reason that had
 * nothing to do with the engine.
 */
function touchFrames({ touches = 10, fps = 12, seed = 23 }) {
  return sequence({
    w: W, h: H, fps, durationMs: 500 * touches,
    path: touchPath({ touches, periodMs: 500 }), seed,
  });
}

function plainFrames({ n = 40, dtMs = 83, seed = 5, ...scene }) {
  const rng = mulberry32(seed);
  const frames = [];
  for (let i = 0; i < n; i += 1) {
    frames.push(envelope(render({ ...scene, rng }), i, i * dtMs));
  }
  return frames;
}

// ------------------------------------------------------------- the set
//
// `expected.state` is the outcome the engine MUST produce. Where a count is
// asserted it is the count the geometry actually contains.
//
// `tolerance` exists only for accepted counting fixtures and is stated per
// fixture rather than globally, so a loose tolerance cannot hide behind an
// average.

export function goldenFixtures() {
  return [
    {
      id: 'G1_clear_juggles',
      kind: 'juggle',
      description: 'Eight clean juggle contacts, parabolic flights, player in frame.',
      frames: juggleFrames({ bounces: 8 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    },
    {
      id: 'G2_clear_touches',
      kind: 'touch',
      description: 'Ten lateral ground touches beside the player at a steady cadence.',
      frames: touchFrames({ touches: 10 }),
      expected: { state: 'accepted', count: 10, tolerance: 2 },
    },
    {
      id: 'G3_no_ball',
      kind: 'touch',
      description: 'Player present, no ball anywhere in frame.',
      frames: plainFrames({ people: [PERSON] }),
      expected: { state: 'ball_not_detected', count: null },
    },
    {
      id: 'G4_no_person',
      kind: 'touch',
      description: 'A ball moving in an empty capture area.',
      frames: (() => {
        const rng = mulberry32(31);
        return Array.from({ length: 40 }, (_, i) =>
          envelope(render({ ball: { x: 60 + i * 2, y: 150, r: 6 }, people: [], rng }), i, i * 83));
      })(),
      expected: { state: 'person_not_detected', count: null },
    },
    {
      id: 'G5_low_light',
      kind: 'juggle',
      description: 'The same valid juggling sequence, captured far too dark to track.',
      frames: (() => {
        const rng = mulberry32(11);
        const base = juggleFrames({ bounces: 8, seed: 11 });
        // Re-render at low gain rather than post-darkening, so the fixture is
        // a genuinely dark capture and not a bright one with a filter.
        const out = [];
        const periodMs = 600, dtMs = 83, contactY = 150, apex = contactY - H * 0.30;
        let seq = 0;
        for (let t = 0; t <= 8 * periodMs; t += dtMs) {
          const phase = (t % periodMs) / periodMs;
          const y = contactY - 4 * (contactY - apex) * phase * (1 - phase);
          out.push(envelope(render({ ball: { x: 113, y, r: 6 }, people: [PERSON], gain: 0.10, noise: 2, rng }), seq, t));
          seq += 1;
        }
        void base;
        return out;
      })(),
      expected: { state: 'insufficient_visibility', count: null },
    },
    {
      id: 'G6_long_occlusion',
      kind: 'juggle',
      description: 'Valid juggling, but the ball leaves the visible area for a long run of frames.',
      // GROUND-TRUTH REVISION (fix pack). Originally declared
      // `ball_not_detected`. The fix pack introduced `observation_discontinuity`
      // as a distinct canonical state, and that is what this fixture actually
      // contains: the ball IS detected for most of the attempt and then lost
      // for nine consecutive frames. Revised on semantic grounds, before
      // seeing whether the engine agreed — and recorded here so the change is
      // a visible edit to a declared truth rather than an invisible nudge.
      frames: (() => {
        const rng = mulberry32(11);
        const out = [];
        const periodMs = 600, dtMs = 83, contactY = 150, apex = contactY - H * 0.30;
        let seq = 0;
        for (let t = 0; t <= 8 * periodMs; t += dtMs) {
          const phase = (t % periodMs) / periodMs;
          const y = contactY - 4 * (contactY - apex) * phase * (1 - phase);
          const hidden = seq >= 18 && seq <= 26;    // 9 consecutive frames
          out.push(envelope(render({ ball: hidden ? null : { x: 113, y, r: 6 }, people: [PERSON], rng }), seq, t));
          seq += 1;
        }
        return out;
      })(),
      expected: { state: 'observation_discontinuity', count: null },
    },
    {
      id: 'G7_two_balls',
      kind: 'touch',
      description: 'Two balls of comparable size in the capture area.',
      frames: (() => {
        const rng = mulberry32(41);
        return Array.from({ length: 40 }, (_, i) => envelope(render({
          balls: [{ x: 120 + Math.sin(i / 3) * 14, y: 150, r: 6 }, { x: 60, y: 120, r: 6 }],
          people: [PERSON], rng,
        }), i, i * 83));
      })(),
      expected: { state: 'protocol_violation', count: null },
    },
    {
      id: 'G8_two_people',
      kind: 'touch',
      description: 'A second person in the capture area, materially interfering.',
      frames: (() => {
        const rng = mulberry32(43);
        return Array.from({ length: 40 }, (_, i) => envelope(render({
          ball: { x: 136 + Math.sin(i / 2) * 14, y: 150, r: 6 },
          people: [PERSON, { x0: 20, y0: 60, x1: 56, y1: 168, luma: 58 }], rng,
        }), i, i * 83));
      })(),
      // Two dark masses merge into one wide person region. The engine must
      // not attempt to decide which is the account holder (§33); whatever it
      // reports, it must not be a confident count attributed to one of them.
      expected: { state: 'any_refusal_or_uncounted', count: null },
    },
    {
      id: 'G9_static_image',
      kind: 'touch',
      description: 'A single still frame repeated — a photograph held up to the lens.',
      frames: (() => {
        const rng = mulberry32(7);
        const scene = render({ ball: { x: 136, y: 150, r: 6 }, people: [PERSON], noise: 0, rng });
        // Distinct seq/atMs but byte-identical pixels.
        return Array.from({ length: 40 }, (_, i) => envelope(scene, i, i * 83));
      })(),
      expected: { state: 'protocol_violation', count: null },
    },
    {
      id: 'G10_frozen_sequence',
      kind: 'juggle',
      description: 'A live-looking start that then freezes — a stalled or looped stream.',
      frames: (() => {
        const live = juggleFrames({ bounces: 3, seed: 11 });
        const last = live[live.length - 1];
        const frozen = Array.from({ length: 12 }, (_, i) => ({
          ...last, seq: live.length + i, atMs: last.atMs + (i + 1) * 83,
          // Not byte-identical: one pixel differs, so the duplicate-hash
          // defence does NOT catch this. Only the static-run rule does.
          data: nudge(last.data),
        }));
        return [...live, ...frozen];
      })(),
      expected: { state: 'protocol_violation', count: null },
    },
    {
      id: 'G11_dropped_frames',
      kind: 'juggle',
      description: 'Valid juggling with scattered frames dropped, but still within tolerance.',
      frames: juggleFrames({ bounces: 8 }).filter((_, i) => i % 7 !== 3),
      expected: { state: 'accepted', count: 8, tolerance: 2 },
    },
    {
      id: 'G12_camera_shake',
      kind: 'touch',
      description: 'Camera shake with a stationary ball — jitter must not manufacture touches.',
      frames: (() => {
        const rng = mulberry32(53);
        return Array.from({ length: 40 }, (_, i) => {
          const jx = (rng() - 0.5) * 7;
          const jy = (rng() - 0.5) * 7;
          return envelope(render({
            ball: { x: 136 + jx, y: 150 + jy, r: 6 },
            people: [{ x0: PERSON.x0 + jx, y0: PERSON.y0 + jy, x1: PERSON.x1 + jx, y1: PERSON.y1 + jy, luma: 55 }],
            rng,
          }), i, i * 83);
        });
      })(),
      // The ball is not being played. Anything counted here is a FALSE
      // POSITIVE, which §61 makes a P0.
      expected: { state: 'accepted_with_zero_or_refusal', count: 0 },
    },
    {
      id: 'G13_duplicate_frames',
      kind: 'juggle',
      description: 'Valid juggling with occasional retransmitted frames (about one in four).',
      frames: (() => {
        // A realistic retransmission rate. The original fixture doubled EVERY
        // frame, which conflated two different properties: "duplicates do not
        // inflate the count" and "a capture that is half duplicates is still
        // acceptable". The second is not something M22 wants to be true, so
        // the two are now separate fixtures rather than one compromise.
        const base = juggleFrames({ bounces: 8 });
        const out = [];
        let seq = 0;
        base.forEach((f, i) => {
          out.push({ ...f, seq: seq += 1 });
          if (i % 4 === 0) out.push({ ...f, seq: seq += 1 });   // same pixels, new seq
        });
        return out;
      })(),
      // Duplicates must not inflate the count (§89, T7).
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    },
    {
      id: 'G14_excessive_duplicates',
      kind: 'juggle',
      description: 'Valid juggling, but half the submitted frames are retransmissions.',
      frames: (() => {
        const base = juggleFrames({ bounces: 8 });
        const out = [];
        let seq = 0;
        for (const f of base) {
          out.push({ ...f, seq: seq += 1 });
          out.push({ ...f, seq: seq += 1 });
        }
        return out;
      })(),
      // A capture that is half retransmission is a degraded capture, whatever
      // the derived count happens to be (§29 duplicate/frozen-frame rate).
      expected: { state: 'protocol_violation', count: null },
    },
  ];
}

/** Flip the low bit of one byte so the frame is near-identical, not identical. */
function nudge(b64) {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = buf[0] ^ 1;
  return buf.toString('base64');
}

export const FIXTURE_FRAME_BUDGET = FRAME_LIMITS.maxFramesPerBatch;
