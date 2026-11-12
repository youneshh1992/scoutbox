// Development: the player's activity and record, the grassroots club and journey, development objectives, Box Cam and
// the Combine, and the Development Hub.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { createActivity as createActivityRecorder } from './activity.mjs';
import { registerBoxCam } from './boxcam/index.mjs';
import { registerGrassrootsJourney } from './grassroots.mjs';
import { registerGrassrootsClub } from './grassrootsClub.mjs';
import { registerDevelopment } from './hub/index.mjs';
import { registerObjectives } from './objectives.mjs';
import { DRILLS, registerPlayerRecord } from './record.mjs';

/** `recordActivity` (a player's streak and badges) and `refreshJourneyBadges`. No routes. */
export function createActivity(deps) {
  const { players, notify } = needs('createActivity', deps, ['players', 'notify']);
  return createActivityRecorder({ players, notify });
}

/**
 * The grassroots club and the player's grassroots journey, the player's record, development objectives, Box Cam and
 * the Combine, and the Development Hub. Returns the grassroots club's `pathwayRecord` and `openTrialView`, and the
 * Combine and Box Cam projections the Recruitment Rooms and the trials show, each behind its own consent gate.
 */
export function createDevelopment(deps) {
  needs('createDevelopment', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'users',
    'orgs',
    'players',
    'grassroots',
    'clubSetup',
    'transitionsVouches',
    'signingsFollowUps',
    'development',
    'developmentReads',
    'boxCam',
    'boxCamReads',
    'scoutingReads',
    'recruitmentReads',
    'notifications',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'storage',
    'mailer',
    'guardianManagedOnly',
    'safeguardingCertified',
    'moderateOrRefuse',
    'playerViewForOrg',
    'recordActivity',
    'publishedVouchesFor',
    'insightsFor',
    'canonicalContractFor',
    'issueRecruitmentRequest',
    'scoutViewsOf',
    'unit',
    'seam',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
  ]);
  const d = strictContext('createDevelopment', deps);
  const { orgRouter, playerRouter, players, unit, seam, nextId, notify, broadcast, ledgerAppend } = d;
  const { moderateOrRefuse, recordActivity, canonicalContractFor, findPlayer } = d;
  const findOrg = d.byId.org;

  const { pathwayRecord, openTrialView } = registerGrassrootsClub({
    orgRouter,
    players,
    grassroots: d.grassroots,
    clubSetup: d.clubSetup,
    transitionsVouches: d.transitionsVouches,
    signings: d.signingsFollowUps.signings,
    findPlayer,
    findOrg,
    unit,
    seam,
    nextId,
    ledgerAppend,
    notify,
    broadcast,
    moderateOrRefuse,
    playerViewForOrg: d.playerViewForOrg,
    recordActivity,
    canonicalContractFor,
    issueRecruitmentRequest: d.issueRecruitmentRequest,
  });

  const ctx = routeContext('createDevelopment', {
    app: d.app,
    orgRouter,
    playerRouter,
    guardianRouter: d.guardianRouter,
    adminRouter: d.adminRouter,
    users: d.users,
    players,
    development: d.development,
    developmentReads: d.developmentReads,
    boxCam: d.boxCam,
    boxCamReads: d.boxCamReads,
    scoutingReads: d.scoutingReads,
    recruitmentReads: d.recruitmentReads,
    notifications: d.notifications,
    byId: d.byId,
    findPlayer,
    isBlocked: d.isBlocked,
    rateLimit: d.rateLimit,
    moderateOrRefuse,
    recordActivity,
    DRILLS,
    unit,
    nextId,
    notify,
    broadcast,
    ledgerAppend,
  });
  registerObjectives(ctx);
  const boxCamDomain = registerBoxCam(ctx);
  registerDevelopment(ctx);

  registerPlayerRecord({
    playerRouter,
    players,
    unit,
    seam,
    nextId,
    broadcast,
    storage: d.storage,
    guardianManagedOnly: d.guardianManagedOnly,
    moderateOrRefuse,
    recordActivity,
    ledgerAppend,
    insightsFor: d.insightsFor,
    canonicalContractFor,
  });
  registerGrassrootsJourney({
    app: d.app,
    playerRouter,
    guardianRouter: d.guardianRouter,
    players,
    orgs: d.orgs,
    grassroots: d.grassroots,
    clubSetup: d.clubSetup,
    transitionsVouches: d.transitionsVouches,
    findPlayer,
    findOrg,
    unit,
    seam,
    nextId,
    broadcast,
    notify,
    ledgerAppend,
    mailer: d.mailer,
    guardianManagedOnly: d.guardianManagedOnly,
    recordActivity,
    publishedVouchesFor: d.publishedVouchesFor,
    scoutViewsOf: d.scoutViewsOf,
    pathwayRecord,
    openTrialView,
    safeguardingCertified: d.safeguardingCertified,
    moderateOrRefuse,
  });

  return {
    pathwayRecord,
    openTrialView,
    combineProjection: boxCamDomain.combineProjection,
    combineRequestView: boxCamDomain.combineRequestView,
    combineProtocolActive: boxCamDomain.combineProtocolActive,
    combineOrgMaySeeResults: boxCamDomain.combineOrgMaySeeResults,
    createCombineRequests: boxCamDomain.createCombineRequests,
    boxPrefsFor: boxCamDomain.boxPrefsFor,
    providerStatus: () => boxCamDomain.providerStatus?.() ?? [],
  };
}
