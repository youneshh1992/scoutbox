// M16 — Box Cam drill registry + observation provider contracts.
//
// A deliberately BOUNDED first library: each drill is a versioned detector
// contract. A drill only ever claims the verification capabilities its
// detector genuinely has — where automated repetition counting is not
// reliable (Box Wall from a single phone angle), the drill ships as
// active_duration_only and says so, rather than fabricating counts.
// Sessions pin drillId@drillVersion forever; a future detector version is a
// NEW measurement and never rewrites history.

export const CAPABILITIES = [
  'player_presence', 'ball_presence', 'active_motion', 'active_duration',
  'rep_count', 'foot_classification', 'interval_completion', 'technique_signals',
];

const drill = (d) => ({
  safetyNotes: 'Train in a clear, dry space. Stop if you feel pain or dizziness — the recorded work still counts.',
  restGuidance: null,
  ageAppropriateness: 'all',
  thresholds: { repMinGapMs: 250, repMinConfidence: 0.5 },
  ...d,
});

export const DRILLS = [
  drill({
    id: 'box-touches', version: 1, title: 'Box Touches', category: 'ball_mastery',
    summary: 'Alternating-foot touches on top of the ball at a steady rhythm.',
    targetTypes: ['repetitions', 'duration'],
    verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration', 'rep_count'],
    setup: { orientation: 'portrait', distanceM: 2.5, space: '2m × 2m clear area', equipment: ['ball'], framing: 'Full body and the ball in frame', demo: 'alternating toe taps on the ball' },
    thresholds: { repMinGapMs: 180, repMinConfidence: 0.5 },
  }),
  drill({
    id: 'box-control', version: 1, title: 'Box Control', category: 'close_control',
    summary: 'Continuous close-control movement inside a defined area.',
    targetTypes: ['duration'],
    verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'],
    setup: { orientation: 'landscape', distanceM: 4, space: '3m × 3m clear area', equipment: ['ball'], framing: 'Whole training area in frame', demo: 'dribbling inside the box, both feet' },
  }),
  drill({
    id: 'box-juggles', version: 1, title: 'Box Juggles', category: 'ball_mastery',
    summary: 'Keepy-uppies — keep the ball off the ground.',
    targetTypes: ['repetitions', 'duration'],
    verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration', 'rep_count'],
    setup: { orientation: 'portrait', distanceM: 3, space: '2m × 2m clear area, high ceiling outdoors preferred', equipment: ['ball'], framing: 'Full body, ball never leaves frame vertically', demo: 'continuous juggling, any surface' },
    thresholds: { repMinGapMs: 300, repMinConfidence: 0.5 },
  }),
  drill({
    id: 'box-wall', version: 1, title: 'Box Wall', category: 'passing',
    summary: 'Wall passes — pass, control, repeat.',
    targetTypes: ['repetitions'],
    // HONESTY: single-phone wall-pass rep counting is not reliable without
    // an additional angle. This drill verifies presence + active duration;
    // automated rep counting is explicitly not configured.
    verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'],
    repSupport: 'not_configured',
    repSupportNote: 'Automated wall-pass repetition counting is not configured for a single camera angle. Box Cam verifies your active training time; your repetition target is shown against active time, not fabricated counts.',
    setup: { orientation: 'landscape', distanceM: 5, space: 'Wall + 4m run-off', equipment: ['ball', 'wall'], framing: 'Player and wall contact point in frame', demo: 'two-touch wall passing' },
  }),
  drill({
    id: 'box-footwork', version: 1, title: 'Box Footwork', category: 'footwork',
    summary: 'Football-relevant lateral footwork patterns.',
    targetTypes: ['duration', 'sets'],
    verificationCapabilities: ['player_presence', 'active_motion', 'active_duration', 'interval_completion'],
    setup: { orientation: 'portrait', distanceM: 3, space: '2m × 2m clear area', equipment: [], framing: 'Feet clearly visible', demo: 'lateral shuffles between markers' },
    restGuidance: 'Rest 30–60 seconds between sets.',
  }),
  drill({
    id: 'box-mobility', version: 1, title: 'Box Mobility', category: 'mobility',
    summary: 'Supported bodyweight mobility movements.',
    targetTypes: ['duration'],
    verificationCapabilities: ['player_presence', 'active_duration'],
    setup: { orientation: 'landscape', distanceM: 3, space: '2m × 2m mat or soft ground', equipment: [], framing: 'Full body in frame', demo: 'guided mobility sequence' },
    safetyNotes: 'Move within a comfortable range. This is general training guidance, not medical advice.',
  }),
  drill({
    id: 'box-strength', version: 1, title: 'Box Strength', category: 'strength',
    summary: 'Controlled bodyweight squat/lunge repetitions.',
    targetTypes: ['repetitions', 'sets'],
    verificationCapabilities: ['player_presence', 'active_motion', 'active_duration', 'rep_count', 'interval_completion'],
    setup: { orientation: 'portrait', distanceM: 2.5, space: '2m × 1m clear area', equipment: [], framing: 'Full body side-on', demo: 'bodyweight squats at controlled tempo' },
    thresholds: { repMinGapMs: 900, repMinConfidence: 0.6 },
    restGuidance: 'Rest 60–90 seconds between sets.',
    safetyNotes: 'Bodyweight only. Stop on any pain — recorded work still counts. Not medical advice.',
  }),
  drill({
    id: 'box-interval', version: 1, title: 'Box Interval', category: 'conditioning',
    summary: 'Timed work/rest intervals.',
    targetTypes: ['sets', 'duration'],
    verificationCapabilities: ['player_presence', 'active_duration', 'interval_completion'],
    setup: { orientation: 'landscape', distanceM: 5, space: '5m running lane', equipment: [], framing: 'Whole lane in frame', demo: '60s work / 60s rest' },
    restGuidance: 'Rest intervals are part of the drill — the rest clock never counts as active training and never breaks verification.',
  }),
];

export const drillByIdVersion = (id, version) => DRILLS.find((d) => d.id === id && d.version === Number(version)) ?? null;
export const latestDrill = (id) => DRILLS.filter((d) => d.id === id).sort((a, b) => b.version - a.version)[0] ?? null;

// ------------------------------------------------- observation providers
// The BoxCamObservationProvider contract: prepare / processFrame / finish /
// capabilities / health. The server registry below describes what each
// provider can HONESTLY do in this environment; a session only verifies the
// intersection of drill capabilities and provider capabilities.
export const PROVIDERS = {
  production_cv: {
    id: 'production_cv', version: 0,
    status: 'not_configured',
    testOnly: false,
    capabilities: [],
    note: 'No production computer-vision model is configured in this environment. This is stated, not simulated.',
  },
  web_client: {
    id: 'web_client', version: 1,
    status: 'limited', label: 'web_limited',
    testOnly: false,
    capabilities: ['player_presence', 'active_duration'],
    note: 'Web capture infers presence and activity from camera-stream availability and app foreground state only. It cannot count repetitions or classify technique.',
  },
  local_test: {
    id: 'local_test', version: 1,
    status: 'configured',
    testOnly: true, // NEVER shown as real Box Cam evidence in production
    capabilities: [...CAPABILITIES],
    note: 'Deterministic test/demo fixture. Simulated observations are always labelled as simulated.',
  },
};

export function providerFor(id, { testProviderEnabled = false } = {}) {
  const p = PROVIDERS[id] ?? null;
  if (!p) return null;
  if (p.testOnly && !testProviderEnabled) return null;
  return p;
}

// Liveness challenges — establish live-session presence, NOT identity.
// No facial recognition, no biometric claim.
export const LIVENESS_CHALLENGES = ['raise_right_hand', 'show_ball', 'left_foot_touch', 'step_into_zone'];
