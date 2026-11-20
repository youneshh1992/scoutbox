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
import { readFileSync } from 'node:fs';
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
  [`${ROOM_RULES}#secondLookEvent`]: {
    module: ROOMS,
    test: (c, ctx) => {
      const [r, d] = c.args;
      const known = ['id', 'orgId', 'playerId', 'room'];
      for (const k of Object.keys(r)) if (!known.includes(k)) throw new Error(`secondLookEvent has no argument for room.${k}`);
      const decision = d
        ? `Some(${ctx.use(ROOMS)}.SecondLookDecision(reason_codes: ${list(string)(d.reasonCodes ?? [], ctx)}, created_at: ${int(d.createdAt ?? r.room.updatedAt)}, source_refs: ${option(jsonValue)(d.snapshot?.sourceRefs ?? null, ctx)}))`
        : 'None';
      return eqJson(
        `${ctx.use(ROOMS)}.second_look_event(${ident('recruitment_case')(r.id, ctx)}, ${ident('org')(r.orgId, ctx)}, ${ident('player')(r.playerId, ctx)}, ${roomStatus(r.room.status, ctx)}, ${int(r.room.updatedAt)}, ${decision})`,
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

// ------------------------------------------------------------------------------------------ recruitment analytics

const ANALYTICS = 'domains/recruitment/analytics';
const METRICS = 'scoutbox/recruitment/analytics/metrics';
const ACONTEXT = 'scoutbox/recruitment/analytics/context';
const SERIES = 'scoutbox/recruitment/analytics/time_series';

/** A JavaScript number where the Gleam type is a Float. */
const failFloat = (v) => {
  throw new Error(`expected a Float, got ${JSON.stringify(v)}`);
};
const float = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) ? `${v}.0` : String(v)) : failFloat(v);

/** A window. The rules read only its bounds, so a window given as bounds alone is a custom one of no stated length. */
const window_ = record({
  module: METRICS,
  constructor: 'Window',
  fields: { preset: ['preset', string], from: ['from', string], to: ['to', string], days: ['days', int] },
  defaults: { preset: '"custom"', days: '0' },
});

/** A history entry as analytics projects it: the detail keeps only `from`, `to` and `status`. */
const entry = (v, ctx) => {
  const d = v.detail && typeof v.detail === 'object' ? v.detail : {};
  return `${ctx.use(ACONTEXT)}.Entry(at: ${int(v.at)}, action: ${string(v.action)}, from: ${option(string)(d.from, ctx)}, to: ${option(string)(d.to, ctx)}, status: ${option(string)(d.status, ctx)})`;
};

/** A projected room; its transitions are derived from its history, as projectRoom does. */
const aroom = (v, ctx) => {
  const known = ['id', 'playerId', 'createdAt', 'status', 'priority', 'sourceContext', 'history', 'transitions'];
  for (const k of Object.keys(v)) if (!known.includes(k)) throw new Error(`a projected room has no field for ${k}`);
  return `${ctx.use(ACONTEXT)}.room(id: ${ident('recruitment_case')(v.id, ctx)}, player_id: ${ident('player')(v.playerId, ctx)}, created_at: ${int(v.createdAt)}, status: ${string(v.status)}, priority: ${string(v.priority)}, source_context: ${string(v.sourceContext ?? 'direct')}, history: ${list(entry)(v.history ?? [], ctx)})`;
};

const transition = record({
  module: ACONTEXT,
  constructor: 'Transition',
  fields: { at: ['at', int], from: ['from', option(string)], to: ['to', string], reopen: ['reopen', bool] },
});

const visit = record({
  module: SERIES,
  constructor: 'Visit',
  fields: { status: ['status', string], from: ['from', int], to: ['to', int], ms: ['ms', int] },
});

const ANALYTICS_MAP = {
  [`${ANALYTICS}/metrics.mjs#ratio`]: {
    module: METRICS,
    test: (c, ctx) =>
      eqJson(`${ctx.use(METRICS)}.ratio_json(${ctx.use(METRICS)}.ratio(${int(c.args[0])}, ${int(c.args[1])}))`, c.result, ctx),
  },
  [`${ANALYTICS}/metrics.mjs#distribution`]: {
    module: METRICS,
    test: (c, ctx) => {
      const [values, { excluded = 0, ...rest } = {}] = c.args;
      if (Object.keys(rest).length) throw new Error(`distribution has no argument for ${Object.keys(rest)}`);
      return eqJson(
        `${ctx.use(METRICS)}.distribution_json(${ctx.use(METRICS)}.distribution(${list(float)(values, ctx)}, ${int(excluded)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${ANALYTICS}/metrics.mjs#count`]: {
    module: METRICS,
    test: (c, ctx) => eqJson(`${ctx.use(METRICS)}.count_json(${int(c.args[0])})`, c.result, ctx),
  },
  [`${ANALYTICS}/metrics.mjs#compare`]: {
    module: METRICS,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(METRICS)}.comparison_json(${ctx.use(METRICS)}.compare(${int(c.args[0])}, ${int(c.args[1])}))`,
        c.result,
        ctx,
      ),
  },
  [`${ANALYTICS}/metrics.mjs#resolveWindow`]: {
    module: METRICS,
    test: (c, ctx) => {
      const [{ preset, from, to, ...rest } = {}, now] = c.args;
      if (Object.keys(rest).length) throw new Error(`resolveWindow has no argument for ${Object.keys(rest)}`);
      return eqJson(
        `${ctx.use(METRICS)}.resolution_json(${ctx.use(METRICS)}.resolve_window(${option(string)(preset, ctx)}, ${option(string)(from, ctx)}, ${option(string)(to, ctx)}, ${int(now)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${ANALYTICS}/metrics.mjs#utcDay`]: {
    module: METRICS,
    test: (c, ctx) => eq(`${ctx.use(METRICS)}.utc_day(${int(c.args[0])})`, string(c.result)),
  },
  [`${ANALYTICS}/metrics.mjs#inWindow`]: {
    module: METRICS,
    test: (c, ctx) => eq(`${ctx.use(METRICS)}.in_window(${int(c.args[0])}, ${window_(c.args[1], ctx)})`, bool(c.result)),
  },
  [`${ANALYTICS}/metrics.mjs#previousWindow`]: {
    module: METRICS,
    test: (c, ctx) =>
      eqJson(`${ctx.use(METRICS)}.window_json(${ctx.use(METRICS)}.previous_window(${window_(c.args[0], ctx)}))`, c.result, ctx),
  },
  [`${ANALYTICS}/metrics.mjs#cohortIncomplete`]: {
    module: METRICS,
    test: (c, ctx) =>
      eq(
        `${ctx.use(METRICS)}.cohort_incomplete(${window_(c.args[0], ctx)}, ${option(float)(c.args[1], ctx)}, ${int(c.args[2])})`,
        bool(c.result),
      ),
  },
  [`${ANALYTICS}/metrics.mjs#wire`]: {
    module: METRICS,
    test: (c, ctx) => eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(METRICS)}.wire(${string(c.args[0].id)}))`, c.result, ctx),
  },
  [`${ANALYTICS}/metrics.mjs#assertMetricRegistry`]: {
    module: METRICS,
    test: (c, ctx) => {
      if (c.result === undefined) throw new Error('assertMetricRegistry threw');
      const m = ctx.use(METRICS);
      return eq(
        `#(${ctx.use('gleam/list')}.length(${m}.metrics), ${ctx.use('gleam/list')}.length(${m}.families), ${m}.registry_problems(${m}.metrics))`,
        `#(${int(c.result.metrics)}, ${int(c.result.families)}, [])`,
      );
    },
  },
  [`${ANALYTICS}/funnels.mjs#transitions`]: {
    module: ACONTEXT,
    test: (c, ctx) =>
      eq(`${ctx.use(ACONTEXT)}.transitions(${list(entry)(c.args[0].history ?? [], ctx)})`, list(transition)(c.result, ctx)),
  },
  [`${ANALYTICS}/funnels.mjs#openedStatus`]: {
    module: ACONTEXT,
    test: (c, ctx) => eq(`${ctx.use(ACONTEXT)}.opened_status(${aroom(c.args[0], ctx)})`, option(string)(c.result, ctx)),
  },
  [`${ANALYTICS}/funnels.mjs#firstReachedAt`]: {
    module: ACONTEXT,
    test: (c, ctx) =>
      eq(`${ctx.use(ACONTEXT)}.first_reached_at(${aroom(c.args[0], ctx)}, ${string(c.args[1])})`, option(int)(c.result, ctx)),
  },
  [`${ANALYTICS}/funnels.mjs#firstTerminalAt`]: {
    module: ACONTEXT,
    test: (c, ctx) => eq(`${ctx.use(ACONTEXT)}.first_terminal_at(${aroom(c.args[0], ctx)})`, option(int)(c.result, ctx)),
  },
  [`${ANALYTICS}/timeSeries.mjs#stageVisits`]: {
    module: SERIES,
    test: (c, ctx) => eq(`${ctx.use(SERIES)}.stage_visits(${aroom(c.args[0], ctx)})`, list(visit)(c.result, ctx)),
  },
  [`${ANALYTICS}/timeSeries.mjs#lastActivityAt`]: {
    module: SERIES,
    test: (c, ctx) => eq(`${ctx.use(SERIES)}.last_activity_at(${aroom(c.args[0], ctx)})`, int(c.result)),
  },
};

// ------------------------------------------------------------------------------------------------- discovery

const DISCOVERY = 'domains/discovery/shared.mjs';
const SL = 'scoutbox/discovery/second_look_rules';
const BR = 'scoutbox/discovery/briefs';
const NM = 'scoutbox/discovery/nobody_missed';
const changeType = vocab(SL, 'change_type_pairs');
const itemStatus = vocab('scoutbox/rows/second_look_items', 'status_pairs');
const triggerType = vocab('scoutbox/rows/second_look_items', 'trigger_type_pairs');
const briefStatus = vocab('scoutbox/vocab/brief_status');
const playingLevel = vocab('scoutbox/vocab/playing_level');
const position_ = vocab('scoutbox/vocab/position');
const band = vocab('scoutbox/vocab/trust_band');
const briefFoot = vocab('scoutbox/rows/recruitment_briefs', 'foot_pairs');

/** A material change, as the Gleam rules carry it: its subject, copy and payload are not part of it. */
const change = record({
  module: SL,
  constructor: 'Change',
  fields: {
    type: ['kind', changeType],
    sourceSystem: ['source_system', string],
    sourceId: ['source_id', option(string)],
    occurredAt: ['occurred_at', int],
    fingerprint: ['fingerprint', string],
  },
  ignore: ['subjectId', 'negative', 'text', 'detail', 'relatesTo'],
  // A forged change can leave out its source; the rules never read it before discarding the change.
  defaults: { source_id: 'None', source_system: '""' },
});
/** The fields of a recorded change that `change_json` writes, in its order. */
const changeView = (c) =>
  c && {
    type: c.type,
    sourceSystem: c.sourceSystem,
    sourceId: c.sourceId ?? null,
    occurredAt: c.occurredAt,
    negative: c.negative,
    text: c.text,
    fingerprint: c.fingerprint,
  };
/** The fields of a recorded candidate that `candidate_json` writes, in its order. */
const candidateView = (c) =>
  c && {
    decisionAt: c.decisionAt,
    archivedStatus: c.archivedStatus,
    archiveReasonCodes: c.archiveReasonCodes,
    kind: c.kind,
    kindLabel: c.kindLabel,
    strength: c.strength,
    changes: c.changes.map((x) => ({ fingerprint: x.fingerprint, relatesTo: x.relatesTo })),
    changeCount: c.changeCount,
    directReasonCodes: c.directReasonCodes,
    unresolvedReasonCodes: c.unresolvedReasonCodes,
    changeFingerprints: c.changeFingerprints,
    latestChangeAt: c.latestChangeAt,
    summary: c.summary,
  };
/** `expression` is an `Option(Json)` that encodes to the TypeScript result, or None where it was null. */
const eqOptionJson = (expression, result, ctx) =>
  eq(
    `${ctx.use('gleam/option')}.map(${expression}, ${ctx.use('gleam/json')}.to_string)`,
    result === null || result === undefined ? 'None' : `Some(${string(JSON.stringify(result))})`,
  );
const trustPair = (t) => (t ? `Some(#(${float(t.score)}, ${string(t.band)}))` : 'None');
/** A brief's criteria as stored; `positionGroups` is derived from the positions. */
const criteria = record({
  module: BR,
  constructor: 'Criteria',
  fields: {
    positions: ['positions', list(position_)],
    minAge: ['min_age', option(int)],
    maxAge: ['max_age', option(int)],
    radiusKm: ['radius_km', option(float)],
    maxLevel: ['max_level', option(playingLevel)],
    foot: ['foot', option(briefFoot)],
    availability: ['availability', option(string)],
    evidenceRequirements: ['evidence_requirements', list(string)],
    minTrustBand: ['min_trust_band', option(band)],
    combineProtocols: ['combine_protocols', list(string)],
  },
  ignore: ['positionGroups'],
  defaults: {
    positions: '[]',
    min_age: 'None',
    max_age: 'None',
    radius_km: 'None',
    max_level: 'None',
    foot: 'None',
    availability: 'None',
    evidence_requirements: '[]',
    min_trust_band: 'None',
    combine_protocols: '[]',
  },
});
const ENGINE = 'scoutbox/discovery/matching/engine';
const CRIT = 'scoutbox/discovery/matching/criteria';
const WLR = 'scoutbox/discovery/matching/watchlist_rules';
/** A candidate's facts; the evidence flags are the keys the record meets. */
const facts = record({
  module: ENGINE,
  constructor: 'Facts',
  fields: {
    playerId: ['player_id', ident('player')],
    name: ['name', string],
    age: ['age', option(int)],
    position: ['position', option(string)],
    secondaryPositions: ['secondary', list(string)],
    level: ['level', option(playingLevel)],
    foot: ['foot', option(string)],
    availability: ['availability', option(string)],
    distanceKm: ['distance_km', option(float)],
    trustBand: ['trust_band', option(band)],
    combineProtocols: ['combine', list(string)],
    evidenceFlags: (v) => [['evidence', list(string)(Object.keys(v).filter((k) => v[k]))]],
    lastEvidenceAt: ['last_evidence_at', option(int)],
    lastFootageAt: ['last_footage_at', option(int)],
    combineMeasurements: (v, ctx) => [
      ['combine_measurements', `[${Object.entries(v).map(([k, x]) => `#(${string(k)}, ${float(x)})`).join(', ')}]`],
    ],
  },
  defaults: {
    last_evidence_at: 'None',
    last_footage_at: 'None',
    secondary: '[]',
    combine: '[]',
    combine_measurements: '[]',
    evidence: '[]',
  },
});
const watchStatus = vocab('scoutbox/rows/dynamic_watchlists', 'status_pairs');
const transitionV = vocab('scoutbox/rows/watchlist_membership_events', 'transition_pairs');
const reasonV = vocab('scoutbox/rows/watchlist_membership_events', 'reason_pairs');
/** A validated criterion's test, from its type, operator and body. */
const testOf = (c, ctx) => {
  const C = ctx.use(CRIT);
  const op = `${c.type}:${c.operator}`;
  const bound = (gte) => `${C}.${gte ? 'AtLeastValue' : 'AtMostValue'}`;
  switch (op) {
    case 'position:in':
      return `${C}.PositionIn(${list(string)(c.values, ctx)}, ${bool(c.primaryOnly === true)})`;
    case 'age:between':
      return `${C}.Age(${C}.Between(${int(c.values[0])}, ${int(c.values[1])}))`;
    case 'age:gte':
      return `${C}.Age(${C}.AtLeast(${int(c.value)}))`;
    case 'age:lte':
      return `${C}.Age(${C}.AtMost(${int(c.value)}))`;
    case 'geography:within_radius':
      return `${C}.WithinRadius(${float(c.value)})`;
    case 'level:lte':
      return `${C}.LevelAtMost(${playingLevel(c.value, ctx)})`;
    case 'level:in':
      return `${C}.LevelIn(${list(playingLevel)(c.values, ctx)})`;
    case 'foot:in':
      return `${C}.FootIn(${list(string)(c.values, ctx)})`;
    case 'availability:equals':
      return `${C}.AvailabilityIs(${string(c.value)})`;
    case 'evidence:exists':
      return `${C}.EvidenceExists(${string(c.value)})`;
    case 'evidence_recency:within_days':
      return `${C}.EvidenceWithin(${int(c.value)}, ${C}.${c.evidenceKind === 'any' ? 'AnyEvidence' : 'Footage'})`;
    case 'trust_band:gte':
      return `${C}.TrustBandAtLeast(${band(c.value, ctx)})`;
    case 'combine_result:exists':
      return `${C}.CombineResult(${string(c.value)})`;
    case 'combine_measurement:gte':
    case 'combine_measurement:lte':
      return `${C}.CombineMeasurement(${string(c.protocol)}, ${bound(c.operator === 'gte')}, ${float(c.value)})`;
    default:
      throw new Error(`no criterion ${op}`);
  }
};
const CLASSES = { required: 'Required', preferred: 'Preferred' };
/** A validated criterion, with the id it was recorded with. */
const criterion = (c, ctx) => {
  if (!CLASSES[c.class]) throw new Error(`a criterion of class ${c.class}`);
  return `${ctx.use(CRIT)}.Criterion(id: ${string(c.id)}, class: ${ctx.use(CRIT)}.${CLASSES[c.class]}, check: ${testOf(c, ctx)})`;
};
/** A validated criteria set; its schema version is a constant. */
const criteriaSet = (v, ctx) =>
  `${ctx.use(CRIT)}.Criteria(required: ${list(criterion)(v?.required ?? [], ctx)}, preferred: ${list(criterion)(v?.preferred ?? [], ctx)})`;
/** A criterion as the editor writes it. */
const scalar = (v, ctx) => {
  if (typeof v === 'string') return `${ctx.use(CRIT)}.Text(${string(v)})`;
  if (typeof v === 'number' && Number.isFinite(v)) return `${ctx.use(CRIT)}.Number(${float(v)})`;
  throw new Error(`a criterion value ${JSON.stringify(v)}`);
};
const rawCriterion = record({
  module: CRIT,
  constructor: 'Raw',
  fields: {
    type: ['type_', option(string)],
    operator: ['operator', option(string)],
    value: ['value', option(scalar)],
    values: ['values', option(list(scalar))],
    primaryOnly: ['primary_only', option(bool)],
    evidenceKind: ['evidence_kind', option(string)],
    protocol: ['protocol', option(string)],
  },
  defaults: {
    type_: 'None',
    operator: 'None',
    value: 'None',
    values: 'None',
    primary_only: 'None',
    evidence_kind: 'None',
    protocol: 'None',
  },
});
const rawList = (v, ctx) => (Array.isArray(v) ? list(rawCriterion)(v, ctx) : '[]');
/** One required outcome a watchlist remembers. */
const met = record({
  module: WLR,
  constructor: 'Met',
  fields: { criterionId: ['criterion_id', string], met: ['met', bool], text: ['text', string] },
  ignore: ['type', 'key'],
  defaults: { text: '""' },
});
const matchOf = (m, ctx) => (m ? `Some(${list(met)(m.required ?? [], ctx)})` : 'None');
const nowOf = (opts, ctx) => int(opts?.now ?? ctx.now);
/** A brief's input fields as `briefs.Fields` reads them; any other key (a prohibited one) is only a key. */
const briefFields = (input, ctx) => {
  const f = (k, p) => option(p)(input[k], ctx);
  return `${ctx.use(BR)}.Fields(title: ${f('title', string)}, positions: ${f('positions', list(string))}, min_age: ${f('minAge', float)}, max_age: ${f('maxAge', float)}, radius_km: ${f('radiusKm', float)}, max_level: ${f('maxLevel', string)}, foot: ${f('foot', string)}, availability: ${f('availability', string)}, evidence_requirements: ${f('evidenceRequirements', list(string))}, min_trust_band: ${f('minTrustBand', string)}, combine_protocols: ${f('combineProtocols', list(string))}, active_from: ${f('activeFrom', string)}, active_until: ${f('activeUntil', string)})`;
};
const levelsOf = (components) =>
  Object.entries(components)
    .map(([k, v]) => [k, typeof v === 'string' ? v : (v?.level?.id ?? v?.id ?? null)])
    .filter(([, v]) => typeof v === 'string');

/** A brief as `briefIsLiveOn` reads it: its status and its window. A brief that isn't there never reaches the rule. */
const briefRow = (v, ctx) => {
  if (v === null || v === undefined) throw new Error('a brief that is not there is a 404 before its liveness is read');
  return record({
    module: 'scoutbox/rows/recruitment_briefs',
    constructor: 'Row',
    base: call(BASE, 'brief'),
    fields: {
      status: ['status', briefStatus],
      activeFrom: ['active_from_date', option(string)],
      activeUntil: ['active_until_date', option(string)],
    },
  })(v, ctx);
};

const DISCOVERY_MAP = {
  // Today, when the suite gives none, is the UTC calendar day of the instant the recording stood at.
  [`${DISCOVERY}#briefIsLiveOn`]: {
    module: BR,
    now: true,
    test: (c, ctx) =>
      eq(
        `${ctx.use(BR)}.is_live_on(${briefRow(c.args[0], ctx)}, ${string(c.args[1] ?? new Date(ctx.now).toISOString().slice(0, 10))})`,
        bool(c.result),
      ),
  },
  [`${DISCOVERY}#normalizeMaterialChange`]: {
    module: SL,
    test: (c, ctx) => {
      const x = c.args[0];
      return eqOptionJson(
        `${ctx.use('gleam/option')}.map(${ctx.use(SL)}.normalize(${string(x.type)}, ${string(x.sourceSystem)}, ${option(string)(x.sourceId, ctx)}, ${option(int)(x.occurredAt, ctx)}), ${ctx.use(SL)}.change_json)`,
        changeView(c.result),
        ctx,
      );
    },
  },
  [`${DISCOVERY}#secondLookReasonMatch`]: {
    module: SL,
    test: (c, ctx) =>
      eq(`${ctx.use(SL)}.reason_match(${change(c.args[0], ctx)}, ${list(string)(c.args[1] ?? [], ctx)})`, list(string)(c.result, ctx)),
  },
  [`${DISCOVERY}#changeFingerprint`]: {
    module: SL,
    test: (c, ctx) => {
      const x = c.args[0];
      return eq(`${ctx.use(SL)}.fingerprint_text(${string(x.type)}, ${string(x.sourceSystem)}, ${option(string)(x.sourceId, ctx)})`, string(c.result));
    },
  },
  [`${DISCOVERY}#dedupeMaterialChanges`]: {
    module: SL,
    test: (c, ctx) => eq(`${ctx.use(SL)}.dedupe(${list(change)(c.args[0], ctx)})`, list(change)(c.result, ctx)),
  },
  [`${DISCOVERY}#changesSinceDecision`]: {
    module: SL,
    now: true,
    test: (c, ctx) =>
      eq(`${ctx.use(SL)}.since(${list(change)(c.args[0], ctx)}, ${int(c.args[1])}, ${ctx.now})`, list(change)(c.result, ctx)),
  },
  [`${DISCOVERY}#buildSecondLookCandidate`]: {
    module: SL,
    now: true,
    test: (c, ctx) => {
      const { room, decision, changes = [], playerVisible = true, now = ctx.now } = c.args[0];
      const id = ctx.use('scoutbox/rows/id');
      const decided = `${ctx.use(SL)}.Decided(id: ${id}.room_decision(${string(decision.id)}), at: ${int(decision.createdAt)}, reason_codes: ${list(string)(decision.reasonCodes ?? [], ctx)})`;
      return eqOptionJson(
        `${ctx.use('gleam/option')}.map(${ctx.use(SL)}.candidate(${id}.recruitment_case(${string(room.id)}), ${id}.player(${string(room.playerId)}), ${string(room.room.status)}, ${bool(playerVisible)}, ${decided}, ${list(change)(changes, ctx)}, ${int(now)}), ${ctx.use(SL)}.candidate_json)`,
        candidateView(c.result),
        ctx,
      );
    },
  },
  [`${DISCOVERY}#canSecondLookTransition`]: {
    module: SL,
    test: (c, ctx) => eq(`${ctx.use(SL)}.can_transition(${itemStatus(c.args[0], ctx)}, ${itemStatus(c.args[1], ctx)})`, bool(c.result)),
  },
  [`${DISCOVERY}#secondLookStatus`]: {
    module: SL,
    now: true,
    test: (c, ctx) => {
      const { existing, candidate, now = ctx.now } = c.args[0];
      const handled = (e) =>
        `${ctx.use(SL)}.Handled(status: ${itemStatus(e.status, ctx)}, fingerprints: ${list(string)(e.changeFingerprints ?? [], ctx)}, dismissed_at: ${option(int)(e.dismissedAt, ctx)}, reviewed_at: ${option(int)(e.reviewedAt, ctx)}, updated_at: ${int(e.updatedAt ?? 0)})`;
      const changes = `[${(candidate.changes ?? []).map((x) => `#(${string(x.fingerprint)}, ${changeType(x.type, ctx)})`).join(', ')}]`;
      return eqJson(`${ctx.use(SL)}.verdict_json(${ctx.use(SL)}.verdict(${option(handled)(existing, ctx)}, ${changes}, ${int(now)}))`, c.result, ctx);
    },
  },
  [`${DISCOVERY}#secondLookExpired`]: {
    module: SL,
    now: true,
    test: (c, ctx) => {
      const [item, now = ctx.now] = c.args;
      return eq(`${ctx.use(SL)}.expired(${itemStatus(item.status, ctx)}, ${int(item.latestChangeAt ?? item.createdAt)}, ${int(now)})`, bool(c.result));
    },
  },
  [`${DISCOVERY}#orderSecondLook`]: {
    module: SL,
    test: (c, ctx) => {
      const items = `[${c.args[0].map((i) => `#(${triggerType(i.kind, ctx)}, ${int(i.latestChangeAt)}, ${string(String(i.id ?? ''))})`).join(', ')}]`;
      return eq(
        `${ctx.use('gleam/list')}.map(${ctx.use('gleam/list')}.sort(${items}, ${ctx.use(SL)}.compare_items), fn(t) { t.2 })`,
        list(string)(c.result.map((i) => String(i.id ?? '')), ctx),
      );
    },
  },
  [`${DISCOVERY}#compareToSnapshot`]: {
    module: SL,
    test: (c, ctx) => {
      const [s, cur] = c.args;
      const n = (xs) => option(int)(Array.isArray(xs) ? xs.length : null, ctx);
      const recorded = s
        ? `Some(${ctx.use(SL)}.Recorded(at: ${option(int)(s.at, ctx)}, trust: ${trustPair(s.trust)}, evidence: ${n(s.sourceRefs?.evidenceIds)}, combine: ${n(s.sourceRefs?.combineResults)}, assessments: ${n(s.sourceRefs?.assessmentIds)}, trials: ${n(s.sourceRefs?.trialIds)}))`
        : 'None';
      const len = (xs) => int((xs ?? []).length);
      const current = `${ctx.use(SL)}.Current(trust: ${trustPair(cur.trust)}, evidence: ${len(cur.evidenceIds)}, references: ${int(cur.references ?? 0)}, references_at_decision: ${option(int)(cur.referencesAtDecision, ctx)}, combine: ${len(cur.combineResults)}, assessments: ${len(cur.assessmentIds)}, trials: ${len(cur.trialIds)})`;
      return eqJson(`${ctx.use(SL)}.compare(${recorded}, ${current})`, c.result, ctx);
    },
  },
  [`${DISCOVERY}#trustLevelChanges`]: {
    module: SL,
    test: (c, ctx) => {
      const [snap, profile] = c.args;
      const levels = (o) =>
        o ? `Some([${levelsOf(o).map(([k, v]) => `#(${string(k)}, ${string(v)})`).join(', ')}])` : 'None';
      const movement = (m) =>
        `${ctx.use(SL)}.Movement(component: ${string(m.component)}, code: ${string(m.code)}, up: ${bool(m.direction === 'up')})`;
      return eq(
        `${ctx.use(SL)}.trust_level_changes(${levels(snap?.componentLevels)}, ${levels(profile?.components)})`,
        list(movement)(c.result, ctx),
      );
    },
  },
  [`${DISCOVERY}#isMeaningfullyEvaluated`]: {
    module: NM,
    now: true,
    test: (c, ctx) => {
      const [signals = {}, { now = ctx.now } = {}] = c.args;
      const on = Object.keys(signals).filter((k) => k !== 'lastDecisionAt' && signals[k]);
      return eqJson(`${ctx.use(NM)}.evaluation(${list(string)(on, ctx)}, ${option(int)(signals.lastDecisionAt, ctx)}, ${int(now)})`, c.result, ctx);
    },
  },
  [`${DISCOVERY}#canBriefTransition`]: {
    module: BR,
    test: (c, ctx) => eq(`${ctx.use(BR)}.can_transition(${briefStatus(c.args[0], ctx)}, ${briefStatus(c.args[1], ctx)})`, bool(c.result)),
  },
  [`${DISCOVERY}#validateRecruitmentBrief`]: {
    module: BR,
    test: (c, ctx) => {
      const [input = {}, { orgLevel = 'pro', protocols = null } = {}] = c.args;
      if (protocols !== null) throw new Error('validateRecruitmentBrief with a protocol list: the Gleam rule reads the registry');
      return eqJson(
        `${ctx.use(BR)}.validate_body(${list(string)(Object.keys(input), ctx)}, ${briefFields(input, ctx)}, ${bool(orgLevel === 'grassroots')})`,
        c.result,
        ctx,
      );
    },
  },
  [`${DISCOVERY}#explainBriefCriteria`]: {
    module: BR,
    test: (c, ctx) => eqJson(`${ctx.use(BR)}.explain(${criteria(c.args[0], ctx)})`, c.result, ctx),
  },
  ['domains/discovery/matching/match.mjs#playerMatchesBrief']: {
    module: ENGINE,
    now: true,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ENGINE)}.match_brief_json(${ctx.use(ENGINE)}.match_brief(${facts(c.args[0], ctx)}, ${criteria(c.args[1] ?? {}, ctx)}, ${nowOf(c.args[2], ctx)}))`,
        c.result,
        ctx,
      ),
  },
  ['domains/discovery/matching/match.mjs#matchBrief']: {
    module: ENGINE,
    now: true,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ENGINE)}.match_brief_json(${ctx.use(ENGINE)}.match_brief(${facts(c.args[0], ctx)}, ${criteria(c.args[1] ?? {}, ctx)}, ${nowOf(c.args[2], ctx)}))`,
        c.result,
        ctx,
      ),
  },
  ['domains/discovery/matching/match.mjs#briefCriteriaToCanonical']: {
    module: ENGINE,
    test: (c, ctx) =>
      eqJson(`${ctx.use(CRIT)}.criteria_json(${ctx.use(ENGINE)}.brief_criteria(${criteria(c.args[0] ?? {}, ctx)}))`, c.result, ctx),
  },
  ['domains/discovery/matching/match.mjs#matchPlayerToCriteria']: {
    module: ENGINE,
    now: true,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(ENGINE)}.match_json(${ctx.use(ENGINE)}.match(${facts(c.args[0], ctx)}, ${criteriaSet(c.args[1], ctx)}, ${nowOf(c.args[2], ctx)}))`,
        c.result,
        ctx,
      ),
  },
  ['domains/discovery/matching/criteria.mjs#validateCriteria']: {
    module: CRIT,
    test: (c, ctx) => {
      const [input = {}, { orgLevel = 'pro', protocols = null } = {}] = c.args;
      const context = `${ctx.use(CRIT)}.Context(grassroots: ${bool(orgLevel === 'grassroots')}, protocols: ${option(list(string))(protocols, ctx)})`;
      return eqJson(
        `${ctx.use(CRIT)}.validation_json(${ctx.use(CRIT)}.validate(${rawList(input?.required, ctx)}, ${rawList(input?.preferred, ctx)}, ${context}))`,
        c.result,
        ctx,
      );
    },
  },
  ['domains/discovery/matching/criteria.mjs#criterionId']: {
    module: CRIT,
    test: (c, ctx) => {
      const [type, operator, body = {}] = c.args;
      return eq(`${ctx.use(CRIT)}.criterion_id(${testOf({ type, operator, ...body }, ctx)})`, string(c.result));
    },
  },
  ['domains/discovery/matching/criteria.mjs#criteriaVersion']: {
    module: CRIT,
    test: (c, ctx) => eq(`${ctx.use(CRIT)}.version(${criteriaSet(c.args[0], ctx)})`, string(c.result)),
  },
  ['domains/discovery/matching/criteria.mjs#describeCriteria']: {
    module: CRIT,
    test: (c, ctx) => eqJson(`${ctx.use(CRIT)}.describe(${criteriaSet(c.args[0], ctx)})`, c.result, ctx),
  },
  ['domains/discovery/matching/criteria.mjs#isProhibitedCriterion']: {
    module: CRIT,
    test: (c, ctx) => eq(`${ctx.use(CRIT)}.is_prohibited(${string(c.args[0])})`, bool(c.result)),
  },
  ['domains/discovery/matching/watchlists.mjs#reconcileMembership']: {
    module: WLR,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use(WLR)}.diff_json(${ctx.use(WLR)}.reconcile(${list(string)(c.args[0] ?? [], ctx)}, ${list(string)(c.args[1] ?? [], ctx)}))`,
        c.result,
        ctx,
      ),
  },
  ['domains/discovery/matching/watchlists.mjs#transitionFingerprint']: {
    module: WLR,
    test: (c, ctx) => {
      const f = c.args[0];
      return eq(
        `${ctx.use(WLR)}.fingerprint(${string(f.watchlistId)}, ${string(f.playerId)}, ${string(f.criteriaVersion)}, ${transitionV(f.transition, ctx)}, ${reasonV(f.reason, ctx)})`,
        string(c.result),
      );
    },
  },
  ['domains/discovery/matching/watchlists.mjs#explainTransition']: {
    module: WLR,
    test: (c, ctx) => {
      const a = c.args[0];
      return eqJson(
        `${ctx.use(WLR)}.explanation_json(${ctx.use(WLR)}.explain(${matchOf(a.previousMatch, ctx)}, ${matchOf(a.currentMatch, ctx)}, ${bool(!!a.criteriaChanged)}, ${bool(!!a.briefChanged)}, ${transitionV(a.transition, ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
  ['domains/discovery/matching/watchlists.mjs#membershipSummary']: {
    module: WLR,
    test: (c, ctx) => {
      const { entered = [], left = [], unchanged = [] } = c.args[0];
      return eqJson(`${ctx.use(WLR)}.summary(${entered.length}, ${left.length}, ${unchanged.length})`, c.result, ctx);
    },
  },
  ['domains/discovery/matching/watchlists.mjs#membershipNotification']: {
    module: WLR,
    test: (c, ctx) => {
      const { watchlistName, entered = [], left = [], reason } = c.args[0];
      const cause = { criteria_changed: 'CriteriaEdited', brief_changed: 'BriefEdited' }[reason] ?? 'FactsChanged';
      const W = ctx.use(WLR);
      return eqJson(
        `${W}.notification_json(${W}.notification(${string(watchlistName)}, ${entered.length}, ${left.length}, ${W}.${cause}), ${entered.length}, ${left.length})`,
        c.result,
        ctx,
      );
    },
  },
  ['domains/platform/notificationPrefs.mjs#categoryOf']: {
    module: 'scoutbox/messaging/notification_prefs',
    test: (c, ctx) =>
      eq(
        `${ctx.use('gleam/option')}.map(${ctx.use('scoutbox/messaging/notification_prefs')}.category_of(${string(c.args[0])}, ${string(c.args[1] ?? '')}), ${ctx.use('scoutbox/vocab/notification_category')}.to_string)`,
        option(string)(c.result, ctx),
      ),
  },
  ['domains/discovery/matching/watchlists.mjs#watchlistBlockedState']: {
    module: WLR,
    test: (c, ctx) => {
      const { status, mode, brief } = c.args[0];
      const W = ctx.use(WLR);
      const link = mode === 'live_linked' ? `${W}.LinkedTo(${brief ? `Some(${briefStatus(brief.status, ctx)})` : 'None'})` : `${W}.NotLinked`;
      return eqJson(`${W}.blocked_state(${watchStatus(status, ctx)}, ${link})`, c.result, ctx);
    },
  },
  [`${DISCOVERY}#buildNobodyMissedCandidate`]: {
    module: NM,
    test: (c, ctx) => {
      const { facts: f, brief, match, evaluation, roomOpen } = c.args[0];
      const reasons = `[${match.reasons.map((r) => `${ctx.use(ENGINE)}.Reason(key: ${string(r.key)}, met: ${bool(r.met)}, text: ${string(r.text)})`).join(', ')}]`;
      return eqOptionJson(
        `${ctx.use('gleam/option')}.map(${ctx.use(NM)}.card(${facts(f, ctx)}, ${ctx.use('scoutbox/rows/id')}.brief(${string(brief.id)}), ${int(brief.version)}, #(${bool(match.matched)}, ${reasons}), ${bool(!!evaluation?.evaluated)}, ${bool(!!roomOpen)}), ${ctx.use('gleam/json')}.object)`,
        c.result,
        ctx,
      );
    },
  },
  [`${DISCOVERY}#evaluationCoverageState`]: {
    module: NM,
    test: (c, ctx) => {
      const { eligible, evaluated, suppressMin = 3 } = c.args[0];
      return eqJson(`${ctx.use(NM)}.coverage_state(${ctx.use(NM)}.Coverage(eligible: ${int(eligible)}, evaluated: ${int(evaluated)}), ${int(suppressMin)})`, c.result, ctx);
    },
  },
  [`${DISCOVERY}#orderNobodyMissed`]: {
    module: NM,
    test: (c, ctx) => {
      const [items, sort = 'newest_evidence'] = c.args;
      const one = (i) =>
        `${ctx.use(NM)}.Orderable(player_id: ${string(i.playerId)}, name: ${option(string)(i.name, ctx)}, distance_km: ${option(float)(i.distanceKm, ctx)}, trust_band: ${option(band)(i.trustBand, ctx)}, last_evidence_at: ${option(int)(i.lastEvidenceAt, ctx)}, reviewed_at: ${option(int)(i.reviewedAt, ctx)})`;
      return eq(
        `${ctx.use('gleam/list')}.map(${ctx.use(NM)}.order([${items.map(one).join(', ')}], ${string(sort)}), fn(o) { o.player_id })`,
        list(string)(c.result.map((i) => i.playerId), ctx),
      );
    },
  },
  [`${DISCOVERY}#clampPage`]: {
    module: NM,
    test: (c, ctx) => eq(`${ctx.use(NM)}.clamp_page(${float(c.args[0])}, ${int(c.args[1] ?? 25)})`, int(c.result)),
  },
  [`${DISCOVERY}#safeM18Projection`]: {
    module: SL,
    test: (c, ctx) => {
      const fields = `[${Object.entries(c.args[0]).map(([k, v]) => `#(${string(k)}, ${jsonValue(v, ctx)})`).join(', ')}]`;
      return eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(SL)}.safe_projection(${fields}))`, c.result, ctx);
    },
  },
};

// -------------------------------------------------------------------------------------------------- agent core

const AGENT = 'domains/agents/core';
const AR = 'scoutbox/agents/agent_rules';
const facetV = vocab('scoutbox/vocab/agent_facet');
const facetState = vocab('scoutbox/vocab/facet_state');
const jurisdictionV = vocab('scoutbox/vocab/jurisdiction');
const tier = vocab('scoutbox/vocab/agency_tier');
const agreementStatus = vocab('scoutbox/vocab/agreement_status');
const storedStatus = vocab('scoutbox/rows/representation_agreements', 'status_pairs');
const scopeV = vocab('scoutbox/rows/agreement_scopes', 'scope_pairs');
/** A key whose only value here is null: the Gleam record has no field for anything else in it. */
const onlyNull = (what) => (v) => {
  if (v !== null) throw new Error(`no Gleam field for ${what} ${JSON.stringify(v)}`);
  return [];
};

/** A facet as the profile stores it. Where it is stored (`$at`: its facet and member association, given by the
 *  profile it is in) is what Gleam keys it by; its own `memberAssociation` copy is not read by any rule. */
const facet = record({
  module: 'scoutbox/rows/agent_profile_facets',
  constructor: 'Row',
  base: call(BASE, 'facet'),
  fields: {
    $at: ([kind, ma], ctx) => [
      ['facet', facetV(kind, ctx)],
      ['member_association', jurisdictionV(ma, ctx)],
    ],
    state: ['state', facetState],
    reference: ['reference', option(string)],
    memberAssociation: () => [],
    provenance: onlyNull('a facet provenance'),
    submittedAt: ['submitted_at', option(int)],
    verifiedAt: ['verified_at', option(int)],
    recheckAt: ['recheck_at', option(int)],
    note: ['note', option(string)],
  },
});
const facetAt = (kind, ma) => (v, ctx) => {
  if (v === null || typeof v !== 'object') throw new Error(`cannot print ${JSON.stringify(v)} as a stored facet`);
  return facet({ $at: [kind, ma], ...v }, ctx);
};

const profileRow = record({
  module: 'scoutbox/rows/agent_profiles',
  constructor: 'Row',
  base: call(BASE, 'agent_profile'),
  fields: {
    id: ['id', ident('agent_profile')],
    userId: ['user_id', ident('org_user')],
    agencyOrgId: ['agency_org_id', ident('org')],
    displayName: ['display_name', string],
    createdAt: ['created_at', int],
    updatedAt: ['updated_at', int],
    rev: ['rev', int],
    revAt: ['rev_at', option(int)],
    revBy: onlyNull('a profile revBy'),
    declared: (v, ctx) => [['declared_fifa_licence_number', option(string)(v?.fifaLicenceNumber, ctx)]],
  },
  ignore: ['facets', 'history'],
});

/** A profile: the stored facets (the FIFA licence under INT, the others keyed by member association) in order. */
const profile = (v, ctx) => {
  if (v === null || typeof v !== 'object') throw new Error(`cannot print ${JSON.stringify(v)} as a Profile`);
  if ((v.history ?? []).length) throw new Error('a profile with history');
  const facets = [];
  for (const [kind, x] of Object.entries(v.facets ?? {})) {
    if (kind === 'fifa_licence') facets.push(facetAt(kind, 'INT')(x, ctx));
    else for (const [ma, f] of Object.entries(x)) facets.push(facetAt(kind, ma)(f, ctx));
  }
  return `${ctx.use(AR)}.Profile(row: ${profileRow(v, ctx)}, jurisdictions: ${list(jurisdictionV)(v.declared?.jurisdictions ?? [], ctx)}, facets: [${facets.join(', ')}], history: [])`;
};

const gap = (v, ctx) => {
  if (v.error === 'AGENT_PROFILE_REQUIRED') return `${ctx.use(AR)}.ProfileRequired`;
  if (v.error !== 'AGENT_VERIFICATION_REQUIRED') throw new Error(`no Gap for ${v.error}`);
  return `${ctx.use(AR)}.VerificationRequired(${facetV(v.facet, ctx)}, ${option(jurisdictionV)(v.memberAssociation, ctx)}, ${facetState(v.state, ctx)})`;
};

const PROVIDERS = { none: 'NoProvider', 'local-synthetic-test-provider': 'SyntheticProvider' };
const submission = (v, ctx) => {
  const p = PROVIDERS[v.provenance?.provider];
  if (!p) throw new Error(`no Provider for ${JSON.stringify(v.provenance)}`);
  return `${ctx.use(AR)}.Submission(state: ${facetState(v.state, ctx)}, verified_at: ${option(int)(v.verifiedAt, ctx)}, recheck_at: ${option(int)(v.recheckAt, ctx)}, provider: ${ctx.use(AR)}.${p}, at: ${int(v.provenance.at)}, note: ${string(v.note)})`;
};

/** A membership. A start is required: the TypeScript rule reads a missing one as never started, and every stored
 *  membership has one. Its roles are as given (the TypeScript rule drops unknown ones; Gleam can't hold them). */
const affiliation = (v, ctx) => {
  if (v === null || typeof v !== 'object' || !('startedAt' in v)) throw new Error(`an affiliation without a start ${JSON.stringify(v)}`);
  const row = record({
    module: 'scoutbox/rows/agency_affiliations',
    constructor: 'Row',
    base: call(BASE, 'affiliation'),
    fields: {
      id: ['id', ident('affiliation')],
      agencyOrgId: ['agency_org_id', ident('org')],
      userId: ['user_id', ident('org_user')],
      startedAt: ['started_at', int],
      endedAt: ['ended_at', option(int)],
    },
    ignore: ['tiers'],
  })(v, ctx);
  return `${ctx.use(AR)}.Affiliation(row: ${row}, tiers: ${list(tier)(v.tiers ?? [], ctx)})`;
};

/** An agreement row. Its status is required (every stored agreement has one). */
const agreementRowOf = record({
  module: 'scoutbox/rows/representation_agreements',
  constructor: 'Row',
  base: call(BASE, 'agreement'),
  fields: {
    id: ['id', ident('agreement')],
    agentUserId: ['agent_user_id', ident('org_user')],
    agencyOrgId: ['agency_org_id', ident('org')],
    clientKind: ['client_kind', vocab('scoutbox/rows/representation_agreements', 'client_kind_pairs')],
    clientId: ['client_id', string],
    jurisdiction: ['jurisdiction', jurisdictionV],
    exclusive: ['exclusive', bool],
    termMonths: ['term_months', int],
    startAt: ['start_at', option(int)],
    endAt: ['end_at', option(int)],
    status: ['status', storedStatus],
    proposedAt: ['proposed_at', int],
    confirmedAt: ['confirmed_at', option(int)],
    confirmedBy: (v, ctx) => {
      if (v?.kind !== 'player') throw new Error(`no Gleam field for confirmedBy ${JSON.stringify(v)}`);
      return [['confirmed_by_player_id', `Some(${ident('player')(v.id, ctx)})`]];
    },
    declinedAt: ['declined_at', option(int)],
    terminatedAt: ['terminated_at', option(int)],
    terminatedBy: ['terminated_by', option(vocab('scoutbox/vocab/terminator'))],
    terminationReasonCode: ['termination_reason_code', option(string)],
    disputedAt: ['disputed_at', option(int)],
    disputeReason: ['dispute_reason', option(string)],
    shareWithAgencyStaff: ['share_with_agency_staff', bool],
    createdAt: ['created_at', int],
    rev: ['rev', int],
    revAt: ['rev_at', option(int)],
    revBy: onlyNull('an agreement revBy'),
    keys: (v) => {
      if (Object.keys(v ?? {}).length) throw new Error(`no Gleam field for keys ${JSON.stringify(v)}`);
      return [];
    },
  },
  // Kept beside the row in Gleam (Agreement), and read by no rule that takes a row.
  ignore: ['scope', 'policyVersions', 'history'],
});
const agreementRow = (v, ctx) => {
  if (v === null || typeof v !== 'object' || !('status' in v)) throw new Error(`an agreement without a status ${JSON.stringify(v)}`);
  return agreementRowOf(v, ctx);
};

/** A whole agreement, for the projections. A stored agreement always has a jurisdiction, a term and a proposal time,
 *  which the projections write; and its history's details are typed columns. */
const agreement = (v, ctx) => {
  for (const k of ['jurisdiction', 'termMonths', 'proposedAt'])
    if (v?.[k] === undefined) throw new Error(`an Agreement always has ${k}`);
  if ((v.history ?? []).length) throw new Error('an Agreement history entry with a free-form detail');
  return `${ctx.use(AR)}.Agreement(row: ${agreementRow(v, ctx)}, scope: ${list(scopeV)(v.scope ?? [], ctx)}, policy_versions: ${list(ident('policy'))(v.policyVersions ?? [], ctx)}, history: [])`;
};

const conflict = (v, ctx) => {
  if (v.error === 'REPRESENTATION_ALREADY_EXISTS')
    return `${ctx.use(AR)}.AlreadyExists(${ident('agreement')(v.agreementId, ctx)}, ${agreementStatus(v.status, ctx)})`;
  if (v.error === 'REPRESENTATION_COOLDOWN') return `${ctx.use(AR)}.Cooldown(${int(v.retryAt)})`;
  throw new Error(`no Conflict for ${v.error}`);
};

const nowArg = (v, ctx) => int(v ?? ctx.now);
const agent = plainIn(AR);
const withNow = (fnName, args, result) => ({
  module: AR,
  now: true,
  test: (c, ctx) =>
    eq(
      `${ctx.use(AR)}.${fnName}(${args.map((p, i) => p(c.args[i], ctx)).join(', ')}, ${nowArg(c.args[args.length], ctx)})`,
      result(c.result, ctx),
    ),
});
const agreementJson = (fnName) => ({
  module: AR,
  now: true,
  test: (c, ctx) =>
    eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(AR)}.${fnName}(${agreement(c.args[0], ctx)}, ${nowArg(c.args[1], ctx)}))`, c.result, ctx),
});
/** An agreement for the access rule: one naming no agent can't be held (the base names one). */
const grantee = (v, ctx) => {
  const row = agreementRow(v, ctx);
  if (v.agentUserId === undefined) throw new Error('an agreement naming no agent');
  return row;
};

const AGENT_MAP = {
  [`${AGENT}/shared.mjs#effectiveFacetState`]: withNow('effective_facet_state', [option(facet)], facetState),
  [`${AGENT}/shared.mjs#evaluateSubmission`]: {
    module: AR,
    now: true,
    test: (c, ctx) => {
      const { facet: f, reference = '', testProviderEnabled = false, now, ...rest } = c.args[0];
      if (Object.keys(rest).length) throw new Error(`evaluate_submission has no argument for ${Object.keys(rest)}`);
      return eq(
        `${ctx.use(AR)}.evaluate_submission(${facetV(f, ctx)}, ${string(reference)}, ${bool(testProviderEnabled)}, ${nowArg(now, ctx)})`,
        submission(c.result, ctx),
      );
    },
  },
  [`${AGENT}/shared.mjs#requiredFacetsFor`]: agent('required_facets_for', [jurisdictionV], (v, ctx) =>
    list((r) => `#(${facetV(r.facet, ctx)}, ${option(jurisdictionV)(r.ma, ctx)})`)(v, ctx),
  ),
  [`${AGENT}/shared.mjs#verificationGap`]: withNow('verification_gap', [option(profile), jurisdictionV], option(gap)),
  [`${AGENT}/shared.mjs#normaliseTiers`]: agent('normalise_tiers', [list(string)], list(tier)),
  [`${AGENT}/shared.mjs#affiliationActive`]: {
    module: AR,
    now: true,
    test: (c, ctx) => {
      const [a, now] = c.args;
      if (a === null || typeof a !== 'object' || !('startedAt' in a)) throw new Error(`an affiliation without a start ${JSON.stringify(a)}`);
      return eq(`${ctx.use(AR)}.affiliation_active(${int(a.startedAt)}, ${option(int)(a.endedAt, ctx)}, ${nowArg(now, ctx)})`, bool(c.result));
    },
  },
  [`${AGENT}/shared.mjs#can`]: agent('can', [list(tier), string], bool),
  [`${AGENT}/shared.mjs#capabilitiesOf`]: agent('capabilities_of', [list(tier)], list(string)),
  [`${AGENT}/shared.mjs#affiliationChangeProblem`]: {
    module: AR,
    now: true,
    test: (c, ctx) => {
      const { affiliations, target, actorUserId, nextTiers, now, ending = false, ...rest } = c.args[0];
      if (Object.keys(rest).length) throw new Error(`affiliation_change_problem has no argument for ${Object.keys(rest)}`);
      return eq(
        `${ctx.use(AR)}.affiliation_change_problem(${list(affiliation)(affiliations, ctx)}, ${affiliation(target, ctx)}, ${ident('org_user')(actorUserId, ctx)}, ${list(tier)(nextTiers, ctx)}, ${bool(ending)}, ${nowArg(now, ctx)})`,
        option(code(AR, 'change_problem_code'))(c.result, ctx),
      );
    },
  },
  [`${AGENT}/shared.mjs#termEndAt`]: agent('term_end_at', [int, int], int),
  [`${AGENT}/shared.mjs#normaliseScope`]: agent('scope_of', [list(scopeV)], list(scopeV)),
  [`${AGENT}/shared.mjs#effectiveAgreementStatus`]: withNow('effective_status', [agreementRow], agreementStatus),
  [`${AGENT}/shared.mjs#agreementGrantsAccess`]: withNow('grants_access', [grantee, ident('org_user')], bool),
  [`${AGENT}/shared.mjs#clientTransitionAllowed`]: withNow('client_transition_allowed', [agreementRow, agreementStatus], bool),
  [`${AGENT}/shared.mjs#agentTransitionAllowed`]: withNow('agent_transition_allowed', [agreementRow, agreementStatus], bool),
  [`${AGENT}/shared.mjs#requestConflict`]: {
    module: AR,
    now: true,
    test: (c, ctx) => {
      const [agreements, { agentUserId, playerId, now, ...rest }] = c.args;
      if (Object.keys(rest).length) throw new Error(`request_conflict has no argument for ${Object.keys(rest)}`);
      return eq(
        `${ctx.use(AR)}.request_conflict(${list(agreementRow)(agreements, ctx)}, ${ident('org_user')(agentUserId, ctx)}, ${string(playerId)}, ${nowArg(now, ctx)})`,
        option(conflict)(c.result, ctx),
      );
    },
  },
  [`${AGENT}/shared.mjs#agreementForAgent`]: agreementJson('agreement_for_agent'),
  [`${AGENT}/shared.mjs#agreementForClient`]: agreementJson('agreement_for_client'),
  [`${AGENT}/shared.mjs#agreementSummaryForStaff`]: {
    module: AR,
    now: true,
    test: (c, ctx) =>
      eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(AR)}.summary_for_staff(${agreementRow(c.args[0], ctx)}, ${nowArg(c.args[1], ctx)}))`, c.result, ctx),
  },
  [`${AGENT}/errors.mjs#publicErrorBody`]: {
    module: 'scoutbox/agents/core_routes',
    test: (c, ctx) => {
      const { error, ...fields } = c.args[0];
      if ('reasons' in fields) throw new Error('publicErrorBody with reasons: the Gleam routes write them already shaped');
      const list_ = Object.entries(fields).map(([k, v]) => `#(${string(k)}, ${jsonValue(v, ctx)})`);
      return eq(
        `${ctx.use('wisp/simulate')}.read_body(${ctx.use('scoutbox/recruitment/domain_errors')}.send(${ctx.use('scoutbox/agents/core_routes')}.contract, ${string(error)}, [${list_.join(', ')}]))`,
        string(JSON.stringify(c.result)),
      );
    },
  },
};

// -------------------------------------------------------------------------------------------------- passport

const PASSPORT = 'domains/passport/shared.mjs';
const PR = 'scoutbox/passport/passport_rules';
const passport = plainIn(PR);
const provenance = vocab(PR, 'provenance_pairs');
const visibility = vocab(PR, 'visibility_pairs');
const viewer = vocab(PR, 'viewer_pairs');
const partyV = vocab('scoutbox/vocab/party');
const positionV = vocab('scoutbox/vocab/position');
const levelV = vocab('scoutbox/vocab/playing_level');
const availabilityV = vocab('scoutbox/rows/passport_prefs', 'availability_pairs');
const EVIDENCE_ROWS = 'scoutbox/rows/evidence';
const ACHIEVEMENT_ROWS = 'scoutbox/rows/passport_achievements';
const anyPlayer = (ctx) => `${ctx.use('scoutbox/rows/id')}.player("p")`;
const unsupported = (what) => (v) => {
  throw new Error(`cannot print ${JSON.stringify(v)} as ${what}`);
};

/** A normalised date; its year, month and day are read from its instant. */
const when_ = record({
  module: PR,
  constructor: 'When',
  fields: { t: ['t', int], precision: ['precision', vocab(PR, 'precision_pairs')] },
  ignore: ['y', 'm', 'd'],
});
const source = record({ module: PR, constructor: 'Source', fields: { type: ['type_', string], id: ['id', string] } });
const career = record({
  module: 'scoutbox/rows/passport_career_entries',
  constructor: 'Row',
  fields: {
    id: ['id', ident('career_entry')],
    orgName: ['org_name', string],
    role: ['role', option(string)],
    from: ['from_date', string],
    to: ['to_date', option(string)],
    submittedBy: ['submitted_by', partyV],
    withdrawnAt: ['withdrawn_at', option(int)],
  },
  defaults: { player_id: anyPlayer, role: 'None', to_date: 'None', note: 'None', created_at: '0', withdrawn_at: 'None' },
});
const squad = record({
  module: PR,
  constructor: 'SquadSource',
  fields: {
    orgId: ['org_id', ident('org')],
    orgName: ['org_name', string],
    rowId: ['row_id', string],
    addedAt: ['added_at', int],
    orgVerified: ['org_verified', bool],
  },
});
/** A trial as the timeline reads it. Only a legacy one (no workflow state) can be printed from its JavaScript. */
const trial = (t, ctx) => {
  if (t.workflowState !== undefined && t.workflowState !== 'legacy_accepted')
    throw new Error(`cannot print the attendance of ${JSON.stringify(t)}`);
  const { id: tid, orgId, orgName = null, proposedDate = null, acceptedAt, report = null, ...rest } = t;
  const unknown = Object.keys(rest).filter((k) => k !== 'workflowState');
  if (unknown.length) throw new Error(`TrialSource has no field for the JavaScript key ${unknown[0]}`);
  const reportAt = report && (report.filedAt ?? report.at);
  if (report && !Number.isInteger(reportAt)) throw new Error(`cannot print the report ${JSON.stringify(report)}`);
  return `${ctx.use(PR)}.TrialSource(id: ${ident('trial')(tid, ctx)}, org_id: ${ident('org')(orgId, ctx)}, org_name: ${option(string)(orgName, ctx)}, proposed_date: ${option(string)(proposedDate, ctx)}, accepted_at: ${int(acceptedAt)}, attendance: ${ctx.use(PR)}.Legacy, report_at: ${option(int)(reportAt, ctx)})`;
};
const assessment = record({
  module: PR,
  constructor: 'AssessmentSource',
  fields: {
    id: ['id', ident('assessment')],
    orgId: ['org_id', ident('org')],
    orgName: ['org_name', option(string)],
    submittedAt: ['submitted_at', option(int)],
    createdAt: ['created_at', int],
    state: ['state', vocab('scoutbox/rows/assessments', 'state_pairs')],
  },
  defaults: { org_name: 'None', submitted_at: 'None', created_at: '0', state: (ctx) => `${ctx.use('scoutbox/rows/assessments')}.Submitted` },
});
const reference = record({
  module: PR,
  constructor: 'ReferenceSource',
  fields: {
    id: ['id', ident('reference')],
    coachName: ['coach_name', option(string)],
    orgId: ['org_id', ident('org')],
    orgName: ['org_name', option(string)],
    createdAt: ['created_at', int],
    status: ['status', vocab('scoutbox/rows/ver_references', 'status_pairs')],
    provenanceStillCurrent: ['provenance_still_current', bool],
  },
  defaults: {
    // The revision reads a reference's id, status and provenance alone.
    org_id: (ctx) => `${ctx.use('scoutbox/rows/id')}.org("org")`,
    created_at: '0',
    coach_name: 'None',
    role_at_time: 'None',
    org_name: 'None',
    relationship: '""',
    from_year: 'None',
    to_year: 'None',
    strengths: '""',
    development: '""',
    summary: '""',
    status: (ctx) => `${ctx.use('scoutbox/rows/ver_references')}.Active`,
    provenance_still_current: 'False',
  },
});
const evidence = record({
  module: PR,
  constructor: 'EvidenceSource',
  fields: {
    id: ['id', ident('scouting_evidence')],
    claimType: ['claim_type', vocab(EVIDENCE_ROWS, 'claim_type_pairs')],
    label: ['label', string],
    recordedAt: ['recorded_at', int],
    tier: ['tier', vocab(EVIDENCE_ROWS, 'verification_status_pairs')],
    sourceKind: ['source_kind', vocab(EVIDENCE_ROWS, 'source_kind_pairs')],
    superseded: ['superseded', bool],
    expired: ['expired', bool],
  },
  // With neither, the TypeScript engine reads a player's own unconfirmed item, as these defaults do.
  defaults: {
    tier: (ctx) => `${ctx.use(EVIDENCE_ROWS)}.SelfReported`,
    source_kind: (ctx) => `${ctx.use(EVIDENCE_ROWS)}.Player`,
    superseded: 'False',
    expired: 'False',
  },
});
const signing = record({
  module: PR,
  constructor: 'SigningSource',
  fields: { id: ['id', ident('signing')], orgId: ['org_id', ident('org')], orgName: ['org_name', option(string)], ts: ['ts', int] },
  defaults: { org_name: 'None' },
});
const achievement = record({
  module: ACHIEVEMENT_ROWS,
  constructor: 'Row',
  fields: {
    id: ['id', ident('achievement')],
    title: ['title', string],
    orgName: ['org_name', option(string)],
    when: ['when_date', option(string)],
    submittedBy: ['submitted_by', partyV],
    confirmation: (c, ctx) =>
      c === null
        ? []
        : [
            ['confirmation_provenance', `Some(${vocab(ACHIEVEMENT_ROWS, 'confirmation_provenance_pairs')(c.provenance, ctx)})`],
            ['confirmation_org_name', option(string)(c.orgName, ctx)],
          ],
    withdrawnAt: ['withdrawn_at', option(int)],
  },
  defaults: {
    player_id: anyPlayer,
    // The revision reads an achievement's id, confirmation and withdrawal alone.
    title: '""',
    submitted_by: (ctx) => partyV('player', ctx),
    org_name: 'None',
    when_date: 'None',
    confirmation_provenance: 'None',
    confirmation_org_id: 'None',
    confirmation_org_name: 'None',
    confirmation_by_name: 'None',
    confirmation_at: 'None',
    created_at: '0',
    withdrawn_at: 'None',
  },
});
const positionEntry = record({
  module: PR,
  constructor: 'PositionSource',
  fields: {
    id: ['id', ident('position_entry')],
    from: ['from', string],
    primary: ['primary', positionV],
    secondary: ['secondary', list(positionV)],
  },
  ignore: ['submittedBy', 'recordedAt'],
  defaults: { secondary: '[]' },
});
const sources = record({
  module: PR,
  constructor: 'Sources',
  base: ref(PR, 'no_sources'),
  fields: {
    careerEntries: ['career_entries', list(career)],
    squads: ['squads', list(squad)],
    trials: ['trials', list(trial)],
    assessments: ['assessments', list(assessment)],
    references: ['references', list(reference)],
    evidence: ['evidence', list(evidence)],
    signings: ['signings', list(signing)],
    achievements: ['achievements', list(achievement)],
    positionHistory: ['position_history', list(positionEntry)],
  },
});
/** An event's title: each field as the value it holds. */
const titleField = (v, ctx) => {
  const pr = ctx.use(PR);
  if (v === null) return `${pr}.Null`;
  if (typeof v === 'string') return `${pr}.Text(${string(v)})`;
  if (typeof v === 'boolean') return `${pr}.Flag(${bool(v)})`;
  if (Number.isInteger(v)) return `${pr}.Count(${v})`;
  if (Array.isArray(v)) return `${pr}.Texts(${list(string)(v, ctx)})`;
  throw new Error(`cannot print ${JSON.stringify(v)} as a title field`);
};
const title = (v, ctx) => `[${Object.entries(v).map(([k, x]) => `#(${string(k)}, ${titleField(x, ctx)})`).join(', ')}]`;
const eventOrg = record({
  module: PR,
  constructor: 'EventOrg',
  fields: { id: ['id', option(ident('org'))], name: ['name', option(string)] },
});
const trialMark = record({
  module: PR,
  constructor: 'TrialMark',
  fields: { legacy: ['legacy', bool], attendedSessions: ['attended_sessions', option(int)] },
  defaults: { attended_sessions: 'None' },
});
const eventRecord = record({
  module: PR,
  constructor: 'Event',
  fields: {
    id: ['id', string],
    type: ['type_', string],
    when: ['when', when_],
    title: ['title', title],
    org: ['org', option(eventOrg)],
    provenance: ['provenance', provenance],
    visibility: ['visibility', visibility],
    publicEligible: ['public_eligible', bool],
    current: ['current', option(bool)],
    source: ['source', source],
    trial: ['trial', option(trialMark)],
  },
  // A bare event (temporalConflicts reads only its id and date) takes any value for the rest.
  defaults: {
    type_: '""',
    title: '[]',
    org: 'None',
    provenance: (ctx) => `${ctx.use(PR)}.PlayerSubmitted`,
    visibility: (ctx) => `${ctx.use(PR)}.Private`,
    public_eligible: 'False',
    current: 'None',
    source: (ctx) => `${ctx.use(PR)}.Source("", "")`,
    trial: 'None',
  },
});
/** A timeline event: its trial marks are one field here. */
const event_ = (e, ctx) => {
  const { legacy, attendedSessions, ...rest } = e;
  return eventRecord(legacy === undefined ? rest : { ...rest, trial: { legacy, attendedSessions } }, ctx);
};
const historyRow = record({
  module: PR,
  constructor: 'HistoryRow',
  fields: {
    key: ['key', string],
    orgId: ['org_id', option(ident('org'))],
    orgName: ['org_name', option(string)],
    role: ['role', option(string)],
    from: ['from', option(when_)],
    to: ['to', option(when_)],
    current: ['current', bool],
    provenance: ['provenance', provenance],
    source: ['source', source],
  },
  ignore: ['assurance'],
  defaults: { org_id: 'None', org_name: 'None', role: 'None', to: 'None', source: (ctx) => `${ctx.use(PR)}.Source("", "")` },
});
const history = record({
  module: PR,
  constructor: 'History',
  fields: {
    rows: ['rows', list(historyRow)],
    foldedConflicts: [
      'folded',
      list(record({ module: PR, constructor: 'Folded', fields: { entryId: ['entry_id', ident('career_entry')], into: ['into', string] } })),
    ],
  },
});
const signingRow = record({
  module: PR,
  constructor: 'SigningRow',
  fields: {
    id: ['id', ident('signing')],
    orgId: ['org_id', ident('org')],
    orgName: ['org_name', option(string)],
    ts: ['ts', int],
    endedAt: ['ended_at', option(int)],
    orgSuspended: ['org_suspended', bool],
  },
  defaults: { org_name: 'None', ended_at: 'None', org_suspended: 'False' },
});
const positions = record({
  module: PR,
  constructor: 'Positions',
  fields: { primary: ['primary', option(positionV)], secondary: ['secondary', list(positionV)] },
});
const prefs = record({
  module: PR,
  constructor: 'Prefs',
  fields: {
    bio: ['bio', option(string)],
    positions: ['positions', option(positions)],
    availability: ['availability', option(availabilityV)],
    availableFrom: ['available_from', option(string)],
    publicSelections: ['public_selections', list(string)],
    positionHistory: ['position_history', list(positionEntry)],
  },
});
/** ScoutBox's identity confirmation: a fixed record, or null. */
const identity = (v) => {
  if (v === null || v === undefined) return 'False';
  if (v.confirmed === true && v.assurance === 'scoutbox_document_review') return 'True';
  throw new Error(`cannot print ${JSON.stringify(v)} as an identity`);
};
const pFacts = record({
  module: PR,
  constructor: 'Facts',
  fields: {
    hasRecentFullMatch: ['has_recent_full_match', bool],
    fullMatchCount: ['full_match_count', int],
    clipCount: ['clip_count', int],
    referenceCount: ['reference_count', int],
    hasConfirmedCurrentClub: ['has_confirmed_current_club', bool],
    hasRecentAssessment: ['has_recent_assessment', bool],
    hasPosition: ['has_position', bool],
    hasAvailability: ['has_availability', bool],
    identityConfirmed: ['identity_confirmed', bool],
    historyRows: ['history_rows', int],
    hasRecentTrainingEvidence: ['has_recent_training_evidence', bool],
  },
  // An absent fact reads as false, as `!f.x` does.
  defaults: { has_recent_training_evidence: 'False' },
});
const pGap = record({
  module: PR,
  constructor: 'Gap',
  fields: { id: ['id', string], version: ['version', int], category: ['category', string] },
});
const completenessV = (c, ctx) =>
  `${ctx.use(PR)}.Completeness(coverage: ${string(c.evidenceCoverage)}, gaps: ${list(pGap)(c.gaps, ctx)}, satisfied: ${int(c.eligibility.satisfied)}, total: ${int(c.eligibility.total)})`;
const currentClub = record({
  module: PR,
  constructor: 'CurrentClub',
  fields: {
    orgId: ['org_id', option(ident('org'))],
    orgName: ['org_name', option(string)],
    role: ['role', option(string)],
    since: ['since', option(string)],
    provenance: ['provenance', provenance],
  },
  ignore: ['assurance'],
});
const pStatus = record({
  module: PR,
  constructor: 'Status',
  fields: {
    currentClub: ['current_club', option(currentClub)],
    positions: ['positions', option(positions)],
    availability: ['availability', option(availabilityV)],
    availableFrom: ['available_from', option(string)],
    // Its `since` is shown as a day; the Gleam record holds the instant it was read from.
    representation: ['representation', option(unsupported('a representation'))],
    identity: ['identity', identity],
    conflicts: ['conflicts', list(unsupported('a club conflict'))],
  },
});
const pair = (a, b) => (v, ctx) => `#(${int(v[a])}, ${int(v[b])})`;
const full = record({
  module: PR,
  constructor: 'Full',
  fields: {
    player: [
      'player',
      record({
        module: PR,
        constructor: 'PlayerFacts',
        fields: {
          id: ['id', ident('player')],
          name: ['name', string],
          age: ['age', option(int)],
          minor: ['minor', bool],
          position: ['position', option(positionV)],
          city: ['city', option(string)],
          level: ['level', option(levelV)],
        },
      }),
    ],
    identity: ['identity', identity],
    prefs: ['prefs', option(prefs)],
    history: ['history', history],
    status: ['status', pStatus],
    timeline: ['timeline', list(event_)],
    temporalConflicts: ['temporal_conflicts', list(unsupported('a temporal conflict'))],
    evidenceSummary: [
      'evidence_summary',
      record({
        module: PR,
        constructor: 'EvidenceSummary',
        fields: {
          fullMatches: ['full_matches', int],
          clips: ['clips', int],
          assessments: ['assessments', int],
          references: ['references', int],
          lastEvidenceDays: ['last_evidence_days', option(int)],
          note: ['note', string],
        },
      }),
    ],
    references: ['references', list(reference)],
    achievements: ['achievements', list(achievement)],
    developmentSummary: ['development_summary', pair('active', 'completed')],
    trialsSummary: ['trials_summary', pair('total', 'withReport')],
    completeness: ['completeness', completenessV],
    sharingSummary: ['sharing_active', (v) => int(v.active)],
    // What buildFor filters to the viewing organisation; the Gleam projection filters them itself.
    assessmentsForOrg: ['assessments', list(assessment)],
    trialsForOrg: ['trials', list(trial)],
  },
  defaults: {
    development_activity: 'None',
    combine: 'None',
    box_share_recruitment: 'False',
    sharing_active: '0',
    assessments: '[]',
    trials: '[]',
    timeline: '[]',
    temporal_conflicts: '[]',
    revision_evidence: '[]',
    revision_careers: '[]',
    revision_combine: '[]',
  },
});

// What `passportRevision` reads of a Passport: its content, never the projected fields, the viewer or the clock.
const evidenceSource = record({
  module: PR,
  constructor: 'EvidenceSource',
  fields: {
    id: ['id', ident('scouting_evidence')],
    tier: ['tier', vocab(EVIDENCE_ROWS, 'verification_status_pairs')],
    superseded: ['superseded', bool],
    expired: ['expired', bool],
  },
  defaults: {
    claim_type: (ctx) => vocab(EVIDENCE_ROWS, 'claim_type_pairs')('statistic', ctx),
    label: '""',
    recorded_at: '0',
    source_kind: (ctx) => vocab(EVIDENCE_ROWS, 'source_kind_pairs')('player', ctx),
  },
});
const careerMark = record({
  module: PR,
  constructor: 'CareerMark',
  fields: { id: ['id', ident('career_entry')], withdrawnAt: ['withdrawn', (v) => bool(v !== null && v !== undefined)] },
  defaults: { withdrawn: 'False' },
});
/** A Combine Verified personal best. The Gleam record holds only verified ones: an invalidated result is absent. */
const combineMark = (v, ctx) => {
  if (v.combineVerified !== true) throw new Error(`cannot print ${JSON.stringify(v)} as a Combine Verified result`);
  return `${ctx.use(PR)}.CombineMark(protocol_id: ${string(v.protocolId)}, protocol_version: ${int(v.protocolVersion)}, measured_value: ${float(v.measuredValue)})`;
};
const revisionFull = record({
  module: PR,
  constructor: 'Full',
  fields: {
    player: [
      'player',
      record({
        module: PR,
        constructor: 'PlayerFacts',
        fields: { position: ['position', option(positionV)], level: ['level', option(levelV)], age: ['age', option(int)] },
        defaults: { id: anyPlayer, name: '""', age: 'None', minor: 'False', position: 'None', city: 'None', level: 'None' },
      }),
    ],
    identity: ['identity', identity],
    status: [
      'status',
      record({
        module: PR,
        constructor: 'Status',
        fields: {
          currentClub: [
            'current_club',
            option(
              record({
                module: PR,
                constructor: 'CurrentClub',
                fields: { orgId: ['org_id', option(ident('org'))], provenance: ['provenance', provenance] },
                defaults: { org_id: 'None', org_name: 'None', role: 'None', since: 'None' },
              }),
            ),
          ],
        },
        defaults: {
          current_club: 'None',
          positions: 'None',
          availability: 'None',
          available_from: 'None',
          representation: 'None',
          identity: 'False',
          conflicts: '[]',
        },
      }),
    ],
    history: [
      'history',
      record({ module: PR, constructor: 'History', fields: { rows: ['rows', list(historyRow)] }, defaults: { folded: '[]' } }),
    ],
    revisionSources: (v, ctx) => {
      const { evidence = [], careerEntries = [], ...rest } = v;
      if (Object.keys(rest).length) throw new Error(`no revision source ${Object.keys(rest)[0]}`);
      return [
        ['revision_evidence', list(evidenceSource)(evidence, ctx)],
        ['revision_careers', list(careerMark)(careerEntries, ctx)],
      ];
    },
    references: ['references', list(reference)],
    achievements: ['achievements', list(achievement)],
    combine: (v, ctx) => [['revision_combine', list(combineMark)(v?.results ?? [], ctx)]],
  },
  // Clock noise the suite adds to show the revision ignores it; the Gleam record has no place for it.
  ignore: ['daysSinceLastEvidence', 'generatedAt', 'summary'],
  defaults: {
    prefs: 'None',
    evidence_summary: (ctx) => `${ctx.use(PR)}.EvidenceSummary(0, 0, 0, 0, None, "")`,
    references: '[]',
    achievements: '[]',
    development_summary: '#(0, 0)',
    trials_summary: '#(0, 0)',
    completeness: (ctx) => `${ctx.use(PR)}.Completeness("", [], 0, 0)`,
    development_activity: 'None',
    combine: 'None',
    box_share_recruitment: 'False',
    sharing_active: '0',
    assessments: '[]',
    trials: '[]',
    timeline: '[]',
    temporal_conflicts: '[]',
    revision_evidence: '[]',
    revision_careers: '[]',
    revision_combine: '[]',
  },
});

const PASSPORT_MAP = {
  [`${PASSPORT}#evId`]: passport('ev_id', [string, string, string], string),
  [`${PASSPORT}#provRank`]: passport('provenance_rank', [provenance], int),
  [`${PASSPORT}#provenanceFromMethod`]: passport('provenance_from_method', [string], provenance),
  [`${PASSPORT}#viewerSees`]: passport('viewer_sees', [viewer, visibility], bool),
  [`${PASSPORT}#whenDisplay`]: passport('when_display', [when_], string),
  [`${PASSPORT}#sha256`]: passport('sha256', [string], string),
  [`${PASSPORT}#normWhen`]: {
    module: PR,
    test: (c, ctx) => {
      const [input] = c.args;
      const pr = ctx.use(PR);
      if (typeof input === 'string') return eq(`${pr}.when_of(${string(input)})`, option(when_)(c.result, ctx));
      if (Number.isInteger(input)) return eq(`${pr}.when_at(${int(input)})`, when_(c.result, ctx));
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const { year, month = null, ...rest } = input;
        if (Object.keys(rest).length) throw new Error(`cannot print ${JSON.stringify(input)} as a year and month`);
        return eq(`${pr}.when_of_year(${int(year)}, ${option(int)(month, ctx)})`, option(when_)(c.result, ctx));
      }
      throw new Error(`cannot print ${JSON.stringify(input)} as a date`);
    },
  },
  [`${PASSPORT}#buildTimeline`]: passport('build_timeline', [sources], list(event_)),
  [`${PASSPORT}#clubHistory`]: {
    module: PR,
    test: (c, ctx) => {
      const { signingRows = [], squads = [], careerEntries = [], affiliations = [], ...rest } = c.args[0];
      if (affiliations.length || Object.keys(rest).length)
        throw new Error(`cannot print ${JSON.stringify(c.args[0])} as club history sources`);
      return eq(
        `${ctx.use(PR)}.club_history(${list(signingRow)(signingRows, ctx)}, ${list(squad)(squads, ctx)}, ${list(career)(careerEntries, ctx)})`,
        history(c.result, ctx),
      );
    },
  },
  [`${PASSPORT}#currentStatus`]: {
    module: PR,
    test: (c, ctx) => {
      const { history: h, prefs: p = null, agreements = [], identity: i = null, ...rest } = c.args[0];
      if (agreements.length || Object.keys(rest).length)
        throw new Error(`cannot print ${JSON.stringify(c.args[0])} as current-status inputs`);
      return eqJson(
        `${ctx.use(PR)}.status_json(${ctx.use(PR)}.current_status(${history(h, ctx)}, ${option(prefs)(p, ctx)}, None, ${identity(i)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${PASSPORT}#temporalConflicts`]: {
    module: PR,
    now: true,
    test: (c, ctx) => {
      const { events = [], history: h = [], dob = null } = c.args[0];
      return eqJson(
        `${ctx.use('gleam/json')}.array(${ctx.use(PR)}.temporal_conflicts(${list(event_)(events, ctx)}, ${list(historyRow)(h, ctx)}, ${option(string)(dob, ctx)}, ${ctx.now}), ${ctx.use(PR)}.temporal_conflict_json)`,
        c.result,
        ctx,
      );
    },
  },
  [`${PASSPORT}#evaluateGaps`]: {
    module: PR,
    test: (c, ctx) =>
      eqJson(
        `${ctx.use('gleam/json')}.array(${ctx.use(PR)}.evaluate_gaps(${pFacts(c.args[0], ctx)}), ${ctx.use(PR)}.gap_json)`,
        c.result,
        ctx,
      ),
  },
  [`${PASSPORT}#completeness`]: {
    module: PR,
    test: (c, ctx) =>
      eqJson(`${ctx.use(PR)}.completeness_json(${ctx.use(PR)}.completeness(${pFacts(c.args[0], ctx)}))`, c.result, ctx),
  },
  [`${PASSPORT}#shareProblem`]: {
    module: PR,
    now: true,
    test: (c, ctx) => {
      const [share, { now = ctx.now, playerRemoved = false } = {}] = c.args;
      const s =
        share === null ? 'None' : `Some(#(${option(int)(share.revokedAt ?? null, ctx)}, ${option(int)(share.expiresAt ?? null, ctx)}))`;
      return eq(
        `${ctx.use(PR)}.share_problem(${s}, ${int(now)}, ${bool(playerRemoved)})`,
        option(code(PR, 'share_problem_code'))(c.result, ctx),
      );
    },
  },
  [`${PASSPORT}#passportRevision`]: passport('passport_revision', [revisionFull], string),
  [`${PASSPORT}#projectPassport`]: {
    module: PR,
    test: (c, ctx) => {
      const [f, v, { orgId = null, shareMode = null } = {}] = c.args;
      return eqJson(
        `${ctx.use(PR)}.project(${full(f, ctx)}, ${viewer(v, ctx)}, ${ctx.use(PR)}.Opts(org_id: ${option(ident('org'))(orgId, ctx)}, share_mode: ${option(string)(shareMode, ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
};

// ------------------------------------------------------------------------------------------------- Trust Score

const TRUST = 'domains/passport/trust/shared.mjs';
const TR = 'scoutbox/passport/trust_rules';
const TRUST_SPEC = JSON.parse(readFileSync(new URL('../../e2e/support/spec/passport/trust/shared.json', import.meta.url)));

const assurance = (v, ctx) => {
  const c = { authoritative: 'Authoritative', organisation_attested: 'OrganisationAttested', scoutbox_document_review: 'ScoutboxDocumentReview' }[v];
  if (!c) throw new Error(`cannot print ${JSON.stringify(v)} as an identity assurance`);
  return `${ctx.use(TR)}.${c}`;
};
const relationshipKind = (v, ctx) => {
  const c = { club: 'ClubRelationship', coach: 'CoachRelationship', agency: 'AgencyRelationship' }[v];
  if (!c) throw new Error(`cannot print ${JSON.stringify(v)} as a relationship kind`);
  return `${ctx.use(TR)}.${c}`;
};
const historyRowT = record({
  module: TR,
  constructor: 'HistoryRow',
  fields: { key: ['key', string], provenance: ['provenance', string], current: ['current', bool] },
  defaults: { current: 'False' },
});
const relationshipT = record({
  module: TR,
  constructor: 'Relationship',
  fields: { key: ['key', string], kind: ['kind', relationshipKind], verified: ['verified', bool] },
  defaults: { verified: 'False' },
});
const evidenceItemT = record({
  module: TR,
  constructor: 'EvidenceItem',
  fields: { key: ['key', string], provenance: ['provenance', string], recordedAt: ['recorded_at', int] },
});
const boxSessionT = record({
  module: TR,
  constructor: 'BoxSession',
  fields: {
    key: ['key', string],
    verificationState: ['verification_state', option(string)],
    simulated: ['simulated', bool],
    endedAt: ['ended_at', int],
  },
  defaults: { verification_state: 'None', simulated: 'False' },
});
const combineAttemptT = record({
  module: TR,
  constructor: 'CombineAttempt',
  fields: {
    key: ['key', string],
    protocolId: ['protocol_id', string],
    protocolVersion: ['protocol_version', int],
    combineState: ['combine_state', string],
    simulated: ['simulated', bool],
  },
  defaults: { simulated: 'False' },
});
const referenceT = record({
  module: TR,
  constructor: 'Reference',
  fields: { key: ['key', string], verified: ['verified', bool] },
  defaults: { verified: 'False' },
});
/** An assessment counts by attribution: its content (rating, verdict) is never read, so the type has no place for it. */
const assessmentT = record({
  module: TR,
  constructor: 'AssessmentSource',
  fields: { key: ['key', string], verifiedSource: ['verified_source', bool] },
  ignore: ['rating', 'verdict'],
  defaults: { verified_source: 'False' },
});
/** What the engine is never given, though a caller may pass it: prestige, popularity, recruitment outcomes and
 *  payment (U9). The Gleam input has no place for any of them. */
const NOT_INPUTS = ['followers', 'profileViews', 'watchlists', 'trialsOffered', 'scoutsInterested', 'subscription', 'paidVerification', 'signedForBigClub'];
const trustInput = (v, ctx) => {
  const {
    playerContext = { isAdult: true },
    identity: id_ = null,
    historyRows = [],
    relationships = [],
    evidenceItems = [],
    boxCamSessions = [],
    combineAttempts = [],
    references = [],
    assessments = [],
    allowSimulatedEvidence = false,
    ...rest
  } = v ?? {};
  const unknown = Object.keys(rest).filter((k) => !NOT_INPUTS.includes(k));
  if (unknown.length) throw new Error(`Input has no field for the JavaScript key ${unknown[0]}`);
  const { isAdult, ...pc } = playerContext;
  if (Object.keys(pc).length) throw new Error(`cannot print the player context ${JSON.stringify(playerContext)}`);
  if (id_ !== null && Object.keys(id_).some((k) => k !== 'assurance'))
    throw new Error(`cannot print the identity ${JSON.stringify(id_)}`);
  return `${ctx.use(TR)}.Input(is_adult: ${bool(isAdult !== false)}, identity: ${option(assurance)(id_?.assurance ?? null, ctx)}, history: ${list(historyRowT)(historyRows, ctx)}, relationships: ${list(relationshipT)(relationships, ctx)}, evidence: ${list(evidenceItemT)(evidenceItems, ctx)}, box_sessions: ${list(boxSessionT)(boxCamSessions, ctx)}, combine: ${list(combineAttemptT)(combineAttempts, ctx)}, references: ${list(referenceT)(references, ctx)}, assessments: ${list(assessmentT)(assessments, ctx)}, allow_simulated: ${bool(!!allowSimulatedEvidence)})`;
};
const signalT = record({ module: TR, constructor: 'Signal', fields: { code: ['code', string], text: ['text', string] } });
/** A component as the engine built it. Its available and earned weight are derived from its weight and coverage. */
const componentT = (c, ctx) => {
  const { weight, availableWeight, coverageBp, earnedWeightBp, level, reasons, strengths, gaps, detail, ...rest } = c;
  if (Object.keys(rest).length || availableWeight !== weight || earnedWeightBp !== weight * coverageBp)
    throw new Error(`cannot print the component ${JSON.stringify(c)}`);
  const det = Object.entries(detail).map(([k, x]) => `#(${string(k)}, ${jsonValue(x, ctx)})`);
  return `${ctx.use(TR)}.Component(weight: ${int(weight)}, coverage_bp: ${int(coverageBp)}, level: #(${string(level.id)}, ${string(level.label)}), reasons: ${list(string)(reasons, ctx)}, strengths: ${list(signalT)(strengths, ctx)}, gaps: ${list(signalT)(gaps, ctx)}, detail: [${det.join(', ')}])`;
};
/** A profile as calculateTrustScore returned it. Its strengths, gaps and explanations are derived from its
 *  components, its band from its score. */
const profileT = (p, ctx) => {
  const band = TRUST_SPEC.POLICY.bands.find((b) => p.score >= b.min && p.score <= b.max);
  if (!band || band.id !== p.band || p.policyVersion !== TRUST_SPEC.TRUST_SCORE_POLICY_VERSION)
    throw new Error(`cannot print the profile ${JSON.stringify(p).slice(0, 200)}`);
  const components = Object.entries(p.components).map(([k, c]) => `#(${string(k)}, ${componentT(c, ctx)})`);
  return `${ctx.use(TR)}.Profile(score: ${int(p.score)}, band: ${ctx.use(TR)}.band_for_score(${int(p.score)}), components: [${components.join(', ')}], is_adult: ${bool(p.context.isAdult)}, simulated_included: ${bool(p.simulatedEvidenceIncluded)})`;
};
/** The viewers the projection has. No route asks for a public projection, so the type has none; nor for a viewer
 *  outside these. */
const trustViewer = (v, ctx) => {
  const c = { self: 'SelfViewer', guardian: 'GuardianViewer', trust_safety: 'TrustSafetyViewer', pro_club: 'ProClubViewer', grassroots_club: 'GrassrootsClubViewer' }[v];
  if (!c) throw new Error(`the projection has no viewer ${JSON.stringify(v)}`);
  return `${ctx.use(TR)}.${c}`;
};
const bandT = record({
  module: TR,
  constructor: 'Band',
  fields: { id: ['id', string], label: ['label', string], min: ['min', int], max: ['max', int] },
});

const TRUST_MAP = {
  [`${TRUST}#calculateTrustScore`]: {
    module: TR,
    test: (c, ctx) => eqJson(`${ctx.use(TR)}.profile_json(${ctx.use(TR)}.calculate(${trustInput(c.args[0], ctx)}))`, c.result, ctx),
  },
  [`${TRUST}#trustBandForScore`]: plainIn(TR)('band_for_score', [int], bandT),
  [`${TRUST}#applyDiminishingReturns`]: plainIn(TR)('diminishing_returns', [int, list(int)], int),
  [`${TRUST}#canonicalTrustSources`]: {
    module: TR,
    test: (c, ctx) => {
      const item = (it) => {
        const { key, strengthBp, ...rest } = it;
        if (Object.keys(rest).length) throw new Error(`cannot print the source ${JSON.stringify(it)}`);
        return `#(${string(key)}, ${int(strengthBp)}, Nil)`;
      };
      return eq(`${ctx.use(TR)}.canonical([${c.args[0].map(item).join(', ')}])`, `[${c.result.map(item).join(', ')}]`);
    },
  },
  [`${TRUST}#policyWeightsTotal`]: {
    module: TR,
    test: (c, ctx) => {
      if (c.args.length && JSON.stringify(c.args[0]) !== JSON.stringify(TRUST_SPEC.POLICY))
        throw new Error('the policy here is the snapshot POLICY only');
      return eq(`${ctx.use(TR)}.weights_total()`, int(c.result));
    },
  },
  [`${TRUST}#safeTrustProjection`]: {
    module: TR,
    test: (c, ctx) => {
      const [p, v, opts = {}] = c.args;
      if (Object.keys(opts).length) throw new Error(`the projection takes no options ${JSON.stringify(opts)}`);
      return eqJson(`${ctx.use(TR)}.projection(${profileT(p, ctx)}, ${trustViewer(v, ctx)})`, c.result, ctx);
    },
  },
  [`${TRUST}#trustSummary`]: {
    module: TR,
    test: (c, ctx) => eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(TR)}.summary_fields(${profileT(c.args[0], ctx)}))`, c.result, ctx),
  },
  [`${TRUST}#trustSnapshot`]: {
    module: TR,
    now: true,
    test: (c, ctx) => {
      const [p, { at = ctx.now } = {}] = c.args;
      return eqJson(`${ctx.use(TR)}.snapshot_json(${profileT(p, ctx)}, ${int(at)})`, c.result, ctx);
    },
  },
  ['domains/agents/core/shared.mjs#agreementInForce']: {
    module: 'scoutbox/passport/trust',
    now: true,
    test: (c, ctx) => {
      const [a, now = ctx.now] = c.args;
      return eq(`${ctx.use('scoutbox/passport/trust')}.agreement_in_force(${agreementRow(a, ctx)}, ${int(now)})`, bool(c.result));
    },
  },
};

// ---------------------------------------------------------------------------------------------------- Box Cam

const BOX = 'domains/development/boxcam';
const BCR = 'scoutbox/development/box_cam_rules';
const boxQuality = vocab('scoutbox/vocab/box_quality');
const boxState = vocab('scoutbox/rows/box_sessions', 'verification_state_pairs');
const boxReason = code(BCR, 'reason_to_string');
const capability = code(BCR, 'capability_to_string');
const boxTargetType = vocab('scoutbox/vocab/box_target_type');
const challengeMetric = vocab('scoutbox/rows/box_challenges', 'metric_pairs');
const boxProvider = vocab('scoutbox/vocab/box_provider');
const span = record({ module: BCR, constructor: 'Span', fields: { fromMs: ['from_ms', float], toMs: ['to_ms', float] } });
/** An active interval; one reported without a quality is good, as the engine reads it. */
const interval = record({
  module: BCR,
  constructor: 'Interval',
  fields: { fromMs: ['from_ms', float], toMs: ['to_ms', float], quality: ['quality', boxQuality] },
  defaults: { quality: (ctx) => `${ctx.use('scoutbox/vocab/box_quality')}.Good` },
});
const boxTarget = record({
  module: BCR,
  constructor: 'Target',
  fields: { type: ['type_', boxTargetType], value: ['value', float] },
});
/** A finished session as the streak and challenge progress read it: `at` is when it ended. */
const finished = record({
  module: BCR,
  constructor: 'Finished',
  fields: {
    id: ['id', string],
    drillId: ['drill_id', string],
    drillVersion: ['drill_version', int],
    verificationState: ['state', option(boxState)],
    verifiedActiveMs: ['verified_active_ms', float],
    verifiedReps: ['verified_reps', option(int)],
    endedAt: ['at', int],
  },
  defaults: { id: '""', drill_id: '""', drill_version: '1', state: 'None', verified_active_ms: '0.0', verified_reps: 'None' },
});
const boxRules = plainIn(BCR);

const BOX_CAM_MAP = {
  [`${BOX}/shared.mjs#verifiedActiveMs`]: {
    module: BCR,
    test: (c, ctx) => {
      const { activeIntervals = [], pauses = [], interruptions = [], sessionDurationMs = 0, requiredIntervals = null, ...rest } =
        c.args[0];
      if (Object.keys(rest).length) throw new Error(`verifiedActiveMs has no argument ${Object.keys(rest)[0]}`);
      return eq(
        `${ctx.use(BCR)}.verified_active_ms(active: ${list(interval)(activeIntervals, ctx)}, pauses: ${list(span)(pauses, ctx)}, interruptions: ${list(span)(interruptions, ctx)}, session_duration_ms: ${float(sessionDurationMs)}, required: ${option(list(span))(requiredIntervals, ctx)})`,
        float(c.result),
      );
    },
  },
  [`${BOX}/shared.mjs#targetCompleted`]: {
    module: BCR,
    test: (c, ctx) => {
      const [target, { activeMs = 0, reps = null, setsCompleted = 0 }, caps = []] = c.args;
      return eq(
        `${ctx.use(BCR)}.target_completed(${boxTarget(target, ctx)}, active_ms: ${float(activeMs)}, reps: ${option(int)(reps, ctx)}, sets_completed: ${int(setsCompleted)}, capabilities: ${list(capability)(caps, ctx)})`,
        option(bool)(c.result, ctx),
      );
    },
  },
  [`${BOX}/shared.mjs#mergeIntervals`]: boxRules('merge_intervals', [list(span)], list(span)),
  [`${BOX}/shared.mjs#intersectIntervals`]: boxRules('intersect_intervals', [list(span), list(span)], list(span)),
  [`${BOX}/shared.mjs#subtractIntervals`]: boxRules('subtract_intervals', [list(span), list(span)], list(span)),
  [`${BOX}/shared.mjs#detectionQuality`]: {
    module: BCR,
    test: (c, ctx) => {
      const { observedMs = 0, sessionDurationMs = 0 } = c.args[0];
      return eq(
        `${ctx.use(BCR)}.detection_quality(observed_ms: ${float(observedMs)}, session_duration_ms: ${float(sessionDurationMs)})`,
        boxQuality(c.result, ctx),
      );
    },
  },
  [`${BOX}/shared.mjs#dedupeReps`]: {
    module: BCR,
    test: (c, ctx) => {
      const [reps, { sessionDurationMs = null, minGapMs = 250, minConfidence = 0.5 } = {}] = c.args;
      const rep = record({
        module: BCR,
        constructor: 'Rep',
        fields: { atMs: ['at_ms', float], confidence: ['confidence', option(float)] },
        defaults: { confidence: 'None' },
      });
      const counted = record({
        module: BCR,
        constructor: 'CountedRep',
        fields: { atMs: ['at_ms', float], confidence: ['confidence', float] },
      });
      return eq(
        `${ctx.use(BCR)}.dedupe_reps(${list(rep)(reps, ctx)}, session_duration_ms: ${option(float)(sessionDurationMs, ctx)}, min_gap_ms: ${float(minGapMs)}, min_confidence: ${float(minConfidence)})`,
        list(counted)(c.result, ctx),
      );
    },
  },
  [`${BOX}/shared.mjs#deriveVerification`]: {
    module: BCR,
    test: (c, ctx) => {
      const {
        cancelled = false,
        livenessPassed = false,
        providerAvailable = true,
        activeMs = 0,
        completed = null,
        quality = null,
        interruptionsCount = 0,
        unsupportedTargetMetric = false,
        sessionDurationMs: _unread,
        ...rest
      } = c.args[0];
      if (Object.keys(rest).length) throw new Error(`deriveVerification has no argument ${Object.keys(rest)[0]}`);
      return eq(
        `${ctx.use(BCR)}.derive_verification(${ctx.use(BCR)}.Observed(cancelled: ${bool(cancelled)}, liveness_passed: ${bool(livenessPassed)}, provider_available: ${bool(providerAvailable)}, active_ms: ${float(activeMs)}, completed: ${option(bool)(completed, ctx)}, quality: ${option(boxQuality)(quality, ctx)}, interruptions_count: ${int(interruptionsCount)}, unsupported_target_metric: ${bool(unsupportedTargetMetric)}))`,
        `#(${boxState(c.result.state, ctx)}, ${list(boxReason)(c.result.reasons, ctx)})`,
      );
    },
  },
  [`${BOX}/shared.mjs#boxStreakWeeks`]: boxRules('box_streak_weeks', [list(finished), int], int),
  [`${BOX}/shared.mjs#challengeProgress`]: {
    module: BCR,
    test: (c, ctx) => {
      const window = record({
        module: BCR,
        constructor: 'ChallengeWindow',
        fields: {
          drillId: ['drill_id', string],
          metric: ['metric', challengeMetric],
          targetTotal: ['target_total', int],
          startsAt: ['starts_at', int],
          endsAt: ['ends_at', int],
        },
        defaults: { starts_at: '0', ends_at: '0' },
      });
      const { total, completed, sessionIds } = c.result;
      return eq(
        `${ctx.use(BCR)}.challenge_progress(${window(c.args[0], ctx)}, ${list(finished)(c.args[1], ctx)})`,
        `${ctx.use(BCR)}.Progress(total: ${int(total)}, completed: ${bool(completed)}, session_ids: ${list(string)(sessionIds, ctx)})`,
      );
    },
  },
  // The registry itself is compared with the snapshot (spec_test); these check the lookups.
  [`${BOX}/drills.mjs#providerFor`]: {
    module: BCR,
    test: (c, ctx) => {
      const [id, { testProviderEnabled = false } = {}] = c.args;
      return eq(
        `${ctx.use(BCR)}.provider_for(${string(id)}, ${bool(testProviderEnabled)})`,
        c.result === null ? 'None' : `Some(${ctx.use(BCR)}.provider(${boxProvider(c.result.id, ctx)}))`,
      );
    },
  },
  [`${BOX}/drills.mjs#drillByIdVersion`]: {
    module: BCR,
    test: (c, ctx) => {
      const [id, version] = c.args;
      const found = c.result === null ? 'None' : `Some(#(${string(c.result.id)}, ${int(c.result.version)}))`;
      return eq(
        `${ctx.use('gleam/option')}.map(${ctx.use(BCR)}.drill_by_id_version(${string(id)}, ${int(version)}), fn(d) { #(d.id, d.version) })`,
        found,
      );
    },
  },
};

// ---------------------------------------------------------------------------------------------- the Combine

const CS = `${BOX}/combineShared.mjs`;
const CR = 'scoutbox/development/combine_rules';
const combineState = vocab('scoutbox/rows/combine_attempts', 'combine_state_pairs');
const measurementState = vocab('scoutbox/rows/combine_attempts', 'measurement_state_pairs');
const metricType = vocab('scoutbox/rows/combine_attempts', 'metric_type_pairs');
const direction = vocab('scoutbox/rows/combine_attempts', 'direction_pairs');
/** A protocol is the registry's own (spec_test proves it equals the snapshot): looked up by id and version. */
const protocolOf = (v, ctx) => {
  if (typeof v?.id !== 'string' || !Number.isInteger(v?.version)) throw new Error(`not a protocol: ${JSON.stringify(v)}`);
  return `${ctx.use(CR)}.protocol(${string(v.id)}, ${int(v.version)})`;
};
const protocolDef = (v, ctx) => `{ let assert ${ctx.use('gleam/option')}.Some(p) = ${protocolOf(v, ctx)}\n p }`;
const found = (c) => (c === null ? 'None' : `Some(#(${string(c.id)}, ${int(c.version)}))`);
const idVersion = (ctx) => `fn(p: ${ctx.use(CR)}.Protocol) { #(p.id, p.version) }`;
const finishedSession = record({
  module: CR,
  constructor: 'Finished',
  fields: {
    verificationState: ['state', option(boxState)],
    sessionDurationMs: ['session_duration_ms', option(float)],
    verifiedActiveMs: ['verified_active_ms', option(float)],
    verifiedReps: ['verified_reps', option(int)],
    setsCompleted: ['sets_completed', option(int)],
    quality: ['quality', option(boxQuality)],
  },
  defaults: {
    state: 'None',
    session_duration_ms: 'None',
    verified_active_ms: 'None',
    verified_reps: 'None',
    sets_completed: 'None',
    quality: 'None',
  },
});
/** An attempt as `personalBest` reads it; the Gleam one carries its item, here nothing. */
const scored = record({
  module: CR,
  constructor: 'Scored',
  fields: {
    measuredValue: ['measured_value', option(float)],
    direction: ['direction', direction],
    effectiveState: ['live_state', combineState],
  },
  defaults: { item: 'Nil', measured_value: 'None', direction: (ctx) => `${ctx.use('scoutbox/rows/combine_attempts')}.Higher` },
});
/** A capability a protocol needs: an observed one, or one only future athletic protocols name. */
const required = (v, ctx) =>
  ['spatial_scale', 'timing_gate', 'target_zone'].includes(v)
    ? code(CR, 'required_to_string')(v, ctx)
    : `${ctx.use(CR)}.Observes(${capability(v, ctx)})`;

const COMBINE_MAP = {
  [`${CS}#combineProtocol`]: {
    module: CR,
    test: (c, ctx) =>
      eq(
        `${ctx.use('gleam/option')}.map(${ctx.use(CR)}.protocol(${string(c.args[0])}, ${int(Number(c.args[1]))}), ${idVersion(ctx)})`,
        found(c.result),
      ),
  },
  [`${CS}#latestCombineProtocol`]: {
    module: CR,
    test: (c, ctx) =>
      eq(`${ctx.use('gleam/option')}.map(${ctx.use(CR)}.latest_protocol(${string(c.args[0])}), ${idVersion(ctx)})`, found(c.result)),
  },
  [`${CS}#measurementSupported`]: {
    module: CR,
    test: (c, ctx) =>
      eq(`${ctx.use(CR)}.measurement_supported(${protocolDef(c.args[0], ctx)}, ${list(capability)(c.args[1] ?? [], ctx)})`, bool(c.result)),
  },
  [`${CS}#measurementCapability`]: {
    module: CR,
    test: (c, ctx) =>
      eq(`${ctx.use(CR)}.measurement_capability(${protocolDef(c.args[0], ctx)}, ${list(capability)(c.args[1] ?? [], ctx)})`, string(c.result)),
  },
  [`${CS}#measureAttempt`]: {
    module: CR,
    test: (c, ctx) => {
      const { protocolDef: p, session, calibrationPassed, providerCapabilities = [], mode = 'verified', ...rest } = c.args[0];
      if (Object.keys(rest).length) throw new Error(`measureAttempt has no argument ${Object.keys(rest)[0]}`);
      const { combineState: cs, measurementState: ms, measuredValue, reasons, observedMs, windowMs, missingCapabilities = [], practice, ...more } =
        c.result;
      if (Object.keys(more).length) throw new Error(`a measurement has no field ${Object.keys(more)[0]}`);
      if ((practice === true) !== (ms === 'practice')) throw new Error('practice is read from the measurement state');
      return eq(
        `${ctx.use(CR)}.measure(protocol: ${p ? `${protocolOf(p, ctx)}` : 'None'}, session: ${option(finishedSession)(session, ctx)}, calibration_passed: ${bool(!!calibrationPassed)}, capabilities: ${list(capability)(providerCapabilities, ctx)}, practice: ${bool(mode === 'practice')})`,
        `${ctx.use(CR)}.Measurement(combine_state: ${combineState(cs, ctx)}, measurement_state: ${measurementState(ms, ctx)}, measured_value: ${option(float)(measuredValue, ctx)}, reasons: ${list(code(CR, 'reason_to_string'))(reasons, ctx)}, observed_ms: ${option(float)(observedMs, ctx)}, window_ms: ${option(int)(windowMs, ctx)}, missing: ${list(required)(missingCapabilities, ctx)})`,
      );
    },
  },
  [`${CS}#formatCombineValue`]: {
    module: CR,
    test: (c, ctx) => eq(`${ctx.use(CR)}.format(${protocolDef(c.args[0], ctx)}, ${option(float)(c.args[1], ctx)})`, string(c.result)),
  },
  [`${CS}#personalBest`]: {
    module: CR,
    test: (c, ctx) => eq(`${ctx.use(CR)}.personal_best(${list(scored)(c.args[0] ?? [], ctx)})`, option(scored)(c.result, ctx)),
  },
  [`${CS}#comparisonMatrix`]: {
    module: CR,
    test: (c, ctx) => {
      const { players, protocols, bestByPlayerProtocol } = c.args[0];
      const cell = record({
        module: CR,
        constructor: 'Cell',
        fields: { measuredValue: ['value', float], completedAt: ['at', option(int)] },
        defaults: { at: 'None' },
      });
      const pl = (v) => `#(${string(v.id)}, ${string(v.name)})`;
      return eqJson(
        `${ctx.use(CR)}.comparison(${list(pl)(players, ctx)}, ${list(protocolDef)(protocols, ctx)}, ${dict(string, cell)(bestByPlayerProtocol, ctx)})`,
        c.result,
        ctx,
      );
    },
  },
  [`${CS}#combineResultHash`]: {
    module: CR,
    test: (c, ctx) => {
      const hashed = record({
        module: CR,
        constructor: 'Hashed',
        fields: {
          id: ['attempt_id', string],
          playerId: ['player_id', string],
          protocolId: ['protocol_id', string],
          protocolVersion: ['protocol_version', int],
          boxSessionId: ['box_session_id', string],
          metricType: ['metric_type', metricType],
          measuredValue: ['measured_value', option(float)],
          provider: ['provider', boxProvider],
          providerVersion: ['provider_version', int],
          measurementAlgorithmVersion: ['measurement_algorithm_version', int],
          completedAt: ['completed_at', option(int)],
          combineState: ['combine_state', combineState],
        },
      });
      return eq(`${ctx.use(CR)}.result_hash(${hashed(c.args[0], ctx)})`, string(c.result));
    },
  },
};

// ------------------------------------------------------------------------------------------- the Development Hub

const HUB = 'domains/development/hub';
const HR = 'scoutbox/development/hub_rules';
const goalStatus = vocab('scoutbox/vocab/goal_status');
const planStatus = vocab('scoutbox/rows/development_plans', 'status_pairs');
const actionStatus = vocab('scoutbox/rows/development_actions', 'status_pairs');
const operator = vocab('scoutbox/rows/development_goals', 'target_operator_pairs');
const provider = vocab('scoutbox/vocab/box_provider');
const hubJson = (fnName, args) => ({
  module: HR,
  test: (c, ctx) => eqJson(`${ctx.use(HR)}.${fnName}(${args.map((p, i) => p(c.args[i], ctx)).join(', ')})`, c.result, ctx),
});
const target = record({
  module: HR,
  constructor: 'Target',
  fields: {
    protocolId: ['protocol_id', string],
    protocolVersion: ['protocol_version', int],
    metricType: ['metric_type', vocab('scoutbox/rows/development_goals', 'target_metric_type_pairs')],
    metricUnit: ['metric_unit', string],
    operator: ['operator', operator],
    value: ['value', float],
    protocolTitle: ['protocol_title', string],
    direction: ['direction', vocab('scoutbox/rows/development_goals', 'target_direction_pairs')],
    precision: ['precision', vocab('scoutbox/rows/development_goals', 'target_precision_pairs')],
  },
  ignore: ['sourceType'],
});
const targetInput = record({
  module: HR,
  constructor: 'TargetInput',
  fields: {
    sourceType: ['source_type', option(string)],
    protocolId: ['protocol_id', option(string)],
    protocolVersion: ['protocol_version', option(int)],
    metricType: ['metric_type', option(string)],
    operator: ['operator', option(string)],
    value: ['value', option(float)],
  },
  defaults: { source_type: 'None', protocol_id: 'None', protocol_version: 'None', metric_type: 'None', operator: 'None', value: 'None' },
});
/** A stored attempt as a target reads it, with its bound session's state (the rule is handed the sessions). */
const measured = (sessions) => (a, ctx) => {
  const { id, protocolId, protocolVersion, provider: p, combineState: cs, measuredValue, boxSessionId, completedAt, playerId: _p, ...rest } = a;
  if (Object.keys(rest).length) throw new Error(`a measured attempt has no field ${Object.keys(rest)[0]}`);
  const session = (sessions ?? []).find((s) => s.id === boxSessionId) ?? null;
  return `${ctx.use(HR)}.measured_of(${ident('combine_attempt')(id, ctx)}, ${string(protocolId)}, ${int(protocolVersion)}, ${option(float)(measuredValue, ctx)}, ${option(int)(completedAt, ctx)}, ${combineState(cs, ctx)}, ${option(boxState)(session?.verificationState, ctx)}, ${provider(p, ctx)})`;
};
/** A transition table is one of the three the Hub has, told apart by its first status. */
const transitionTable = (table) =>
  'not_started' in table
    ? ['goal_transitions', goalStatus]
    : 'draft' in table
      ? ['plan_transitions', planStatus]
      : 'todo' in table
        ? ['action_transitions', actionStatus]
        : (() => {
            throw new Error(`not a Development Hub transition table: ${JSON.stringify(table)}`);
          })();
const caps = (v, ctx) => {
  const { readInternal, ...rest } = v;
  if (Object.keys(rest).length) throw new Error(`reviewView reads readInternal only, not ${Object.keys(rest)[0]}`);
  return `${ctx.use(HR)}.Caps(..${ctx.use(HR)}.no_caps, read_internal: ${bool(!!readInternal)})`;
};
const devReview = (v, ctx) => {
  const { goalSnapshots = [], reviewedBy = null, ...rest } = v;
  if (goalSnapshots.length) throw new Error('a review with goal snapshots is ported by hand');
  const row = record({
    module: 'scoutbox/rows/development_reviews',
    constructor: 'Row',
    base: call(BASE, 'dev_review'),
    fields: {
      id: ['id', ident('dev_review')],
      planId: ['plan_id', ident('dev_plan')],
      reviewerKind: ['reviewer_kind', vocab('scoutbox/rows/development_reviews', 'reviewer_kind_pairs')],
      reviewedAt: ['reviewed_at', int],
      sharedSummary: ['shared_summary', option(string)],
      internalNote: ['internal_note', option(string)],
      sharedWithPlayerAt: ['shared_with_player_at', option(int)],
    },
  })({ ...rest, ...(reviewedBy ? {} : {}) }, ctx);
  const named = reviewedBy?.name
    ? `${ctx.use('scoutbox/rows/development_reviews')}.Row(..${row}, reviewed_by_name: ${option(string)(reviewedBy.name, ctx)})`
    : row;
  return `${ctx.use('scoutbox/development/hub')}.Review(row: ${named}, snapshots: [], superseded_by: ${ctx.use('gleam/option')}.None, history: [])`;
};

const HUB_MAP = {
  [`${HUB}/shared.mjs#dueState`]: {
    module: HR,
    test: (c, ctx) => eqJson(`${ctx.use(HR)}.due_json(${ctx.use(HR)}.due_state(${option(int)(c.args[0], ctx)}, ${int(c.args[1])}))`, c.result, ctx),
  },
  [`${HUB}/shared.mjs#reviewDueState`]: {
    module: HR,
    test: (c, ctx) =>
      eqJson(`${ctx.use(HR)}.due_json(${ctx.use(HR)}.review_due_state(${option(int)(c.args[0], ctx)}, ${int(c.args[1])}))`, c.result, ctx),
  },
  [`${HUB}/shared.mjs#utcDay`]: plainIn(HR)('utc_day', [int], int),
  [`${HUB}/shared.mjs#daysBetween`]: plainIn(HR)('days_between', [int, int], int),
  [`${HUB}/shared.mjs#boundedText`]: {
    module: HR,
    test: (c, ctx) =>
      eqJson(`${ctx.use(HR)}.bounded_text_json(${option(string)(c.args[0], ctx)}, ${int(c.args[1])}, ${string(c.args[2].field)})`, c.result, ctx),
  },
  [`${HUB}/shared.mjs#transitionAllowed`]: {
    module: HR,
    test: (c, ctx) => {
      const [table, from, to] = c.args;
      const [fnName, status] = transitionTable(table);
      return eq(`${ctx.use(HR)}.allowed(${ctx.use(HR)}.${fnName}, ${status(from, ctx)}, ${status(to, ctx)})`, bool(c.result));
    },
  },
  [`${HUB}/shared.mjs#actionCounts`]: {
    module: HR,
    test: (c, ctx) =>
      eqJson(`${ctx.use(HR)}.counts_json(${ctx.use(HR)}.action_counts(${list((a, x) => actionStatus(a.status, x))(c.args[0], ctx)}))`, c.result, ctx),
  },
  [`${HUB}/shared.mjs#completionPhrase`]: {
    module: HR,
    test: (c, ctx) => {
      const { total, done, cancelled } = c.args[0];
      return eqJson(`${ctx.use(HR)}.completion_json(${int(done)}, ${int(total)}, ${int(cancelled)})`, c.result, ctx);
    },
  },
  [`${HUB}/shared.mjs#refusedClientFields`]: {
    module: HR,
    test: (c, ctx) => eq(`${ctx.use(HR)}.refused_client_fields(${list(string)(Object.keys(c.args[0]), ctx)})`, list(string)(c.result, ctx)),
  },
  [`${HUB}/shared.mjs#scanCopyForForbiddenNames`]: {
    module: HR,
    test: (c, ctx) =>
      eq(`${ctx.use(HR)}.scan_copy(${list((p) => `#(${string(p[0])}, ${string(p[1])})`)(c.args[0], ctx)})`, list(string)(c.result, ctx)),
  },
  [`${HUB}/shared.mjs#assertDevelopmentVocabulary`]: {
    module: HR,
    test: (c, ctx) => {
      if (c.args.length) throw new Error('the vocabulary check takes no options here');
      return eqJson(`${ctx.use(HR)}.vocabulary_check()`, c.result, ctx);
    },
  },
  [`${HUB}/targets.mjs#compare`]: plainIn(HR)('compare', [float, operator, float], bool),
  [`${HUB}/targets.mjs#validateTarget`]: hubJson('validate_target_json', [targetInput]),
  [`${HUB}/targets.mjs#evaluateTarget`]: {
    module: HR,
    test: (c, ctx) => {
      const { target: t, attempts, sessions, ...rest } = c.args[0];
      if (Object.keys(rest).length) throw new Error(`evaluateTarget has no argument ${Object.keys(rest)[0]}`);
      if (t === null) throw new Error('a goal without a target is never evaluated here');
      return eqJson(
        `${ctx.use(HR)}.evaluation_json(${target(t, ctx)}, ${ctx.use(HR)}.evaluate_target(${target(t, ctx)}, ${list(measured(sessions))(attempts ?? [], ctx)}))`,
        c.result,
        ctx,
      );
    },
  },
  [`${HUB}/targets.mjs#bestValidAttempt`]: {
    module: HR,
    test: (c, ctx) => {
      const { target: t, attempts, sessions } = c.args[0];
      return eq(
        `${ctx.use('gleam/option')}.map(${ctx.use(HR)}.best_valid(${list(measured(sessions))(attempts ?? [], ctx)}, ${target(t, ctx)}), fn(m: ${ctx.use(HR)}.Measured) { m.id })`,
        option(ident('combine_attempt'))(c.result?.id, ctx),
      );
    },
  },
  [`${CS}#isProductionValidCombine`]: {
    module: HR,
    test: (c, ctx) => {
      const [attempt, session, prov] = c.args;
      if (attempt.provider !== prov?.id) throw new Error('the provider is the attempt’s own');
      return eq(`${ctx.use(HR)}.production_valid(${measured(session ? [session] : [])(attempt, ctx)})`, bool(c.result));
    },
  },
  [`${CS}#liveCombineState`]: {
    module: CR,
    test: (c, ctx) =>
      eq(
        `${ctx.use(CR)}.live_state(${combineState(c.args[0].combineState, ctx)}, ${option(boxState)(c.args[1]?.verificationState, ctx)})`,
        combineState(c.result, ctx),
      ),
  },
  [`${HUB}/evidence.mjs#summariseEvidence`]: {
    module: HR,
    test: (c, ctx) =>
      eqJson(`${ctx.use(HR)}.summarise_evidence(${list((e) => `#(${bool(e.available)}, ${bool(e.simulated)})`)(c.args[0], ctx)})`, c.result, ctx),
  },
  [`${HUB}/permissions.mjs#reviewView`]: {
    module: HR,
    test: (c, ctx) => eqJson(`${ctx.use(HR)}.review_json(${devReview(c.args[0], ctx)}, ${caps(c.args[1], ctx)})`, c.result, ctx),
  },
  [`${HUB}/reviews.mjs#pageReviews`]: {
    module: HR,
    test: (c, ctx) => {
      const [reviews, { limit = null, cursor = null }] = c.args;
      const pair = (r) => `#(${string(r.id)}, ${int(r.reviewedAt)})`;
      const call = `${ctx.use(HR)}.page_reviews(${list(pair)(reviews, ctx)}, ${option(int)(limit, ctx)}, ${option(string)(cursor, ctx)})`;
      if (c.result.error) return eq(call, 'Error(Nil)');
      const { items, total, nextCursor } = c.result.value;
      return eq(call, `Ok(#(${list(pair)(items, ctx)}, ${int(total)}, ${option(string)(nextCursor, ctx)}))`);
    },
  },
};

const SU = 'scoutbox/scouting/suitability';
const weeklySlot = record({
  module: SU,
  constructor: 'Slot',
  fields: { day: ['day', string], start: ['start', string], end: ['end', string], tz: ['tz', string], label: ['label', option(string)] },
  defaults: { label: 'None' },
});

const BUDGETS = 'scoutbox/recruitment/budgets';
const currency = vocab('scoutbox/vocab/currency');
const budgetLine = record({
  module: 'scoutbox/rows/case_budget_lines',
  constructor: 'Row',
  base: call(BASE, 'budget_line'),
  fields: {
    id: ['id', ident('budget_line')],
    kind: ['kind', vocab('scoutbox/rows/case_budget_lines', 'kind_pairs')],
    label: ['label', string],
    amountMinor: ['amount_minor', int],
    currency: ['currency', currency],
    schedule: ['schedule', vocab('scoutbox/rows/case_budget_lines', 'schedule_pairs')],
    confirmed: ['confirmed', bool],
    conditional: (v, ctx) => [['conditional_assumption', option(string)(v?.assumption, ctx)]],
  },
});
const budgetFx = record({
  module: 'scoutbox/rows/case_budget_fx_assumptions',
  constructor: 'Row',
  base: call(BASE, 'budget_fx'),
  fields: {
    from: ['from_currency', currency],
    to: ['to_currency', currency],
    rate: ['rate', string],
    source: ['source', option(string)],
    date: ['date', string],
    manual: ['manual', bool],
  },
});

// ----------------------------------------------------------------------------------------- age, TOTP, webhooks

const AGE = 'scoutbox/rules/age';
const TOTP = 'scoutbox/identity/totp';
const WEBHOOKS = 'scoutbox/integrations/webhooks';

/** The instant a rule is asked about: a Date (recorded as `{ $date: ms }`) or milliseconds; absent, the clock. */
const instant = (v, ctx) =>
  v === undefined ? int(ctx.now) : typeof v?.$date === 'number' ? int(v.$date) : int(v);

const AGE_MAP = {
  ['domain.ts#adultAgeFor']: plainIn(AGE)('adult_age_for', [string], int),
  ['domain.ts#ageOn']: {
    module: AGE,
    now: true,
    test: (c, ctx) =>
      eq(`${ctx.use(AGE)}.age_on(${string(c.args[0])}, ${instant(c.args[1], ctx)})`, option(int)(c.result, ctx)),
  },
  ['domain.ts#isAdult']: {
    module: AGE,
    now: true,
    test: (c, ctx) => {
      const { dob, country } = c.args[0] ?? {};
      return eq(
        `${ctx.use(AGE)}.is_adult(${string(dob)}, ${string(country)}, ${instant(c.args[1], ctx)})`,
        bool(c.result),
      );
    },
  },
};

const TOTP_MAP = {
  ['domains/identity/totp.mjs#b32encode']: plainIn(TOTP)('b32encode', [bytes], string),
  ['domains/identity/totp.mjs#totp']: plainIn(TOTP)('totp', [string, int], string),
  ['domains/identity/totp.mjs#totpValid']: plainIn(TOTP)('valid', [string, string, int], bool),
};

const WEBHOOK_MAP = {
  // The rule reads ALLOW_LOCAL_WEBHOOKS at call time; the only suite that calls it sets it to 1.
  ['domains/integrations/webhooks.mjs#webhookUrlProblem']: {
    module: WEBHOOKS,
    test: (c, ctx) =>
      eq(`${ctx.use(WEBHOOKS)}.url_problem(${string(c.args[0])}, True)`, option(string)(c.result, ctx)),
  },
};

// ----------------------------------------------------------------------------------------- platform

const REV = 'scoutbox/platform/rev';
const LIMITS = 'scoutbox/platform/limits';
const CONFIG = 'scoutbox/platform/config';

/** A request body, recorded as the object the route would parse. */
const body = (v, ctx) => `${ctx.use(BASE)}.body(${string(JSON.stringify(v ?? {}))})`;

/** `{ rev, revAt, revBy: { userId, name } }` as the record's `Rev`: a revision names who moved it by name only. */
const revRecord = (v, ctx) => {
  const keys = Object.keys(v ?? {}).filter((k) => !['rev', 'revAt', 'revBy'].includes(k));
  if (keys.length) throw new Error(`Rev has no field for the JavaScript key ${keys[0]}`);
  return `${ctx.use(REV)}.Rev(rev: ${int(v.rev ?? 1)}, at: ${option(int)(v.revAt, ctx)}, by_name: ${option(string)(v.revBy?.name, ctx)})`;
};

const PLATFORM_MAP = {
  ['domains/platform/concurrency.mjs#expectedRevOf']: {
    module: REV,
    test: (c, ctx) =>
      eq(
        `${ctx.use(REV)}.expected(${body(c.args[0], ctx)})`,
        c.result === null ? `Ok(${ctx.use(REV)}.Unguarded)` : `Ok(${ctx.use(REV)}.Expected(${int(c.result)}))`,
      ),
  },
  ['domains/platform/concurrency.mjs#revMeta']: {
    module: REV,
    test: (c, ctx) =>
      eqJson(`${ctx.use('gleam/json')}.object(${ctx.use(REV)}.meta(${revRecord(c.args[0], ctx)}))`, c.result, ctx),
  },
  ['domains/platform/rateLimit.mjs#rateLimitedBody']: {
    module: LIMITS,
    test: (c, ctx) =>
      eq(
        `${ctx.use(LIMITS)}.limited_body(${code(LIMITS, 'action_name')(c.args[0], ctx)})`,
        list((pair) => `#(${string(pair[0])}, ${string(pair[1])})`)(Object.entries(c.result), ctx),
      ),
  },
  // The suite passes the environment it means; the Trust Score weights, when it names none, are this server's own
  // (100, proved by passport's component_weights_total_exactly_100).
  ['domains/platform/capabilities.mjs#productionConfigProblems']: {
    module: CONFIG,
    test: (c, ctx) => {
      const { env = {}, trustWeightsTotal = null } = c.args[0] ?? {};
      if (c.result.some((p) => p.fatal !== true)) throw new Error('a problem that is not fatal');
      const pairs = Object.entries(env).map(([k, v]) => `#(${string(k)}, ${string(v)})`);
      const get = `${ctx.use('gleam/list')}.key_find([${pairs.join(', ')}], _)`;
      return eq(
        `${ctx.use(CONFIG)}.problems(${get}, ${int(trustWeightsTotal ?? 100)})`,
        list((p) => `${ctx.use(CONFIG)}.Problem(${string(p.code)}, ${string(p.message)})`)(c.result, ctx),
      );
    },
  },
};

export const MAP = {
  ...PLATFORM_MAP,
  ...AGE_MAP,
  ...TOTP_MAP,
  ...WEBHOOK_MAP,
  ['domains/recruitment/money.mjs#convertMinor']: plainIn(BUDGETS)('convert_minor', [int, string], (v) =>
    v === null ? 'Error(Nil)' : `Ok(${int(v)})`,
  ),
  ['domains/recruitment/budgets.mjs#computeScenarioTotals']: {
    module: BUDGETS,
    test: (c, ctx) => {
      const { termMonths, currency: cur, lines, fxAssumptions = [] } = c.args[0];
      const call = `${ctx.use(BUDGETS)}.totals(term_months: ${int(termMonths)}, currency: ${currency(cur, ctx)}, lines: ${list(budgetLine)(lines, ctx)}, fx: ${list(budgetFx)(fxAssumptions, ctx)})`;
      return eqJson(`${ctx.use(BUDGETS)}.totals_json(${call})`, c.result, ctx);
    },
  },
  ['domains/scouting/slots.mjs#slotsOverlap']: plainIn(SU)('slots_overlap', [weeklySlot, weeklySlot], option(bool)),
  ...BOX_CAM_MAP,
  ...COMBINE_MAP,
  ...HUB_MAP,
  ...ROOM_MAP,
  ...PASSPORT_MAP,
  ...TRUST_MAP,
  ...AGENT_MAP,
  ...ANALYTICS_MAP,
  ...DISCOVERY_MAP,
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
/**
 * Rules with no Gleam counterpart, closed rather than pending: each reason says why this server has nothing that plays
 * the rule's role (it refuses what the rule cleans, or its types already hold what the rule repairs). A function here
 * has no entry in MAP, and its recorded calls get no test.
 */
export const NO_COUNTERPART = {
  ['domains/platform/concurrency.mjs#revOf']:
    "A revision is a typed column: NOT NULL on every versioned table, and on a case present exactly when its Room is (the table's CHECK), so no record lacks one to default.",
  ['domains/platform/concurrency.mjs#bumpRev']:
    "Each domain moves its revision in its own UPDATE (rev = rev + 1, with who and when) inside the act's unit; there is no record to mutate. productionHardening's Room sections check it over HTTP.",
  ['domains/platform/notificationPrefs.mjs#defaultPrefs']:
    "The defaults are each entry's `default` in notification_prefs.categories, which spec_test proves equal to the CATEGORIES snapshot; a person with no row has emailIntent off (`effective`).",
  ['domains/platform/eventRegistry.mjs#eventFingerprint']:
    'No TypeScript route reads it: live sync neither dedupes nor coalesces by it, and nothing outside eventRegistry.mjs calls it.',
  ['domains/platform/eventRegistry.mjs#minimizePayload']:
    "An event's payload is its variant's fields, which live_test proves are the registry's payload keys: there is nothing to drop, and no event can carry a name outside the registry.",
  ['domains/platform/eventRegistry.mjs#assertEventRegistry']:
    "The registry is the Event type: every name an event can carry is in live_event.registered, which live_test proves is the registry's names, so there is nothing to check at boot.",
  ['domains/platform/eventAudience.mjs#audienceFor']:
    'An event reaches a stream by its variant (live.gleam): no event can carry a name outside the registry, so none can fail closed; the batteries check each delivery over SSE.',
  ['domains/platform/eventAudience.mjs#unclassifiedEvents']:
    'No event can carry a name outside the registry (live_event.registered, proved equal to it), so none is unclassified.',
  ['domains/platform/integrity.mjs#integrityReport']:
    "The report here is SQL over the tables (operator.integrity), not over collections: a Room's organisation is a foreign key and ids are primary keys, so ROOM_ORPHAN_ORG and the id duplicates can't happen. test/scoutbox/platform/integrity_test.gleam checks the open-Room rule on written rows.",
  ['domains/platform/integrity.mjs#integritySummary']:
    "operator.integrity counts by code as it reads (integrity_test), and there is no report with ids to summarise.",
  ['domains/development/hub/shared.mjs#parseDate']:
    "Every date the Hub reads is first judged by the request's shape (schemas.mjs `dueDate`), which refuses a malformed one before parseDate sees it; only the out-of-range instant reaches it, refused in hub_routes.",
  ['domains/development/hub/shared.mjs#scanPayloadForForbiddenFields']:
    'A helper for tests over responses: the hub battery scans every payload for the forbidden field names itself.',
  ['domains/development/hub/plan.mjs#buildTimeline']:
    "Its cases feed it a history action the Hub never writes (plan_read) to show it is dropped; a history row's action is typed here, so no such row can exist. The internal-entry filter is checked over HTTP.",
  [`${AGENT}/shared.mjs#newFacets`]:
    "A profile's facets are rows: a new profile is written with its one UNVERIFIED FIFA licence row, which agents/core checks over HTTP.",
  [`${AGENT}/shared.mjs#termMonthsOf`]:
    'No TypeScript route calls it. Both request routes refuse a term that is not a whole number of months in range, and default an absent one.',
  [`${TRUST}#eligibleTrustComponents`]:
    "No whole component is adult-only, so every weight is eligible (the policy's, proved equal to the snapshot); the agency facet a minor's relationships drop is each profile's context.adultOnlyFacetsExcluded, which calculateTrustScore's cases compare.",
  [`${TRUST}#trustChangeReasons`]:
    'No route reports change reasons on either server: they appear in no response, and the trust_recalculation_reason counter is never counted.',
  [`${AGENT}/shared.mjs#tiersOf`]:
    "A membership's roles are typed as they are read from the table (the schema refuses unknown ones), and a missing membership is None where it is used.",
};

/**
 * Rules whose result is random. The recorder seeds randomness so recordings repeat, but a Gleam rule draws its own
 * bytes, so these calls are ported by hand (HAND_PORTED) rather than compared with the recorded value.
 */
export const RANDOM = [`${PASSPORT}#mintShareSecret`];

export const HAND_PORTED = {
  ['domain.ts#ageOn']: 'test/scoutbox/rules/age_test.gleam',
  // Development throws on an emitted name the registry doesn't know; here no event can carry one (live_test).
  ['domains/platform/eventRegistry.mjs#assertEventRegistry']: 'test/scoutbox/live_test.gleam',
  ['domains/discovery/shared.mjs#briefIsLiveOn']: 'test/scoutbox/discovery/briefs_test.gleam',
  ['domains/platform/concurrency.mjs#expectedRevOf']: 'test/scoutbox/rev_test.gleam',
  ['domains/platform/notificationPrefs.mjs#createNotificationPrefs']: 'test/scoutbox/messaging/notification_prefs_test.gleam',
  ['domains/platform/capabilities.mjs#buildCapabilityReport']: 'test/scoutbox/config_test.gleam',
  // There is one limiter, in process, and no provider to choose or refuse; the capability report says it is not
  // distributed (config_test).
  ['domains/platform/rateLimit.mjs#createRateLimiter']: 'test/scoutbox/config_test.gleam',
  ['domains/platform/rateLimit.mjs#memoryRateLimitProvider']: 'test/scoutbox/limits_test.gleam',
  ['domains/development/hub/permissions.mjs#planAccess']: 'test/scoutbox/development/hub_access_test.gleam',
  ...Object.fromEntries(
    ['mintShareSecret', 'normWhen'].map((f) => [`${PASSPORT}#${f}`, 'test/scoutbox/passport/passport_rules_test.gleam']),
  ),
  ...Object.fromEntries(
    [
      'affiliationActive',
      'agentTransitionAllowed',
      'agreementForAgent',
      'agreementForClient',
      'agreementGrantsAccess',
      'can',
      'clientTransitionAllowed',
      'effectiveAgreementStatus',
      'effectiveFacetState',
      'normaliseScope',
      'normaliseTiers',
      'verificationGap',
    ].map((f) => [`domains/agents/core/shared.mjs#${f}`, 'test/scoutbox/agents/agent_rules_test.gleam']),
  ),
  ...Object.fromEntries(
    [`${TRUST}#safeTrustProjection`, 'domains/agents/core/shared.mjs#agreementInForce'].map((f) => [
      f,
      'test/scoutbox/passport/trust_rules_test.gleam',
    ]),
  ),
  ['domains/discovery/matching/match.mjs#matchPlayerToCriteria']: 'test/scoutbox/discovery/matching_test.gleam',
  ['domains/discovery/shared.mjs#buildSecondLookCandidate']: 'test/scoutbox/discovery/second_look_rules_test.gleam',
  ...Object.fromEntries(
    ['dashboard.mjs#buildDashboard', 'dashboard.mjs#buildReportingContext', 'funnels.mjs#stagesReached', 'metrics.mjs#assertMetricRegistry'].map(
      (f) => [`domains/recruitment/analytics/${f}`, 'test/scoutbox/recruitment/analytics_test.gleam'],
    ),
  ),
  [`${SHARED}#arrayTokenStore`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#mintToken`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#peekToken`]: 'test/scoutbox/verification/tokens_test.gleam',
  [`${SHARED}#consumeToken`]: 'test/scoutbox/verification/tokens_test.gleam',
  ...Object.fromEntries(
    ['buildRoomSnapshot', 'roomCan', 'roomSummary', 'validateDecision', 'validateReasonCodes', 'validateTransition'].map(
      (f) => [`domains/recruitment/rooms/shared.mjs#${f}`, 'test/scoutbox/recruitment/room_rules_test.gleam'],
    ),
  ),
};
