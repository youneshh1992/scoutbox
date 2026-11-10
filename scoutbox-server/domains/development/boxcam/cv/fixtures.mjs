// Golden observation fixtures. Synthetic (a bright disc and a dark rectangle on noise), so they show the engine is
// deterministic and refuses what it promises to refuse, not that it counts real touches; there is no real football
// video here and private user media must not be added. That is why gate.mjs requires real-world validation.
// Expected outcomes are declared as data, so tuning against a result shows as a diff to a ground-truth constant.
import { FRAME_LIMITS } from './policy.mjs';
import { sequence, touchPath } from './scenes.mjs';

// Fixtures must be byte-identical on every run.
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

/** Drawn from explicit geometry: there is no image asset in ScoutBox. */
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

/** Parabolic flights between contacts; `bounces` contacts by construction. */
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
// A count asserted is the count the geometry contains. `tolerance` is per fixture so a loose one can't hide behind
// an average.

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
        // Low gain rather than post-darkening, so it's a genuinely dark capture.
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
      // The ball is detected for most of the attempt then lost for nine consecutive frames: an
      // `observation_discontinuity`, not `ball_not_detected`.
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
      // Two dark masses merge into one person region. The engine must not report a confident count attributed to either.
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
          // One pixel differs, so only the static-run rule catches this, not the duplicate hash.
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
      // The ball is not being played: anything counted is a false positive.
      expected: { state: 'accepted_with_zero_or_refusal', count: 0 },
    },
    {
      id: 'G13_duplicate_frames',
      kind: 'juggle',
      description: 'Valid juggling with occasional retransmitted frames (about one in four).',
      frames: (() => {
        // A realistic retransmission rate. A capture that is half duplicates must not be acceptable; G14 tests that.
        const base = juggleFrames({ bounces: 8 });
        const out = [];
        let seq = 0;
        base.forEach((f, i) => {
          out.push({ ...f, seq: seq += 1 });
          if (i % 4 === 0) out.push({ ...f, seq: seq += 1 });   // same pixels, new seq
        });
        return out;
      })(),
      // Duplicates must not inflate the count.
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
      // Half retransmission is degraded, whatever the derived count.
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
