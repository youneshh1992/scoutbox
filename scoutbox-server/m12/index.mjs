// Registration point for these feature modules. Each receives the shared server
// context and registers routes on the existing authenticated routers, so all
// existing gates (bearer sessions, org suspension, guardian ownership,
// visibleToOrg, blocks, moderation) apply before any of their handlers run.
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
  registerPassport(full);   // evidence · coach identity
  registerScouting(full);   // assessments · video · recruitment · tactical fit
  registerJourneys(full);   // opportunities · campaigns · trial-day
  registerObjectives(full); // drill guidance · development objectives
  const { sweepUploads } = registerUploads(full); // resumable uploads
  registerOperations({ ...full, sweepUploads }); // outcomes + jobs · captions/benchmarks
}
