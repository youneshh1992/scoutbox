/** An agent's compliance contexts: the parties, the representations declared in them and their conflict evaluation. */

import { visibleToOrg } from '../../../domain.mjs';
import { guardRev } from '../../platform/concurrency.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { effectiveAgreementStatus, agreementGrantsAccess } from '../core/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { representationScopeProblem } from './policy.mjs';
import { PARTY_ROLES, CONTEXT_TYPES, PERMITTED_WITH_CONSENT } from './conflict.mjs';
import { now } from '../../platform/clock.mjs';

export function registerContextRoutes(ctx) {
  const {
    access,
    agentReads,
    bumpContext,
    bumped,
    byId,
    byOrg,
    clientKeyOr400,
    closeContextNow,
    complianceRecords,
    contextById,
    contextForAgent,
    createReview,
    entry,
    evaluateAndRecord,
    facetGate,
    findPlayer,
    hist,
    inputOr400,
    isAdult,
    isBlocked,
    limitedOr429,
    nextId,
    orgCanSee,
    orgRouter,
    ownContext,
    policySetFor,
    profileOf,
    ROLLBACK,
    unit,
    unitOrSent,
  } = ctx;
  const { contexts } = complianceRecords;
  /** A party its schema has read, resolved to a subject this agency may name. */
  const resolveParty = (req, res, raw) => {
    const { partyRole, subjectKind, subjectId } = raw;
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') {
        sendComplianceError(
          res,
          { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A player is the individual party.' },
          'party',
        );
        return null;
      }
      const pl = findPlayer(subjectId);
      // Missing, minor, invisible and blocked answer alike.
      if (!pl || !isAdult(pl) || !visibleToOrg(pl, req.org) || isBlocked(pl.id, req.org.id)) {
        sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party');
        return null;
      }
      return {
        id: nextId('cpt'),
        partyRole,
        subjectKind,
        subjectId: pl.id,
        addedAt: now(),
        removed: false,
        removedAt: null,
      };
    }
    if (partyRole === 'individual') {
      sendComplianceError(
        res,
        { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A club is an engaging or releasing entity.' },
        'party',
      );
      return null;
    }
    const org = byId.org(subjectId, (o) => o.type === 'club');
    if (!org) {
      sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party');
      return null;
    }
    return {
      id: nextId('cpt'),
      partyRole,
      subjectKind,
      subjectId: org.id,
      addedAt: now(),
      removed: false,
      removedAt: null,
    };
  };

  orgRouter.get('/agent/compliance/contexts', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.read')) return;
    res.json({
      items: contexts.forAgent(req.org.id, req.orgUser.id).map(contextForAgent),
      types: CONTEXT_TYPES,
      partyRoles: PARTY_ROLES,
    });
  });
  orgRouter.post('/agent/compliance/contexts', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.contexts.write')) return;
    const b = inputOr400(res, 'newContext', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const { type } = b;
    const jurisdictions = [...new Set(b.jurisdictions.map((j) => j.toUpperCase()))];
    const fp = payloadFingerprint({ type, jurisdictions, parties: b.parties ?? [] });
    if (key) {
      const hit = contexts.byCreateKey(req.org.id, req.orgUser.id, key);
      if (hit) {
        if (hit.keys.create.fp === fp) return res.json({ context: contextForAgent(hit), idempotent: true });
        return sendComplianceError(res, { error: 'CONTEXT_IDEMPOTENCY_CONFLICT' }, 'contexts');
      }
    }
    const p = profileOf(req.orgUser.id);
    if (!p)
      return sendComplianceError(
        res,
        { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' },
        'contexts',
      );
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    if (!facetGate(req, res, p, jurisdictions)) return;
    const parties = [];
    for (const raw of b.parties ?? []) {
      const party = resolveParty(req, res, raw);
      if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole))
        return sendComplianceError(
          res,
          { error: 'CONTEXT_PARTY_EXISTS', message: `A ${party.partyRole} party is already named.` },
          'contexts',
        );
      parties.push(party);
    }
    const c = {
      id: nextId('ctx'),
      agencyOrgId: req.org.id,
      agentUserId: req.orgUser.id,
      type,
      jurisdictions,
      parties,
      representations: [],
      resolvedFacts: [],
      reEvaluationPending: false,
      reviewRejectedAt: null,
      status: 'open',
      openedAt: now(),
      closedAt: null,
      keys: key ? { create: { key, fp } } : {},
      rev: 1,
      revAt: now(),
      revBy: null,
      history: [],
    };
    hist(c, 'compliance_context_opened', byOrg(req), {
      type,
      policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id),
    });
    const out = unit(() => {
      contexts.create(c);
      evaluateAndRecord(c, byOrg(req));
      return contextById(c.id);
    });
    res.status(201).json({ context: contextForAgent(out) });
  });
  orgRouter.get('/agent/compliance/contexts/:id', (req, res) => {
    const c = ownContext(req, res, req.params.id);
    if (!c) return;
    res.json({ context: contextForAgent(c) });
  });
  orgRouter.post('/agent/compliance/contexts/:id/evaluate', (req, res) => {
    const c = ownContext(req, res, req.params.id);
    if (!c) return;
    if (!inputOr400(res, 'evaluation', req.body)) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'evaluate');
    const { result, ctx } = unit(() => {
      const result = evaluateAndRecord(c, byOrg(req));
      return { result, ctx: bumpContext(c.id, req) };
    });
    res.json({ context: contextForAgent(ctx), evaluation: result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/parties', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true });
    if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'parties');
    const b = inputOr400(res, 'newParty', req.body);
    if (!b) return;
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    const party = resolveParty(req, res, b);
    if (!party) return;
    if (c.parties.some((x) => x.partyRole === party.partyRole && !x.removed))
      return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS' }, 'parties');
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const { result, ctx } = unit(() => {
      contexts.addParty(
        c.id,
        { party },
        {
          history: [
            entry('compliance_context_party_added', byOrg(req), {
              partyRole: party.partyRole,
              kind: party.subjectKind,
            }),
          ],
        },
      );
      const result = evaluateAndRecord(c, byOrg(req));
      return { result, ctx: bumpContext(c.id, req) };
    });
    res.status(201).json({ context: contextForAgent(ctx), evaluation: result });
  });

  /** The agent records that they perform Football Agent Services for a party in this context. */
  orgRouter.post('/agent/compliance/contexts/:id/representations', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true });
    if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'representations');
    const b = inputOr400(res, 'declaration', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const partyRole = b.partyRole;
    const party = c.parties.find((x) => x.partyRole === partyRole && !x.removed);
    if (!party) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'representations');
    const fp = payloadFingerprint({ partyRole, agreementId: b.agreementId ?? null });
    if (key) {
      const hit = c.representations.find((r) => r.keys?.declare?.key === key);
      if (hit) {
        if (hit.keys.declare.fp === fp)
          return res.json({ context: contextForAgent(c), representation: hit, idempotent: true });
        return sendComplianceError(res, { error: 'CONTEXT_IDEMPOTENCY_CONFLICT' }, 'representations');
      }
    }
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    const p = profileOf(req.orgUser.id);
    if (!p)
      return sendComplianceError(
        res,
        { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' },
        'representations',
      );
    let agreement = null;
    let declaredOnly = false;
    if (party.subjectKind === 'player') {
      const found = b.agreementId ? agentReads.agreements.byId(b.agreementId) : null;
      agreement =
        found &&
        found.agentUserId === req.orgUser.id &&
        found.agencyOrgId === req.org.id &&
        found.clientId === party.subjectId
          ? found
          : null;
      // Safeguarding before scope, so it cannot be told apart from "no such party" by a later refusal.
      const pl = findPlayer(party.subjectId);
      if (!pl || !orgCanSee(req.org, pl) || !isAdult(pl))
        return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'representations');
      if (!agreement)
        return sendComplianceError(
          res,
          {
            error: 'REPRESENTATION_REQUIRED',
            message: 'A client-confirmed, active relationship with this party is required (agreementId).',
          },
          'representations',
        );
      const st = effectiveAgreementStatus(agreement, now());
      const problem = representationScopeProblem({
        agreement,
        effectiveStatus: st,
        confirmed: agreement.confirmedAt != null && agreementGrantsAccess(agreement, req.orgUser.id, now()),
        contextType: c.type,
        memberAssociations: c.jurisdictions,
      });
      if (problem)
        return sendComplianceError(
          res,
          {
            ...problem,
            message:
              problem.error === 'REPRESENTATION_SCOPE_INSUFFICIENT'
                ? "The relationship does not cover this action's scope or jurisdiction."
                : 'No active, client-confirmed relationship covers this party.',
          },
          'representations',
        );
    } else {
      // An entity client has no ScoutBox agreement: declared only, pending attributed review, never CLEAR (DR-18).
      declaredOnly = true;
    }
    if (
      c.representations.some(
        (r) => r.partyRole === partyRole && r.status !== 'withdrawn' && r.agentUserId === req.orgUser.id,
      )
    )
      return sendComplianceError(
        res,
        { error: 'CONTEXT_PARTY_EXISTS', message: 'You already represent this party in this context.' },
        'representations',
      );
    if (!facetGate(req, res, p, c.jurisdictions)) return;
    // The minor gate is inside the engine (MINOR_PARTY).
    const proposed = {
      agentUserId: req.orgUser.id,
      partyRole,
      agreementId: agreement?.id ?? null,
      declaredOnly,
      status: declaredOnly ? 'declared' : 'verified',
      firstActAt: now(),
    };
    const out = unitOrSent(() => {
      const result = evaluateAndRecord(c, byOrg(req), { proposed });
      if (result.outcome === 'PROHIBITED_CONFLICT') {
        bumpContext(c.id, req);
        return {
          refuse: {
            error: 'REPRESENTATION_CONFLICT',
            reasons: result.reasons.filter((r) =>
              ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code),
            ),
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.',
          },
        };
      }
      if (result.outcome === PERMITTED_WITH_CONSENT) {
        bumpContext(c.id, req);
        return {
          refuse: {
            error: 'CONSENT_REQUIRED',
            consentsOutstanding: result.consentsOutstanding,
            reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'),
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            contextId: c.id,
            message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.',
          },
        };
      }
      if (result.outcome === 'INSUFFICIENT_DATA' && !declaredOnly) {
        bumpContext(c.id, req);
        return {
          refuse: {
            error: 'COMPLIANCE_INSUFFICIENT_DATA',
            reasons: result.reasons.filter((r) => result.missingEvidence.includes(r.code)),
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            message: 'A fact the evaluation needs is missing. Nothing was recorded.',
          },
        };
      }
      if (result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA') {
        if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) throw ROLLBACK;
        const repId = declaredOnly ? nextId('crp') : null;
        const kind = declaredOnly ? 'representation_declared' : 'conflict_evaluation';
        const review = createReview({
          kind,
          agencyOrgId: c.agencyOrgId,
          agentUserId: req.orgUser.id,
          subject: { contextId: c.id, representationId: repId, partyRole },
          reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'),
          policyVersions: result.policyVersions,
          snapshot: result,
          requestedBy: byOrg(req),
        });
        if (declaredOnly) {
          const representation = {
            id: repId,
            agentUserId: req.orgUser.id,
            partyRole,
            agreementId: null,
            status: 'pending_review',
            declaredOnly: true,
            reviewId: review.id,
            declaredAt: now(),
            firstActAt: null,
            withdrawnAt: null,
            verifiedByReviewId: null,
            verifiedAt: null,
            keys: key ? { declare: { key, fp } } : {},
          };
          contexts.declareRepresentation(
            c.id,
            { representation },
            {
              ...bumped(req.orgUser),
              history: [
                entry('compliance_representation_declared', byOrg(req), { partyRole, status: 'pending_review' }),
              ],
            },
          );
        } else bumpContext(c.id, req);
        return {
          refuse: {
            error: 'REGULATORY_REVIEW_REQUIRED',
            reviewId: review.id,
            contextId: c.id,
            reasons: review.reasons,
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            message: declaredOnly
              ? 'Representation of an entity without a ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.'
              : "The deciding rule's operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.",
          },
        };
      }
      if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) throw ROLLBACK;
      const rep = {
        id: nextId('crp'),
        agentUserId: req.orgUser.id,
        partyRole,
        agreementId: agreement?.id ?? null,
        status: 'verified',
        declaredOnly: false,
        reviewId: null,
        declaredAt: now(),
        firstActAt: now(),
        withdrawnAt: null,
        verifiedByReviewId: null,
        verifiedAt: null,
        keys: key ? { declare: { key, fp } } : {},
      };
      const ctx = contexts.declareRepresentation(
        c.id,
        { representation: rep },
        {
          ...bumped(req.orgUser),
          history: [
            entry('compliance_representation_declared', byOrg(req), {
              partyRole,
              status: 'verified',
              outcome: result.outcome,
              policyVersions: result.policyVersions,
            }),
          ],
        },
      );
      return { ctx, rep, result };
    });
    if (!out) return;
    if (out.refuse) return sendComplianceError(res, out.refuse, 'representations');
    res.status(201).json({
      context: contextForAgent(out.ctx),
      representation: { id: out.rep.id, partyRole, status: out.rep.status },
      evaluation: out.result,
    });
  });
  orgRouter.post('/agent/compliance/contexts/:id/representations/:repId/withdraw', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true });
    if (!c) return;
    const rep = c.representations.find((r) => r.id === req.params.repId && r.agentUserId === req.orgUser.id);
    if (!rep) return sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'withdraw');
    if (!inputOr400(res, 'contextRev', req.body)) return;
    if (rep.status === 'withdrawn') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const { result, ctx } = unit(() => {
      contexts.withdrawRepresentation(
        c.id,
        { representationId: rep.id, at: now() },
        { history: [entry('compliance_representation_withdrawn', byOrg(req), { partyRole: rep.partyRole })] },
      );
      const result = evaluateAndRecord(c, byOrg(req));
      return { result, ctx: bumpContext(c.id, req) };
    });
    res.json({ context: contextForAgent(ctx), evaluation: result });
  });

  orgRouter.post('/agent/compliance/contexts/:id/close', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true });
    if (!c) return;
    if (!inputOr400(res, 'contextRev', req.body)) return;
    if (c.status === 'closed') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const ctx = unit(() => {
      closeContextNow(c, byOrg(req), req.orgUser);
      return bumpContext(c.id, req);
    });
    res.json({ context: contextForAgent(ctx) });
  });
}
