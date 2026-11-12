// Trust Score: an evidence-confidence summary recomputed on every read; nothing is persisted.
import { metrics } from '../../platform/metrics.mjs';
import { POLICY, TRUST_SCORE_POLICY_VERSION, policyWeightsTotal } from './shared.mjs';
import { registerTrust } from './trust.mjs';

export function registerTrustScore(ctx) {
  const total = policyWeightsTotal(POLICY);
  if (total !== 100) throw new Error(`Trust Score policy weights must total 100, got ${total}`);
  // For the boot assertions, so they do not duplicate the arithmetic.
  ctx.trustWeightsTotal = total;

  // Aggregate counters only, never a player id or name.
  metrics.trust = {
    trust_profile_viewed: 0,
    trust_explanation_viewed: 0,
    trust_band_limited_evidence: 0,
    trust_band_developing_evidence: 0,
    trust_band_established_evidence: 0,
    trust_band_strong_evidence: 0,
    trust_band_very_strong_evidence: 0,
    trust_recalculation_reason: 0,
    policyVersion: TRUST_SCORE_POLICY_VERSION,
  };
  const vmetric = (k, n = 1) => {
    if (k === 'policyVersion') return;
    metrics.trust[k] = (metrics.trust[k] ?? 0) + n;
  };

  const shared = { ...ctx, vmetric };
  registerTrust(shared);
  return shared;
}
