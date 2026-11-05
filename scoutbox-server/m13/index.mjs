// Milestone 13 registration point. Same architecture as m12/: focused domain
// modules receive the shared server context and register on the EXISTING
// authenticated routers, so every standing gate (bearer sessions, org
// suspension, guardian ownership, visibleToOrg, blocks, moderation) runs
// before any M13 handler. Order matters only where a module publishes a hook
// another consumes (delivery exposes notifyAction; imports exposes
// emitWebhook; enterprise exposes the exposure hook).
import { migrateM13, buildSharedM13 } from './shared.mjs';
import { registerImports } from './imports.mjs';
import { registerDelivery } from './delivery.mjs';
import { registerEnterprise } from './enterprise.mjs';
import { registerSuitability } from '../domains/scouting/suitability.mjs';
import { registerTransitions } from '../domains/verification/transitions.mjs';
import { registerInsight } from '../domains/insight/insight.mjs';
import { registerCoverage } from '../domains/insight/coverage.mjs';
import { registerBudgets } from '../domains/recruitment/budgets.mjs';
import { registerGroups } from './groups.mjs';

export function registerM13(ctx) {
  migrateM13(ctx.db, ctx.players);
  const full = { ...ctx, ...buildSharedM13(ctx) };
  registerImports(full);     // F1  imports · identity · API keys · webhooks
  registerDelivery(full);    // F11 dispatch centre · callbacks · acks (exposes notifyAction)
  registerEnterprise(full);  // F12 onboarding · MFA · SSO · audit/support · backup · metrics
  registerSuitability(full); // F3  private preferences · verdicts · approved summaries
  registerTransitions(full); // F2  transition cases · F10 adult representation
  registerInsight(full);     // F4  exposure funnel · F5 calibration · F6 evidence gaps
  registerCoverage(full);    // F7  fixtures/coverage
  registerBudgets(full);     // F9  deal scenarios
  registerGroups(full);      // F8  federation workspaces · grants
  // One shared slow tick for the m13 sweeps that are not already covered by
  // the delivery module's own timer.
  const tick = () => { full.transitionSweep?.(); full.insightSweep?.(); };
  tick();
  const timer = setInterval(tick, process.env.M13_FAST_RETRY === '1' ? 500 : 60_000);
  timer.unref();
  return full;
}
