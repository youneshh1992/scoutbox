// Scouting: the club's evidence and assessments, opportunities and campaigns, and trial days.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { CLUB_SETUP_LIMITS } from '../../repositories/clubSetup.mjs';
import { registerJourneys } from './journeys.mjs';
import { registerPassport } from './passport.mjs';
import { registerScouting } from './scouting.mjs';
import { registerSuitability } from './suitability.mjs';

/**
 * The writes another domain makes on a club's setup: a player joining the squad (from an approved invitation or a
 * completed signing; a player already on it stays as they are, and one the club shadowed joins all the same, since the
 * shadow list is not the squad), a grassroots club's own squad entries and what it is looking for, the
 * federation-route verification request, and the follow-up sweep's reminder on an unanswered application.
 */
export function createScoutingActs(deps) {
  const { clubSetup, opportunitiesCampaigns, nextId } = strictContext(
    'createScoutingActs',
    needs('createScoutingActs', deps, ['clubSetup', 'opportunitiesCampaigns', 'nextId']),
  );
  const joinSquad = ({ orgId, playerId, name, position = null, source, approvedBy, at }) => {
    if (clubSetup.squad.has(orgId, playerId)) return;
    clubSetup.squad.create({
      id: nextId('sq'),
      orgId,
      playerId,
      name: String(name ?? 'Player').slice(0, CLUB_SETUP_LIMITS.name),
      position,
      source,
      ...(approvedBy === undefined ? {} : { approvedBy }),
      addedAt: at,
    });
  };
  return Object.freeze({
    joinSquad,
    addToSquad: (entry) => clubSetup.squad.create(entry),
    removeFromSquad: (entryId) => clubSetup.squad.remove(entryId),
    setLookingFor: (orgId, positions) => clubSetup.lookingFor.set(orgId, positions),
    submitFederationCheck: (check) => clubSetup.federation.submit(check),
    markApplicationReminded: (applicationId, reminder) =>
      opportunitiesCampaigns.applications.markReminded(applicationId, reminder),
  });
}

/** Evidence and coach identity, assessments and video, opportunities and applications, campaigns, trial days, and the player's private suitability preferences. */
export function createScouting(deps) {
  needs('createScouting', deps, [
    'byId',
    'scoutingReads',
    'verificationReads',
    'players',
    'playerRecord',
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
    'joinSquad',
    'transitionsVouches',
    'coachReferences',
    'findPlayer',
    'moderateOrRefuse',
    'development',
    'recruitmentReads',
    'users',
    'staffRecord',
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
