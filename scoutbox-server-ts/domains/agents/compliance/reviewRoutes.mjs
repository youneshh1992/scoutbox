import { guardRev } from '../../platform/concurrency.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { effectiveFacetState, RECHECK_MS, effectiveAgreementStatus } from '../core/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { filled } from '../../platform/schemas.mjs';
import { reviewerDecisionRows } from './audit.mjs';
import { REVIEW_KINDS, REVIEW_STATUSES } from '../../../repositories/complianceRecords.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';
import { now } from '../../platform/clock.mjs';
import { REVIEWER_LEGACY_NOTE } from './reviewers.mjs';

/** Reason codes only a policy version can settle: a reviewer may not "approve" past them. */
export const POLICY_LEVEL_REASONS = Object.freeze([
  'RULE_STATUS_UNCERTAIN',
  'POLICY_NOT_ENCODED',
  'NO_ACTIVE_RULE_DECIDES',
  'SCOPE_MIXED',
  'EXCLUSIVITY_WINDOW_DOUBTFUL',
]);

export function registerReviewRoutes(ctx) {
  const {
    adminRouter,
    agentCore,
    agentReads,
    broadcast,
    bumped,
    byReviewer,
    clientKeyOr400,
    complianceRecords,
    contextById,
    createReview,
    entry,
    evaluateAndRecord,
    facetRecord,
    inputOr400,
    lastEvaluation,
    limitedOr429,
    notify,
    policySetFor,
    publicReviewer,
    representationReviewedHandlers,
    reviewPublic,
    tsRouter,
    unit,
  } = ctx;
  const { contexts, reviews, consents } = complianceRecords;
  const reviewById = (id) => (typeof id === 'string' ? reviews.byId(id) : null);
  /** Open items first, each part oldest first. The T&S app reads only the first page. */
  const queuePage = (req, res, { forReviewer }) => {
    const q = inputOr400(res, 'reviewQueue', req.query, 'query');
    if (!q) return null;
    const status = q.status ?? null;
    let page;
    try {
      page = readPage(q, ['number', 'number', 'number']);
    } catch (e) {
      sendPageError(res, e);
      return null;
    }
    const { rows } = reviews.queuePage({ status, limit: page.limit, after: page.after });
    const out = pageOf(rows, page.limit, (r) => r.key);
    return { items: out.items.map((r) => reviewPublic(r.record, { forReviewer })), nextCursor: out.nextCursor };
  };
  tsRouter.get('/compliance/reviews', (req, res) => {
    const page = queuePage(req, res, { forReviewer: true });
    if (!page) return;
    res.json({ ...page, statuses: REVIEW_STATUSES, kinds: REVIEW_KINDS, reviewer: publicReviewer(req.reviewer) });
  });
  tsRouter.get('/compliance/reviews/:id', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'review');
    res.json({ review: reviewPublic(r, { forReviewer: true }), subjectDetail: reviewSubjectDetail(r) });
  });
  /** States and ids, no client data beyond the review's need. */
  function reviewSubjectDetail(r) {
    if (r.kind === 'verification_facet') {
      const p = agentReads.profiles.byId(r.subject.profileId);
      const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null;
      return {
        agentDisplayName: p?.displayName ?? null,
        facet: r.subject.facet,
        memberAssociation: r.subject.memberAssociation,
        reference: rec?.reference ?? null,
        state: rec ? effectiveFacetState(rec, now()) : null,
        submittedAt: rec?.submittedAt ?? null,
      };
    }
    if (r.kind === 'representation_dispute') {
      const a = agentReads.agreements.byId(r.subject.agreementId);
      return a
        ? {
            agreementId: a.id,
            status: effectiveAgreementStatus(a, now()),
            disputedAt: a.disputedAt ?? null,
            hadReason: !!a.disputeReason,
            scope: a.scope,
            jurisdiction: a.jurisdiction ?? null,
          }
        : null;
    }
    const c = contextById(r.subject?.contextId);
    return c
      ? {
          contextId: c.id,
          type: c.type,
          jurisdictions: c.jurisdictions,
          partyRoles: c.parties.filter((p) => !p.removed).map((p) => p.partyRole),
          representations: c.representations.map((x) => ({ partyRole: x.partyRole, status: x.status })),
          lastOutcome: lastEvaluation(c)?.outcome ?? null,
        }
      : null;
  }
  tsRouter.post('/compliance/reviews/:id/start', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'start');
    if (!inputOr400(res, 'reviewStart', req.body)) return;
    if (r.status === 'IN_REVIEW' && r.startedBy?.id === req.reviewer.id)
      return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true });
    if (r.status !== 'PENDING')
      return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'start');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const out = unit(() => {
      const next = reviews.start(
        r.id,
        { at: now(), by: { id: req.reviewer.id, name: req.reviewer.name, role: req.reviewer.role } },
        { ...bumped(req.reviewer), history: [entry('regulatory_review_started', byReviewer(req), { rev: r.rev })] },
      );
      broadcast('regulatory_review_started', { orgId: r.agencyOrgId, reviewId: r.id });
      return next;
    });
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  tsRouter.post('/compliance/reviews/:id/resolve', (req, res) => {
    if (limitedOr429(res, 'ts_review_decision', req.reviewer.id)) return;
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'resolve');
    const b = inputOr400(res, 'reviewResolution', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const { outcome } = b;
    const reasonCode = filled(b.reasonCode) ?? '';
    const reason = filled(b.reason) ?? '';
    const evidenceRefs = [...new Set((b.evidenceRefs ?? []).map(filled).filter(Boolean))];
    const fp = payloadFingerprint({ outcome, reasonCode, reason, evidenceRefs });
    if (key && r.keys?.resolve?.key === key) {
      if (r.keys.resolve.fp === fp)
        return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true });
      return sendComplianceError(res, { error: 'REVIEW_IDEMPOTENCY_CONFLICT' }, 'resolve');
    }
    if (!reasonCode || !reason)
      return sendComplianceError(
        res,
        {
          error: 'REVIEW_INPUT_INVALID',
          field: !reasonCode ? 'reasonCode' : 'reason',
          problem: 'required',
          message: 'A reason code and a written reason are required.',
        },
        'resolve',
      );
    if (outcome === 'APPROVED' && !evidenceRefs.length)
      return sendComplianceError(
        res,
        {
          error: 'REVIEW_INPUT_INVALID',
          field: 'evidenceRefs',
          problem: 'required',
          message: 'An approval must cite at least one evidence reference.',
        },
        'resolve',
      );
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW')
      return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'resolve');
    // A reviewer resolves missing or uncertain facts, never active policy.
    if (outcome === 'APPROVED') {
      if (
        r.snapshot?.outcome === 'PROHIBITED_CONFLICT' ||
        (r.reasons ?? []).some((x) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED'].includes(x.code))
      )
        return sendComplianceError(
          res,
          {
            error: 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE',
            message: 'An objectively prohibited combination under an ACTIVE rule cannot be approved by review.',
          },
          'resolve',
        );
      if (r.kind === 'conflict_evaluation' && (r.reasons ?? []).some((x) => POLICY_LEVEL_REASONS.includes(x.code)))
        return sendComplianceError(
          res,
          {
            error: 'REVIEW_REQUIRES_POLICY_VERSION',
            reasons: r.reasons.filter((x) => POLICY_LEVEL_REASONS.includes(x.code)),
            message:
              "The deciding rule's status is uncertain or not encoded. Only a published policy version (dual control) can settle that; a review cannot approve past it. It may be rejected (the workflow does not proceed) or left pending.",
          },
          'resolve',
        );
    }
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const priorState = { status: r.status, ...reviewEffectState(r) };
    const out = unit(() => {
      const resultingState = applyReviewDecision(r, outcome, req);
      const decision = {
        reviewerId: req.reviewer.id,
        reviewerName: req.reviewer.name,
        reviewerRole: req.reviewer.role,
        outcome,
        reasonCode,
        reason,
        evidenceRefs,
        policyVersions: r.policyVersions,
        at: now(),
        priorState,
        resultingState,
      };
      const next = reviews.resolve(
        r.id,
        { decision, key: key ? { key, fp } : null },
        {
          ...bumped(req.reviewer),
          history: [
            entry('regulatory_review_resolved', byReviewer(req), {
              outcome,
              reasonCode,
              evidenceRefs,
              evidenceCount: evidenceRefs.length,
              policyVersions: r.policyVersions,
              priorState,
              resultingState,
              rev: r.rev,
            }),
          ],
        },
      );
      broadcast('regulatory_review_resolved', { orgId: r.agencyOrgId, reviewId: r.id, outcome });
      if (r.agentUserId)
        notify(
          { kind: 'org_user', id: r.agentUserId },
          'regulatory_review_completed',
          `Attributed Trust & Safety review ${outcome === 'APPROVED' ? 'approved' : 'did not approve'} a ${r.kind.replace(/_/g, ' ')} item under ScoutBox policy. This is a platform decision, not a legal determination.`,
          r.id,
        );
      return next;
    });
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  function reviewEffectState(r) {
    if (r.kind === 'verification_facet') {
      const p = agentReads.profiles.byId(r.subject.profileId);
      const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null;
      return { facetState: rec ? effectiveFacetState(rec, now()) : null };
    }
    if (r.kind === 'representation_dispute') {
      const a = agentReads.agreements.byId(r.subject.agreementId);
      return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null };
    }
    const c = contextById(r.subject?.contextId);
    const rep = c?.representations.find((x) => x.id === r.subject?.representationId);
    return {
      contextOutcome: c ? (lastEvaluation(c)?.outcome ?? null) : null,
      representationStatus: rep?.status ?? null,
    };
  }
  function applyReviewDecision(r, outcome, req) {
    const by = byReviewer(req);
    if (r.kind === 'verification_facet') {
      const p = agentReads.profiles.byId(r.subject.profileId);
      if (!p) return { facetState: null, note: 'profile gone' };
      const cur = facetRecord(p, r.subject.facet, r.subject.memberAssociation) ?? {
        state: 'UNVERIFIED',
        reference: null,
        memberAssociation: r.subject.memberAssociation ?? null,
        provenance: null,
        submittedAt: null,
        verifiedAt: null,
        recheckAt: null,
        note: null,
        staleNotifiedAt: null,
      };
      const prev = effectiveFacetState(cur, now());
      const next =
        outcome === 'APPROVED'
          ? {
              ...cur,
              state: 'VERIFIED',
              verifiedAt: now(),
              recheckAt: now() + RECHECK_MS,
              provenance: {
                provider: 'attributed_review',
                kind: 'human_review',
                at: now(),
                reviewerId: req.reviewer.id,
                reviewId: r.id,
              },
              note: 'Verified by attributed Trust & Safety review against the cited evidence. Re-check due in 30 days.',
              staleNotifiedAt: null,
            }
          : {
              ...cur,
              state: 'UNVERIFIED',
              verifiedAt: null,
              recheckAt: null,
              provenance: {
                provider: 'attributed_review',
                kind: 'human_review',
                at: now(),
                reviewerId: req.reviewer.id,
                reviewId: r.id,
              },
              note: 'Attributed Trust & Safety review could not verify this reference.',
            };
      agentCore.profiles.setFacet(
        p.id,
        {
          facet: r.subject.facet,
          memberAssociation: r.subject.memberAssociation,
          record: { ...next, staleNotifiedAt: null },
        },
        {
          at: now(),
          touch: true,
          ...bumped(req.reviewer),
          history: [
            entry('agent_verification_state_changed', by, {
              facet: r.subject.facet,
              memberAssociation: r.subject.memberAssociation,
              from: prev,
              to: next.state,
              state: next.state,
              reviewId: r.id,
            }),
          ],
        },
      );
      broadcast('agent_verification_state_changed', {
        orgId: p.agencyOrgId,
        userId: p.userId,
        facet: r.subject.facet,
        state: next.state,
      });
      broadcast('agent_authorisation_state_changed', { orgId: p.agencyOrgId, userId: p.userId, state: next.state });
      return { facetState: next.state };
    }
    if (r.kind === 'representation_dispute') {
      const a = agentReads.agreements.byId(r.subject.agreementId);
      if (!a || a.status !== 'disputed')
        return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null, note: 'not disputed any more' };
      // Reinstating lifts only the dispute suspension; an expired term stays expired.
      agentCore.agreements.resolveDispute(
        a.id,
        { outcome: outcome === 'APPROVED' ? 'reinstated' : 'ended', reviewId: r.id, at: now() },
        {
          ...bumped(req.reviewer),
          history: [
            entry(outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', by, {
              by: 'trust_safety',
              phase: 'disputed',
              reviewId: r.id,
              reasonCode: outcome === 'APPROVED' ? 'dispute_reinstated' : 'dispute_upheld',
            }),
          ],
        },
      );
      broadcast(outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', {
        orgId: a.agencyOrgId,
        agreementId: a.id,
        agentUserId: a.agentUserId,
      });
      notify(
        { kind: 'player', id: a.clientId },
        'representation_disputed',
        outcome === 'APPROVED'
          ? 'Attributed Trust & Safety review resolved your dispute: the relationship record is reinstated. You can still end it at any time.'
          : 'Attributed Trust & Safety review resolved your dispute: the relationship record has been ended.',
        a.id,
      );
      if (a.agentUserId)
        notify(
          { kind: 'org_user', id: a.agentUserId },
          'representation_disputed',
          outcome === 'APPROVED'
            ? 'A disputed relationship was reinstated by attributed review.'
            : 'A disputed relationship was ended by attributed review.',
          a.id,
        );
      return { agreementStatus: effectiveAgreementStatus(agentReads.agreements.byId(a.id), now()) };
    }
    const c = contextById(r.subject?.contextId);
    if (!c) return { contextOutcome: null, note: 'context gone' };
    if (r.kind === 'representation_declared') {
      // For a transaction, its representation row is the truth and the context only projects it.
      if (r.subject?.transactionId) {
        for (const handle of representationReviewedHandlers)
          handle({
            transactionId: r.subject.transactionId,
            representationId: r.subject.representationId,
            outcome,
            by,
            reviewId: r.id,
          });
      }
      const live = contextById(c.id);
      const rep = live.representations.find((x) => x.id === r.subject.representationId);
      if (rep && rep.status === 'pending_review') {
        // firstActAt stays null until the agent acts, so a later party-specific consent still counts as in advance.
        contexts.decideRepresentation(
          c.id,
          { representationId: rep.id, approved: outcome === 'APPROVED', reviewId: r.id, at: now() },
          {
            history: [
              entry(
                outcome === 'APPROVED' ? 'compliance_representation_verified' : 'compliance_representation_withdrawn',
                by,
                { partyRole: rep.partyRole, reviewId: r.id },
              ),
            ],
          },
        );
      }
    } else if (r.kind === 'conflict_evaluation') {
      const book = {
        history: [
          entry('compliance_context_evaluated', by, {
            reviewId: r.id,
            outcome: outcome === 'APPROVED' ? 'review_approved' : 'review_rejected',
          }),
        ],
      };
      if (outcome === 'APPROVED')
        contexts.resolveFacts(
          c.id,
          {
            codes: (r.reasons ?? [])
              .map((x) => x.code)
              .filter((code) =>
                ['OTHER_SERVICES_PRESUMPTION', 'INTEREST_DECLARED', 'REPRESENTATION_UNVERIFIED'].includes(code),
              ),
          },
          book,
        );
      else contexts.rejectByReview(c.id, { at: now() }, book);
    }
    if (contextById(c.id).status === 'open') evaluateAndRecord(c, by);
    const after = contexts.recordAct(c.id, bumped(req.reviewer));
    return {
      contextOutcome: lastEvaluation(after)?.outcome ?? null,
      representationStatus: after.representations.find((x) => x.id === r.subject?.representationId)?.status ?? null,
    };
  }
  tsRouter.post('/compliance/reviews/:id/cancel', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'cancel');
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW')
      return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'cancel');
    const b = inputOr400(res, 'reviewClosure', req.body);
    if (!b) return;
    const reason = filled(b.reason);
    if (!reason)
      return sendComplianceError(
        res,
        {
          error: 'REVIEW_INPUT_INVALID',
          field: 'reason',
          problem: 'required',
          message: 'A written reason is required.',
        },
        'cancel',
      );
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const decision = {
      reviewerId: req.reviewer.id,
      reviewerName: req.reviewer.name,
      reviewerRole: req.reviewer.role,
      outcome: 'CANCELLED',
      reasonCode: 'cancelled',
      reason,
      evidenceRefs: [],
      policyVersions: r.policyVersions,
      at: now(),
      priorState: null,
      resultingState: null,
    };
    const out = unit(() =>
      reviews.cancel(
        r.id,
        { at: now(), decision },
        {
          ...bumped(req.reviewer),
          history: [
            entry('regulatory_review_cancelled', byReviewer(req), {
              outcome: 'CANCELLED',
              reasonCode: 'cancelled',
              rev: r.rev,
            }),
          ],
        },
      ),
    );
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  /** A final decision is never rewritten: a new review supersedes it. */
  tsRouter.post('/compliance/reviews/:id/supersede', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'supersede');
    if (!['APPROVED', 'REJECTED'].includes(r.status))
      return sendComplianceError(
        res,
        { error: 'REVIEW_NOT_PENDING', status: r.status, message: 'Only a decided review can be superseded.' },
        'supersede',
      );
    if (r.supersededBy)
      return sendComplianceError(res, { error: 'REVIEW_ALREADY_EXISTS', reviewId: r.supersededBy }, 'supersede');
    const b = inputOr400(res, 'reviewClosure', req.body);
    if (!b) return;
    const reason = filled(b.reason);
    if (!reason)
      return sendComplianceError(
        res,
        {
          error: 'REVIEW_INPUT_INVALID',
          field: 'reason',
          problem: 'required',
          message: 'A written reason is required.',
        },
        'supersede',
      );
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const { next, old } = unit(() => {
      const next = createReview({
        kind: r.kind,
        agencyOrgId: r.agencyOrgId,
        agentUserId: r.agentUserId,
        subject: r.subject,
        reasons: r.reasons,
        policyVersions: policySetFor(
          r.subject?.memberAssociation
            ? [r.subject.memberAssociation]
            : (contextById(r.subject?.contextId)?.jurisdictions ?? []),
        ).policies.map((p) => p.id),
        snapshot: r.snapshot,
        requestedBy: byReviewer(req),
        supersedes: r.id,
      });
      const old = reviews.markSuperseded(
        r.id,
        {},
        {
          ...bumped(req.reviewer),
          history: [
            entry('regulatory_review_superseded', byReviewer(req), {
              reasonCode: 'superseded',
              reviewId: next.id,
              priorState: { status: r.status },
              rev: r.rev,
            }),
          ],
        },
      );
      return { next, old };
    });
    res.status(201).json({
      review: reviewPublic(next, { forReviewer: true }),
      superseded: reviewPublic(old, { forReviewer: true }),
    });
  });
  tsRouter.get('/compliance/audit', (req, res) =>
    res.json({ items: reviewerDecisionRows(complianceRecords.reads, 200), legacyNote: REVIEWER_LEGACY_NOTE }),
  );
  /** Counts and durations only; no person, no ranking. */
  tsRouter.get('/compliance/metrics', (_req, res) => {
    let stale = 0;
    for (const f of agentReads.profiles.facetStates()) if (effectiveFacetState(f, now()) === 'STALE') stale += 1;
    res.json({
      reviews: reviews.metrics(),
      conflictOutcomes: contexts.outcomeCounts(),
      consents: consents.metrics(),
      staleFacets: stale,
      note: 'Process metrics only. No agent is ranked and no subscription or payment status enters any compliance outcome.',
    });
  });
  adminRouter.get('/compliance/reviews', (req, res) => {
    const page = queuePage(req, res, { forReviewer: false });
    if (!page) return;
    res.json({
      ...page,
      readOnly: true,
      note: 'Read-only. Starting, resolving, cancelling or superseding a review requires an authenticated reviewer session (/ts). The shared key can adjudicate nothing.',
    });
  });
}
