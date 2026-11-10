/**
 * The versioned jurisdiction policy content.
 *
 * These are DATA, reviewed against the primary sources read on 18 September
 * 2026 (docs/reference/agent-regulatory-snapshot-2026-09.md). They seed the
 * policy-version table every evaluation reads; a later version is published
 * through the attributed, dual-controlled Trust & Safety route — never by
 * editing this file on a live system. Nothing here is legal advice; every
 * entry names its source, version, effective date and retrieval date.
 *
 * Two facts are stored separately on every rule, on purpose:
 *   - the TEXT exists in the current edition (`sourceRef`, `textStatus`), and
 *   - the rule is currently OPERATIVE (`ruleStatus`).
 * A rule that exists in text while its enforcement is suspended is a row with
 * `ruleStatus: SUSPENDED` or `UNDER_LEGAL_REVIEW`, never a deleted row.
 */

export const RULE_STATUSES = Object.freeze([
  'ACTIVE',                 // the body says it applies now
  'SUSPENDED',              // text exists; enforcement suspended by the same body
  'PARTIALLY_SUSPENDED',    // only some limbs suspended (params.activeLimbs apply)
  'JURISDICTION_OVERRIDE',  // a national entry governs inside its territory
  'PENDING_IMPLEMENTATION', // announced, not yet in force (never applied before effectiveFrom)
  'UNDER_LEGAL_REVIEW',     // governing-body materials conflict / status not established
  'UNKNOWN',                // not encoded from a primary source
]);

export const TEXT_STATUSES = Object.freeze(['CURRENT', 'CURRENT_BUT_SUSPENDED', 'CURRENT_WITH_PARTIAL_SUSPENSION', 'UNCERTAIN_OPERATIVE_STATUS', 'HISTORICAL', 'SUPERSEDED', 'ANNOUNCED']);

/** The parties of a transaction (the engine's vocabulary; conflict.mjs re-exports it). */
export const PARTY_ROLES = Object.freeze(['individual', 'engaging_entity', 'releasing_entity']);
/** The consents the ledger knows (only `dual_representation` is requested by a route today). */
export const CONSENT_KINDS = Object.freeze(['dual_representation', 'agency_performance', 'guardian_approach', 'guardian_agreement', 'legal_advice_ack']);
/** The minors approach-timing formulas the engine computes (policy.mjs earliestPermittedApproachAt). */
export const TIMING_FORMULAS = Object.freeze(['academic_year_16', 'six_months_before_first_contract_age']);
/** How a published override applies (only national entries exist). */
export const OVERRIDE_SCOPES = Object.freeze(['national']);

/**
 * The rule parameters a policy version may carry, by name, with their type. The engine reads parameters by name
 * (policy.mjs, conflict.mjs, the consent route), so a name it does not know is a typo that would silently change
 * nothing: publishing one is refused, like a value of the wrong type. A new parameter needs a build that reads it, and
 * is added here with it. Types:
 *   flag      true or false
 *   count     a whole number, 0 or more
 *   text      free text, at most 200 characters
 *   [values]  one of the listed values
 *   date      a calendar day, YYYY-MM-DD
 *   monthDay  a day of the year, MM-DD
 *   textList  a list of distinct texts (may be empty)
 *   roleSets  a list of party-role sets, each a non-empty list of distinct party roles
 *   ageMap    a map from a three-letter country code to an age in whole years (may be empty)
 */
export const RULE_PARAMS = Object.freeze({
  licenceRequired: 'flag', licenceHolder: 'text', onlyLicensedAgentPerforms: 'flag', agencyStaffMayNotApproach: 'flag',
  onlyLicensedAgentApproaches: 'flag', maxTermMonthsIndividual: 'count', oneAgreementPerPair: 'flag', legalAdviceNotice: 'flag',
  permittedSets: 'roleSets', consentKind: CONSENT_KINDS, consentInAdvance: 'flag', prohibitedWith: PARTY_ROLES,
  connectedAgentsAreOne: 'flag', sameAgencyConnected: 'flag', formula: TIMING_FORMULAS, firstContractAge: 'ageMap',
  guardianConsentBeforeApproach: 'flag', minorsAccreditationRequired: 'flag', validityYears: 'count', informational: 'flag',
  noFeeForMinorWithoutProContract: 'flag', otherServicesPresumptionMonths: 'count', exclusivityWindowMonths: 'count',
  discloseConflicts: 'flag', effectiveFrom: 'date', nationalRegistrationRequired: 'flag', requiresFifaLicence: 'flag',
  cascadeFromFifaLicence: 'flag', onlyRegisteredAgentPerforms: 'flag', agencyPartyColleaguePerformance: 'flag',
  productionEnabled: 'flag', pendingLegalReview: 'text', pfaLmaNotice: 'flag', academicYearStart: 'monthDay',
  coversIndirectApproach: 'flag', minorsAuthorisationRequired: 'flag', enhancedDbsWithinMonths: 'count',
  permittedMultiple: 'flag', excludedRole: PARTY_ROLES, fullParticularsRequired: 'flag', legalAdviceOfferRequired: 'flag',
  prescribedForm: 'text', activeLimbs: 'textList', lodgeWithinDays: 'count', domesticAuthorisationRequired: 'flag',
  kind: 'text',
});
export const RULE_PARAM_TEXT_MAX = 200;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Is `v` a calendar day written YYYY-MM-DD (a day that exists)? */
export function isCalendarDay(v) {
  const m = typeof v === 'string' ? DAY_RE.exec(v) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const isMonthDay = (v) => typeof v === 'string' && /^\d{2}-\d{2}$/.test(v) && isCalendarDay(`2000-${v}`);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/**
 * Type a rule's `params` against RULE_PARAMS: `{ ok: true, params }` (a fresh copy, keys in the given order) or
 * `{ ok: false, field, why }` naming the parameter, never its value.
 */
export function typeRuleParams(params) {
  if (params === undefined || params === null) return { ok: true, params: {} };
  if (!plain(params)) return { ok: false, field: 'params', why: 'must be an object of named parameters' };
  const out = {};
  for (const [name, v] of Object.entries(params)) {
    const type = Object.hasOwn(RULE_PARAMS, name) ? RULE_PARAMS[name] : null;
    const no = (why) => ({ ok: false, field: `params.${name}`, why });
    if (!type) return no('is not a parameter this build reads');
    if (Array.isArray(type)) { if (!type.includes(v)) return no(`must be one of ${type.join('|')}`); out[name] = v; continue; }
    if (type === 'flag') { if (typeof v !== 'boolean') return no('must be true or false'); out[name] = v; continue; }
    if (type === 'count') { if (!Number.isSafeInteger(v) || v < 0) return no('must be a whole number, 0 or more'); out[name] = v; continue; }
    if (type === 'text') { if (typeof v !== 'string' || !v.length || v.length > RULE_PARAM_TEXT_MAX) return no(`must be text of 1 to ${RULE_PARAM_TEXT_MAX} characters`); out[name] = v; continue; }
    if (type === 'date') { if (!isCalendarDay(v)) return no('must be a calendar day written YYYY-MM-DD'); out[name] = v; continue; }
    if (type === 'monthDay') { if (!isMonthDay(v)) return no('must be a day of the year written MM-DD'); out[name] = v; continue; }
    if (type === 'textList') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.length || x.length > RULE_PARAM_TEXT_MAX) || new Set(v).size !== v.length) return no(`must be a list of distinct texts of 1 to ${RULE_PARAM_TEXT_MAX} characters`);
      out[name] = [...v]; continue;
    }
    if (type === 'roleSets') {
      if (!Array.isArray(v) || v.some((set) => !Array.isArray(set) || !set.length || set.some((r) => !PARTY_ROLES.includes(r)) || new Set(set).size !== set.length)) return no(`must be a list of non-empty sets of distinct party roles (${PARTY_ROLES.join('|')})`);
      out[name] = v.map((set) => [...set]); continue;
    }
    // ageMap
    if (!plain(v) || Object.entries(v).some(([k, age]) => !/^[A-Z]{3}$/.test(k) || !Number.isSafeInteger(age) || age < 0 || age > 30)) return no('must map three-letter country codes to an age of 0 to 30 years');
    out[name] = { ...v };
  }
  return { ok: true, params: out };
}

const src = (source, version, effectiveDate, retrievedDate = '2026-09-18') => ({ source, version, effectiveDate, retrievedDate });
const S1 = src('FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01');
const S2 = src('FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30');
const S3 = src('CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16');
const S4 = src('FIFA statement welcoming the CJEU decision', '16 Jul 2026', '2026-07-16');
const S5 = src('FIFA agents FAQ', 'last updated 23 Jan 2025', '2025-01-23');
const S6b = src('FIFA Bureau of the Council — new regulatory framework for the transfer system', '10 Jun 2026', '2027-01-01');
const S7 = src('The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01');
const S8 = src('The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01');
const S9c = src('The FA — FA Registered Football Agent criminal record check process', 'undated, current', '2026-06-01');
const S10 = src('U.S. Soccer — Player Agents', 'read 18 Sep 2026', '2024-01-01');

const rule = (ruleStatus, textStatus, sourceRef, params = {}, note = null, extra = {}) => ({ ruleStatus, textStatus, sourceRef, params, note, ...extra });

const FIFA_UNCERTAIN_NOTE = 'Circular 1873 (30 Dec 2023) suspended enforcement "until the European Court of Justice renders a final decision"; the CJEU decided C-209/23 on 16 Jul 2026 and referred proportionality to the national court; FIFA has issued no instrument since. The operative status is not conclusively established (L-1, DR-46). The engine returns MANUAL_REGULATORY_REVIEW_REQUIRED wherever this rule would decide an outcome and no national ACTIVE entry applies.';

/** FFAR 2025 edition with the enforcement statuses of 18 Sep 2026. */
export const JP_FIFA_2025_1 = Object.freeze({
  id: 'jp-fifa-2025-1', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 1, supersedes: null,
  effectiveFrom: '2025-01-01', effectiveTo: null,
  status: 'published', publishedBy: [{ kind: 'system', id: 'migration-2306', name: 'seeded from the regulatory snapshot (18 Sep 2026)' }],
  rules: {
    'FIFA-8.1':   rule('ACTIVE', 'CURRENT', [S1], { licenceRequired: true, licenceHolder: 'natural_person' }, 'A licence is issued to a natural person; strictly personal and non-transferable.'),
    'FIFA-11.1':  rule('ACTIVE', 'CURRENT', [S1, S3], { onlyLicensedAgentPerforms: true }, 'Only a Football Agent may perform Football Agent Services. CJEU: the licence requirement "may be justified".'),
    'FIFA-11.3':  rule('ACTIVE', 'CURRENT', [S1], { agencyStaffMayNotApproach: true }, 'Agency employees who are not Football Agents may not perform services or make any Approach.'),
    'FIFA-12.2':  rule('ACTIVE', 'CURRENT', [S1], { onlyLicensedAgentApproaches: true }, 'Only a Football Agent may Approach a potential Client.'),
    'FIFA-12.3':  rule('ACTIVE', 'CURRENT', [S1], { maxTermMonthsIndividual: 24 }, 'Two-year maximum for agreements with Individuals; automatic renewal void.'),
    'FIFA-12.4':  rule('ACTIVE', 'CURRENT', [S1], { oneAgreementPerPair: true, legalAdviceNotice: true }),
    'FIFA-12.8':  rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2, S3, S4, S5], { permittedSets: [['individual', 'engaging_entity']], consentKind: 'dual_representation', consentInAdvance: true }, FIFA_UNCERTAIN_NOTE,
      { overrides: [{ jurisdiction: 'ENG', scope: 'national', overrideRuleId: 'ENG-6.3' }] }),
    'FIFA-12.9':  rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2, S3, S4, S5], { prohibitedWith: 'releasing_entity' }, FIFA_UNCERTAIN_NOTE,
      { overrides: [{ jurisdiction: 'ENG', scope: 'national', overrideRuleId: 'ENG-6.4' }] }),
    'FIFA-12.10': rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2, S3, S4], { connectedAgentsAreOne: true, sameAgencyConnected: true }, FIFA_UNCERTAIN_NOTE,
      { overrides: [{ jurisdiction: 'ENG', scope: 'national', overrideRuleId: 'ENG-6.5' }] }),
    'FIFA-13.1':  rule('ACTIVE', 'CURRENT', [S1], { formula: 'six_months_before_first_contract_age', firstContractAge: {}, guardianConsentBeforeApproach: true }, 'The first-professional-contract age is the employing country\'s law and is NOT encoded for any country (L-6): the parameter is UNKNOWN → INSUFFICIENT_DATA.'),
    'FIFA-13.2':  rule('ACTIVE', 'CURRENT', [S1, S5], { minorsAccreditationRequired: true, validityYears: 3 }),
    'FIFA-14.2':  rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2, S3], { informational: true }, 'Client-pays and the fee framework; no fee rule is enforced by ScoutBox (P-5).'),
    'FIFA-14.9':  rule('ACTIVE', 'CURRENT', [S1], { informational: true, noFeeForMinorWithoutProContract: true }),
    'FIFA-15.1':  rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2, S3], { informational: true }, 'Fee caps. Never validated (DR-31).'),
    'FIFA-15.3':  rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S2], { otherServicesPresumptionMonths: 24 }, 'Other Services presumption: review, never prohibit (DR-34).'),
    'FIFA-16.1b': rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S1, S3], { exclusivityWindowMonths: 2 }, 'CJEU: the exclusive-agreement approach window "appears … incompatible with the prohibition on cartels". Manual review, never a hard block (DR-33).'),
    'FIFA-16.2c': rule('ACTIVE', 'CURRENT', [S1], { informational: true, discloseConflicts: true }),
    'FIFA-19':    rule('SUSPENDED', 'CURRENT_BUT_SUSPENDED', [S1, S2, S3], { informational: true }, 'Publication suspended by Circular 1873 and constrained by the GDPR per the CJEU; ScoutBox publishes nothing.'),
    'FIFA-RSTP-2027': rule('PENDING_IMPLEMENTATION', 'ANNOUNCED', [S6b], { effectiveFrom: '2027-01-01' }, 'Announced regulatory framework in force 1 Jan 2027; no agent-regulation content published. Never applied before its effective date.', { effectiveFrom: '2027-01-01' }),
  },
});

/** The FA Football Agent Regulations 2026-27, in force 1 June 2026. */
export const JP_ENG_2026_27_1 = Object.freeze({
  id: 'jp-eng-2026-27-1', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 1, supersedes: null,
  effectiveFrom: '2026-06-01', effectiveTo: null,
  status: 'published', publishedBy: [{ kind: 'system', id: 'migration-2306', name: 'seeded from the regulatory snapshot (18 Sep 2026)' }],
  rules: {
    'ENG-2.1':  rule('ACTIVE', 'CURRENT', [S7, S8], { nationalRegistrationRequired: true, requiresFifaLicence: true }, 'Before any regulated conduct an agent must be an FA Registered Football Agent; registration requires a FIFA licence.'),
    'ENG-2.10': rule('ACTIVE', 'CURRENT', [S7], { cascadeFromFifaLicence: true }, 'FIFA licence suspended or withdrawn → FA registration automatically suspended or withdrawn.'),
    'ENG-3.1':  rule('ACTIVE', 'CURRENT', [S7], { onlyRegisteredAgentPerforms: true }),
    'ENG-3.3':  rule('ACTIVE', 'CURRENT', [S7, S8], { agencyStaffMayNotApproach: true }),
    'ENG-4.1b': rule('ACTIVE', 'CURRENT', [S7, S8], { agencyPartyColleaguePerformance: true, consentKind: 'agency_performance', productionEnabled: false, pendingLegalReview: 'L-9' }, 'A licensed, FA-registered colleague may perform under an agency-party agreement with all parties\' written consent. Modelled; DISABLED in production until L-9 (DR-45).'),
    'ENG-4.3':  rule('ACTIVE', 'CURRENT', [S7], { maxTermMonthsIndividual: 24 }),
    'ENG-4.4':  rule('ACTIVE', 'CURRENT', [S7], { oneAgreementPerPair: true }),
    'ENG-4.5':  rule('ACTIVE', 'CURRENT', [S7, S8], { legalAdviceNotice: true, pfaLmaNotice: true }),
    'ENG-5.1':  rule('ACTIVE', 'CURRENT', [S7, S8], { formula: 'academic_year_16', academicYearStart: '09-01', guardianConsentBeforeApproach: true, coversIndirectApproach: true }, 'Not before 1 September in the Academic Year in which the Minor reaches 16; prior written guardian consent before any Approach or agreement. England\'s formula only; never generalised (DR-48).'),
    'ENG-5.2':  rule('ACTIVE', 'CURRENT', [S7, S8, S9c], { minorsAuthorisationRequired: true, validityYears: 3, enhancedDbsWithinMonths: 3 }, 'Additional authorisation to deal with Minors from The FA; suitability incl. enhanced DBS; valid three years; automatic suspension on lapse.'),
    'ENG-6.3':  rule('ACTIVE', 'CURRENT', [S7, S8], { permittedMultiple: true, excludedRole: 'releasing_entity', consentKind: 'dual_representation', consentInAdvance: true, fullParticularsRequired: true, legalAdviceOfferRequired: true, prescribedForm: 'AF1 at completion constitutes written consent' }, 'Permitted dual OR multiple representation with four safeguards (all parties\' prior written consent; full particulars incl. fees; opportunity for independent legal advice; express written consent on the proposed terms).'),
    'ENG-6.4':  rule('ACTIVE', 'CURRENT', [S7, S8], { prohibitedWith: 'releasing_entity' }, 'When acting for a Releasing Club the agent may perform services for no other party in the same National Transaction.'),
    'ENG-6.5':  rule('ACTIVE', 'CURRENT', [S7, S8], { connectedAgentsAreOne: true, sameAgencyConnected: true }, 'An agent and a Connected Football Agent may not act for different parties in the same National Transaction except under 6.3.'),
    'ENG-7.2':  rule('ACTIVE', 'CURRENT', [S7, S8], { informational: true }, 'Client pays (with the USD 200,000 engaging-club exception, 7.3). Recorded, never enforced (DR-31).'),
    'ENG-7.10': rule('ACTIVE', 'CURRENT', [S7, S8], { informational: true, noFeeForMinorWithoutProContract: true }),
    'ENG-7.13': rule('PARTIALLY_SUSPENDED', 'CURRENT_WITH_PARTIAL_SUSPENSION', [S7], { informational: true, activeLimbs: [] }, 'Clearing House: not covered by the 2026-27 Guidance, likely shaded (L-7). No payment channel exists.'),
    'ENG-8.1b': rule('UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', [S7, S3], { exclusivityWindowMonths: 2 }, 'Exclusive-agreement approach window: in the 2026-27 text; doubtful after the CJEU judgment (L-2). Manual review, never a hard block.'),
    'ENG-8.3g': rule('ACTIVE', 'CURRENT', [S7, S8], { informational: true, lodgeWithinDays: 14 }, 'Lodging duties. ScoutBox keeps records; it does not file (L-16).'),
  },
});

/** U.S. Soccer — thin: licence, background check and SafeSport known; everything else UNKNOWN (DR-44, L-8). */
export const JP_USA_2024_1 = Object.freeze({
  id: 'jp-usa-2024-1', regulator: 'USSF', jurisdiction: 'USA', policyVersion: 1, supersedes: null,
  effectiveFrom: '2024-01-01', effectiveTo: null,
  status: 'published', publishedBy: [{ kind: 'system', id: 'migration-2306', name: 'seeded from the regulatory snapshot (18 Sep 2026)' }],
  rules: {
    'USA-LIC':   rule('ACTIVE', 'CURRENT', [S10], { licenceRequired: true }, 'Effective 1 Jan 2024 U.S. Soccer enforces the FFAR; any agent in its jurisdiction must be FIFA-licensed.'),
    'USA-BGC':   rule('ACTIVE', 'CURRENT', [S10], { domesticAuthorisationRequired: true, kind: 'background_check_safesport' }, 'Background check and SafeSport training required for all agents operating in the United States; scope is a counsel item (R-U2).'),
    'USA-MULTI': rule('UNKNOWN', 'UNCERTAIN_OPERATIVE_STATUS', [S10], {}, 'No U.S. Soccer national regulations text was located; multiple-representation rules are not encoded.'),
    'USA-MINOR': rule('UNKNOWN', 'UNCERTAIN_OPERATIVE_STATUS', [S10], {}, 'No minors approach timing or first-contract age was located (L-8). Any U.S. minors pathway is INSUFFICIENT_DATA → refused.'),
  },
});

export const SEEDED_POLICY_VERSIONS = Object.freeze([JP_FIFA_2025_1, JP_ENG_2026_27_1, JP_USA_2024_1]);

/** The jurisdictions whose rules are encoded well enough for an adult regulated action. */
export const ENCODED_JURISDICTIONS = Object.freeze(['INT', 'ENG', 'USA']);
