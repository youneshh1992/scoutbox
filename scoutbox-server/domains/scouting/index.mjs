// Scouting: the club's evidence and assessments, opportunities and campaigns, and trial days.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { CLUB_SETUP_LIMITS } from '../../repositories/clubSetup.mjs';
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
  /**
   * A player joins a club's squad (from an approved invitation or a completed signing); a player already on it stays
   * as they are. A player the club shadowed joins all the same: the shadow list is not the squad.
   */
  const joinSquad = ({ orgId, playerId, name, position = null, source, approvedBy, at }) => {
    if (deps.clubSetup.squad.has(orgId, playerId)) return;
    deps.clubSetup.squad.create({
      id: deps.nextId('sq'),
      orgId,
      playerId,
      name: String(name ?? 'Player').slice(0, CLUB_SETUP_LIMITS.name),
      position,
      source,
      ...(approvedBy === undefined ? {} : { approvedBy }),
      addedAt: at,
    });
  };
  const ctx = routeContext('createScouting', { ...deps, joinSquad });
  registerPassport(ctx);
  registerScouting(ctx);
  registerJourneys(ctx);
  registerSuitability(ctx);
  return { joinSquad };
}
