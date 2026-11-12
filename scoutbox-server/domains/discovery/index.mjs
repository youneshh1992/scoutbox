// Discovery: player search and the Film Room, saved searches, recruitment briefs with Second Look and Nobody Missed,
// Explainable Matching and its watchlists, and the stored match facts they all query.
import { needs, strictContext } from '../platform/deps.mjs';
import { registerFilmRoom } from './filmRoom.mjs';
import { createInsights } from './insights.mjs';
import { createMatchFactsKeeper } from './matchFacts.mjs';
import { registerMatching } from './matching/index.mjs';
import { registerSavedSearches } from './savedSearches.mjs';
import { registerPlayerSearch } from './search.mjs';
import { registerDiscovery } from './workflows.mjs';

/** `insightsFor(playerId)`: what the Discovery Ledger says about who has looked at a player. No routes. */
export function createPlayerInsights(deps) {
  const { safetyAudit } = needs('createPlayerInsights', deps, ['safetyAudit']);
  return createInsights({ ledger: safetyAudit.ledger });
}

/**
 * Search, the Film Room and saved searches; Second Look (has something material changed since this club last
 * decided?) and Nobody Missed (do eligible players match the club's own criteria without ever entering its workflow?);
 * and Explainable Matching, which reuses the same stored facts and the Rooms' one Room-creation path. None of them
 * judges talent or ranks, and none registers a player, guardian or public route. Returns `checkSavedSearches` and the
 * match facts keeper, which `server.mjs` starts and sweeps.
 */
export function createDiscovery(deps) {
  needs('createDiscovery', deps, [
    'orgRouter',
    'players',
    'playerRecord',
    'recruitment',
    'recruitmentActs',
    'discovery',
    'discoveryReads',
    'matchFacts',
    'savedSearches',
    'notifications',
    'safetyAudit',
    'scoutingReads',
    'verificationReads',
    'agentReads',
    'boxCamReads',
    'insightReads',
    'recruitmentReads',
    'sqlite',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'playerViewForOrg',
    'combineProtocolIds',
    'assemblePassport',
    'buildTrustProfile',
    'safeTrustProjection',
    'trustSummaryFor',
    'trustPolicyVersion',
    'testProviderEnabled',
    'combineProjection',
    'reopenRoom',
    'createRoomForPlayer',
    'sourceChangesFor',
    'unit',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
  ]);
  const d = strictContext('createDiscovery', deps);
  const { orgRouter, players, safetyAudit, findPlayer, isBlocked, ledgerAppend, broadcast, nextId } = d;
  const { playerViewForOrg, notify, unit, byId } = d;
  registerPlayerSearch({
    orgRouter,
    players,
    safetyAudit,
    findPlayer,
    isBlocked,
    ledgerAppend,
    broadcast,
    nextId,
    playerViewForOrg,
  });
  registerFilmRoom({
    orgRouter,
    players,
    playerRecord: d.playerRecord,
    recruitment: d.recruitment,
    recruitmentActs: d.recruitmentActs,
    safetyAudit,
    findPlayer,
    isBlocked,
    unit,
    ledgerAppend,
    notify,
    broadcast,
    playerViewForOrg,
  });
  const { checkSavedSearches } = registerSavedSearches({
    byId,
    orgRouter,
    notify,
    nextId,
    playerViewForOrg,
    savedSearches: d.savedSearches,
  });

  const workflowDeps = {
    orgRouter,
    players,
    discovery: d.discovery,
    discoveryReads: d.discoveryReads,
    matchFacts: d.matchFacts,
    scoutingReads: d.scoutingReads,
    verificationReads: d.verificationReads,
    boxCamReads: d.boxCamReads,
    insightReads: d.insightReads,
    recruitmentReads: d.recruitmentReads,
    byId,
    findPlayer,
    isBlocked,
    rateLimit: d.rateLimit,
    combineProtocolIds: d.combineProtocolIds,
    assemblePassport: d.assemblePassport,
    buildTrustProfile: d.buildTrustProfile,
    safeTrustProjection: d.safeTrustProjection,
    combineProjection: d.combineProjection,
    reopenRoom: d.reopenRoom,
    createRoomForPlayer: d.createRoomForPlayer,
    sourceChangesFor: d.sourceChangesFor,
    unit,
    nextId,
    notify,
    broadcast,
  };
  const workflows = registerDiscovery(strictContext('createDiscovery', workflowDeps));
  // Matching shares Second Look's context (its counters included) and adds the notifications it reads.
  registerMatching(strictContext('createDiscovery', { ...workflows, notifications: d.notifications }));

  // Triggers on their inputs mark a player; the keeper re-derives the marked players before every COMMIT, so matching
  // and Nobody Missed read current facts in SQL. Time-only changes (an expiry, a term, adulthood) are the sweep's.
  const matchFactsKeeper = createMatchFactsKeeper(
    strictContext('createDiscovery', {
      matchFacts: d.matchFacts,
      players,
      unit,
      sqlite: d.sqlite,
      byId,
      scoutingReads: d.scoutingReads,
      verificationReads: d.verificationReads,
      agentReads: d.agentReads,
      boxCamReads: d.boxCamReads,
      recruitmentReads: d.recruitmentReads,
      trustSummaryFor: d.trustSummaryFor,
      trustPolicyVersion: d.trustPolicyVersion,
      testProviderEnabled: d.testProviderEnabled,
    }),
  );
  return { checkSavedSearches, matchFactsKeeper };
}
