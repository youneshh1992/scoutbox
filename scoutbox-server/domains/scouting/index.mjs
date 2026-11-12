// Scouting: the club's evidence and assessments, opportunities and campaigns, and trial days.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerJourneys } from './journeys.mjs';
import { registerPassport } from './passport.mjs';
import { registerScouting } from './scouting.mjs';
import { registerSuitability } from './suitability.mjs';

/** Evidence and coach identity, assessments and video, opportunities and applications, campaigns, trial days, and the player's private suitability preferences. */
export function createScouting(deps) {
  needs('createScouting', deps, [
    'byId',
    'scoutingReads',
    'verificationReads',
    'players',
    'unit',
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'nextId',
    'notify',
    'ledgerAppend',
    'broadcast',
    'scoutingEvidence',
    'clubSetup',
    'transitionsVouches',
    'findPlayer',
    'moderateOrRefuse',
    'development',
    'recruitmentReads',
    'users',
    'recruitment',
    'recruitmentCases',
    'scoutingAssessments',
    'playerViewForOrg',
    'revokeOrgUserAccess',
    'grassrootsReads',
    'opportunitiesCampaigns',
    'isBlocked',
    'recordActivity',
    'DRILLS',
  ]);
  const ctx = routeContext('createScouting', deps);
  registerPassport(ctx);
  registerScouting(ctx);
  registerJourneys(ctx);
  registerSuitability(ctx);
}
