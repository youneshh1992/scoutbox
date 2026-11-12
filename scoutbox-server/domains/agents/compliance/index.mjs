/**
 * Agent conflict and compliance routes. They decide only whether ScoutBox may permit a workflow action under
 * encoded, versioned platform policy; uncertainty never becomes permission.
 *
 * Only the attributed reviewer routes (/ts) make authoritative compliance decisions; the shared admin key is
 * read-only.
 */

import { refuseWhenLimited } from '../../platform/rateLimit.mjs';
import { normaliseClientKey } from '../../platform/idempotency.mjs';
import { parseInput } from '../../platform/schemas.mjs';
import { strictContext } from '../../platform/deps.mjs';
import { now } from '../../platform/clock.mjs';
import { REVIEWER_ROLES } from '../../../repositories/compliancePolicies.mjs';
import { REVIEW_KINDS, REVIEW_STATUSES } from '../../../repositories/complianceRecords.mjs';
import { sendComplianceError } from './errors.mjs';
import { COMPLIANCE_INPUT, complianceParseOptions } from './schemas.mjs';
import { CONSENT_KINDS } from './policyVersions.mjs';
import { createVerificationProvider } from './provider.mjs';
import { complianceAuditRows } from './audit.mjs';
import { registerReviewers } from './reviewers.mjs';
import { registerPolicies } from './policyRoutes.mjs';
import { createComplianceShared } from './shared.mjs';
import { registerFacetRoutes } from './facetRoutes.mjs';
import { registerContextRoutes } from './contextRoutes.mjs';
import { registerConsentRoutes } from './consentRoutes.mjs';
import { registerReviewRoutes } from './reviewRoutes.mjs';
import { createComplianceSeams } from './seams.mjs';

export { CONSENT_KINDS, REVIEWER_ROLES, REVIEW_KINDS, REVIEW_STATUSES };
export { POLICY_LEVEL_REASONS } from './reviewRoutes.mjs';
export const CONSENT_STATUSES = Object.freeze(['requested', 'granted', 'declined', 'revoked']);

export function registerCompliance(rawCtx) {
  const {
    byId,
    app,
    orgRouter,
    playerRouter,
    adminRouter,
    tsRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    isAdult,
    orgCanSee,
    rateLimit,
    hashPassword,
    verifyPassword,
    createSession,
    sessionFor,
    sessions,
    devLogins,
    access,
    verificationProvider,
    agentCore,
    unit,
    compliancePolicies,
    complianceRecords,
    verificationReads,
  } = rawCtx;

  const provider =
    verificationProvider ??
    createVerificationProvider({ synthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1' });
  if (typeof compliancePolicies?.reviewers?.update !== 'function')
    throw new TypeError('registerCompliance needs the compliance policies repository from the data layer');
  if (typeof complianceRecords?.contexts?.recordAct !== 'function')
    throw new TypeError('registerCompliance needs the compliance records repository from the data layer');
  const entry = (action, by, detail = null) => ({ id: nextId('aud'), at: now(), action, by, detail });
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push(entry(action, by, detail));
  };
  /** `by` is an org user, a reviewer, or a party `{ id, name }`. */
  const bumped = (by) => ({ bump: { at: now(), by } });
  const byOrg = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });
  const byClubUser = (req) => ({
    kind: 'club_user',
    userId: req.orgUser.id,
    name: req.orgUser.name,
    orgId: req.org.id,
  });
  const byReviewer = (req) => ({
    kind: 'ts_reviewer',
    userId: req.reviewer.id,
    name: req.reviewer.name,
    role: req.reviewer.role,
  });
  const bySystem = (name) => ({ kind: 'system', userId: null, name });
  const limitedOr429 = refuseWhenLimited(rateLimit);
  /** The request input read with its schema (COMPLIANCE_INPUT), or `undefined` once the refusal is sent. */
  const inputOr400 = (res, name, input, root = 'body') => {
    const parsed = parseInput(COMPLIANCE_INPUT[name], input ?? {}, complianceParseOptions(name, root));
    if (parsed.ok) return parsed.value;
    sendComplianceError(res, parsed, name);
    return undefined;
  };
  const clientKeyOr400 = (body, res) => {
    const k = normaliseClientKey(body.clientKey);
    if (!k.ok) {
      sendComplianceError(res, { error: 'COMPLIANCE_CLIENT_KEY_INVALID', message: k.message }, 'clientKey');
      return undefined;
    }
    return k.key;
  };
  if (typeof agentCore?.profiles?.recordAct !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerCompliance needs the agent core repository and unit from the data layer');
  const agentReads = agentCore.reads;
  const profileOf = (userId) => agentReads.profiles.forUser(userId);
  const activeAffiliationOf = (userId, orgId) => agentReads.affiliations.activeFor(userId, orgId, now());
  const agencyJurisdictions = (orgId) => agentReads.settings.forOrg(orgId).jurisdictions;

  /** Run inside the review decision's unit, so the review and its effect on the transaction commit together. */
  const representationReviewedHandlers = [];

  // Each part adds what it offers the later ones, so the parts are created in this order and register their routes in
  // it. Reading a name a part has not been given yet throws outside production.
  const parts = {
    app,
    orgRouter,
    playerRouter,
    adminRouter,
    tsRouter,
    byId,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    isAdult,
    orgCanSee,
    rateLimit,
    hashPassword,
    verifyPassword,
    createSession,
    sessionFor,
    sessions,
    devLogins,
    access,
    agentCore,
    unit,
    compliancePolicies,
    complianceRecords,
    verificationReads,
    provider,
    entry,
    hist,
    bumped,
    byOrg,
    byPlayer,
    byClubUser,
    byReviewer,
    bySystem,
    limitedOr429,
    inputOr400,
    clientKeyOr400,
    agentReads,
    profileOf,
    activeAffiliationOf,
    agencyJurisdictions,
    representationReviewedHandlers,
  };
  const ctx = strictContext('registerCompliance', parts);
  Object.assign(parts, registerReviewers(ctx));
  Object.assign(parts, registerPolicies(ctx));
  Object.assign(parts, createComplianceShared(ctx));
  registerFacetRoutes(ctx);
  registerContextRoutes(ctx);
  Object.assign(parts, registerConsentRoutes(ctx));
  registerReviewRoutes(ctx);
  const { transactionSeam, integrationSeam } = createComplianceSeams(ctx);
  const { reviewerAuth, onPlayerDeleted, facetNeedsReview, representationDisputed, authorizeApproach } = parts;
  const { createApproachReview, facetStatesOf, policySetFor } = parts;

  return {
    reviewerAuth,
    provider,
    onPlayerDeleted,
    coreReviews: { facetNeedsReview, representationDisputed, authorizeApproach, createApproachReview },
    complianceAuditRows: (org) => complianceAuditRows(complianceRecords.reads, org),
    facetStatesOf,
    policySetFor,
    transactionSeam,
    integrationSeam,
  };
}
