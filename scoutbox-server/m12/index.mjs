// Milestone 12 registration point. Each module receives the shared server
// context and registers routes on the existing authenticated routers, so all
// existing gates (bearer sessions, org suspension, guardian ownership,
// visibleToOrg, blocks, moderation) apply before any M12 handler runs.
import { migrateM12, buildShared } from './shared.mjs';
import { registerPassport } from './passport.mjs';
import { registerScouting } from './scouting.mjs';
import { registerJourneys } from './journeys.mjs';
import { registerOperations } from './operations.mjs';

export function registerM12(ctx) {
  migrateM12(ctx.db);
  const shared = buildShared(ctx);
  const full = { ...ctx, ...shared };
  registerPassport(full);   // F1 evidence · F10 coach identity
  registerScouting(full);   // F2 assessments · F7 video · F3 recruitment · F4 tactical fit
  registerJourneys(full);   // F5 opportunities · F6 campaigns · F8 development · F9 trial-day
  registerOperations(full); // F11 outcomes + jobs · F12 uploads/captions/benchmarks
}
