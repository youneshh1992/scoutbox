import { evaluatePolicy, representationScopeProblem, POLICY_ACTIONS } from './policy.mjs';
import { now } from '../../platform/clock.mjs';

export function createComplianceSeams(ctx) {
  const {
    byOrg,
    bySystem,
    closeContextNow,
    complianceRecords,
    contextById,
    createReview,
    engineConsentsFor,
    entry,
    evaluateAndRecord,
    facetStatesOf,
    lastEvaluation,
    nextId,
    policySetFor,
    profileOf,
    representationReviewedHandlers,
    requestDualRepresentationConsent,
  } = ctx;
  const { contexts, reviews, consents } = complianceRecords;
  /**
   * A transaction owns one compliance context and reads its verdict. The context stays personal to the agent; a club
   * party sees only the transaction's projection.
   */
  const transactionSeam = {
    /** `fn({ transactionId, representationId, outcome, by, reviewId })`. */
    onRepresentationReviewed(fn) {
      if (typeof fn !== 'function') throw new TypeError('onRepresentationReviewed takes a function');
      representationReviewedHandlers.push(fn);
    },
    openContext({ agencyOrgId, agentUserId, type, jurisdictions, transactionId, by }) {
      const c = {
        id: nextId('ctx'),
        agencyOrgId,
        agentUserId,
        type,
        jurisdictions,
        parties: [],
        representations: [],
        resolvedFacts: [],
        reEvaluationPending: false,
        reviewRejectedAt: null,
        status: 'open',
        origin: 'transaction',
        transactionId,
        openedAt: now(),
        closedAt: null,
        keys: {},
        rev: 1,
        revAt: now(),
        revBy: null,
        history: [
          entry('compliance_context_opened', by, {
            type,
            policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id),
          }),
        ],
      };
      return contexts.create(c);
    },
    contextById,
    /** The engine's input, rebuilt from the transaction's own rows every time so it cannot go stale. */
    project(c, { parties, representations }) {
      contexts.project(c.id, {
        parties: parties.map((p) => ({
          id: p.id,
          partyRole: p.partyRole,
          subjectKind: p.subjectKind,
          subjectId: p.subjectId,
          addedAt: p.addedAt ?? null,
          removed: !!p.removed,
          removedAt: p.removed ? (p.removedAt ?? null) : null,
        })),
        representations: representations.map((r) => ({
          id: r.id,
          agentUserId: r.agentUserId,
          partyRole: r.partyRole,
          agreementId: r.agreementId ?? null,
          status: r.status,
          declaredOnly: !!r.declaredOnly,
          reviewId: r.reviewId ?? null,
          declaredAt: null,
          firstActAt: r.firstActAt ?? null,
          withdrawnAt: null,
          verifiedByReviewId: null,
          verifiedAt: null,
          keys: {},
        })),
      });
    },
    evaluate(c, by, opts = {}) {
      return evaluateAndRecord(c, by, opts);
    },
    lastEvaluation,
    evaluationById: (id) => contexts.evaluationById(id),
    consentAnswerWaits: () => consents.transactionAnswerWaits(),
    /** A snapshot taken without an evaluation (the facet gate refused first) still answers the policy flag. */
    clearReEvaluation(c) {
      if (c && contextById(c.id)?.reEvaluationPending) contexts.clearReEvaluation(c.id);
    },
    consentsFor: engineConsentsFor,
    closeContext(c, by) {
      const cur = c ? contextById(c.id) : null;
      if (!cur || cur.status === 'closed') return;
      closeContextNow(cur, by);
    },
    /** The first refusal payload, or null; the caller decides how to answer. */
    facetGateProblem(agentUserId, mas) {
      const p = profileOf(agentUserId);
      if (!p) return { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' };
      const set = policySetFor(mas);
      const d = evaluatePolicy({
        action: 'declare_representation',
        memberAssociations: mas,
        facets: facetStatesOf(p),
        policySet: set.policies,
        missingPolicies: set.missing,
        now: now(),
      });
      if (d.facetGaps.length) {
        const g = d.facetGaps[0];
        return {
          error: g.code,
          facet: g.facet,
          memberAssociation: g.memberAssociation,
          state: g.state,
          gate: 'FACET_NOT_VERIFIED',
        };
      }
      if (d.requiresManualReview && d.reasons.some((r) => r.code === 'POLICY_NOT_ENCODED'))
        return {
          error: 'JURISDICTION_UNSUPPORTED',
          reasons: d.reasons.filter((r) => r.code === 'POLICY_NOT_ENCODED'),
          policyVersions: d.policyVersions,
          gate: 'JURISDICTION_UNSUPPORTED',
        };
      return null;
    },
    /** For the party-revision hash: a licence change must make a snapshot stale. */
    facetStatesFor: (agentUserId) => {
      const p = profileOf(agentUserId);
      return p ? facetStatesOf(p) : null;
    },
    representationScopeProblem,
    requestConsent: requestDualRepresentationConsent,
    reviewsForContext: (ctxId) =>
      reviews.forContext(ctxId).map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt ?? null,
        outcome: r.decision?.outcome ?? null,
      })),
    createReview,
    byOrg,
    bySystem,
  };

  /** Is this agent clear, under the policy in force now, to perform this regulated action in this jurisdiction? */
  const integrationSeam = {
    clearFor({ agentUserId, jurisdiction, action }) {
      if (!POLICY_ACTIONS.includes(action))
        return { clear: false, reasonCodes: ['ACTION_UNKNOWN'], policyVersions: [] };
      const p = profileOf(agentUserId);
      if (!p) return { clear: false, reasonCodes: ['AGENT_PROFILE_REQUIRED'], policyVersions: [] };
      // Only the action's jurisdiction: one the agent merely declared must not bar an act elsewhere (an agent not
      // registered with the FA is not barred from an international act). `evaluatePolicy` adds INT itself.
      const mas = [jurisdiction].filter((m) => typeof m === 'string' && m);
      // No jurisdiction is not the international default; it fails closed.
      if (!mas.length) return { clear: false, reasonCodes: ['JURISDICTION_UNKNOWN'], policyVersions: [] };
      const set = policySetFor(mas);
      const d = evaluatePolicy({
        action,
        memberAssociations: mas,
        facets: facetStatesOf(p),
        policySet: set.policies,
        missingPolicies: set.missing,
        now: now(),
      });
      return {
        clear: d.allowed === true,
        reasonCodes: [...new Set(d.reasons.filter((r) => r.code !== 'FACET_VERIFIED').map((r) => r.code))],
        policyVersions: d.policyVersions,
      };
    },
    facetStatesFor: (agentUserId) => {
      const p = profileOf(agentUserId);
      return p ? facetStatesOf(p) : null;
    },
  };

  return { transactionSeam, integrationSeam };
}
