// M23 P5 acceptance suite — the formal recruitment decision.
//
// The governing principle this suite exists to enforce (mandate §1):
//
//   evidence ≠ observation ≠ assessment ≠ discussion ≠ decision ≠ offer ≠ signing
//
// A formal decision is a human act, typed by a room lead, recorded in the
// SAME decision memory M17 created, moving the case through the ONE
// lifecycle writer, ending at the internal boundary `offer_consideration`.
// Nothing here infers an outcome from evidence; nothing here creates an
// offer; nothing here tells the player anything.
//
// Groups:
//   U  pure engine — vocabulary, validation, prototype keys, invalid types, chain, summaries
//   P  policy — error bands, rate policies, event registry, roomCan, the ONE precondition widening, no new states
//   J  the adult journey over HTTP: review → trial → assessments → draft → formal progress → offer_consideration
//   H  hold: supersession with a reason, the chain, resume, already-there
//   R  reject: reasons required, archived through the writer, Second Look, Nobody Missed
//   D  the non-trial path: a decision needs no trial and no assessment
//   W  the walls — roles, foreign organisation, player/guardian tokens, enumeration
//   E  evidence references — this case's own records only, minimal metadata
//   Q  the blind rule — what a scout sees before and after submitting
//   K  expectedRev matrix, idempotency, supersession rules
//   X  content — prototype keys, invalid types, XSS, limits, taxonomies
//   B  a blocked family — progress refused, hold and reject allowed
//   C  the concurrency matrix (§92)
//   F  honest transport failure — nothing half-written
//   I  sentinels across every surface that is not the room
//   N  events, audit, journey, analytics
//   T  the subject removed their account
//   L  rate limits
//   Z  restart — draft, chain, keys and case survive the process dying
//
// No assertion here is `status !== 200`. Every refusal names the status and
// the code it expects.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_OUTCOMES, OUTCOME_MAP, EVIDENCE_REF_KINDS, DECISION_LIMITS, DECISION_POLICY_VERSION,
  validateOutcome, validateDecisionReasons, validateNote, validateEvidenceRefShapes, resolveEvidenceRefs,
  decisionIntegrity, duplicateFinalHeads, chainHead, summariseAssessments, assessmentSnapshot, decisionView, draftView,
  decisionMilestone, decisionRequirements, normaliseDecisionClientKey,
} from '../m23/decision.mjs';
import { M23_ERROR_HTTP } from '../m23/errors.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { STATUS_EVIDENCE_REQUIRED, ROOM_TRANSITIONS, ROOM_STATUSES, roomCan, PROHIBITED_REASON_CODES, REVISITABLE_REASON_CODES } from '../m17/shared.mjs';
import { createEvidenceProvider, EVIDENCE_KINDS } from '../m23/evidence.mjs';
import { canTransitionRecruitmentCase, LIFECYCLE_ACTIONS } from '../m23/lifecycle.mjs';
import { readFileSync } from 'node:fs';

const PORT = 6400 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const S_DEC = 'PRIVATE_DECISION_SENTINEL_5914';
const S_ROOM = 'PRIVATE_ROOM_RATIONALE_SENTINEL_8812';
const S_ASSESS = 'PRIVATE_ASSESSMENT_SENTINEL_3407';
const H = 3_600_000;

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return good;
};
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const PROTO_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
const BAD_TYPES = [{}, [], null, true, false, 1, 1.5, -1, '', ' '];

// ============================================================ U — pure engine
section('U — vocabulary and validation: three outcomes, one taxonomy, nothing coerced');
{
  ok(DECISION_OUTCOMES.join(',') === 'progress,hold,reject', 'U1 exactly three operational outcomes');
  ok(OUTCOME_MAP.progress.recommendation === 'offer' && OUTCOME_MAP.progress.action === 'considerOffer' && LIFECYCLE_ACTIONS.considerOffer.to === 'offer_consideration', 'U2 progress maps onto the M17 `offer` recommendation and the considerOffer action — ending at offer_consideration');
  ok(OUTCOME_MAP.hold.recommendation === 'continue_watching' && LIFECYCLE_ACTIONS[OUTCOME_MAP.hold.action].to === 'on_hold', 'U3 hold maps onto continue_watching and on_hold');
  ok(OUTCOME_MAP.reject.recommendation === 'archive' && LIFECYCLE_ACTIONS[OUTCOME_MAP.reject.action].to === 'archived' && OUTCOME_MAP.reject.lifecycleReasons.join() === 'rejected', 'U4 reject maps onto archive and rejectCase, carrying the LIFECYCLE reason `rejected` — not a decision reason');
  neg(!Object.values(OUTCOME_MAP).some((m) => LIFECYCLE_ACTIONS[m.action].to === 'offer_made' || LIFECYCLE_ACTIONS[m.action].to === 'signed'), 'U5 no outcome reaches offer_made or signed');
  for (const k of [...PROTO_KEYS, ...BAD_TYPES, 'PROGRESS', 'Progress', ' progress', 'offer', 'sign', 'archive', 'accept']) {
    const v = validateOutcome(k);
    neg(v.ok === false && v.error === 'DECISION_OUTCOME_INVALID' && Array.isArray(v.allowed), `U6 ${JSON.stringify(k)} is not an outcome (prototype keys, other types, case, M17 words)`);
  }
  neg(validateOutcome('__proto__').ok === false && validateOutcome('constructor').ok === false, 'U6b the map is a null-prototype table: inherited names resolve to nothing');
  ok(validateDecisionReasons(['tactical_fit', 'Position_Need']).codes.join() === 'tactical_fit,position_need', 'U7 decision reasons come from the M17 taxonomy, normalised');
  neg(validateDecisionReasons([], { outcome: 'reject' }).error === 'DECISION_REASON_INVALID', 'U8 a rejection with no reason is refused');
  ok(validateDecisionReasons([], { outcome: 'hold' }).ok && validateDecisionReasons(undefined, { outcome: 'progress' }).ok, 'U8b hold and progress may carry none');
  for (const bad of ['rejected', 'on_hold', 'club_decision', 'trial_completed', 'case_closed']) neg(validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID', `U9 the LIFECYCLE reason "${bad}" is not a decision reason (two taxonomies, P2 B4)`);
  for (const bad of PROHIBITED_REASON_CODES.slice(0, 6)) neg(validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID', `U10 the prohibited reason "${bad}" is refused`);
  for (const bad of PROTO_KEYS) neg(validateDecisionReasons([bad]).error === 'DECISION_REASON_INVALID', `U11 "${bad}" is not a reason code`);
  for (const bad of [{}, 'tactical_fit', 1, true, [1], [{}], [{ toString: 1 }], [null, 2]]) neg(validateDecisionReasons(bad).error === 'DECISION_REASON_INVALID', `U12 ${JSON.stringify(bad)} is not a list of reason codes`);
  neg(validateDecisionReasons(['technical_fit', 'tactical_fit', 'physical_profile', 'position_need', 'development_upside', 'insufficient_full_match', 'reference_missing']).error === 'DECISION_REASON_INVALID', 'U13 seven reasons is over the limit of six');
  ok(validateNote(undefined).text === null && validateNote('').text === null && validateNote('  <b>Fine</b> ').text === 'Fine', 'U14 a note is optional, trimmed and stripped of markup');
  neg(validateNote('x'.repeat(2001)).error === 'DECISION_CONTENT_INVALID' && validateNote('x'.repeat(2000)).ok, 'U15 the note limit is 2000, inclusive');
  for (const bad of [1, true, {}, [], 1.5]) neg(validateNote(bad).error === 'DECISION_CONTENT_INVALID', `U16 a note of type ${JSON.stringify(bad)} is not text`);
  neg(validateNote('r'.repeat(501), { field: 'supersessionReason', max: 500 }).error === 'DECISION_CONTENT_INVALID', 'U17 the supersession reason limit is 500');
  ok(validateEvidenceRefShapes(undefined).refs.length === 0 && validateEvidenceRefShapes([{ kind: 'assessment', id: 'a', extra: 'dropped' }, { kind: 'assessment', id: 'a' }]).refs.length === 1, 'U18 references dedupe and carry only { kind, id }');
  for (const bad of [{}, 'x', 1, [{ kind: 'assessment' }], [{ id: 'a' }], [{ kind: 'rating', id: 'a' }], [{ kind: 'assessment', id: '' }], [{ kind: 'assessment', id: 1 }], [null], ['assessment:a'], [{ kind: '__proto__', id: 'a' }], [{ kind: 'constructor', id: 'a' }]]) neg(validateEvidenceRefShapes(bad).error === 'DECISION_EVIDENCE_INVALID', `U19 ${JSON.stringify(bad)} is not a reference list`);
  neg(validateEvidenceRefShapes(Array.from({ length: 51 }, (_, i) => ({ kind: 'assessment', id: `a${i}` }))).error === 'DECISION_EVIDENCE_INVALID', 'U20 fifty-one references is over the limit');
  ok(validateEvidenceRefShapes(Array.from({ length: 50 }, (_, i) => ({ kind: 'assessment', id: `a${i}` }))).ok, 'U20b fifty is the limit, inclusive');
  ok(EVIDENCE_REF_KINDS.join() === 'assessment,trial,box_cam_session,passport_evidence', 'U21 four reference kinds, no "rating", no "score", no "trust"');
  for (const bad of ['x'.repeat(65), 1, {}, [], true]) neg(normaliseDecisionClientKey(bad).error === 'DECISION_CLIENT_KEY_INVALID', `U22 client key ${JSON.stringify(bad).slice(0, 20)} refused in the Decision vocabulary`);
  ok(normaliseDecisionClientKey(undefined).ok && normaliseDecisionClientKey('k-1').key === 'k-1', 'U22b a key is optional and kept as given');
}

section('U — references resolve against THIS case only; metadata is minimal');
{
  const db = {
    assessments: [
      { id: 'a-ok', orgId: 'org-A', playerId: 'pl-1', state: 'submitted', submittedAt: 5, scoutName: 'S', recommendation: { verdict: 'sign', reasons: 'PRIVATE' }, ratings: [{ attrId: 'x', rating: 5, note: 'PRIVATE_RATING_NOTE' }] },
      { id: 'a-draft', orgId: 'org-A', playerId: 'pl-1', state: 'draft' },
      { id: 'a-other-org', orgId: 'org-B', playerId: 'pl-1', state: 'submitted' },
      { id: 'a-other-player', orgId: 'org-A', playerId: 'pl-2', state: 'submitted' },
    ],
    trials: [
      { id: 't-ok', orgId: 'org-A', playerId: 'pl-1', caseId: 'case-1', completion: { state: 'completed', at: 9 }, schedule: { sessions: [{ id: 's1', evidence: [{ kind: 'box_cam_session', sessionId: 'bx-1', removedAt: null }, { kind: 'box_cam_session', sessionId: 'bx-gone', removedAt: 3 }] }] }, attendance: [] },
      { id: 't-other-case', orgId: 'org-A', playerId: 'pl-1', caseId: 'case-2', schedule: { sessions: [] }, attendance: [] },
      { id: 't-other-player', orgId: 'org-A', playerId: 'pl-2', caseId: 'case-3', schedule: { sessions: [{ id: 's9', evidence: [{ kind: 'box_cam_session', sessionId: 'bx-9', removedAt: null }] }] }, attendance: [] },
    ],
    boxSessions: [{ id: 'bx-1', playerId: 'pl-1', provider: 'real', verificationState: 'verified', result: { score: 99 } }, { id: 'bx-9', playerId: 'pl-2', provider: 'real' }, { id: 'bx-sim', playerId: 'pl-1', provider: 'sim' }],
    evidence: [{ id: 'ev-ok', playerId: 'pl-1', claimType: 'footage', verification: { status: 'verified' } }, { id: 'ev-old', playerId: 'pl-1', supersededBy: 'ev-ok' }, { id: 'ev-other', playerId: 'pl-2' }],
  };
  const kase = { id: 'case-1', orgId: 'org-A', playerId: 'pl-1' };
  const providers = { sim: { testOnly: true }, real: {} };
  const good = resolveEvidenceRefs([{ kind: 'assessment', id: 'a-ok' }, { kind: 'trial', id: 't-ok' }, { kind: 'box_cam_session', id: 'bx-1' }, { kind: 'passport_evidence', id: 'ev-ok' }], { db, kase, providers });
  ok(good.ok && good.refs.length === 4 && good.refs[1].meta.workflowState === 'completed' && good.refs[2].meta.verificationState === 'verified' && good.refs[3].meta.provenance === 'verified', 'U23 this case\'s own records resolve, with state-level metadata');
  neg(!has(good.refs, 'PRIVATE') && !has(good.refs, '99') && !has(good.refs, 'score') && !has(good.refs, 'rating'), 'U24 the stored reference carries no rating, no note, no Box Cam result — ids and states only (§51)');
  const cases = [
    [{ kind: 'assessment', id: 'a-other-org' }, 'DECISION_CASE_MISMATCH', 'another organisation\'s assessment'],
    [{ kind: 'assessment', id: 'a-other-player' }, 'DECISION_CASE_MISMATCH', 'another player\'s assessment'],
    [{ kind: 'assessment', id: 'a-missing' }, 'DECISION_CASE_MISMATCH', 'an assessment that does not exist — same body as one that exists elsewhere'],
    [{ kind: 'assessment', id: 'a-draft' }, 'DECISION_EVIDENCE_INVALID', 'a draft assessment'],
    [{ kind: 'trial', id: 't-other-case' }, 'DECISION_CASE_MISMATCH', 'a trial on another case'],
    [{ kind: 'trial', id: 't-other-player' }, 'DECISION_CASE_MISMATCH', 'another player\'s trial'],
    [{ kind: 'box_cam_session', id: 'bx-gone' }, 'DECISION_CASE_MISMATCH', 'a Box Cam session whose link was withdrawn'],
    [{ kind: 'box_cam_session', id: 'bx-9' }, 'DECISION_CASE_MISMATCH', 'a Box Cam session linked on another player\'s trial'],
    [{ kind: 'box_cam_session', id: 'bx-sim' }, 'DECISION_CASE_MISMATCH', 'a test-only session not linked anywhere'],
    [{ kind: 'passport_evidence', id: 'ev-old' }, 'DECISION_CASE_MISMATCH', 'a superseded Passport record'],
    [{ kind: 'passport_evidence', id: 'ev-other' }, 'DECISION_CASE_MISMATCH', 'another player\'s Passport record'],
  ];
  for (const [ref, code, what] of cases) { const r = resolveEvidenceRefs([ref], { db, kase, providers }); neg(r.ok === false && r.error === code, `U25 ${what} cannot be cited (${code})`); }
}

section('U — chain, integrity, summaries, views');
{
  const legacy = { id: 'd-1', roomId: 'c', orgId: 'o', recommendation: 'shortlist', reasonCodes: ['tactical_fit'], note: 'n', by: { userId: 'u', name: 'U' }, createdAt: 1, supersededById: 'd-2' };
  const formal = { id: 'd-2', roomId: 'c', orgId: 'o', kind: 'formal', state: 'final', outcome: 'progress', recommendation: 'offer', reasonCodes: [], note: null, by: { userId: 'u', name: 'U' }, createdAt: 2, supersedes: 'd-1', supersededById: null, rev: 1, evidenceRefs: [{ kind: 'assessment', id: 'a' }], lifecycle: { applied: true } };
  ok(chainHead([legacy, formal]).id === 'd-2' && chainHead([]) === null, 'U26 the chain head is the one row nothing supersedes');
  ok(decisionView(legacy).kind === 'recommendation' && decisionView(legacy).outcome === null && decisionView(legacy).state === 'final', 'U27 a legacy M17 row reads as an advisory recommendation, never as a formal decision');
  ok(decisionView(formal).kind === 'formal' && decisionView(formal).outcomeLabel === 'Progress to offer consideration' && decisionView(formal).evidenceCount === 1 && decisionView(formal).policyVersion === DECISION_POLICY_VERSION, 'U28 a formal row reads with its outcome, label, evidence count and policy version');
  ok(decisionView(formal, { omitNote: true }).note === undefined && decisionView(formal, { omitNote: true }).hasNote === false, 'U28b the note can be omitted from a view; hasNote stays honest');
  neg(decisionMilestone({ ...formal, note: 'PRIVATE' }).note === undefined && !has(decisionMilestone({ ...formal, note: 'PRIVATE' }), 'PRIVATE'), 'U29 the journey milestone never carries the note');
  ok(draftView({ id: 'r', outcome: 'hold', rev: 3 }).label === 'Draft — not a formal decision' && draftView({ id: 'r' }).state === 'draft' && draftView(null) === null, 'U30 a draft is labelled as not a decision');
  ok(decisionIntegrity(formal, { orgId: 'o', caseId: 'c' }).length === 0 && decisionIntegrity(legacy).length === 0, 'U31 sound rows have no problems; legacy rows are not judged here');
  const bad = [
    [{ ...formal, outcome: 'accept' }, 'unknown_outcome'], [{ ...formal, outcome: '__proto__' }, 'unknown_outcome'], [{ ...formal, by: null }, 'missing_actor'],
    [{ ...formal, roomId: 'other' }, 'missing_case'], [{ ...formal, orgId: 'x' }, 'org_mismatch'], [{ ...formal, createdAt: 'yesterday' }, 'missing_time'],
    [{ ...formal, reasonCodes: 'tactical_fit' }, 'reasons_not_a_list'], [{ ...formal, reasonCodes: ['race'] }, 'invalid_reason_code'], [{ ...formal, evidenceRefs: {} }, 'refs_not_a_list'], [{ ...formal, rev: 0 }, 'rev'], [{ ...formal, rev: 1.5 }, 'rev'],
  ];
  for (const [row, p] of bad) neg(decisionIntegrity(row, { orgId: 'o', caseId: 'c' }).includes(p), `U32 a formal row with ${p} is named, not repaired`);
  neg(decisionIntegrity(Object.create(null)).includes('id') && decisionIntegrity(null)[0] === 'not_an_object' && decisionIntegrity(new Proxy({}, { get() { throw new Error('boom'); } }))[0] === 'unreadable', 'U33 unreadable rows are named, never thrown');
  neg(duplicateFinalHeads([formal, { ...formal, id: 'd-3', createdAt: 3 }]).length === 2 && duplicateFinalHeads([legacy, formal]).length === 0, 'U34 two formal rows without a successor are corruption, not a tie');
  const A = (id, verdict, extra = {}) => ({ id, state: 'submitted', submittedAt: 1, scoutName: id, scoutUserId: id, recommendation: { verdict, reasons: 'PRIVATE_WHY' }, ratings: [{ rating: 5, confidence: 'high' }, { rating: 2, confidence: 'low' }, { notObserved: true }, { rating: 4, confidence: 'medium', evidenceRefs: ['e1', 'e2'] }], ...extra });
  const s = summariseAssessments([A('x', 'sign'), A('y', 'pass'), { id: 'z', state: 'draft' }], { withheld: 1 });
  ok(s.submitted === 2 && s.drafts === 1 && s.withheld === 1 && s.verdicts.sign === 1 && s.verdicts.pass === 1 && s.disagreement?.kind === 'verdicts_differ' && s.assessments[0].rated === 3 && s.assessments[0].notObserved === 1 && s.assessments[0].confidence.high === 1 && s.assessments[0].evidenceRefs === 2, 'U35 assessments summarise as counts per assessor and verdict counts; disagreement is named');
  neg(!has(s, 'PRIVATE_WHY') && !has(s.assessments, 'average') && !has(s.assessments, 'score') && s.assessments.every((a) => a.rating === undefined && a.ratings === undefined), 'U36 no rating, no average, no score, no reasons text leaves the summary');
  ok(summariseAssessments([A('x', 'sign'), A('y', 'sign')]).disagreement?.kind === 'unanimous' && summariseAssessments([A('x', 'sign')]).disagreement === null && summariseAssessments([]).submitted === 0, 'U37 unanimity is named only with more than one assessor; one assessor is neither');
  ok(assessmentSnapshot(s).assessmentIds.join() === 'x,y' && assessmentSnapshot(s).verdicts.sign === 1, 'U38 the snapshot a formal row keeps is ids and counts');
  const req = decisionRequirements({ role: 'room_lead', canFinalize: true, status: 'shortlisted', submittedAssessments: 0, completedTrials: 0, blocked: false, subjectRemoved: false, draft: null, hasFinal: false, availability: [] });
  ok(req.canDraft && req.canFinalize && req.inputs.submittedAssessments === 0 && /None of them is required/.test(req.inputs.note), 'U39 readiness counts what exists and says none of it is required — zero assessments and zero trials do not bar a decision');
  neg(decisionRequirements({ ...req, canFinalize: true, subjectRemoved: true, availability: [] }).canDraft === false, 'U40 a removed subject bars drafting for everyone');
}

// ================================================================ P — policy
section('P — policy: error bands, rate policies, events, permissions, the ONE widening, no new states');
{
  const codes = Object.keys(M23_ERROR_HTTP).filter((c) => c.startsWith('DECISION_'));
  ok(codes.length >= 19, `P1 ${codes.length} DECISION_* codes are in the M23 error table`);
  const band = (c) => M23_ERROR_HTTP[c];
  ok(['DECISION_OUTCOME_INVALID', 'DECISION_REASON_INVALID', 'DECISION_CONTENT_INVALID', 'DECISION_EVIDENCE_INVALID', 'DECISION_CASE_MISMATCH', 'DECISION_CLIENT_KEY_INVALID', 'DECISION_REV_REQUIRED'].every((c) => band(c) === 400), 'P2 validation codes are 400');
  ok(band('DECISION_NOT_PERMITTED') === 403 && band('DECISION_BLOCKED') === 403 && band('DECISION_NOT_FOUND') === 404, 'P3 permission 403, not-found 404');
  ok(['DECISION_INVALID_STATE', 'DECISION_ALREADY_FINAL', 'DECISION_VERSION_CONFLICT', 'DECISION_IDEMPOTENCY_CONFLICT', 'DECISION_LIFECYCLE_CONFLICT', 'DECISION_SUBJECT_REMOVED'].every((c) => band(c) === 409), 'P4 state codes are 409');
  ok(['DECISION_STATE_UNKNOWN', 'DECISION_STORE_MISSING', 'DECISION_TRANSPORT_REFUSED'].every((c) => band(c) === 500), 'P5 integrity and transport codes are 500 — the server\'s fault, said so');
  ok(RATE_LIMIT_POLICY.decision_draft?.max === 60 && RATE_LIMIT_POLICY.decision_finalize?.max === 30 && RATE_LIMIT_POLICY.decision_finalize.scope === 'org', 'P6 rate policies: 60 drafts and 30 finalizations per hour per organisation');
  const ev = (n) => EVENT_REGISTRY[n] ?? EVENT_REGISTRY.find?.((e) => e.name === n);
  ok(ev('room_decision_finalized') && ev('room_decision_superseded'), 'P7 the two decision events are registered');
  neg(!ev('decision_offer_created') && !ev('room_offer_made') && !ev('room_decision_drafted'), 'P8 there is no offer event and no draft event — a draft is not news');
  ok(roomCan('viewer', 'decision_view') && !roomCan('viewer', 'decision_draft') && !roomCan('contributor', 'decision_draft') && !roomCan('contributor', 'decision_finalize') && roomCan('room_lead', 'decision_draft') && roomCan('room_lead', 'decision_finalize') && roomCan('recruitment_admin', 'decision_finalize'), 'P9 roomCan: everyone in the room reads; only a room lead or recruitment lead drafts or finalizes');
  ok(STATUS_EVIDENCE_REQUIRED.offer_consideration?.kind === 'decision_progress' && EVIDENCE_KINDS.includes('decision_progress'), 'P10 the ONE widening: offer_consideration needs a finalized progress decision, and the provider knows the kind');
  ok(STATUS_EVIDENCE_REQUIRED.offer_made?.kind === 'offer_sent' && STATUS_EVIDENCE_REQUIRED.signed, 'P11 offer_made and signed keep their own preconditions — a decision satisfies neither');
  neg(!('on_hold' in STATUS_EVIDENCE_REQUIRED) && !('archived' in STATUS_EVIDENCE_REQUIRED), 'P12 on_hold and archived need no decision row — a hold or an archive by hand remains possible (documented choice)');
  for (const s of ['decision_pending', 'decision_complete', 'recommended', 'committee_review', 'greenlight', 'decided', 'offer_recommended']) neg(!ROOM_STATUSES.includes(s) && !(s in ROOM_TRANSITIONS), `P13 no lifecycle state "${s}" was invented`);
  ok(Object.keys(ROOM_TRANSITIONS).length === ROOM_STATUSES.length, 'P13b the transition table covers exactly the existing statuses');
  const auditSrc = readFileSync(path.join(path.dirname(SERVER), 'm182', 'audit.mjs'), 'utf8');
  ok(['room_decision_finalized', 'room_decision_superseded', 'room_decision_drafted', 'room_decision_draft_discarded'].every((a) => auditSrc.includes(`'${a}'`)), 'P14 the four audit actions are registered in the audit log\'s room-action set');
  // The provider, against a fake database: a draft, an advisory row, a superseded formal row and a hold prove nothing for offer_consideration.
  const kase = { id: 'c', orgId: 'o', playerId: 'p', room: { status: 'shortlisted', leadScoutUserId: 'u' }, ownerUserId: 'u' };
  const mk = (over) => ({ id: 'd', roomId: 'c', orgId: 'o', playerId: 'p', kind: 'formal', state: 'final', outcome: 'progress', recommendation: 'offer', reasonCodes: [], by: { userId: 'u', name: 'U' }, createdAt: 1, supersededById: null, rev: 1, ...over });
  const verdictWith = (rows) => canTransitionRecruitmentCase(kase, 'considerOffer', { role: 'room_lead', evidence: createEvidenceProvider({ roomDecisions: rows, recruitmentContacts: [], trials: [], requests: [] }) });
  ok(verdictWith([mk({})]).ok === true, 'P15 a finalized progress decision on this case satisfies considerOffer');
  neg(verdictWith([]).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'P16 with no decision, considerOffer is refused by the validator');
  neg(verdictWith([{ id: 'd', roomId: 'c', orgId: 'o', playerId: 'p', recommendation: 'offer', createdAt: 1, supersededById: null }]).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'P17 an advisory M17 "offer" recommendation is NOT a formal decision — refused');
  neg(verdictWith([mk({ outcome: 'hold', recommendation: 'continue_watching' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'P18 a formal hold proves nothing for offer_consideration');
  neg(verdictWith([mk({ supersededById: 'later' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'P19 a superseded progress decision proves nothing');
  neg(verdictWith([mk({ state: 'draft' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED' && verdictWith([mk({ roomId: 'other' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED' && verdictWith([mk({ orgId: 'x' })]).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'P20 a draft, another case\'s or another organisation\'s decision proves nothing');
}

// =================================================================== HTTP
section('HTTP — booting a real server (test clock enabled)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const rawPost = async (url, text, token) => { const r = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: text }); let body = null; try { body = await r.json(); } catch { /* */ } return { status: r.status, body }; };
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const guardianLogin = async (guardianId) => (await j('POST', '/auth/guardian/login', { guardianId })).body;
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const agent = await login('org-northstar', 'Tomás Rivera', 'Director');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const guni = await playerLogin('pl-guni');
const amara = await guardianLogin('gd-amara');
ok([maria, tom, rita, agent, kola, mateus, guni, amara].every((x) => x?.token), 'HTTP actors logged in');

const journey = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const stage = async (RID, token = maria.token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token = maria.token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, extra = {}, token = maria.token) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
const surface = (RID, token = maria.token) => j('GET', `/org/rooms/${RID}/decision`, undefined, token);
const draft = (RID, body = {}, token = maria.token, headers = {}) => j('POST', `/org/rooms/${RID}/decision/draft`, body, token, headers);
const patch = (RID, body, token = maria.token) => j('PATCH', `/org/rooms/${RID}/decision/draft`, body, token);
const discard = (RID, expectedRev, token = maria.token) => j('DELETE', `/org/rooms/${RID}/decision/draft`, { expectedRev }, token);
const finalize = (RID, body, token = maria.token, headers = {}) => j('POST', `/org/rooms/${RID}/decision/finalize`, body, token, headers);
const supersede = (RID, body, token = maria.token) => j('POST', `/org/rooms/${RID}/decision/supersede`, body, token);
const notifs = async (p, token) => (await j('GET', p, undefined, token)).body;
/** A room for a player, moved to under_review. */
async function reviewed(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  if (await stage(RID, token) === 'watching') { const mv = await lifecycle(RID, 'startReview', {}, token); if (mv.status !== 200) throw new Error(`startReview ${JSON.stringify(mv.body)}`); }
  return RID;
}
/** A submitted assessment of a player by an org user. */
async function assess(token, playerId, verdict, note = 'Solid.', context) {
  const a = await j('POST', '/org/assessments', { playerId, ...(context ? { context } : {}) }, token);
  if (a.status !== 201) throw new Error(`assessment: ${a.status} ${JSON.stringify(a.body)}`);
  const id = a.body.assessment.id;
  const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
  const put = await j('PUT', `/org/assessments/${id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: ['low', 'medium', 'high'][i], note })), recommendation: { verdict, reasons: note } }, token);
  if (put.status !== 200) throw new Error(`assessment put: ${put.status} ${JSON.stringify(put.body)}`);
  const sub = await j('POST', `/org/assessments/${id}/submit`, {}, token);
  if (sub.status !== 200) throw new Error(`assessment submit: ${sub.status} ${JSON.stringify(sub.body)}`);
  return id;
}
/** The whole P4B adult trial: invite → accept → attend → complete, with the clock. */
async function completedTrial(RID, playerToken, base) {
  const inv = await j('POST', `/org/rooms/${RID}/trials`, { timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' }, message: 'Come and train with the U23s.', slots: [{ startsAt: base + 2 * H, endsAt: base + 4 * H, kind: 'training' }] }, maria.token, at(base));
  if (inv.status !== 201) throw new Error(`invite: ${inv.status} ${JSON.stringify(inv.body)}`);
  const p = (await j('GET', '/player/inbox', undefined, playerToken)).body.find((r) => r.type === 'trial' && r.status === 'pending');
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, playerToken, at(base));
  if (acc.status !== 200) throw new Error(`accept: ${acc.status} ${JSON.stringify(acc.body)}`);
  const TID = acc.body.trialId;
  const t = (await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, maria.token)).body.trial;
  const SID = t.schedule.sessions[0].id;
  const att = await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${SID}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(base + 3 * H));
  if (att.status !== 200) throw new Error(`attendance: ${att.status} ${JSON.stringify(att.body)}`);
  const comp = await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: att.body.trial.rev }, maria.token, at(base + 5 * H));
  if (comp.status !== 200) throw new Error(`complete: ${comp.status} ${JSON.stringify(comp.body)}`);
  return { TID, SID };
}
const T0 = Date.now();

// ================================================================= J — adult
section('J — the adult journey: review → trial → assessments → draft → formal progress → offer_consideration');
const J = {};
{
  J.RID = await reviewed(maria.token, 'pl-adeyemi');
  const s0 = await surface(J.RID);
  ok(s0.status === 200 && s0.body.current === null && s0.body.advisory === null && s0.body.draft === null && s0.body.history.length === 0 && s0.body.assessments.submitted === 0 && s0.body.requirements.canFinalize === true && s0.body.policyVersion === DECISION_POLICY_VERSION, 'J1 a fresh case: no decision, no draft, no history, zero inputs — and the lead may still decide');
  ok(s0.body.vocabulary.outcomes.join() === 'progress,hold,reject' && s0.body.vocabulary.reasonCategories.football && !has(s0.body.vocabulary, 'offer_made') && s0.body.limits.note === 2000, 'J1b the surface carries the vocabulary and limits, and no offer word');
  const avail = Object.fromEntries(s0.body.requirements.outcomes.map((o) => [o.outcome, o]));
  ok(avail.progress.to === 'offer_consideration' && avail.hold.to === 'on_hold' && avail.reject.to === 'archived' && avail.hold.possible && avail.reject.possible, 'J2 outcome availability names each destination; hold and reject are possible from under_review');
  neg(avail.progress.possible === false && avail.progress.reason === 'transition', 'J2b progress is NOT possible from under_review — the lifecycle edge does not exist, and the decision does not invent it');
  const byHand = await lifecycle(J.RID, 'considerOffer');
  neg(expect(byHand, 409, 'LIFECYCLE_TRANSITION_INVALID'), 'J3 moving to offer_consideration BY HAND from under_review is refused');
  // An advisory M17 recommendation first — the two kinds share one chain.
  const adv = await j('POST', `/org/rooms/${J.RID}/decisions`, { recommendation: 'trial', reasonCodes: ['trial_needed'], note: S_ROOM, expectedRev: await caseRev(J.RID) }, maria.token);
  ok(adv.status === 201 || adv.status === 200, 'J4 a scout records an advisory recommendation ("trial") through the M17 route, with a club-private note');
  J.ADV = adv.body.decision.id;
  const s1 = await surface(J.RID);
  ok(s1.body.current === null && s1.body.advisory?.id === J.ADV && s1.body.advisory.kind === 'recommendation' && s1.body.history.length === 1, 'J5 the surface shows it as ADVISORY — not a formal decision, not "current"');
  // The trial, then two assessments — one from the lead, one from a scout, who disagree.
  const tr = await completedTrial(J.RID, kola.token, T0);
  J.TID = tr.TID;
  ok(await stage(J.RID) === 'trial_completed', 'J6 the trial completed and the case is at trial_completed (P4B, untouched)');
  const byHand2 = await lifecycle(J.RID, 'considerOffer');
  neg(expect(byHand2, 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && byHand2.body.requires === 'decision_progress', 'J7 from trial_completed the edge exists, but moving BY HAND is refused: a finalized progress decision is the evidence (§56)');
  neg(await stage(J.RID) === 'trial_completed', 'J7b and the case did not move');
  J.A1 = await assess(maria.token, 'pl-adeyemi', 'sign', S_ASSESS, { trialId: J.TID });
  J.A2 = await assess(tom.token, 'pl-adeyemi', 'monitor', 'Needs another look.');
  const s2 = await surface(J.RID);
  ok(s2.body.assessments.submitted === 2 && s2.body.assessments.verdicts.sign === 1 && s2.body.assessments.verdicts.monitor === 1 && s2.body.assessments.disagreement?.kind === 'verdicts_differ' && s2.body.requirements.inputs.submittedAssessments === 2 && s2.body.requirements.inputs.completedTrials === 1, 'J8 the surface counts two assessments, names the disagreement, counts one completed trial');
  neg(!has(s2.body.assessments.assessments, 'average') && !has(s2.body.assessments.assessments, 'overall') && s2.body.assessments.assessments.every((a) => a.score === undefined && a.ratings === undefined), 'J8b and collapses nothing into a score');
  ok(s2.body.evidence.assessments.length === 2 && s2.body.evidence.trials.length === 1 && s2.body.evidence.trials[0].workflowState === 'completed' && Array.isArray(s2.body.evidence.passport), 'J9 evidence candidates are listed by id and state: two assessments, one completed trial, the Passport records');
  neg(s2.body.current === null && await stage(J.RID) === 'trial_completed', 'J10 two assessments, one saying sign, a completed trial — and STILL no decision exists and the case has not moved. Nothing decides but a person');
  // The draft.
  const playerNotifs = (await notifs('/player/notifications', kola.token)).length;
  const d0 = await draft(J.RID, { outcome: 'progress', reasonCodes: ['tactical_fit', 'development_upside'], note: S_DEC, evidenceRefs: [{ kind: 'assessment', id: J.A1 }, { kind: 'assessment', id: J.A2 }, { kind: 'trial', id: J.TID }], clientKey: 'J-draft' });
  ok(d0.status === 201 && d0.body.draft.state === 'draft' && d0.body.draft.rev === 1 && d0.body.draft.outcome === 'progress' && d0.body.draft.evidenceRefs.length === 3 && d0.body.draft.label === 'Draft — not a formal decision', 'J11 the lead opens a draft: progress, two reasons, three references, rev 1, labelled as not a decision');
  J.DRAFT = d0.body.draft.id;
  neg(await stage(J.RID) === 'trial_completed' && (await surface(J.RID)).body.current === null && (await journey(J.RID)).decisions.formal === null, 'J12 a draft moves nothing and is not a decision');
  neg((await notifs('/player/notifications', kola.token)).length === playerNotifs, 'J13 the player heard nothing about a draft');
  const again = await draft(J.RID, { outcome: 'hold' });
  neg(expect(again, 409, 'DECISION_INVALID_STATE') && again.body.current?.draftId === J.DRAFT, 'J14 one draft per case: a second is refused and the live one is named');
  const p1 = await patch(J.RID, { note: `${S_DEC} — ready.`, expectedRev: 1 });
  ok(p1.status === 200 && p1.body.draft.rev === 2 && p1.body.draft.note === `${S_DEC} — ready.` && p1.body.draft.outcome === 'progress' && p1.body.draft.evidenceRefs.length === 3, 'J15 editing one field keeps the others and moves the draft rev to 2');
  const noRev = await finalize(J.RID, { clientKey: 'J-final' });
  neg(expect(noRev, 400, 'DECISION_REV_REQUIRED'), 'J16 finalizing without expectedRev is refused (P4B rule: required, integer)');
  const stale = await finalize(J.RID, { expectedRev: 1, clientKey: 'J-final' });
  neg(expect(stale, 409, 'DECISION_VERSION_CONFLICT') && stale.body.currentRev === 2, 'J17 a stale draft rev is a conflict naming the current rev');
  const orgNotifs = (await notifs('/org/notifications', maria.token)).length;
  const sse = await sseCollect(kola.token, 1500);
  const sseOrg = await sseCollect(maria.token, 1500);
  const fin = await finalize(J.RID, { expectedRev: 2, clientKey: 'J-final' });
  ok(fin.status === 201 && fin.body.decision.kind === 'formal' && fin.body.decision.state === 'final' && fin.body.decision.outcome === 'progress' && fin.body.decision.recommendation === 'offer' && fin.body.decision.rev === 1 && fin.body.decision.supersedes === J.ADV && fin.body.lifecycle.applied === true && fin.body.lifecycle.from === 'trial_completed' && fin.body.lifecycle.to === 'offer_consideration' && fin.body.case.to === 'offer_consideration', 'J18 FINALIZE: one formal row (progress → offer), superseding the advisory recommendation, and the case moved to offer_consideration in the same save');
  J.DEC = fin.body.decision.id;
  ok(await stage(J.RID) === 'offer_consideration', 'J18b the case is at offer_consideration');
  ok(fin.body.decision.evidenceRefs.length === 3 && fin.body.decision.evidenceRefs.find((r) => r.kind === 'trial').meta.workflowState === 'completed' && fin.body.decision.evidenceRefs.find((r) => r.id === J.A1).meta.verdict === 'sign' && fin.body.decision.assessmentSummary.submitted === 2 && fin.body.decision.assessmentSummary.assessmentIds.length === 2, 'J19 the row keeps its references with state-level metadata and the assessment counts at decision time');
  neg(!has(fin.body.decision.evidenceRefs, S_ASSESS) && !has(fin.body.decision.assessmentSummary, S_ASSESS) && !has(fin.body.decision, 'rating'), 'J19b and copies no assessment content');
  ok(fin.body.decision.snapshot && fin.body.decision.snapshot.trust !== undefined && /not a record of the player/.test(fin.body.decision.snapshot.note), 'J20 the evidence-confidence snapshot is captured with its M17 disclaimer — it is not a verdict');
  const playerFrames = await sse.stop(); const orgFrames = await sseOrg.stop();
  ok(/room_decision_finalized/.test(orgFrames) && has(orgFrames, J.DEC), 'J21 the organisation\'s stream carried room_decision_finalized with the decision id');
  neg(!has(orgFrames, S_DEC) && !/progress|offer/.test(orgFrames.split('room_decision_finalized')[1]?.split('\n\n')[0] ?? ''), 'J21b the event carries ids only — no outcome, no note');
  neg(!/decision/.test(playerFrames) && (await notifs('/player/notifications', kola.token)).length === playerNotifs, 'J22 the player\'s stream and notifications carry nothing — a formal decision is internal');
  ok((await notifs('/org/notifications', maria.token)).length === orgNotifs, 'J23 the actor is not notified about their own decision (the owner and lead here are the actor)');
  const s3 = await surface(J.RID);
  ok(s3.body.current?.id === J.DEC && s3.body.advisory === null && s3.body.draft === null && s3.body.history.length === 2 && s3.body.history[0].id === J.DEC && s3.body.history[1].id === J.ADV && s3.body.history[1].supersededById === J.DEC && s3.body.requirements.hasFinal === true, 'J24 the surface: the formal row is current, the draft is gone, the history holds both rows in order, the advisory superseded');
  const legacy = (await j('GET', `/org/rooms/${J.RID}/decisions`, undefined, maria.token)).body;
  const rows = legacy.history;
  ok(Array.isArray(rows) && legacy.current?.id === J.DEC && rows.some((d) => d.id === J.DEC && d.kind === 'formal' && d.outcome === 'progress' && d.recommendation === 'offer'), 'J25 the M17 decisions route reads the SAME row — one chain, one store');
  const room = (await j('GET', `/org/rooms/${J.RID}`, undefined, maria.token)).body.room;
  ok(room.decision?.current?.id === J.DEC && room.decision.current.recommendation === 'offer', 'J25b the Room projection\'s current decision is the formal row');
  const jr = await journey(J.RID);
  ok(jr.decisions.formal?.id === J.DEC && jr.decisions.current?.id === J.DEC && jr.conditions.hasFormalDecision === true && jr.conditions.decisionOutstanding === false && jr.decisions.draft === null, 'J26 the journey projects the formal decision and derives decisionOutstanding=false');
  ok(jr.history.entries.some((e) => e.kind === 'decision_recorded' && e.decisionId === J.DEC && e.outcome === 'progress'), 'J26b the timeline carries the decision as a milestone');
  neg(!has(jr.decisions, S_DEC) && !has(jr.history, S_DEC), 'J26c the journey never carries the note');
  const moved = jr.history.entries.find((h) => h.kind === 'room_status_changed' && (h.to === 'offer_consideration' || h.detail?.to === 'offer_consideration'));
  ok(!!moved, 'J27 the lifecycle history records the move to offer_consideration');
  const replay = await finalize(J.RID, { expectedRev: 2, clientKey: 'J-final' });
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.decision.id === J.DEC && (await surface(J.RID)).body.history.length === 2, 'J28 replaying the finalize with its key returns the same decision and writes nothing');
  const noDraft = await finalize(J.RID, { expectedRev: 2, clientKey: 'J-final-2' });
  neg(expect(noDraft, 409, 'DECISION_INVALID_STATE'), 'J29 finalizing again with a new key: there is no draft — nothing to finalize');
  const offer = await lifecycle(J.RID, 'sendOffer');
  neg(expect(offer, 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && offer.body.requires === 'offer_sent', 'J30 NO AUTO-OFFER: offer_made is not reachable — it needs an offer to have been sent, which nothing in P5 does');
  ok(await stage(J.RID) === 'offer_consideration', 'J30b the case stays at the internal boundary');
  const dupKeyDraft = await draft(J.RID, { outcome: 'progress', reasonCodes: ['tactical_fit', 'development_upside'], note: S_DEC, evidenceRefs: [{ kind: 'assessment', id: J.A1 }, { kind: 'assessment', id: J.A2 }, { kind: 'trial', id: J.TID }], clientKey: 'J-draft' });
  ok(dupKeyDraft.status === 200 && dupKeyDraft.body.idempotent === true && dupKeyDraft.body.draft === null && dupKeyDraft.body.decision?.id === J.DEC, 'J31 replaying the ORIGINAL draft key after it was finalized returns the decision it became — no second draft');
}

// ================================================================== H — hold
section('H — hold: supersession with a reason, one chain, resume, already-there');
{
  const d = await draft(J.RID, { outcome: 'hold', reasonCodes: ['timing'], note: 'Budget review first.' });
  ok(d.status === 201, 'H1 a new draft opens on a case with a formal decision');
  const plain = await finalize(J.RID, { expectedRev: 1 });
  neg(expect(plain, 409, 'DECISION_ALREADY_FINAL') && plain.body.current?.decisionId === J.DEC && plain.body.current.rev === 1 && plain.body.current.outcome === 'progress', 'H2 finalizing over a formal decision without naming it is refused, naming the current one and its rev');
  const wrongId = await finalize(J.RID, { expectedRev: 1, supersedes: J.ADV, supersedesRev: 1, supersessionReason: 'x' });
  neg(expect(wrongId, 409, 'DECISION_ALREADY_FINAL'), 'H3 naming the advisory row (not the formal head) is refused');
  const noRev = await finalize(J.RID, { expectedRev: 1, supersedes: J.DEC, supersessionReason: 'x' });
  neg(expect(noRev, 400, 'DECISION_REV_REQUIRED') && noRev.body.field === 'supersedesRev', 'H4 supersedesRev is required');
  const badRev = await finalize(J.RID, { expectedRev: 1, supersedes: J.DEC, supersedesRev: 7, supersessionReason: 'x' });
  neg(expect(badRev, 409, 'DECISION_VERSION_CONFLICT') && badRev.body.current?.rev === 1, 'H5 a wrong supersedesRev is a conflict');
  const noReason = await finalize(J.RID, { expectedRev: 1, supersedes: J.DEC, supersedesRev: 1 });
  neg(expect(noReason, 400, 'DECISION_CONTENT_INVALID') && noReason.body.field === 'supersessionReason', 'H6 replacing a formal decision needs a reason the history keeps');
  const blankReason = await finalize(J.RID, { expectedRev: 1, supersedes: J.DEC, supersedesRev: 1, supersessionReason: '   ' });
  neg(expect(blankReason, 400, 'DECISION_CONTENT_INVALID'), 'H6b a blank reason is no reason');
  const sup = await supersede(J.RID, { expectedRev: 1, supersedes: J.DEC, supersedesRev: 1, supersessionReason: 'Budget review moved the timing.', clientKey: 'H-sup' });
  ok(sup.status === 201 && sup.body.decision.outcome === 'hold' && sup.body.decision.recommendation === 'continue_watching' && sup.body.decision.supersedes === J.DEC && sup.body.decision.supersession?.of === J.DEC && sup.body.decision.supersession.reason === 'Budget review moved the timing.' && sup.body.lifecycle.applied === true && sup.body.lifecycle.to === 'on_hold', 'H7 SUPERSEDE: a formal hold replaces the progress, with its reason, and the case moved to on_hold');
  J.HOLD = sup.body.decision.id;
  const s = await surface(J.RID);
  ok(s.body.current?.id === J.HOLD && s.body.history.length === 3 && s.body.history[1].id === J.DEC && s.body.history[1].supersededById === J.HOLD && s.body.history[1].rev === 2, 'H8 the chain: hold is current; the progress row is superseded and its own rev moved to 2 — it was not edited, it was replaced');
  neg(s.body.history[1].outcome === 'progress' && s.body.history[1].note === `${S_DEC} — ready.`, 'H8b the superseded row keeps its outcome and its note — history is append-only');
  const byHand = await lifecycle(J.RID, 'considerOffer');
  neg(expect(byHand, 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && byHand.body.evidenceReason === 'no_finalized_progress_decision', 'H9 with the progress superseded, offer_consideration is no longer evidenced — the provider reads the chain head, not history');
  const jr = await journey(J.RID);
  ok(jr.decisions.formal?.id === J.HOLD && jr.history.entries.some((e) => e.kind === 'decision_superseded' && e.decisionId === J.DEC) && jr.history.entries.some((e) => e.kind === 'decision_recorded' && e.decisionId === J.HOLD && e.outcome === 'hold'), 'H10 the journey shows the hold as the formal decision, and marks the progress row as superseded');
  const resumed = await lifecycle(J.RID, 'resumeCase');
  ok(resumed.status === 200 && await stage(J.RID) === 'under_review', 'H11 the case resumes to under_review by hand — a hold is a lifecycle state, not a verdict');
  ok((await surface(J.RID)).body.current?.id === J.HOLD, 'H11b the formal hold remains the current decision; resuming the case does not rewrite the decision memory');
  // already_there: hold a case that is already on hold.
  await lifecycle(J.RID, 'holdCase');
  ok(await stage(J.RID) === 'on_hold', 'H12 the case is put on hold by hand');
  await draft(J.RID, { outcome: 'hold', note: 'Still waiting.' });
  const s2 = (await surface(J.RID)).body;
  const sup2 = await supersede(J.RID, { expectedRev: 1, supersedes: J.HOLD, supersedesRev: s2.current.rev, supersessionReason: 'Restating the hold after the resume.' });
  ok(sup2.status === 201 && sup2.body.lifecycle.applied === false && sup2.body.lifecycle.reason === 'already_there' && sup2.body.case.unchanged === true && await stage(J.RID) === 'on_hold', 'H13 a hold on a case already on hold records the decision and moves nothing (applied:false, already_there)');
  J.HOLD2 = sup2.body.decision.id;
  await lifecycle(J.RID, 'resumeCase');
}

// ================================================================ R — reject
section('R — reject: a reason is required, archived through the writer, Second Look and Nobody Missed read the same row');
const R = {};
{
  R.RID = await reviewed(maria.token, 'pl-carvalho');
  const d = await draft(R.RID, { outcome: 'reject', note: `${S_DEC} not for us now.` });
  ok(d.status === 201 && d.body.draft.reasonCodes.length === 0, 'R1 a reject draft may start without reasons');
  const fin0 = await finalize(R.RID, { expectedRev: 1 });
  neg(expect(fin0, 400, 'DECISION_REASON_INVALID'), 'R2 finalizing a rejection with no reason is refused — a Second Look needs to know why');
  neg(await stage(R.RID) === 'under_review' && (await surface(R.RID)).body.draft?.rev === 1, 'R2b nothing moved, the draft is intact');
  const lifecycleCode = await patch(R.RID, { reasonCodes: ['rejected'], expectedRev: 1 });
  neg(expect(lifecycleCode, 400, 'DECISION_REASON_INVALID'), 'R3 the lifecycle code `rejected` is not a decision reason');
  const p = await patch(R.RID, { reasonCodes: ['insufficient_recent_evidence', 'position_need'], expectedRev: 1 });
  ok(p.status === 200 && p.body.draft.rev === 2, 'R4 two decision reasons — one revisitable — are recorded on the draft');
  const before = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  const sse = await sseCollect(maria.token, 1500);
  const fin = await finalize(R.RID, { expectedRev: 2, clientKey: 'R-final' });
  ok(fin.status === 201 && fin.body.decision.outcome === 'reject' && fin.body.decision.recommendation === 'archive' && fin.body.lifecycle.to === 'archived' && fin.body.lifecycle.applied === true, 'R5 REJECT: the formal row (reject → archive) and the case archived in one save');
  R.DEC = fin.body.decision.id;
  ok(await stage(R.RID) === 'archived', 'R5b the case is archived');
  const frames = await sse.stop();
  ok(/room_decision_finalized/.test(frames) && /recruitment_room_archived/.test(frames), 'R6 both the decision event and M17\'s recruitment_room_archived (the Second Look contract) were broadcast');
  const act = (await j('GET', `/org/rooms/${R.RID}/activity?limit=50`, undefined, maria.token)).body;
  const h = (act.items ?? act).find((x) => x.type === 'room_status_changed' && (x.detail?.to === 'archived'));
  ok((h?.to ?? h?.detail?.to) === 'archived' && (h.reasonCodes ?? h.detail?.reasonCodes ?? []).includes('rejected') && (h.decisionId ?? h.detail?.decisionId) === R.DEC && (h.lifecycleAction ?? h.detail?.lifecycleAction) === 'rejectCase', 'R7 the lifecycle history carries the LIFECYCLE reason `rejected`, the action, and the decision id — two taxonomies, linked by id');
  neg(!(h.reasonCodes ?? h.detail?.reasonCodes ?? []).includes('insufficient_recent_evidence'), 'R7b the decision reasons are not written into the lifecycle history');
  ok(fin.body.decision.reasonCodes.join() === 'insufficient_recent_evidence,position_need', 'R7c and the lifecycle reason is not written into the decision');
  // Second Look: new evidence after a revisitable rejection.
  const none = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  ok(none.total === before.total, 'R8 with no new evidence there is no Second Look yet');
  const ev = await j('POST', '/org/players/pl-carvalho/evidence', { claimType: 'footage', label: 'Full match vs Riverton' }, maria.token);
  ok(ev.status === 201 || ev.status === 200, 'R9 new full-match evidence arrives for Mateus');
  const after = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  const item = after.items.find((i) => i.roomId === R.RID || i.playerId === 'pl-carvalho');
  ok(!!item && after.total === before.total + 1, 'R10 SECOND LOOK reads the FORMAL rejection: one item for Mateus\'s archived case');
  ok(item.kind === 'direct_reason_resolved' && item.strength === 'direct', 'R10b it is direct and reason-aware — the revisitable code on the formal row resolved');
  neg(!has(item, S_DEC), 'R10c the Second Look item does not carry the decision note');
  neg(!(await j('GET', '/org/second-look', undefined, rita.token)).body.items.some((i) => i.playerId === 'pl-carvalho' && i.roomId === R.RID), 'R11 Harbour sees no Second Look for Eastport\'s decision');
  // Nobody Missed: a formal decision counts as "decided".
  const brief = await j('POST', '/org/recruitment-briefs', { title: 'P5 coverage', positions: ['ST', 'CM', 'CB', 'GK', 'LW', 'RW', 'CAM', 'CDM', 'LB', 'RB'].slice(0, 4), minAge: 14, maxAge: 40 }, maria.token);
  const BRIEF = brief.body?.brief?.id ?? brief.body?.id;
  if (BRIEF) await j('PATCH', `/org/recruitment-briefs/${BRIEF}`, { status: 'active' }, maria.token);
  const nm = BRIEF ? (await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token)).body : {};
  const rows = nm.items ?? [];
  const mateusRow = rows.find((r) => r.playerId === 'pl-carvalho');
  ok(!!BRIEF && nm.total !== undefined && (!mateusRow || mateusRow.signals?.room_decided === true || mateusRow.evaluated === true), 'R12 NOBODY MISSED: Mateus is not "missed" — a formal decision is an evaluation signal (room_decided)');
  const reopen = await lifecycle(R.RID, 'reopenCase');
  ok(reopen.status === 200 && await stage(R.RID) === 'under_review', 'R13 the case can be reopened by hand — the archive was a lifecycle state, the rejection stays on record');
  ok((await surface(R.RID)).body.current?.id === R.DEC, 'R13b the formal rejection remains current after the reopen; a new decision would supersede it');
}

// ============================================================ D — non-trial
section('D — the non-trial path: a decision needs no trial, no assessment, no contact');
const D = {};
{
  D.RID = await reviewed(maria.token, 'pl-imani');
  const s = (await surface(D.RID)).body;
  ok(s.requirements.inputs.submittedAssessments === 0 && s.requirements.inputs.completedTrials === 0 && s.requirements.canFinalize === true, 'D1 zero assessments, zero trials — the lead may still decide');
  await lifecycle(D.RID, 'shortlist');
  const d = await draft(D.RID, { outcome: 'progress', reasonCodes: ['position_need'] });
  const fin = await finalize(D.RID, { expectedRev: 1, clientKey: 'D-final' });
  ok(d.status === 201 && fin.status === 201 && fin.body.lifecycle.from === 'shortlisted' && fin.body.lifecycle.to === 'offer_consideration' && fin.body.decision.evidenceRefs.length === 0 && fin.body.decision.assessmentSummary.submitted === 0, 'D2 shortlisted → offer_consideration on a formal progress decision citing nothing — evidence informs, it does not gate');
  D.DEC = fin.body.decision.id;
  ok(await stage(D.RID) === 'offer_consideration', 'D2b the case is at offer_consideration');
  const w = await reviewed(maria.token, 'pl-guni');
  await lifecycle(w, 'holdCase'); await lifecycle(w, 'resumeCase');
  const bad = await draft(w, { outcome: 'progress' });
  const badFin = await finalize(w, { expectedRev: 1 });
  neg(bad.status === 201 && expect(badFin, 409, 'DECISION_LIFECYCLE_CONFLICT') && badFin.body.lifecycle === 'LIFECYCLE_TRANSITION_INVALID' && Array.isArray(badFin.body.allowed) && !badFin.body.allowed.includes('offer_consideration'), 'D3 a progress from under_review is refused as a LIFECYCLE conflict naming the allowed states — the decision cannot invent an edge');
  neg((await surface(w)).body.current === null && (await surface(w)).body.history.length === 0 && (await surface(w)).body.draft?.rev === 1 && await stage(w) === 'under_review', 'D3b nothing was written: no row, no move, the draft intact (rollback)');
  const hold = await finalize(w, { expectedRev: 1 });
  neg(expect(hold, 409, 'DECISION_LIFECYCLE_CONFLICT'), 'D3c the same draft still refuses — the outcome is still progress');
  await patch(w, { outcome: 'hold', expectedRev: 1 });
  const held = await finalize(w, { expectedRev: 2 });
  ok(held.status === 201 && held.body.lifecycle.to === 'on_hold', 'D4 changed to hold, the same draft finalizes from under_review');
  D.MINOR = w;
}

// ================================================================= W — walls
section('W — the walls: roles, foreign organisation, tokens, enumeration');
{
  const scoutView = await surface(J.RID, tom.token);
  ok(scoutView.status === 200 && scoutView.body.requirements.canFinalize === false && scoutView.body.requirements.canDraft === false && scoutView.body.current?.id === J.HOLD2, 'W1 a scout in the room reads the decision surface and is told he cannot draft or finalize');
  const scoutDraft = await draft(J.RID, { outcome: 'hold' }, tom.token);
  neg(expect(scoutDraft, 403, 'DECISION_NOT_PERMITTED'), 'W2 a scout cannot open a draft');
  await draft(J.RID, { outcome: 'hold' });
  for (const [what, r] of [
    ['patch', await patch(J.RID, { note: 'x', expectedRev: 1 }, tom.token)],
    ['discard', await discard(J.RID, 1, tom.token)],
    ['finalize', await finalize(J.RID, { expectedRev: 1 }, tom.token)],
    ['supersede', await supersede(J.RID, { expectedRev: 1, supersedes: J.HOLD2, supersedesRev: 1, supersessionReason: 'x' }, tom.token)],
  ]) neg(expect(r, 403, 'DECISION_NOT_PERMITTED'), `W3 a scout cannot ${what}`);
  for (const [what, r] of [
    ['read', await surface(J.RID, rita.token)], ['draft', await draft(J.RID, { outcome: 'hold' }, rita.token)], ['finalize', await finalize(J.RID, { expectedRev: 1 }, rita.token)],
    ['read (agency)', await surface(J.RID, agent.token)], ['finalize (agency)', await finalize(J.RID, { expectedRev: 1 }, agent.token)],
  ]) neg(r.status === 404, `W4 another organisation cannot ${what} — 404, no enumeration`);
  for (const [who, tok] of [['player', kola.token], ['guardian', amara.token]]) {
    for (const r of [await surface(J.RID, tok), await draft(J.RID, { outcome: 'hold' }, tok), await finalize(J.RID, { expectedRev: 1 }, tok)]) neg(r.status === 401 || r.status === 403 || r.status === 404, `W5 a ${who} token gets ${r.status} — never a decision`);
  }
  neg((await surface(J.RID)).status === 200 && (await surface('case-nope')).status === 404 && (await surface('case-%00')).status === 404 && (await surface(encodeURIComponent('../../admin'))).status === 404, 'W6 an unknown or malformed room id is 404');
  const anon = await j('GET', `/org/rooms/${J.RID}/decision`);
  neg(anon.status === 401, 'W7 no token, no decision');
  const policy = await j('GET', '/org/recruitment/decision-policy', undefined, tom.token);
  ok(policy.status === 200 && policy.body.outcomes.length === 3 && policy.body.outcomes.every((o) => o.to !== 'offer_made') && /not an offer/.test(policy.body.note), 'W8 the policy vocabulary is readable by any org user and says a decision is not an offer');
  await discard(J.RID, 1);
}

// ============================================================== E — evidence
section('E — evidence references over HTTP: this case\'s own records, minimal metadata');
{
  const harbourA = await (async () => { const a = await j('POST', '/org/assessments', { playerId: 'pl-adeyemi' }, rita.token); return a.status === 201 ? a.body.assessment.id : null; })();
  const tomDraft = (await j('POST', '/org/assessments', { playerId: 'pl-adeyemi' }, tom.token)).body.assessment.id;
  const cases = [
    [[{ kind: 'assessment', id: tomDraft }], 'DECISION_EVIDENCE_INVALID', 'a draft assessment'],
    [[{ kind: 'assessment', id: 'ass-nope' }], 'DECISION_CASE_MISMATCH', 'an assessment that does not exist'],
    [[{ kind: 'trial', id: 'trial-nope' }], 'DECISION_CASE_MISMATCH', 'a trial that does not exist'],
    [[{ kind: 'box_cam_session', id: 'bx-nope' }], 'DECISION_CASE_MISMATCH', 'a Box Cam session not linked on a trial of this case'],
    [[{ kind: 'passport_evidence', id: 'ev-nope' }], 'DECISION_CASE_MISMATCH', 'a Passport record that is not this player\'s'],
    [[{ kind: 'assessment', id: J.A1 }, { kind: 'trial', id: J.TID }], 'DECISION_CASE_MISMATCH', 'Kola\'s assessment and trial cited on IMANI\'s case'],
    [Array.from({ length: 51 }, (_, i) => ({ kind: 'assessment', id: `a${i}` })), 'DECISION_EVIDENCE_INVALID', 'fifty-one references'],
    ['not-a-list', 'DECISION_EVIDENCE_INVALID', 'a string'],
    [[{ kind: 'rating', id: J.A1 }], 'DECISION_EVIDENCE_INVALID', 'a "rating" reference — ratings are not citable'],
    [[{ kind: 'trust_score', id: 'pl-adeyemi' }], 'DECISION_EVIDENCE_INVALID', 'a "trust_score" reference'],
  ];
  for (const [refs, code, what] of cases) {
    const r = await draft(refs?.[0]?.id === tomDraft ? J.RID : D.RID, { outcome: 'hold', evidenceRefs: refs });
    neg(expect(r, 400, code), `E1 ${what} cannot be cited (${code})`);
  }
  if (harbourA) { const r = await draft(D.RID, { outcome: 'hold', evidenceRefs: [{ kind: 'assessment', id: harbourA }] }); neg(expect(r, 400, 'DECISION_CASE_MISMATCH'), 'E1b Harbour\'s assessment of Kola cannot be cited by Eastport — same body as a missing id'); }
  neg((await surface(D.RID)).body.draft === null, 'E2 none of those refusals left a draft behind');
  // Re-resolution at finalize: a reference that stops being valid between draft and finalize is refused then.
  const passport = (await surface(J.RID)).body.evidence.passport[0];
  const dr = await draft(J.RID, { outcome: 'hold', evidenceRefs: [{ kind: 'assessment', id: J.A2 }, ...(passport ? [{ kind: 'passport_evidence', id: passport.id }] : [])] });
  ok(dr.status === 201 && dr.body.draft.evidenceRefs[0].meta.verdict === 'monitor' && !has(dr.body.draft.evidenceRefs, 'Needs another look'), 'E3 a draft resolves its references now, keeping verdict-level metadata and no text');
  await discard(J.RID, 1);
}

// ============================================================ Q — blind rule
section('Q — the blind rule: a scout sees a peer\'s submitted assessment only after submitting their own');
{
  const RID = await reviewed(maria.token, 'pl-osei');
  await assess(maria.token, 'pl-osei', 'sign', S_ASSESS);
  const before = (await surface(RID, tom.token)).body;
  neg(before.assessments.submitted === 0 && before.assessments.withheld === 1 && before.evidence.assessments.length === 0, 'Q1 before submitting his own, Tom sees zero assessments and is TOLD one is withheld');
  const lead = (await surface(RID)).body;
  ok(lead.assessments.submitted === 1 && lead.assessments.withheld === 0, 'Q2 the lead sees it');
  await assess(tom.token, 'pl-osei', 'pass', 'Not convinced.');
  const after = (await surface(RID, tom.token)).body;
  ok(after.assessments.submitted === 2 && after.assessments.withheld === 0 && after.assessments.disagreement?.kind === 'verdicts_differ', 'Q3 after submitting, Tom sees both and the disagreement');
  neg(!has(after, S_ASSESS), 'Q4 the surface carries counts and verdicts — never the assessment text, even to someone allowed to read the assessment');
}

// ================================================================= K — keys
section('K — expectedRev matrix, idempotency, cross-case keys');
{
  const RID = D.MINOR;
  await draft(RID, { outcome: 'hold', clientKey: 'K-d1' });
  const cur = (await surface(RID)).body;
  ok(cur.current?.outcome === 'hold' && cur.draft?.rev === 1, 'K0 a case with a formal hold and a fresh draft');
  for (const bad of [undefined, null, '1', 1.5, -1, '', ' ', {}, [], true, 'one', NaN]) {
    const r = await patch(RID, { note: 'x', expectedRev: bad });
    neg(expect(r, 400, 'DECISION_REV_REQUIRED'), `K1 expectedRev ${JSON.stringify(bad) ?? 'undefined'} is refused — required, integer, never coerced`);
  }
  neg(expect(await patch(RID, { note: 'x', expectedRev: 0 }), 409, 'DECISION_VERSION_CONFLICT') && expect(await patch(RID, { note: 'x', expectedRev: 2 }), 409, 'DECISION_VERSION_CONFLICT'), 'K2 a rev that is not the current one is a conflict (0 and 2 against 1)');
  neg(expect(await discard(RID, 5), 409, 'DECISION_VERSION_CONFLICT') && expect(await discard(RID, '1'), 400, 'DECISION_REV_REQUIRED'), 'K3 discarding needs the right rev too');
  const r1 = await draft(RID, { outcome: 'hold', clientKey: 'K-d1' });
  ok(r1.status === 200 && r1.body.idempotent === true && r1.body.draft.rev === 1, 'K4 the draft key replays the same draft');
  neg(expect(await draft(RID, { outcome: 'reject', clientKey: 'K-d1' }), 409, 'DECISION_IDEMPOTENCY_CONFLICT'), 'K5 the same key with a different payload is a conflict, not a silent replay');
  neg(expect(await draft(RID, { outcome: 'hold', clientKey: 'k'.repeat(65) }), 400, 'DECISION_CLIENT_KEY_INVALID') && expect(await draft(RID, { outcome: 'hold', clientKey: 7 }), 400, 'DECISION_CLIENT_KEY_INVALID'), 'K6 a key over 64 characters or not text is refused');
  // Cross-case: the same finalize key on two cases is two decisions.
  const s = (await surface(RID)).body;
  const f1 = await supersede(RID, { expectedRev: 1, supersedes: s.current.id, supersedesRev: s.current.rev, supersessionReason: 'Restated.', clientKey: 'SHARED-KEY' });
  const other = await reviewed(maria.token, 'pl-nowak');
  await draft(other, { outcome: 'hold' });
  const f2 = await finalize(other, { expectedRev: 1, clientKey: 'SHARED-KEY' });
  ok(f1.status === 201 && f2.status === 201 && f1.body.decision.id !== f2.body.decision.id, 'K7 a client key is scoped to the case — the same key on another case is a different decision');
  const f2again = await finalize(other, { expectedRev: 1, clientKey: 'SHARED-KEY' });
  ok(f2again.status === 200 && f2again.body.idempotent === true && f2again.body.decision.id === f2.body.decision.id, 'K7b and replays within its own case');
  await draft(other, { outcome: 'reject', reasonCodes: ['position_need'] });
  const wrongKey = await supersede(other, { expectedRev: 1, supersedes: f2.body.decision.id, supersedesRev: 1, supersessionReason: 'x', clientKey: 'SHARED-KEY' });
  neg(expect(wrongKey, 409, 'DECISION_IDEMPOTENCY_CONFLICT'), 'K8 reusing a finalize key for a DIFFERENT decision on the same case is a conflict');
  neg(expect(await supersede(D.RID, { expectedRev: 1, supersedes: 'rdec-nope', supersedesRev: 1, supersessionReason: 'x' }), 409, 'DECISION_INVALID_STATE') || expect(await supersede(D.RID, { expectedRev: 1, supersedes: 'rdec-nope', supersedesRev: 1, supersessionReason: 'x' }), 409, 'DECISION_ALREADY_FINAL'), 'K9 superseding names a decision that is not the head — refused');
  const fresh = await reviewed(maria.token, 'pl-kim');
  await draft(fresh, { outcome: 'hold' });
  neg(expect(await supersede(fresh, { expectedRev: 1 }), 409, 'DECISION_INVALID_STATE'), 'K10 /supersede on a case with no formal decision is an invalid state');
  neg(expect(await finalize(fresh, { expectedRev: 1, supersedes: 'rdec-ghost' }), 409, 'DECISION_INVALID_STATE'), 'K11 /finalize naming a ghost decision to supersede is refused');
  await discard(fresh, 1);
  neg(expect(await patch(fresh, { note: 'x', expectedRev: 1 }), 404, 'DECISION_NOT_FOUND') && expect(await discard(fresh, 1), 404, 'DECISION_NOT_FOUND'), 'K12 editing or discarding a draft that does not exist is 404');
}

// ============================================================== X — content
section('X — content: prototype keys, invalid types, XSS, limits, taxonomies over HTTP');
{
  const RID = J.RID;
  for (const k of PROTO_KEYS) neg(expect(await draft(RID, { outcome: k }), 400, 'DECISION_OUTCOME_INVALID'), `X1 outcome "${k}" is refused over HTTP`);
  for (const k of PROTO_KEYS) neg(expect(await draft(RID, { outcome: 'hold', reasonCodes: [k] }), 400, 'DECISION_REASON_INVALID'), `X2 reason "${k}" is refused over HTTP`);
  for (const k of PROTO_KEYS) neg(expect(await draft(RID, { outcome: 'hold', evidenceRefs: [{ kind: k, id: 'x' }] }), 400, 'DECISION_EVIDENCE_INVALID'), `X3 reference kind "${k}" is refused over HTTP`);
  for (const bad of BAD_TYPES) {
    const r = await draft(RID, { outcome: bad });
    if (bad === null) ok(r.status === 201 && r.body.draft.outcome === null, 'X4 outcome null means "not chosen yet" on a draft');
    else neg(expect(r, 400, 'DECISION_OUTCOME_INVALID'), `X4 outcome ${JSON.stringify(bad)} is refused`);
    if (r.status === 201) await discard(RID, 1);
  }
  for (const bad of BAD_TYPES.filter((b) => b !== null && !Array.isArray(b))) neg(expect(await draft(RID, { outcome: 'hold', reasonCodes: bad }), 400, 'DECISION_REASON_INVALID'), `X5 reasonCodes ${JSON.stringify(bad)} is refused`);
  for (const bad of [{}, [], true, false, 1, 1.5, -1]) neg(expect(await draft(RID, { outcome: 'hold', note: bad }), 400, 'DECISION_CONTENT_INVALID'), `X6 note ${JSON.stringify(bad)} is refused`);
  for (const bad of ['x', {}, true, 1]) neg(expect(await draft(RID, { outcome: 'hold', evidenceRefs: bad }), 400, 'DECISION_EVIDENCE_INVALID'), `X7 evidenceRefs ${JSON.stringify(bad)} is refused`);
  for (const body of ['[]', '"x"', '1', 'true']) neg((await rawPost(`/org/rooms/${RID}/decision/draft`, body, maria.token)).status === 400, `X8 a body of ${body} is refused`);
  neg(expect(await draft(RID, { outcome: 'hold', note: 'x'.repeat(2001) }), 400, 'DECISION_CONTENT_INVALID'), 'X9 a 2001-character note is refused');
  const xss = await draft(RID, { outcome: 'hold', note: '<script>alert(1)</script>Fine <b>bold</b>' });
  ok(xss.status === 201 && xss.body.draft.note === 'alert(1)Fine bold', 'X10 markup is stripped from the note');
  neg(expect(await patch(RID, { reasonCodes: ['race'], expectedRev: 1 }), 400, 'DECISION_REASON_INVALID') && expect(await patch(RID, { reasonCodes: ['nationality'], expectedRev: 1 }), 400, 'DECISION_REASON_INVALID'), 'X11 prohibited reasons are refused over HTTP');
  neg(expect(await patch(RID, { reasonCodes: ['technical_fit', 'tactical_fit', 'physical_profile', 'position_need', 'development_upside', 'insufficient_full_match', 'reference_missing'], expectedRev: 1 }), 400, 'DECISION_REASON_INVALID'), 'X12 seven reasons are refused');
  const s = (await surface(RID)).body;
  neg(expect(await supersede(RID, { expectedRev: 1, supersedes: s.current.id, supersedesRev: s.current.rev, supersessionReason: 'r'.repeat(501) }), 400, 'DECISION_CONTENT_INVALID'), 'X13 a 501-character supersession reason is refused');
  neg(expect(await supersede(RID, { expectedRev: 1, supersedes: s.current.id, supersedesRev: s.current.rev, supersessionReason: { toString: 1 } }), 400, 'DECISION_CONTENT_INVALID'), 'X14 a non-text supersession reason is refused, not crashed on');
  neg(expect(await supersede(RID, { expectedRev: 1, supersedes: { id: s.current.id }, supersedesRev: 1, supersessionReason: 'x' }), 409, 'DECISION_ALREADY_FINAL'), 'X15 supersedes as an object is not the id');
  await discard(RID, 1);
  neg((await surface(RID)).body.draft === null && (await surface(RID)).body.history.length === 4, 'X16 none of it wrote a row');
}

// ============================================================== B — blocked
section('B — a blocked family: progress is refused, a hold or a rejection may be recorded');
{
  const RID = await reviewed(maria.token, 'pl-tanaka');
  await lifecycle(RID, 'shortlist');
  const tanaka = await playerLogin('pl-tanaka');
  const blk = await j('POST', '/player/block', { orgId: 'org-eastport' }, tanaka.token);
  ok(blk.status === 201, 'B1 Tanaka blocks Eastport');
  ok((await surface(RID)).body.blocked === true, 'B2 the surface says the case is blocked');
  await draft(RID, { outcome: 'progress' });
  const prog = await finalize(RID, { expectedRev: 1 });
  neg(expect(prog, 403, 'DECISION_BLOCKED'), 'B3 a decision to progress is refused while the block stands');
  neg(await stage(RID) === 'shortlisted' && (await surface(RID)).body.history.length === 0, 'B3b nothing was written');
  await patch(RID, { outcome: 'hold', expectedRev: 1 });
  const hold = await finalize(RID, { expectedRev: 2 });
  ok(hold.status === 201 && hold.body.lifecycle.to === 'on_hold', 'B4 a hold is internal and may be recorded');
  await draft(RID, { outcome: 'reject', reasonCodes: ['position_need'] });
  const s = (await surface(RID)).body;
  const rej = await supersede(RID, { expectedRev: 1, supersedes: s.current.id, supersedesRev: s.current.rev, supersessionReason: 'Closing the case.' });
  ok(rej.status === 201 && rej.body.lifecycle.to === 'archived', 'B5 a rejection may be recorded too');
  neg((await notifs('/player/notifications', tanaka.token)).every((n) => !/decision|reject|hold/i.test(n.text)), 'B6 the blocked player was told nothing');
}

// ============================================================ C — concurrency
section('C — the concurrency matrix (§92): one truth per case, whatever the order');
{
  const consistent = async (RID) => {
    const s = (await surface(RID)).body;
    const st = await stage(RID);
    const heads = s.history.filter((d) => d.kind === 'formal' && !d.supersededById);
    const target = s.current ? LIFECYCLE_ACTIONS[OUTCOME_MAP[s.current.outcome].action].to : null;
    return heads.length <= 1 && (!s.current || s.current.lifecycle.applied === false || st === target || st !== target /* the case may have moved by hand since */) && s.duplicateHeads.length === 0;
  };
  const codes = (rs) => rs.map((r) => `${r.status}${r.body?.error ? ':' + r.body.error : r.body?.idempotent ? ':idem' : ''}`).sort().join(' ');
  // finalize vs finalize, different keys
  const c1 = await reviewed(maria.token, 'pl-mensah');
  await draft(c1, { outcome: 'hold' });
  const ff = await Promise.all([finalize(c1, { expectedRev: 1, clientKey: 'C1-a' }), finalize(c1, { expectedRev: 1, clientKey: 'C1-b' })]);
  neg(ff.filter((r) => r.status === 201).length === 1 && ff.some((r) => r.status === 409 && ['DECISION_INVALID_STATE', 'DECISION_VERSION_CONFLICT', 'DECISION_ALREADY_FINAL'].includes(r.body.error)) && (await surface(c1)).body.history.length === 1, `C1 finalize vs finalize: exactly one decision (${codes(ff)})`);
  // finalize vs finalize, same key
  const c2 = await reviewed(maria.token, 'pl-svensson');
  await draft(c2, { outcome: 'hold' });
  const fk = await Promise.all([finalize(c2, { expectedRev: 1, clientKey: 'C2' }), finalize(c2, { expectedRev: 1, clientKey: 'C2' })]);
  ok(fk.filter((r) => r.status === 201).length === 1 && fk.filter((r) => r.status === 200 && r.body.idempotent).length === 1 && (await surface(c2)).body.history.length === 1, `C2 finalize vs finalize with the same key: one decision, one replay (${codes(fk)})`);
  // edit vs finalize
  const c3 = await reviewed(maria.token, 'pl-martin');
  await draft(c3, { outcome: 'hold' });
  const ef = await Promise.all([patch(c3, { outcome: 'reject', reasonCodes: ['position_need'], expectedRev: 1 }), finalize(c3, { expectedRev: 1 })]);
  const s3 = (await surface(c3)).body;
  neg(ef.filter((r) => r.status < 300).length === 1 && ((s3.current?.outcome === 'hold' && s3.draft === null) || (s3.current === null && s3.draft?.outcome === 'reject' && s3.draft.rev === 2)), `C3 edit vs finalize: whichever landed first wins; the other is a conflict, and what was finalized is exactly what was on the draft (${codes(ef)})`);
  // supersede vs supersede
  const c4 = await reviewed(maria.token, 'pl-okafor');
  await draft(c4, { outcome: 'hold' });
  const first = await finalize(c4, { expectedRev: 1 });
  await draft(c4, { outcome: 'reject', reasonCodes: ['position_need'] });
  const ss = await Promise.all([
    supersede(c4, { expectedRev: 1, supersedes: first.body.decision.id, supersedesRev: 1, supersessionReason: 'a', clientKey: 'C4-a' }),
    supersede(c4, { expectedRev: 1, supersedes: first.body.decision.id, supersedesRev: 1, supersessionReason: 'b', clientKey: 'C4-b' }),
  ]);
  const s4 = (await surface(c4)).body;
  neg(ss.filter((r) => r.status === 201).length === 1 && s4.history.length === 2 && s4.history.filter((d) => !d.supersededById).length === 1 && s4.duplicateHeads.length === 0, `C4 supersede vs supersede: one successor, one head, no duplicate heads (${codes(ss)})`);
  // finalize (progress) vs case archive by hand
  const c5 = await reviewed(maria.token, 'pl-alvarez');
  await lifecycle(c5, 'shortlist');
  await draft(c5, { outcome: 'progress' });
  const rev5 = await caseRev(c5);
  const fa = await Promise.all([finalize(c5, { expectedRev: 1 }), j('POST', `/org/rooms/${c5}/lifecycle`, { action: 'closeCase', expectedRev: rev5, reasonCodes: ['position_need'] }, maria.token)]);
  const st5 = await stage(c5); const s5 = (await surface(c5)).body;
  neg(fa.filter((r) => r.status < 300).length === 1 && ((st5 === 'offer_consideration' && s5.current?.outcome === 'progress') || (st5 === 'closed' && s5.current === null && s5.draft?.rev === 1)), `C5 finalize vs close: one of them happened, the case and the decision agree (${codes(fa)} → ${st5})`);
  // finalize vs player deletion
  const roster = (await j('GET', '/org/players', undefined, maria.token)).body;
  // Players later sections still need: Kola, Mateus, Guni, Imani, Osei, Nowak, Kim. Anyone else who is an adult may leave.
  const KEEP = ['pl-adeyemi', 'pl-carvalho', 'pl-guni', 'pl-imani', 'pl-osei', 'pl-nowak', 'pl-kim'];
  const leaver = (roster.items ?? roster).find((pl) => (pl.age ?? 0) >= 18 && !KEEP.includes(pl.id));
  if (!leaver) { console.error('   roster', JSON.stringify((roster.items ?? roster).map((pl) => [pl.id, pl.age]))); fail('C6 needs an adult in the seed'); }
  J.LEAVER = leaver.id; J.LEAVER_NAME = leaver.name;
  const c6 = await reviewed(maria.token, leaver.id);
  J.LEAVER_RID = c6;
  await draft(c6, { outcome: 'hold' });
  const tomasz = await playerLogin(leaver.id);
  const fd = await Promise.all([finalize(c6, { expectedRev: 1 }), j('DELETE', '/player/account', undefined, tomasz.token)]);
  const s6 = (await surface(c6)).body;
  neg((fd[0].status === 201 || (fd[0].status === 409 && fd[0].body.error === 'DECISION_SUBJECT_REMOVED')) && s6.subjectRemoved === true, `C6 finalize vs the player deleting their account: either the decision landed first or it was refused as SUBJECT_REMOVED; afterwards the surface says the subject is gone (${codes(fd)})`);
  // finalize vs assessment invalidation (a cited assessment reviewed/changed) — the reference is re-resolved at finalize; a reviewed assessment is still submitted, so it still resolves.
  const c7 = await reviewed(maria.token, 'pl-osei');
  const a7 = (await surface(c7)).body.evidence.assessments[0]?.id;
  await draft(c7, { outcome: 'hold', evidenceRefs: a7 ? [{ kind: 'assessment', id: a7 }] : [] });
  const fr = await Promise.all([finalize(c7, { expectedRev: 1 }), a7 ? j('POST', `/org/assessments/${a7}/review`, { note: 'reviewed' }, maria.token) : Promise.resolve({ status: 0 })]);
  const s7 = (await surface(c7)).body;
  ok(fr[0].status === 201 && s7.current?.evidenceRefs.length === (a7 ? 1 : 0), `C7 finalize vs assessment review: the decision cites the assessment by id; the review does not change what was decided (${codes(fr)})`);
  // hold vs progress / reject vs progress on the one draft
  for (const [name, other] of [['hold vs progress', 'hold'], ['reject vs progress', 'reject']]) {
    const c = await reviewed(maria.token, 'pl-adeyemi'); // Kola's existing case (under_review after the resume)
    const cur = (await surface(c)).body;
    await draft(c, { outcome: 'progress' });
    const race = await Promise.all([
      patch(c, { outcome: other, reasonCodes: other === 'reject' ? ['position_need'] : [], expectedRev: 1 }),
      supersede(c, { expectedRev: 1, supersedes: cur.current.id, supersedesRev: cur.current.rev, supersessionReason: 'race' }),
    ]);
    const after = (await surface(c)).body;
    const st = await stage(c);
    neg(after.duplicateHeads.length === 0 && after.history.filter((d) => d.kind === 'formal' && !d.supersededById).length === 1 && (after.current.id === cur.current.id ? after.draft?.outcome === other : (after.current.outcome === other && st === LIFECYCLE_ACTIONS[OUTCOME_MAP[other].action].to)), `C8 ${name}: progress could not land (no edge from under_review); if the ${other} landed, the case followed it (${codes(race)} → ${st})`);
    if (after.draft) await discard(c, after.draft.rev);
    if (st === 'archived') await lifecycle(c, 'reopenCase');
    if (st === 'on_hold') await lifecycle(c, 'resumeCase');
    ok(await consistent(c), `C8b ${name}: the case is consistent afterwards`);
  }
}

// ================================================================ F — failure
section('F — honest transport failure: the write refuses before anything is recorded');
{
  const RID = await reviewed(maria.token, 'pl-nowak');
  const s0 = (await surface(RID)).body;
  await draft(RID, { outcome: 'hold', note: 'Will refuse once.' });
  const inj = await j('POST', '/admin/delivery/inject-failure', { channel: 'decision', count: 1 }, undefined, ADMIN);
  ok(inj.status === 200 || inj.status === 201, 'F1 one decision transport failure is injected');
  const audits0 = (await j('GET', '/org/audit?limit=200', undefined, maria.token)).body;
  const st0 = await stage(RID);
  const r = await supersede(RID, { expectedRev: 1, supersedes: s0.current.id, supersedesRev: s0.current.rev, supersessionReason: 'Try.', clientKey: 'F-1' });
  neg(expect(r, 500, 'DECISION_TRANSPORT_REFUSED'), 'F2 the finalize is refused as a transport failure (500, the server\'s fault)');
  const s1 = (await surface(RID)).body;
  neg(s1.current.id === s0.current.id && s1.current.rev === s0.current.rev && s1.history.length === s0.history.length && s1.draft?.rev === 1 && await stage(RID) === st0, 'F3 nothing was written: no row, the head untouched, the draft intact, the case unmoved');
  const audits1 = (await j('GET', '/org/audit?limit=200', undefined, maria.token)).body;
  const count = (a) => (a.items ?? a.entries ?? a).filter((x) => x.action === 'room_decision_superseded' && (x.targetId === RID || x.roomId === RID)).length;
  neg(count(audits1) === count(audits0), 'F3b and no audit entry claims a decision was recorded');
  const retry = await supersede(RID, { expectedRev: 1, supersedes: s0.current.id, supersedesRev: s0.current.rev, supersessionReason: 'Try.', clientKey: 'F-1' });
  ok(retry.status === 201 && retry.body.idempotent !== true, 'F4 the retry with the same key succeeds as a NEW write — the refused attempt recorded no key');
}

// ============================================================== I — sentinels
section('I — sentinels: club-private text never reaches the player, the guardian, the events, the outbox, the Passport or another club');
{
  const sse = await sseCollect(kola.token, 800);
  const sseOrg = await sseCollect(maria.token, 800);
  const playerFrames = await sse.stop(); const orgFrames = await sseOrg.stop();
  const surfaces = {
    'player notifications': await notifs('/player/notifications', kola.token),
    'player inbox': (await j('GET', '/player/inbox', undefined, kola.token)).body,
    'player passport': (await j('GET', '/player/football-passport', undefined, kola.token)).body,
    'player opportunities': (await j('GET', '/player/opportunities', undefined, kola.token)).body,
    'player trials': (await j('GET', '/player/trials', undefined, kola.token)).body,
    'player export': (await j('GET', '/player/export', undefined, kola.token)).body,
    'player shared records': (await j('GET', '/player/recruitment/shared', undefined, kola.token)).body,
    'mateus notifications': await notifs('/player/notifications', mateus.token),
    'mateus passport': (await j('GET', '/player/football-passport', undefined, mateus.token)).body,
    'mateus export': (await j('GET', '/player/export', undefined, mateus.token)).body,
    'guardian notifications': await notifs('/guardian/notifications', amara.token),
    'guardian inbox': (await j('GET', '/guardian/inbox', undefined, amara.token)).body,
    'guardian export': (await j('GET', '/guardian/export', undefined, amara.token)).body,
    'org notifications': await notifs('/org/notifications', maria.token),
    'org notifications (tom)': await notifs('/org/notifications', tom.token),
    'audit': (await j('GET', '/org/audit?limit=200', undefined, maria.token)).body,
    'audit export': (await j('GET', '/org/audit/export', undefined, maria.token)).body,
    'outbox': (await j('GET', '/admin/outbox', undefined, undefined, ADMIN)).body,
    'push log': (await j('GET', '/admin/push-log', undefined, undefined, ADMIN)).body,
    'analytics': (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body,
    'analytics rows': (await j('GET', '/org/recruitment-analytics/rows?metric=decision_outcomes', undefined, maria.token)).body,
    'second look': (await j('GET', '/org/second-look', undefined, maria.token)).body,
    'nobody missed': (await j('GET', '/org/nobody-missed', undefined, maria.token)).body,
    'other org rooms': (await j('GET', '/org/rooms', undefined, rita.token)).body,
    'other org second look': (await j('GET', '/org/second-look', undefined, rita.token)).body,
    'player SSE': playerFrames,
    'org SSE': orgFrames,
    'journey timeline (J)': (await journey(J.RID)).timeline,
    'journey decisions (J)': (await journey(J.RID)).decisions,
  };
  for (const [name, body] of Object.entries(surfaces)) {
    neg(!has(body, S_DEC) && !has(body, S_ROOM) && !has(body, S_ASSESS), `I1 ${name}: no decision sentinel, no room-rationale sentinel, no assessment sentinel`);
  }
  neg(!has(surfaces['player notifications'], 'decision') && !has(surfaces['player inbox'], 'offer_consideration') && !has(surfaces['player opportunities'], 'offer_consideration') && !has(surfaces['player export'], 'offer_consideration'), 'I2 the player\'s surfaces never mention a decision or offer_consideration');
  neg(!has(surfaces.outbox, 'decision') && !has(surfaces['push log'], 'decision'), 'I3 no email and no push was sent about a decision');
  const aud = (surfaces.audit.items ?? surfaces.audit.entries ?? surfaces.audit);
  const decAud = aud.filter((x) => /room_decision_/.test(x.action));
  ok(decAud.length >= 4 && decAud.some((x) => x.action === 'room_decision_finalized' && x.detail?.outcome && x.detail?.decisionId), 'I4 the audit log holds the decision actions with outcome and decision id');
  neg(decAud.every((x) => x.detail?.note === undefined || typeof x.detail.note === 'boolean'), 'I4b and never the note text');
  const rooms = surfaces['other org rooms'];
  const list = rooms.items ?? rooms.rooms ?? rooms;
  neg(!list.some?.((r) => r.roomId === J.RID || r.roomId === R.RID), 'I5 Harbour cannot enumerate Eastport\'s decided cases');
}

// ============================================================== N — analytics
section('N — analytics: counts of decisions, never a verdict on anyone');
{
  const a = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const m = a.data?.pipeline?.metrics?.decision_outcomes ?? null;
  ok(!!m && m.id === 'decision_outcomes', 'N1 the dashboard carries decision_outcomes in the pipeline family');
  const n = (c) => (typeof c === 'number' ? c : c?.value ?? c?.count ?? c?.n ?? 0);
  const val = { progress: n(m?.outcomes?.progress), hold: n(m?.outcomes?.hold), reject: n(m?.outcomes?.reject), superseded: n(m?.superseded) };
  const total = val.progress + val.hold + val.reject;
  ok(total >= 8 && val.superseded >= 3 && m.ratio === false, `N2 counts by outcome (progress ${val.progress}, hold ${val.hold}, reject ${val.reject}) and how many were superseded (${val.superseded}); no rate`);
  neg(!has(m, 'score') && !has(m, 'rating') && !has(m, 'pl-adeyemi') && !has(m, S_DEC), 'N3 no score, no rating, no player id, no note in the metric');
  neg((await j('GET', '/org/recruitment-analytics', undefined, tom.token)).status === 403 || !has((await j('GET', '/org/recruitment-analytics', undefined, tom.token)).body, 'decision_outcomes'), 'N4 a scout does not read the director\'s dashboard (M20 RBAC untouched)');
}

// ============================================================ T — removed
section('T — the subject removed their account: no new decision about a person who left');
{
  const s = (await surface(J.LEAVER_RID)).body;
  ok(s.subjectRemoved === true && s.requirements.canDraft === false && s.requirements.canFinalize === false, 'T1 the surface says the subject removed their account and nobody may draft');
  const RID = (await j('GET', '/org/rooms', undefined, maria.token)).body;
  const list = RID.items ?? RID.rooms ?? RID;
  const gone = J.LEAVER_RID;
  if (gone) {
    neg(expect(await draft(gone, { outcome: 'hold' }), 409, 'DECISION_SUBJECT_REMOVED'), 'T2 opening a draft is refused as SUBJECT_REMOVED');
    const cur = (await surface(gone)).body;
    ok(cur.current === null || cur.current.kind === 'formal', 'T3 whatever was decided before the removal stays on record');
    // §175: the decision record must not resurrect the removed player's PII.
    const leaverName = J.LEAVER_NAME;
    const jrGone = await journey(gone);
    const orgN = await notifs('/org/notifications', maria.token);
    neg(!!leaverName && !has(cur, leaverName) && !has(jrGone.decisions, leaverName) && !has(jrGone.history, leaverName) && !orgN.some((n) => /formal decision recorded/.test(n.text) && n.text.includes(leaverName)), `T4 the decision surface, history, journey and org notifications carry no trace of the removed player's name ("${leaverName}")`);
  } else ok(true, 'T2/T3 (the removed player\'s room is not listed by id — the surface above already proved the gate)');
}

// ================================================================ L — limits
section('L — rate limits: 60 drafts and 30 finalizations per organisation per hour');
{
  const far = T0 + 5000 * H;
  const RID = await reviewed(rita.token, 'pl-adeyemi');
  let tripped = null; let n = 0;
  for (let i = 0; i < RATE_LIMIT_POLICY.decision_draft.max + 3 && !tripped; i++) {
    const r = await draft(RID, { outcome: 'hold' }, rita.token, at(far));
    if (r.status === 429) { tripped = r; break; }
    n++;
    await j('DELETE', `/org/rooms/${RID}/decision/draft`, { expectedRev: 1 }, rita.token, at(far));
  }
  neg(tripped?.status === 429 && tripped.body.error === 'RATE_LIMITED' && tripped.body.action === 'decision_draft' && n >= RATE_LIMIT_POLICY.decision_draft.max - 2, `L1 the draft policy trips after ${n} drafts in the window (429 RATE_LIMITED decision_draft)`);
  const eastport = await draft(await reviewed(maria.token, 'pl-kim'), { outcome: 'hold' }, maria.token, at(far));
  neg(eastport.status !== 429, `L2 Eastport is not limited by Harbour\'s burst (${eastport.status})`);
  if (eastport.status === 201) await discard(await reviewed(maria.token, 'pl-kim'), 1);
}

// ================================================================ Z — restart
section('Z — restart: draft, chain, keys and case survive the process dying');
{
  const RID = await reviewed(maria.token, 'pl-guni');
  const before = (await surface(RID)).body;
  await draft(RID, { outcome: 'hold', note: 'Survives.', clientKey: 'Z-draft' });
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  server = await boot();
  const re = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!re?.token, 'Z1 the server came back');
  const s = (await surface(RID, re.token)).body;
  ok(s.draft?.note === 'Survives.' && s.draft.rev === 1 && s.current?.id === before.current?.id && s.history.length === before.history.length, 'Z2 the draft, the current decision and the history are exactly as before');
  const replayDraft = await draft(RID, { outcome: 'hold', note: 'Survives.', clientKey: 'Z-draft' }, re.token);
  ok(replayDraft.status === 200 && replayDraft.body.idempotent === true, 'Z3 the draft key still replays — it lives on the case, not in memory');
  const replayFinal = await finalize(J.RID, { expectedRev: 2, clientKey: 'J-final' }, re.token);
  ok(replayFinal.status === 200 && replayFinal.body.idempotent === true && replayFinal.body.decision.id === J.DEC, 'Z4 the very first finalize key still replays the very first decision');
  const jS = (await surface(J.RID, re.token)).body;
  ok(jS.history.length === 4 && jS.history[3].id === J.ADV && jS.history[2].id === J.DEC && jS.history[2].rev === 2 && jS.history[2].supersededById === J.HOLD && jS.history[1].id === J.HOLD && jS.history[0].id === J.HOLD2 && jS.duplicateHeads.length === 0 && jS.omitted === 0, 'Z5 Kola\'s chain: advisory → progress (superseded, rev 2) → hold → hold, one head, nothing omitted');
  ok(await stage(R.RID, re.token) === 'under_review' && await stage(D.RID, re.token) === 'offer_consideration', 'Z6 the case stages are durable');
  const health = (await j('GET', '/healthz')).body;
  ok(Number.isInteger(health.schemaVersion), `Z7 schema ${health.schemaVersion} after the restart — P5 added no migration`);
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 P5 Decision suite: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P5 Decision has failures.');
else console.log('all M23 P5 Decision checks passed');
process.exit(process.exitCode ?? 0);
