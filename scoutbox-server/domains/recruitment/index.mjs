// Recruitment: requests and trials, the Discovery Ledger, budgets, the Recruitment Rooms and their analytics, the case
// lifecycle (contacts, decisions, trials), Offers, signings, the journey views and the player's Inbox.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerBudgets } from './budgets.mjs';
import { registerClubTrials } from './clubTrials.mjs';
import { registerLedger } from './ledger.mjs';
import { createRequestWriters, registerClubRequests } from './requests.mjs';
import { createContractLookup } from './signings/contract.mjs';

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
    'operations',
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
    invoices: d.operations.invoices,
    reputationSeed: d.operations.reputationSeed,
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
