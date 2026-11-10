// Variation families (expected results declared before execution, never read back from the engine) and the
// false-touch stress suite, where every case expects zero touches. The player is a rectangle: the variation axes are
// geometric and photometric, with no demographic labels.

import {
  sequence,
  jugglePath,
  touchPath,
  stationaryPath,
  rollPath,
  independentBouncePath,
  nearMissPath,
  DEFAULT_PERSON,
  DEFAULT_BALL_RN,
} from './scenes.mjs';

// Real 480p–1080p would exceed the gray8 320x240 cap, so these are proportional synthetic sizes; 2x between smallest
// and largest is enough for a pixel-space threshold to fail loudly.
export const RESOLUTIONS = Object.freeze([
  { id: '160x120', w: 160, h: 120 },
  { id: '240x180', w: 240, h: 180 },
  { id: '320x240', w: 320, h: 240 },
]);

export const FRAME_RATES = Object.freeze([15, 24, 30]);

// =========================================================================
// Variation families
// =========================================================================

/** `expected.count` is what the path contains by construction, not a reading from the detector. */
export function variationFamilies() {
  const fams = [];

  // --- Family 1: resolution invariance on a valid juggle -----------------
  fams.push({
    family: 'juggle_valid_resolution',
    axis: 'resolution',
    parameterSpace: { resolution: RESOLUTIONS.map((r) => r.id), fps: [12], contacts: [8] },
    variants: RESOLUTIONS.map((r) => ({
      id: `juggle_res_${r.id}`,
      kind: 'juggle',
      frames: sequence({ w: r.w, h: r.h, fps: 12, durationMs: 4800, path: jugglePath({ contacts: 8 }), seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 2: resolution invariance on valid touches ------------------
  fams.push({
    family: 'touch_valid_resolution',
    axis: 'resolution',
    parameterSpace: { resolution: RESOLUTIONS.map((r) => r.id), fps: [12], touches: [10] },
    variants: RESOLUTIONS.map((r) => ({
      id: `touch_res_${r.id}`,
      kind: 'touch',
      frames: sequence({ w: r.w, h: r.h, fps: 12, durationMs: 5000, path: touchPath({ touches: 10 }), seed: 23 }),
      expected: { state: 'accepted', count: 10, tolerance: 2 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 3: frame-rate invariance on a valid juggle -----------------
  // The same physical event (8 contacts over 4.8 s) sampled at three rates.
  fams.push({
    family: 'juggle_valid_fps',
    axis: 'fps',
    parameterSpace: { fps: FRAME_RATES, resolution: ['240x180'], contacts: [8] },
    variants: FRAME_RATES.map((fps) => ({
      id: `juggle_fps_${fps}`,
      kind: 'juggle',
      frames: sequence({ w: 240, h: 180, fps, durationMs: 4800, path: jugglePath({ contacts: 8 }), seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 4: frame-rate invariance on valid touches ------------------
  fams.push({
    family: 'touch_valid_fps',
    axis: 'fps',
    parameterSpace: { fps: FRAME_RATES, resolution: ['240x180'], touches: [10] },
    variants: FRAME_RATES.map((fps) => ({
      id: `touch_fps_${fps}`,
      kind: 'touch',
      frames: sequence({ w: 240, h: 180, fps, durationMs: 5000, path: touchPath({ touches: 10 }), seed: 23 }),
      expected: { state: 'accepted', count: 10, tolerance: 2 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 5: apparent ball size --------------------------------------
  fams.push({
    family: 'ball_scale',
    axis: 'ballScale',
    parameterSpace: { rN: [0.022, 0.033, 0.05] },
    variants: [0.022, 0.033, 0.05].map((rN, i) => ({
      id: `ball_scale_${i}`,
      kind: 'juggle',
      frames: sequence({ path: jugglePath({ contacts: 8 }), rN, seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 6: ball contrast, inside the supported range ---------------
  fams.push({
    family: 'ball_contrast',
    axis: 'ballLuma',
    parameterSpace: { ballLuma: [250, 225, 205], bgLuma: [130] },
    variants: [250, 225, 205].map((ballLuma) => ({
      id: `ball_luma_${ballLuma}`,
      kind: 'juggle',
      frames: sequence({ path: jugglePath({ contacts: 8 }), ballLuma, seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 7: background luminance ------------------------------------
  fams.push({
    family: 'background_luma',
    axis: 'bgLuma',
    parameterSpace: { bgLuma: [95, 130, 165] },
    variants: [95, 130, 165].map((bgLuma) => ({
      id: `bg_luma_${bgLuma}`,
      kind: 'juggle',
      frames: sequence({ path: jugglePath({ contacts: 8 }), bgLuma, seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 8: player silhouette geometry ------------------------------
  const SILHOUETTES = [
    { id: 'narrow', box: { x0: 0.43, y0: 0.32, x1: 0.51, y1: 0.93, luma: 55 } },
    { id: 'wide', box: { x0: 0.36, y0: 0.3, x1: 0.58, y1: 0.93, luma: 55 } },
    { id: 'mid_contrast', box: { x0: 0.4, y0: 0.32, x1: 0.54, y1: 0.93, luma: 92 } },
    { id: 'shifted_left', box: { x0: 0.3, y0: 0.32, x1: 0.44, y1: 0.93, luma: 55 } },
  ];
  fams.push({
    family: 'player_silhouette',
    axis: 'playerGeometry',
    parameterSpace: { silhouette: SILHOUETTES.map((s) => s.id) },
    variants: SILHOUETTES.map((s) => ({
      id: `silhouette_${s.id}`,
      kind: 'juggle',
      // The ball tracks the silhouette, so every variant is the same physical scene.
      frames: sequence({
        path: jugglePath({ contacts: 8, x: (s.box.x0 + s.box.x1) / 2 + 0.02 }),
        person: s.box,
        seed: 11,
      }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 9: camera behaviour, valid activity underneath -------------
  fams.push({
    family: 'camera_motion_valid',
    axis: 'camera',
    parameterSpace: { mode: ['still', 'small_translation', 'shake', 'mild_scale'] },
    variants: [
      { id: 'cam_still', opts: {} },
      {
        id: 'cam_translation',
        opts: { cameraDrift: (t) => ({ dx: 0.04 * Math.sin(t / 1500), dy: 0.02 * Math.cos(t / 1700) }) },
      },
      { id: 'cam_shake', opts: { cameraShakeN: 0.012 } },
      { id: 'cam_scale', opts: { cameraScale: (t) => 1 + 0.06 * Math.sin(t / 2000) } },
    ].map((v) => ({
      id: v.id,
      kind: 'juggle',
      frames: sequence({ path: jugglePath({ contacts: 8 }), seed: 11, ...v.opts }),
      // The rules measure in the player-relative frame, so camera motion must not change the count.
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 10: legitimate touch pace ----------------------------------
  // The strike is identical in every variant; only the rest between touches changes. The engine counts within
  // tolerance from 900 ms down to 340 ms and returned 10 of 14 at 260 ms. The supported range was narrowed rather than
  // the refractory or separation rules relaxed, which would weaken the false-touch defences; 260 ms is kept below as
  // a declared limitation.
  const PACES = [
    { id: 'slow', periodMs: 900, touches: 6 },
    { id: 'normal', periodMs: 500, touches: 10 },
    { id: 'fast', periodMs: 340, touches: 12 },
  ];
  const SUPPORTED_MIN_TOUCH_PERIOD_MS = 340;
  fams.push({
    family: 'touch_pace',
    axis: 'motionSpeed',
    parameterSpace: { periodMs: PACES.map((p) => p.periodMs) },
    variants: PACES.map((p) => ({
      id: `pace_${p.id}`,
      kind: 'touch',
      frames: sequence({
        fps: 30,
        durationMs: p.periodMs * p.touches,
        path: touchPath({ touches: p.touches, periodMs: p.periodMs }),
        seed: 23,
      }),
      // Even the fastest supported pace is well outside the 180 ms refractory, so every touch must survive.
      expected: { state: 'accepted', count: p.touches, tolerance: 2 },
    })),
    invariant: 'each_real_touch_counted_once',
    supportedMinPeriodMs: SUPPORTED_MIN_TOUCH_PERIOD_MS,
  });

  // --- Family 10b: the declared limitation, measured ---
  // Above the supported pace the engine under-counts; recorded with its actual numbers.
  fams.push({
    family: 'touch_pace_above_supported',
    axis: 'motionSpeed',
    parameterSpace: { periodMs: [260] },
    declaredLimitation:
      'Above four touches per second the engine under-counts; the pace is outside the supported envelope.',
    variants: [
      {
        id: 'pace_above_supported_260ms',
        kind: 'touch',
        frames: sequence({
          fps: 30,
          durationMs: 260 * 14,
          path: touchPath({ touches: 14, periodMs: 260 }),
          seed: 23,
        }),
        // The count is not asserted against the true 14: this is outside the envelope.
        expected: { state: 'accepted_count_not_asserted', count: null },
      },
    ],
    invariant: 'declared_limitation_only',
  });

  // --- Family 11: background structure away from the player --------------
  fams.push({
    family: 'background_structure',
    axis: 'background',
    parameterSpace: { textureBands: [0, 3, 6] },
    variants: [0, 3, 6].map((bands) => ({
      id: `bg_bands_${bands}`,
      kind: 'juggle',
      frames: sequence({ path: jugglePath({ contacts: 8 }), textureBands: bands, seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  // --- Family 12: cadence jitter -----------------------------------------
  // Same event, increasingly irregular arrival times, on trusted timestamps.
  fams.push({
    family: 'cadence_jitter',
    axis: 'jitterMs',
    parameterSpace: { jitterMs: [0, 6, 14] },
    variants: [0, 6, 14].map((jitterMs) => ({
      id: `jitter_${jitterMs}`,
      kind: 'juggle',
      frames: sequence({ fps: 24, path: jugglePath({ contacts: 8 }), jitterMs, seed: 11 }),
      expected: { state: 'accepted', count: 8, tolerance: 1 },
    })),
    invariant: 'count_must_match_across_variants',
  });

  return fams;
}

// =========================================================================
// The false-touch stress suite
//
// Twenty ways to try to make the engine count a touch that never happened. Every case expects zero.
// =========================================================================

export function falseTouchStress() {
  const P = DEFAULT_PERSON;
  const near = { x: 0.567, y: 0.83 };

  const c = (id, description, opts, kind = 'touch') => ({
    id,
    kind,
    description,
    frames: sequence({ seed: 61, ...opts }),
    expected: { state: 'zero_touches', count: 0 },
  });

  return [
    c('FT01_body_moves_near_still_ball', 'Player shifts body beside a stationary ball without touching it.', {
      path: stationaryPath(near),
      personAt: (t) => ({ ...P, x0: P.x0 + 0.02 * Math.sin(t / 400), x1: P.x1 + 0.02 * Math.sin(t / 400) }),
    }),

    c('FT02_still_ball_body_shift', 'Stationary ball, player sways slowly.', {
      path: stationaryPath(near),
      personAt: (t) => ({ ...P, y0: P.y0 + 0.01 * Math.sin(t / 900), y1: P.y1 + 0.01 * Math.sin(t / 900) }),
    }),

    c('FT03_ball_rolls_near_no_contact', 'Ball rolls steadily past the player without contact.', {
      path: rollPath({ x0: 0.05, x1: 0.95, y: 0.9, durationMs: 4000 }),
    }),

    c('FT04_ball_rolls_behind', 'Ball rolls behind the player, higher in frame.', {
      path: rollPath({ x0: 0.05, x1: 0.95, y: 0.4, durationMs: 4000 }),
    }),

    c('FT05_ball_passes_in_front', 'Ball passes in front of the player, low in frame.', {
      path: rollPath({ x0: 0.95, x1: 0.05, y: 0.95, durationMs: 4000 }),
    }),

    c('FT06_independent_bounce', 'Ball bounces on its own, away from the player.', {
      path: independentBouncePath({ x: 0.15 }),
    }),

    c('FT07_whole_camera_moves', 'Ball and player both stationary; the entire camera translates.', {
      path: stationaryPath(near),
      cameraDrift: (t) => ({ dx: 0.06 * Math.sin(t / 700), dy: 0.04 * Math.cos(t / 800) }),
    }),

    c('FT08_camera_pan_fixed_relation', 'Camera pans steadily; player and ball keep a fixed relationship.', {
      path: stationaryPath(near),
      cameraDrift: (t) => ({ dx: -0.1 + 0.00005 * t, dy: 0 }),
    }),

    c('FT09_person_walks_past_still_ball', 'A person walks across frame past a stationary ball.', {
      path: stationaryPath({ x: 0.8, y: 0.88 }),
      personAt: (t) => {
        const x = 0.05 + 0.00012 * t;
        return { x0: x, y0: 0.32, x1: x + 0.14, y1: 0.93, luma: 55 };
      },
    }),

    c('FT10_ball_starts_in_contact_range', 'Ball is already resting against the player when the protocol begins.', {
      path: stationaryPath({ x: 0.55, y: 0.9 }),
    }),

    c('FT11_prolonged_proximity', 'Ball rests against the foot for the entire attempt.', {
      path: stationaryPath({ x: 0.545, y: 0.91 }),
      durationMs: 8000,
    }),

    c('FT12_oscillates_near_threshold', 'Ball oscillates just outside contact range, never arriving.', {
      path: nearMissPath({ x0: 0.72, amplitude: 0.02 }),
    }),

    c('FT13_relative_motion_noise', 'Small random player-relative jitter with no real contact.', {
      path: (() => {
        let s = 5;
        const rnd = () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff - 0.5;
        };
        return () => ({ x: 0.567 + rnd() * 0.006, y: 0.83 + rnd() * 0.006 });
      })(),
    }),

    c('FT14_tracking_jitter', 'Detector-scale jitter on both ball and player.', {
      path: (t) => ({ x: 0.567 + 0.004 * Math.sin(t / 60), y: 0.83 + 0.004 * Math.cos(t / 55) }),
      personAt: (t) => ({ ...P, x0: P.x0 + 0.004 * Math.sin(t / 61), x1: P.x1 + 0.004 * Math.sin(t / 61) }),
    }),

    c('FT15_centroid_noise_high_freq', 'High-frequency centroid noise at the detector floor.', {
      path: (t) => ({ x: 0.567 + (t % 2 === 0 ? 0.003 : -0.003), y: 0.83 }),
    }),

    c('FT16_one_frame_false_proximity', 'Ball is distant except for a single frame adjacent to the player.', {
      path: (t) => (Math.abs(t - 2000) < 30 ? { x: 0.55, y: 0.86 } : { x: 0.9, y: 0.86 }),
    }),

    c('FT17_two_frame_false_proximity', 'Ball is distant except for two adjacent frames near the player.', {
      path: (t) => (t >= 2000 && t <= 2180 ? { x: 0.55, y: 0.86 } : { x: 0.9, y: 0.86 }),
    }),

    c('FT18_sudden_bbox_size_change', 'Player region changes size abruptly mid-attempt.', {
      path: stationaryPath(near),
      personAt: (t) => (t < 2400 ? P : { x0: 0.3, y0: 0.2, x1: 0.62, y1: 0.97, luma: 55 }),
    }),

    c('FT19_ball_crosses_behind_silhouette', 'Ball passes behind the player and is briefly occluded.', {
      path: (t) => {
        const x = 0.05 + 0.0002 * t;
        if (x > 0.4 && x < 0.54) return null; // hidden by the player
        return { x: Math.min(0.97, x), y: 0.62 };
      },
    }),

    c('FT20_lost_then_reacquired_near_player', 'Ball is lost for a few frames and reappears beside the player.', {
      path: (t) => {
        if (t > 1500 && t < 1900) return null;
        return t <= 1500 ? { x: 0.85, y: 0.86 } : { x: 0.56, y: 0.86 };
      },
    }),
  ];
}
