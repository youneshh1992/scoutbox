// The mapping from each ported TypeScript rule to the Gleam that plays its role, used by generate.mjs to write a
// gleeunit test for every recorded call. An entry is keyed `<module path>#<export>`, as report.json names functions,
// and has:
//
//   test(call, ctx)  the Gleam assertion for one recorded call: `call.args` (decoded), `call.result` (decoded, or
//                    undefined when it threw), `call.throws`, `call.argsAfter` (when the rule changed its arguments)
//   module           the Gleam module the test file is named after
//   now              true when the Gleam rule takes the clock as `now`: the call is then a case even when its result
//                    depends on the clock, and the test passes the instant the recording stood at (ctx.now)
//
// A function with no entry gets no test; the report lists it as pending.
import {
  bool,
  bytes,
  code,
  dict,
  int,
  list,
  option,
  record,
  ref,
  string,
  vocab,
} from './printers.mjs';

const CLAIMS = 'scoutbox/verification/claims';
const BASE = 'scoutbox/battery/base';

// ----------------------------------------------------------------------------------------- verification types

const status = vocab('scoutbox/rows/ver_claims', 'status_pairs');
const subjectKind = vocab('scoutbox/rows/ver_claims', 'subject_kind_pairs');
const claimType = vocab('scoutbox/vocab/claim_type');
const method = vocab('scoutbox/vocab/verification_method');
const actorKind = vocab('scoutbox/vocab/actor_kind');
const verLevel = vocab('scoutbox/vocab/ver_level');
const verCode = vocab('scoutbox/vocab/ver_code');
const evidenceType = vocab('scoutbox/rows/ver_evidence', 'type_pairs');
const mime = vocab('scoutbox/rows/ver_evidence', 'mime_pairs');

/** `{ kind, id }` → `<prefix>_kind`, `<prefix>_id`. */
const actor = (prefix) => (v, ctx) => [
  [`${prefix}_kind`, option(actorKind)(v?.kind, ctx)],
  [`${prefix}_id`, option(string)(v?.id, ctx)],
];

/** A claim record as the verification repository returns it, as its `ver_claims` row. Risk flags, review reasons and
 *  evidence ids live in their own tables, which no rule here reads. */
const claim = record({
  module: 'scoutbox/rows/ver_claims',
  constructor: 'Row',
  base: ref(BASE, 'claim'),
  fields: {
    id: ['id', string],
    subjectType: ['subject_kind', subjectKind],
    subjectId: ['subject_id', string],
    claimType: ['claim_type', claimType],
    organisationId: ['organisation_id', option(string)],
    role: ['role', option(string)],
    status: ['status', status],
    validFrom: ['valid_from', option(int)],
    validUntil: ['valid_until', option(int)],
    current: ['current', bool],
    verificationMethod: ['verification_method', option(method)],
    createdAt: ['created_at', int],
    updatedAt: ['updated_at', int],
    verifiedAt: ['verified_at', option(int)],
    verifiedBy: actor('verified_by'),
    revokedAt: ['revoked_at', option(int)],
    revokedBy: actor('revoked_by'),
    revocationReason: ['revocation_reason', option(string)],
    suspendedAt: ['suspended_at', option(int)],
    suspendReason: ['suspend_reason', option(string)],
    disputedAt: ['disputed_at', option(int)],
    expiredAt: ['expired_at', option(int)],
    metadata: (v, ctx) =>
      Object.entries(v ?? {}).map(([k, x]) => {
        const column = { licenceType: 'licence_type', workEmail: 'work_email' }[k];
        if (!column) throw new Error(`no ver_claims column for metadata.${k}`);
        return [column, option(string)(x, ctx)];
      }),
  },
  ignore: ['riskFlags', 'reviewReasons', 'evidenceIds'],
});

const org = record({
  module: 'scoutbox/rows/orgs',
  constructor: 'Row',
  base: ref(BASE, 'org'),
  fields: {
    id: ['id', string],
    name: ['name', string],
    verified: ['verified', bool],
    suspended: ['suspended', bool],
    verificationRevokedAt: ['verification_revoked_at', option(int)],
  },
});

const admin = record({
  module: 'scoutbox/rows/ver_admins',
  constructor: 'Row',
  base: ref(BASE, 'admin'),
  fields: {
    orgId: ['org_id', string],
    userId: ['user_id', string],
    level: ['level', verLevel],
    status: ['status', vocab('scoutbox/rows/ver_admins', 'status_pairs')],
  },
});

const by = record({
  module: CLAIMS,
  constructor: 'By',
  base: ref(CLAIMS, 'nobody'),
  fields: {
    actorKind: ['actor_kind', option(actorKind)],
    actorId: ['actor_id', option(string)],
    method: ['method', option(method)],
    reason: ['reason', option(string)],
  },
});

const risk = record({
  module: CLAIMS,
  constructor: 'Risk',
  base: ref(CLAIMS, 'no_risk'),
  fields: {
    email: ['email', option(string)],
    orgDomains: ['org_domains', list(string)],
    applicantHadRecentRevocation: ['applicant_had_recent_revocation', bool],
    duplicateEvidenceHash: ['duplicate_evidence_hash', bool],
    competingOrgClaims: ['competing_org_claims', int],
    orgSuspended: ['org_suspended', bool],
    conflictingActiveRoles: ['conflicting_active_roles', int],
    requestsLastDay: ['requests_last_day', int],
    actorIsSubject: ['actor_is_subject', bool],
    emailChallengeFails: ['email_challenge_fails', int],
    credentialReusedByOthers: ['credential_reused_by_others', bool],
  },
});

const reviewCase = record({
  module: CLAIMS,
  constructor: 'Case',
  base: ref(CLAIMS, 'plain_case'),
  fields: {
    claimType: ['claim_type', option(claimType)],
    orgHasActiveAuthority: ['org_has_active_authority', bool],
    isFirstOrgAdmin: ['is_first_org_admin', bool],
    duplicateOrg: ['duplicate_org', bool],
    conflictingEvidence: ['conflicting_evidence', bool],
    identityMismatch: ['identity_mismatch', bool],
    domainAmbiguous: ['domain_ambiguous', bool],
    registryResult: ['registry_result', option(code(CLAIMS, 'registry_answer_code'))],
    disputed: ['disputed', bool],
    highRiskAdminChange: ['high_risk_admin_change', bool],
    manualException: ['manual_exception', bool],
    riskFlagCount: ['risk_flag_count', int],
    documentOnly: ['document_only', bool],
  },
});

const review = record({
  module: CLAIMS,
  constructor: 'Review',
  fields: { decision: ['decision', code(CLAIMS, 'decision_code')], reasons: ['reasons', list(verCode)] },
});

const effective = record({
  module: CLAIMS,
  constructor: 'Effective',
  fields: {
    status: ['status', status],
    displayable: ['displayable', bool],
    current: ['current', bool],
    historical: ['historical', bool],
    reasons: ['reasons', list(code(CLAIMS, 'effective_reason_code'))],
  },
});

const file = record({
  module: CLAIMS,
  constructor: 'File',
  defaults: { buffer: 'None' },
  fields: {
    mime: ['mime', string],
    bytes: ['bytes', int],
    filename: ['filename', string],
    buffer: ['buffer', option(bytes)],
  },
});

const completeness = record({
  module: CLAIMS,
  constructor: 'Completeness',
  fields: { complete: ['complete', bool], missing: ['missing', list(evidenceType)] },
});

// -------------------------------------------------------------------------------------------------- helpers

const eq = (actual, expected) => `assert ${actual} == ${expected}`;

/** A rule called with positional arguments, compared as a value. */
const plain = (fnName, args, result) => ({
  module: CLAIMS,
  test: (c, ctx) =>
    eq(`${ctx.use(CLAIMS)}.${fnName}(${args.map((p, i) => p(c.args[i], ctx)).join(', ')})`, result(c.result, ctx)),
});

// -------------------------------------------------------------------------------------------------- the map

const SHARED = 'domains/verification/claims/shared.mjs';

export const MAP = {
  [`${SHARED}#canTransition`]: plain('can_transition', [status, status], bool),
  [`${SHARED}#applyTransition`]: {
    module: CLAIMS,
    now: true,
    test: (c, ctx) => {
      const [before, to, opts = {}] = c.args;
      const call = `${ctx.use(CLAIMS)}.transition(${claim(before, ctx)}, ${status(to, ctx)}, ${by(opts, ctx)}, ${ctx.now})`;
      if (c.result === null) {
        if (!c.argsAfter) throw new Error('applyTransition succeeded without changing its claim');
        return eq(call, `Ok(${claim(c.argsAfter[0], ctx)})`);
      }
      return eq(call, `Error(${code(CLAIMS, 'transition_error_code')(c.result, ctx)})`);
    },
  },
  [`${SHARED}#effectiveStatus`]: {
    module: CLAIMS,
    now: true,
    test: (c, ctx) => {
      const [subject, { org: o = null, subjectRemoved = false, now = ctx.now } = {}] = c.args;
      return eq(
        `${ctx.use(CLAIMS)}.effective_status(${claim(subject, ctx)}, org: ${option(org)(o, ctx)}, subject_removed: ${bool(subjectRemoved)}, now: ${int(now)})`,
        effective(c.result, ctx),
      );
    },
  },
  [`${SHARED}#decideReview`]: plain('decide_review', [reviewCase], review),
  [`${SHARED}#riskFlags`]: plain('risk_flags', [risk], list(verCode)),
  [`${SHARED}#emailProblem`]: plain('email_problem', [string], option(code(CLAIMS, 'email_problem_code'))),
  [`${SHARED}#normalizeDomain`]: plain('normalize_domain', [string], string),
  [`${SHARED}#domainOfEmail`]: plain('domain_of_email', [string], string),
  [`${SHARED}#isFreeMail`]: plain('is_free_mail', [string], bool),
  [`${SHARED}#isDisposable`]: plain('is_disposable', [string], bool),
  [`${SHARED}#domainCovered`]: plain('domain_covered', [string, string], bool),
  [`${SHARED}#evidenceFileProblem`]: plain('evidence_file_problem', [file], option(code(CLAIMS, 'file_problem_code'))),
  [`${SHARED}#sniffFileSignature`]: plain('sniff_file_signature', [bytes], option(mime)),
  [`${SHARED}#evidenceCompleteness`]: plain('evidence_completeness', [claimType, list(evidenceType)], completeness),
  [`${SHARED}#verLevelFor`]: plain('ver_level_for', [list(admin), string, string], option(verLevel)),
  [`${SHARED}#orgVerificationStatus`]: {
    module: CLAIMS,
    test: (c, ctx) =>
      eq(
        `${ctx.use(CLAIMS)}.org_verification_status(${option(org)(c.args[0], ctx)}, ${bool(c.args[1] ?? false)})`,
        code(CLAIMS, 'org_status_code')(c.result, ctx),
      ),
  },
  [`${SHARED}#assuranceForClaim`]: plain('assurance_for_claim', [claim], option(code(CLAIMS, 'assurance_code'))),
  [`${SHARED}#claimProvenanceLabel`]: plain('claim_provenance_label', [claim, option(string)], string),
  [`${SHARED}#toPublicVerificationProfile`]: {
    module: CLAIMS,
    now: true,
    test: (c, ctx) => {
      const { subjectType, subjectId, claims, orgsById = { $map: [] }, subjectRemoved = false, now = ctx.now } = c.args[0];
      const call = `${ctx.use(CLAIMS)}.public_profile(subject_kind: ${subjectKind(subjectType, ctx)}, subject_id: ${string(subjectId)}, claims: ${list(claim)(claims, ctx)}, orgs: ${dict(string, org)(orgsById, ctx)}, subject_removed: ${bool(subjectRemoved)}, now: ${int(now)})`;
      return eq(`${ctx.use('gleam/json')}.to_string(${call})`, string(JSON.stringify(c.result)));
    },
  },
};

/**
 * The calls the recorder can't keep (report.json's `handPort`), by function: the Gleam test file that ports the
 * suite's checks of it by hand. dev/ledger.mjs counts a function's hand-port calls as done once it is listed here.
 */
export const HAND_PORTED = {
  [`${SHARED}#arrayTokenStore`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#mintToken`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#peekToken`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#consumeToken`]: 'test/scoutbox/verification/tokens_test.gleam',
};
