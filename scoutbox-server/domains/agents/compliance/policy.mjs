/**
 * The pure policy evaluation layer: routes hand it the policy set, facet states and clock rather than branching on
 * country.
 *
 * Rule statuses (DR-52, docs/product/agents.md):
 *   ACTIVE                 applied
 *   SUSPENDED              not applied; reason RULE_SUSPENDED; never a permission
 *   PARTIALLY_SUSPENDED    params.activeLimbs applied; the rest as SUSPENDED
 *   JURISDICTION_OVERRIDE  the national entry decides inside its territory
 *   PENDING_IMPLEMENTATION not applied before effectiveFrom
 *   UNDER_LEGAL_REVIEW     MANUAL_REGULATORY_REVIEW_REQUIRED — never CLEAR, never a block
 *   UNKNOWN                MANUAL_REGULATORY_REVIEW_REQUIRED / INSUFFICIENT_DATA
 *
 * Objective mandatory conditions fail closed (licence, registration,
 * authorisation, guardian consent, scope); uncertainty goes to attributed
 * review. Neither branch is permission.
 */

import { RULE_STATUSES } from './policyVersions.mjs';
import { parseDob } from '../../../domain.mjs';
import { parseStrictDateOnly, readInstant } from '../../../temporal.mjs';

export { RULE_STATUSES };

export const POLICY_ACTIONS = Object.freeze(['approach_adult', 'declare_representation', 'request_consent', 'approach_minor']);

/** Facet names the policy layer can require. Registration and domestic authorisation are separate facets (DR-53). */
export const POLICY_FACETS = Object.freeze(['fifa_licence', 'national_registration', 'domestic_authorisation', 'minors_authorisation']);

const DAY = 24 * 60 * 60 * 1000;

/**
 * Strict, because `Date.parse` reads `2026-02-30` as 2 March. NaN fails every window comparison, so an unreadable
 * boundary means the version is never selected.
 */
const dateMs = (iso) => {
  if (typeof iso === 'string') { const p = parseStrictDateOnly(iso); return p.ok ? p.t : NaN; }
  return readInstant(iso) ?? NaN;
};

// ------------------------------------------------------------ versions

/** The latest policyVersion among those in effect wins. */
export function selectPolicyVersion(rows, jurisdiction, now = Date.now()) {
  let best = null;
  for (const r of rows ?? []) {
    if (!r || r.jurisdiction !== jurisdiction || r.status !== 'published') continue;
    const from = dateMs(r.effectiveFrom);
    const to = r.effectiveTo == null ? Infinity : dateMs(r.effectiveTo);
    if (!(from <= now) || !(now < to)) continue;
    if (!best || (r.policyVersion ?? 0) > (best.policyVersion ?? 0)) best = r;
  }
  return best;
}

/** FIFA (`INT`) always applies. A missing national entry is reported, never skipped. */
export function applicablePolicySet(rows, memberAssociations, now = Date.now()) {
  const mas = [...new Set(['INT', ...(memberAssociations ?? []).filter((m) => typeof m === 'string' && m && m !== 'INT')])];
  const policies = []; const missing = [];
  for (const ma of mas) {
    const v = selectPolicyVersion(rows, ma, now);
    if (v) policies.push(v); else missing.push(ma);
  }
  return { policies, missing, memberAssociations: mas };
}

export function findRule(policySet, ruleId) {
  for (const p of policySet ?? []) {
    if (p?.rules && Object.hasOwn(p.rules, ruleId)) return { rule: p.rules[ruleId], policy: p };
  }
  return null;
}

/** PENDING_IMPLEMENTATION reads as ACTIVE from the rule's own effectiveFrom. */
export function ruleStatusAt(entry, now = Date.now()) {
  if (!entry?.rule) return 'UNKNOWN';
  const st = entry.rule.ruleStatus;
  if (!RULE_STATUSES.includes(st)) return 'UNKNOWN';
  if (st === 'PENDING_IMPLEMENTATION') {
    const from = dateMs(entry.rule.effectiveFrom ?? entry.rule.params?.effectiveFrom);
    return Number.isFinite(from) && from <= now ? 'ACTIVE' : 'PENDING_IMPLEMENTATION';
  }
  return st;
}

const reasonOf = (code, entry, extra = {}) => ({
  code,
  ruleId: entry?.ruleId ?? null,
  ruleStatus: entry?.status ?? 'UNKNOWN',
  regulator: entry?.policy?.regulator ?? null,
  jurisdiction: entry?.policy?.jurisdiction ?? null,
  policyVersion: entry?.policy?.id ?? null,
  ...extra,
});

/** A missing rule is an UNKNOWN entry, so it still produces a reason. */
export function ruleAt(policySet, ruleId, now = Date.now()) {
  const found = findRule(policySet, ruleId);
  if (!found) return { ruleId, rule: null, policy: null, status: 'UNKNOWN' };
  return { ruleId, rule: found.rule, policy: found.policy, status: ruleStatusAt(found, now) };
}

// ------------------------------------------------------------ scope

/** `national` for a single non-INT association; `international` when INT or several are involved. */
export function resolveScope(jurisdictions) {
  const mas = [...new Set((jurisdictions ?? []).map((j) => (typeof j === 'string' ? j : j?.memberAssociation)).filter((m) => typeof m === 'string' && m))];
  if (!mas.length) return { scope: 'unknown', memberAssociations: [] };
  if (mas.length === 1 && mas[0] !== 'INT') return { scope: 'national', memberAssociations: mas, nationalMa: mas[0] };
  return { scope: 'international', memberAssociations: mas };
}

// ------------------------------------------------------------ facets

const facetStateOf = (facets, facet, ma) => {
  const f = facets?.[facet];
  if (!f) return 'UNVERIFIED';
  if (facet === 'fifa_licence') return typeof f === 'string' ? f : (f.state ?? 'UNVERIFIED');
  const g = f?.[ma];
  return typeof g === 'string' ? g : (g?.state ?? 'UNVERIFIED');
};

export function facetRefusalCode(facet, state) {
  if (state === 'VERIFIED') return null;
  if (state === 'STALE') return 'AGENT_VERIFICATION_STALE';
  if (state === 'INACTIVE') return 'AGENT_LICENCE_INACTIVE';
  if (facet === 'national_registration') return 'AGENT_NATIONAL_REGISTRATION_REQUIRED';
  if (facet === 'domestic_authorisation') return 'AGENT_DOMESTIC_AUTHORISATION_REQUIRED';
  if (facet === 'minors_authorisation') return 'AGENT_MINOR_AUTHORISATION_REQUIRED';
  return 'AGENT_VERIFICATION_REQUIRED';
}

// ------------------------------------------------------------ decision

const emptyDecision = () => ({
  allowed: false, blocked: false,
  requiresConsent: false, requiresGuardian: false, requiresMinorAccreditation: false,
  requiresNationalRegistration: false, requiresDomesticAuthorisation: false, requiresManualReview: false,
  reasons: [], policyVersions: [], ruleIds: [], ruleStatuses: {},
  facetGaps: [], // [{ facet, memberAssociation, state, code }] — objective, fail closed
});

const finish = (d, policySet) => {
  d.policyVersions = [...new Set((policySet ?? []).map((p) => p.id))];
  d.ruleIds = [...new Set(d.reasons.map((r) => r.ruleId).filter(Boolean))];
  for (const r of d.reasons) if (r.ruleId) d.ruleStatuses[r.ruleId] = r.ruleStatus;
  d.allowed = !d.blocked && !d.requiresConsent && !d.requiresGuardian && !d.requiresMinorAccreditation
    && !d.requiresNationalRegistration && !d.requiresDomesticAuthorisation && !d.requiresManualReview;
  return d;
};

/** An active rule makes the facet mandatory; a non-active one only contributes a reason. */
function requireFacet(d, entry, facet, ma, facets, flag) {
  const st = entry.status;
  if (st === 'ACTIVE' || st === 'JURISDICTION_OVERRIDE') {
    const state = facetStateOf(facets, facet, ma);
    if (state !== 'VERIFIED') {
      const code = facetRefusalCode(facet, state);
      d.facetGaps.push({ facet, memberAssociation: ma, state, code });
      d.reasons.push(reasonOf(code, entry, { facet, memberAssociation: ma, state }));
      if (flag) d[flag] = true; else d.blocked = true;
    } else {
      d.reasons.push(reasonOf('FACET_VERIFIED', entry, { facet, memberAssociation: ma }));
    }
  } else if (st === 'SUSPENDED' || st === 'PARTIALLY_SUSPENDED') {
    d.reasons.push(reasonOf('RULE_SUSPENDED', entry));
  } else if (st === 'PENDING_IMPLEMENTATION') {
    d.reasons.push(reasonOf('RULE_NOT_YET_IN_FORCE', entry));
  } else if (st === 'UNDER_LEGAL_REVIEW') {
    d.requiresManualReview = true; d.reasons.push(reasonOf('RULE_STATUS_UNCERTAIN', entry));
  } else {
    d.requiresManualReview = true; d.reasons.push(reasonOf('POLICY_NOT_ENCODED', entry));
  }
}

/**
 * `facets` are effective states, e.g. `{ fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } }`.
 * `otherExclusiveAgreements` are other agents' active exclusive agreements, anonymised to `[{ endAt }]`.
 */
export function evaluatePolicy({ action, memberAssociations = [], facets = {}, policySet = [], missingPolicies = [], otherExclusiveAgreements = [], now = Date.now() }) {
  const d = emptyDecision();
  if (!POLICY_ACTIONS.includes(action)) {
    d.blocked = true; d.reasons.push({ code: 'ACTION_UNKNOWN', ruleId: null, ruleStatus: 'UNKNOWN', regulator: null, jurisdiction: null, policyVersion: null });
    return finish(d, policySet);
  }
  for (const ma of missingPolicies ?? []) {
    d.requiresManualReview = true;
    d.reasons.push({ code: 'POLICY_NOT_ENCODED', ruleId: null, ruleStatus: 'UNKNOWN', regulator: null, jurisdiction: ma, policyVersion: null });
  }
  const mas = [...new Set(['INT', ...memberAssociations.filter((m) => m && m !== 'INT')])];

  // The FIFA licence is personal and required for every regulated act (FIFA-8.1 / 11.1 / 12.2).
  requireFacet(d, ruleAt(policySet, 'FIFA-8.1', now), 'fifa_licence', null, facets, null);
  const approachRule = ruleAt(policySet, action === 'approach_minor' ? 'FIFA-13.1' : 'FIFA-12.2', now);
  if (approachRule.status !== 'ACTIVE') d.reasons.push(reasonOf(approachRule.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN', approachRule));

  // National overlays: registration and domestic authorisation are separate facets (DR-53).
  for (const ma of mas) {
    if (ma === 'INT') continue;
    const policy = policySet.find((p) => p.jurisdiction === ma);
    if (!policy) continue; // already reported as missing
    for (const [ruleId, r] of Object.entries(policy.rules ?? {})) {
      const entry = { ruleId, rule: r, policy, status: ruleStatusAt({ rule: r }, now) };
      if (r.params?.nationalRegistrationRequired) requireFacet(d, entry, 'national_registration', ma, facets, 'requiresNationalRegistration');
      if (r.params?.domesticAuthorisationRequired) requireFacet(d, entry, 'domestic_authorisation', ma, facets, 'requiresDomesticAuthorisation');
      if (action === 'approach_minor' && r.params?.minorsAuthorisationRequired) requireFacet(d, entry, 'minors_authorisation', ma, facets, 'requiresMinorAccreditation');
    }
  }
  if (action === 'approach_minor') {
    const acc = ruleAt(policySet, 'FIFA-13.2', now);
    // FIFA minors accreditation is recorded as a facet on the INT scope.
    requireFacet(d, acc, 'minors_authorisation', 'INT', facets, 'requiresMinorAccreditation');
  }

  // Exclusive-agreement approach window (FIFA-16.1b / ENG-8.1b): while under legal review, manual review whenever
  // the rule would decide, never a block and never the other agent's identity.
  if ((action === 'approach_adult') && (otherExclusiveAgreements ?? []).length) {
    for (const ruleId of ['FIFA-16.1b', ...mas.filter((m) => m !== 'INT').map((m) => `${m}-8.1b`)]) {
      const e = ruleAt(policySet, ruleId, now);
      if (!e.rule) continue;
      if (e.status === 'ACTIVE') {
        // The text's own window: an approach only in the final two months of the other agreement.
        const windowMs = (e.rule.params?.exclusivityWindowMonths ?? 2) * 30 * DAY;
        const insideWindow = otherExclusiveAgreements.every((a) => typeof a?.endAt === 'number' && a.endAt - now <= windowMs);
        if (!insideWindow) { d.blocked = true; d.reasons.push(reasonOf('EXCLUSIVITY_WINDOW_CLOSED', e)); }
        else d.reasons.push(reasonOf('EXCLUSIVITY_WINDOW_OPEN', e));
      } else if (e.status === 'SUSPENDED' || e.status === 'PENDING_IMPLEMENTATION') {
        d.reasons.push(reasonOf(e.status === 'SUSPENDED' ? 'RULE_SUSPENDED' : 'RULE_NOT_YET_IN_FORCE', e));
      } else {
        d.requiresManualReview = true; d.reasons.push(reasonOf('EXCLUSIVITY_WINDOW_DOUBTFUL', e));
      }
    }
  }
  return finish(d, policySet);
}

// ------------------------------------------------------------ minors gate

/** FFAR "Minor" / FA "Minor": under 18. A separate predicate from the visibility age of majority (DR-14). */
export function isRegulatoryMinor(dob, now = Date.now()) {
  // `new Date(null)` is the epoch and V8 rolls 30 February into March; an unparseable dob is unknown, which blocks.
  const day = parseDob(dob);
  if (day === null) return null;
  const b = new Date(`${day}T00:00:00Z`);
  const on = new Date(now);
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age -= 1;
  return age < 18;
}

/**
 * England: 1 September of the academic year (1 Sep–31 Aug) in which the minor reaches 16 (FA 2026-27 reg. 5.1).
 * FIFA: six months before the employing country's first-contract age, a parameter unknown everywhere.
 */
export function earliestPermittedApproachAt(dob, entry, { employingCountry = null } = {}) {
  const day = parseDob(dob);
  if (day === null || !entry?.rule) return { at: null, reason: 'MINOR_TIMING_NOT_ENCODED' };
  const b = new Date(`${day}T00:00:00Z`);
  const p = entry.rule.params ?? {};
  if (p.formula === 'academic_year_16') {
    const sixteenth = Date.UTC(b.getUTCFullYear() + 16, b.getUTCMonth(), b.getUTCDate());
    const d16 = new Date(sixteenth);
    const [mm, dd] = String(p.academicYearStart ?? '09-01').split('-').map(Number);
    // The academic year containing the sixteenth birthday starts on the most recent 1 Sep at or before it.
    const startYear = (d16.getUTCMonth() + 1 > mm || (d16.getUTCMonth() + 1 === mm && d16.getUTCDate() >= dd)) ? d16.getUTCFullYear() : d16.getUTCFullYear() - 1;
    return { at: Date.UTC(startYear, mm - 1, dd), reason: null, formula: 'academic_year_16' };
  }
  if (p.formula === 'six_months_before_first_contract_age') {
    const age = employingCountry ? p.firstContractAge?.[employingCountry] : null;
    if (typeof age !== 'number') return { at: null, reason: 'MINOR_TIMING_NOT_ENCODED', formula: p.formula };
    const contractAgeAt = Date.UTC(b.getUTCFullYear() + age, b.getUTCMonth(), b.getUTCDate());
    return { at: contractAgeAt - 6 * 30 * DAY, reason: null, formula: p.formula };
  }
  return { at: null, reason: 'MINOR_TIMING_NOT_ENCODED' };
}

/** No jurisdiction has a production minor pathway enabled (DR-49). */
export const MINOR_PATHWAY_PRODUCTION_ENABLED = Object.freeze({ ENG: false, INT: false, USA: false });

/**
 * Readiness only; no route lets an agency see a minor. `dob` is the server's record, never client-supplied;
 * `guardianConsents` are for this minor and this agent.
 */
export function evaluateMinorGate({ dob, memberAssociation, employingCountry = null, facets = {}, policySet = [], missingPolicies = [], guardianConsents = [], blocked = false, now = Date.now() }) {
  const d = emptyDecision();
  d.pathwayEnabledInProduction = false;
  const minor = isRegulatoryMinor(dob, now);
  if (minor === null) { d.blocked = true; d.reasons.push({ code: 'SUBJECT_DOB_UNKNOWN', ruleId: null, ruleStatus: 'UNKNOWN', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); return finish(d, policySet); }
  d.isRegulatoryMinor = minor;
  if (!minor) { d.reasons.push({ code: 'NOT_A_MINOR', ruleId: null, ruleStatus: 'ACTIVE', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); return finish(d, policySet); }
  if (blocked) { d.blocked = true; d.reasons.push({ code: 'SAFEGUARDING_BLOCK', ruleId: null, ruleStatus: 'ACTIVE', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); }

  // The minor's national timing rule, else FIFA's formula (whose parameter is unknown, so INSUFFICIENT_DATA).
  const national = memberAssociation && memberAssociation !== 'INT' ? policySet.find((p) => p.jurisdiction === memberAssociation) : null;
  const timingRuleId = national ? Object.keys(national.rules ?? {}).find((id) => national.rules[id]?.params?.formula) ?? null : null;
  const timing = timingRuleId ? ruleAt(policySet, timingRuleId, now) : ruleAt(policySet, 'FIFA-13.1', now);
  if ((missingPolicies ?? []).includes(memberAssociation) || (memberAssociation && memberAssociation !== 'INT' && !national)) {
    d.requiresManualReview = true; d.blocked = true;
    d.reasons.push({ code: 'POLICY_NOT_ENCODED', ruleId: null, ruleStatus: 'UNKNOWN', regulator: null, jurisdiction: memberAssociation, policyVersion: null });
  }
  if (timing.status !== 'ACTIVE') {
    d.requiresManualReview = true; d.blocked = true;
    d.reasons.push(reasonOf(timing.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN', timing));
  } else {
    const e = earliestPermittedApproachAt(dob, timing, { employingCountry });
    if (e.at === null) {
      d.requiresManualReview = true; d.blocked = true;
      d.reasons.push(reasonOf('INSUFFICIENT_DATA', timing, { detail: e.reason }));
    } else if (now < e.at) {
      d.blocked = true; d.reasons.push(reasonOf('MINOR_APPROACH_NOT_PERMITTED', timing, { reason: 'timing' })); // no date in the reason (DR-16)
    } else {
      d.reasons.push(reasonOf('MINOR_TIMING_SATISFIED', timing));
    }
  }
  // The individual's own facets, never the agency's.
  const licence = evaluatePolicy({ action: 'approach_minor', memberAssociations: [memberAssociation].filter(Boolean), facets, policySet, missingPolicies: [], now });
  for (const k of ['requiresNationalRegistration', 'requiresDomesticAuthorisation', 'requiresMinorAccreditation', 'requiresManualReview']) if (licence[k]) d[k] = true;
  if (licence.blocked) d.blocked = true;
  d.facetGaps.push(...licence.facetGaps);
  d.reasons.push(...licence.reasons.filter((r) => r.code !== 'FACET_VERIFIED' || true));
  // The guardian's unrevoked approach consent must pre-exist; it cannot be retroactive.
  const approachConsent = (guardianConsents ?? []).find((c) => c && c.kind === 'guardian_approach' && readInstant(c.grantedAt) !== null && c.grantedAt <= now && c.revokedAt == null);
  if (!approachConsent) { d.requiresGuardian = true; d.reasons.push(reasonOf('GUARDIAN_CONSENT_REQUIRED', timing, { consentKind: 'guardian_approach' })); }
  else d.reasons.push(reasonOf('GUARDIAN_CONSENT_PRESENT', timing, { consentKind: 'guardian_approach' }));
  return finish(d, policySet);
}

// ------------------------------------------------------------ representation scope

/** Agreement scopes that cover each context type. */
export const CONTEXT_TYPE_SCOPES = Object.freeze({
  employment_contract: ['employment'],
  transfer: ['transfer', 'employment'],
  loan: ['transfer', 'employment'],
  other_services: ['other_services', 'commercial'],
});

export function representationScopeProblem({ agreement, effectiveStatus, confirmed, contextType, memberAssociations = [] }) {
  if (!agreement) return { error: 'REPRESENTATION_REQUIRED' };
  if (effectiveStatus === 'expired') return { error: 'REPRESENTATION_EXPIRED', agreementId: agreement.id };
  if (effectiveStatus !== 'active' || !confirmed) return { error: 'REPRESENTATION_REQUIRED', agreementId: agreement.id, status: effectiveStatus };
  const needed = CONTEXT_TYPE_SCOPES[contextType];
  if (!needed) return { error: 'REPRESENTATION_SCOPE_INSUFFICIENT', agreementId: agreement.id, required: null };
  const scope = Array.isArray(agreement.scope) ? agreement.scope : [];
  if (!needed.some((s) => scope.includes(s))) return { error: 'REPRESENTATION_SCOPE_INSUFFICIENT', agreementId: agreement.id, required: needed };
  const j = agreement.jurisdiction ?? null;
  // An agreement for one national association does not authorise an act in another; INT covers only the international dimension.
  const foreign = memberAssociations.filter((m) => m && m !== 'INT' && j && j !== 'INT' && m !== j);
  if (foreign.length) return { error: 'REPRESENTATION_SCOPE_INSUFFICIENT', agreementId: agreement.id, required: memberAssociations };
  return null;
}
