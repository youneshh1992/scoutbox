/**
 * The compliance routes' request input. Each refusal keeps the route's own code (COMPLIANCE_INPUT_INVALID,
 * CONTEXT_INPUT_INVALID, …) through COMPLIANCE_INPUT_CODES and says which field and what was wrong with it.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  REV_FIELDS,
  dateOnly,
  flag,
  id,
  oneOf,
  requiredText,
  text,
  wholeNumber,
} from '../../platform/schemas.mjs';
import { JURISDICTIONS } from '../core/shared.mjs';
import { COMPLIANCE_POLICY_LIMITS as PL, REVIEWER_ROLES } from '../../../repositories/compliancePolicies.mjs';
import { REVIEW_STATUSES } from '../../../repositories/complianceRecords.mjs';
import { OVERRIDE_SCOPES, PARTY_ROLES, RULE_PARAMS, RULE_STATUSES, TEXT_STATUSES } from './policyVersions.mjs';
import { CONTEXT_TYPES } from './conflict.mjs';

/** What a free-text field may hold. A review decision keeps its reason code and reason in these. */
export const COMPLIANCE_TEXT_LIMITS = Object.freeze({
  reviewReasonCode: 60,
  reviewReason: 1000,
  evidenceRef: 200,
  evidenceRefs: 10,
  cancelReason: 400,
  secretMin: 12,
  secretMax: 200,
  jurisdictions: 10,
  parties: 6,
});
const T = COMPLIANCE_TEXT_LIMITS;

// normaliseClientKey judges the key itself (trimmed, at most CLIENT_KEY_MAX characters) under its own code.
const clientKey = v.nullish(v.string());
const optText = (max) => v.nullish(text(max));
const memberAssociation = v.pipe(v.string(), v.regex(/^[A-Za-z]{3}$/, 'must be a three-letter code'));
const partyRole = oneOf(PARTY_ROLES);

// ------------------------------------------------------------- reviewers
const ReviewerLogin = v.strictObject({ reviewerId: text(PL.reviewerId), secret: text(T.secretMax) });
const NewReviewer = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{2,39}$/i, 'must be 3 to 40 letters, digits or dashes')),
  name: requiredText(PL.name),
  role: v.optional(oneOf(REVIEWER_ROLES)),
  secret: v.pipe(v.string(), v.minLength(T.secretMin), v.maxLength(T.secretMax)),
});
const ReviewerRevocation = v.strictObject({ reason: optText(PL.revokeReason), ...REV_FIELDS });

// ------------------------------------------------------------- policies
const PARAM_SCHEMAS = {
  flag: v.boolean(),
  count: wholeNumber({ min: 0 }),
  text: text(200),
  date: dateOnly,
  monthDay: v.pipe(v.string(), v.regex(/^\d{2}-\d{2}$/, 'must be a day of the year written MM-DD')),
  textList: v.pipe(v.array(text(200)), v.maxLength(50)),
  roleSets: v.pipe(v.array(v.pipe(v.array(partyRole), v.minLength(1))), v.maxLength(20)),
  ageMap: v.record(memberAssociation, wholeNumber({ min: 0, max: 30 })),
};
// Each parameter the engine reads, with its type: a misspelt one would silently change nothing, so it is refused.
const RuleParams = v.strictObject(
  Object.fromEntries(
    Object.entries(RULE_PARAMS).map(([name, kind]) => [
      name,
      v.nullish(Array.isArray(kind) ? oneOf(kind) : PARAM_SCHEMAS[kind]),
    ]),
  ),
);
const SourceRef = v.strictObject({
  source: requiredText(PL.source),
  version: optText(PL.sourceVersion),
  effectiveDate: v.nullish(dateOnly),
  retrievedDate: dateOnly,
});
const Override = v.strictObject({
  jurisdiction: oneOf(JURISDICTIONS),
  scope: oneOf(OVERRIDE_SCOPES),
  overrideRuleId: v.pipe(v.string(), v.minLength(1), v.maxLength(PL.ruleId)),
});
const Rule = v.strictObject({
  ruleStatus: oneOf(RULE_STATUSES),
  textStatus: v.nullish(oneOf(TEXT_STATUSES)),
  sourceRef: v.pipe(v.array(SourceRef), v.minLength(1), v.maxLength(PL.sourceCount)),
  params: v.nullish(RuleParams),
  note: optText(PL.note),
  overrides: v.nullish(v.pipe(v.array(Override), v.maxLength(PL.overrideCount))),
  effectiveFrom: v.nullish(dateOnly),
});
const NewPolicy = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^jp-[a-z]{2,6}-[0-9a-z-]{2,20}$/i, 'must be written jp-<body>-<version>')),
  regulator: optText(PL.regulator),
  jurisdiction: oneOf(JURISDICTIONS),
  policyVersion: wholeNumber({ min: 1 }),
  supersedes: v.nullish(id),
  effectiveFrom: dateOnly,
  effectiveTo: v.nullish(dateOnly),
  rules: v.pipe(
    v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(PL.ruleId)), Rule),
    v.check((r) => Object.keys(r).length > 0, 'must name at least one rule'),
    v.check((r) => Object.keys(r).length <= PL.ruleCount, `must name at most ${PL.ruleCount} rules`),
  ),
});

// ------------------------------------------------------------- facets and contexts
const FacetRecheck = v.strictObject({ memberAssociation: v.nullish(memberAssociation) });
const Party = {
  partyRole,
  subjectKind: oneOf(['player', 'club']),
  subjectId: id,
};
const NewContext = v.strictObject({
  type: oneOf(CONTEXT_TYPES),
  jurisdictions: v.pipe(v.array(memberAssociation), v.minLength(1), v.maxLength(T.jurisdictions)),
  parties: v.nullish(v.pipe(v.array(v.strictObject(Party)), v.maxLength(T.parties))),
  clientKey,
});
const NewParty = v.strictObject({ ...Party, ...REV_FIELDS });
const Declaration = v.strictObject({ partyRole, agreementId: v.nullish(id), clientKey, ...REV_FIELDS });
const RevOnly = v.strictObject({ ...REV_FIELDS });
const NoInput = v.strictObject({});

// ------------------------------------------------------------- consents
const ConsentRequest = v.strictObject({
  partyRole,
  fullParticularsProvided: v.optional(flag),
  legalAdviceOffered: v.optional(flag),
  proposedFeeDisclosed: v.optional(flag),
  clientKey,
});
const ConsentGrant = v.strictObject({
  acknowledgedParticulars: v.optional(flag),
  acknowledgedLegalAdvice: v.optional(flag),
  clientKey,
  ...REV_FIELDS,
});
const ConsentAnswer = v.strictObject({ clientKey, ...REV_FIELDS });

// ------------------------------------------------------------- reviews
const ReviewQueue = v.strictObject({ status: v.optional(oneOf(REVIEW_STATUSES)), ...CURSOR_PAGE });
const ReviewResolution = v.strictObject({
  outcome: oneOf(['APPROVED', 'REJECTED']),
  reasonCode: optText(T.reviewReasonCode),
  reason: optText(T.reviewReason),
  evidenceRefs: v.nullish(v.pipe(v.array(text(T.evidenceRef)), v.maxLength(T.evidenceRefs))),
  clientKey,
  ...REV_FIELDS,
});
const ReviewClosure = v.strictObject({ reason: optText(T.cancelReason), ...REV_FIELDS });

export const COMPLIANCE_INPUT = Object.freeze({
  reviewerLogin: ReviewerLogin,
  newReviewer: NewReviewer,
  reviewerRevocation: ReviewerRevocation,
  newPolicy: NewPolicy,
  policyApproval: NoInput,
  facetRecheck: FacetRecheck,
  newContext: NewContext,
  newParty: NewParty,
  declaration: Declaration,
  evaluation: NoInput,
  contextRev: RevOnly,
  reviewStart: RevOnly,
  consentRequest: ConsentRequest,
  consentGrant: ConsentGrant,
  consentAnswer: ConsentAnswer,
  reviewQueue: ReviewQueue,
  reviewResolution: ReviewResolution,
  reviewClosure: ReviewClosure,
});

const REV_CODES = { expectedRev: 'EXPECTED_REV_INVALID', expectedVersion: 'EXPECTED_REV_INVALID' };

/**
 * Per schema: the code a refusal carries, and the fields with codes of their own. A malformed rev is refused as
 * guardRev refuses it, and a malformed client key as the idempotency check does.
 */
export const COMPLIANCE_INPUT_CODES = Object.freeze({
  reviewerLogin: 'COMPLIANCE_INPUT_INVALID',
  newReviewer: 'COMPLIANCE_INPUT_INVALID',
  reviewerRevocation: 'COMPLIANCE_INPUT_INVALID',
  newPolicy: 'POLICY_INPUT_INVALID',
  policyApproval: 'POLICY_INPUT_INVALID',
  facetRecheck: 'COMPLIANCE_INPUT_INVALID',
  newContext: 'CONTEXT_INPUT_INVALID',
  newParty: 'CONTEXT_INPUT_INVALID',
  declaration: 'COMPLIANCE_INPUT_INVALID',
  evaluation: 'CONTEXT_INPUT_INVALID',
  contextRev: 'CONTEXT_INPUT_INVALID',
  reviewStart: 'REVIEW_INPUT_INVALID',
  consentRequest: 'COMPLIANCE_INPUT_INVALID',
  consentGrant: 'CONSENT_INPUT_INVALID',
  consentAnswer: 'CONSENT_INPUT_INVALID',
  reviewQueue: 'REVIEW_INPUT_INVALID',
  reviewResolution: 'REVIEW_INPUT_INVALID',
  reviewClosure: 'REVIEW_INPUT_INVALID',
});

export const complianceParseOptions = (name, root = 'body') => {
  const code = COMPLIANCE_INPUT_CODES[name];
  return {
    root,
    codes: { FIELD_INVALID: code, DATE_INVALID: code },
    fieldCodes: { ...REV_CODES, clientKey: 'COMPLIANCE_CLIENT_KEY_INVALID' },
  };
};
