// Box Cam + Development Intelligence registration point. Focused modules receive the shared server context and
// register on the authenticated routers, so every standing gate runs before any Box Cam handler.
//
// Persistence is limited to what Box Cam genuinely introduces: sessions (aggregated observations, never raw frames
// or video), assignments, challenges (+entries), disputes and privacy prefs, Combine requests and attempts, and CV
// results. The drill registry is versioned code, and the Football Passport PROJECTS Box Cam data — it is never
// copied.
import { metrics } from '../../enterprise/enterprise.mjs';
import { DRILLS, PROVIDERS } from './drills.mjs';
import { registerBoxCamSessions } from './sessions.mjs';
import { registerBoxTraining } from './training.mjs';
import { registerCombine } from './combine.mjs';
import { registerProductionCvRoutes } from './cv/routes.mjs';

export function registerBoxCam(ctx) {
  // Box Cam, Combine and the CV results are tables (repositories/boxCam.mjs); every module writes through `boxCam`
  // and reads through `boxCamReads`.
  if (typeof ctx.boxCam?.sessions?.create !== 'function' || !ctx.boxCamReads) throw new TypeError('registerBoxCam needs the Box Cam repository from the data layer');

  // Privacy-safe operational metrics — counters only, never player labels.
  metrics.boxCam = {
    box_sessions_started: 0, box_sessions_completed: 0, box_sessions_verified: 0,
    box_sessions_partial: 0, box_sessions_unverifiable: 0, box_session_active_seconds: 0,
    box_assignment_created: 0, box_assignment_completed: 0,
    box_challenge_started: 0, box_challenge_completed: 0, provider_errors: 0,
    // At-Home Combine
    combine_attempt_started: 0, combine_attempt_completed: 0, combine_attempt_verified: 0,
    combine_attempt_incomplete: 0, combine_attempt_invalidated: 0, combine_practice_started: 0,
    combine_request_created: 0, combine_request_completed: 0, club_combine_created: 0,
    combine_measurement_provider_error: 0,
    // production CV provider
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
  registerProductionCvRoutes(shared);      // production CV: frame transport, Ready Check, diagnostics
  return shared;
}
