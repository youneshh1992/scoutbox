// Milestone 16.2 registration point — ScoutBox Trust Score.
//
// Trust Score is a DERIVED evidence-confidence summary. It adds no new
// storage (nothing to persist — every read recomputes from canonical
// sources), no new authentication and, critically, no new authorization:
// every route registers on the EXISTING authenticated routers so the
// standing gates run before any handler here.
import { metrics } from '../m13/enterprise.mjs';
import { POLICY, TRUST_SCORE_POLICY_VERSION, policyWeightsTotal } from './shared.mjs';
import { registerTrust } from './trust.mjs';

export function registerM162(ctx) {
  // Fail fast rather than ship a silently mis-weighted policy.
  const total = policyWeightsTotal(POLICY);
  if (total !== 100) throw new Error(`M16.2 trust policy weights must total 100, got ${total}`);
  // Exposed so the M18.1 boot assertions can report it alongside the other
  // configuration checks instead of duplicating the arithmetic.
  ctx.trustWeightsTotal = total;

  // Privacy-safe, aggregate-only metrics — never a player id or name.
  metrics.trust = {
    trust_profile_viewed: 0, trust_explanation_viewed: 0,
    trust_band_limited_evidence: 0, trust_band_developing_evidence: 0,
    trust_band_established_evidence: 0, trust_band_strong_evidence: 0,
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
