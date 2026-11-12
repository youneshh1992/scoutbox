// Passport: the Football Passport (a provenance-aware projection over other domains' records) and the Trust Score
// (an evidence-confidence summary over it). Neither grants access to anything.
import { needs, strictContext } from '../platform/deps.mjs';
import { registerFootballPassport } from './football.mjs';
import { registerTrustScore } from './trust/index.mjs';

/**
 * Returns the Passport projections (`assemblePassport`, `buildFootballPassport`, `passportRevisionOf`,
 * `passportHistoryFor`) and the Trust Score's (`buildTrustProfile`, `trustSummaryFor`, `trustSnapshotOf`,
 * `safeTrustProjection`), each behind its own gate, and `trustWeightsTotal` for the boot checks.
 */
export function createPassport(deps) {
  needs('createPassport', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'players',
    'passport',
    'development',
    'scoutingReads',
    'verificationReads',
    'agentReads',
    'developmentReads',
    'boxCamReads',
    'recruitmentReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'moderateOrRefuse',
    'playerViewForOrg',
    'recordSourceChange',
    'testProviderEnabled',
    'unit',
    'nextId',
    'notify',
    'ledgerAppend',
  ]);
  const { testProviderEnabled, ...passportDeps } = deps;
  const passport = registerFootballPassport(strictContext('createPassport', passportDeps));
  const trust = registerTrustScore(
    strictContext('createPassport', {
      byId: deps.byId,
      players: deps.players,
      scoutingReads: deps.scoutingReads,
      verificationReads: deps.verificationReads,
      agentReads: deps.agentReads,
      boxCamReads: deps.boxCamReads,
      orgRouter: deps.orgRouter,
      playerRouter: deps.playerRouter,
      guardianRouter: deps.guardianRouter,
      adminRouter: deps.adminRouter,
      findPlayer: deps.findPlayer,
      isBlocked: deps.isBlocked,
      assemblePassport: passport.assemblePassport,
      passportHistoryFor: passport.passportHistoryFor,
      testProviderEnabled,
    }),
  );
  return {
    assemblePassport: passport.assemblePassport,
    buildFootballPassport: passport.buildFootballPassport,
    passportRevisionOf: passport.passportRevisionOf,
    passportHistoryFor: passport.passportHistoryFor,
    buildTrustProfile: trust.buildTrustProfile,
    trustSummaryFor: trust.trustSummaryFor,
    trustSnapshotOf: trust.trustSnapshotOf,
    safeTrustProjection: trust.safeTrustProjection,
    trustWeightsTotal: trust.trustWeightsTotal,
  };
}
