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
  call,
  code,
  dict,
  ident,
  int,
  jsonValue,
  list,
  numberText,
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
  base: call(BASE, 'claim'),
  fields: {
    id: ['id', ident('claim')],
    subjectType: ['subject_kind', subjectKind],
    subjectId: ['subject_id', string],
    claimType: ['claim_type', claimType],
    organisationId: ['organisation_id', option(ident('org'))],
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
  base: call(BASE, 'org'),
  fields: {
    id: ['id', ident('org')],
    name: ['name', string],
    verified: ['verified', bool],
    suspended: ['suspended', bool],
    verificationRevokedAt: ['verification_revoked_at', option(int)],
  },
});

const admin = record({
  module: 'scoutbox/rows/ver_admins',
  constructor: 'Row',
  base: call(BASE, 'admin'),
  fields: {
    orgId: ['org_id', ident('org')],
    userId: ['user_id', ident('org_user')],
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


// ----------------------------------------------------------------------------------------------- room types

const ROOMS = 'scoutbox/recruitment/room_rules';
const roomStatus = vocab('scoutbox/vocab/room_status');
const level = vocab('scoutbox/rows/orgs', 'level_pairs');
const stage = vocab('scoutbox/rows/recruitment_cases', 'stage_pairs');
const roomPriority = vocab('scoutbox/rows/recruitment_cases', 'room_priority_pairs');
const recommendation = vocab('scoutbox/rows/room_decisions', 'recommendation_pairs');
const taskState = vocab('scoutbox/vocab/task_state');
const sourceContext = vocab('scoutbox/vocab/source_context');
const byKind = vocab('scoutbox/rows/case_history', 'by_kind_pairs');
const role = code(ROOMS, 'role_code');
const roomAction = code(ROOMS, 'action_code');
const health = code(ROOMS, 'health_code');


const readinessInput = record({
  module: ROOMS,
  constructor: 'ReadinessInput',
  base: ref(ROOMS, 'no_readiness'),
  fields: {
    assessmentsAssigned: ['assessments_assigned', int],
    assessmentsSubmitted: ['assessments_submitted', int],
    recentFullMatch: ['recent_full_match', bool],
    coachReference: ['coach_reference', bool],
    combineVerified: ['combine_verified', int],
    combineRequested: ['combine_requested', int],
    trialState: ['trial_state', code(ROOMS, 'trial_state_code')],
    openTasks: ['open_tasks', int],
    openEvidenceRequests: ['open_evidence_requests', int],
  },
});

const item = record({
  module: ROOMS,
  constructor: 'Item',
  fields: {
    key: ['key', code(ROOMS, 'item_key_code')],
    label: ['label', string],
    value: ['value', string],
    complete: ['complete', bool],
    outstanding: ['outstanding', option(string)],
  },
});

/** A readiness as decisionReadiness returns it. Its counts and blockers are derived from its items in Gleam, so
 *  a recorded readiness whose blockers disagree with its items can't be held. */
const readiness = (v, ctx) => {
  const blockers = (v.items ?? []).filter((i) => i.outstanding).map((i) => ({ key: i.key, text: i.outstanding }));
  if (JSON.stringify(v.blockers ?? blockers) !== JSON.stringify(blockers))
    throw new Error('Readiness has no field for blockers that disagree with its items');
  return record({
    module: ROOMS,
    constructor: 'Readiness',
    fields: { items: ['items', list(item)], openEvidenceRequests: ['open_evidence_requests', int] },
    ignore: ['complete', 'total', 'blockers', 'note'],
  })(v, ctx);
};

/** The parts of a room its roles are decided from. */
const membership = (v, ctx) =>
  `${ctx.use(ROOMS)}.Membership(owner: ${ident('org_user')(v.ownerUserId, ctx)}, lead_scout: ${option(ident('org_user'))(v.room?.leadScoutUserId, ctx)}, assignees: ${list(ident('org_user'))((v.assignments ?? []).map((a) => a.userId), ctx)}, restricted: ${bool(!!v.restricted)}, status: ${roomStatus(v.room?.status, ctx)})`;

const event = record({
  module: ROOMS,
  constructor: 'Event',
  defaults: { by_kind: 'None', by_id: 'None', by_name: 'None', detail: 'None' },
  fields: {
    id: ['id', string],
    at: ['at', int],
    action: ['action', string],
    byKind: ['by_kind', option(byKind)],
    byId: ['by_id', option(string)],
    byName: ['by_name', option(string)],
    detail: ['detail', option(jsonValue)],
  },
});

const summaryRoom = record({
  module: ROOMS,
  constructor: 'SummaryRoom',
  defaults: { player_name: 'None', owner_name: 'None', lead_scout_user_id: 'None', tags: '[]' },
  fields: {
    id: ['room_id', ident('recruitment_case')],
    playerId: ['player_id', ident('player')],
    playerName: ['player_name', option(string)],
    stage: ['stage', stage],
    ownerUserId: ['owner_user_id', ident('org_user')],
    ownerName: ['owner_name', option(string)],
    createdAt: ['created_at', int],
    room: (v, ctx) => {
      const known = ['status', 'priority', 'tags', 'leadScoutUserId', 'updatedAt'];
      for (const k of Object.keys(v ?? {}))
        if (!known.includes(k)) throw new Error(`SummaryRoom has no field for the JavaScript key room.${k}`);
      return [
        ['status', roomStatus(v.status, ctx)],
        ['priority', roomPriority(v.priority, ctx)],
        ['tags', list(string)(v.tags ?? [], ctx)],
        ['lead_scout_user_id', option(ident('org_user'))(v.leadScoutUserId, ctx)],
        ['updated_at', int(v.updatedAt)],
      ];
    },
  },
});

const summaryPlayer = record({
  module: ROOMS,
  constructor: 'SummaryPlayer',
  defaults: { position: 'None', age: 'None', current_club: 'None' },
  fields: {
    position: ['position', option(string)],
    age: ['age', option(int)],
    currentClub: ['current_club', option(string)],
  },
});

const summaryTrust = record({
  module: ROOMS,
  constructor: 'SummaryTrust',
  fields: { score: ['score', int], band: ['band', string], bandLabel: ['band_label', string] },
});

// -------------------------------------------------------------------------------------------------- helpers

const eq = (actual, expected) => `assert ${actual} == ${expected}`;

/** A rule of `module` called with positional arguments, compared as a value. */
const plainIn = (module) => (fnName, args, result) => ({
  module,
  test: (c, ctx) =>
    eq(`${ctx.use(module)}.${fnName}(${args.map((p, i) => p(c.args[i], ctx)).join(', ')})`, result(c.result, ctx)),
});
const plain = plainIn(CLAIMS);

/** `expression` encodes to exactly the JSON the TypeScript rule returned. */
const eqJson = (expression, result, ctx) =>
  eq(`${ctx.use('gleam/json')}.to_string(${expression})`, string(JSON.stringify(result)));

// -------------------------------------------------------------------------------------------------- the map

const SHARED = 'domains/verification/claims/shared.mjs';


const ROOM_RULES = 'domains/recruitment/rooms/shared.mjs';
const room = plainIn(ROOMS);

const ROOM_MAP = {
  [`${ROOM_RULES}#stageForRoomStatus`]: room('stage_for_room_status', [roomStatus, level], stage),
  [`${ROOM_RULES}#roomStatusForStage`]: room('room_status_for_stage', [stage, level], option(roomStatus)),
  [`${ROOM_RULES}#canTransition`]: room('can_transition', [roomStatus, roomStatus], bool),
  [`${ROOM_RULES}#validateTransition`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const [from, to, { reasonCodes = [] } = {}] = c.args;
      return eqJson(
        `${ctx.use(ROOMS)}.transition_json(${ctx.use(ROOMS)}.validate_transition(${roomStatus(from, ctx)}, ${roomStatus(to, ctx)}, ${list(string)(reasonCodes, ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${ROOM_RULES}#validateReasonCodes`]: {
    module: ROOMS,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ROOMS)}.reasons_json(${ctx.use(ROOMS)}.validate_reason_codes(${list(string)(c.args[0], ctx)}))`,
        c.result,
        ctx,
      ),
  },
  [`${ROOM_RULES}#validateDecision`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const { recommendation: r, reasonCodes = [], note = null, ...rest } = c.args[0] ?? {};
      if (Object.keys(rest).length) throw new Error(`validate_decision has no argument for ${Object.keys(rest)}`);
      return eqJson(
        `${ctx.use(ROOMS)}.decision_json(${ctx.use(ROOMS)}.validate_decision(${recommendation(r, ctx)}, ${list(string)(reasonCodes, ctx)}, ${option(string)(note, ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${ROOM_RULES}#decisionReadiness`]: {
    module: ROOMS,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ROOMS)}.readiness_json(${ctx.use(ROOMS)}.decision_readiness(${readinessInput(c.args[0] ?? {}, ctx)}))`,
        c.result,
        ctx,
      ),
  },
  [`${ROOM_RULES}#roomHealth`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const { readiness: r = null, hasCurrentDecision = false, status = 'watching' } = c.args[0] ?? {};
      return eq(
        `${ctx.use(ROOMS)}.room_health(${option(readiness)(r, ctx)}, ${bool(hasCurrentDecision)}, ${roomStatus(status, ctx)})`,
        health(c.result, ctx),
      );
    },
  },
  [`${ROOM_RULES}#roomRole`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const { room: r, user, isLead } = c.args[0];
      return eq(
        `${ctx.use(ROOMS)}.room_role(${membership(r, ctx)}, ${ident('org_user')(user.id, ctx)}, ${bool(!!isLead)})`,
        option(role)(c.result, ctx),
      );
    },
  },
  [`${ROOM_RULES}#roomCan`]: room('room_can', [option(role), roomAction], bool),
  [`${ROOM_RULES}#canTaskTransition`]: room('can_task_transition', [taskState, taskState], bool),
  [`${ROOM_RULES}#roomActivity`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const [history = [], { limit = 50, cursor = null } = {}] = c.args;
      return eqJson(
        `${ctx.use(ROOMS)}.activity_json(${ctx.use(ROOMS)}.room_activity(${list(event)(history, ctx)}, ${int(limit)}, ${option(string)(cursor, ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${ROOM_RULES}#roomFunnel`]: {
    module: ROOMS,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ROOMS)}.room_funnel(${list(roomStatus)((c.args[0] ?? []).map((r) => r.room?.status), ctx)})`,
        c.result,
        ctx,
      ),
  },
  [`${ROOM_RULES}#roomSummary`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const [r, { player = null, trust = null, openTasks = 0, health: h = null, lastActivityAt = null, visible = true } = {}] =
        c.args;
      return eqJson(
        `${ctx.use(ROOMS)}.room_summary(${summaryRoom(r, ctx)}, player: ${option(summaryPlayer)(player, ctx)}, trust: ${option(summaryTrust)(trust, ctx)}, open_tasks: ${int(openTasks)}, health: ${option(health)(h, ctx)}, last_activity_at: ${option(int)(lastActivityAt, ctx)}, visible: ${bool(visible)})`,
        c.result,
        ctx,
      );
    },
  },
  [`${ROOM_RULES}#validateTag`]: {
    module: ROOMS,
    test: (c, ctx) =>
      eqJson(`${ctx.use(ROOMS)}.tag_json(${ctx.use(ROOMS)}.validate_tag(${string(c.args[0])}))`, c.result, ctx),
  },
  [`${ROOM_RULES}#clampPage`]: room('clamp_page', [option(numberText)], int),
  [`${ROOM_RULES}#normaliseSourceContext`]: room('normalise_source_context', [string], sourceContext),
};

export const MAP = {
  ...ROOM_MAP,
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
  [`${SHARED}#verLevelFor`]: plain('ver_level_for', [list(admin), ident('org'), ident('org_user')], option(verLevel)),
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
      const call = `${ctx.use(CLAIMS)}.public_profile(subject_kind: ${subjectKind(subjectType, ctx)}, subject_id: ${string(subjectId)}, claims: ${list(claim)(claims, ctx)}, orgs: ${dict(ident('org'), org)(orgsById, ctx)}, subject_removed: ${bool(subjectRemoved)}, now: ${int(now)})`;
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
