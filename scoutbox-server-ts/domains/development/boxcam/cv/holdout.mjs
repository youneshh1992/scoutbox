// Material the engine has never been tuned against, so it measures generalisation rather than fit: seeds disjoint
// from development (which uses 7, 11, 23, 61), different parameter values, all inside the supported envelope. Run
// once under a recorded freeze; if a threshold moves, regenerate with fresh seeds rather than re-run until it agrees.
// Reported separately from development numbers, never averaged with them.

import {
  sequence,
  jugglePath,
  touchPath,
  stationaryPath,
  rollPath,
  independentBouncePath,
  nearMissPath,
  DEFAULT_PERSON,
} from './scenes.mjs';

/**
 * A holdout is spent once it diagnoses something: its cases become development regressions
 * (`consumedHoldoutCases()`) and a fresh generation with new seeds and values takes over. A consumed generation
 * doesn't return to holdout duty.
 */
export const HOLDOUT_GENERATIONS = Object.freeze([
  Object.freeze({
    generation: 1,
    seedBase: 9001,
    freezeId: 'm22-v2-freeze-1',
    status: 'consumed',
    consumedBecause:
      'HT05 (18% camera zoom pulse) produced a P0 false touch. The tracking layer was ' +
      'differencing player-relative positions in pixels and dividing by a single ball ' +
      'diameter, so a global scale change left a residual velocity. Diagnosing and fixing ' +
      'that used these cases, so they are now development material.',
    result: Object.freeze({
      familyVariants: 28,
      offTruth: 0,
      invarianceBreaks: 0,
      adversarialCases: 12,
      falseTouches: 1,
      falseVerifications: 0,
      nondeterministic: 0,
      meanAbsCountError: 1.036,
      maxAbsCountError: 2,
    }),
  }),
  Object.freeze({
    generation: 2,
    seedBase: 14001,
    freezeId: 'm22-v2-freeze-2',
    status: 'consumed',
    consumedBecause:
      'Generation 2 pressed harder on the axis generation 1 had found a defect on, and found ' +
      'two more things. First, three further P0 false touches (HT13 step zoom in, HT14 step ' +
      "zoom out, HT15 repeated pulses): generation 1's fix — normalising each sample by its " +
      'own ball diameter before differencing — cancelled global scale exactly, but a step ' +
      'zoom also clips the player region against the frame edge, which moves the origin in a ' +
      'way no global transform describes. Second, that same fix had quietly cost accuracy: ' +
      "dividing by a per-sample diameter amplifies the diameter estimate's noise by |rel|/d, " +
      'about 3.5x, and at the smallest frame size that manufactured two extra touches and ' +
      'broke resolution invariance. Both were replaced by one structural test — a derived ' +
      'per-sample bound on how much the player region may change size — which catches camera ' +
      'zoom, player approach and edge clipping alike without touching the well-conditioned ' +
      'velocity computation.',
    result: Object.freeze({
      familyVariants: 28,
      offTruth: 1,
      invarianceBreaks: 2,
      adversarialCases: 16,
      falseTouches: 1,
      falseVerifications: 0,
      nondeterministic: 0,
      meanAbsCountError: 1.037,
      maxAbsCountError: 2,
      note:
        "Reported under generation 1's fix. Re-probed after reverting it, the same cases " +
        'showed 4 false touches and no invariance break, which is what identified the ' +
        'noise-amplification side effect.',
    }),
  }),
  Object.freeze({
    generation: 3,
    seedBase: 21001,
    freezeId: 'm22-v2-freeze-3',
    status: 'active',
    note: 'Generated after the scale-step fix, under a freeze covering constants and layer source.',
  }),
]);

export const ACTIVE_GENERATION = HOLDOUT_GENERATIONS.find((g) => g.status === 'active');
export const HOLDOUT_SEED_BASE = ACTIVE_GENERATION.seedBase;
export const DEV_SEEDS = Object.freeze([7, 11, 23, 61]);

/** Each generation takes values no earlier set used, because earlier values were looked at during fixes. */
export const GENERATION_PARAMETERS = Object.freeze({
  1: Object.freeze({
    resolutions: Object.freeze([
      { id: '176x144', w: 176, h: 144 },
      { id: '208x160', w: 208, h: 160 },
      { id: '288x216', w: 288, h: 216 },
    ]),
    frameRates: Object.freeze([14, 20, 27]),
    juggleContacts: Object.freeze([7, 11]),
    touchCounts: Object.freeze([9, 13]),
    pacesMs: Object.freeze([760, 620, 420]),
    ballScales: Object.freeze([0.027, 0.041]),
    ballLuma: Object.freeze([238, 214]),
    bgLuma: Object.freeze([110, 148]),
    jitterMs: Object.freeze([4, 10]),
    textureBands: Object.freeze([2, 5]),
  }),
  3: Object.freeze({
    resolutions: Object.freeze([
      { id: '176x132', w: 176, h: 132 },
      { id: '224x168', w: 224, h: 168 },
      { id: '288x216', w: 288, h: 216 },
    ]),
    frameRates: Object.freeze([16, 22, 29]),
    juggleContacts: Object.freeze([5, 10]),
    touchCounts: Object.freeze([7, 12]),
    pacesMs: Object.freeze([900, 640, 460]), // all >= the declared 340 ms floor
    ballScales: Object.freeze([0.029, 0.047]),
    ballLuma: Object.freeze([252, 216]),
    bgLuma: Object.freeze([118, 162]),
    jitterMs: Object.freeze([5, 11]),
    textureBands: Object.freeze([3, 6]),
  }),
  2: Object.freeze({
    resolutions: Object.freeze([
      { id: '192x144', w: 192, h: 144 },
      { id: '256x192', w: 256, h: 192 },
      { id: '304x228', w: 304, h: 228 },
    ]),
    frameRates: Object.freeze([13, 18, 25]),
    juggleContacts: Object.freeze([6, 9]),
    touchCounts: Object.freeze([8, 11]),
    pacesMs: Object.freeze([840, 570, 380]), // all >= the declared 340 ms floor
    ballScales: Object.freeze([0.025, 0.045]),
    ballLuma: Object.freeze([245, 209]),
    bgLuma: Object.freeze([102, 156]),
    jitterMs: Object.freeze([3, 12]),
    textureBands: Object.freeze([1, 4]),
  }),
});

export const HOLDOUT_PARAMETERS = GENERATION_PARAMETERS[ACTIVE_GENERATION.generation];

const SHAPES = {
  1: {
    jugglePeriodMs: 660,
    silhouettes: [
      { id: 'tall_narrow', box: { x0: 0.455, y0: 0.24, x1: 0.515, y1: 0.95, luma: 48 } },
      { id: 'short_wide', box: { x0: 0.38, y0: 0.44, x1: 0.6, y1: 0.92, luma: 68 } },
      { id: 'right_of_centre', box: { x0: 0.56, y0: 0.3, x1: 0.7, y1: 0.94, luma: 55 } },
    ],
    cameras: [
      { id: 'still', opts: {} },
      { id: 'drift', opts: { cameraDrift: (t) => ({ dx: 0.05 * Math.sin(t / 1100), dy: 0.03 * Math.sin(t / 1300) }) } },
      { id: 'shake', opts: { cameraShakeN: 0.009 } },
      { id: 'zoom', opts: { cameraScale: (t) => 1 + 0.045 * Math.sin(t / 2600) } },
    ],
  },
  3: {
    jugglePeriodMs: 620,
    silhouettes: [
      { id: 'lean_right', box: { x0: 0.58, y0: 0.26, x1: 0.66, y1: 0.95, luma: 50 } },
      { id: 'broad_centre', box: { x0: 0.41, y0: 0.4, x1: 0.63, y1: 0.94, luma: 60 } },
      { id: 'small_far', box: { x0: 0.46, y0: 0.52, x1: 0.54, y1: 0.86, luma: 70 } },
    ],
    cameras: [
      { id: 'still', opts: {} },
      {
        id: 'drift',
        opts: { cameraDrift: (t) => ({ dx: 0.045 * Math.cos(t / 1250), dy: 0.03 * Math.sin(t / 1600) }) },
      },
      { id: 'shake', opts: { cameraShakeN: 0.011 } },
      // Earlier generations found defects on the scale axis, so this one pushes it further.
      { id: 'zoom', opts: { cameraScale: (t) => 1 + 0.11 * Math.sin(t / 1700) } },
    ],
  },
  2: {
    jugglePeriodMs: 720,
    silhouettes: [
      { id: 'very_tall', box: { x0: 0.47, y0: 0.18, x1: 0.53, y1: 0.96, luma: 44 } },
      { id: 'squat_left', box: { x0: 0.26, y0: 0.5, x1: 0.46, y1: 0.91, luma: 74 } },
      { id: 'mid_bright', box: { x0: 0.44, y0: 0.36, x1: 0.6, y1: 0.93, luma: 86 } },
    ],
    cameras: [
      { id: 'still', opts: {} },
      {
        id: 'drift',
        opts: { cameraDrift: (t) => ({ dx: 0.038 * Math.sin(t / 1450), dy: 0.026 * Math.cos(t / 980) }) },
      },
      { id: 'shake', opts: { cameraShakeN: 0.013 } },
      // Generation 1 found abrupt scale changes dangerous, so this varies scale harder (plus a step pulse below).
      { id: 'zoom', opts: { cameraScale: (t) => 1 + 0.085 * Math.sin(t / 1300) } },
    ],
  },
};

// =========================================================================
// Holdout counting families
// =========================================================================

/** Ground truth is the contact count the path contains by construction, never a reading from the engine. */
export function holdoutFamilies({ generation = ACTIVE_GENERATION.generation } = {}) {
  const P = GENERATION_PARAMETERS[generation];
  const H = SHAPES[generation];
  const base = GENERATION_PARAMETERS[generation].resolutions[1]; // the middle size
  const baseFps = P.frameRates[1];
  const jp = H.jugglePeriodMs;
  const S = (n) => HOLDOUT_GENERATIONS.find((g) => g.generation === generation).seedBase + n;
  const [smallJuggle, bigJuggle] = P.juggleContacts;
  const [smallTouch, bigTouch] = P.touchCounts;

  const juggleBase = (extra = {}, seed = S(0), contacts = smallJuggle) =>
    sequence({
      w: base.w,
      h: base.h,
      fps: baseFps,
      durationMs: contacts * jp,
      path: jugglePath({ contacts, periodMs: jp }),
      seed,
      ...extra,
    });

  const fams = [];

  // --- H1: resolution invariance, juggle ----------------------------------
  fams.push({
    family: 'holdout_juggle_resolution',
    axis: 'resolution',
    parameterSpace: { resolution: P.resolutions.map((r) => r.id), fps: [baseFps], contacts: [bigJuggle] },
    variants: P.resolutions.map((r) => ({
      id: `ho_juggle_res_${r.id}`,
      kind: 'juggle',
      frames: sequence({
        w: r.w,
        h: r.h,
        fps: baseFps,
        durationMs: bigJuggle * jp,
        path: jugglePath({ contacts: bigJuggle, periodMs: jp }),
        seed: S(1),
      }),
      expected: { state: 'accepted', count: bigJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H2: resolution invariance, touch -----------------------------------
  fams.push({
    family: 'holdout_touch_resolution',
    axis: 'resolution',
    parameterSpace: { resolution: P.resolutions.map((r) => r.id), fps: [P.frameRates[2]], touches: [bigTouch] },
    variants: P.resolutions.map((r) => ({
      id: `ho_touch_res_${r.id}`,
      kind: 'touch',
      frames: sequence({
        w: r.w,
        h: r.h,
        fps: P.frameRates[2],
        durationMs: bigTouch * P.pacesMs[1],
        path: touchPath({ touches: bigTouch, periodMs: P.pacesMs[1] }),
        seed: S(2),
      }),
      expected: { state: 'accepted', count: bigTouch, tolerance: 2 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H3: frame-rate invariance, juggle ----------------------------------
  // The same physical event sampled at three rates.
  fams.push({
    family: 'holdout_juggle_fps',
    axis: 'fps',
    parameterSpace: { fps: P.frameRates, resolution: [base.id], contacts: [smallJuggle] },
    variants: P.frameRates.map((fps) => ({
      id: `ho_juggle_fps_${fps}`,
      kind: 'juggle',
      frames: sequence({
        w: base.w,
        h: base.h,
        fps,
        durationMs: smallJuggle * jp,
        path: jugglePath({ contacts: smallJuggle, periodMs: jp }),
        seed: S(3),
      }),
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H4: frame-rate invariance, touch -----------------------------------
  fams.push({
    family: 'holdout_touch_fps',
    axis: 'fps',
    parameterSpace: { fps: P.frameRates, resolution: [P.resolutions[0].id], touches: [smallTouch] },
    variants: P.frameRates.map((fps) => ({
      id: `ho_touch_fps_${fps}`,
      kind: 'touch',
      frames: sequence({
        w: P.resolutions[0].w,
        h: P.resolutions[0].h,
        fps,
        durationMs: smallTouch * P.pacesMs[0],
        path: touchPath({ touches: smallTouch, periodMs: P.pacesMs[0] }),
        seed: S(4),
      }),
      expected: { state: 'accepted', count: smallTouch, tolerance: 2 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H5: apparent ball size ---------------------------------------------
  fams.push({
    family: 'holdout_ball_scale',
    axis: 'ballScale',
    parameterSpace: { rN: P.ballScales },
    variants: P.ballScales.map((rN, i) => ({
      id: `ho_ball_scale_${i}`,
      kind: 'juggle',
      frames: juggleBase({ rN }, S(5)),
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H6: photometry — ball contrast and background varied together ------
  // Together, to expose a threshold that only holds while one of them is nominal.
  fams.push({
    family: 'holdout_photometry',
    axis: 'ballLuma+bgLuma',
    parameterSpace: { ballLuma: P.ballLuma, bgLuma: P.bgLuma },
    variants: [
      { id: 'bright_on_dark', ballLuma: P.ballLuma[0], bgLuma: P.bgLuma[0] },
      { id: 'dim_on_light', ballLuma: P.ballLuma[1], bgLuma: P.bgLuma[1] },
    ].map((p) => ({
      id: `ho_photo_${p.id}`,
      kind: 'juggle',
      frames: juggleBase({ ballLuma: p.ballLuma, bgLuma: p.bgLuma }, S(6)),
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H7: player silhouette geometry, unseen shapes ----------------------
  fams.push({
    family: 'holdout_player_silhouette',
    axis: 'playerGeometry',
    parameterSpace: { silhouette: H.silhouettes.map((s) => s.id) },
    variants: H.silhouettes.map((s) => ({
      id: `ho_silhouette_${s.id}`,
      kind: 'juggle',
      // The ball tracks the silhouette, so every variant is the same physical scene.
      frames: sequence({
        w: base.w,
        h: base.h,
        fps: baseFps,
        durationMs: smallJuggle * jp,
        path: jugglePath({
          contacts: smallJuggle,
          periodMs: jp,
          x: (s.box.x0 + s.box.x1) / 2 + 0.02,
          contactY: Math.min(0.86, s.box.y1 - 0.06),
        }),
        person: s.box,
        seed: S(7),
      }),
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H8: camera behaviour ------------------------------------------------
  fams.push({
    family: 'holdout_camera_motion',
    axis: 'camera',
    parameterSpace: { mode: H.cameras.map((c) => c.id) },
    variants: H.cameras.map((c) => ({
      id: `ho_cam_${c.id}`,
      kind: 'juggle',
      frames: juggleBase(c.opts, S(8)),
      // The rules measure in the player's frame, in ball diameters, so camera motion must not change the count.
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- H9: touch pace, unseen values inside the supported envelope --------
  fams.push({
    family: 'holdout_touch_pace',
    axis: 'motionSpeed',
    parameterSpace: { periodMs: P.pacesMs },
    variants: P.pacesMs.map((periodMs, i) => {
      const touches = [smallTouch, smallTouch + 2, bigTouch][i];
      return {
        id: `ho_pace_${periodMs}ms`,
        kind: 'touch',
        frames: sequence({
          w: base.w,
          h: base.h,
          fps: P.frameRates[2],
          durationMs: periodMs * touches,
          path: touchPath({ touches, periodMs }),
          seed: S(9),
        }),
        expected: { state: 'accepted', count: touches, tolerance: 2 },
      };
    }),
    invariant: 'each_real_touch_counted_once',
  });

  // --- H10: cadence jitter and background structure together --------------
  fams.push({
    family: 'holdout_jitter_and_texture',
    axis: 'jitterMs+textureBands',
    parameterSpace: { jitterMs: P.jitterMs, textureBands: P.textureBands },
    variants: [0, 1].map((i) => ({
      id: `ho_jitter${P.jitterMs[i]}_bands${P.textureBands[i]}`,
      kind: 'juggle',
      frames: juggleBase({ jitterMs: P.jitterMs[i], textureBands: P.textureBands[i] }, S(10)),
      expected: { state: 'accepted', count: smallJuggle, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  return fams;
}

// =========================================================================
// Holdout adversarial group
//
// Fresh ways to manufacture a touch, none a re-seeded FT case. Every one expects zero.
// =========================================================================

export function holdoutFalseTouchStress({ generation = ACTIVE_GENERATION.generation } = {}) {
  const P = GENERATION_PARAMETERS[generation];
  const base = P.resolutions[1];
  const baseFps = P.frameRates[1];
  const S = (n) => HOLDOUT_GENERATIONS.find((g) => g.generation === generation).seedBase + n;
  const PERSON = DEFAULT_PERSON;
  const near = { x: 0.567, y: 0.83 };

  const c = (id, description, opts) => ({
    id,
    kind: 'touch',
    description,
    frames: sequence({ w: base.w, h: base.h, fps: baseFps, seed: S(40), ...opts }),
    expected: { state: 'zero_touches', count: 0 },
  });

  const cases = [
    c('HT01_ball_approaches_and_stops_short', 'Ball decelerates to rest just outside contact range and stays there.', {
      path: (t) => ({ x: 0.95 - 0.3 * (1 - Math.exp(-t / 900)), y: 0.86 }),
    }),

    c(
      'HT02_player_leans_over_still_ball',
      'Player region extends downward toward a stationary ball that never moves.',
      {
        path: stationaryPath(near),
        personAt: (t) => ({ ...PERSON, y1: Math.min(0.97, PERSON.y1 + 0.00002 * t) }),
      },
    ),

    c(
      'HT03_second_ball_passes_close',
      'A second bright object crosses near the player while the real ball rests far away.',
      {
        path: stationaryPath({ x: 0.1, y: 0.86 }),
        extraBalls: (t, { shake, drift, scale }) => {
          const x = 0.3 + 0.00018 * t;
          if (x > 0.95) return [];
          return [
            {
              x: (x - 0.5) * scale + 0.5 + shake.dx + drift.dx,
              y: (0.86 - 0.5) * scale + 0.5 + shake.dy + drift.dy,
              rN: 0.03 * scale,
              luma: 236,
              blur: 0,
            },
          ];
        },
      },
    ),

    c(
      'HT04_player_walks_into_resting_ball_frame',
      'Player walks across until the ball is inside the region, but the ball never moves.',
      {
        path: stationaryPath({ x: 0.62, y: 0.88 }),
        personAt: (t) => {
          const x = 0.2 + 0.0001 * t;
          return { x0: x, y0: 0.32, x1: x + 0.14, y1: 0.93, luma: 55 };
        },
      },
    ),

    c('HT05_zoom_pulse_near_ball', 'A sharp camera zoom pulse while ball and player hold a fixed relationship.', {
      path: stationaryPath(near),
      cameraScale: (t) => (Math.abs(t - 2000) < 200 ? 1.18 : 1),
    }),

    c(
      'HT06_ball_rolls_into_frame_and_out',
      'Ball enters at one edge, crosses behind the player and exits the other edge.',
      { path: rollPath({ x0: -0.02, x1: 1.02, y: 0.55, durationMs: 4200 }) },
    ),

    c(
      'HT07_periodic_occlusion_no_contact',
      'Ball is repeatedly hidden and revealed while resting away from the player.',
      { path: (t) => (Math.floor(t / 300) % 3 === 0 ? null : { x: 0.86, y: 0.86 }) },
    ),

    c(
      'HT08_independent_bounce_close_behind',
      'Ball bounces on its own, closer to the player than the development case but still clear of it.',
      { path: independentBouncePath({ x: 0.28, periodMs: 460, contactY: 0.88, apexFrac: 0.26 }) },
    ),

    c(
      'HT09_near_miss_larger_amplitude',
      'Ball swings toward the player with a larger amplitude, still stopping short.',
      { path: nearMissPath({ x0: 0.73, amplitude: 0.035, periodMs: 520 }) },
    ),

    c('HT10_low_contrast_ball_at_rest', 'A dim ball rests beside the player for the whole attempt.', {
      path: stationaryPath({ x: 0.55, y: 0.9 }),
      ballLuma: 206,
      bgLuma: 148,
      durationMs: 7000,
    }),

    c('HT11_two_people_one_still_ball', 'A second person crosses the frame past a stationary ball.', {
      path: stationaryPath({ x: 0.84, y: 0.88 }),
      extraPeople: (t) => {
        const x = 0.04 + 0.00014 * t;
        if (x > 0.9) return [];
        return [{ x0: x, y0: 0.38, x1: x + 0.11, y1: 0.93, luma: 62 }];
      },
    }),

    c('HT12_shake_and_drift_together', 'Camera shakes and drifts at once, over a fixed ball-player relationship.', {
      path: stationaryPath(near),
      cameraShakeN: 0.014,
      cameraDrift: (t) => ({ dx: 0.07 * Math.sin(t / 640), dy: 0.05 * Math.cos(t / 730) }),
    }),
  ];

  // The fix made the measurement invariant to any global similarity transform, so these must read zero for a
  // structural reason, not because their magnitudes sit under a threshold.
  if (generation >= 2) {
    cases.push(
      c('HT13_step_zoom_in_and_hold', 'Camera steps to a 35% larger scale mid-attempt and stays there.', {
        path: stationaryPath(near),
        cameraScale: (t) => (t < 2000 ? 1 : 1.35),
      }),

      c('HT14_step_zoom_out_and_hold', 'Camera steps to a 25% smaller scale mid-attempt and stays there.', {
        path: stationaryPath(near),
        cameraScale: (t) => (t < 2000 ? 1 : 0.75),
      }),

      c('HT15_repeated_zoom_pulses', 'Repeated short zoom pulses over a fixed ball-player relationship.', {
        path: stationaryPath(near),
        cameraScale: (t) => (Math.floor(t / 600) % 2 === 0 ? 1 : 1.16),
      }),

      c(
        'HT16_zoom_while_ball_rests_at_foot',
        'Camera zooms smoothly while the ball rests inside contact range and never moves.',
        {
          path: stationaryPath({ x: 0.545, y: 0.91 }),
          cameraScale: (t) => 1 + 0.22 * (t / 5000),
          durationMs: 5000,
        },
      ),
    );
  }

  // Attacks the scale-step bound's derivation (under 4% per sample cannot fabricate 4.5 d/s): cases just under it,
  // accumulating under it, or from directions the derivation didn't consider.
  if (generation >= 3) {
    const dtMs = 1000 / baseFps;
    cases.push(
      c(
        'HT17_scale_ramp_just_under_the_bound',
        'Camera scales by just under the per-sample bound on every single frame, compounding to well over 2x.',
        {
          path: stationaryPath(near),
          // 3.5% per sample is never flagged; does the per-step residual stay under the impulse threshold?
          cameraScale: (t) => 1.035 ** (t / dtMs),
          durationMs: 25 * dtMs,
        },
      ),

      c(
        'HT18_person_clipped_at_edge_throughout',
        'Player region is clipped by the bottom frame edge for the whole attempt while the camera drifts.',
        {
          path: stationaryPath({ x: 0.567, y: 0.88 }),
          person: { x0: 0.4, y0: 0.3, x1: 0.54, y1: 1.06, luma: 55 },
          cameraDrift: (t) => ({ dx: 0.05 * Math.sin(t / 900), dy: 0.04 * Math.cos(t / 1100) }),
        },
      ),

      c(
        'HT19_player_walks_toward_camera',
        'Player grows steadily as they approach the lens, passing a ball that never moves.',
        {
          path: stationaryPath({ x: 0.8, y: 0.88 }),
          personAt: (t) => {
            const g = 1 + 0.00009 * t; // ~45% larger by 5 s
            const cx = 0.47,
              cy = 0.625;
            const hw = 0.07 * g,
              hh = 0.305 * g;
            return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh, luma: 55 };
          },
        },
      ),

      c('HT20_extreme_step_zoom', 'Camera doubles scale in a single frame over a fixed ball-player relationship.', {
        path: stationaryPath(near),
        cameraScale: (t) => (t < 2000 ? 1 : 2),
      }),
    );
  }

  return cases;
}

/** Every seed a generation uses, for the disjointness check. */
export function holdoutSeeds({ generation = ACTIVE_GENERATION.generation } = {}) {
  const b = HOLDOUT_GENERATIONS.find((g) => g.generation === generation).seedBase;
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40].map((n) => b + n);
}

/** Consumed holdout cases, run by the development harness as regressions: the only cases known to have caught something. */
export function consumedHoldoutCases() {
  const out = [];
  for (const g of HOLDOUT_GENERATIONS) {
    if (g.status !== 'consumed') continue;
    for (const fam of holdoutFamilies({ generation: g.generation })) {
      for (const v of fam.variants)
        out.push({ ...v, id: `g${g.generation}_${v.id}`, consumedFrom: g.generation, group: 'counting' });
    }
    for (const st of holdoutFalseTouchStress({ generation: g.generation })) {
      out.push({ ...st, id: `g${g.generation}_${st.id}`, consumedFrom: g.generation, group: 'adversarial' });
    }
  }
  return out;
}
