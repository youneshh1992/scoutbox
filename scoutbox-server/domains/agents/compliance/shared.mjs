import { revMeta } from '../../platform/concurrency.mjs';
import { effectiveFacetState, effectiveAgreementStatus, affiliationActive } from '../core/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { evaluatePolicy, resolveScope } from './policy.mjs';
import { evaluateConflict } from './conflict.mjs';
import { now } from '../../platform/clock.mjs';

export function createComplianceShared(ctx) {
  const {
    access,
    activeAffiliationOf,
    agentReads,
    broadcast,
    bumped,
    byId,
    byOrg,
    bySystem,
    complianceRecords,
    entry,
    findPlayer,
    isAdult,
    nextId,
    notify,
    orgCanSee,
    policySetFor,
    profileOf,
    unit,
  } = ctx;
  const { contexts, reviews, consents } = complianceRecords;
  const facetStatesOf = (p, at = now()) => ({
    fifa_licence: effectiveFacetState(p?.facets?.fifa_licence, at),
    national_registration: Object.fromEntries(
      Object.entries(p?.facets?.national_registration ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)]),
    ),
    domestic_authorisation: Object.fromEntries(
      Object.entries(p?.facets?.domestic_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)]),
    ),
    minors_authorisation: Object.fromEntries(
      Object.entries(p?.facets?.minors_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)]),
    ),
  });
  const facetRecord = (p, facet, ma) =>
    (facet === 'fifa_licence' ? p?.facets?.fifa_licence : p?.facets?.[facet]?.[ma]) ?? null;

  const reviewPublic = (r, { forReviewer = false } = {}) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    agencyOrgId: r.agencyOrgId,
    agentUserId: r.agentUserId ?? null,
    subject: r.subject,
    reasons: (r.reasons ?? []).map((x) => ({
      code: x.code,
      ruleId: x.ruleId ?? null,
      ruleStatus: x.ruleStatus ?? null,
      policyVersion: x.policyVersion ?? null,
    })),
    policyVersions: r.policyVersions ?? [],
    requestedAt: r.requestedAt,
    startedAt: r.startedAt ?? null,
    decidedAt: r.decidedAt ?? null,
    decision: r.decision
      ? {
          outcome: r.decision.outcome,
          reasonCode: r.decision.reasonCode,
          reviewer: { id: r.decision.reviewerId, name: r.decision.reviewerName, role: r.decision.reviewerRole },
          evidenceCount: (r.decision.evidenceRefs ?? []).length,
          ...(forReviewer
            ? {
                reason: r.decision.reason,
                evidenceRefs: r.decision.evidenceRefs,
                priorState: r.decision.priorState,
                resultingState: r.decision.resultingState,
              }
            : {}),
          policyVersions: r.decision.policyVersions ?? [],
          at: r.decision.at,
        }
      : null,
    startedBy: r.startedBy ? { id: r.startedBy.id, name: r.startedBy.name } : null,
    supersedes: r.supersedes ?? null,
    supersededBy: r.supersededBy ?? null,
    snapshot: forReviewer
      ? (r.snapshot ?? null)
      : r.snapshot
        ? {
            outcome: r.snapshot.outcome ?? null,
            evaluatedAt: r.snapshot.evaluatedAt ?? null,
            policyVersions: r.snapshot.policyVersions ?? [],
          }
        : null,
    ...revMeta(r),
    honest:
      'A ScoutBox reviewer decides whether the ScoutBox workflow may proceed under the encoded rules. This is not a legal determination and no governing body has approved anything.',
  });
  /** The caller holds the unit. A reconsideration names the review it `supersedes`. */
  function createReview({
    kind,
    agencyOrgId,
    agentUserId,
    subject,
    reasons,
    policyVersions,
    snapshot = null,
    requestedBy,
    supersedes = null,
  }) {
    const r = {
      id: nextId('rrv'),
      kind,
      status: 'PENDING',
      agencyOrgId,
      agentUserId: agentUserId ?? null,
      subject,
      reasons: reasons ?? [],
      policyVersions: policyVersions ?? [],
      snapshot: snapshot && {
        outcome: snapshot.outcome,
        evaluationId: snapshot.evaluationId ?? null,
        evaluatedAt: snapshot.evaluatedAt ?? null,
      },
      requestedAt: now(),
      requestedBy,
      startedAt: null,
      startedBy: null,
      decidedAt: null,
      decision: null,
      supersedes,
      supersededBy: null,
      keys: {},
      rev: 1,
      revAt: now(),
      revBy: null,
      history: [
        entry('regulatory_review_requested', requestedBy, {
          kind,
          reasonCodes: [...new Set((reasons ?? []).map((x) => x.code))],
          policyVersions: policyVersions ?? [],
        }),
        ...(supersedes
          ? [entry('regulatory_review_requested', requestedBy, { reasonCode: 'supersedes', reviewId: supersedes })]
          : []),
      ],
    };
    // The review and its notice commit together (inside the caller's unit when there is one).
    return unit(() => {
      const out = reviews.create(r);
      broadcast('regulatory_review_requested', { orgId: agencyOrgId, reviewId: out.id, kind });
      if (agentUserId)
        notify(
          { kind: 'org_user', id: agentUserId },
          'regulatory_review_required',
          kind === 'verification_facet'
            ? 'A verification submission needs attributed Trust & Safety review. Nothing is verified until a named reviewer decides.'
            : 'A compliance question needs attributed Trust & Safety review. The workflow does not proceed until a named reviewer decides.',
          out.id,
        );
      return out;
    });
  }

  /** For the agent core. Idempotent per facet. */
  function facetNeedsReview(profile, { facet, memberAssociation }, by) {
    if (reviews.openForFacet(profile.id, facet, memberAssociation ?? null)) return null;
    return createReview({
      kind: 'verification_facet',
      agencyOrgId: profile.agencyOrgId,
      agentUserId: profile.userId,
      subject: { profileId: profile.id, userId: profile.userId, facet, memberAssociation: memberAssociation ?? null },
      reasons: [{ code: 'NO_PROVIDER', ruleId: null, ruleStatus: null, policyVersion: null }],
      policyVersions: policySetFor([memberAssociation].filter(Boolean)).policies.map((p) => p.id),
      requestedBy: by,
    });
  }
  /** For the agent core. */
  function representationDisputed(a, by) {
    if (reviews.openForAgreement(a.id)) return null;
    return createReview({
      kind: 'representation_dispute',
      agencyOrgId: a.agencyOrgId,
      agentUserId: a.agentUserId,
      subject: { agreementId: a.id },
      reasons: [{ code: 'CLIENT_DISPUTE', ruleId: null, ruleStatus: null, policyVersion: null }],
      policyVersions: policySetFor([a.jurisdiction].filter(Boolean)).policies.map((p) => p.id),
      requestedBy: by,
    });
  }
  /** For the agent core's request route (exclusivity window, USA domestic authorisation …). */
  function authorizeApproach({ profile, jurisdiction, player, agentUserId }) {
    const set = policySetFor([jurisdiction]);
    const others = agentReads.agreements
      .forClient(player.id)
      .filter(
        (a) =>
          a.agentUserId !== agentUserId &&
          a.exclusive &&
          effectiveAgreementStatus(a, now()) === 'active' &&
          a.confirmedAt,
      )
      .map((a) => ({ endAt: a.endAt ?? null }));
    const d = evaluatePolicy({
      action: 'approach_adult',
      memberAssociations: [jurisdiction],
      facets: facetStatesOf(profile),
      policySet: set.policies,
      missingPolicies: set.missing,
      otherExclusiveAgreements: others,
      now: now(),
    });
    return { decision: d, policySet: set };
  }

  const contextById = (id) => (typeof id === 'string' ? contexts.byId(id) : null);
  const partyName = (party, org) => {
    if (party.subjectKind === 'club') return byId.org(party.subjectId)?.name ?? null;
    const pl = findPlayer(party.subjectId);
    return pl && orgCanSee(org, pl) ? pl.name : null;
  };
  const lastEvaluation = (c) => c?.lastEvaluation ?? null;
  function contextForAgent(c) {
    const org = byId.org(c.agencyOrgId);
    const ev = lastEvaluation(c);
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      jurisdictions: c.jurisdictions,
      scope: resolveScope(c.jurisdictions).scope,
      parties: c.parties.map((p) => ({
        id: p.id,
        partyRole: p.partyRole,
        subjectKind: p.subjectKind,
        subjectId: p.subjectId,
        name: org ? partyName(p, org) : null,
        removed: !!p.removed,
      })),
      representations: c.representations.map((r) => ({
        id: r.id,
        agentUserId: r.agentUserId,
        partyRole: r.partyRole,
        agreementId: r.agreementId ?? null,
        status: r.status,
        declaredOnly: !!r.declaredOnly,
        reviewId: r.reviewId ?? null,
        firstActAt: r.firstActAt ?? null,
      })),
      clearance: ev
        ? {
            outcome: ev.outcome,
            alias: ev.alias ?? null,
            reasons: ev.reasons,
            consentsOutstanding: ev.consentsOutstanding,
            requiredActions: ev.requiredActions,
            policyVersions: ev.policyVersions,
            evaluatedAt: ev.evaluatedAt,
            inputHash: ev.inputHash,
            current: !c.reEvaluationPending,
          }
        : null,
      reEvaluationPending: !!c.reEvaluationPending,
      evaluationCount: c.evaluationCount ?? 0,
      openedAt: c.openedAt,
      closedAt: c.closedAt ?? null,
      ...revMeta(c),
      history: (c.history ?? []).map((h) => ({
        id: h.id,
        at: h.at,
        action: h.action,
        byKind: h.by?.kind ?? null,
        detail: h.detail ?? null,
      })),
      honest:
        'A compliance context is a minimal record for conflict evaluation. It is not a Transaction Room: no negotiation, no terms, no offer and no signing happen here.',
    };
  }
  const revokedAtOf = (k) => k.revocation?.at ?? null;
  const consentStatusOf = (k) => (k.revocation ? 'revoked' : k.status);
  const consentForAgent = (k) => ({
    id: k.id,
    kind: k.kind,
    status: consentStatusOf(k),
    contextId: k.contextId ?? null,
    partyRole: k.partyRole ?? null,
    subjectKind: k.subject?.kind ?? null,
    requestedAt: k.requestedAt ?? null,
    grantedAt: k.grantedAt ?? null,
    declinedAt: k.declinedAt ?? null,
    revokedAt: revokedAtOf(k),
    policyVersions: k.policyVersions ?? [],
    ruleIds: k.ruleIds ?? [],
    particulars: k.particulars ?? null,
    ...revMeta(k),
  });
  const engineConsentsFor = (contextId) =>
    consents.forContext(contextId).map(({ revocation, ...k }) => ({
      ...k,
      status: revocation ? 'revoked' : k.status,
      revokedAt: revocation?.at ?? null,
    }));

  const repInput = (r) => ({
    agentUserId: r.agentUserId,
    partyRole: r.partyRole,
    agreementId: r.agreementId ?? null,
    declaredOnly: r.status === 'pending_review',
    status: r.status === 'pending_review' ? 'declared' : r.status,
    firstActAt: r.firstActAt ?? null,
  });
  const sameTransaction = (a, b) => {
    // Two contexts describe the same real-world transaction when they name the same individual and the same entities.
    const key = (c) =>
      c.parties
        .filter((p) => !p.removed)
        .map((p) => `${p.partyRole}:${p.subjectId}`)
        .sort()
        .join('|');
    const ka = key(a);
    const kb = key(b);
    const ia = a.parties.find((p) => p.partyRole === 'individual' && !p.removed)?.subjectId;
    return (
      !!ia &&
      ia === b.parties.find((p) => p.partyRole === 'individual' && !p.removed)?.subjectId &&
      (ka === kb ||
        a.parties
          .filter((p) => !p.removed)
          .every((p) =>
            b.parties.some((q) => !q.removed && q.partyRole === p.partyRole && q.subjectId === p.subjectId),
          ))
    );
  };
  function engineInput(c, { proposed = null } = {}) {
    const org = byId.org(c.agencyOrgId);
    const reps = c.representations.filter((r) => r.status !== 'withdrawn').map(repInput);
    if (proposed) reps.push(proposed);
    // Connected agents (FA 6.5 / FFAR 12(10)): a colleague's verified representation in the same transaction (another
    // open context of this agency naming the same parties) is attributed to this agent. Reasons never name the colleague.
    const colleagues = agentReads.affiliations
      .forAgency(c.agencyOrgId)
      .filter((a) => a.userId !== c.agentUserId && affiliationActive(a, now()))
      .map((a) => a.userId);
    for (const other of contexts.openForAgencyExcept(c.agencyOrgId, c.id)) {
      if (!colleagues.includes(other.agentUserId) || !sameTransaction(c, other)) continue;
      for (const r of other.representations)
        if (r.status === 'verified' && r.agentUserId !== c.agentUserId)
          reps.push({ ...repInput(r), viaColleague: true });
    }
    // The opener is evaluated even before any representation.
    const agentIds = [...new Set([c.agentUserId, ...reps.map((r) => r.agentUserId)])];
    const agents = {};
    for (const id of agentIds) {
      const aff = activeAffiliationOf(id, c.agencyOrgId);
      agents[id] = {
        licenceState: aff ? facetStatesOf(profileOf(id)).fifa_licence : 'NO_AFFILIATION',
        connectedAgentUserIds: colleagues.filter((x) => x !== id).concat(id === c.agentUserId ? [] : [c.agentUserId]),
      };
    }
    const parties = c.parties.map((p) => {
      const pl = p.subjectKind === 'player' ? findPlayer(p.subjectId) : null;
      // Lost visibility removes the party from the evaluation, so a regulatory clear never overrides safety.
      const gone = p.subjectKind === 'player' ? !pl || !org || !orgCanSee(org, pl) : !byId.org(p.subjectId);
      return {
        partyRole: p.partyRole,
        subjectKind: p.subjectKind,
        subjectId: p.subjectId,
        removed: !!p.removed || gone,
        isMinor: pl ? !isAdult(pl) : false,
      };
    });
    const set = policySetFor(c.jurisdictions);
    return {
      // No route records other services or declared interests.
      transaction: {
        id: c.id,
        type: c.type,
        jurisdictions: c.jurisdictions.map((ma) => ({ memberAssociation: ma })),
        parties,
        representations: reps,
        otherServices: [],
        evaluateAgentUserIds: [c.agentUserId],
      },
      agents,
      consents: engineConsentsFor(c.id),
      interests: [],
      policySet: set.policies,
      missingPolicies: set.missing,
      now: now(),
    };
  }
  /** Contexts and consents naming the player keep only the id. */
  function onPlayerDeleted(playerId, at = now()) {
    complianceRecords.forgetPlayer(playerId, at, () => ({
      id: nextId('aud'),
      at: now(),
      action: 'compliance_context_party_removed',
      by: bySystem('account deletion'),
      detail: { partyRole: 'individual' },
    }));
  }
  /** With `record`, answers the stored evaluation (with its `evaluationId`). The caller holds the unit. */
  function evaluateAndRecord(c, by, { proposed = null, record = true } = {}) {
    const cur = contextById(c.id) ?? c;
    const result = evaluateConflict(engineInput(cur, { proposed }));
    if (!record) return result;
    const stored = contexts.recordEvaluation(
      cur.id,
      result,
      {
        parties: cur.parties.map((p) => ({
          partyRole: p.partyRole,
          subjectKind: p.subjectKind,
          subjectId: p.subjectId,
        })),
        representations: cur.representations.map((r) => ({
          agentUserId: r.agentUserId,
          partyRole: r.partyRole,
          status: r.status,
        })),
        proposed: proposed ? { partyRole: proposed.partyRole, agentUserId: proposed.agentUserId } : null,
      },
      {
        id: nextId('aud'),
        at: now(),
        action: 'compliance_context_evaluated',
        by,
        detail: {
          outcome: result.outcome,
          reasonCodes: [...new Set(result.reasons.map((r) => r.code))],
          policyVersions: result.policyVersions,
        },
      },
    );
    broadcast('conflict_evaluated', { orgId: cur.agencyOrgId, ctxId: cur.id, outcome: result.outcome });
    return stored;
  }
  const bumpContext = (id, req) => contexts.recordAct(id, bumped(req.orgUser));
  /** A refusal after a write that must not stand (a stale rev): the unit rolls back; the response was already sent. */
  const ROLLBACK = Symbol('compliance rollback');
  const unitOrSent = (work) => {
    try {
      return unit(work);
    } catch (e) {
      if (e === ROLLBACK) return undefined;
      throw e;
    }
  };

  /** Conceals other agents' contexts. */
  function ownContext(req, res, id, { write = false } = {}) {
    if (!access.resolveMembership(req, res)) return null;
    if (!access.requireCap(req, res, write ? 'compliance.contexts.write' : 'compliance.read')) return null;
    const c = contextById(id);
    if (!c || c.agencyOrgId !== req.org.id || c.agentUserId !== req.orgUser.id) {
      sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'context');
      return null;
    }
    return c;
  }

  /** The agent's own facets under the applicable set, for a declaration in this context. */
  function facetGate(req, res, p, mas) {
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
      sendComplianceError(
        res,
        {
          error: g.code,
          facet: g.facet,
          memberAssociation: g.memberAssociation,
          state: g.state,
          message: `A regulated action needs a VERIFIED ${g.facet}${g.memberAssociation ? ` (${g.memberAssociation})` : ''}; it is ${g.state}.`,
        },
        'facets',
      );
      return null;
    }
    if (d.requiresManualReview && d.reasons.some((r) => r.code === 'POLICY_NOT_ENCODED')) {
      sendComplianceError(
        res,
        {
          error: 'JURISDICTION_UNSUPPORTED',
          reasons: d.reasons.filter((r) => r.code === 'POLICY_NOT_ENCODED'),
          policyVersions: d.policyVersions,
          message:
            'No encoded policy covers this jurisdiction. The workflow cannot proceed without attributed review under an encoded policy version.',
        },
        'facets',
      );
      return null;
    }
    return d;
  }

  /** Also cancels the context's open review items; `bumpBy` names who bumps each review's rev. */
  function closeContextNow(c, by, bumpBy = null) {
    contexts.close(c.id, { at: now() }, { history: [entry('compliance_context_closed', by)] });
    for (const r of reviews.openForContext(c.id)) {
      reviews.cancel(
        r.id,
        { at: now() },
        {
          ...(bumpBy ? bumped(bumpBy) : {}),
          history: [entry('regulatory_review_cancelled', by, { reasonCode: 'context_closed' })],
        },
      );
    }
  }

  /** For the agent core's request route, when an approach's deciding rule is uncertain. */
  function createApproachReview({ req, decision, playerId, jurisdiction }) {
    return createReview({
      kind: 'conflict_evaluation',
      agencyOrgId: req.org.id,
      agentUserId: req.orgUser.id,
      subject: { approach: true, playerId, jurisdiction },
      reasons: decision.reasons.filter((r) => r.code !== 'FACET_VERIFIED'),
      policyVersions: decision.policyVersions,
      snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', evaluatedAt: now() },
      requestedBy: byOrg(req),
    });
  }

  return {
    facetStatesOf,
    facetRecord,
    reviewPublic,
    createReview,
    facetNeedsReview,
    representationDisputed,
    authorizeApproach,
    createApproachReview,
    contextById,
    lastEvaluation,
    contextForAgent,
    revokedAtOf,
    consentStatusOf,
    consentForAgent,
    engineConsentsFor,
    onPlayerDeleted,
    evaluateAndRecord,
    bumpContext,
    ROLLBACK,
    unitOrSent,
    ownContext,
    facetGate,
    closeContextNow,
  };
}
