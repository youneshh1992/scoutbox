import { effectiveFacetState, can, JURISDICTIONS } from '../core/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { evaluatePolicy, ruleAt, MINOR_PATHWAY_PRODUCTION_ENABLED, POLICY_FACETS } from './policy.mjs';
import { facetFromProviderAnswer, FACET_METHOD } from './provider.mjs';
import { now } from '../../platform/clock.mjs';

export function registerFacetRoutes(ctx) {
  const {
    access,
    agencyJurisdictions,
    agentCore,
    broadcast,
    bumped,
    byOrg,
    complianceRecords,
    consentForAgent,
    contextForAgent,
    entry,
    facetNeedsReview,
    facetRecord,
    facetStatesOf,
    inputOr400,
    limitedOr429,
    orgRouter,
    policySetFor,
    profileOf,
    provider,
    reviewPublic,
    unit,
  } = ctx;
  const { contexts, reviews, consents } = complianceRecords;
  orgRouter.post('/agent/compliance/facets/:facet/recheck', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'verification.submit')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const facet = req.params.facet;
    if (!POLICY_FACETS.includes(facet))
      return sendComplianceError(
        res,
        { error: 'COMPLIANCE_INPUT_INVALID', field: 'facet', allowed: POLICY_FACETS },
        'recheck',
      );
    const p = profileOf(req.orgUser.id);
    if (!p)
      return sendComplianceError(
        res,
        { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' },
        'recheck',
      );
    const b = inputOr400(res, 'facetRecheck', req.body);
    if (!b) return;
    const ma = facet === 'fifa_licence' ? null : (b.memberAssociation?.toUpperCase() ?? '');
    const cur = facetRecord(p, facet, ma);
    if (!cur || !cur.reference)
      return sendComplianceError(
        res,
        {
          error: 'COMPLIANCE_INPUT_INVALID',
          field: 'facet',
          message: 'Nothing has been submitted for this facet yet.',
        },
        'recheck',
      );
    const answer = provider[FACET_METHOD[facet]]({ reference: cur.reference, now: now() });
    if (answer.state === 'UNAVAILABLE')
      return sendComplianceError(
        res,
        {
          error: 'REGULATORY_PROVIDER_UNAVAILABLE',
          retryAfter: 300,
          message:
            'The verification source is unavailable. Nothing was changed; a cached VERIFIED facet stays usable only until its own recheck date.',
        },
        'recheck',
      );
    const next = facetFromProviderAnswer(answer, { reference: cur.reference, memberAssociation: ma, now: now() });
    const prevState = effectiveFacetState(cur, now());
    const nextState = effectiveFacetState(next, now());
    unit(() => {
      const out = agentCore.profiles.setFacet(
        p.id,
        { facet, memberAssociation: ma, record: { ...next, staleNotifiedAt: null } },
        {
          at: now(),
          touch: true,
          ...bumped(req.orgUser),
          history: [
            entry('agent_facet_rechecked', byOrg(req), {
              facet,
              memberAssociation: ma,
              from: prevState,
              to: nextState,
            }),
            ...(prevState !== nextState
              ? [
                  entry('agent_verification_state_changed', byOrg(req), {
                    facet,
                    memberAssociation: ma,
                    from: prevState,
                    to: nextState,
                    state: next.state,
                  }),
                ]
              : []),
          ],
        },
      );
      if (next.state === 'MANUAL_REVIEW_REQUIRED') facetNeedsReview(out, { facet, memberAssociation: ma }, byOrg(req));
      if (prevState !== nextState)
        broadcast('agent_verification_state_changed', {
          orgId: req.org.id,
          userId: out.userId,
          facet,
          state: nextState,
        });
    });
    res.json({
      facet: { ...next, state: effectiveFacetState(next, now()), storedState: next.state },
      provider: provider.status(),
    });
  });

  // ============================================================ the agent's compliance overview
  const minorReadinessFor = (p, ma) => {
    const set = policySetFor([ma]);
    const facets = facetStatesOf(p);
    // The agent's own state under the jurisdiction's rules, evaluated against no subject.
    const timingRule =
      ma === 'INT'
        ? ruleAt(set.policies, 'FIFA-13.1', now())
        : (() => {
            const nat = set.policies.find((x) => x.jurisdiction === ma);
            const id = nat ? Object.keys(nat.rules).find((k) => nat.rules[k]?.params?.formula) : null;
            return id ? ruleAt(set.policies, id, now()) : { ruleId: null, status: 'UNKNOWN' };
          })();
    const d = evaluatePolicy({
      action: 'approach_minor',
      memberAssociations: [ma],
      facets,
      policySet: set.policies,
      missingPolicies: set.missing,
      now: now(),
    });
    return {
      memberAssociation: ma,
      pathwayEnabledInProduction: MINOR_PATHWAY_PRODUCTION_ENABLED[ma] === true,
      timingRule: timingRule.ruleId
        ? {
            ruleId: timingRule.ruleId,
            ruleStatus: timingRule.status,
            formula: timingRule.rule?.params?.formula ?? null,
          }
        : null,
      timingEncoded:
        timingRule.status === 'ACTIVE' &&
        !!timingRule.rule?.params?.formula &&
        timingRule.rule.params.formula !== 'six_months_before_first_contract_age',
      agentReady: d.allowed,
      gaps: d.facetGaps,
      reasons: d.reasons.map((r) => ({ code: r.code, ruleId: r.ruleId, ruleStatus: r.ruleStatus })),
      honest:
        "General discovery of minors by agencies is prohibited and no minor representation workflow is live in any jurisdiction. This is the agent's own readiness under the encoded rules, evaluated against no subject.",
    };
  };
  orgRouter.get('/agent/compliance/overview', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.read')) return;
    const p = profileOf(req.orgUser.id);
    const facets = p ? facetStatesOf(p) : null;
    const freshness = [];
    if (p) {
      const push = (facet, ma, rec) => {
        if (!rec) return;
        const st = effectiveFacetState(rec, now());
        freshness.push({
          facet,
          memberAssociation: ma,
          state: st,
          storedState: rec.state,
          recheckAt: rec.recheckAt ?? null,
          daysUntilRecheck: typeof rec.recheckAt === 'number' ? Math.ceil((rec.recheckAt - now()) / 86_400_000) : null,
          provenance: rec.provenance ?? null,
          verifiedAt: rec.verifiedAt ?? null,
        });
      };
      push('fifa_licence', null, p.facets?.fifa_licence);
      for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation'])
        for (const [ma, rec] of Object.entries(p.facets?.[f] ?? {})) push(f, ma, rec);
      // The agent core's sweep, not this read, tells the agent of a stale facet.
    }
    const mine = (x) => x.agentUserId === req.orgUser.id || can(req.tiers, 'agency.compliance.read');
    const reviewList = reviews
      .forAgency(req.org.id)
      .filter(mine)
      .map((r) => reviewPublic(r));
    const contextList = contexts.forAgent(req.org.id, req.orgUser.id).map(contextForAgent);
    const consentList = consents.forAgent(req.org.id, req.orgUser.id).map(consentForAgent);
    const jurisdictions = [
      ...new Set([...(p?.declared?.jurisdictions ?? []), ...agencyJurisdictions(req.org.id)]),
    ].filter((j) => JURISDICTIONS.includes(j));
    const inForce = policySetFor(['INT', ...jurisdictions]);
    res.json({
      provider: provider.status(),
      facets,
      freshness,
      policies: {
        inEffect: inForce.policies.map((x) => ({
          id: x.id,
          regulator: x.regulator,
          jurisdiction: x.jurisdiction,
          effectiveFrom: x.effectiveFrom,
        })),
        missing: inForce.missing,
      },
      reviews: reviewList,
      contexts: contextList,
      consents: consentList,
      minorReadiness: jurisdictions.filter((j) => j !== 'INT').map((ma) => minorReadinessFor(p, ma)),
      counts: {
        reviewsPending: reviewList.filter((r) => r.status === 'PENDING' || r.status === 'IN_REVIEW').length,
        contextsOpen: contextList.filter((c) => c.status === 'open').length,
        consentsOutstanding: consentList.filter((k) => k.status === 'requested').length,
        staleFacets: freshness.filter((f) => f.state === 'STALE').length,
      },
      honest:
        'ScoutBox policy results say whether this workflow may proceed under the currently encoded rules. They are not statements of legal validity and no governing body has approved anything here.',
    });
  });
}
