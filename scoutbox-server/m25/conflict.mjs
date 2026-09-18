/**
 * M23 P5.6C — the Conflict-of-Interest Engine (pure, deterministic).
 *
 * Implements M23_P56A_CONFLICT_ENGINE_CONTRACT.md. Everything it reads is
 * passed in; it never touches `db`. Given the same inputs, policy set and
 * clock it returns the same result and the same `inputHash`.
 *
 * It evaluates the LICENSED INDIVIDUAL (plus connected agents), never the
 * agency organisation. It applies encoded rule entries with their operative
 * status; where the deciding rule is UNDER_LEGAL_REVIEW or UNKNOWN, or the
 * applicable policies contradict, it returns review — never a guess.
 */

import { createHash } from 'node:crypto';
import { resolveScope, ruleAt } from './policy.mjs';

export const CONFLICT_OUTCOMES = Object.freeze([
  'CLEAR',
  'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', // alias in copy/tests: PERMITTED_WITH_CONSENT (DR-51)
  'PROHIBITED_CONFLICT',
  'MANUAL_REGULATORY_REVIEW_REQUIRED',
  'INSUFFICIENT_DATA',
]);
export const PERMITTED_WITH_CONSENT = 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED';
export const OUTCOME_ALIASES = Object.freeze({ PERMITTED_WITH_CONSENT });

/**
 * Severity order for aggregation: the most severe outcome wins; all reasons are kept.
 *
 * PROHIBITED_CONFLICT dominates everything. A prohibition under an ACTIVE rule is a
 * definite answer, while "needs attributed review" and "insufficient data" are the
 * ABSENCE of one — so no missing fact and no uncertain rule can soften it, and the
 * domain layer must never record a representation for a prohibited combination as
 * merely "declared, pending review". No reviewer could approve such an item anyway
 * (REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE), so recording it would leave the agent shown
 * as acting for a party they must not act for, on an item that can never resolve.
 */
const SEVERITY = Object.freeze({ PROHIBITED_CONFLICT: 4, INSUFFICIENT_DATA: 3, MANUAL_REGULATORY_REVIEW_REQUIRED: 2, [PERMITTED_WITH_CONSENT]: 1, CLEAR: 0 });
export const mostSevere = (a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b);

export const PARTY_ROLES = Object.freeze(['individual', 'engaging_entity', 'releasing_entity']);
export const CONTEXT_TYPES = Object.freeze(['employment_contract', 'transfer', 'loan', 'other_services']);

// ------------------------------------------------------------ canonical hashing

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
export const inputHashOf = (inputs) => createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex');

// ------------------------------------------------------------ consent sufficiency

/**
 * A dual-representation consent is sufficient only if it is unrevoked, was
 * granted IN ADVANCE of the agent's first act for the other party, was granted
 * by the party itself (or its recorded signatory), names a policy version in
 * which the deciding rule was ACTIVE, and — for England — carries the full
 * particulars and the legal-advice offer (contract §4.3).
 */
export function consentSufficiency(consent, { partyRole, agentUserId, contextId, firstActAt = null, requireParticulars = false, activePolicyIds = [] }) {
  if (!consent) return { ok: false, reasonCode: 'CONSENT_MISSING' };
  if (consent.kind !== 'dual_representation') return { ok: false, reasonCode: 'CONSENT_MISSING' };
  // A revocation is a fact in its own right (the ledger derives status 'revoked'): it is reported before anything else.
  if (consent.revokedAt != null || consent.status === 'revoked') return { ok: false, reasonCode: 'CONSENT_REVOKED' };
  if (consent.status !== 'granted' || typeof consent.grantedAt !== 'number') return { ok: false, reasonCode: consent.status === 'declined' ? 'CONSENT_DECLINED' : 'CONSENT_MISSING' };
  if (consent.contextId !== contextId) return { ok: false, reasonCode: 'CONSENT_WRONG_CONTEXT' };
  if (consent.agentUserId !== agentUserId) return { ok: false, reasonCode: 'CONSENT_WRONG_AGENT' };
  if (consent.partyRole !== partyRole) return { ok: false, reasonCode: 'CONSENT_WRONG_PARTY' };
  if (consent.grantedBy?.signatory === false) return { ok: false, reasonCode: 'SIGNATORY_REQUIRED' };
  if (typeof firstActAt === 'number' && consent.grantedAt > firstActAt) return { ok: false, reasonCode: 'CONSENT_NOT_IN_ADVANCE' };
  const versions = Array.isArray(consent.policyVersions) ? consent.policyVersions : [];
  if (activePolicyIds.length && !versions.some((v) => activePolicyIds.includes(v))) return { ok: false, reasonCode: 'CONSENT_POLICY_VERSION_STALE' };
  if (requireParticulars) {
    if (!consent.particulars?.fullParticularsProvided) return { ok: false, reasonCode: 'PARTICULARS_MISSING' };
    if (!consent.particulars?.legalAdviceOffered) return { ok: false, reasonCode: 'LEGAL_ADVICE_NOT_OFFERED' };
  }
  return { ok: true, reasonCode: null };
}

// ------------------------------------------------------------ the engine

const reason = (code, entry, extra = {}) => ({
  code,
  ruleId: entry?.ruleId ?? null,
  ruleStatus: entry?.status ?? 'UNKNOWN',
  regulator: entry?.policy?.regulator ?? null,
  jurisdiction: entry?.policy?.jurisdiction ?? null,
  policyVersion: entry?.policy?.id ?? null,
  ...extra,
});

/**
 * @param {object} input  see the contract §1. Minimal:
 *   transaction: { id, type, jurisdictions: [{ memberAssociation, role }], parties: [{ partyRole, subjectKind, subjectId, isMinor?, removed? }],
 *                  representations: [{ agentUserId, partyRole, agreementId, declaredOnly, status, firstActAt }], otherServices: [] }
 *   agents: { [agentUserId]: { licenceState, connectedAgentUserIds: [] } }
 *   consents: [ regulatoryConsents rows ]
 *   interests: []
 *   policySet: [ policy rows ]     missingPolicies: [ma]
 *   now
 */
export function evaluateConflict(input) {
  const { transaction = {}, agents = {}, consents = [], interests = [], policySet = [], missingPolicies = [], now = Date.now() } = input ?? {};
  const inputHash = inputHashOf({ transaction, agents, consents, interests, policyVersions: policySet.map((p) => p.id), missingPolicies, now });
  const reasons = [];
  const consentsOutstanding = [];
  let outcome = 'CLEAR';
  const raise = (o) => { outcome = mostSevere(outcome, o); };
  const done = () => ({
    outcome, alias: outcome === PERMITTED_WITH_CONSENT ? 'PERMITTED_WITH_CONSENT' : null,
    reasons,
    // A consent is owed by a PARTY, once, whichever connected agent's evaluation surfaced it.
    consentsOutstanding: consentsOutstanding.filter((c, i, arr) => arr.findIndex((x) => x.partyRole === c.partyRole && x.consentKind === c.consentKind) === i),
    requiredActions: requiredActionsFor(outcome, reasons, consentsOutstanding),
    missingEvidence: reasons.filter((r) => ['POLICY_NOT_ENCODED', 'SCOPE_UNRESOLVED', 'TYPE_UNKNOWN', 'PARTY_REMOVED', 'MINOR_PARTY', 'REPRESENTATION_UNVERIFIED', 'AGENT_STATE_INVALID', 'INSUFFICIENT_DATA'].includes(r.code)).map((r) => r.code),
    policyVersions: [...new Set(policySet.map((p) => p.id))],
    evaluatedAt: now, inputHash,
  });

  // 1. Type and scope.
  if (!CONTEXT_TYPES.includes(transaction.type)) { raise('INSUFFICIENT_DATA'); reasons.push(reason('TYPE_UNKNOWN', null)); }
  const { scope, memberAssociations } = resolveScope(transaction.jurisdictions);
  if (scope === 'unknown') { raise('INSUFFICIENT_DATA'); reasons.push(reason('SCOPE_UNRESOLVED', null)); }
  for (const ma of missingPolicies ?? []) { raise('INSUFFICIENT_DATA'); reasons.push(reason('POLICY_NOT_ENCODED', null, { jurisdiction: ma })); }
  if (outcome === 'INSUFFICIENT_DATA') return done();

  // 2. Parties.
  const parties = Array.isArray(transaction.parties) ? transaction.parties : [];
  for (const p of parties) {
    if (p?.removed) { raise('INSUFFICIENT_DATA'); reasons.push(reason('PARTY_REMOVED', null, { partyRole: p.partyRole })); }
    if (p?.isMinor) {
      const ga = consents.find((c) => c?.kind === 'guardian_agreement' && c.status === 'granted' && c.revokedAt == null && c.subject?.id === p.subjectId && c.contextId === transaction.id);
      if (!ga) { raise('INSUFFICIENT_DATA'); reasons.push(reason('MINOR_PARTY', null, { partyRole: p.partyRole })); }
    }
  }

  // 3. Which table decides.
  const national = scope === 'national' ? memberAssociations[0] : null;
  const nationalPolicy = national ? policySet.find((p) => p.jurisdiction === national) : null;
  const multiRuleId = nationalPolicy ? Object.keys(nationalPolicy.rules).find((id) => nationalPolicy.rules[id]?.params?.permittedMultiple || nationalPolicy.rules[id]?.params?.permittedSets) ?? null : 'FIFA-12.8';
  const prohibitRuleId = nationalPolicy ? Object.keys(nationalPolicy.rules).find((id) => nationalPolicy.rules[id]?.params?.prohibitedWith) ?? null : 'FIFA-12.9';
  const connectedRuleId = nationalPolicy ? Object.keys(nationalPolicy.rules).find((id) => nationalPolicy.rules[id]?.params?.connectedAgentsAreOne) ?? null : 'FIFA-12.10';
  const multiRule = multiRuleId ? ruleAt(policySet, multiRuleId, now) : { ruleId: null, rule: null, policy: nationalPolicy, status: 'UNKNOWN' };
  const prohibitRule = prohibitRuleId ? ruleAt(policySet, prohibitRuleId, now) : { ruleId: null, rule: null, policy: nationalPolicy, status: 'UNKNOWN' };
  const connectedRule = connectedRuleId ? ruleAt(policySet, connectedRuleId, now) : { ruleId: null, rule: null, policy: nationalPolicy, status: 'UNKNOWN' };
  // For a national ENG transaction the FIFA entries are JURISDICTION_OVERRIDE; say so in the reasons.
  if (national) {
    for (const fifaId of ['FIFA-12.8', 'FIFA-12.9', 'FIFA-12.10']) {
      const f = ruleAt(policySet, fifaId, now);
      if (f.rule?.overrides?.some((o) => o.jurisdiction === national && o.scope === 'national')) reasons.push({ ...reason('NATIONAL_RULE_APPLIES', f), ruleStatus: 'JURISDICTION_OVERRIDE', overrideRuleId: f.rule.overrides.find((o) => o.jurisdiction === national).overrideRuleId });
    }
  }
  // A mixed case: a national transaction whose parties span more than one MA is not national. Contract L-18.
  if (scope === 'international' && memberAssociations.filter((m) => m !== 'INT').length > 1) {
    const nationalOnes = memberAssociations.filter((m) => m !== 'INT');
    const anyActiveNational = nationalOnes.some((m) => { const p = policySet.find((x) => x.jurisdiction === m); return p && Object.values(p.rules).some((r) => r.params?.permittedMultiple && r.ruleStatus === 'ACTIVE'); });
    if (anyActiveNational) { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('SCOPE_MIXED', multiRule, { jurisdictions: nationalOnes })); }
  }

  // 4. Connected agents and the set S per evaluated agent. `evaluateAgentUserIds`
  //    narrows the evaluation to the agent(s) acting; a colleague's representation
  //    is an INPUT to attribution, never a subject the colleague is judged on here.
  const reps = (Array.isArray(transaction.representations) ? transaction.representations : []).filter((r) => r && r.agentUserId && r.status !== 'withdrawn');
  const agentIds = (Array.isArray(transaction.evaluateAgentUserIds) && transaction.evaluateAgentUserIds.length ? transaction.evaluateAgentUserIds : [...new Set(reps.map((r) => r.agentUserId))]).filter((id) => reps.some((r) => r.agentUserId === id) || (Array.isArray(transaction.evaluateAgentUserIds) && transaction.evaluateAgentUserIds.includes(id)));
  const connectedOf = (id) => new Set([id, ...((agents?.[id]?.connectedAgentUserIds ?? []).filter(Boolean))]);
  const requireParticulars = !!multiRule.rule?.params?.fullParticularsRequired;
  const activePolicyIds = policySet.filter((p) => p.jurisdiction === (national ?? 'INT')).map((p) => p.id);

  for (const agentId of agentIds) {
    const a = agents?.[agentId];
    if (!a || a.licenceState !== 'VERIFIED') { raise('INSUFFICIENT_DATA'); reasons.push(reason('AGENT_STATE_INVALID', null, { agentUserId: agentId, state: a?.licenceState ?? 'UNKNOWN' })); continue; }
    const conn = connectedOf(agentId);
    const own = reps.filter((r) => r.agentUserId === agentId);
    const viaConnected = reps.filter((r) => r.agentUserId !== agentId && conn.has(r.agentUserId));
    if (!own.length && !viaConnected.length) { reasons.push(reason('NO_REPRESENTATION', null, { agentUserId: agentId })); continue; }
    for (const r of own) if (r.declaredOnly) { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('REPRESENTATION_UNVERIFIED', null, { agentUserId: agentId, partyRole: r.partyRole })); }
    const S = new Set(own.map((r) => r.partyRole));
    let attributed = false;
    if (viaConnected.length) {
      if (connectedRule.status === 'ACTIVE' || connectedRule.status === 'UNDER_LEGAL_REVIEW' || connectedRule.status === 'UNKNOWN') {
        for (const r of viaConnected) S.add(r.partyRole);
        attributed = true;
        reasons.push(reason('CONNECTED_AGENT_ATTRIBUTION', connectedRule, { agentUserId: agentId, partyRoles: [...new Set(viaConnected.map((r) => r.partyRole))] }));
        if (connectedRule.status !== 'ACTIVE') { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason(connectedRule.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN', connectedRule, { agentUserId: agentId })); }
      } else {
        reasons.push(reason(connectedRule.status === 'SUSPENDED' ? 'RULE_SUSPENDED' : 'RULE_NOT_YET_IN_FORCE', connectedRule, { agentUserId: agentId }));
      }
    }
    // Other Services: England counts them inside 6.3–6.5 (they enter S); FIFA's 15(3) presumption is under review.
    for (const os of (Array.isArray(transaction.otherServices) ? transaction.otherServices : []).filter((o) => o && conn.has(o.agentUserId))) {
      if (nationalPolicy) S.add(os.partyRole);
      else { const r15 = ruleAt(policySet, 'FIFA-15.3', now); if (r15.status === 'ACTIVE') S.add(os.partyRole); else { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('OTHER_SERVICES_PRESUMPTION', r15, { agentUserId: agentId, partyRole: os.partyRole })); } }
    }
    const roles = [...S];
    if (roles.length <= 1) { reasons.push(reason('SINGLE_PARTY', multiRule.rule ? multiRule : prohibitRule, { agentUserId: agentId, partyRoles: roles })); continue; }

    // Multiple parties: the deciding rule's status governs everything below.
    const decidingStatus = multiRule.status;
    if (decidingStatus === 'UNDER_LEGAL_REVIEW') { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('RULE_STATUS_UNCERTAIN', multiRule, { agentUserId: agentId, partyRoles: roles })); if (roles.includes('releasing_entity')) reasons.push(reason('RULE_STATUS_UNCERTAIN', prohibitRule, { agentUserId: agentId, partyRoles: roles })); continue; }
    if (decidingStatus === 'UNKNOWN') { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('POLICY_NOT_ENCODED', multiRule, { agentUserId: agentId, partyRoles: roles })); continue; }
    if (decidingStatus === 'SUSPENDED' || decidingStatus === 'PENDING_IMPLEMENTATION') {
      // A suspended rule is not a permission: with no ACTIVE rule deciding the question, review.
      reasons.push(reason(decidingStatus === 'SUSPENDED' ? 'RULE_SUSPENDED' : 'RULE_NOT_YET_IN_FORCE', multiRule, { agentUserId: agentId }));
      raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('NO_ACTIVE_RULE_DECIDES', multiRule, { agentUserId: agentId, partyRoles: roles }));
      continue;
    }
    // ACTIVE (or an active limb of a partially suspended rule).
    const prohibitedWith = prohibitRule.status === 'ACTIVE' ? prohibitRule.rule?.params?.prohibitedWith ?? null : null;
    if (prohibitedWith && roles.includes(prohibitedWith)) {
      raise('PROHIBITED_CONFLICT'); reasons.push(reason('PROHIBITED_COMBINATION', prohibitRule, { agentUserId: agentId, partyRoles: roles, ...(attributed ? { viaConnectedAgent: true } : {}) }));
      continue;
    }
    const params = multiRule.rule?.params ?? {};
    const permitted = params.permittedMultiple
      ? !roles.includes(params.excludedRole)
      : Array.isArray(params.permittedSets) && params.permittedSets.some((set) => set.length === roles.length && set.every((r) => roles.includes(r)));
    if (!permitted) { raise('PROHIBITED_CONFLICT'); reasons.push(reason('COMBINATION_NOT_PERMITTED', multiRule, { agentUserId: agentId, partyRoles: roles })); continue; }
    // Permitted with consent from EVERY represented party. "In advance" means
    // before the agent first acted for MORE THAN ONE party: the moment the
    // second representation was acted on (the second-earliest firstActAt).
    const acts = [...own, ...viaConnected].map((r) => r.firstActAt).filter((t) => typeof t === 'number').sort((x, y) => x - y);
    const dualAt = acts.length >= 2 ? acts[1] : null;
    let allConsented = true;
    for (const role of roles) {
      const candidates = consents.filter((c) => c?.kind === 'dual_representation' && c.contextId === transaction.id && c.partyRole === role && (c.agentUserId === agentId || conn.has(c.agentUserId)));
      let best = { ok: false, reasonCode: 'CONSENT_MISSING' };
      for (const c of candidates) {
        const s = consentSufficiency(c, { partyRole: role, agentUserId: c.agentUserId, contextId: transaction.id, firstActAt: dualAt, requireParticulars, activePolicyIds });
        if (s.ok) { best = s; break; }
        if (best.reasonCode === 'CONSENT_MISSING') best = s;
      }
      if (!best.ok) { allConsented = false; consentsOutstanding.push({ partyRole: role, agentUserId: agentId, consentKind: 'dual_representation', reasonCode: best.reasonCode }); }
    }
    if (allConsented) reasons.push(reason('DUAL_CONSENTED', multiRule, { agentUserId: agentId, partyRoles: roles }));
    else { raise(PERMITTED_WITH_CONSENT); reasons.push(reason('CONSENT_REQUIRED', multiRule, { agentUserId: agentId, partyRoles: roles })); }
  }

  // 5. Declared interests linking a party's user to the agent: review.
  for (const i of Array.isArray(interests) ? interests : []) if (i?.agentUserId && agentIds.includes(i.agentUserId)) { raise('MANUAL_REGULATORY_REVIEW_REQUIRED'); reasons.push(reason('INTEREST_DECLARED', null, { agentUserId: i.agentUserId, kind: i.kind ?? null })); }

  return done();
}

function requiredActionsFor(outcome, reasons, consentsOutstanding) {
  const out = [];
  if (outcome === PERMITTED_WITH_CONSENT) for (const c of consentsOutstanding) out.push({ action: 'obtain_consent', partyRole: c.partyRole, consentKind: c.consentKind, reasonCode: c.reasonCode });
  if (outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED') out.push({ action: 'attributed_regulatory_review', reasonCodes: [...new Set(reasons.filter((r) => ['RULE_STATUS_UNCERTAIN', 'POLICY_NOT_ENCODED', 'SCOPE_MIXED', 'REPRESENTATION_UNVERIFIED', 'OTHER_SERVICES_PRESUMPTION', 'INTEREST_DECLARED', 'NO_ACTIVE_RULE_DECIDES'].includes(r.code)).map((r) => r.code))] });
  if (outcome === 'INSUFFICIENT_DATA') out.push({ action: 'supply_missing_facts', reasonCodes: [...new Set(reasons.filter((r) => ['TYPE_UNKNOWN', 'SCOPE_UNRESOLVED', 'POLICY_NOT_ENCODED', 'PARTY_REMOVED', 'MINOR_PARTY', 'AGENT_STATE_INVALID'].includes(r.code)).map((r) => r.code))] });
  if (outcome === 'PROHIBITED_CONFLICT') out.push({ action: 'withdraw_a_representation', reasonCodes: [...new Set(reasons.filter((r) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED'].includes(r.code)).map((r) => r.code))] });
  return out;
}

/** What may be shown to a party other than the evaluated agent: outcome and codes, never the other side's agents (privacy matrix row 14). */
export function conflictSummaryForParty(result) {
  if (!result) return null;
  return { outcome: result.outcome, reasonCodes: [...new Set((result.reasons ?? []).map((r) => r.code))], policyVersions: result.policyVersions ?? [], evaluatedAt: result.evaluatedAt ?? null };
}
