// The agent core's rules behind the agent core persistence battery (e2e/agents/corePersistence.mjs), checked in this
// process over the battery's own records: an agreement naming no agent grants nobody access, and records a typed
// table could never hold (a facet state "approved", an agreement status "signed") are still judged safely by the
// pure rules, wherever they might come from.
import {
  effectiveFacetState,
  agreementGrantsAccess,
  clientTransitionAllowed,
  agentTransitionAllowed,
  verificationGap,
  newFacets,
} from '../../../domains/agents/core/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { neg, section, done } = rulesSuite('agents/corePersistence');

const T0 = 1_700_000_000_000; // 2023-11-14 — firmly in the past, so createdAt-based windows have started

section('2 — an agreement naming no agent');
{
  const mirror = {
    id: 'rep-x',
    agentUserId: null,
    clientId: 'pl-a',
    status: 'active',
    confirmedAt: T0 + 10,
    startAt: T0 + 10,
    endAt: T0 + 400 * 24 * 3600 * 1000,
  };
  neg(
    !agreementGrantsAccess(mirror, null, T0 + 20) &&
      !agreementGrantsAccess(mirror, 'usr-lead', T0 + 20) &&
      !agreementGrantsAccess(mirror, undefined, T0 + 20),
    'an ACTIVE agreement naming no agent grants access to nobody — null, the admin, undefined',
  );
}

section('5 — records no typed table can hold, judged by the pure rules');
{
  const profile = {
    id: 'agp-x',
    userId: 'usr-lead',
    agencyOrgId: 'org-ag',
    displayName: 'Lead Person',
    declared: { fifaLicenceNumber: null, jurisdictions: ['INT'] },
    facets: { ...newFacets(), fifa_licence: { ...newFacets().fifa_licence, state: 'approved', reference: 'X' } },
    createdAt: T0,
    updatedAt: T0,
    rev: 1,
    revAt: T0,
    revBy: null,
    history: [],
  };
  const signed = {
    id: 'rep-x',
    agentUserId: 'usr-lead',
    agencyOrgId: 'org-ag',
    clientKind: 'player',
    clientId: 'pl-b',
    jurisdiction: 'INT',
    exclusive: false,
    status: 'signed',
    confirmedAt: T0,
    confirmedBy: { kind: 'player', id: 'pl-b' },
    scope: ['employment'],
    termMonths: 12,
    startAt: T0,
    endAt: T0 + 1e10,
    proposedAt: T0,
    declinedAt: null,
    terminatedAt: null,
    terminatedBy: null,
    terminationReasonCode: null,
    disputedAt: null,
    disputeReason: null,
    shareWithAgencyStaff: false,
    policyVersions: [],
    keys: {},
    createdAt: T0,
    rev: 1,
    revAt: T0,
    revBy: null,
    history: [],
  };
  neg(
    effectiveFacetState(profile.facets.fifa_licence, T0) === 'MANUAL_REVIEW_REQUIRED',
    'an unknown facet state "approved" reads as MANUAL_REVIEW_REQUIRED',
  );
  neg(verificationGap(profile, 'INT', T0)?.state === 'MANUAL_REVIEW_REQUIRED', 'and is a verification gap');
  neg(!agreementGrantsAccess(signed, 'usr-lead', T0 + 1), 'an agreement with status "signed" grants NO access');
  neg(
    !clientTransitionAllowed(signed, 'active', T0 + 1) &&
      !agentTransitionAllowed(signed, 'terminated_by_agent', T0 + 1),
    'and moves nowhere',
  );
}

done();
