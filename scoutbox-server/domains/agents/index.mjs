// Agents: agency membership and access, agent profiles and client-confirmed representation, the Conflict & Compliance
// Engine with its attributed Trust & Safety reviewer lane, the cross-app integration, and the transaction workspace.
import express from 'express';
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { createAgentAccess } from './access.mjs';
import { registerCompliance } from './compliance/index.mjs';
import { createVerificationProvider } from './compliance/provider.mjs';
import { registerAgent } from './core/index.mjs';
import { registerIntegration } from './integration/index.mjs';
import { registerTransactions } from './transactions/index.mjs';

/**
 * Returns `access` (agency membership, role capabilities and the concealing agreement lookup), the integration `seam`
 * (may this agent see or do this, on this surface, for this client, now?), the transactions' `offerReadinessFor`, the
 * minute `agentSweep`, and each part's `onPlayerDeleted` for a player's erasure.
 */
export function createAgents(deps) {
  needs('createAgents', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'adminRouter',
    'users',
    'players',
    'sessions',
    'channels',
    'notifications',
    'agentCore',
    'agentTransactions',
    'compliancePolicies',
    'complianceRecords',
    'caseHandoffs',
    'agentReads',
    'verificationReads',
    'scoutingReads',
    'grassrootsReads',
    'recruitmentReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'sessionFor',
    'createSession',
    'hashPassword',
    'verifyPassword',
    'devLogins',
    'moderateOrRefuse',
    'playerViewForOrg',
    'orgSafe',
    'revokeOrgUserAccess',
    'findRoomForRequest',
    'verificationSynthetic',
    'unit',
    'nextId',
    'notify',
    'broadcast',
  ]);
  const { verificationSynthetic, findRoomForRequest, ...base } = deps;
  const { agentCore, unit, nextId, broadcast } = deps;
  const access = createAgentAccess({ agentCore, unit, nextId, broadcast });
  // One verification provider for facet submissions (the agent core) and rechecks (compliance): one path to VERIFIED.
  const verificationProvider = createVerificationProvider({ synthetic: verificationSynthetic });

  // The attributed Trust & Safety lane: every route resolves a specific authenticated reviewer, never the shared key.
  const tsRouter = express.Router();
  const compliance = registerCompliance(
    routeContext('createAgents', { ...base, tsRouter, verificationProvider, access }),
  );
  deps.app.use('/ts', compliance.reviewerAuth, tsRouter);

  // It reads the cases, agreements and transactions through their repositories, so it comes before the transactions,
  // which take its seam. The Rooms' concealing case lookup is passed, not re-derived.
  const integration = registerIntegration(
    routeContext('createAgents', {
      ...base,
      access,
      compliance: compliance.integrationSeam,
      findRoomForRequest,
      transactionReads: deps.agentTransactions.reads,
    }),
  );
  const transactions = registerTransactions(
    routeContext('createAgents', {
      ...base,
      tsRouter,
      access,
      compliance: compliance.transactionSeam,
      integration: integration.seam,
    }),
  );
  const core = registerAgent(
    routeContext('createAgents', {
      ...base,
      verificationProvider,
      access,
      compliance: compliance.coreReviews,
      auditSources: [compliance.complianceAuditRows, transactions.agencyAuditRows],
    }),
  );
  return {
    access,
    integration: integration.seam,
    offerReadinessFor: transactions.offerReadinessFor,
    agentSweep: core.agentSweep,
    onPlayerDeleted: [core.onPlayerDeleted, compliance.onPlayerDeleted, transactions.onPlayerDeleted],
  };
}
