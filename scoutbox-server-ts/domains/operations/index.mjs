// Operations: the post-signing follow-ups and their persistent sweep, and the club's operational records.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerOperations } from './followUps.mjs';

/** Returns the minute `followUpSweep`. */
export function createOperations(deps) {
  needs('createOperations', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'users',
    'orgs',
    'players',
    'playerRecord',
    'recruitment',
    'recruitmentActs',
    'scoutingActs',
    'signingsFollowUps',
    'opportunitiesCampaigns',
    'scoutingReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'sessionFor',
    'moderateOrRefuse',
    'storage',
    'sweepUploads',
    'unit',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
    'DATA_DIR',
  ]);
  const { followUpSweep } = registerOperations(routeContext('createOperations', deps));
  return { followUpSweep };
}
