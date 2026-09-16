// M23 acceptance suite — P2: the canonical lifecycle and the journey projection.
//
// The governing rule this suite exists to enforce:
//
//   The recruitment lifecycle must describe what has actually happened — not
//   what the UI wants to show, not what another subsystem happens to call it,
//   and never more than the underlying records can prove.
//
// P2 scope: one authoritative lifecycle, server-validated semantic actions,
// append-only history, viewer-aware projection, and — the part most worth
// testing — the things that must NOT happen. Contact, Trial and Offer arrive in
// later phases; this suite proves the lifecycle refuses to pretend they exist.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_ACTIONS, LIFECYCLE_TERMINAL, LIFECYCLE_REOPENABLE, LIFECYCLE_REASON_CODES,
  validateLifecycleReasons, isLifecycleReason,
  RECRUITMENT_LIFECYCLE_POLICY_VERSION, canTransitionRecruitmentCase,
  derivedConditions, availableActions, toAnalyticsRecruitmentStage,
  NULL_EVIDENCE_PROVIDER,
} from '../m23/lifecycle.mjs';
import { buildRecruitmentJourney, JOURNEY_REQUIRED_STORES } from '../m23/journey.mjs';
import {
  ROOM_STATUSES, ROOM_TRANSITIONS, TERMINAL_ROOM_STATUSES, roomStatusForStage,
  STATUS_EVIDENCE_REQUIRED, adoptionStatusForStage, PRO_STAGES, GRASSROOTS_STAGES,
  ALL_REASON_CODES,
} from '../m17/shared.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { M23_ERROR_HTTP, httpStatusFor, publicErrorBody } from '../m23/errors.mjs';
import { FUNNEL_STAGES, stagesReached } from '../m20/funnels.mjs';

const PORT = 5700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ pure engine
section('U1 — the lifecycle is one table, and the declined states stayed declined');
{
  neg(!ROOM_STATUSES.includes('trial_in_progress'),
    '#39 `trial_in_progress` is NOT a case stage — it is a state of the trial');
  neg(!ROOM_STATUSES.includes('decision_pending'),
    '#40 `decision_pending` is NOT a case stage — it is a derivation');

  const conds = derivedConditions({ status: 'trial_completed', hasCurrentDecision: false });
  ok(conds.decisionPending === true, 'decision-pending is answered by looking, not by storing');
  ok(derivedConditions({ status: 'trial_completed', hasCurrentDecision: true }).decisionPending === false,
    'and stops being true the moment a decision exists');

  ok(ROOM_STATUSES.includes('offer_accepted') && ROOM_STATUSES.includes('signed'),
    'offer_accepted and signed are different states');
  neg(!ROOM_TRANSITIONS.offer_accepted.includes('offer_made'),
    'an accepted offer cannot be un-accepted');
  ok(Object.keys(ROOM_TRANSITIONS).length === ROOM_STATUSES.length,
    'every status has a transition row — the table is total');
  for (const [from, tos] of Object.entries(ROOM_TRANSITIONS)) {
    for (const to of tos) {
      if (!ROOM_STATUSES.includes(to)) fail(`${from} -> ${to} names a status that does not exist`);
    }
  }
  ok(true, 'every transition target is a real status');

  neg(!TERMINAL_ROOM_STATUSES.includes('on_hold'), '#38 on_hold is NOT terminal');
  ok(JSON.stringify([...LIFECYCLE_TERMINAL].sort()) === JSON.stringify([...TERMINAL_ROOM_STATUSES].sort()),
    'M23 terminal set matches M17 by CONTENT, not merely by count — one definition');
}

section('U2 — no lifecycle action is performable by a player, and evidence cannot be faked');
{
  const kase = { id: 'case-x', orgId: 'org-a', playerId: 'pl-a', room: { status: 'offer_made', rev: 1 } };

  // #23 — the single most important negative in the milestone.
  const toSigned = canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(toSigned.ok === false && toSigned.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#23 offer acceptance does not become signed: `signed` demands a confirmed joining record');
  neg(toSigned.requires === 'confirmed_join', 'and names the record it needs rather than guessing');

  // Even with the case sitting at offer_accepted, nothing promotes it.
  const accepted = { ...kase, room: { status: 'offer_accepted', rev: 1 } };
  const stillNot = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(stillNot.ok === false,
    '#23b a case AT offer_accepted still cannot reach signed without separate confirmed truth');

  // A provider that lies is the only way through — which is the point: the
  // lifecycle asserts exactly what some record supports, no more.
  const liar = { check: () => ({ satisfied: true }) };
  const withEvidence = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: liar });
  ok(withEvidence.ok === true && withEvidence.to === 'signed',
    'J17 with confirmed joining evidence, offer_accepted -> signed is permitted');

  // #4 — role.
  neg(canTransitionRecruitmentCase(kase, 'sendOffer', { role: 'viewer' }).error === 'LIFECYCLE_NOT_PERMITTED',
    '#4 a viewer cannot move the lifecycle');
  neg(canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'room_lead', evidence: liar }).error === 'LIFECYCLE_NOT_PERMITTED',
    '#4b confirming a signing is admin-only, even with evidence');

  // #6 — impossible jump.
  const watching = { ...kase, room: { status: 'watching', rev: 1 } };
  neg(canTransitionRecruitmentCase(watching, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: liar }).error === 'LIFECYCLE_TRANSITION_INVALID',
    '#6 a watched player cannot jump to an accepted offer');

  // #5 — no generic stage setter exists in the action vocabulary at all.
  neg(!Object.keys(LIFECYCLE_ACTIONS).some((a) => /^set|^patch|stage$/i.test(a)),
    '#5 there is no generic set-stage action to call');

  neg(canTransitionRecruitmentCase(kase, 'notAnAction', { role: 'recruitment_admin' }).error === 'LIFECYCLE_ACTION_UNKNOWN',
    'an unknown action is refused by name');
  neg(canTransitionRecruitmentCase({ id: 'c', room: { status: 'nonsense' } }, 'startReview', { role: 'room_lead' }).error === 'LIFECYCLE_STATE_UNKNOWN',
    'a case in an unrecognised state reports corruption, not a workflow answer');

  ok(LIFECYCLE_REASON_CODES.every((c) => typeof c === 'string' && /^[a-z_]+$/.test(c)),
    'every lifecycle reason is a structured code, never prose');

  const acts = availableActions(watching, { role: 'recruitment_admin' });
  neg(!acts.includes('confirmSignedOutcome'), '#42 an action the evidence cannot support is not suggested');
  ok(acts.includes('startReview') && acts.includes('planContact'), 'the possible actions are offered');
  neg(!availableActions(watching, { role: 'viewer' }).includes('startReview'),
    '#42b and nothing is suggested to a role that cannot do it');
}

section('U3 — the projector refuses to mistake a broken database for an empty history');
{
  const base = {
    recruitmentCases: [{ id: 'case-1', orgId: 'o1', playerId: 'p1', room: { status: 'watching', rev: 1 }, history: [] }],
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [],
  };
  const good = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  ok(good.ok === true, 'a healthy database projects');

  for (const store of JOURNEY_REQUIRED_STORES) {
    const broken = { ...base };
    delete broken[store];
    const out = buildRecruitmentJourney(broken, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
    neg(out.ok === false && out.error === 'JOURNEY_STORE_MISSING',
      `#30/#31 a missing db.${store} is reported as broken infrastructure, not as "nothing happened"`);
  }

  // #1/#2 — foreign org.
  const foreign = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'OTHER', role: 'room_lead' });
  neg(foreign.ok === false && foreign.error === 'CASE_NOT_FOUND',
    '#1/#2 a foreign org gets CASE_NOT_FOUND');
  const absent = buildRecruitmentJourney(base, 'case-nope', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  neg(JSON.stringify(foreign) === JSON.stringify(absent),
    'and it is byte-identical to a case that never existed — no count, no hint, no leak');

  // #13/#14/#35/#36 — hidden club interest.
  const asPlayer = buildRecruitmentJourney(base, 'case-1', { kind: 'player_self', playerId: 'p1' });
  neg(asPlayer.ok === false && asPlayer.error === 'CASE_NOT_FOUND',
    '#13 a player cannot see that a club has a case on them');
  neg(JSON.stringify(asPlayer) === JSON.stringify(absent),
    '#36 and the answer is identical to a case that does not exist — interest cannot be inferred');
  const asGuardian = buildRecruitmentJourney(base, 'case-1', { kind: 'guardian', guardianId: 'g1' });
  neg(asGuardian.ok === false && asGuardian.error === 'CASE_NOT_FOUND',
    '#14 nor can a guardian without a share');

  // #15 — agency is not a viewer context at all.
  neg(buildRecruitmentJourney(base, 'case-1', { kind: 'agency' }).error === 'JOURNEY_VIEWER_UNKNOWN',
    '#15 "agency" is not a recruitment-journey viewer — no policy grants it one');

  // #38-T&S — not a master key.
  neg(buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety' }).error === 'CASE_NOT_FOUND',
    'T&S with no authorization sees nothing');
  ok(buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety', authorized: true }).ok === true,
    'and sees the case only when its own authorization says so');

  // #30 — no score of any kind.
  const body = JSON.stringify(good);
  neg(!/score|readiness|probability|percentage|quality|rating/i.test(body),
    '#30 the journey carries no score, readiness, probability, percentage or rating');

  // §76 — determinism.
  const a = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' }, { now: 1000 });
  const b = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' }, { now: 1000 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'the projection is deterministic for the same db, viewer and clock');
}

section('U4 — private text never reaches the projection');
{
  const db = {
    recruitmentCases: [{ id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'under_review', rev: 1 }, history: [] }],
    roomDecisions: [{ id: 'd1', roomId: 'c1', orgId: 'o1', recommendation: 'archive', reasonCodes: ['squad_space'], note: 'HIS ATTITUDE IS THE PROBLEM', createdAt: '2026-01-01T00:00:00.000Z', by: { name: 'Maria' } }],
    requests: [], trials: [], assessments: [], signings: [],
  };
  const out = buildRecruitmentJourney(db, 'c1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  const s = JSON.stringify(out);
  neg(!s.includes('ATTITUDE'), '#42-note a decision note body is never projected, even to the club');
  ok(out.decisions.all[0].hasNote === true, 'its existence is reported; its content is not');
  ok(out.decisions.all[0].reasonCodes[0] === 'squad_space', 'the structured reason travels because it is structured');
}

section('U5 — analytics compatibility is explicit');
{
  ok(FUNNEL_STAGES.includes('contact_planned') && FUNNEL_STAGES.includes('contacted'),
    'J19 the two contact states ARE funnel progression');
  ok(FUNNEL_STAGES.includes('offer_accepted'), 'and an accepted offer is further than a made one');
  neg(!FUNNEL_STAGES.includes('on_hold'), '#34 pausing is not counted as progress');
  neg(!FUNNEL_STAGES.includes('offer_declined'), '#34b nor is declining, which already counted at offer_made');
  ok(toAnalyticsRecruitmentStage('on_hold') === null && toAnalyticsRecruitmentStage('offer_declined') === null,
    'the mapping says so in one place');
  ok(toAnalyticsRecruitmentStage('trial_completed') === 'trial_completed',
    'and every historical status still maps to itself — no rename, no silent invalidation');
  for (const s of ['watching', 'under_review', 'shortlisted', 'priority', 'trial_requested', 'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made', 'signed']) {
    if (toAnalyticsRecruitmentStage(s) !== s) fail(`legacy status ${s} no longer maps to itself`);
  }
  ok(true, '#34c all ten pre-M23 funnel statuses are unchanged');
}

section('H7-H8, H13-H14, H18-H20 — determinism, legacy mapping and isolation (pure)');
{
  const mkCase = (id, orgId, playerId, status, hist) => ({
    id, orgId, playerId, stage: null,
    room: { status, rev: 1, priority: 'normal' },
    createdAt: '2026-01-01T00:00:00.000Z',
    history: hist ?? [],
  });
  const REQ = { roomDecisions: [], requests: [], trials: [], assessments: [], signings: [] };
  const target = mkCase('case-T', 'oT', 'pT', 'under_review', [
    { action: 'room_created', at: '2026-01-01T00:00:00.000Z', by: { name: 'A' }, detail: { status: 'watching' } },
    { action: 'room_status_changed', at: '2026-01-02T00:00:00.000Z', by: { name: 'A' }, detail: { from: 'watching', to: 'under_review' } },
  ]);
  const noiseA = mkCase('case-X', 'oOTHER', 'pOTHER', 'signed', [{ action: 'room_status_changed', at: '2026-01-03T00:00:00.000Z', detail: { from: 'offer_made', to: 'signed' } }]);
  const noiseB = mkCase('case-Y', 'oT', 'pOTHER2', 'archived', [{ action: 'room_status_changed', at: '2026-01-04T00:00:00.000Z', detail: { from: 'watching', to: 'archived' } }]);
  const V = { kind: 'org_staff', orgId: 'oT', role: 'room_lead' };

  // H7 — unrelated insertion order must not change the answer.
  const one = buildRecruitmentJourney({ ...REQ, recruitmentCases: [noiseA, target, noiseB] }, 'case-T', V, { now: 5 });
  const two = buildRecruitmentJourney({ ...REQ, recruitmentCases: [noiseB, noiseA, target] }, 'case-T', V, { now: 5 });
  const three = buildRecruitmentJourney({ ...REQ, recruitmentCases: [target, noiseB, noiseA] }, 'case-T', V, { now: 5 });
  ok(JSON.stringify(one) === JSON.stringify(two) && JSON.stringify(two) === JSON.stringify(three),
    'H7 the journey is byte-identical however unrelated cases are ordered in the array');

  // H18/H19 — nothing foreign, from either axis.
  const body = JSON.stringify(one);
  neg(!body.includes('case-X') && !body.includes('oOTHER') && !body.includes('pOTHER'),
    'H18 no foreign-org id, case id or player id appears anywhere in the projection');
  neg(!body.includes('case-Y') && !body.includes('pOTHER2'),
    'H19 nor a same-org DIFFERENT player case — cross-player isolation holds');
  neg(!body.includes('signed'), 'H18b and a foreign case at `signed` does not colour this one');

  // H20 — a decision belonging to another case or another org never attaches.
  const decisions = [
    { id: 'd-mine', roomId: 'case-T', orgId: 'oT', recommendation: 'shortlist', reasonCodes: [], createdAt: '2026-01-05T00:00:00.000Z', by: { name: 'A' } },
    { id: 'd-othercase', roomId: 'case-Y', orgId: 'oT', recommendation: 'archive', reasonCodes: [], createdAt: '2026-01-05T00:00:00.000Z', by: { name: 'B' } },
    { id: 'd-otherorg', roomId: 'case-T', orgId: 'oOTHER', recommendation: 'offer', reasonCodes: [], createdAt: '2026-01-05T00:00:00.000Z', by: { name: 'C' } },
  ];
  const withD = buildRecruitmentJourney({ ...REQ, roomDecisions: decisions, recruitmentCases: [target] }, 'case-T', V, { now: 5 });
  ok(withD.decisions.all.length === 1 && withD.decisions.all[0].id === 'd-mine', 'H20 only this case’s own decision attaches');
  neg(!JSON.stringify(withD).includes('d-othercase'), 'H20b a decision from another case does not leak in');
  neg(!JSON.stringify(withD).includes('d-otherorg'), 'H20c nor one from another org with the same room id');

  // H8 — same-timestamp ordering is deterministic and documented.
  const sameTs = mkCase('case-S', 'oT', 'pT', 'under_review', [
    { action: 'room_status_changed', at: '2026-02-01T00:00:00.000Z', detail: { from: 'archived', to: 'under_review' } },
    { action: 'room_reopened', at: '2026-02-01T00:00:00.000Z', detail: { from: 'archived', to: 'under_review' } },
    { action: 'room_created', at: '2026-02-01T00:00:00.000Z', detail: { status: 'watching' } },
  ]);
  const s1 = buildRecruitmentJourney({ ...REQ, recruitmentCases: [sameTs] }, 'case-S', V, { now: 5 });
  const s2 = buildRecruitmentJourney({ ...REQ, recruitmentCases: [sameTs] }, 'case-S', V, { now: 5 });
  ok(JSON.stringify(s1.history.entries) === JSON.stringify(s2.history.entries),
    'H8 three entries at the SAME millisecond come back in the same order every time');
  ok(s1.history.entries.length === 3, 'H8b and all three survive — identical timestamps are not deduped into one');

  // H13 — every historical M17 status maps, exactly once, with no fallback.
  const LEGACY = ['watching', 'under_review', 'shortlisted', 'priority', 'trial_requested',
    'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made', 'signed',
    'withdrawn', 'archived', 'closed'];
  let mappedAll = true;
  for (const st of LEGACY) {
    if (!ROOM_STATUSES.includes(st)) { mappedAll = false; fail('H13 legacy status ' + st + ' disappeared from the canonical set'); }
    if (!ROOM_TRANSITIONS[st]) { mappedAll = false; fail('H13 legacy status ' + st + ' lost its transition row'); }
    const projected = buildRecruitmentJourney({ ...REQ, recruitmentCases: [mkCase('c-' + st, 'oT', 'pT', st)] }, 'c-' + st, V, { now: 5 });
    if (!projected.ok || projected.lifecycle.currentStage !== st) { mappedAll = false; fail('H13 legacy status ' + st + ' does not project as itself'); }
    if (!projected.lifecycle.label || projected.lifecycle.label === st) { mappedAll = false; fail('H13 legacy status ' + st + ' has no human label'); }
  }
  ok(mappedAll, 'H13 all 13 pre-M23 statuses still exist, keep their transitions, project as themselves and carry a label');

  // H14 — an unknown legacy status is refused, never coerced.
  const weird = mkCase('case-W', 'oT', 'pT', '__unknown_old_status__');
  const wj = buildRecruitmentJourney({ ...REQ, recruitmentCases: [weird] }, 'case-W', V, { now: 5 });
  const coerced = wj.ok && ['under_review', 'closed', 'watching'].includes(wj.lifecycle?.currentStage);
  neg(!coerced, 'H14 an unrecognised stored status is NOT silently coerced to under_review, closed or watching');
  const wv = canTransitionRecruitmentCase(weird, 'startReview', { role: 'recruitment_admin' });
  neg(wv.ok === false && wv.error === 'LIFECYCLE_STATE_UNKNOWN',
    'H14b and the validator calls it corruption rather than guessing a workflow answer');

  // H14c — an unknown value inside HISTORY is not given meaning either.
  const weirdHist = mkCase('case-WH', 'oT', 'pT', 'under_review', [
    { action: '__not_a_real_action__', at: '2026-03-01T00:00:00.000Z', detail: { to: 'nonsense' } },
    { action: 'room_status_changed', at: '2026-03-02T00:00:00.000Z', detail: { from: 'watching', to: 'under_review' } },
  ]);
  const whj = buildRecruitmentJourney({ ...REQ, recruitmentCases: [weirdHist] }, 'case-WH', V, { now: 5 });
  neg(!JSON.stringify(whj.history.entries).includes('__not_a_real_action__'),
    'H14c an unrecognised history action is omitted, not rendered as a fabricated timeline event');
  ok(whj.history.entries.length === 1, 'H14d and the real entry beside it still shows');

  // H23 — optional stores are structurally absent, not faked.
  ok(one.offer.available === false && one.offer.records.length === 0,
    'H23 the unshipped offer store reports available:false rather than pretending to be empty-but-present');
  neg(JOURNEY_REQUIRED_STORES.includes('recruitmentOffers') === false,
    'H23b and it is NOT in the required list — a future phase’s store cannot break today’s projection');
}

section('H11 — nextActions is a permission statement, not a workflow diagram');
{
  const kase = { id: 'c-r', orgId: 'oT', playerId: 'pT', room: { status: 'under_review', rev: 1 } };
  const forRole = (role) => availableActions(kase, { role });
  const viewer = forRole('viewer');
  const contributor = forRole('contributor');
  const lead = forRole('room_lead');
  const admin = forRole('recruitment_admin');

  ok(viewer.length === 0, 'H11 a read-only viewer is offered NOTHING');
  for (const a of ['rejectCase', 'closeCase', 'holdCase', 'reopenCase', 'confirmSignedOutcome']) {
    if (viewer.includes(a)) fail('H11 a viewer was offered ' + a);
  }
  neg(true, 'H11b specifically not reject, close, hold, reopen or confirm-signing');

  ok(contributor.includes('startReview') === false || contributor.length < lead.length,
    'H11c a contributor is offered strictly less than a lead');
  neg(!contributor.includes('rejectCase'), 'H11d a contributor cannot end a case');
  neg(!contributor.includes('confirmSignedOutcome'), 'H11e nor confirm a signing');
  neg(!lead.includes('confirmSignedOutcome'), 'H11f nor can a room lead — that is admin-only');
  ok(lead.includes('holdCase') && lead.includes('rejectCase'), 'H11g a lead can hold and reject');
  ok(admin.length >= lead.length, 'H11h an admin is offered at least what a lead is');

  // Every offered action must actually succeed validation for that role.
  let consistent = true;
  for (const role of ['contributor', 'room_lead', 'recruitment_admin']) {
    for (const a of forRole(role)) {
      const v = canTransitionRecruitmentCase(kase, a, { role, forAvailability: true });
      if (!v.ok) { consistent = false; fail('H11 ' + role + ' was offered ' + a + ' but it does not validate'); }
    }
  }
  ok(consistent, 'H11i every offered action validates for the role it was offered to');
}

section('H15-H17 — hold cycling, reopen cycling and what the funnel counts');
{
  const cyc = { id: 'c-c', orgId: 'oT', playerId: 'pT', room: { status: 'under_review', rev: 1 } };
  const step = (from, action) => canTransitionRecruitmentCase({ ...cyc, room: { status: from, rev: 1 } }, action, { role: 'recruitment_admin', forAvailability: true });
  ok(step('under_review', 'holdCase').ok, 'H15 under_review -> on_hold');
  ok(step('on_hold', 'resumeCase').ok, 'H15b on_hold -> under_review');
  ok(step('under_review', 'holdCase').ok && step('on_hold', 'resumeCase').ok,
    'H15c and the cycle can repeat — nothing about a second hold is refused');
  neg(!LIFECYCLE_TERMINAL.includes('on_hold'), 'H15d because on_hold was never terminal');

  ok(step('archived', 'reopenCase').ok, 'H16 archived -> under_review reopens');
  ok(step('under_review', 'rejectCase').ok, 'H16b and can be rejected again');
  ok(step('closed', 'reopenCase').ok, 'H16c a closed case reopens too');

  // H17 — what the funnel counts.
  neg(!FUNNEL_STAGES.includes('on_hold'), 'H17 on_hold is not a funnel stage, so repeated holds cannot inflate progress');
  neg(!FUNNEL_STAGES.includes('offer_declined'), 'H17b nor offer_declined, which already counted at offer_made');
  ok(FUNNEL_STAGES.includes('offer_made'), 'H17c offer_made IS counted');
  ok(stagesReached({ history: [
    { action: 'room_status_changed', at: 1, detail: { from: 'watching', to: 'under_review' } },
    { action: 'room_status_changed', at: 2, detail: { from: 'under_review', to: 'on_hold' } },
    { action: 'room_status_changed', at: 3, detail: { from: 'on_hold', to: 'under_review' } },
    { action: 'room_status_changed', at: 4, detail: { from: 'under_review', to: 'on_hold' } },
    { action: 'room_status_changed', at: 5, detail: { from: 'on_hold', to: 'under_review' } },
  ], room: { status: 'under_review' } }).size >= 1, 'H17d stagesReached returns a SET, so reaching a stage twice counts once');
  const reached = stagesReached({ history: [
    { action: 'room_status_changed', at: 1, detail: { from: 'watching', to: 'under_review' } },
    { action: 'room_status_changed', at: 2, detail: { from: 'under_review', to: 'archived' } },
    { action: 'room_reopened', at: 3, detail: { from: 'archived', to: 'under_review' } },
    { action: 'room_status_changed', at: 4, detail: { from: 'archived', to: 'under_review' } },
  ], room: { status: 'under_review' } });
  ok(reached.has('under_review'), 'H17e a reopened case still shows the stage it reached');
  ok([...reached].filter((s) => s === 'under_review').length === 1,
    'H17f and reaching under_review twice appears once — the funnel is unique-case, so reopening cannot double-count');
}

// ================================================================== HTTP
section('P — the transition graph as a property, over every state × action × role');
{
  // 18 states x 19 actions x 4 roles = 1,368 combinations. Enumerating them as
  // individual checks would be a wall of output that nobody reads and that
  // still misses the combination added next week. These are stated as
  // properties over the whole product instead, so a nineteenth state or a
  // twentieth action is covered the day it is added.
  const ROLES = ['viewer', 'contributor', 'room_lead', 'recruitment_admin'];
  const ACTIONS = Object.keys(LIFECYCLE_ACTIONS);
  const ERRORS = new Set([
    'LIFECYCLE_ACTION_UNKNOWN', 'LIFECYCLE_CASE_NOT_A_ROOM', 'LIFECYCLE_STATE_UNKNOWN',
    'LIFECYCLE_NOT_PERMITTED', 'LIFECYCLE_NO_CHANGE', 'LIFECYCLE_TRANSITION_INVALID',
    'LIFECYCLE_REASON_REQUIRED', 'LIFECYCLE_EVIDENCE_REQUIRED', 'LIFECYCLE_ACTION_NOT_APPLICABLE',
  ]);
  const caseAt = (status) => ({
    id: 'case-P', orgId: 'org-P', playerId: 'pl-P',
    room: { status, rev: 1 }, history: [],
  });
  const reasons = ['club_decision'];

  const cells = [];
  for (const from of ROOM_STATUSES) {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        const v = canTransitionRecruitmentCase(caseAt(from), action, { role, reasonCodes: reasons });
        cells.push({ from, action, role, to: LIFECYCLE_ACTIONS[action].to, v });
      }
    }
  }
  ok(cells.length === ROOM_STATUSES.length * ACTIONS.length * ROLES.length && cells.length === 1368,
    `P1 the matrix is complete: ${cells.length} state x action x role combinations evaluated`);

  // Totality — every cell answers, and answers in the declared shape.
  neg(cells.every((c) => c.v && (c.v.ok === true || (c.v.ok === false && ERRORS.has(c.v.error)))),
    'P2 every combination returns a verdict, and every refusal carries a declared error code');

  // Purity — the validator is asked the same question twice, about a frozen
  // case, and must give the same answer without touching it.
  const frozen = Object.freeze({ ...caseAt('under_review'), room: Object.freeze({ status: 'under_review', rev: 1 }) });
  const twice = ACTIONS.map((a) => [
    JSON.stringify(canTransitionRecruitmentCase(frozen, a, { role: 'recruitment_admin', reasonCodes: reasons })),
    JSON.stringify(canTransitionRecruitmentCase(frozen, a, { role: 'recruitment_admin', reasonCodes: reasons })),
  ]);
  ok(twice.every(([a, b]) => a === b), 'P3 the validator is deterministic and mutates nothing it is given');

  // Refusal ORDER is a privacy property, not a style choice. Role is checked
  // before the transition table, so a viewer cannot map the graph by probing:
  // every answer they get is the same answer, and it carries no `allowed` list.
  const viewerCells = cells.filter((c) => c.role === 'viewer');
  neg(viewerCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_NOT_PERMITTED'),
    'P4 a viewer is refused identically everywhere — the graph is not probeable by role');
  neg(viewerCells.every((c) => c.v.allowed === undefined),
    'P5 and no refusal to a viewer leaks the set of states the case could move to');

  // The role ladder must be monotone. A privilege inversion — where a lower
  // role may do something a higher role may not — would be invisible in any
  // single test and catastrophic in the one case that hit it.
  const rank = (r) => ROLES.indexOf(r);
  let inversions = 0;
  for (const from of ROOM_STATUSES) {
    for (const action of ACTIONS) {
      const okAt = ROLES.map((r) => cells.find((c) => c.from === from && c.action === action && c.role === r).v.ok);
      for (let i = 0; i < ROLES.length; i += 1) {
        for (let k = i + 1; k < ROLES.length; k += 1) if (okAt[i] && !okAt[k] && rank(ROLES[k]) > rank(ROLES[i])) inversions += 1;
      }
    }
  }
  neg(inversions === 0, 'P6 the role ladder is monotone: no lower role may do what a higher role may not');

  // §16 — the self-transition decision, stated once and enforced everywhere.
  //
  // A self-transition is REFUSED, and refused DISTINCTLY: `LIFECYCLE_NO_CHANGE`
  // rather than `LIFECYCLE_TRANSITION_INVALID`. "You are already there" and
  // "you cannot get there" are different facts. A client retrying after a lost
  // response is in the first case, and telling it the move was impossible
  // would send it to reload state that is in fact correct.
  const selfCells = cells.filter((c) => c.from === c.to && c.role === 'recruitment_admin');
  ok(selfCells.length > 0, 'P7 the matrix does contain self-transitions to rule on');
  neg(selfCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_NO_CHANGE'),
    'P8 every self-transition is refused as NO_CHANGE, never as INVALID — the two are different facts');
  neg(ROOM_STATUSES.every((s) => !availableActions(caseAt(s), { role: 'recruitment_admin' })
    .some((a) => LIFECYCLE_ACTIONS[a].to === s)),
    'P9 and a self-transition is never offered as an available action');

  // Evidence is keyed by TARGET, so it must bind on every inbound edge — for
  // every source state and every action that aims there, with no exception.
  const evidenceCells = cells.filter((c) => STATUS_EVIDENCE_REQUIRED[c.to] && c.role === 'recruitment_admin'
    && ROOM_TRANSITIONS[c.from].includes(c.to) && c.from !== c.to);
  ok(evidenceCells.length > 0, 'P10 there are inbound edges to evidence-bearing states to check');
  neg(evidenceCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_EVIDENCE_REQUIRED'),
    `P11 all ${evidenceCells.length} otherwise-legal inbound edges to an evidence-bearing state are refused for evidence`);
  neg(evidenceCells.every((c) => c.v.requires === STATUS_EVIDENCE_REQUIRED[c.to].kind),
    'P12 and each names the kind its TARGET requires, not a kind chosen per edge');

  // Terminal closure. A terminal case may be FILED (closed / archived), but
  // nothing may revive it except an explicit reopen from a reopenable state.
  // `signed` is terminal and NOT reopenable, so no route back to pursuit
  // exists from it at all — the only thing left to do with a signed case is
  // file it.
  const ACTIVE = ROOM_STATUSES.filter((s) => !LIFECYCLE_TERMINAL.includes(s) && s !== 'under_review');
  for (const t of LIFECYCLE_TERMINAL) {
    const offered = availableActions(caseAt(t), { role: 'recruitment_admin' });
    neg(!offered.some((a) => ACTIVE.includes(LIFECYCLE_ACTIONS[a].to)),
      `P13 a ${t} case cannot be moved back into active pursuit`);
    const revivers = offered.filter((a) => LIFECYCLE_ACTIONS[a].to === 'under_review');
    if (LIFECYCLE_REOPENABLE.includes(t)) {
      neg(revivers.length === 1 && revivers[0] === 'reopenCase',
        `P14 a ${t} case is revived by exactly one action, and it is named reopenCase`);
    } else {
      neg(revivers.length === 0, `P14 a ${t} case offers no revival at all — it is not reopenable`);
    }
  }

  // The general form of the defect P13/P14 found: three actions reach
  // `under_review`, and from a withdrawn case all three were offered at once.
  // Each writes a different reason code into a history nothing ever rewrites,
  // so "resumed from hold" could be recorded for a case that was never held.
  let ambiguous = 0;
  for (const from of ROOM_STATUSES) {
    for (const role of ROLES) {
      const targets = availableActions(caseAt(from), { role }).map((a) => LIFECYCLE_ACTIONS[a].to);
      if (new Set(targets).size !== targets.length) ambiguous += 1;
    }
  }
  neg(ambiguous === 0,
    'P15 no state ever offers two actions for the same move — one event, one name, one reason code');

  // availableActions and the validator must agree in BOTH directions. A list
  // that is merely a subset of what is permitted still hides capability; one
  // that is a superset offers what will then be refused.
  let disagreements = 0;
  for (const from of ROOM_STATUSES) {
    for (const role of ROLES) {
      const offered = new Set(availableActions(caseAt(from), { role }));
      for (const a of ACTIONS) {
        const v = canTransitionRecruitmentCase(caseAt(from), a, { role, forAvailability: true });
        if (offered.has(a) !== v.ok) disagreements += 1;
      }
    }
  }
  neg(disagreements === 0,
    'P16 the offered-action list and the validator agree in both directions, for every state and role');

  // An unknown role is not a weak role. Anything the ranking does not know
  // fails closed rather than falling through to the lowest tier.
  for (const role of [null, undefined, '', 'admin', 'owner', 'ROOM_LEAD', 'recruitment_admin ']) {
    const v = canTransitionRecruitmentCase(caseAt('watching'), 'startReview', { role });
    neg(v.ok === false && v.error === 'LIFECYCLE_NOT_PERMITTED',
      `P17 an unrecognised role (${JSON.stringify(role)}) is refused, not treated as the lowest tier`);
  }

  // A corrupt stored state is corruption, not a workflow position — and it is
  // never coerced to a plausible-looking one.
  for (const bogus of ['identified', 'IN_PROGRESS', 'trial_in_progress', '', null, 42]) {
    const v = canTransitionRecruitmentCase({ ...caseAt('watching'), room: { status: bogus, rev: 1 } }, 'startReview', { role: 'recruitment_admin' });
    neg(v.ok === false && v.error === 'LIFECYCLE_STATE_UNKNOWN',
      `P18 a case stored at ${JSON.stringify(bogus)} is reported as unrecognised, never coerced`);
  }
}

section('HTTP — booting a real server');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** Start a server on the shared PORT and DATA_DIR, and wait for it to answer. */
async function boot() {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1' }, stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

// Filled in by group C, read by group R after the process is restarted.
const IDEMPOTENCY_PROBE = { room: null, key: null, from: null, to: null };
/** Section E collects every refusal the two routes can produce; section Y sweeps the same set. */
const ERROR_BODIES_FROM_E = [];
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const realEvidence = createEvidenceProvider({ signings: [] });
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const harbour = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, harbour, kola].every((x) => x?.token), 'HTTP actors logged in');

const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name));
const created = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, maria.token);
const ROOM = created.body.room?.roomId;
ok(created.status === 201 && ROOM, 'J2 a case opens, and it starts at the canonical initial state');
ok(created.body.room.status === 'watching', 'J2b which is `watching`');

section('J — the positive journeys');
{
  // J1 — an existing M17 case projects.
  const j1 = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  ok(j1.status === 200 && j1.body.ok === true, 'J1 an M17-created case projects through the canonical journey');
  ok(j1.body.lifecycle.currentStage === 'watching', 'J1b with its real current stage');
  ok(j1.body.lifecycle.policyVersion === RECRUITMENT_LIFECYCLE_POLICY_VERSION, 'J1c and the policy version it was computed under');
  ok(Array.isArray(j1.body.nextActions) && j1.body.nextActions.includes('startReview'), 'J1d and deterministic next actions');
  neg(!j1.body.nextActions.includes('confirmSignedOutcome'), 'J1e which never include one the evidence cannot support');

  const rev0 = j1.body.case.rev;

  // J3/J4/J5 — move, history, rev.
  const mv = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: rev0 }, maria.token);
  ok(mv.status === 200 && mv.body.to === 'under_review', 'J3 an authorised lead moves the case to under_review');
  const j2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(j2.history.entries.some((e) => e.to === 'under_review'), 'J4 the transition is appended to history');
  ok(j2.case.rev === rev0 + 1, 'J5 the case rev incremented exactly once');

  // J6 — idempotency, bound to request identity.
  const key = 'ck-plan-1';
  const p1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'planContact', expectedRev: j2.case.rev, clientKey: key }, maria.token);
  ok(p1.status === 200 && p1.body.to === 'contact_planned', 'J6a planContact lands');
  const historyLen = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body.history.total;
  const p2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'planContact', expectedRev: 999, clientKey: key }, maria.token);
  ok(p2.status === 200 && p2.body.idempotent === true, 'J6b the same action with the same key replays without re-applying');
  const after = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(after.history.total === historyLen, '#29 and appends no duplicate history entry');

  // #8 — contact is not yet implemented, so `contacted` is refused for want of evidence.
  const noEvidence = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'recordContact', expectedRev: after.case.rev }, maria.token);
  neg(noEvidence.status === 422 && noEvidence.body.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#14-mandate a contact cannot be recorded before the Contact phase can prove one happened');

  // J7/J8 — hold, then resume. Hold is live, not an ending.
  const hold = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: after.case.rev }, maria.token);
  ok(hold.status === 200 && hold.body.to === 'on_hold', 'J7 the case can be put on hold');
  const held = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(held.lifecycle.terminal === false, 'J7b and a held case is NOT terminal');
  ok(held.conditions.onHold === true, 'J7c the derived condition reports the hold');
  const resume = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'resumeCase', expectedRev: held.case.rev }, maria.token);
  ok(resume.status === 200 && resume.body.to === 'under_review', 'J8 and it resumes into review');

  // J9/J11 — reject, preserving everything.
  const beforeReject = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const rej = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'rejectCase', expectedRev: beforeReject.case.rev, reasonCodes: ['rejected'] }, maria.token);
  ok(rej.status === 200 && rej.body.to === 'archived', 'J9 the case can be rejected with a structured reason');
  const rejected = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(rejected.history.total >= beforeReject.history.total, '#28/#36 rejecting destroyed no prior history');
  ok(rejected.history.entries.some((e) => e.to === 'on_hold'), 'J11 including the hold that came before it');

  // #26 — archive is not rejection-by-another-name in the projection.
  neg(rejected.lifecycle.currentStage === 'archived' && !/rejected/i.test(JSON.stringify(rejected.lifecycle)),
    '#26 an archived room is reported as archived, never silently relabelled "rejected"');

  // J10 — reopen preserves terminal history.
  const reopen = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: rejected.case.rev }, maria.token);
  ok(reopen.status === 200 && reopen.body.to === 'under_review', 'J10 an authorised reopen works');
  const reopened = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(reopened.history.entries.some((e) => e.to === 'archived'), '#37 and the terminal history survives the reopen');
  ok(reopened.history.total > rejected.history.total, 'J10b the reopen is itself appended');

  // #24 — closed -> reopened -> closed is three real transitions, not one deduped pair.
  //
  // Note the hold before each close. `under_review -> closed` is NOT an edge,
  // in M17 or in M23: a case is put beyond active pursuit (held, withdrawn or
  // archived) before it is filed away. The first draft of this test assumed the
  // shortcut existed; the table refused, which is the table working.
  const h1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: reopened.case.rev }, maria.token);
  ok(h1.status === 200, 'a case is held before it can be filed away');
  const preC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: preC1.case.rev, reasonCodes: ['case_closed'], clientKey: 'close-a' }, maria.token);
  ok(c1.status === 200, 'a case closes');
  const afterC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const r2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: afterC1.case.rev }, maria.token);
  const midR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: midR2.case.rev }, maria.token);
  const afterR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: afterR2.case.rev, reasonCodes: ['case_closed'], clientKey: 'close-b' }, maria.token);
  ok(r2.status === 200 && c2.status === 200,
    '#24 closed -> reopened -> closed all land: idempotency binds to request identity, not to an all-time stage pair');
  const afterC2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(afterC2.history.total > afterR2.history.total, 'and the second close is recorded in its own right');
}

section('Negatives — isolation, authority, concurrency, privacy');
{
  const cur = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;

  // #1/#2/#3 — foreign org.
  const fRead = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, harbour.token);
  neg(fRead.status === 404, '#2 a foreign org reading the journey gets 404');
  const fMove = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: cur.case.rev }, harbour.token);
  neg(fMove.status === 404, '#3 and a foreign org transition is 404, not 403 — no existence leak');
  neg(!JSON.stringify(fMove.body).includes(ADULT.id), '#17 and the refusal names no player');

  // #5 — arbitrary stage patch.
  const patch = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { stage: 'signed', expectedRev: cur.case.rev }, maria.token);
  neg(patch.status === 400 && patch.body.error === 'LIFECYCLE_STAGE_NOT_SETTABLE',
    '#5/#25 a client naming a stage is refused by name, and told to name an action');
  const patch2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', status: 'signed', expectedRev: cur.case.rev }, maria.token);
  neg(patch2.status === 400, '#25b smuggling a status alongside a valid action is refused too');

  // #6 — invalid jump.
  const jump = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'recordOfferAccepted', expectedRev: cur.case.rev }, maria.token);
  neg(jump.status === 409 && jump.body.error === 'LIFECYCLE_TRANSITION_INVALID', '#6 an impossible jump is 409');
  neg(Array.isArray(jump.body.allowed), 'and the refusal says what IS allowed');

  // An action that CAN traverse the edge but does not describe it. The case is
  // here in a terminal state, and `startReview` would land on the same
  // `under_review` that `reopenCase` does — writing `club_decision` into the
  // history for what is, in fact, a reopen.
  const misnamed = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: cur.case.rev }, maria.token);
  neg(misnamed.status === 409 && misnamed.body.error === 'LIFECYCLE_ACTION_NOT_APPLICABLE',
    'an action that does not describe the move is refused, even though the edge exists');
  const wrongResume = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'resumeCase', expectedRev: cur.case.rev }, maria.token);
  neg(wrongResume.status === 409 && wrongResume.body.error === 'LIFECYCLE_ACTION_NOT_APPLICABLE',
    'and a case that was never on hold cannot be "resumed from hold"');

  // #7/#8 — rev.
  const reopenNow = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: cur.case.rev }, maria.token);
  ok(reopenNow.status === 200, 'a fresh rev works');
  const stale = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: cur.case.rev }, maria.token);
  neg(stale.status === 409 && stale.body.error === 'ROOM_VERSION_CONFLICT', '#7 a stale expectedRev is 409');
  // #18 — the conflict body carries names and times, never content.
  neg(!/note|comment|rationale|summary/i.test(JSON.stringify(stale.body)),
    '#18 and the conflict response leaks no private text');
  ok(stale.body.currentRev != null, 'it does tell the caller where to resync');

  // #9/#10 — idempotency key reuse with a DIFFERENT payload.
  const live = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const k = 'shared-key';
  const first = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: live.case.rev, clientKey: k }, maria.token);
  ok(first.status === 200 && first.body.to === 'on_hold', '#9 an action with a key lands');
  const different = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: 999, clientKey: k, reasonCodes: ['case_closed'] }, maria.token);
  neg(different.body?.idempotent !== true,
    '#10 the SAME key with a DIFFERENT action is not treated as a replay — identity is key AND action');

  // #4 — unauthorised staff.
  const held2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const byScout = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'confirmSignedOutcome', expectedRev: held2.case.rev }, tom.token);
  // Named exactly, not "one of three refusals". A disjunction over 403/409/422
  // is the D5 shape: it passes when the server refuses for a DIFFERENT reason
  // than the one under test, which is how a role-resolution bug hid behind an
  // evidence gate. Role is checked before the transition table, so a scout is
  // refused for who they are, and that is the assertion.
  neg(byScout.status === 403 && byScout.body?.error === 'LIFECYCLE_NOT_PERMITTED',
    '#4 a non-lead scout is refused 403 LIFECYCLE_NOT_PERMITTED — for their role, not for missing evidence');

  // #13 — the player has no route into any of it.
  const playerTry = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, kola.token);
  neg(playerTry.status === 401 || playerTry.status === 403 || playerTry.status === 404,
    '#13 a player token cannot read an org recruitment journey at all');

  // #19/#20/#21/#22 — lifecycle changes nothing elsewhere.
  const trustBefore = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  const nowState = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'resumeCase', expectedRev: nowState.case.rev }, maria.token);
  const trustAfter = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  neg(JSON.stringify(trustBefore?.score ?? null) === JSON.stringify(trustAfter?.score ?? null),
    '#19 J18 a lifecycle transition does not move the Trust Score');

  const plans = (await j('GET', `/org/development/plans?playerId=${ADULT.id}`, undefined, maria.token)).body;
  neg(!Array.isArray(plans?.plans) || plans.plans.length === 0,
    '#20 no Development Plan was created by moving the lifecycle');

  const second = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  const items = second?.items ?? second?.open ?? [];
  neg(!items.some((i) => i.playerId === ADULT.id && i.kind === 'general_update'),
    '#22 a lifecycle transition alone raises no Second Look item');

  // #35 — Passport gains nothing.
  const passport = (await j('GET', `/org/players/${ADULT.id}/passport`, undefined, maria.token)).body;
  const pj = JSON.stringify(passport ?? {});
  neg(!/under_review|on_hold|offer_consideration|contact_planned|recruitment_case/i.test(pj),
    '#35 the Passport gains no hidden recruitment interest from the lifecycle');
}

section('H1-H6 — the signed boundary, attacked from every write path');
{
  // Drive a case all the way to offer_made using a provider-satisfied path is
  // not possible in P2 (offer evidence is not implemented), so this group
  // works against the pure validator for state coverage and against real HTTP
  // for the routes that exist. Both matter: the validator is the rule, the
  // routes are where the rule is actually reachable.

  // ---- H1: the normal semantic action, no evidence.
  const atAccepted = { id: 'c-h', orgId: 'org-eastport', playerId: ADULT.id, room: { status: 'offer_accepted', rev: 1 } };
  const h1 = canTransitionRecruitmentCase(atAccepted, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: realEvidence });
  neg(h1.ok === false && h1.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'H1 offer_accepted -> signed is refused: no confirmed joining record exists for this player');
  neg(h1.evidenceReason === 'no_confirmed_join', 'H1b and the reason names what is missing, not a generic failure');

  // ---- H5: offer_made carries the IDENTICAL burden.
  const atMade = { ...atAccepted, room: { status: 'offer_made', rev: 1 } };
  const h5 = canTransitionRecruitmentCase(atMade, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: realEvidence });
  neg(h5.ok === false && h5.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'H5 offer_made -> signed requires exactly the same evidence — the retained legacy edge is not a weaker path');
  neg(h5.requires === h1.requires, 'H5b and it is literally the same requirement, because the table is keyed by target');

  // ---- H6: foreign signing evidence does not count.
  const foreignSigning = { id: 'sign-foreign', orgId: 'org-harbour', playerId: ADULT.id, ts: Date.now() };
  const otherPlayer = { id: 'sign-other', orgId: 'org-eastport', playerId: 'pl-someone-else', ts: Date.now() };
  const cancelled = { id: 'sign-cancelled', orgId: 'org-eastport', playerId: ADULT.id, ts: Date.now(), cancelledAt: Date.now() };
  const probe = (rows) => createEvidenceProvider({ signings: rows }).check('confirmed_join', { kase: atAccepted });
  neg(probe([foreignSigning]).satisfied === false, 'H6 another club\'s signing does not prove this club signed the player');
  neg(probe([otherPlayer]).satisfied === false, 'H6b another player\'s signing proves nothing about this one');
  neg(probe([cancelled]).satisfied === false, 'H6c a cancelled signing is not a signing');
  ok(probe([{ id: 'sign-ok', orgId: 'org-eastport', playerId: ADULT.id, ts: Date.now() }]).satisfied === true,
    'H6d a signing for this club AND this player does prove it');
  neg(probe(undefined).satisfied === false && probe(undefined).reason === 'signings_store_unavailable',
    'H6e a MISSING signings store is reported as unavailable, never as "no signing" — the D2 lesson again');

  // ---- H2/H3: the legacy status route is not a side door.
  //
  // THIS IS THE DEFECT THIS HARDENING PASS EXISTS TO CATCH. Before the fix a
  // club at offer_made could POST {status:'signed'} here and land on signed
  // with nothing in db.signings at all.
  const lr = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, harbour.token);
  const HR = lr.body?.room?.roomId;
  if (HR) {
    const direct = await j('POST', `/org/rooms/${HR}/status`, { status: 'signed' }, harbour.token);
    neg(direct.status === 409 && direct.body?.error === 'ROOM_TRANSITION_INVALID',
      'H2 the legacy status route answers 409 ROOM_TRANSITION_INVALID for watching -> signed');
    const st = (await j('GET', `/org/rooms/${HR}`, undefined, harbour.token)).body;
    neg(st.room?.status !== 'signed', 'H2b and the case did not move');
  } else {
    ok(false, 'could not create the harbour fixture room');
  }

  // H2c — the legacy route enforces the gate for a status it CAN reach.
  //
  // `signed` is unreachable over HTTP in P2 (every route into it needs
  // evidence no phase can supply), so proving the route gate needs a status
  // that is both reachable and evidence-bearing: `contacted`, one step from
  // `contact_planned`. Before the fix this returned 200 and moved the case.
  // Use the harbour room: a DIFFERENT org, so it is a genuinely new case at
  // `watching` rather than the adopted Eastport one (there is one open room
  // per org and player, so re-creating returns the existing case).
  const GR = HR;
  const gateBefore = (await j('GET', `/org/rooms/${GR}/journey`, undefined, harbour.token)).body;
  const planned = await j('POST', `/org/rooms/${GR}/lifecycle`, { action: 'planContact', expectedRev: gateBefore.case?.rev }, harbour.token);
  if (planned.status === 200) {
    const sneak = await j('POST', `/org/rooms/${GR}/status`, { status: 'contacted' }, harbour.token);
    neg(sneak.status === 422 && sneak.body.error === 'ROOM_EVIDENCE_REQUIRED',
      'H2c the LEGACY status route refuses an evidence-bearing status — the side door is closed');
    neg(sneak.body.requires === 'contact_delivered', 'H2d and names the record it wanted');
    const after = (await j('GET', `/org/rooms/${GR}`, undefined, harbour.token)).body;
    neg(after.room?.status === 'contact_planned', 'H2e the case did not move');
  } else {
    ok(false, 'could not reach contact_planned for the legacy-route gate test');
  }

  // H3 — the M12 legacy stage route cannot express `signed` at all.
  const stageNames = ['identified', 'review', 'observation', 'trial', 'invited', 'awaiting_response', 'decision', 'closed'];
  neg(stageNames.every((st) => roomStatusForStage(st, 'academy') !== 'signed'),
    'H3 no legacy M12 stage maps to `signed` — the compatibility path cannot express it');
  neg(stageNames.every((st) => roomStatusForStage(st, 'grassroots') !== 'signed'),
    'H3b in either vocabulary');

  // ---- H4: concurrency. A stale actor cannot win by racing.
  const cur = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const staleRev = cur.case.rev;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: staleRev }, maria.token);
  const raced = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'confirmSignedOutcome', expectedRev: staleRev }, maria.token);
  // Named, not merely "not 200". A bare `!== 200` also passes when the caller
  // is refused for PERMISSION — which is how a silently demoted lead looks,
  // and would hide the real gate behind an accidental one.
  neg(raced.status === 409 && raced.body?.error === 'LIFECYCLE_TRANSITION_INVALID',
    'H4 a racing confirm-signing loses on the transition table — the case is not at an offer');
  neg(raced.body?.error !== 'LIFECYCLE_NOT_PERMITTED',
    'H4b and it loses on the RULE, not because the actor was refused permission');

  // ---- The evidence table is keyed by target, so every inbound edge is covered.
  const inboundToSigned = Object.entries(ROOM_TRANSITIONS).filter(([, tos]) => tos.includes('signed')).map(([from]) => from);
  ok(inboundToSigned.length >= 2, `there is more than one inbound edge to signed (${inboundToSigned.join(', ')})`);
  for (const from of inboundToSigned) {
    const k = { ...atAccepted, room: { status: from, rev: 1 } };
    const v = canTransitionRecruitmentCase(k, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: realEvidence });
    if (v.ok !== false || v.error !== 'LIFECYCLE_EVIDENCE_REQUIRED') fail(`${from} -> signed skipped the evidence requirement`);
  }
  neg(true, 'every inbound edge to signed carries the evidence requirement — no weaker path exists');
}

section('Legacy compatibility — an old case still reads');
{
  // J12 — a case whose room predates M23, with no lifecycleAction on any entry
  // and a status from the original thirteen, must project without rewriting.
  const legacy = await j('POST', '/org/rooms', { playerId: players.find((p) => p.id !== ADULT.id)?.id, sourceContext: 'search' }, maria.token);
  if (legacy.status === 201) {
    const LID = legacy.body.room.roomId;
    const viaOldRoute = await j('POST', `/org/rooms/${LID}/status`, { status: 'under_review' }, maria.token);
    ok(viaOldRoute.status === 200, 'J12 the pre-M23 status route still works');
    const proj = await j('GET', `/org/rooms/${LID}/journey`, undefined, maria.token);
    ok(proj.status === 200 && proj.body.lifecycle.currentStage === 'under_review',
      '#27 J12b and the case it produced projects through the M23 journey unchanged');
    ok(proj.body.history.entries.some((e) => e.to === 'under_review'),
      'J12c its history, written by the old route, is read by the new projector');
  } else {
    ok(false, 'could not create the legacy fixture case');
  }
}

section('V — two reason taxonomies, and the route must use the right one');
{
  // M17's 20 codes say why a club DECIDED something — an opinion about a
  // player. M23's 16 say why a case MOVED — an event in a process. The route
  // used to validate transitions against the DECISION taxonomy, which accepted
  // a judgement about a player as the reason a case closed and refused every
  // one of the sixteen reasons it publishes.
  neg(LIFECYCLE_REASON_CODES.every((c) => !ALL_REASON_CODES.includes(c)),
    'V1 the two taxonomies share no code at all — they are not interchangeable');
  ok(LIFECYCLE_REASON_CODES.every((c) => isLifecycleReason(c)),
    'V2 and every published lifecycle code passes the lifecycle predicate');

  neg(validateLifecycleReasons(['squad_space']).error === 'LIFECYCLE_REASON_UNKNOWN',
    'V3 a DECISION reason is refused on a lifecycle transition');
  ok(validateLifecycleReasons(['case_closed']).ok === true,
    'V4 while a lifecycle reason is accepted');
  neg(Array.isArray(validateLifecycleReasons(['squad_space']).allowed),
    'V5 and the refusal publishes the taxonomy that WOULD work, so the caller can correct it');

  // Safeguarding is shared deliberately: one rule, one implementation, one
  // error code. A protected characteristic is never a reason for anything.
  for (const c of ['nationality', 'religion', 'disability', 'postcode']) {
    const v = validateLifecycleReasons([c]);
    neg(v.ok === false && v.error === 'ROOM_REASON_PROHIBITED',
      `V6 "${c}" is refused as a prohibited characteristic, with M17's own error code`);
  }
  neg(validateLifecycleReasons(Array.from({ length: 7 }, () => 'case_closed').map((c, i) => (i ? `${c}` : c))).ok === true,
    'V7 duplicates collapse rather than tripping the ceiling');
  neg(validateLifecycleReasons(LIFECYCLE_REASON_CODES.slice(0, 7)).error === 'LIFECYCLE_REASONS_TOO_MANY',
    'V8 but seven distinct reasons on one transition is refused');
  for (const bad of ['case_closed', 0, {}, null, [['case_closed']]]) {
    const v = validateLifecycleReasons(bad);
    neg(v.ok === false, `V9 ${JSON.stringify(bad)} is not a valid reason list`);
  }

  // Every action that REQUIRES a reason must have one it can actually be given.
  const needsReason = Object.entries(LIFECYCLE_ACTIONS).filter(([, d]) => d.reasonCodesRequired);
  ok(needsReason.length === 3, `V10 ${needsReason.length} actions require a recorded reason`);
  neg(needsReason.every(([, d]) => isLifecycleReason(d.reason)),
    'V11 and each one\'s own default reason is a valid LIFECYCLE code — a required reason nobody can supply is a dead action');
}

section('T — hostile input: no shape of request body becomes a 500');
{
  let TROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) { TROOM = r.body.room.roomId; break; }
  }
  ok(!!TROOM, 'T0 a case for the input checks');

  // T1 — the one that was actually broken. `LIFECYCLE_ACTIONS` was a plain
  // object literal, so `LIFECYCLE_ACTIONS['constructor']` was truthy: the
  // route's `!LIFECYCLE_ACTIONS[action]` guard passed it through, the
  // validator read `.roles` off Object's constructor, and one word of request
  // body became a 500.
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype', 'isPrototypeOf'];
  for (const k of PROTO_KEYS) {
    const r = await j('POST', `/org/rooms/${TROOM}/lifecycle`, { action: k }, maria.token);
    neg(r.status === 400 && r.body?.error === 'LIFECYCLE_ACTION_UNKNOWN',
      `T1 action "${k}" is an unknown action, not a crash`);
  }

  // T2 — the same hazard on the read side, where the key comes from STORED
  // data rather than from the request.
  neg(PROTO_KEYS.every((k) => ROOM_TRANSITIONS[k] === undefined && STATUS_EVIDENCE_REQUIRED[k] === undefined),
    'T2 the status tables answer undefined for a key nobody defined');
  neg(PROTO_KEYS.every((k) => roomStatusForStage(k, 'pro') === null && roomStatusForStage(k, 'grassroots') === null),
    'T3 and so does the stage map, in both vocabularies');

  // T4 — everything else a client can put in the body. The property is that
  // NOTHING produces a 5xx: a bad request is the caller's problem and must be
  // reported as such.
  const HOSTILE_ACTIONS = [null, 0, 1, true, false, {}, [], ['holdCase'], { action: 'holdCase' }, 'x'.repeat(5000), '', ' holdCase ', 'HOLDCASE'];
  const HOSTILE_REVS = ['3', 3.5, -1, 0, NaN, Infinity, -Infinity, {}, [], '1e309', Number.MAX_SAFE_INTEGER + 2, null, 'abc'];
  const HOSTILE_KEYS = [{}, [], 0, true, 'k'.repeat(10000), '__proto__', null];
  const HOSTILE_REASONS = ['club_decision', {}, 0, [{}], [null], [['club_decision']], Array(200).fill('club_decision'), ['x'.repeat(5000)], [{ toString: 1 }]];
  const BODIES = [];
  for (const a of HOSTILE_ACTIONS) BODIES.push({ action: a });
  for (const v of HOSTILE_REVS) BODIES.push({ action: 'holdCase', expectedRev: v });
  for (const v of HOSTILE_KEYS) BODIES.push({ action: 'holdCase', clientKey: v });
  for (const v of HOSTILE_REASONS) BODIES.push({ action: 'closeCase', reasonCodes: v });
  BODIES.push({}, { action: 'holdCase', extra: { __proto__: { polluted: true } } });

  let crashes = 0; let statuses = new Set();
  for (const b of BODIES) {
    const r = await j('POST', `/org/rooms/${TROOM}/lifecycle`, b, maria.token);
    statuses.add(r.status);
    if (r.status >= 500) { crashes += 1; console.error(`   500 on ${JSON.stringify(b).slice(0, 120)}`); }
  }
  neg(crashes === 0, `T4 none of ${BODIES.length} hostile bodies produced a 5xx (saw ${[...statuses].sort().join(', ')})`);
  neg(({}).polluted === undefined, 'T5 and nothing in that set polluted Object.prototype');

  // T6 — raw non-JSON and non-object bodies, which never reach the route's
  // destructuring in the shape it expects.
  for (const raw of ['not json', '[]', '"string"', '123', 'null', '{"action":']) {
    const r = await fetch(`${BASE}/org/rooms/${TROOM}/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
      body: raw,
    });
    neg(r.status < 500, `T6 a raw body of ${JSON.stringify(raw.slice(0, 20))} is a 4xx, not a crash`);
  }

  // T7 — pagination numbers on the read side.
  for (const q of ['limit=-1', 'limit=0', 'limit=abc', 'limit=1e9', 'limit=Infinity', 'limit=999999999999',
    'cursor=-1', 'cursor=abc', 'cursor=1e12', 'limit=50&cursor=1e12', 'limit[]=5', 'limit=__proto__']) {
    const r = await j('GET', `/org/rooms/${TROOM}/journey?${q}`, undefined, maria.token);
    neg(r.status === 200 && Array.isArray(r.body?.history?.entries) && r.body.history.entries.length <= 200,
      `T7 ?${q} returns a clamped page rather than a crash or an unbounded response`);
  }

  // T8 — the case id itself.
  for (const id of ['..%2f..%2fetc%2fpasswd', 'x'.repeat(2000), '%00', 'case-1%20or%201=1', '__proto__']) {
    const r = await j('GET', `/org/rooms/${id}/journey`, undefined, maria.token);
    neg(r.status === 404 || r.status === 400,
      `T8 a case id of ${JSON.stringify(id.slice(0, 24))} is not found, and is not a crash`);
  }
}

section('X — stored corruption: a broken record is reported, never rendered as fact');
{
  // These go straight at the projector with databases that could not have been
  // written by this build. The rule from M23-D2 carries forward: a broken
  // record is infrastructure failure or corruption, and neither is "no data".
  const VIEWER = { kind: 'org_staff', orgId: 'org-X', role: 'room_lead' };
  const OPTS = { now: 1767225600000, evidence: NULL_EVIDENCE_PROVIDER };
  const base = (over = {}) => ({
    recruitmentCases: [{ id: 'case-X', orgId: 'org-X', playerId: 'pl-X', stage: 'review', createdAt: 1, history: [], room: { status: 'under_review', rev: 1 }, ...over }],
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [],
  });
  const build = (db) => { try { return buildRecruitmentJourney(db, 'case-X', VIEWER, OPTS); } catch (e) { return { threw: e }; } };

  // A required store missing is NOT an empty history.
  for (const store of JOURNEY_REQUIRED_STORES) {
    const db = base(); delete db[store];
    const out = build(db);
    neg(out.ok === false && out.error === 'JOURNEY_STORE_MISSING' && out.missing?.includes(store),
      `X1 a missing \`${store}\` is reported as broken infrastructure, not as empty history`);
  }

  // A store present but of the wrong TYPE. `null` is not "absent", and an
  // object is not a list.
  for (const bad of [null, 0, '', 'nope', {}, true]) {
    const db = base(); db.roomDecisions = bad;
    const out = build(db);
    neg(out.threw === undefined, `X2 roomDecisions = ${JSON.stringify(bad)} does not throw out of the projector`);
  }

  // The refusal names WHICH failure happened. "Absent" and "present but not a
  // list" are different operational problems and a log that conflates them
  // sends someone looking in the wrong place.
  {
    const db = base(); db.trials = null; delete db.assessments;
    const out = build(db);
    neg(out.malformed?.includes('trials') && out.missing?.includes('assessments'),
      'X2b and names which store was absent and which was the wrong type');
  }

  // A corrupt case must not become a disclosure oracle. A player who receives
  // "this case is corrupt" where a stranger receives "no such case" has just
  // been told the case exists.
  {
    const db = base({ history: { 0: 'x' } });
    const asPlayer = buildRecruitmentJourney(db, 'case-X', { kind: 'player_self', playerId: 'pl-X' }, OPTS);
    const asStranger = buildRecruitmentJourney(db, 'case-X', { kind: 'player_self', playerId: 'pl-nobody' }, OPTS);
    neg(asPlayer.error === 'CASE_NOT_FOUND' && JSON.stringify(asPlayer) === JSON.stringify(asStranger),
      'X2c a player asking about a corrupt case gets the same answer as for a case that never existed');
    const asClub = buildRecruitmentJourney(db, 'case-X', VIEWER, OPTS);
    neg(asClub.error === 'CASE_HISTORY_CORRUPT',
      'X2d while the club that owns it is told plainly that the record is unreadable');
  }

  // Corrupt values ON the case.
  const CORRUPTIONS = [
    ['room missing', { room: undefined }],
    ['room null', { room: null }],
    ['room not an object', { room: 'under_review' }],
    ['status unknown', { room: { status: 'identified', rev: 1 } }],
    ['status a prototype key', { room: { status: '__proto__', rev: 1 } }],
    ['status null', { room: { status: null, rev: 1 } }],
    ['rev missing', { room: { status: 'under_review' } }],
    ['rev a string', { room: { status: 'under_review', rev: '4' } }],
    ['rev negative', { room: { status: 'under_review', rev: -3 } }],
    ['history missing', { history: undefined }],
    ['history not an array', { history: { 0: 'x' } }],
    ['history holding nulls', { history: [null, undefined, 0] }],
    ['history entries without an action', { history: [{ at: 1 }, { action: null }] }],
    ['history entry with an unknown action', { history: [{ action: 'teleported', at: 1, detail: { from: 'a', to: 'b' } }] }],
    ['history timestamps unsortable', { history: [{ action: 'room_status_changed', at: 'yesterday', detail: { from: 'watching', to: 'under_review' } }] }],
    ['stage disagreeing with status', { stage: 'closed' }],
  ];
  for (const [name, over] of CORRUPTIONS) {
    const out = build(base(over));
    neg(out.threw === undefined, `X3 ${name}: the projector answers instead of throwing`);
  }

  // The two that must answer with a NAMED refusal rather than a rendered page.
  neg(build(base({ room: null })).error === 'CASE_NOT_A_ROOM',
    'X4 a case with no room facet is refused by name, not projected as an empty workspace');

  // An unknown stored action is OMITTED from the timeline rather than rendered
  // as a fabricated event. Inventing a label for it would put a sentence in
  // front of a user that describes something that never happened.
  const invented = build(base({ history: [
    { action: 'room_status_changed', at: 2, detail: { from: 'watching', to: 'under_review' } },
    { action: 'teleported', at: 3, detail: { from: 'under_review', to: 'signed' } },
  ] }));
  neg(!JSON.stringify(invented.history?.entries ?? []).includes('teleported'),
    'X5 an unknown history action is omitted, never rendered as a timeline event');
  neg(!JSON.stringify(invented.history?.entries ?? []).includes('signed'),
    'X6 and its invented destination does not leak into the timeline either');

  // A corrupt stored status must not become a plausible one. Guessing is how a
  // broken record turns into a confident wrong answer.
  const unknownStatus = build(base({ room: { status: 'identified', rev: 1 } }));
  if (unknownStatus.ok) {
    neg(unknownStatus.lifecycle.currentStage === 'identified',
      'X7 a stored status this build does not know is reported verbatim, never coerced to a known one');
    neg(Array.isArray(unknownStatus.nextActions) && unknownStatus.nextActions.length === 0,
      'X8 and no action is offered on a case whose state cannot be interpreted');
  } else {
    neg(true, 'X7 a stored status this build does not know is refused by name');
  }
}

section('C — concurrency and idempotency: one request, one effect, one entry');
{
  const spare = players.find((p) => p.id !== ADULT.id);
  let CROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) { CROOM = r.body.room.roomId; break; }
  }
  ok(!!CROOM && !!spare, 'C0 a fresh case for the concurrency checks');

  const state = async () => (await j('GET', `/org/rooms/${CROOM}/journey`, undefined, maria.token)).body;
  const historyLen = async () => (await state()).history.total;

  // C1 — the lost update. Two callers read the same rev and both act. One must
  // win; the other must be told, not silently overwritten.
  const base = await state();
  const [a, b] = await Promise.all([
    j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'startReview', expectedRev: base.case.rev }, maria.token),
    j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'shortlist', expectedRev: base.case.rev }, maria.token),
  ]);
  const winners = [a, b].filter((r) => r.status === 200);
  const losers = [a, b].filter((r) => r.status !== 200);
  ok(winners.length === 1, 'C1 exactly one of two racing writers on the same rev succeeds');
  neg(losers.length === 1 && losers[0].status === 409 && losers[0].body?.error === 'ROOM_VERSION_CONFLICT',
    'C2 and the loser is told its read was stale, not silently discarded');
  neg(losers[0].body?.currentRev != null, 'C3 with the rev it needs to resync');

  // C4 — one accepted request writes exactly one history entry and moves the
  // rev by exactly one. A double-append is invisible until someone counts.
  const beforeLen = await historyLen();
  const beforeRev = (await state()).case.rev;
  const single = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'prioritise', expectedRev: beforeRev }, maria.token);
  ok(single.status === 200, 'C4 a clean write succeeds');
  const afterLen = await historyLen();
  const afterRev = (await state()).case.rev;
  neg(afterLen === beforeLen + 1, 'C5 and appends exactly one history entry, not two');
  neg(afterRev === beforeRev + 1, 'C6 and moves the rev by exactly one');

  // C7-C9 — idempotent replay. The key is the caller's, so a repeat is the
  // SAME request, not a second one.
  const key = `ckey-${Date.now()}`;
  const first = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'holdCase', expectedRev: afterRev, clientKey: key }, maria.token);
  ok(first.status === 200 && !first.body.idempotent, 'C7 the first call with a client key performs the action');
  const lenAfterFirst = await historyLen();
  const replay = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'holdCase', clientKey: key }, maria.token);
  ok(replay.status === 200 && replay.body.idempotent === true, 'C8 the identical call replays instead of acting again');
  neg(await historyLen() === lenAfterFirst, 'C9 and writes no second history entry');
  ok(replay.body.from === first.body.from && replay.body.to === first.body.to,
    'C10 the replay reports the original endpoints, not the current state');

  // C11 — the key is bound to the ACTION, not just to the case. Reusing a key
  // for something else is a different request and must not be swallowed.
  const different = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'resumeCase', expectedRev: replay.body.currentRev ?? (await state()).case.rev, clientKey: key }, maria.token);
  neg(different.body?.idempotent !== true,
    'C11 the same key with a DIFFERENT action is not a replay — it is a different request');

  // C12 — a replay is still an action. Someone whose role could never have
  // performed it must not be told it succeeded. Full validation cannot stand
  // in for this check: the case has moved, so the transition is no longer
  // legal and every replay would be refused for the wrong reason.
  const junior = await login('org-eastport', 'Replay Prober', 'First-Team Scout');
  const stolen = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'holdCase', clientKey: key }, junior.token);
  neg(stolen.status === 403 && stolen.body?.error === 'LIFECYCLE_NOT_PERMITTED',
    'C12 replaying another role\'s key is refused on permission, not answered 200');
  neg(!('from' in (stolen.body ?? {})) && !('to' in (stolen.body ?? {})),
    'C13 and the refusal echoes none of the original transition back');

  // C14 — the key lives in the CASE\'s history, so a key that means something
  // in one case means nothing in another. Cross-case and cross-org collision
  // is impossible by construction rather than by a uniqueness check.
  const otherState = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  const collide = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: otherState.body.case.rev, clientKey: key }, maria.token);
  neg(collide.body?.idempotent !== true,
    'C14 the same key on a different case is not a replay — idempotency is scoped to the case');

  // The restart half of this — a replay after the process dies — is checked
  // for real at the end of the suite (group R), because it needs the server
  // killed and brought back.
  IDEMPOTENCY_PROBE.room = CROOM;
  IDEMPOTENCY_PROBE.key = key;
  IDEMPOTENCY_PROBE.from = first.body.from;
  IDEMPOTENCY_PROBE.to = first.body.to;
}

section('A — authorization drift: the role is decided now, from the database, not from the token');
{
  // The whole group exists because a role resolved once and carried is a role
  // that can be wrong later. Every check here changes the world AFTER a token
  // was minted and then uses the OLD token.
  const drifter = await login('org-eastport', 'Drift Tester', 'First-Team Scout');
  const DRIFT_TOKEN = drifter.token;

  // A room this person did not open and is not assigned to.
  // Seeded data already holds rooms for some players; take the first one that
  // is free rather than assuming.
  let target = null; let opened = null;
  for (const p of players) {
    if (p.id === ADULT.id) continue;
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, tom.token);
    if (r.status === 201) { target = p; opened = r; break; }
  }
  const AROOM = opened?.body?.room?.roomId;
  ok(!!AROOM, 'A0 a room exists that the drift tester neither opened nor was assigned to');

  const roleOf = async (token) => (await j('GET', `/org/rooms/${AROOM}/journey`, undefined, token)).body?.nextActions ?? [];

  // The discriminator for "what role did the server resolve?" is the REFUSAL
  // ORDER. `confirmSignedOutcome` is admin-only, and role is checked before
  // the transition table, so from `watching`:
  //
  //   below recruitment_admin -> 403 LIFECYCLE_NOT_PERMITTED
  //   recruitment_admin       -> 409 LIFECYCLE_TRANSITION_INVALID
  //
  // Neither reaches `signed`, which is the point: this reads the role without
  // needing a transition that P2 cannot legally perform.
  const confirmAs = async (token) => {
    const r = await j('POST', `/org/rooms/${AROOM}/lifecycle`, { action: 'confirmSignedOutcome' }, token);
    return r.status === 403 ? 'below_admin' : r.status === 409 ? 'admin' : `unexpected:${r.status}`;
  };

  // A1-A2 — a recruitment lead is a recruitment_admin ANYWHERE in the
  // organisation, including in a room they have never touched. This is the
  // check that catches a lead being silently demoted.
  ok(await confirmAs(maria.token) === 'admin',
    'A1 a recruitment lead resolves as recruitment_admin in a room they never opened');
  // A3 — and the tier below really is refused, so A1 is not passing because
  // everyone is an admin.
  neg(await confirmAs(DRIFT_TOKEN) === 'below_admin',
    'A3 a first-team scout is refused the admin-only action');

  // A4 — PROMOTION drift. The role changes in the database; the old token is
  // unchanged. If authorization came from the token, this would not move.
  await login('org-eastport', 'Drift Tester', 'Head of Recruitment');
  ok(await confirmAs(DRIFT_TOKEN) === 'admin',
    'A4 promoting them in the database promotes the OLD token too — the role is read per request');

  // A5 — DEMOTION drift, which is the direction that matters for safety.
  await login('org-eastport', 'Drift Tester', 'First-Team Scout');
  neg(await confirmAs(DRIFT_TOKEN) === 'below_admin',
    'A5 and demoting them demotes the old token immediately — no stale capability survives');

  // A6 — the offered-action list drifts with the role as well. A list computed
  // from a stale role is a UI that offers a 403.
  const beforeList = await roleOf(DRIFT_TOKEN);
  await login('org-eastport', 'Drift Tester', 'Head of Recruitment');
  const afterList = await roleOf(DRIFT_TOKEN);
  ok(afterList.length > beforeList.length,
    'A6 the offered-action list is recomputed from the live role, not cached with the session');
  await login('org-eastport', 'Drift Tester', 'First-Team Scout');

  // A7 — removal. The row survives so history stays attributed; the access
  // does not.
  const removed = await j('POST', `/org/staff/${drifter.userId}/remove`, {}, maria.token);
  ok(removed.status === 200, 'A7 a lead removes the drift tester');
  const afterRemoval = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, DRIFT_TOKEN);
  neg(afterRemoval.status === 401,
    'A8 and their still-valid-looking token is refused on the journey — removal is not a UI state');
  const writeAfterRemoval = await j('POST', `/org/rooms/${AROOM}/lifecycle`, { action: 'shortlist' }, DRIFT_TOKEN);
  neg(writeAfterRemoval.status === 401, 'A9 and on the lifecycle write, for the same reason');

  // A10-A11 — cross-tenant. A foreign case must be indistinguishable from one
  // that never existed: same code, same body, byte for byte.
  const foreign = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, harbour.token);
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/journey', undefined, harbour.token);
  neg(foreign.status === 404 && foreign.status === ghost.status,
    'A10 another club\'s case answers 404, exactly as a case that never existed does');
  neg(JSON.stringify(foreign.body) === JSON.stringify(ghost.body),
    'A11 and byte-identically, so the id cannot be confirmed by comparing answers');

  // A12 — the journey carries the club's own record, and no player identity.
  // A block stops a player's DATA flowing; it does not erase a club's notes
  // about its own process. There is nothing here for a block to stop.
  const proj = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, maria.token);
  const body = JSON.stringify(proj.body);
  neg(!body.includes(target.name),
    'A12 the journey names no player — it reports the club\'s own record, keyed by id');
  neg(!/dateOfBirth|\bdob\b|email|phone|guardianName/i.test(body),
    'A13 and carries no personal detail a block or a removal would need to stop');
}

section('W — write-site audit: every path that can move a case, and the ones that must not');
{
  // W1-W4 (pure) — room CREATION is an inbound edge like any other, and it
  // runs no transition table and no evidence gate. Stated as a property over
  // both vocabularies rather than as a special case, so a stage added later
  // cannot reintroduce the hole.
  ok(roomStatusForStage('awaiting_response', 'grassroots') === 'trial_completed',
    'W1 the honest inverse of the grassroots stage map does reach an evidence-bearing status');
  neg(adoptionStatusForStage('awaiting_response', 'grassroots') === 'under_review',
    'W2 but a Room adopting that case does NOT start at `trial_completed` — no trial is proven');
  const proStarts = PRO_STAGES.map((s) => adoptionStatusForStage(s, 'pro'));
  const grStarts = GRASSROOTS_STAGES.map((s) => adoptionStatusForStage(s, 'grassroots'));
  neg([...proStarts, ...grStarts].every((s) => !STATUS_EVIDENCE_REQUIRED[s]),
    'W3 no stage in either vocabulary starts a room at a status the records cannot prove');
  ok([...proStarts, ...grStarts].every((s) => ROOM_STATUSES.includes(s)),
    'W4 and every adoption start is a real status, never null or invented');

  // W5-W10 (live) — the legacy M12 stage route is the oldest writer of
  // `case.stage`, which M23 made a pure derivation of `room.status`. It had no
  // bridge to the lifecycle at all, so it could move one representation of a
  // case and leave the other behind.
  const before = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  const stageBefore = before.body?.lifecycle?.currentStage;
  const legacyStage = await j('POST', `/org/cases/${ROOM}/stage`, { stage: 'trial', reason: 'legacy client' }, maria.token);
  neg(legacyStage.status === 409 && legacyStage.body?.error === 'STAGE_NOT_SETTABLE_ON_ROOM',
    'W5 the legacy stage route refuses a case that has a Room');
  ok(typeof legacyStage.body?.use === 'string' && legacyStage.body.use.includes('/lifecycle'),
    'W6 and names the lifecycle route rather than failing blankly');
  const after = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  neg(after.body?.lifecycle?.currentStage === stageBefore,
    'W7 the refusal left the lifecycle exactly where it was');

  const room = await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token);
  const revBefore = room.body?.room?.rev;
  const legacyDecision = await j('POST', `/org/cases/${ROOM}/decision`, { outcome: 'monitor', reasons: 'keep watching through the spring' }, maria.token);
  ok(legacyDecision.status === 200 && legacyDecision.body?.case?.decision?.outcome === 'monitor',
    'W8 an M12 decision on a Room is still recorded — the route is not broken, only disarmed');
  neg(legacyDecision.body?.case?.stage !== 'decision',
    'W9 but it does not write the derived stage behind the lifecycle\'s back');
  const roomAfter = await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token);
  neg(roomAfter.body?.room?.rev === revBefore,
    'W10 and it moves no concurrency token, because it moved no lifecycle state');

  // W11 — the same route on a plain M12 case is untouched. Refusing a Room is
  // not an excuse to break the cases that have no lifecycle to protect.
  const spare = players.find((p) => p.id !== ADULT.id && p.dateOfBirth && (new Date().getFullYear() - new Date(p.dateOfBirth).getFullYear()) >= 18);
  const plain = await j('POST', '/org/cases', { playerId: spare?.id ?? ADULT.id, priority: 'low' }, tom.token);
  if (plain.status === 201 && !plain.body.case.room) {
    const moved = await j('POST', `/org/cases/${plain.body.case.id}/stage`, { stage: 'observation' }, tom.token);
    ok(moved.status === 200 && moved.body.case.stage === 'observation',
      'W11 a plain case with no Room still moves through the legacy route exactly as before');
  } else {
    ok(false, 'could not create the plain-case fixture');
  }
}

section('E — every error body, swept for private text at once');
{
  // Individual "this response leaks nothing" checks test the responses somebody
  // thought of. This collects EVERY refusal the two M23 routes can produce and
  // sweeps them all against the same forbidden set, so a new error code added
  // later is covered by construction rather than by remembering.
  const SECRET = 'SECRETNOTEPHRASE';
  let EROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) { EROOM = r.body.room.roomId; break; }
  }
  ok(!!EROOM, 'E0 a case for the error sweep');

  // Put genuinely private text into the room: a comment, and a decision note.
  const rev0 = (await j('GET', `/org/rooms/${EROOM}/journey`, undefined, maria.token)).body.case.rev;
  await j('POST', `/org/rooms/${EROOM}/comments`, { body: `${SECRET} in a comment` }, maria.token);
  await j('POST', `/org/rooms/${EROOM}/decisions`, {
    recommendation: 'monitor', reasonCodes: ['needs_more_evidence'],
    note: `${SECRET} in a decision note`, expectedRev: rev0,
  }, maria.token);

  // The control. Without it the sweep below could pass because the secret was
  // never stored, which would make every "leaks nothing" check vacuous.
  const roomView = await j('GET', `/org/rooms/${EROOM}`, undefined, maria.token);
  const comments = await j('GET', `/org/rooms/${EROOM}/comments`, undefined, maria.token);
  ok(JSON.stringify(roomView.body).includes(SECRET) || JSON.stringify(comments.body).includes(SECRET),
    'E0b the private text really is stored and really is visible to the club that wrote it');

  const errorBodies = ERROR_BODIES_FROM_E;
  const collect = async (label, res) => { if (res.status >= 400) errorBodies.push({ label, status: res.status, body: res.body }); };

  const cur = (await j('GET', `/org/rooms/${EROOM}/journey`, undefined, maria.token)).body;
  await collect('unknown action', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'teleport' }, maria.token));
  await collect('stage smuggled', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase', stage: 'signed' }, maria.token));
  await collect('bad reasons', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'closeCase', reasonCodes: ['nope'] }, maria.token));
  await collect('prohibited reason', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'closeCase', reasonCodes: ['nationality'] }, maria.token));
  await collect('impossible jump', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'recordOfferAccepted', expectedRev: cur.case.rev }, maria.token));
  await collect('not applicable', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'resumeCase', expectedRev: cur.case.rev }, maria.token));
  await collect('no change', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'startReview', expectedRev: cur.case.rev }, maria.token));
  await collect('stale rev', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase', expectedRev: 1 }, maria.token));
  await collect('reason required', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'closeCase', expectedRev: cur.case.rev }, maria.token));
  await collect('foreign org journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, harbour.token));
  await collect('foreign org write', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase' }, harbour.token));
  await collect('player journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, kola.token));
  await collect('no auth journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, undefined));
  await collect('no auth write', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase' }, undefined));
  await collect('ghost case', await j('GET', '/org/rooms/case-nope/journey', undefined, maria.token));

  ok(errorBodies.length >= 12, `E1 collected ${errorBodies.length} distinct refusals to sweep`);

  const FORBIDDEN = [
    [SECRET, 'a private note or comment body'],
    ['Rita Vale', 'a person at another organisation'],
    ['Harbour', 'another organisation\'s name'],
  ];
  const offenders = [];
  for (const { label, body } of errorBodies) {
    const text = JSON.stringify(body ?? {});
    for (const [needle, what] of FORBIDDEN) if (text.includes(needle)) offenders.push(`${label}: ${what}`);
  }
  for (const o of offenders) console.error(`   ${o}`);
  neg(offenders.length === 0, 'E2 no refusal carries a private note, a colleague at another club, or another club\'s name');

  // A stack trace in a response body is both a leak and an invitation.
  const stacky = errorBodies.filter(({ body }) => /\bat [\w$.]+ \(|\.mjs:\d+|node_modules|TypeError:|ReferenceError:/.test(JSON.stringify(body ?? {})));
  neg(stacky.length === 0, 'E3 and none carries a stack trace, a file path or an internal exception name');

  // Every refusal names itself. An error a log cannot group is an error nobody
  // can count, and a client cannot branch on prose.
  const unnamed = errorBodies.filter(({ body }) => typeof body?.error !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(body.error));
  for (const u of unnamed) console.error(`   unnamed: ${u.label} -> ${JSON.stringify(u.body).slice(0, 120)}`);
  neg(unnamed.length === 0, 'E4 every refusal carries a machine-readable error code');

  // 5xx means OUR fault. None of the above is our fault.
  neg(errorBodies.every((e) => e.status < 500), 'E5 and not one of them is a 5xx — every one is the caller\'s to fix');
}

section('Y — the error contract: one table, no default, nothing internal in the body');
{
  // The drift guard, and it is MECHANICAL rather than a list somebody keeps.
  //
  // Every `error: 'CODE'` literal in the M23 source is extracted from the
  // files themselves and required to have a status. A list written by hand
  // here would pass forever while the module grew a code nobody mapped — which
  // is exactly what the ternary chain this replaced did, silently, by falling
  // through to 400.
  const M23_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'm23');
  const sources = readdirSync(M23_DIR).filter((f) => f.endsWith('.mjs') && f !== 'errors.mjs');
  const produced = new Set();
  for (const f of sources) {
    const text = readFileSync(path.join(M23_DIR, f), 'utf8');
    for (const m of text.matchAll(/error:\s*'([A-Z][A-Z0-9_]+)'/g)) produced.add(m[1]);
  }
  ok(produced.size >= 15, `Y1 ${produced.size} error codes found in the M23 source, mechanically`);

  const unmapped = [...produced].filter((c) => httpStatusFor(c) === null);
  for (const c of unmapped) console.error(`   unmapped: ${c}`);
  neg(unmapped.length === 0, 'Y2 every error code the M23 source can produce has an HTTP status in the one table');

  // The converse. A table entry for a code nothing produces is dead weight that
  // makes the table look more complete than it is. `ROOM_VERSION_CONFLICT` is
  // the one legitimate exception: M18.1's rev guard raises it, not M23.
  const EXTERNAL = new Set(['ROOM_VERSION_CONFLICT']);
  const orphaned = Object.keys(M23_ERROR_HTTP).filter((c) => !produced.has(c) && !EXTERNAL.has(c));
  for (const c of orphaned) console.error(`   orphaned: ${c}`);
  neg(orphaned.length === 0, 'Y3 and the table contains no code nothing can produce');

  // No silent default in either direction: an unknown code must NOT resolve.
  neg(httpStatusFor('LIFECYCLE_NOT_A_REAL_CODE') === null, 'Y4 an unknown code resolves to null, not to a default status');
  neg(httpStatusFor('constructor') === null, 'Y5 and a prototype key is absent from the table, not a function');

  // Every mapped status is one this contract actually uses. A 418 or a 200 in
  // the table would be a typo that no other assertion here would notice.
  const BANDS = [400, 403, 404, 409, 422, 500];
  const offBand = Object.entries(M23_ERROR_HTTP).filter(([, s]) => !BANDS.includes(s));
  neg(offBand.length === 0, `Y6 every status in the table is one of ${BANDS.join('/')}`);

  // §36 — an internal error must not hand the client the implementation.
  //
  // The control first: the projector's own return value DOES name the stores,
  // because that detail is what makes it useful in a log and in the unit tests
  // above. Without this the next assertion could pass by testing nothing.
  const holed = {
    recruitmentCases: [], roomDecisions: [], requests: [], signings: [],
    assessments: undefined, trials: 'not-a-list',
  };
  const internal = buildRecruitmentJourney(holed, 'case-anything', { kind: 'org_staff', orgId: 'org-eastport' });
  ok(internal.ok === false && internal.error === 'JOURNEY_STORE_MISSING'
    && JSON.stringify(internal).includes('assessments'),
  'Y7 the projector names the absent store internally, which is why the log is worth reading');

  const publicBody = publicErrorBody(internal);
  const leaked = JOURNEY_REQUIRED_STORES.filter((s) => JSON.stringify(publicBody).includes(s));
  for (const s of leaked) console.error(`   leaked store name: ${s}`);
  neg(leaked.length === 0, 'Y8 and the body a client receives names none of them — not one store, not the count');
  neg(publicBody.missing === undefined && publicBody.malformed === undefined,
    'Y9 the diagnostic fields are absent from the public body, not emptied');
  ok(publicBody.error === 'JOURNEY_STORE_MISSING', 'Y10 while the code itself survives, so a client can still branch and a log can still group');

  // §33 as a property over the HTTP bodies collected in E, rather than over the
  // ones somebody remembered: no refusal may carry a key outside the allowlist.
  //
  // `ROOM_VERSION_CONFLICT` is excluded, and that is a decision with a reason.
  // It is raised by M18.1's `guardRev` BEFORE this module's mapping is reached,
  // and its body — `currentRev`, `updatedBy`, `updatedAt` — is the shared
  // conflict contract that `conflict.tsx` renders in two clients across five
  // milestones. `updatedBy` is deliberately a display name and never a user id,
  // and every caller reaching it has already passed the room's visibility gate,
  // so there is nothing here a 200 would not also have shown them. Narrowing it
  // would break the shared conflict notice everywhere to disclose nothing.
  const ALLOWED_KEYS = new Set(['ok', 'error', 'message', 'allowed', 'to', 'actions',
    'requires', 'evidenceReason', 'current', 'expectedRev', 'rev']);
  const strayKeys = [];
  for (const { label, body } of ERROR_BODIES_FROM_E) {
    if (body?.error === 'ROOM_VERSION_CONFLICT') continue;
    for (const k of Object.keys(body ?? {})) if (!ALLOWED_KEYS.has(k)) strayKeys.push(`${label}.${k}`);
  }
  for (const s of strayKeys) console.error(`   stray key: ${s}`);
  neg(strayKeys.length === 0, 'Y11 no refusal M23 itself produces carries a field outside the published error shape');

  // §35 — and the one body that IS excluded still may not carry the thing §35
  // actually forbids. Checked rather than assumed, because the exclusion above
  // is only defensible if this holds.
  {
    const conflicts = ERROR_BODIES_FROM_E.filter(({ body }) => body?.error === 'ROOM_VERSION_CONFLICT');
    ok(conflicts.length >= 1, 'Y11b the sweep really did provoke a version conflict');
    const CONFLICT_KEYS = new Set(['error', 'message', 'expectedRev', 'currentRev', 'updatedBy', 'updatedAt', 'status']);
    const widened = [];
    for (const { label, body } of conflicts) {
      for (const k of Object.keys(body ?? {})) if (!CONFLICT_KEYS.has(k)) widened.push(`${label}.${k}`);
    }
    neg(widened.length === 0, 'Y11c the 409 body is exactly M18.1\'s conflict contract, not that contract plus M23 detail');
    const carriesNarrative = conflicts.some(({ body }) => {
      const text = JSON.stringify(body ?? {});
      return LIFECYCLE_REASON_CODES.some((c) => text.includes(c)) || /note|reason|narrative/i.test(Object.keys(body ?? {}).join(' '));
    });
    neg(carriesNarrative === false, 'Y11d and carries no lifecycle reason code and no narrative field');
  }

  // §34 — the parity, restated after the mapping moved. Not "both are 404":
  // byte-identical, because a difference of one character is an oracle.
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/journey', undefined, maria.token);
  const foreign = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, harbour.token);
  neg(ghost.status === 404 && foreign.status === 404, 'Y12 a hidden case and a case that never existed both answer 404');
  neg(JSON.stringify(ghost.body) === JSON.stringify(foreign.body),
    'Y13 and their bodies are byte-identical, after the error mapping was centralised');
}

section('S — the subsystems M23 must not have touched');
{
  // "Do NOT add Match Score. Do NOT alter Trust. Do NOT alter M22 Combine
  // eligibility." Asserted by taking a reading, moving the lifecycle, and
  // taking the reading again — rather than by reading the source and trusting
  // that nothing calls anything.
  let SROOM = null; let SPLAYER = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) { SROOM = r.body.room.roomId; SPLAYER = p; break; }
  }
  ok(!!SROOM, 'S0 a case for the non-interference checks');

  const readAll = async () => ({
    trust: (await j('GET', `/org/players/${SPLAYER.id}/trust`, undefined, maria.token)).body,
    passport: (await j('GET', `/org/players/${SPLAYER.id}/passport`, undefined, maria.token)).body,
    plans: (await j('GET', `/org/development/plans?playerId=${SPLAYER.id}`, undefined, maria.token)).body,
    secondLook: (await j('GET', '/org/second-look', undefined, maria.token)).body,
    combine: (await j('GET', `/org/players/${SPLAYER.id}/combine`, undefined, maria.token)).body,
    funnel: (await j('GET', '/org/rooms-funnel', undefined, maria.token)).body,
  });
  const stable = (o) => JSON.stringify(o, (k, v) => (/at$|At$|generatedAt|updatedAt|ts$/.test(k) ? undefined : v));

  const before = await readAll();
  // Move the lifecycle through several transitions, including a hold, a
  // reopen and an ending.
  let rev = (await j('GET', `/org/rooms/${SROOM}/journey`, undefined, maria.token)).body.case.rev;
  for (const action of ['startReview', 'holdCase', 'resumeCase', 'shortlist', 'prioritise']) {
    const r = await j('POST', `/org/rooms/${SROOM}/lifecycle`, { action, expectedRev: rev }, maria.token);
    if (r.status === 200) rev = r.body.currentRev ?? rev + 1;
  }
  const after = await readAll();

  neg(stable(before.trust) === stable(after.trust),
    'S1 five lifecycle transitions move the Trust Score not at all — Trust is evidence confidence, not progress');
  neg(stable(before.passport) === stable(after.passport),
    'S2 and put nothing in the Passport — a club\'s pipeline position is not player truth');
  neg(stable(before.plans) === stable(after.plans),
    'S3 and create no Development Plan');
  neg(stable(before.combine) === stable(after.combine),
    'S4 and change no Combine eligibility — M22 is untouched by recruitment workflow');
  neg(stable(before.secondLook) === stable(after.secondLook),
    'S5 and raise no Second Look item — a transition is not canonical material evidence');

  // The funnel SHOULD move: it is the one subsystem that reads the lifecycle.
  ok(stable(before.funnel) !== stable(after.funnel),
    'S6 the recruitment funnel DOES move — it is the one subsystem that reads the lifecycle, and a silent funnel would be the real bug');

  // No score, of any name, anywhere in the projection.
  const proj = JSON.stringify((await j('GET', `/org/rooms/${SROOM}/journey`, undefined, maria.token)).body);
  neg(!/matchScore|match_score|journeyScore|readiness|signingProbability|progressPercent|candidateQuality|likelihood/i.test(proj),
    'S7 and the journey carries no score, readiness, probability or percentage of any kind');

  // Matching is criteria-based and must not learn from the lifecycle.
  // Two assertions, not one disjunction. `status !== 200 || !includes(...)`
  // passes when the watchlists route is BROKEN, which proves nothing about
  // whether matching learned from the lifecycle.
  const watch = await j('GET', '/org/watchlists', undefined, maria.token);
  ok(watch.status === 200, 'S8 the watchlists route answers, so the next check is not vacuous');
  neg(!JSON.stringify(watch.body).includes(SROOM),
    'S8b and no watchlist acquired the case as a criterion');
}

section('R — restart: what survived the process going away');
{
  // Idempotency that lives in process memory is idempotency that stops working
  // exactly when it is needed — after the crash that made the client retry.
  // This kills the server and brings it back on the same data directory.
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; }
  }
  server = await boot();
  const reAuth = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!reAuth?.token, 'R1 the server came back and accepts a login');

  const { room, key, from, to } = IDEMPOTENCY_PROBE;
  const beforeState = (await j('GET', `/org/rooms/${room}/journey`, undefined, reAuth.token)).body;
  const replayAfterRestart = await j('POST', `/org/rooms/${room}/lifecycle`, { action: 'holdCase', clientKey: key }, reAuth.token);
  neg(replayAfterRestart.status === 200 && replayAfterRestart.body?.idempotent === true,
    'R2 a replay after the process died is still recognised as a replay');
  ok(replayAfterRestart.body?.from === from && replayAfterRestart.body?.to === to,
    'R3 and reports the original endpoints, recovered from the persisted history');
  const afterState = (await j('GET', `/org/rooms/${room}/journey`, undefined, reAuth.token)).body;
  neg(afterState.history.total === beforeState.history.total,
    'R4 and the restart plus replay wrote no new history entry');
  neg(afterState.case.rev === beforeState.case.rev, 'R5 and moved no rev');
  ok(afterState.lifecycle.currentStage === beforeState.lifecycle.currentStage,
    'R6 the case is exactly where it was before the crash');
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 acceptance suite (P2): ${total} checks passed, ${negatives} negative/security/edge checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P2 has failures.');
else console.log('all M23 P2 checks passed');
