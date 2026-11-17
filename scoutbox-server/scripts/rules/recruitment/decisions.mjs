// The decision engine behind the recruitment decisions battery (e2e/recruitment/decisions.mjs), checked in this
// process: the outcome vocabulary and its validation, evidence references over plain collections, the decision chain,
// integrity, summaries and views, and the policy tables (error bands, rate policies, events, permissions, the evidence
// a formal progress decision supplies).
import {
  DECISION_OUTCOMES,
  OUTCOME_MAP,
  EVIDENCE_REF_KINDS,
  DECISION_POLICY_VERSION,
  validateOutcome,
  validateDecisionReasons,
  validateNote,
  validateEvidenceRefShapes,
  decisionIntegrity,
  duplicateFinalHeads,
  chainHead,
  summariseAssessments,
  assessmentSnapshot,
  decisionView,
  draftView,
  decisionMilestone,
  decisionRequirements,
  normaliseDecisionClientKey,
} from '../../../domains/recruitment/lifecycle/decision.mjs';
import { LIFECYCLE_ERROR_HTTP } from '../../../domains/recruitment/lifecycle/errors.mjs';
import { DECISION_INPUT_CODES } from '../../../domains/recruitment/lifecycle/decisionRoutes.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import {
  STATUS_EVIDENCE_REQUIRED,
  ROOM_TRANSITIONS,
  ROOM_STATUSES,
  roomCan,
  PROHIBITED_REASON_CODES,
} from '../../../domains/recruitment/rooms/shared.mjs';
import { EVIDENCE_KINDS } from '../../../domains/recruitment/lifecycle/evidence.mjs';
import { canTransitionRecruitmentCase, LIFECYCLE_ACTIONS } from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { createEvidenceProvider, resolveEvidenceRefs } from '../../recruitmentReadsFixture.mjs'; // the recruitment queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/decisions');
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const PROTO_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
const BAD_TYPES = [{}, [], null, true, false, 1, 1.5, -1, '', ' '];

section('U — vocabulary and validation: three outcomes, one taxonomy, nothing coerced');
{
  ok(DECISION_OUTCOMES.join(',') === 'progress,hold,reject', 'U1 exactly three operational outcomes');
  ok(
    OUTCOME_MAP.progress.recommendation === 'offer' &&
      OUTCOME_MAP.progress.action === 'considerOffer' &&
      LIFECYCLE_ACTIONS.considerOffer.to === 'offer_consideration',
    'U2 progress maps onto the advisory `offer` recommendation and the considerOffer action — ending at offer_consideration',
  );
  ok(
    OUTCOME_MAP.hold.recommendation === 'continue_watching' &&
      LIFECYCLE_ACTIONS[OUTCOME_MAP.hold.action].to === 'on_hold',
    'U3 hold maps onto continue_watching and on_hold',
  );
  ok(
    OUTCOME_MAP.reject.recommendation === 'archive' &&
      LIFECYCLE_ACTIONS[OUTCOME_MAP.reject.action].to === 'archived' &&
      OUTCOME_MAP.reject.lifecycleReasons.join() === 'rejected',
    'U4 reject maps onto archive and rejectCase, carrying the LIFECYCLE reason `rejected` — not a decision reason',
  );
  neg(
    !Object.values(OUTCOME_MAP).some(
      (m) => LIFECYCLE_ACTIONS[m.action].to === 'offer_made' || LIFECYCLE_ACTIONS[m.action].to === 'signed',
    ),
    'U5 no outcome reaches offer_made or signed',
  );
  for (const k of [
    ...PROTO_KEYS,
    ...BAD_TYPES,
    'PROGRESS',
    'Progress',
    ' progress',
    'offer',
    'sign',
    'archive',
    'accept',
  ]) {
    const v = validateOutcome(k);
    neg(
      v.ok === false && v.error === 'DECISION_OUTCOME_INVALID' && Array.isArray(v.allowed),
      `U6 ${JSON.stringify(k)} is not an outcome (prototype keys, other types, case, Room words)`,
    );
  }
  neg(
    validateOutcome('__proto__').ok === false && validateOutcome('constructor').ok === false,
    'U6b the map is a null-prototype table: inherited names resolve to nothing',
  );
  ok(
    validateDecisionReasons(['tactical_fit', 'Position_Need']).codes.join() === 'tactical_fit,position_need',
    'U7 decision reasons come from the Rooms taxonomy, normalised',
  );
  neg(
    validateDecisionReasons([], { outcome: 'reject' }).error === 'DECISION_REASON_INVALID',
    'U8 a rejection with no reason is refused',
  );
  ok(
    validateDecisionReasons([], { outcome: 'hold' }).ok &&
      validateDecisionReasons(undefined, { outcome: 'progress' }).ok,
    'U8b hold and progress may carry none',
  );
  for (const bad of ['rejected', 'on_hold', 'club_decision', 'trial_completed', 'case_closed'])
    neg(
      validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID',
      `U9 the LIFECYCLE reason "${bad}" is not a decision reason (two taxonomies)`,
    );
  for (const bad of PROHIBITED_REASON_CODES.slice(0, 6))
    neg(
      validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID',
      `U10 the prohibited reason "${bad}" is refused`,
    );
  for (const bad of PROTO_KEYS)
    neg(validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID', `U11 "${bad}" is not a reason code`);
  for (const bad of [{}, 'tactical_fit', 1, true, [1], [{}], [{ toString: 1 }], [null, 2]])
    neg(
      validateDecisionReasons(bad).error === 'DECISION_REASON_INVALID',
      `U12 ${JSON.stringify(bad)} is not a list of reason codes`,
    );
  neg(
    validateDecisionReasons([
      'technical_fit',
      'tactical_fit',
      'physical_profile',
      'position_need',
      'development_upside',
      'insufficient_full_match',
      'reference_missing',
    ]).error === 'DECISION_REASON_INVALID',
    'U13 seven reasons is over the limit of six',
  );
  ok(
    validateNote(undefined).text === null &&
      validateNote('').text === null &&
      validateNote('  <b>Fine</b> ').text === 'Fine',
    'U14 a note is optional, trimmed and stripped of markup',
  );
  neg(
    validateNote('x'.repeat(2001)).error === 'DECISION_CONTENT_INVALID' && validateNote('x'.repeat(2000)).ok,
    'U15 the note limit is 2000, inclusive',
  );
  for (const bad of [1, true, {}, [], 1.5])
    neg(
      validateNote(bad).error === 'DECISION_CONTENT_INVALID',
      `U16 a note of type ${JSON.stringify(bad)} is not text`,
    );
  neg(
    validateNote('r'.repeat(501), { field: 'supersessionReason', max: 500 }).error === 'DECISION_CONTENT_INVALID',
    'U17 the supersession reason limit is 500',
  );
  ok(
    validateEvidenceRefShapes(undefined).refs.length === 0 &&
      validateEvidenceRefShapes([
        { kind: 'assessment', id: 'a', extra: 'dropped' },
        { kind: 'assessment', id: 'a' },
      ]).refs.length === 1,
    'U18 references dedupe and carry only { kind, id }',
  );
  for (const bad of [
    {},
    'x',
    1,
    [{ kind: 'assessment' }],
    [{ id: 'a' }],
    [{ kind: 'rating', id: 'a' }],
    [{ kind: 'assessment', id: '' }],
    [{ kind: 'assessment', id: 1 }],
    [null],
    ['assessment:a'],
    [{ kind: '__proto__', id: 'a' }],
    [{ kind: 'constructor', id: 'a' }],
  ])
    neg(
      validateEvidenceRefShapes(bad).error === 'DECISION_EVIDENCE_INVALID',
      `U19 ${JSON.stringify(bad)} is not a reference list`,
    );
  neg(
    validateEvidenceRefShapes(Array.from({ length: 51 }, (_, i) => ({ kind: 'assessment', id: `a${i}` }))).error ===
      'DECISION_EVIDENCE_INVALID',
    'U20 fifty-one references is over the limit',
  );
  ok(
    validateEvidenceRefShapes(Array.from({ length: 50 }, (_, i) => ({ kind: 'assessment', id: `a${i}` }))).ok,
    'U20b fifty is the limit, inclusive',
  );
  ok(
    EVIDENCE_REF_KINDS.join() === 'assessment,trial,box_cam_session,passport_evidence',
    'U21 four reference kinds, no "rating", no "score", no "trust"',
  );
  for (const bad of ['x'.repeat(65), 1, {}, [], true])
    neg(
      normaliseDecisionClientKey(bad).error === 'DECISION_CLIENT_KEY_INVALID',
      `U22 client key ${JSON.stringify(bad).slice(0, 20)} refused in the Decision vocabulary`,
    );
  ok(
    normaliseDecisionClientKey(undefined).ok && normaliseDecisionClientKey('k-1').key === 'k-1',
    'U22b a key is optional and kept as given',
  );
}

section('U — references resolve against THIS case only; metadata is minimal');
{
  const db = {
    assessments: [
      {
        id: 'a-ok',
        orgId: 'org-A',
        playerId: 'pl-1',
        state: 'submitted',
        submittedAt: 5,
        scoutName: 'S',
        recommendation: { verdict: 'sign', reasons: 'PRIVATE' },
        ratings: [{ attrId: 'x', rating: 5, note: 'PRIVATE_RATING_NOTE' }],
      },
      { id: 'a-draft', orgId: 'org-A', playerId: 'pl-1', state: 'draft' },
      { id: 'a-other-org', orgId: 'org-B', playerId: 'pl-1', state: 'submitted' },
      { id: 'a-other-player', orgId: 'org-A', playerId: 'pl-2', state: 'submitted' },
    ],
    trials: [
      {
        id: 't-ok',
        orgId: 'org-A',
        playerId: 'pl-1',
        caseId: 'case-1',
        completion: { state: 'completed', at: 9 },
        schedule: {
          sessions: [
            {
              id: 's1',
              evidence: [
                { kind: 'box_cam_session', sessionId: 'bx-1', removedAt: null },
                { kind: 'box_cam_session', sessionId: 'bx-gone', removedAt: 3 },
              ],
            },
          ],
        },
        attendance: [],
      },
      {
        id: 't-other-case',
        orgId: 'org-A',
        playerId: 'pl-1',
        caseId: 'case-2',
        schedule: { sessions: [] },
        attendance: [],
      },
      {
        id: 't-other-player',
        orgId: 'org-A',
        playerId: 'pl-2',
        caseId: 'case-3',
        schedule: {
          sessions: [{ id: 's9', evidence: [{ kind: 'box_cam_session', sessionId: 'bx-9', removedAt: null }] }],
        },
        attendance: [],
      },
    ],
    boxSessions: [
      { id: 'bx-1', playerId: 'pl-1', provider: 'real', verificationState: 'verified', result: { score: 99 } },
      { id: 'bx-9', playerId: 'pl-2', provider: 'real' },
      { id: 'bx-sim', playerId: 'pl-1', provider: 'sim' },
    ],
    evidence: [
      { id: 'ev-ok', playerId: 'pl-1', claimType: 'footage', verification: { status: 'verified' } },
      { id: 'ev-old', playerId: 'pl-1', supersededBy: 'ev-ok' },
      { id: 'ev-other', playerId: 'pl-2' },
    ],
  };
  const kase = { id: 'case-1', orgId: 'org-A', playerId: 'pl-1' };
  const providers = { sim: { testOnly: true }, real: {} };
  const good = resolveEvidenceRefs(
    [
      { kind: 'assessment', id: 'a-ok' },
      { kind: 'trial', id: 't-ok' },
      { kind: 'box_cam_session', id: 'bx-1' },
      { kind: 'passport_evidence', id: 'ev-ok' },
    ],
    { db, kase, providers },
  );
  ok(
    good.ok &&
      good.refs.length === 4 &&
      good.refs[1].meta.workflowState === 'completed' &&
      good.refs[2].meta.verificationState === 'verified' &&
      good.refs[3].meta.provenance === 'verified',
    "U23 this case's own records resolve, with state-level metadata",
  );
  neg(
    !has(good.refs, 'PRIVATE') && !has(good.refs, '99') && !has(good.refs, 'score') && !has(good.refs, 'rating'),
    'U24 the stored reference carries no rating, no note, no Box Cam result — ids and states only',
  );
  const cases = [
    [{ kind: 'assessment', id: 'a-other-org' }, 'DECISION_CASE_MISMATCH', "another organisation's assessment"],
    [{ kind: 'assessment', id: 'a-other-player' }, 'DECISION_CASE_MISMATCH', "another player's assessment"],
    [
      { kind: 'assessment', id: 'a-missing' },
      'DECISION_CASE_MISMATCH',
      'an assessment that does not exist — same body as one that exists elsewhere',
    ],
    [{ kind: 'assessment', id: 'a-draft' }, 'DECISION_EVIDENCE_INVALID', 'a draft assessment'],
    [{ kind: 'trial', id: 't-other-case' }, 'DECISION_CASE_MISMATCH', 'a trial on another case'],
    [{ kind: 'trial', id: 't-other-player' }, 'DECISION_CASE_MISMATCH', "another player's trial"],
    [
      { kind: 'box_cam_session', id: 'bx-gone' },
      'DECISION_CASE_MISMATCH',
      'a Box Cam session whose link was withdrawn',
    ],
    [
      { kind: 'box_cam_session', id: 'bx-9' },
      'DECISION_CASE_MISMATCH',
      "a Box Cam session linked on another player's trial",
    ],
    [{ kind: 'box_cam_session', id: 'bx-sim' }, 'DECISION_CASE_MISMATCH', 'a test-only session not linked anywhere'],
    [{ kind: 'passport_evidence', id: 'ev-old' }, 'DECISION_CASE_MISMATCH', 'a superseded Passport record'],
    [{ kind: 'passport_evidence', id: 'ev-other' }, 'DECISION_CASE_MISMATCH', "another player's Passport record"],
  ];
  for (const [ref, code, what] of cases) {
    const r = resolveEvidenceRefs([ref], { db, kase, providers });
    neg(r.ok === false && r.error === code, `U25 ${what} cannot be cited (${code})`);
  }
}

section('U — chain, integrity, summaries, views');
{
  const legacy = {
    id: 'd-1',
    roomId: 'c',
    orgId: 'o',
    recommendation: 'shortlist',
    reasonCodes: ['tactical_fit'],
    note: 'n',
    by: { userId: 'u', name: 'U' },
    createdAt: 1,
    supersededById: 'd-2',
  };
  const formal = {
    id: 'd-2',
    roomId: 'c',
    orgId: 'o',
    kind: 'formal',
    state: 'final',
    outcome: 'progress',
    recommendation: 'offer',
    reasonCodes: [],
    note: null,
    by: { userId: 'u', name: 'U' },
    createdAt: 2,
    supersedes: 'd-1',
    supersededById: null,
    rev: 1,
    evidenceRefs: [{ kind: 'assessment', id: 'a' }],
    lifecycle: { applied: true },
  };
  ok(
    chainHead([legacy, formal]).id === 'd-2' && chainHead([]) === null,
    'U26 the chain head is the one row nothing supersedes',
  );
  ok(
    decisionView(legacy).kind === 'recommendation' &&
      decisionView(legacy).outcome === null &&
      decisionView(legacy).state === 'final',
    'U27 a legacy advisory row reads as an advisory recommendation, never as a formal decision',
  );
  ok(
    decisionView(formal).kind === 'formal' &&
      decisionView(formal).outcomeLabel === 'Progress to offer consideration' &&
      decisionView(formal).evidenceCount === 1 &&
      decisionView(formal).policyVersion === DECISION_POLICY_VERSION,
    'U28 a formal row reads with its outcome, label, evidence count and policy version',
  );
  ok(
    decisionView(formal, { omitNote: true }).note === undefined &&
      decisionView(formal, { omitNote: true }).hasNote === false,
    'U28b the note can be omitted from a view; hasNote stays honest',
  );
  neg(
    decisionMilestone({ ...formal, note: 'PRIVATE' }).note === undefined &&
      !has(decisionMilestone({ ...formal, note: 'PRIVATE' }), 'PRIVATE'),
    'U29 the journey milestone never carries the note',
  );
  ok(
    draftView({ id: 'r', outcome: 'hold', rev: 3 }).label === 'Draft — not a formal decision' &&
      draftView({ id: 'r' }).state === 'draft' &&
      draftView(null) === null,
    'U30 a draft is labelled as not a decision',
  );
  ok(
    decisionIntegrity(formal, { orgId: 'o', caseId: 'c' }).length === 0 && decisionIntegrity(legacy).length === 0,
    'U31 sound rows have no problems; legacy rows are not judged here',
  );
  const bad = [
    [{ ...formal, outcome: 'accept' }, 'unknown_outcome'],
    [{ ...formal, outcome: '__proto__' }, 'unknown_outcome'],
    [{ ...formal, by: null }, 'missing_actor'],
    [{ ...formal, roomId: 'other' }, 'missing_case'],
    [{ ...formal, orgId: 'x' }, 'org_mismatch'],
    [{ ...formal, createdAt: 'yesterday' }, 'missing_time'],
    [{ ...formal, reasonCodes: 'tactical_fit' }, 'reasons_not_a_list'],
    [{ ...formal, reasonCodes: ['race'] }, 'invalid_reason_code'],
    [{ ...formal, evidenceRefs: {} }, 'refs_not_a_list'],
    [{ ...formal, rev: 0 }, 'rev'],
    [{ ...formal, rev: 1.5 }, 'rev'],
  ];
  for (const [row, p] of bad)
    neg(
      decisionIntegrity(row, { orgId: 'o', caseId: 'c' }).includes(p),
      `U32 a formal row with ${p} is named, not repaired`,
    );
  neg(
    decisionIntegrity(Object.create(null)).includes('id') &&
      decisionIntegrity(null)[0] === 'not_an_object' &&
      decisionIntegrity(
        new Proxy(
          {},
          {
            get() {
              throw new Error('boom');
            },
          },
        ),
      )[0] === 'unreadable',
    'U33 unreadable rows are named, never thrown',
  );
  neg(
    duplicateFinalHeads([formal, { ...formal, id: 'd-3', createdAt: 3 }]).length === 2 &&
      duplicateFinalHeads([legacy, formal]).length === 0,
    'U34 two formal rows without a successor are corruption, not a tie',
  );
  const A = (id, verdict, extra = {}) => ({
    id,
    state: 'submitted',
    submittedAt: 1,
    scoutName: id,
    scoutUserId: id,
    recommendation: { verdict, reasons: 'PRIVATE_WHY' },
    ratings: [
      { rating: 5, confidence: 'high' },
      { rating: 2, confidence: 'low' },
      { notObserved: true },
      { rating: 4, confidence: 'medium', evidenceRefs: ['e1', 'e2'] },
    ],
    ...extra,
  });
  const s = summariseAssessments([A('x', 'sign'), A('y', 'pass'), { id: 'z', state: 'draft' }], { withheld: 1 });
  ok(
    s.submitted === 2 &&
      s.drafts === 1 &&
      s.withheld === 1 &&
      s.verdicts.sign === 1 &&
      s.verdicts.pass === 1 &&
      s.disagreement?.kind === 'verdicts_differ' &&
      s.assessments[0].rated === 3 &&
      s.assessments[0].notObserved === 1 &&
      s.assessments[0].confidence.high === 1 &&
      s.assessments[0].evidenceRefs === 2,
    'U35 assessments summarise as counts per assessor and verdict counts; disagreement is named',
  );
  neg(
    !has(s, 'PRIVATE_WHY') &&
      !has(s.assessments, 'average') &&
      !has(s.assessments, 'score') &&
      s.assessments.every((a) => a.rating === undefined && a.ratings === undefined),
    'U36 no rating, no average, no score, no reasons text leaves the summary',
  );
  ok(
    summariseAssessments([A('x', 'sign'), A('y', 'sign')]).disagreement?.kind === 'unanimous' &&
      summariseAssessments([A('x', 'sign')]).disagreement === null &&
      summariseAssessments([]).submitted === 0,
    'U37 unanimity is named only with more than one assessor; one assessor is neither',
  );
  ok(
    assessmentSnapshot(s).assessmentIds.join() === 'x,y' && assessmentSnapshot(s).verdicts.sign === 1,
    'U38 the snapshot a formal row keeps is ids and counts',
  );
  const req = decisionRequirements({
    role: 'room_lead',
    canFinalize: true,
    status: 'shortlisted',
    submittedAssessments: 0,
    completedTrials: 0,
    blocked: false,
    subjectRemoved: false,
    draft: null,
    hasFinal: false,
    availability: [],
  });
  ok(
    req.canDraft &&
      req.canFinalize &&
      req.inputs.submittedAssessments === 0 &&
      /None of them is required/.test(req.inputs.note),
    'U39 readiness counts what exists and says none of it is required — zero assessments and zero trials do not bar a decision',
  );
  neg(
    decisionRequirements({ ...req, canFinalize: true, subjectRemoved: true, availability: [] }).canDraft === false,
    'U40 a removed subject bars drafting for everyone',
  );
}

// ================================================================ P — policy
section('P — policy: error bands, rate policies, events, permissions, the ONE widening, no new states');
{
  const codes = Object.keys(LIFECYCLE_ERROR_HTTP).filter((c) => c.startsWith('DECISION_'));
  ok(codes.length >= 18, `P1 ${codes.length} DECISION_* codes are in the lifecycle error table`);
  const band = (c) => LIFECYCLE_ERROR_HTTP[c];
  ok(
    [
      'DECISION_OUTCOME_INVALID',
      'DECISION_REASON_INVALID',
      'DECISION_CONTENT_INVALID',
      'DECISION_EVIDENCE_INVALID',
      'DECISION_CASE_MISMATCH',
      'DECISION_CLIENT_KEY_INVALID',
      'DECISION_REV_REQUIRED',
    ].every((c) => band(c) === 400),
    'P2 validation codes are 400',
  );
  const inputCodes = [...Object.values(DECISION_INPUT_CODES.codes), ...Object.values(DECISION_INPUT_CODES.fieldCodes)];
  ok(
    inputCodes.every((c) => band(c) === 400),
    'P2b every code the decision input schemas give a refusal is a 400 in the table',
  );
  ok(
    band('DECISION_NOT_PERMITTED') === 403 && band('DECISION_BLOCKED') === 403 && band('DECISION_NOT_FOUND') === 404,
    'P3 permission 403, not-found 404',
  );
  ok(
    [
      'DECISION_INVALID_STATE',
      'DECISION_ALREADY_FINAL',
      'DECISION_VERSION_CONFLICT',
      'DECISION_IDEMPOTENCY_CONFLICT',
      'DECISION_LIFECYCLE_CONFLICT',
      'DECISION_SUBJECT_REMOVED',
    ].every((c) => band(c) === 409),
    'P4 state codes are 409',
  );
  ok(
    ['DECISION_STATE_UNKNOWN', 'DECISION_TRANSPORT_REFUSED'].every((c) => band(c) === 500),
    "P5 integrity and transport codes are 500 — the server's fault, said so",
  );
  ok(
    RATE_LIMIT_POLICY.decision_draft?.max === 60 &&
      RATE_LIMIT_POLICY.decision_finalize?.max === 30 &&
      RATE_LIMIT_POLICY.decision_finalize.scope === 'org',
    'P6 rate policies: 60 drafts and 30 finalizations per hour per organisation',
  );
  const ev = (n) => EVENT_REGISTRY[n] ?? EVENT_REGISTRY.find?.((e) => e.name === n);
  ok(ev('room_decision_finalized') && ev('room_decision_superseded'), 'P7 the two decision events are registered');
  neg(
    !ev('decision_offer_created') && !ev('room_offer_made') && !ev('room_decision_drafted'),
    'P8 there is no offer event and no draft event — a draft is not news',
  );
  ok(
    roomCan('viewer', 'decision_view') &&
      !roomCan('viewer', 'decision_draft') &&
      !roomCan('contributor', 'decision_draft') &&
      !roomCan('contributor', 'decision_finalize') &&
      roomCan('room_lead', 'decision_draft') &&
      roomCan('room_lead', 'decision_finalize') &&
      roomCan('recruitment_admin', 'decision_finalize'),
    'P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes',
  );
  ok(
    STATUS_EVIDENCE_REQUIRED.offer_consideration?.kind === 'decision_progress' &&
      EVIDENCE_KINDS.includes('decision_progress'),
    'P10 the ONE widening: offer_consideration needs a finalized progress decision, and the provider knows the kind',
  );
  ok(
    STATUS_EVIDENCE_REQUIRED.offer_made?.kind === 'offer_sent' && STATUS_EVIDENCE_REQUIRED.signed,
    'P11 offer_made and signed keep their own preconditions — a decision satisfies neither',
  );
  neg(
    !('on_hold' in STATUS_EVIDENCE_REQUIRED) && !('archived' in STATUS_EVIDENCE_REQUIRED),
    'P12 on_hold and archived need no decision row — a hold or an archive by hand remains possible (documented choice)',
  );
  for (const s of [
    'decision_pending',
    'decision_complete',
    'recommended',
    'committee_review',
    'greenlight',
    'decided',
    'offer_recommended',
  ])
    neg(!ROOM_STATUSES.includes(s) && !(s in ROOM_TRANSITIONS), `P13 no lifecycle state "${s}" was invented`);
  ok(
    Object.keys(ROOM_TRANSITIONS).length === ROOM_STATUSES.length,
    'P13b the transition table covers exactly the existing statuses',
  );
  // The provider, against a fake database: a draft, an advisory row, a superseded formal row and a hold prove nothing for offer_consideration.
  const kase = {
    id: 'c',
    orgId: 'o',
    playerId: 'p',
    room: { status: 'shortlisted', leadScoutUserId: 'u' },
    ownerUserId: 'u',
  };
  const mk = (over) => ({
    id: 'd',
    roomId: 'c',
    orgId: 'o',
    playerId: 'p',
    kind: 'formal',
    state: 'final',
    outcome: 'progress',
    recommendation: 'offer',
    reasonCodes: [],
    by: { userId: 'u', name: 'U' },
    createdAt: 1,
    supersededById: null,
    rev: 1,
    ...over,
  });
  const verdictWith = (rows) =>
    canTransitionRecruitmentCase(kase, 'considerOffer', {
      role: 'room_lead',
      evidence: createEvidenceProvider({ roomDecisions: rows, recruitmentContacts: [], trials: [], requests: [] }),
    });
  ok(verdictWith([mk({})]).ok === true, 'P15 a finalized progress decision on this case satisfies considerOffer');
  neg(
    verdictWith([]).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'P16 with no decision, considerOffer is refused by the validator',
  );
  neg(
    verdictWith([
      { id: 'd', roomId: 'c', orgId: 'o', playerId: 'p', recommendation: 'offer', createdAt: 1, supersededById: null },
    ]).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'P17 an advisory "offer" recommendation is NOT a formal decision — refused',
  );
  neg(
    verdictWith([mk({ outcome: 'hold', recommendation: 'continue_watching' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'P18 a formal hold proves nothing for offer_consideration',
  );
  neg(
    verdictWith([mk({ supersededById: 'later' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'P19 a superseded progress decision proves nothing',
  );
  neg(
    verdictWith([mk({ state: 'draft' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED' &&
      verdictWith([mk({ roomId: 'other' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED' &&
      verdictWith([mk({ orgId: 'x' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    "P20 a draft, another case's or another organisation's decision proves nothing",
  );
}

done();
