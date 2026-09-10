// M16 demo mirror — an honest, self-contained Box Cam experience with a
// SIMULATED observation stream. Every simulated session is marked
// simulated:true and labelled "Box Cam demo — simulated camera
// observations" in the UI. Nothing here is presented as real live
// verification. The demo reproduces the server's truth rules: elapsed ≠
// active, partial credit, and 1-under-target is not complete.
import type {
  PlayerM16, BoxActor, BoxDrill, BoxSession, CreatedSession, BoxDashboard,
  DevelopmentPlan, BoxChallenge, BoxAssignment, BoxPrefs, BoxTarget,
} from './m16client';

const now = Date.now();
const day = 86_400_000;
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const DRILLS: BoxDrill[] = [
  { id: 'box-control', version: 1, title: 'Box Control', category: 'close_control', summary: 'Continuous close-control movement inside a defined area.', targetTypes: ['duration'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'], repSupport: 'configured', repSupportNote: null, setup: { orientation: 'landscape', distanceM: 4, space: '3m × 3m clear area', equipment: ['ball'], framing: 'Whole training area in frame', demo: 'dribbling inside the box, both feet' }, safetyNotes: 'Train in a clear, dry space. Stop if you feel pain — the recorded work still counts.', restGuidance: null, ageAppropriateness: 'all' },
  { id: 'box-touches', version: 1, title: 'Box Touches', category: 'ball_mastery', summary: 'Alternating-foot touches on top of the ball.', targetTypes: ['repetitions', 'duration'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration', 'rep_count'], repSupport: 'configured', repSupportNote: null, setup: { orientation: 'portrait', distanceM: 2.5, space: '2m × 2m clear area', equipment: ['ball'], framing: 'Full body and the ball in frame', demo: 'alternating toe taps' }, safetyNotes: 'Train in a clear, dry space.', restGuidance: null, ageAppropriateness: 'all' },
  { id: 'box-wall', version: 1, title: 'Box Wall', category: 'passing', summary: 'Wall passes — pass, control, repeat.', targetTypes: ['repetitions'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'], repSupport: 'not_configured', repSupportNote: 'Automated wall-pass repetition counting is not configured for a single camera angle. Box Cam verifies your active training time.', setup: { orientation: 'landscape', distanceM: 5, space: 'Wall + 4m run-off', equipment: ['ball', 'wall'], framing: 'Player and wall in frame', demo: 'two-touch wall passing' }, safetyNotes: 'Train in a clear, dry space.', restGuidance: null, ageAppropriateness: 'all' },
  { id: 'box-mobility', version: 1, title: 'Box Mobility', category: 'mobility', summary: 'Supported bodyweight mobility movements.', targetTypes: ['duration'], verificationCapabilities: ['player_presence', 'active_duration'], repSupport: 'configured', repSupportNote: null, setup: { orientation: 'landscape', distanceM: 3, space: '2m × 2m mat', equipment: [], framing: 'Full body in frame', demo: 'guided mobility sequence' }, safetyNotes: 'Move within a comfortable range. Not medical advice.', restGuidance: null, ageAppropriateness: 'all' },
];

const store = {
  sessions: [
    { id: 'boxs-d1', playerId: 'demo', drillId: 'box-control', drillVersion: 1, drillTitle: 'Box Control', assignmentId: 'boxa-d1', target: { type: 'duration', value: 1200000 } as BoxTarget, status: 'partially_verified', sessionDurationMs: 1267000, verifiedActiveMs: 1123000, verifiedReps: null, setsCompleted: null, targetCompleted: false, verificationState: 'partially_verified', verificationReasons: ['TARGET_NOT_YET_COMPLETED', 'OBSERVATION_QUALITY_DEGRADED'], stateCopy: 'Box Cam verified part of this session.', quality: 'degraded', interruptions: 2, provider: 'local_test', providerVersion: 1, simulated: true, note: null, provenance: 'box_cam_observed', provenanceLabel: 'Captured by Box Cam', provenanceDetail: 'Recorded live through ScoutBox Box Cam. ScoutBox observed activity consistent with the selected supported drill for 18:43.', endedAt: now - 2 * day, createdAt: now - 2 * day },
    { id: 'boxs-d2', playerId: 'demo', drillId: 'box-touches', drillVersion: 1, drillTitle: 'Box Touches', assignmentId: null, target: { type: 'repetitions', value: 250 } as BoxTarget, status: 'verified', sessionDurationMs: 190000, verifiedActiveMs: 176000, verifiedReps: 261, setsCompleted: null, targetCompleted: true, verificationState: 'verified', verificationReasons: [], stateCopy: 'Box Cam observed activity consistent with this drill for the recorded duration.', quality: 'good', interruptions: 0, provider: 'local_test', providerVersion: 1, simulated: true, note: 'Focused on my weak foot.', provenance: 'box_cam_observed', provenanceLabel: 'Box Cam Verified', provenanceDetail: 'Recorded live through ScoutBox Box Cam. ScoutBox observed 261 repetitions consistent with the selected supported drill across 2:56 of active capture.', endedAt: now - 5 * day, createdAt: now - 5 * day },
  ] as BoxSession[],
  challenges: [
    { id: 'boxc-d1', title: 'The 1,000 Touch Box Challenge', publisher: { kind: 'scoutbox' }, drillId: 'box-touches', drillTitle: 'Box Touches', metric: 'reps', targetTotal: 1000, startsAt: now - 5 * day, endsAt: now + 25 * day, adultOnly: false, participants: 42, disclaimer: 'Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.', entry: { id: 'boxe-d1', status: 'active', progress: 511, completedAt: null } },
    { id: 'boxc-d2', title: 'Eastport United Close Control Box Challenge', publisher: { kind: 'org', orgName: 'Eastport United FC' }, drillId: 'box-control', drillTitle: 'Box Control', metric: 'active_minutes', targetTotal: 60, startsAt: now - 2 * day, endsAt: now + 12 * day, adultOnly: false, participants: 18, disclaimer: 'Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.', entry: null },
  ] as BoxChallenge[],
  assignments: [
    { id: 'boxa-d1', orgName: 'Eastport United FC', drillId: 'box-control', drillTitle: 'Box Control', target: { type: 'duration', value: 1200000 }, frequencyPerWeek: 2, dueDate: null, instructions: 'Both feet, quick changes of direction.', state: 'partially_completed', sessionsCompleted: 1, lastResult: { verifiedActive: '18:43', verifiedReps: null, targetCompleted: false, verificationState: 'partially_verified', statusLabel: 'Target not yet completed' } },
    { id: 'boxa-d2', orgName: 'Eastport United FC', drillId: 'box-wall', drillTitle: 'Box Wall', target: { type: 'repetitions', value: 150 }, frequencyPerWeek: 3, dueDate: null, instructions: 'Weak-foot passes.', state: 'assigned', sessionsCompleted: 0, lastResult: null },
  ] as BoxAssignment[],
  prefs: { shareDevelopmentActivity: 'private', retainClips: false } as BoxPrefs,
};

// A deterministic simulated session used by the live-capture demo screen.
let pending: { session: BoxSession; nonce: string; plan: { active: number; session: number; reps: number | null } } | null = null;

export const m16mock: PlayerM16 = {
  drills: async () => ({ drills: DRILLS, providers: [
    { id: 'local_test', status: 'configured', label: 'Box Cam demo — simulated camera observations', testOnly: true, note: 'Deterministic demo fixture. Simulated observations are always labelled as simulated.' },
    { id: 'production_cv', status: 'not_configured', label: 'not_configured', testOnly: false, note: 'No production computer-vision model is configured in this environment. This is stated, not simulated.' },
  ] }),
  dashboard: async () => ({
    streakWeeks: 3, streakNote: 'A Box Streak is consistency against your planned training weeks. Rest days never break a streak.',
    bests: [{ drillId: 'box-touches', drillVersion: 1, bestActiveMs: 176000, bestActive: '2:56', bestReps: 261 }, { drillId: 'box-control', drillVersion: 1, bestActiveMs: 1123000, bestActive: '18:43', bestReps: null }],
    recent: store.sessions, assignments: store.assignments,
  } as BoxDashboard),
  developmentPlan: async () => ({
    objectives: [{ id: 'obj-d1', orgName: 'Eastport United FC', status: 'active', objectives: ['Improve weak-foot confidence'], assignments: store.assignments }],
    assignments: store.assignments,
    activity: { days: 30, boxSessions: 14, verifiedActiveMs: 24180000, assigned: 2, assignedCompleted: 0, focus: [{ category: 'close_control', activeMs: 7920000 }, { category: 'ball_mastery', activeMs: 7260000 }], note: 'This is evidence of recorded training activity. It is not proof of player ability.' },
    note: 'Completing sessions never automatically marks a development objective achieved.',
  } as DevelopmentPlan),
  sessions: async () => store.sessions,
  createSession: async (_playerId, body) => {
    // Simulate a realistic partial-or-complete result deterministically.
    const drill = DRILLS.find((d) => d.id === body.drillId) ?? DRILLS[0];
    const targetMs = body.target.type === 'duration' ? body.target.value : 0;
    const activeMs = body.target.type === 'duration' ? Math.round(targetMs * 0.9) : 165000;
    const reps = body.target.type === 'repetitions' ? Math.round(body.target.value * 1.02) : null;
    const session: BoxSession = {
      id: `boxs-sim-${Math.random().toString(36).slice(2, 8)}`, playerId: 'demo', drillId: drill.id, drillVersion: 1, drillTitle: drill.title,
      assignmentId: body.assignmentId ?? null, target: body.target, status: 'setup_required',
      sessionDurationMs: null, verifiedActiveMs: null, verifiedReps: null, setsCompleted: null, targetCompleted: null,
      verificationState: null, verificationReasons: [], stateCopy: null, quality: null, interruptions: 0,
      provider: 'local_test', providerVersion: 1, simulated: true, note: null, provenance: null, provenanceLabel: null, provenanceDetail: null,
      endedAt: null, createdAt: Date.now(),
    };
    pending = { session, nonce: 'demo-nonce', plan: { active: activeMs || 165000, session: (activeMs || 165000) + 14000, reps } };
    return { session, nonce: 'demo-nonce', livenessChallenge: 'show_ball', livenessNote: 'The liveness check establishes live-session presence. It is not identity verification.', drillSetup: drill.setup, readyCheck: { automated: ['camera_permission', 'camera_stream', 'device_orientation'], unableToCheckAutomatically: ['lighting', 'framing', 'space', 'single_participant'] } };
  },
  startSession: async (_p, _id, _n) => { if (pending) pending.session.status = 'recording'; return { session: pending!.session }; },
  sendEvents: async () => ({ accepted: 1, lastSeq: 1 }),
  complete: async (_p, _id, _n) => {
    const pl = pending!.plan;
    const s = pending!.session;
    const drill = DRILLS.find((d) => d.id === s.drillId)!;
    s.sessionDurationMs = pl.session;
    s.verifiedActiveMs = pl.active;
    s.verifiedReps = drill.verificationCapabilities.includes('rep_count') ? pl.reps : null;
    const target = s.target;
    s.targetCompleted = target.type === 'duration' ? pl.active >= target.value : (s.verifiedReps != null ? s.verifiedReps >= target.value : null);
    s.verificationState = s.targetCompleted === true ? 'verified' : 'partially_verified';
    s.status = s.verificationState;
    s.quality = 'good';
    s.provenance = 'box_cam_observed';
    s.provenanceLabel = s.verificationState === 'verified' ? 'Box Cam Verified' : 'Captured by Box Cam';
    s.stateCopy = s.verificationState === 'verified' ? 'Box Cam observed activity consistent with this drill for the recorded duration.' : 'Box Cam verified part of this session.';
    s.provenanceDetail = `Recorded live through ScoutBox Box Cam. ScoutBox observed activity consistent with the selected supported drill for ${fmt(pl.active)}.`;
    s.endedAt = Date.now();
    store.sessions = [s, ...store.sessions];
    return { session: s };
  },
  cancel: async () => { if (pending) { pending.session.status = 'cancelled'; pending.session.verificationState = 'cancelled'; } return { session: pending!.session }; },
  addNote: async (_p, id, note) => { const s = store.sessions.find((x) => x.id === id); if (s) s.note = note; return { session: s! }; },
  challenges: async () => store.challenges,
  joinChallenge: async (_a, challengeId) => { const c = store.challenges.find((x) => x.id === challengeId)!; c.entry = { id: 'boxe-new', status: 'active', progress: 0, completedAt: null }; return { challenge: c }; },
  assignments: async () => store.assignments,
  acceptAssignment: async (_a, id) => { const x = store.assignments.find((y) => y.id === id); if (x && x.state === 'assigned') x.state = 'accepted'; },
  dispute: async () => ({ note: 'Demo: Trust & Safety reviews Box Cam disputes. Verified results are never edited by hand.' }),
  prefs: async () => store.prefs,
  setPrefs: async (_a, body) => { store.prefs = { ...store.prefs, ...body }; return { prefs: store.prefs }; },
};
