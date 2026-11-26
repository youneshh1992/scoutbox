// The compliance engine's rules behind the compliance persistence battery (e2e/agents/compliancePersistence.mjs),
// checked in this process over records the battery's corrupt database stands for: a consent naming a policy version
// that does not exist, and an emptied policy store.
import { consentSufficiency } from '../../../domains/agents/compliance/conflict.mjs';
import { applicablePolicySet } from '../../../domains/agents/compliance/policy.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { neg, section, done } = rulesSuite('agents/compliancePersistence');

const T0 = 1_700_000_000_000;

section('5 — corruption on disk, judged by the pure engine');
{
  // (c) a consent naming a policy version that does not exist.
  const stale = consentSufficiency(
    {
      kind: 'dual_representation',
      status: 'granted',
      grantedAt: T0,
      contextId: 'c',
      agentUserId: 'a',
      partyRole: 'individual',
      policyVersions: ['jp-eng-1999-1'],
      grantedBy: { kind: 'player', id: 'p' },
      particulars: { fullParticularsProvided: true, legalAdviceOffered: true },
    },
    {
      partyRole: 'individual',
      agentUserId: 'a',
      contextId: 'c',
      activePolicyIds: ['jp-eng-2026-27-1'],
      requireParticulars: true,
    },
  );
  neg(
    stale.ok === false && stale.reasonCode === 'CONSENT_POLICY_VERSION_STALE',
    'a consent naming an unknown policy version is insufficient (pure engine)',
  );
  // (d) an emptied policy store: no jurisdiction is encoded any more.
  const missing = applicablePolicySet([], ['ENG'], Date.now());
  neg(
    missing.policies.length === 0 && missing.missing.includes('ENG') && missing.missing.includes('INT'),
    'with no policy rows the policy set is empty and both INT and ENG are reported missing (pure)',
  );
}

done();
