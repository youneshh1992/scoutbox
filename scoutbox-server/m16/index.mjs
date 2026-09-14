// Milestone 16 registration point — Box Cam + Development Intelligence.
// Same architecture as m12–m15: focused modules receive the shared server
// context and register on the EXISTING authenticated routers, so every
// standing gate runs before any M16 handler.
//
// New persistence is limited to what Box Cam genuinely introduces:
// sessions (aggregated observations, never raw frames or video),
// assignments, challenges (+entries), disputes and privacy prefs. The
// drill registry is versioned code, and the Football Passport PROJECTS
// Box Cam data — it is never copied.
import { metrics } from '../m13/enterprise.mjs';
import { DRILLS, PROVIDERS } from './drills.mjs';
import { registerBoxCamSessions } from './sessions.mjs';
import { registerBoxTraining } from './training.mjs';
import { registerCombine } from './combine.mjs';
import { registerM22Routes } from '../m22/routes.mjs';

export function registerM16(ctx) {
  const { db } = ctx;
  db.boxSessions ??= [];
  db.boxSessionEvents ??= [];   // reserved: aggregates live on the session record
  db.boxAssignments ??= [];
  db.boxChallenges ??= [];
  db.boxChallengeEntries ??= [];
  db.boxCamDisputes ??= [];
  db.boxCamPrefs ??= [];
  db.combineAttempts ??= [];    // M16.1 At-Home Combine (measurement layer over Box Cam)
  db.combineRequests ??= [];
  // M22: canonical provider observation results. Derived metadata only —
  // counts, presence, durations, integrity counters and bounded event
  // timestamps. There is deliberately no frame store, and §117 records why:
  // frames are ephemeral by design, so nothing about them needs representing.
  db.boxCamCvResults ??= [];

  // Privacy-safe operational metrics — counters only, never player labels.
  metrics.boxCam = {
    box_sessions_started: 0, box_sessions_completed: 0, box_sessions_verified: 0,
    box_sessions_partial: 0, box_sessions_unverifiable: 0, box_session_active_seconds: 0,
    box_assignment_created: 0, box_assignment_completed: 0,
    box_challenge_started: 0, box_challenge_completed: 0, provider_errors: 0,
    // M16.1 At-Home Combine
    combine_attempt_started: 0, combine_attempt_completed: 0, combine_attempt_verified: 0,
    combine_attempt_incomplete: 0, combine_attempt_invalidated: 0, combine_practice_started: 0,
    combine_request_created: 0, combine_request_completed: 0, club_combine_created: 0,
    combine_measurement_provider_error: 0,
    // M22 production CV provider
    box_cam_cv_sessions_started: 0, box_cam_cv_accepted: 0, box_cam_cv_refused: 0,
  };
  const vmetric = (k, n = 1) => { metrics.boxCam[k] = (metrics.boxCam[k] ?? 0) + n; };

  const shared = {
    ...ctx,
    vmetric,
    testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
    drillList: () => DRILLS.map((d) => ({
      id: d.id, version: d.version, title: d.title, category: d.category, summary: d.summary,
      targetTypes: d.targetTypes, verificationCapabilities: d.verificationCapabilities,
      repSupport: d.repSupport ?? 'configured', repSupportNote: d.repSupportNote ?? null,
      setup: d.setup, safetyNotes: d.safetyNotes, restGuidance: d.restGuidance,
      ageAppropriateness: d.ageAppropriateness,
    })),
    providerStatus: () => Object.values(PROVIDERS).map((p) => ({ id: p.id, status: p.status, label: p.label ?? p.status, testOnly: !!p.testOnly, note: p.note })),
  };
  registerBoxTraining(shared);   // sets onSessionFinalized/prefs/views on ctx
  registerBoxCamSessions(shared); // sets boxMintSession/boxCompleteSession/boxSessionView
  registerCombine(shared);        // At-Home Combine — chains onSessionFinalized, reuses Box Cam
  registerM22Routes(shared);      // M22 production CV: frame transport, Ready Check, diagnostics
  return shared;
}
