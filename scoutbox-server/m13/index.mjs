// Registration point for these feature modules. Same architecture as m12/: focused domain
// modules receive the shared server context and register on the EXISTING
// authenticated routers, so every standing gate (bearer sessions, org
// suspension, guardian ownership, visibleToOrg, blocks, moderation) runs
// before any of their handlers. Order matters only where a module publishes a hook
// another consumes (delivery exposes notifyAction; imports exposes
// emitWebhook; enterprise exposes the exposure hook).
import { buildSharedM13 } from './shared.mjs';
import { registerImports } from '../domains/integrations/imports.mjs';
import { registerDelivery } from './delivery.mjs';
import { registerEnterprise } from '../domains/enterprise/enterprise.mjs';
import { registerSuitability } from '../domains/scouting/suitability.mjs';
import { registerTransitions } from '../domains/verification/transitions.mjs';
import { registerInsight } from '../domains/insight/insight.mjs';
import { registerCoverage } from '../domains/insight/coverage.mjs';
import { registerBudgets } from '../domains/recruitment/budgets.mjs';
import { registerGroups } from '../domains/groups/groups.mjs';

export function registerM13(ctx) {
  const full = { ...ctx, ...buildSharedM13(ctx) };
  registerImports(full);     // imports · identity · API keys · webhooks
  registerDelivery(full);    // dispatch centre · callbacks · acks (exposes notifyAction)
  registerEnterprise(full);  // onboarding · MFA · SSO · audit/support · backup · metrics
  registerSuitability(full); // private preferences · verdicts · approved summaries
  registerTransitions(full); // transition cases · adult representation
  registerInsight(full);     // exposure funnel · calibration · evidence gaps
  registerCoverage(full);    // fixtures/coverage
  registerBudgets(full);     // deal scenarios
  registerGroups(full);      // federation workspaces · grants
  // One shared slow tick for the m13 sweeps that are not already covered by
  // the delivery module's own timer.
  const tick = () => { full.transitionSweep?.(); full.insightSweep?.(); };
  tick();
  const timer = setInterval(tick, process.env.M13_FAST_RETRY === '1' ? 500 : 60_000);
  timer.unref();
  return full;
}
