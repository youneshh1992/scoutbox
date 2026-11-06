// Milestone 12 registration point. Each module receives the shared server
// context and registers routes on the existing authenticated routers, so all
// existing gates (bearer sessions, org suspension, guardian ownership,
// visibleToOrg, blocks, moderation) apply before any M12 handler runs.
import { buildShared } from './shared.mjs';
import { registerPassport } from '../domains/scouting/passport.mjs';
import { registerScouting } from '../domains/scouting/scouting.mjs';
import { registerJourneys } from '../domains/scouting/journeys.mjs';
import { registerOperations } from './operations.mjs';
import { registerUploads } from '../domains/media/uploads.mjs';
import { registerObjectives } from '../domains/development/objectives.mjs';

export function registerM12(ctx) {
  const shared = buildShared(ctx);
  const full = { ...ctx, ...shared };
  registerPassport(full);   // F1 evidence · F10 coach identity
  registerScouting(full);   // F2 assessments · F7 video · F3 recruitment · F4 tactical fit
  registerJourneys(full);   // F5 opportunities · F6 campaigns · F9 trial-day
  registerObjectives(full); // F6 drill guidance · F8 development objectives
  const { sweepUploads } = registerUploads(full); // F12A resumable uploads
  registerOperations({ ...full, sweepUploads }); // F11 outcomes + jobs · F12 captions/benchmarks
}
