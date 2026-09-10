// M16.1 demo mirror — a self-contained At-Home Combine with a SIMULATED Box
// Cam observation stream. Every simulated attempt is marked simulated:true and
// labelled "At-Home Combine demo — simulated Box Cam observations" in the UI.
// Nothing here is presented as real verification. The demo reproduces the
// server's truth rules: no projection, missing results are "—" (never 0), and
// only the demo-supported first-library protocols can produce a measurement.
import type {
  CombineClient, CombineProtocol, CombineAttempt, CombineRequest,
  CombineOverview, CombineCard, CreatedAttempt, VerificationCheck,
} from './combineClient';

const now = Date.now();
const day = 86_400_000;

// The standardized protocol library, as the server publishes it. The
// first-library (count/duration/interval) protocols are demo-supported; the
// athletic protocols need capabilities no provider has, so they stay
// "not yet supported on this device" everywhere — architected, never faked.
const PROTOCOLS: CombineProtocol[] = [
  { id: 'combine-box-touch-60', version: 1, title: 'Box Touch 60', category: 'ball_mastery', description: 'As many controlled alternating touches on top of the ball as possible in 60 seconds.', metricType: 'count', metricUnit: 'touches', direction: 'higher', precision: 'integer', protocolWindowMs: 60_000, requiredCapabilities: ['player_presence', 'ball_presence', 'rep_count'], measurementCapability: 'not_configured', demoSupported: true, setupRequirements: 'Full body and ball in frame, stable phone, 2m × 2m clear area.', cameraRequirements: 'Portrait, ~2.5m distance.', spaceRequirements: '2m × 2m clear, level surface.', equipmentRequirements: ['ball'], calibrationRequirements: [], scoringMethod: 'Verified, de-duplicated touch count inside the 60-second window.', maxVerifiedPerWindow: 3, practiceAllowed: true, safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.', status: 'active', unsupportedNote: null },
  { id: 'combine-box-juggle', version: 1, title: 'Box Juggle', category: 'ball_mastery', description: 'Total verified juggles (keepy-uppies) within a 60-second window.', metricType: 'count', metricUnit: 'juggles', direction: 'higher', precision: 'integer', protocolWindowMs: 60_000, requiredCapabilities: ['player_presence', 'ball_presence', 'rep_count'], measurementCapability: 'not_configured', demoSupported: true, setupRequirements: 'Full body in frame, ball never leaves the frame vertically.', cameraRequirements: 'Portrait, ~3m distance.', spaceRequirements: '2m × 2m clear area.', equipmentRequirements: ['ball'], calibrationRequirements: [], scoringMethod: 'Verified, de-duplicated juggle count inside the window.', maxVerifiedPerWindow: 3, practiceAllowed: true, safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.', status: 'active', unsupportedNote: null },
  { id: 'combine-box-control-60', version: 1, title: 'Box Control 60', category: 'close_control', description: 'Verified active close-control time inside a fixed 60-second protocol.', metricType: 'duration', metricUnit: 'seconds', direction: 'higher', precision: 'tenths', protocolWindowMs: 60_000, requiredCapabilities: ['player_presence', 'ball_presence', 'active_duration'], measurementCapability: 'configured', demoSupported: true, setupRequirements: 'Whole 3m × 3m training area in frame.', cameraRequirements: 'Landscape, ~4m distance.', spaceRequirements: '3m × 3m clear, level surface.', equipmentRequirements: ['ball'], calibrationRequirements: [], scoringMethod: 'Verified active-control seconds ∩ ball-visible, inside the window.', maxVerifiedPerWindow: 3, practiceAllowed: true, safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.', status: 'active', unsupportedNote: null },
  { id: 'combine-box-footwork', version: 1, title: 'Box Footwork', category: 'footwork', description: 'Completed standardized lateral footwork intervals.', metricType: 'set', metricUnit: 'intervals', direction: 'higher', precision: 'integer', protocolWindowMs: 5 * 60_000, requiredCapabilities: ['player_presence', 'active_duration', 'interval_completion'], measurementCapability: 'not_configured', demoSupported: true, setupRequirements: 'Feet clearly visible between two markers.', spaceRequirements: '2m × 2m clear area.', equipmentRequirements: [], calibrationRequirements: [], scoringMethod: 'Count of completed intervals.', maxVerifiedPerWindow: 3, practiceAllowed: true, safetyNotes: 'Rest 30–60s between sets. Stop on any pain.', status: 'active', unsupportedNote: null },
  { id: 'combine-box-strength-60', version: 1, title: 'Box Strength 60', category: 'strength', description: 'Valid observed bodyweight squat repetitions in 60 seconds. General physical-development evidence — not a measure of football ability.', metricType: 'count', metricUnit: 'reps', direction: 'higher', precision: 'integer', protocolWindowMs: 60_000, requiredCapabilities: ['player_presence', 'active_motion', 'rep_count'], measurementCapability: 'not_configured', demoSupported: true, setupRequirements: 'Full body side-on in frame.', spaceRequirements: '2m × 1m clear area.', equipmentRequirements: [], calibrationRequirements: [], scoringMethod: 'Verified, de-duplicated squat count inside the window.', maxVerifiedPerWindow: 3, practiceAllowed: true, safetyNotes: 'Bodyweight only. Stop on any pain. Not medical advice.', status: 'active', unsupportedNote: null },
  { id: 'combine-agility-5-10-5', version: 1, title: '5-10-5 Agility', category: 'athletic', description: 'Standardized 5-10-5 pro-agility shuttle. Requires spatial calibration and automated timing gates.', metricType: 'time', metricUnit: 'seconds', direction: 'lower', precision: 'hundredths', protocolWindowMs: 60_000, requiredCapabilities: ['timing_gate', 'spatial_scale'], measurementCapability: 'not_configured', demoSupported: false, setupRequirements: 'Three markers exactly 5 metres apart (Box Marker).', calibrationRequirements: ['box_marker_5m'], scoringMethod: 'Automated start/finish timing — not available in this environment.', maxVerifiedPerWindow: 3, practiceAllowed: false, safetyNotes: 'Requires a large, flat, clear surface.', status: 'active', unsupportedNote: 'Combine measurement is not yet supported on this device. ScoutBox will not estimate or fabricate a result for this test.' },
  { id: 'combine-broad-jump', version: 1, title: 'Standing Broad Jump', category: 'athletic', description: 'Standardized standing broad jump. Requires physical-scale calibration.', metricType: 'distance', metricUnit: 'centimetres', direction: 'higher', precision: 'centimetres', protocolWindowMs: 60_000, requiredCapabilities: ['spatial_scale'], measurementCapability: 'not_configured', demoSupported: false, setupRequirements: 'Calibration marker of known size in frame (Box Marker).', calibrationRequirements: ['box_marker_scale'], scoringMethod: 'Calibrated distance measurement — not available in this environment.', maxVerifiedPerWindow: 3, practiceAllowed: false, safetyNotes: 'Land safely on a soft, clear surface.', status: 'active', unsupportedNote: 'Combine measurement is not yet supported on this device. ScoutBox will not estimate or fabricate a result for this test.' },
];

const CHECKLIST = (title: string, version: number): VerificationCheck[] => [
  { label: 'Standardized ScoutBox protocol', ok: true, detail: `${title} v${version}` },
  { label: 'Live Box Cam capture', ok: true },
  { label: 'Liveness passed', ok: true },
  { label: 'Required camera setup passed', ok: true },
  { label: 'Result calculated by ScoutBox', ok: true },
  { label: 'Detector supported this metric', ok: true },
  { label: 'Attempt integrity passed', ok: true },
];

function verifiedAttempt(id: string, protocolId: string, value: number, display: string, ageDays: number): CombineAttempt {
  const p = PROTOCOLS.find((x) => x.id === protocolId)!;
  return {
    id, playerId: 'demo', protocolId, protocolVersion: 1, protocolTitle: p.title,
    metricType: p.metricType, metricUnit: p.metricUnit, direction: p.direction, mode: 'verified',
    captureContext: 'at_home', requestId: null, attemptNumber: 1,
    measuredValue: value, display, unit: p.metricUnit,
    measurementState: 'measured', combineState: 'combine_verified',
    stateCopy: 'Measured from a standardized ScoutBox Combine Protocol during a live Box Cam session, with a supported detector, and passed the required integrity checks.',
    reasons: [], provider: 'local_test', providerVersion: 1, simulated: true,
    calibration: { required: [], passed: true, checks: ['geometry_ready_check'], at: now - ageDays * day },
    startedAt: now - ageDays * day, completedAt: now - ageDays * day, createdAt: now - ageDays * day,
    provenance: 'box_cam_observed', provenanceLabel: 'Combine Verified',
    verificationExplained: CHECKLIST(p.title, 1), boxSessionId: `boxs-cmb-${id}`, resultHash: 'demo0000feedface',
  };
}

const store = {
  attempts: [
    verifiedAttempt('catt-d1', 'combine-box-touch-60', 184, '184', 3),
    verifiedAttempt('catt-d2', 'combine-box-juggle', 87, '87', 6),
    verifiedAttempt('catt-d3', 'combine-box-control-60', 57.4, '57.4', 9),
  ] as CombineAttempt[],
  requests: [
    {
      id: 'creq-d1', orgId: 'org-eastport', orgName: 'Eastport United FC', title: 'Autumn At-Home Combine',
      requestedBy: { userId: 'u-eastport', name: 'A. Coach', role: 'Head of Recruitment', at: now - 2 * day },
      playerId: 'demo',
      protocols: [
        { protocolId: 'combine-box-touch-60', protocolTitle: 'Box Touch 60', completed: true },
        { protocolId: 'combine-box-control-60', protocolTitle: 'Box Control 60', completed: false },
      ],
      deadline: new Date(now + 12 * day).toISOString().slice(0, 10),
      instructions: 'Portrait for touches, landscape for control. Powered by Box Cam.',
      state: 'requested', createdAt: now - 2 * day, completedCount: 1, requiredCount: 2,
      note: 'Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.',
    },
  ] as CombineRequest[],
};

const bests = () => {
  const map = new Map<string, CombineAttempt>();
  for (const a of store.attempts) {
    if (a.combineState !== 'combine_verified' || a.measuredValue == null) continue;
    const key = `${a.protocolId}@${a.protocolVersion}`;
    const cur = map.get(key);
    if (!cur) { map.set(key, a); continue; }
    const better = a.direction === 'lower' ? a.measuredValue! < cur.measuredValue! : a.measuredValue! > cur.measuredValue!;
    if (better) map.set(key, a);
  }
  return [...map.values()];
};

// A deterministic simulated attempt used by the live-capture demo screen.
let pending: { attempt: CombineAttempt; protocol: CombineProtocol; value: number; display: string } | null = null;

const fmtValue = (p: CombineProtocol, v: number) => p.precision === 'tenths' ? v.toFixed(1) : p.precision === 'hundredths' ? v.toFixed(2) : `${Math.round(v)}`;
const simulatedValue = (p: CombineProtocol) => {
  switch (p.id) {
    case 'combine-box-touch-60': return 188;
    case 'combine-box-juggle': return 92;
    case 'combine-box-control-60': return 58.6;
    case 'combine-box-footwork': return 5;
    case 'combine-box-strength-60': return 41;
    default: return 0;
  }
};

export const combineMock: CombineClient = {
  protocols: async () => ({
    protocols: PROTOCOLS,
    productionProvider: { id: 'web_client', status: 'configured', label: 'Web capture (presence + active duration)', capabilities: ['player_presence', 'ball_presence', 'active_duration'] },
    testProviderEnabled: true,
    note: 'A Combine test can be Combine Verified only when the active detector genuinely supports its metric. Unsupported tests are labelled honestly and never estimated.',
  }),
  overview: async (): Promise<CombineOverview> => ({
    verifiedResults: bests(),
    personalBests: bests().length,
    attempts: [...store.attempts].sort((a, b) => b.createdAt - a.createdAt),
    activeRequests: store.requests.filter((r) => r.state !== 'completed' && r.state !== 'cancelled'),
    capabilityNote: 'Real numbers. Real evidence. From anywhere. Some tests are not yet measurable on this device — those are marked, never estimated.',
  }),
  card: async (): Promise<CombineCard> => ({
    player: { id: 'demo', name: 'Kola Adeyemi', age: 17, position: 'ST' },
    results: bests().map((a) => ({ protocolId: a.protocolId, protocolTitle: a.protocolTitle, display: a.display, unit: a.unit, combineVerified: true, protocolVersion: a.protocolVersion, completedAt: a.completedAt ?? now })),
    capturedBy: 'box_cam', updatedAt: now,
    note: 'This card is a collection of standardized measurements captured with Box Cam. It is not an overall rating — clubs decide what matters.',
  }),
  requests: async () => store.requests.filter((r) => r.state !== 'cancelled'),
  createAttempt: async (_playerId, body): Promise<CreatedAttempt> => {
    const proto = PROTOCOLS.find((p) => p.id === body.protocolId) ?? PROTOCOLS[0];
    if (!proto.demoSupported) {
      const err = new Error('This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result.') as Error & { code?: string };
      err.code = 'MEASUREMENT_NOT_SUPPORTED';
      throw err;
    }
    const attempt: CombineAttempt = {
      id: `catt-sim-${Math.random().toString(36).slice(2, 8)}`, playerId: 'demo',
      protocolId: proto.id, protocolVersion: proto.version, protocolTitle: proto.title,
      metricType: proto.metricType, metricUnit: proto.metricUnit, direction: proto.direction,
      mode: body.mode, captureContext: body.captureContext, requestId: body.requestId ?? null, attemptNumber: 1,
      measuredValue: null, display: '—', unit: proto.metricUnit,
      measurementState: null, combineState: 'ready', stateCopy: null, reasons: [],
      provider: 'local_test', providerVersion: 1, simulated: true,
      calibration: { required: [], passed: true, checks: ['geometry_ready_check'], at: Date.now() },
      startedAt: null, completedAt: null, createdAt: Date.now(),
      provenance: null, provenanceLabel: null, verificationExplained: null,
      boxSessionId: `boxs-cmb-${Math.random().toString(36).slice(2, 7)}`, resultHash: null,
    };
    pending = { attempt, protocol: proto, value: simulatedValue(proto), display: fmtValue(proto, simulatedValue(proto)) };
    return {
      attempt, boxSession: { id: attempt.boxSessionId!, status: 'setup_required' },
      nonce: 'demo-nonce', livenessChallenge: 'show_ball',
      livenessNote: 'The liveness check establishes live-session presence. It is not identity verification.',
      expiresAt: Date.now() + 600_000, protocol: proto,
      readyCheck: { automated: ['camera_permission', 'camera_stream', 'device_orientation'], unableToCheckAutomatically: ['lighting', 'framing', 'space', 'single_participant'] },
      calibration: { required: [], note: 'No physical-scale calibration required — standardized geometry only.' },
    };
  },
  calibrate: async (_p, _id, _checks) => ({ attempt: pending!.attempt, calibrationPassed: true }),
  startBox: async () => { if (pending) pending.attempt.startedAt = Date.now(); return { session: { id: pending?.attempt.boxSessionId, status: 'recording' } }; },
  sendBoxEvents: async () => ({ accepted: 2, lastSeq: 2 }),
  complete: async (): Promise<{ attempt: CombineAttempt; boxSession: Record<string, unknown> }> => {
    const { attempt: a, protocol: p, value, display } = pending!;
    a.measuredValue = value; a.display = display;
    a.measurementState = 'measured'; a.combineState = 'combine_verified';
    a.stateCopy = 'Measured from a standardized ScoutBox Combine Protocol during a live Box Cam session, with a supported detector, and passed the required integrity checks.';
    a.completedAt = Date.now();
    a.provenance = 'box_cam_observed'; a.provenanceLabel = 'Combine Verified';
    a.verificationExplained = CHECKLIST(p.title, p.version);
    a.resultHash = 'demo0000feedface';
    store.attempts = [a, ...store.attempts];
    // Reflect Club Combine progress like the server does.
    for (const r of store.requests) {
      const hit = r.protocols.find((x) => x.protocolId === a.protocolId);
      if (hit) hit.completed = true;
      r.completedCount = r.protocols.filter((x) => x.completed).length;
      if (r.completedCount >= r.requiredCount) r.state = 'completed';
    }
    return { attempt: a, boxSession: { id: a.boxSessionId, status: 'verified' } };
  },
  cancel: async () => { if (pending) { pending.attempt.combineState = 'cancelled'; } return { attempt: pending!.attempt }; },
};
