// Recruitment: requests and trials, the Discovery Ledger, budgets, the Recruitment Rooms and their analytics, the case
// lifecycle (contacts, decisions, trials), Offers, signings, the journey views and the player's Inbox.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerAnalytics } from './analytics/index.mjs';
import { registerBudgets } from './budgets.mjs';
import { registerClubTrials } from './clubTrials.mjs';
import { registerRequestInbox } from './inbox.mjs';
import { registerLedger } from './ledger.mjs';
import { createEvidenceProvider } from './lifecycle/evidence.mjs';
import { registerLifecycle } from './lifecycle/index.mjs';
import { registerJourneyRoutes } from './lifecycle/journeyRoutes.mjs';
import { registerOffers } from './offers/index.mjs';
import { createRequestWriters, registerClubRequests, requestForRecipient } from './requests.mjs';
import { registerRecruitmentRooms } from './rooms/index.mjs';
import { createContractLookup } from './signings/contract.mjs';
import { registerSigning } from './signings/index.mjs';
import { registerLegacySigning } from './signings/legacy.mjs';

/**
 * Requests, the club's trials, the ledger and budgets. Returns the one writer of a request row
 * (`issueRecruitmentRequest`) and of an accepted trial (`issueAcceptedTrial`), `contactReplyFrom`, and
 * `canonicalContractFor`, a player's current contract as the signings record it.
 */
export function createRecruitment(deps) {
  needs('createRecruitment', deps, [
    'orgRouter',
    'recruitment',
    'recruitmentCases',
    'recruitmentReads',
    'signingsFollowUps',
    'safetyAudit',
    'operationsReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'safeguardingCertified',
    'moderateOrRefuse',
    'unit',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
  ]);
  const d = strictContext('createRecruitment', deps);
  const { orgRouter, recruitment, findPlayer, isBlocked, moderateOrRefuse, unit, nextId, notify, broadcast } = d;
  const { ledgerAppend } = d;
  const canonicalContractFor = createContractLookup({ signingsFollowUps: d.signingsFollowUps });
  // The Contact, Trial and open-day flows and the Inbox's answers all write through these.
  const { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom } = createRequestWriters({
    recruitment,
    nextId,
    ledgerAppend,
    notify,
    broadcast,
    safeguardingCertified: d.safeguardingCertified,
    moderateOrRefuse,
  });
  registerClubRequests({
    orgRouter,
    recruitment,
    findPlayer,
    isBlocked,
    moderateOrRefuse,
    rateLimit: d.rateLimit,
    unit,
    issueRecruitmentRequest,
  });
  registerClubTrials({
    orgRouter,
    recruitment,
    findPlayer,
    isBlocked,
    moderateOrRefuse,
    unit,
    nextId,
    ledgerAppend,
    notify,
    broadcast,
  });
  registerLedger({
    orgRouter,
    safetyAudit: d.safetyAudit,
    recruitment,
    signings: d.signingsFollowUps.signings,
    invoices: d.operationsReads.invoices,
    reputationSeed: d.operationsReads.reputationSeed,
    findPlayer,
    isBlocked,
  });
  registerBudgets(
    routeContext('createRecruitment', {
      byId: d.byId,
      recruitmentReads: d.recruitmentReads,
      recruitmentCases: d.recruitmentCases,
      orgRouter,
      isBlocked,
      nextId,
    }),
  );
  return { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom, canonicalContractFor };
}

/**
 * The Recruitment Rooms (the club's private decision layer over one player, composed from the canonical projections
 * fetched through their own gates on every read) and the recruitment analytics, which measure the process and never a
 * player or a colleague. Returns the one recruitment evidence provider every status path uses, and the Rooms' seams:
 * the 404-concealing `findRoomForRequest`, the single status writer `applyLifecycleTransition`, `roomIsRoom`, the
 * decision-time `captureRoomSnapshot`, `createRoomForPlayer` / `reopenRoom`, and the case's agent `caseHandoffs`.
 */
export function createRooms(deps) {
  needs('createRooms', deps, [
    'orgRouter',
    'adminRouter',
    'users',
    'players',
    'recruitmentCases',
    'recruitmentReads',
    'scoutingReads',
    'boxCamReads',
    'insightReads',
    'discoveryReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'faults',
    'moderateOrRefuse',
    'playerViewForOrg',
    'assemblePassport',
    'buildFootballPassport',
    'passportRevisionOf',
    'buildTrustProfile',
    'safeTrustProjection',
    'trustSnapshotOf',
    'combineProjection',
    'combineRequestView',
    'combineProtocolActive',
    'combineOrgMaySeeResults',
    'createCombineRequests',
    'boxPrefsFor',
    'requestEvidenceGap',
    'computeEvidenceGaps',
    'unit',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
  ]);
  const { discoveryReads, ...roomDeps } = deps;
  const recruitmentEvidence = createEvidenceProvider(deps.recruitmentReads);
  const rooms = registerRecruitmentRooms(strictContext('createRooms', { ...roomDeps, recruitmentEvidence }));
  registerAnalytics(
    routeContext('createRooms', {
      rateLimit: deps.rateLimit,
      byId: deps.byId,
      players: deps.players,
      scoutingReads: deps.scoutingReads,
      discoveryReads,
      recruitmentReads: deps.recruitmentReads,
      orgRouter: deps.orgRouter,
      unit: deps.unit,
      findPlayer: deps.findPlayer,
      isBlocked: deps.isBlocked,
      nextId: deps.nextId,
      safeTrustProjection: deps.safeTrustProjection,
    }),
  );
  return {
    recruitmentEvidence,
    findRoomForRequest: rooms.findRoomForRequest,
    applyLifecycleTransition: rooms.applyLifecycleTransition,
    roomIsRoom: rooms.roomIsRoom,
    captureRoomSnapshot: rooms.captureRoomSnapshot,
    createRoomForPlayer: rooms.createRoomForPlayer,
    reopenRoom: rooms.reopenRoom,
    // An agent's handoff is part of its case: the agents domain writes one only through these acts.
    caseHandoffs: Object.freeze({
      invite: (...a) => deps.recruitmentCases.cases.inviteHandoff(...a),
      withdraw: (...a) => deps.recruitmentCases.cases.withdrawHandoff(...a),
      accept: (...a) => deps.recruitmentCases.cases.acceptHandoff(...a),
    }),
  };
}

/**
 * The case work over a Room: the lifecycle (named semantic acts with server-validated transitions, which write status
 * only through the Rooms' single writer, so the case's stage and the Room's status cannot disagree), signings (the one
 * writer of a signing, of the move to `signed` and of a player's contract status), Offers (a club act drafts one,
 * issuing freezes a revision, and only the recipient's own answer accepts or declines it), the player's, guardian's
 * and an authorised agent's journeys, and the player's Inbox. Returns `notificationTargetFor`, where a notification
 * leads, and the parts' `onPlayerDeleted` for a player's erasure.
 */
export function createCaseWorkflow(deps) {
  needs('createCaseWorkflow', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'users',
    'guardians',
    'playerRecord',
    'joinSquad',
    'injectedFailures',
    'recruitment',
    'recruitmentCases',
    'recruitmentContactsOffers',
    'signingsFollowUps',
    'notifications',
    'safetyReads',
    'scoutingReads',
    'verificationReads',
    'agentReads',
    'boxCamReads',
    'recruitmentReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'faults',
    'storage',
    'mailer',
    'billing',
    'guardianManagedOnly',
    'moderateOrRefuse',
    'safeTrustProjection',
    'combineOrgMaySeeResults',
    'boxPrefsFor',
    'testProviderEnabled',
    'refreshJourneyBadges',
    'recruitmentEvidenceProvider',
    'findRoomForRequest',
    'applyLifecycleTransition',
    'roomIsRoom',
    'captureRoomSnapshot',
    'issueRecruitmentRequest',
    'issueAcceptedTrial',
    'contactReplyFrom',
    'openChannel',
    'access',
    'integration',
    'offerReadinessFor',
    'evidence',
    'unit',
    'afterCommit',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
  ]);
  const { issueAcceptedTrial, contactReplyFrom, openChannel, offerReadinessFor, evidence, billing, ...base } = deps;
  const { refreshJourneyBadges, ...shared } = base;
  const lifecycle = registerLifecycle(routeContext('createCaseWorkflow', shared));
  const signings = registerSigning(
    routeContext('createCaseWorkflow', { ...shared, billing, refreshJourneyBadges, evidence }),
  );
  registerLegacySigning({
    orgRouter: deps.orgRouter,
    signings: deps.signingsFollowUps.signings,
    findPlayer: deps.findPlayer,
    isBlocked: deps.isBlocked,
    rateLimit: deps.rateLimit,
    unit: deps.unit,
    recordCompletedSigning: signings.recordCompletedSigning,
    legacyRecordingBlocker: signings.legacyRecordingBlocker,
  });
  // The Offer reads the transactions' readiness seam and the signing summary; it never writes `signed`.
  const offers = registerOffers(
    routeContext('createCaseWorkflow', {
      ...shared,
      transactions: { offerReadinessFor },
      signingSummary: signings.summaryForOffer,
    }),
  );
  // Reads only: the agent's route proves its basis through the same seams the Offer and signing agent routes use.
  const journeys = registerJourneyRoutes(routeContext('createCaseWorkflow', shared));
  // The player's answers go through the lifecycle, and an accepted request opens a thread.
  registerRequestInbox({
    playerRouter: deps.playerRouter,
    guardianRouter: deps.guardianRouter,
    requests: deps.recruitment.requests,
    findPlayer: deps.findPlayer,
    unit: deps.unit,
    rateLimit: deps.rateLimit,
    isBlocked: deps.isBlocked,
    contactReplyFrom,
    requestForRecipient,
    lifecycle,
    openChannel,
    issueAcceptedTrial,
    ledgerAppend: deps.ledgerAppend,
    notify: deps.notify,
    broadcast: deps.broadcast,
    guardianManagedOnly: deps.guardianManagedOnly,
  });
  return {
    notificationTargetFor: journeys.notificationTargetFor,
    onPlayerDeleted: [offers.onPlayerDeleted, signings.onPlayerDeleted],
  };
}
