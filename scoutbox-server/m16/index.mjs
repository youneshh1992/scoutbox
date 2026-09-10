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

export function registerM16(ctx) {
  const { db } = ctx;
  db.boxSessions ??= [];
  db.boxSessionEvents ??= [];   // reserved: aggregates live on the session record
  db.boxAssignments ??= [];
  db.boxChallenges ??= [];
  db.boxChallengeEntries ??= [];
  db.boxCamDisputes ??= [];
  db.boxCamPrefs ??= [];

  // Privacy-safe operational metrics — counters only, never player labels.
  metrics.boxCam = {
    box_sessions_started: 0, box_sessions_completed: 0, box_sessions_verified: 0,
    box_sessions_partial: 0, box_sessions_unverifiable: 0, box_session_active_seconds: 0,
    box_assignment_created: 0, box_assignment_completed: 0,
    box_challenge_started: 0, box_challenge_completed: 0, provider_errors: 0,
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
  registerBoxCamSessions(shared);
  return shared;
}
