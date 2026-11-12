// Insight: exposure and evidence-gap insight for clubs, and fixture coverage.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerCoverage } from './coverage.mjs';
import { registerInsight } from './insight.mjs';

/** Returns the minute `insightSweep` and the evidence-gap reads the Recruitment Rooms show. */
export function createInsight(deps) {
  needs('createInsight', deps, [
    'orgRouter',
    'playerRouter',
    'insightCoverage',
    'recruitmentReads',
    'scoutingReads',
    'safetyReads',
    'players',
    'byId',
    'findPlayer',
    'isBlocked',
    'playerViewForOrg',
    'unit',
    'nextId',
    'notify',
  ]);
  const ctx = routeContext('createInsight', deps);
  const { insightSweep, requestEvidenceGap, computeEvidenceGaps } = registerInsight(ctx);
  registerCoverage(ctx);
  return { insightSweep, requestEvidenceGap, computeEvidenceGaps };
}
