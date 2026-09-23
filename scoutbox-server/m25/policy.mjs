/**
 * M23 P5.6C — the policy evaluation layer (pure).
 *
 * Routes never say `if (country === 'GB')`. They hand the applicable policy
 * set, the agent's facet states, the subject and the clock to this module and
 * get a structured decision back. Everything here is a function over plain
 * records; nothing reads `db`, nothing answers HTTP.
 *
 * Frozen semantics (M23_P56A_CONFLICT_ENGINE_CONTRACT.md §3, §3a; P5.6A DR-52):
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
import { parseDob } from '../domain.mjs';
import { parseStrictDateOnly, readInstant } from '../temporal.mjs';

export { RULE_STATUSES };

export const POLICY_ACTIONS = Object.freeze(['approach_adult', 'declare_representation', 'request_consent', 'approach_minor']);

/** Facet names the policy layer can require. `domestic_authorisation` is new in P5.6C (P5.6A DR-53). */
export const POLICY_FACETS = Object.freeze(['fifa_licence', 'national_registration', 'domestic_authorisation', 'minors_authorisation']);

const DAY = 24 * 60 * 60 * 1000;

/**
 * A policy boundary (`effectiveFrom` / `effectiveTo`) as an instant: a strict
 * DATE_ONLY (UTC midnight of that day) or a finite integer timestamp; NaN
 * otherwise. M23 P5.7 (T-4): the previous regex-then-Date.parse accepted
 * `2026-02-30` as 2 March — a published policy could start on a day that does
 * not exist. NaN fails every window comparison, so an unreadable boundary
 * means the version is never selected (closed).
 */
const dateMs = (iso) => {
  if (typeof iso === 'string') { const p = parseStrictDateOnly(iso); return p.ok ? p.t : NaN; }
  return readInstant(iso) ?? NaN;
};

// ------------------------------------------------------------ versions

/** The published version of a jurisdiction that is in effect at `now` (latest policyVersion wins among the effective ones). */
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

/**
 * The applicable policy set for a list of member associations. FIFA (`INT`)
 * always applies; each other MA contributes its national entry. A missing
 * entry is reported, never silently skipped.
 */
export function applicablePolicySet(rows, memberAssociations, now = Date.now()) {
  const mas = [...new Set(['INT', ...(memberAssociations ?? []).filter((m) => typeof m === 'string' && m && m !== 'INT')])];
  const policies = []; const missing = [];
  for (const ma of mas) {
    const v = selectPolicyVersion(rows, ma, now);
    if (v) policies.push(v); else missing.push(ma);
  }
  return { policies, missing, memberAssociations: mas };
}

/** Find a rule entry in a policy set, with its owning version. */
export function findRule(policySet, ruleId) {
  for (const p of policySet ?? []) {
    if (p?.rules && Object.hasOwn(p.rules, ruleId)) return { rule: p.rules[ruleId], policy: p };
  }
  return null;
}

/** The rule's operative status at `now` (PENDING_IMPLEMENTATION before its own effectiveFrom stays pending; after, it reads as ACTIVE). */
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

/** Look up a rule and stamp its status; a missing rule is an UNKNOWN entry so it still produces a reason. */
export function ruleAt(policySet, ruleId, now = Date.now()) {
  const found = findRule(policySet, ruleId);
  if (!found) return { ruleId, rule: null, policy: null, status: 'UNKNOWN' };
  return { ruleId, rule: found.rule, policy: found.policy, status: ruleStatusAt(found, now) };
}

// ------------------------------------------------------------ scope

/**
 * Jurisdiction resolution (contract §4.0). `national` when every MA in play
 * is the same national association with an encoded national policy;
 * `international` when INT or more than one MA is involved; `unknown` when
 * nothing usable was supplied.
 */
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

/** Map a required facet's effective state to the objective refusal the route answers with. */
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

/**
 * Require a facet under a rule: an ACTIVE rule that names the facet makes it
 * mandatory (fail closed on anything but VERIFIED); a non-ACTIVE rule only
 * contributes a reason.
 */
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
 * Evaluate the policy for a regulated action.
 *
 * @param {object} p
 * @param {string} p.action           one of POLICY_ACTIONS
 * @param {string[]} p.memberAssociations  the MAs the act touches (the agreement's jurisdiction; a context's parties' MAs)
 * @param {object} p.facets           the agent's facets as effective states: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' }, domestic_authorisation: {…}, minors_authorisation: {…} }
 * @param {object[]} p.policySet      applicable policy rows (from applicablePolicySet)
 * @param {string[]} p.missingPolicies  MAs with no encoded entry
 * @param {object[]} [p.otherExclusiveAgreements]  other agents' active EXCLUSIVE agreements with the subject, ANONYMISED: [{ endAt }]
 * @param {number} p.now
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

  // The FIFA licence: personal, required for every regulated act (FIFA-8.1 / 11.1 / 12.2, ACTIVE).
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
    // FIFA minors accreditation: recorded as a facet on the INT scope. Required by the ACTIVE rule.
    requireFacet(d, acc, 'minors_authorisation', 'INT', facets, 'requiresMinorAccreditation');
  }

  // Exclusive-agreement approach window (FIFA-16.1b / ENG-8.1b): UNDER_LEGAL_REVIEW →
  // manual review whenever the rule WOULD decide, never a block, never the other agent's identity.
  if ((action === 'approach_adult') && (otherExclusiveAgreements ?? []).length) {
    for (const ruleId of ['FIFA-16.1b', ...mas.filter((m) => m !== 'INT').map((m) => `${m}-8.1b`)]) {
      const e = ruleAt(policySet, ruleId, now);
      if (!e.rule) continue;
      if (e.status === 'ACTIVE') {
        // If a body ever settles this rule as ACTIVE, the text's own window applies: an approach is
        // permitted only in the final two months of the other agreement.
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
  // P5.6F (F-8): `new Date(null)` is the EPOCH, not an invalid date, so a null
  // date of birth used to answer "not a minor" (a 56-year-old) instead of
  // "unknown". Same for 0 and false. Only a non-empty string can be a date of
  // birth here; anything else is unknown, and unknown blocks (evaluateMinorGate).
  // …and (F-12b) a day that only exists because V8 rolled it over — 30 February
  // — is not a date of birth either. One rule for the whole platform: parseDob.
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
 * The earliest permitted approach date for a minor under ONE jurisdiction's
 * timing rule, or null with a reason when the parameter is not encoded.
 * England: 1 September of the Academic Year (1 Sep–31 Aug) in which the minor
 * reaches 16 (FA 2026-27 reg. 5.1). FIFA: six months before the employing
 * country's first-contract age — a parameter that is UNKNOWN everywhere.
 */
export function earliestPermittedApproachAt(dob, entry, { employingCountry = null } = {}) {
  // M23 P5.7 (T-5): `new Date(null)` is the epoch and `new Date('2010-02-30')`
  // is 2 March; a formula over either produced a confident, wrong date. One
  // DOB rule for the platform: parseDob.
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

/** No jurisdiction has a production minor pathway enabled (P5.6A DR-49; this mandate §49). */
export const MINOR_PATHWAY_PRODUCTION_ENABLED = Object.freeze({ ENG: false, INT: false, USA: false });

/**
 * The minors compliance gate (mandate §47): jurisdiction-aware, guardian-first,
 * accreditation-bound, fail-closed. Evaluates readiness; it exposes no
 * discovery and the route layer never lets an agency see a minor.
 *
 * @param {object} p
 * @param {string} p.dob                       the minor's date of birth (server record, never client-supplied)
 * @param {string} p.memberAssociation         the minor's jurisdiction
 * @param {string} [p.employingCountry]        for the FIFA formula
 * @param {object} p.facets                    the agent's facets (effective states)
 * @param {object[]} p.policySet
 * @param {string[]} p.missingPolicies
 * @param {object[]} p.guardianConsents        [{ kind, grantedAt, revokedAt, subjectId }] for THIS minor and THIS agent
 * @param {boolean} p.blocked                  block / safeguarding state
 * @param {number} p.now
 */
export function evaluateMinorGate({ dob, memberAssociation, employingCountry = null, facets = {}, policySet = [], missingPolicies = [], guardianConsents = [], blocked = false, now = Date.now() }) {
  const d = emptyDecision();
  d.pathwayEnabledInProduction = false;
  const minor = isRegulatoryMinor(dob, now);
  if (minor === null) { d.blocked = true; d.reasons.push({ code: 'SUBJECT_DOB_UNKNOWN', ruleId: null, ruleStatus: 'UNKNOWN', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); return finish(d, policySet); }
  d.isRegulatoryMinor = minor;
  if (!minor) { d.reasons.push({ code: 'NOT_A_MINOR', ruleId: null, ruleStatus: 'ACTIVE', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); return finish(d, policySet); }
  if (blocked) { d.blocked = true; d.reasons.push({ code: 'SAFEGUARDING_BLOCK', ruleId: null, ruleStatus: 'ACTIVE', regulator: null, jurisdiction: memberAssociation ?? null, policyVersion: null }); }

  // Which timing rule governs: the minor's national ACTIVE entry; else FIFA's formula (parameter unknown → INSUFFICIENT_DATA).
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
  // Licence, registration, minors authorisation — the individual's own facets, never the agency's.
  const licence = evaluatePolicy({ action: 'approach_minor', memberAssociations: [memberAssociation].filter(Boolean), facets, policySet, missingPolicies: [], now });
  for (const k of ['requiresNationalRegistration', 'requiresDomesticAuthorisation', 'requiresMinorAccreditation', 'requiresManualReview']) if (licence[k]) d[k] = true;
  if (licence.blocked) d.blocked = true;
  d.facetGaps.push(...licence.facetGaps);
  d.reasons.push(...licence.reasons.filter((r) => r.code !== 'FACET_VERIFIED' || true));
  // Guardian first: a prior, unrevoked approach consent must PRE-EXIST (no retroactive consent).
  const approachConsent = (guardianConsents ?? []).find((c) => c && c.kind === 'guardian_approach' && readInstant(c.grantedAt) !== null && c.grantedAt <= now && c.revokedAt == null);
  if (!approachConsent) { d.requiresGuardian = true; d.reasons.push(reasonOf('GUARDIAN_CONSENT_REQUIRED', timing, { consentKind: 'guardian_approach' })); }
  else d.reasons.push(reasonOf('GUARDIAN_CONSENT_PRESENT', timing, { consentKind: 'guardian_approach' }));
  return finish(d, policySet);
}

// ------------------------------------------------------------ representation scope

/**
 * The action must fit the agreement (mandate §25–§26). No exceptions are
 * invented: anything but an ACTIVE, client-confirmed, unexpired agreement
 * whose scope and jurisdiction cover the act is refused.
 */
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
  // An agreement declared for one national association does not authorise an act in another; INT covers international dimension only.
  const foreign = memberAssociations.filter((m) => m && m !== 'INT' && j && j !== 'INT' && m !== j);
  if (foreign.length) return { error: 'REPRESENTATION_SCOPE_INSUFFICIENT', agreementId: agreement.id, required: memberAssociations };
  return null;
}
