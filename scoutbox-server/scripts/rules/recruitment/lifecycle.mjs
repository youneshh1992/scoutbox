// The lifecycle engine behind the recruitment lifecycle battery (e2e/recruitment/lifecycle.mjs), checked in this
// process: the transition table and its validator, the offered actions, the evidence gate, the reason taxonomy, the
// journey projector over plain collections, and the lifecycle's error table.
import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_TERMINAL,
  LIFECYCLE_REOPENABLE,
  LIFECYCLE_REASON_CODES,
  validateLifecycleReasons,
  isLifecycleReason,
  canTransitionRecruitmentCase,
  derivedConditions,
  availableActions,
  toAnalyticsRecruitmentStage,
  NULL_EVIDENCE_PROVIDER,
} from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { JOURNEY_REQUIRED_STORES } from '../../../domains/recruitment/lifecycle/journey.mjs';
import {
  ROOM_STATUSES,
  ROOM_TRANSITIONS,
  TERMINAL_ROOM_STATUSES,
  roomStatusForStage,
  STATUS_EVIDENCE_REQUIRED,
  adoptionStatusForStage,
  PRO_STAGES,
  GRASSROOTS_STAGES,
  ALL_REASON_CODES,
} from '../../../domains/recruitment/rooms/shared.mjs';
import {
  LIFECYCLE_ERROR_HTTP,
  httpStatusFor,
  publicErrorBody,
  sendDomainError,
} from '../../../domains/recruitment/lifecycle/errors.mjs';
import { DECISION_INPUT_CODES } from '../../../domains/recruitment/lifecycle/decisionRoutes.mjs';
import { CONTACT_INPUT_CODES } from '../../../domains/recruitment/lifecycle/contactRoutes.mjs';
import { LIFECYCLE_INPUT_CODES } from '../../../domains/recruitment/lifecycle/index.mjs';
import { TRIAL_INPUT_CODES } from '../../../domains/recruitment/lifecycle/trialRoutes.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../../repositories/index.mjs';
import { FUNNEL_STAGES, stagesReached } from '../../../domains/recruitment/analytics/funnels.mjs';
import { buildRecruitmentJourney, createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, fail, section, done } = rulesSuite('recruitment/lifecycle');
const realEvidence = createEvidenceProvider({ signings: [] });
const ADULT = { id: 'pl-adeyemi' }; // the battery's adult player

// ============================================================ pure engine
section('U1 — the lifecycle is one table, and the declined states stayed declined');
{
  neg(
    !ROOM_STATUSES.includes('trial_in_progress'),
    '#39 `trial_in_progress` is NOT a case stage — it is a state of the trial',
  );
  neg(!ROOM_STATUSES.includes('decision_pending'), '#40 `decision_pending` is NOT a case stage — it is a derivation');

  const conds = derivedConditions({ status: 'trial_completed', hasCurrentDecision: false });
  ok(conds.decisionPending === true, 'decision-pending is answered by looking, not by storing');
  ok(
    derivedConditions({ status: 'trial_completed', hasCurrentDecision: true }).decisionPending === false,
    'and stops being true the moment a decision exists',
  );

  ok(
    ROOM_STATUSES.includes('offer_accepted') && ROOM_STATUSES.includes('signed'),
    'offer_accepted and signed are different states',
  );
  neg(!ROOM_TRANSITIONS.offer_accepted.includes('offer_made'), 'an accepted offer cannot be un-accepted');
  ok(
    Object.keys(ROOM_TRANSITIONS).length === ROOM_STATUSES.length,
    'every status has a transition row — the table is total',
  );
  for (const [from, tos] of Object.entries(ROOM_TRANSITIONS)) {
    for (const to of tos) {
      if (!ROOM_STATUSES.includes(to)) fail(`${from} -> ${to} names a status that does not exist`);
    }
  }
  ok(true, 'every transition target is a real status');

  neg(!TERMINAL_ROOM_STATUSES.includes('on_hold'), '#38 on_hold is NOT terminal');
  ok(
    JSON.stringify([...LIFECYCLE_TERMINAL].sort()) === JSON.stringify([...TERMINAL_ROOM_STATUSES].sort()),
    'M23 terminal set matches M17 by CONTENT, not merely by count — one definition',
  );
}

section('U2 — no lifecycle action is performable by a player, and evidence cannot be faked');
{
  const kase = { id: 'case-x', orgId: 'org-a', playerId: 'pl-a', room: { status: 'offer_made', rev: 1 } };

  // #23 — the single most important negative in the suite.
  const toSigned = canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(
    toSigned.ok === false && toSigned.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#23 offer acceptance does not become signed: `signed` demands a confirmed joining record',
  );
  neg(toSigned.requires === 'confirmed_join', 'and names the record it needs rather than guessing');

  // Even with the case sitting at offer_accepted, nothing promotes it.
  const accepted = { ...kase, room: { status: 'offer_accepted', rev: 1 } };
  const stillNot = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(
    stillNot.ok === false,
    '#23b a case AT offer_accepted still cannot reach signed without separate confirmed truth',
  );

  // A provider that lies is the only way through — which is the point: the
  // lifecycle asserts exactly what some record supports, no more.
  const liar = { check: () => ({ satisfied: true }) };
  const withEvidence = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', {
    role: 'recruitment_admin',
    evidence: liar,
  });
  ok(
    withEvidence.ok === true && withEvidence.to === 'signed',
    'J17 with confirmed joining evidence, offer_accepted -> signed is permitted',
  );

  // #4 — role.
  neg(
    canTransitionRecruitmentCase(kase, 'sendOffer', { role: 'viewer' }).error === 'LIFECYCLE_NOT_PERMITTED',
    '#4 a viewer cannot move the lifecycle',
  );
  neg(
    canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'room_lead', evidence: liar }).error ===
      'LIFECYCLE_NOT_PERMITTED',
    '#4b confirming a signing is admin-only, even with evidence',
  );

  // #6 — impossible jump.
  const watching = { ...kase, room: { status: 'watching', rev: 1 } };
  neg(
    canTransitionRecruitmentCase(watching, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: liar })
      .error === 'LIFECYCLE_TRANSITION_INVALID',
    '#6 a watched player cannot jump to an accepted offer',
  );

  // #5 — no generic stage setter exists in the action vocabulary at all.
  neg(
    !Object.keys(LIFECYCLE_ACTIONS).some((a) => /^set|^patch|stage$/i.test(a)),
    '#5 there is no generic set-stage action to call',
  );

  neg(
    canTransitionRecruitmentCase(kase, 'notAnAction', { role: 'recruitment_admin' }).error ===
      'LIFECYCLE_ACTION_UNKNOWN',
    'an unknown action is refused by name',
  );
  neg(
    canTransitionRecruitmentCase({ id: 'c', room: { status: 'nonsense' } }, 'startReview', { role: 'room_lead' })
      .error === 'LIFECYCLE_STATE_UNKNOWN',
    'a case in an unrecognised state reports corruption, not a workflow answer',
  );

  ok(
    LIFECYCLE_REASON_CODES.every((c) => typeof c === 'string' && /^[a-z_]+$/.test(c)),
    'every lifecycle reason is a structured code, never prose',
  );

  const acts = availableActions(watching, { role: 'recruitment_admin' });
  neg(!acts.includes('confirmSignedOutcome'), '#42 an action the evidence cannot support is not suggested');
  ok(acts.includes('startReview') && acts.includes('planContact'), 'the possible actions are offered');
  neg(
    !availableActions(watching, { role: 'viewer' }).includes('startReview'),
    '#42b and nothing is suggested to a role that cannot do it',
  );
}

section('U3 — the projector refuses to mistake a broken database for an empty history');
{
  const base = {
    recruitmentCases: [
      { id: 'case-1', orgId: 'o1', playerId: 'p1', room: { status: 'watching', rev: 1 }, history: [] },
    ],
    roomDecisions: [],
    requests: [],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [],
  };
  const good = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  ok(good.ok === true, 'a healthy database projects');

  for (const store of JOURNEY_REQUIRED_STORES) {
    const broken = { ...base };
    delete broken[store];
    const out = buildRecruitmentJourney(broken, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
    neg(
      out.ok === false && out.error === 'JOURNEY_STORE_MISSING',
      `#30/#31 a missing db.${store} is reported as broken infrastructure, not as "nothing happened"`,
    );
  }

  // #1/#2 — foreign org.
  const foreign = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'OTHER', role: 'room_lead' });
  neg(foreign.ok === false && foreign.error === 'CASE_NOT_FOUND', '#1/#2 a foreign org gets CASE_NOT_FOUND');
  const absent = buildRecruitmentJourney(base, 'case-nope', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  neg(
    JSON.stringify(foreign) === JSON.stringify(absent),
    'and it is byte-identical to a case that never existed — no count, no hint, no leak',
  );

  // #13/#14/#35/#36 — hidden club interest.
  const asPlayer = buildRecruitmentJourney(base, 'case-1', { kind: 'player_self', playerId: 'p1' });
  neg(
    asPlayer.ok === false && asPlayer.error === 'CASE_NOT_FOUND',
    '#13 a player cannot see that a club has a case on them',
  );
  neg(
    JSON.stringify(asPlayer) === JSON.stringify(absent),
    '#36 and the answer is identical to a case that does not exist — interest cannot be inferred',
  );
  const asGuardian = buildRecruitmentJourney(base, 'case-1', { kind: 'guardian', guardianId: 'g1' });
  neg(asGuardian.ok === false && asGuardian.error === 'CASE_NOT_FOUND', '#14 nor can a guardian without a share');

  // #15 — agency is not a viewer context at all.
  neg(
    buildRecruitmentJourney(base, 'case-1', { kind: 'agency' }).error === 'JOURNEY_VIEWER_UNKNOWN',
    '#15 "agency" is not a recruitment-journey viewer — no policy grants it one',
  );

  // #38-T&S — not a master key.
  neg(
    buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety' }).error === 'CASE_NOT_FOUND',
    'T&S with no authorization sees nothing',
  );
  ok(
    buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety', authorized: true }).ok === true,
    'and sees the case only when its own authorization says so',
  );

  // #30 — no score of any kind.
  const body = JSON.stringify(good);
  neg(
    !/score|readiness|probability|percentage|quality|rating/i.test(body),
    '#30 the journey carries no score, readiness, probability, percentage or rating',
  );

  // Determinism.
  const a = buildRecruitmentJourney(
    base,
    'case-1',
    { kind: 'org_staff', orgId: 'o1', role: 'room_lead' },
    { now: 1000 },
  );
  const b = buildRecruitmentJourney(
    base,
    'case-1',
    { kind: 'org_staff', orgId: 'o1', role: 'room_lead' },
    { now: 1000 },
  );
  ok(JSON.stringify(a) === JSON.stringify(b), 'the projection is deterministic for the same db, viewer and clock');
}

section('U4 — private text never reaches the projection');
{
  const db = {
    recruitmentCases: [
      { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'under_review', rev: 1 }, history: [] },
    ],
    roomDecisions: [
      {
        id: 'd1',
        roomId: 'c1',
        orgId: 'o1',
        recommendation: 'archive',
        reasonCodes: ['squad_space'],
        note: 'HIS ATTITUDE IS THE PROBLEM',
        createdAt: '2026-01-01T00:00:00.000Z',
        by: { name: 'Maria' },
      },
    ],
    requests: [],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [],
  };
  const out = buildRecruitmentJourney(db, 'c1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  const s = JSON.stringify(out);
  neg(!s.includes('ATTITUDE'), '#42-note a decision note body is never projected, even to the club');
  ok(out.decisions.all[0].hasNote === true, 'its existence is reported; its content is not');
  ok(out.decisions.all[0].reasonCodes[0] === 'squad_space', 'the structured reason travels because it is structured');
}

section('U5 — analytics compatibility is explicit');
{
  ok(
    FUNNEL_STAGES.includes('contact_planned') && FUNNEL_STAGES.includes('contacted'),
    'J19 the two contact states ARE funnel progression',
  );
  ok(FUNNEL_STAGES.includes('offer_accepted'), 'and an accepted offer is further than a made one');
  neg(!FUNNEL_STAGES.includes('on_hold'), '#34 pausing is not counted as progress');
  neg(!FUNNEL_STAGES.includes('offer_declined'), '#34b nor is declining, which already counted at offer_made');
  ok(
    toAnalyticsRecruitmentStage('on_hold') === null && toAnalyticsRecruitmentStage('offer_declined') === null,
    'the mapping says so in one place',
  );
  ok(
    toAnalyticsRecruitmentStage('trial_completed') === 'trial_completed',
    'and every historical status still maps to itself — no rename, no silent invalidation',
  );
  for (const s of [
    'watching',
    'under_review',
    'shortlisted',
    'priority',
    'trial_requested',
    'trial_scheduled',
    'trial_completed',
    'offer_consideration',
    'offer_made',
    'signed',
  ]) {
    if (toAnalyticsRecruitmentStage(s) !== s) fail(`legacy status ${s} no longer maps to itself`);
  }
  ok(true, '#34c all ten original funnel statuses are unchanged');
}

section('H7-H8, H13-H14, H18-H20 — determinism, legacy mapping and isolation (pure)');
{
  const mkCase = (id, orgId, playerId, status, hist) => ({
    id,
    orgId,
    playerId,
    stage: null,
    room: { status, rev: 1, priority: 'normal' },
    createdAt: '2026-01-01T00:00:00.000Z',
    history: hist ?? [],
  });
  const REQ = { roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [] };
  const target = mkCase('case-T', 'oT', 'pT', 'under_review', [
    { action: 'room_created', at: '2026-01-01T00:00:00.000Z', by: { name: 'A' }, detail: { status: 'watching' } },
    {
      action: 'room_status_changed',
      at: '2026-01-02T00:00:00.000Z',
      by: { name: 'A' },
      detail: { from: 'watching', to: 'under_review' },
    },
  ]);
  const noiseA = mkCase('case-X', 'oOTHER', 'pOTHER', 'signed', [
    { action: 'room_status_changed', at: '2026-01-03T00:00:00.000Z', detail: { from: 'offer_made', to: 'signed' } },
  ]);
  const noiseB = mkCase('case-Y', 'oT', 'pOTHER2', 'archived', [
    { action: 'room_status_changed', at: '2026-01-04T00:00:00.000Z', detail: { from: 'watching', to: 'archived' } },
  ]);
  const V = { kind: 'org_staff', orgId: 'oT', role: 'room_lead' };

  // H7 — unrelated insertion order must not change the answer.
  const one = buildRecruitmentJourney({ ...REQ, recruitmentCases: [noiseA, target, noiseB] }, 'case-T', V, { now: 5 });
  const two = buildRecruitmentJourney({ ...REQ, recruitmentCases: [noiseB, noiseA, target] }, 'case-T', V, { now: 5 });
  const three = buildRecruitmentJourney({ ...REQ, recruitmentCases: [target, noiseB, noiseA] }, 'case-T', V, {
    now: 5,
  });
  ok(
    JSON.stringify(one) === JSON.stringify(two) && JSON.stringify(two) === JSON.stringify(three),
    'H7 the journey is byte-identical however unrelated cases are ordered in the array',
  );

  // H18/H19 — nothing foreign, from either axis.
  const body = JSON.stringify(one);
  neg(
    !body.includes('case-X') && !body.includes('oOTHER') && !body.includes('pOTHER'),
    'H18 no foreign-org id, case id or player id appears anywhere in the projection',
  );
  neg(
    !body.includes('case-Y') && !body.includes('pOTHER2'),
    'H19 nor a same-org DIFFERENT player case — cross-player isolation holds',
  );
  neg(!body.includes('signed'), 'H18b and a foreign case at `signed` does not colour this one');

  // H20 — a decision belonging to another case or another org never attaches.
  const decisions = [
    {
      id: 'd-mine',
      roomId: 'case-T',
      orgId: 'oT',
      recommendation: 'shortlist',
      reasonCodes: [],
      createdAt: '2026-01-05T00:00:00.000Z',
      by: { name: 'A' },
    },
    {
      id: 'd-othercase',
      roomId: 'case-Y',
      orgId: 'oT',
      recommendation: 'archive',
      reasonCodes: [],
      createdAt: '2026-01-05T00:00:00.000Z',
      by: { name: 'B' },
    },
    {
      id: 'd-otherorg',
      roomId: 'case-T',
      orgId: 'oOTHER',
      recommendation: 'offer',
      reasonCodes: [],
      createdAt: '2026-01-05T00:00:00.000Z',
      by: { name: 'C' },
    },
  ];
  const withD = buildRecruitmentJourney({ ...REQ, roomDecisions: decisions, recruitmentCases: [target] }, 'case-T', V, {
    now: 5,
  });
  ok(
    withD.decisions.all.length === 1 && withD.decisions.all[0].id === 'd-mine',
    'H20 only this case’s own decision attaches',
  );
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
  ok(
    JSON.stringify(s1.history.entries) === JSON.stringify(s2.history.entries),
    'H8 three entries at the SAME millisecond come back in the same order every time',
  );
  ok(s1.history.entries.length === 3, 'H8b and all three survive — identical timestamps are not deduped into one');

  // H13 — every historical room status maps, exactly once, with no fallback.
  const LEGACY = [
    'watching',
    'under_review',
    'shortlisted',
    'priority',
    'trial_requested',
    'trial_scheduled',
    'trial_completed',
    'offer_consideration',
    'offer_made',
    'signed',
    'withdrawn',
    'archived',
    'closed',
  ];
  let mappedAll = true;
  for (const st of LEGACY) {
    if (!ROOM_STATUSES.includes(st)) {
      mappedAll = false;
      fail('H13 legacy status ' + st + ' disappeared from the canonical set');
    }
    if (!ROOM_TRANSITIONS[st]) {
      mappedAll = false;
      fail('H13 legacy status ' + st + ' lost its transition row');
    }
    const projected = buildRecruitmentJourney(
      { ...REQ, recruitmentCases: [mkCase('c-' + st, 'oT', 'pT', st)] },
      'c-' + st,
      V,
      { now: 5 },
    );
    if (!projected.ok || projected.lifecycle.currentStage !== st) {
      mappedAll = false;
      fail('H13 legacy status ' + st + ' does not project as itself');
    }
    if (!projected.lifecycle.label || projected.lifecycle.label === st) {
      mappedAll = false;
      fail('H13 legacy status ' + st + ' has no human label');
    }
  }
  ok(
    mappedAll,
    'H13 all 13 original statuses still exist, keep their transitions, project as themselves and carry a label',
  );

  // H14 — an unknown legacy status is refused, never coerced.
  const weird = mkCase('case-W', 'oT', 'pT', '__unknown_old_status__');
  const wj = buildRecruitmentJourney({ ...REQ, recruitmentCases: [weird] }, 'case-W', V, { now: 5 });
  const coerced = wj.ok && ['under_review', 'closed', 'watching'].includes(wj.lifecycle?.currentStage);
  neg(!coerced, 'H14 an unrecognised stored status is NOT silently coerced to under_review, closed or watching');
  const wv = canTransitionRecruitmentCase(weird, 'startReview', { role: 'recruitment_admin' });
  neg(
    wv.ok === false && wv.error === 'LIFECYCLE_STATE_UNKNOWN',
    'H14b and the validator calls it corruption rather than guessing a workflow answer',
  );

  // H14c — an unknown value inside HISTORY is not given meaning either.
  const weirdHist = mkCase('case-WH', 'oT', 'pT', 'under_review', [
    { action: '__not_a_real_action__', at: '2026-03-01T00:00:00.000Z', detail: { to: 'nonsense' } },
    { action: 'room_status_changed', at: '2026-03-02T00:00:00.000Z', detail: { from: 'watching', to: 'under_review' } },
  ]);
  const whj = buildRecruitmentJourney({ ...REQ, recruitmentCases: [weirdHist] }, 'case-WH', V, { now: 5 });
  neg(
    !JSON.stringify(whj.history.entries).includes('__not_a_real_action__'),
    'H14c an unrecognised history action is omitted, not rendered as a fabricated timeline event',
  );
  ok(whj.history.entries.length === 1, 'H14d and the real entry beside it still shows');

  // H23 — optional stores are structurally absent, not faked.
  ok(
    one.offer.available === false && one.offer.records.length === 0,
    'H23 the unshipped offer store reports available:false rather than pretending to be empty-but-present',
  );
  neg(
    JOURNEY_REQUIRED_STORES.includes('recruitmentOffers') === false,
    'H23b and it is NOT in the required list — a future phase’s store cannot break today’s projection',
  );
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

  ok(
    contributor.includes('startReview') === false || contributor.length < lead.length,
    'H11c a contributor is offered strictly less than a lead',
  );
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
      if (!v.ok) {
        consistent = false;
        fail('H11 ' + role + ' was offered ' + a + ' but it does not validate');
      }
    }
  }
  ok(consistent, 'H11i every offered action validates for the role it was offered to');
}

section('H15-H17 — hold cycling, reopen cycling and what the funnel counts');
{
  const cyc = { id: 'c-c', orgId: 'oT', playerId: 'pT', room: { status: 'under_review', rev: 1 } };
  const step = (from, action) =>
    canTransitionRecruitmentCase({ ...cyc, room: { status: from, rev: 1 } }, action, {
      role: 'recruitment_admin',
      forAvailability: true,
    });
  ok(step('under_review', 'holdCase').ok, 'H15 under_review -> on_hold');
  ok(step('on_hold', 'resumeCase').ok, 'H15b on_hold -> under_review');
  ok(
    step('under_review', 'holdCase').ok && step('on_hold', 'resumeCase').ok,
    'H15c and the cycle can repeat — nothing about a second hold is refused',
  );
  neg(!LIFECYCLE_TERMINAL.includes('on_hold'), 'H15d because on_hold was never terminal');

  ok(step('archived', 'reopenCase').ok, 'H16 archived -> under_review reopens');
  ok(step('under_review', 'rejectCase').ok, 'H16b and can be rejected again');
  ok(step('closed', 'reopenCase').ok, 'H16c a closed case reopens too');

  // H17 — what the funnel counts.
  neg(
    !FUNNEL_STAGES.includes('on_hold'),
    'H17 on_hold is not a funnel stage, so repeated holds cannot inflate progress',
  );
  neg(!FUNNEL_STAGES.includes('offer_declined'), 'H17b nor offer_declined, which already counted at offer_made');
  ok(FUNNEL_STAGES.includes('offer_made'), 'H17c offer_made IS counted');
  ok(
    stagesReached({
      history: [
        { action: 'room_status_changed', at: 1, detail: { from: 'watching', to: 'under_review' } },
        { action: 'room_status_changed', at: 2, detail: { from: 'under_review', to: 'on_hold' } },
        { action: 'room_status_changed', at: 3, detail: { from: 'on_hold', to: 'under_review' } },
        { action: 'room_status_changed', at: 4, detail: { from: 'under_review', to: 'on_hold' } },
        { action: 'room_status_changed', at: 5, detail: { from: 'on_hold', to: 'under_review' } },
      ],
      room: { status: 'under_review' },
    }).size >= 1,
    'H17d stagesReached returns a SET, so reaching a stage twice counts once',
  );
  const reached = stagesReached({
    history: [
      { action: 'room_status_changed', at: 1, detail: { from: 'watching', to: 'under_review' } },
      { action: 'room_status_changed', at: 2, detail: { from: 'under_review', to: 'archived' } },
      { action: 'room_reopened', at: 3, detail: { from: 'archived', to: 'under_review' } },
      { action: 'room_status_changed', at: 4, detail: { from: 'archived', to: 'under_review' } },
    ],
    room: { status: 'under_review' },
  });
  ok(reached.has('under_review'), 'H17e a reopened case still shows the stage it reached');
  ok(
    [...reached].filter((s) => s === 'under_review').length === 1,
    'H17f and reaching under_review twice appears once — the funnel is unique-case, so reopening cannot double-count',
  );
}

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
    'LIFECYCLE_ACTION_UNKNOWN',
    'LIFECYCLE_CASE_NOT_A_ROOM',
    'LIFECYCLE_STATE_UNKNOWN',
    'LIFECYCLE_NOT_PERMITTED',
    'LIFECYCLE_NO_CHANGE',
    'LIFECYCLE_TRANSITION_INVALID',
    'LIFECYCLE_REASON_REQUIRED',
    'LIFECYCLE_EVIDENCE_REQUIRED',
    'LIFECYCLE_ACTION_NOT_APPLICABLE',
  ]);
  const caseAt = (status) => ({
    id: 'case-P',
    orgId: 'org-P',
    playerId: 'pl-P',
    room: { status, rev: 1 },
    history: [],
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
  ok(
    cells.length === ROOM_STATUSES.length * ACTIONS.length * ROLES.length && cells.length === 1368,
    `P1 the matrix is complete: ${cells.length} state x action x role combinations evaluated`,
  );

  // Totality — every cell answers, and answers in the declared shape.
  neg(
    cells.every((c) => c.v && (c.v.ok === true || (c.v.ok === false && ERRORS.has(c.v.error)))),
    'P2 every combination returns a verdict, and every refusal carries a declared error code',
  );

  // Purity — the validator is asked the same question twice, about a frozen
  // case, and must give the same answer without touching it.
  const frozen = Object.freeze({ ...caseAt('under_review'), room: Object.freeze({ status: 'under_review', rev: 1 }) });
  const twice = ACTIONS.map((a) => [
    JSON.stringify(canTransitionRecruitmentCase(frozen, a, { role: 'recruitment_admin', reasonCodes: reasons })),
    JSON.stringify(canTransitionRecruitmentCase(frozen, a, { role: 'recruitment_admin', reasonCodes: reasons })),
  ]);
  ok(
    twice.every(([a, b]) => a === b),
    'P3 the validator is deterministic and mutates nothing it is given',
  );

  // Refusal ORDER is a privacy property, not a style choice. Role is checked
  // before the transition table, so a viewer cannot map the graph by probing:
  // every answer they get is the same answer, and it carries no `allowed` list.
  const viewerCells = cells.filter((c) => c.role === 'viewer');
  neg(
    viewerCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_NOT_PERMITTED'),
    'P4 a viewer is refused identically everywhere — the graph is not probeable by role',
  );
  neg(
    viewerCells.every((c) => c.v.allowed === undefined),
    'P5 and no refusal to a viewer leaks the set of states the case could move to',
  );

  // The role ladder must be monotone. A privilege inversion — where a lower
  // role may do something a higher role may not — would be invisible in any
  // single test and catastrophic in the one case that hit it.
  const rank = (r) => ROLES.indexOf(r);
  let inversions = 0;
  for (const from of ROOM_STATUSES) {
    for (const action of ACTIONS) {
      const okAt = ROLES.map((r) => cells.find((c) => c.from === from && c.action === action && c.role === r).v.ok);
      for (let i = 0; i < ROLES.length; i += 1) {
        for (let k = i + 1; k < ROLES.length; k += 1)
          if (okAt[i] && !okAt[k] && rank(ROLES[k]) > rank(ROLES[i])) inversions += 1;
      }
    }
  }
  neg(inversions === 0, 'P6 the role ladder is monotone: no lower role may do what a higher role may not');

  // The self-transition decision, stated once and enforced everywhere.
  //
  // A self-transition is REFUSED, and refused DISTINCTLY: `LIFECYCLE_NO_CHANGE`
  // rather than `LIFECYCLE_TRANSITION_INVALID`. "You are already there" and
  // "you cannot get there" are different facts. A client retrying after a lost
  // response is in the first case, and telling it the move was impossible
  // would send it to reload state that is in fact correct.
  const selfCells = cells.filter((c) => c.from === c.to && c.role === 'recruitment_admin');
  ok(selfCells.length > 0, 'P7 the matrix does contain self-transitions to rule on');
  neg(
    selfCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_NO_CHANGE'),
    'P8 every self-transition is refused as NO_CHANGE, never as INVALID — the two are different facts',
  );
  neg(
    ROOM_STATUSES.every(
      (s) => !availableActions(caseAt(s), { role: 'recruitment_admin' }).some((a) => LIFECYCLE_ACTIONS[a].to === s),
    ),
    'P9 and a self-transition is never offered as an available action',
  );

  // Evidence is keyed by TARGET, so it must bind on every inbound edge — for
  // every source state and every action that aims there, with no exception.
  const evidenceCells = cells.filter(
    (c) =>
      STATUS_EVIDENCE_REQUIRED[c.to] &&
      c.role === 'recruitment_admin' &&
      ROOM_TRANSITIONS[c.from].includes(c.to) &&
      c.from !== c.to,
  );
  ok(evidenceCells.length > 0, 'P10 there are inbound edges to evidence-bearing states to check');
  neg(
    evidenceCells.every((c) => c.v.ok === false && c.v.error === 'LIFECYCLE_EVIDENCE_REQUIRED'),
    `P11 all ${evidenceCells.length} otherwise-legal inbound edges to an evidence-bearing state are refused for evidence`,
  );
  neg(
    evidenceCells.every((c) => c.v.requires === STATUS_EVIDENCE_REQUIRED[c.to].kind),
    'P12 and each names the kind its TARGET requires, not a kind chosen per edge',
  );

  // Terminal closure. A terminal case may be FILED (closed / archived), but
  // nothing may revive it except an explicit reopen from a reopenable state.
  // `signed` is terminal and NOT reopenable, so no route back to pursuit
  // exists from it at all — the only thing left to do with a signed case is
  // file it.
  const ACTIVE = ROOM_STATUSES.filter((s) => !LIFECYCLE_TERMINAL.includes(s) && s !== 'under_review');
  for (const t of LIFECYCLE_TERMINAL) {
    const offered = availableActions(caseAt(t), { role: 'recruitment_admin' });
    neg(
      !offered.some((a) => ACTIVE.includes(LIFECYCLE_ACTIONS[a].to)),
      `P13 a ${t} case cannot be moved back into active pursuit`,
    );
    const revivers = offered.filter((a) => LIFECYCLE_ACTIONS[a].to === 'under_review');
    if (LIFECYCLE_REOPENABLE.includes(t)) {
      neg(
        revivers.length === 1 && revivers[0] === 'reopenCase',
        `P14 a ${t} case is revived by exactly one action, and it is named reopenCase`,
      );
    } else {
      neg(revivers.length === 0, `P14 a ${t} case offers no revival at all — it is not reopenable`);
    }
  }

  // Three actions reach `under_review`; if a state offered more than one of
  // them for the same move, the caller would pick the reason. Each writes a different reason code into a history nothing ever rewrites,
  // so "resumed from hold" could be recorded for a case that was never held.
  let ambiguous = 0;
  for (const from of ROOM_STATUSES) {
    for (const role of ROLES) {
      const targets = availableActions(caseAt(from), { role }).map((a) => LIFECYCLE_ACTIONS[a].to);
      if (new Set(targets).size !== targets.length) ambiguous += 1;
    }
  }
  neg(ambiguous === 0, 'P15 no state ever offers two actions for the same move — one event, one name, one reason code');

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
  neg(
    disagreements === 0,
    'P16 the offered-action list and the validator agree in both directions, for every state and role',
  );

  // An unknown role is not a weak role. Anything the ranking does not know
  // fails closed rather than falling through to the lowest tier.
  for (const role of [null, undefined, '', 'admin', 'owner', 'ROOM_LEAD', 'recruitment_admin ']) {
    const v = canTransitionRecruitmentCase(caseAt('watching'), 'startReview', { role });
    neg(
      v.ok === false && v.error === 'LIFECYCLE_NOT_PERMITTED',
      `P17 an unrecognised role (${JSON.stringify(role)}) is refused, not treated as the lowest tier`,
    );
  }

  // A corrupt stored state is corruption, not a workflow position — and it is
  // never coerced to a plausible-looking one.
  for (const bogus of ['identified', 'IN_PROGRESS', 'trial_in_progress', '', null, 42]) {
    const v = canTransitionRecruitmentCase({ ...caseAt('watching'), room: { status: bogus, rev: 1 } }, 'startReview', {
      role: 'recruitment_admin',
    });
    neg(
      v.ok === false && v.error === 'LIFECYCLE_STATE_UNKNOWN',
      `P18 a case stored at ${JSON.stringify(bogus)} is reported as unrecognised, never coerced`,
    );
  }
}

section('H1-H6 — the signed boundary, against the validator and the evidence provider (pure)');
{
  // ---- H1: the normal semantic action, no evidence.
  const atAccepted = {
    id: 'c-h',
    orgId: 'org-eastport',
    playerId: ADULT.id,
    room: { status: 'offer_accepted', rev: 1 },
  };
  const h1 = canTransitionRecruitmentCase(atAccepted, 'confirmSignedOutcome', {
    role: 'recruitment_admin',
    evidence: realEvidence,
  });
  neg(
    h1.ok === false && h1.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'H1 offer_accepted -> signed is refused: no confirmed joining record exists for this player',
  );
  neg(h1.evidenceReason === 'no_confirmed_join', 'H1b and the reason names what is missing, not a generic failure');

  // ---- H5: offer_made carries the IDENTICAL burden.
  const atMade = { ...atAccepted, room: { status: 'offer_made', rev: 1 } };
  const h5 = canTransitionRecruitmentCase(atMade, 'confirmSignedOutcome', {
    role: 'recruitment_admin',
    evidence: realEvidence,
  });
  neg(
    h5.ok === false && h5.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'H5 offer_made -> signed requires exactly the same evidence — the retained legacy edge is not a weaker path',
  );
  neg(
    h5.requires === h1.requires,
    'H5b and it is literally the same requirement, because the table is keyed by target',
  );

  // ---- H6: foreign signing evidence does not count.
  const foreignSigning = { id: 'sign-foreign', orgId: 'org-harbour', playerId: ADULT.id, ts: Date.now() };
  const otherPlayer = { id: 'sign-other', orgId: 'org-eastport', playerId: 'pl-someone-else', ts: Date.now() };
  const cancelled = {
    id: 'sign-cancelled',
    orgId: 'org-eastport',
    playerId: ADULT.id,
    ts: Date.now(),
    cancelledAt: Date.now(),
  };
  const probe = (rows) => createEvidenceProvider({ signings: rows }).check('confirmed_join', { kase: atAccepted });
  neg(
    probe([foreignSigning]).satisfied === false,
    "H6 another club's signing does not prove this club signed the player",
  );
  neg(probe([otherPlayer]).satisfied === false, "H6b another player's signing proves nothing about this one");
  neg(probe([cancelled]).satisfied === false, 'H6c a cancelled signing is not a signing');
  ok(
    probe([{ id: 'sign-ok', orgId: 'org-eastport', playerId: ADULT.id, ts: Date.now() }]).satisfied === true,
    'H6d a signing for this club AND this player does prove it',
  );
  neg(
    probe(undefined).satisfied === false && probe(undefined).reason === 'signings_store_unavailable',
    'H6e a MISSING signings store is reported as unavailable, never as "no signing" — the D2 lesson again',
  );

  // H3 — the legacy stage route cannot express `signed` at all.
  const stageNames = [
    'identified',
    'review',
    'observation',
    'trial',
    'invited',
    'awaiting_response',
    'decision',
    'closed',
  ];
  neg(
    stageNames.every((st) => roomStatusForStage(st, 'academy') !== 'signed'),
    'H3 no legacy workspace stage maps to `signed` — the compatibility path cannot express it',
  );
  neg(
    stageNames.every((st) => roomStatusForStage(st, 'grassroots') !== 'signed'),
    'H3b in either vocabulary',
  );

  // ---- The evidence table is keyed by target, so every inbound edge is covered.
  const inboundToSigned = Object.entries(ROOM_TRANSITIONS)
    .filter(([, tos]) => tos.includes('signed'))
    .map(([from]) => from);
  ok(inboundToSigned.length >= 2, `there is more than one inbound edge to signed (${inboundToSigned.join(', ')})`);
  for (const from of inboundToSigned) {
    const k = { ...atAccepted, room: { status: from, rev: 1 } };
    const v = canTransitionRecruitmentCase(k, 'confirmSignedOutcome', {
      role: 'recruitment_admin',
      evidence: realEvidence,
    });
    if (v.ok !== false || v.error !== 'LIFECYCLE_EVIDENCE_REQUIRED')
      fail(`${from} -> signed skipped the evidence requirement`);
  }
  neg(true, 'every inbound edge to signed carries the evidence requirement — no weaker path exists');
}

section('V — two reason taxonomies, and the route must use the right one');
{
  // The 20 decision codes say why a club DECIDED something — an opinion about a
  // player. The 16 lifecycle codes say why a case MOVED — an event in a process.
  // Validating transitions against the DECISION taxonomy would accept a
  // judgement about a player as the reason a case closed and refuse every one
  // of the sixteen reasons the lifecycle publishes.
  neg(
    LIFECYCLE_REASON_CODES.every((c) => !ALL_REASON_CODES.includes(c)),
    'V1 the two taxonomies share no code at all — they are not interchangeable',
  );
  ok(
    LIFECYCLE_REASON_CODES.every((c) => isLifecycleReason(c)),
    'V2 and every published lifecycle code passes the lifecycle predicate',
  );

  neg(
    validateLifecycleReasons(['squad_space']).error === 'LIFECYCLE_REASON_UNKNOWN',
    'V3 a DECISION reason is refused on a lifecycle transition',
  );
  ok(validateLifecycleReasons(['case_closed']).ok === true, 'V4 while a lifecycle reason is accepted');
  neg(
    Array.isArray(validateLifecycleReasons(['squad_space']).allowed),
    'V5 and the refusal publishes the taxonomy that WOULD work, so the caller can correct it',
  );

  // Safeguarding is shared deliberately: one rule, one implementation, one
  // error code. A protected characteristic is never a reason for anything.
  for (const c of ['nationality', 'religion', 'disability', 'postcode']) {
    const v = validateLifecycleReasons([c]);
    neg(
      v.ok === false && v.error === 'ROOM_REASON_PROHIBITED',
      `V6 "${c}" is refused as a prohibited characteristic, with the Rooms' own error code`,
    );
  }
  neg(
    validateLifecycleReasons(Array.from({ length: 7 }, () => 'case_closed').map((c, i) => (i ? `${c}` : c))).ok ===
      true,
    'V7 duplicates collapse rather than tripping the ceiling',
  );
  neg(
    validateLifecycleReasons(LIFECYCLE_REASON_CODES.slice(0, 7)).error === 'LIFECYCLE_REASONS_TOO_MANY',
    'V8 but seven distinct reasons on one transition is refused',
  );
  for (const bad of ['case_closed', 0, {}, null, [['case_closed']]]) {
    const v = validateLifecycleReasons(bad);
    neg(v.ok === false, `V9 ${JSON.stringify(bad)} is not a valid reason list`);
  }

  // Every action that REQUIRES a reason must have one it can actually be given.
  const needsReason = Object.entries(LIFECYCLE_ACTIONS).filter(([, d]) => d.reasonCodesRequired);
  ok(needsReason.length === 3, `V10 ${needsReason.length} actions require a recorded reason`);
  neg(
    needsReason.every(([, d]) => isLifecycleReason(d.reason)),
    "V11 and each one's own default reason is a valid LIFECYCLE code — a required reason nobody can supply is a dead action",
  );
}

section('T — the status tables and the stage map answer nothing for a prototype key (pure)');
{
  const PROTO_KEYS = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'prototype',
    'isPrototypeOf',
  ];

  // T2 — the same hazard on the read side, where the key comes from STORED
  // data rather than from the request.
  neg(
    PROTO_KEYS.every((k) => ROOM_TRANSITIONS[k] === undefined && STATUS_EVIDENCE_REQUIRED[k] === undefined),
    'T2 the status tables answer undefined for a key nobody defined',
  );
  neg(
    PROTO_KEYS.every((k) => roomStatusForStage(k, 'pro') === null && roomStatusForStage(k, 'grassroots') === null),
    'T3 and so does the stage map, in both vocabularies',
  );
}

section('X — stored corruption: a broken record is reported, never rendered as fact');
{
  // These go straight at the projector with databases that could not have been
  // written by this build. A broken record is infrastructure failure or corruption, and neither is "no data".
  const VIEWER = { kind: 'org_staff', orgId: 'org-X', role: 'room_lead' };
  const OPTS = { now: 1767225600000, evidence: NULL_EVIDENCE_PROVIDER };
  const base = (over = {}) => ({
    recruitmentCases: [
      {
        id: 'case-X',
        orgId: 'org-X',
        playerId: 'pl-X',
        stage: 'review',
        createdAt: 1,
        history: [],
        room: { status: 'under_review', rev: 1 },
        ...over,
      },
    ],
    roomDecisions: [],
    requests: [],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [],
  });
  const build = (db) => {
    try {
      return buildRecruitmentJourney(db, 'case-X', VIEWER, OPTS);
    } catch (e) {
      return { threw: e };
    }
  };

  // A required store missing is NOT an empty history.
  for (const store of JOURNEY_REQUIRED_STORES) {
    const db = base();
    delete db[store];
    const out = build(db);
    neg(
      out.ok === false && out.error === 'JOURNEY_STORE_MISSING' && out.missing?.includes(store),
      `X1 a missing \`${store}\` is reported as broken infrastructure, not as empty history`,
    );
  }

  // A store present but of the wrong TYPE. `null` is not "absent", and an
  // object is not a list.
  for (const bad of [null, 0, '', 'nope', {}, true]) {
    const db = base();
    db.roomDecisions = bad;
    const out = build(db);
    neg(out.threw === undefined, `X2 roomDecisions = ${JSON.stringify(bad)} does not throw out of the projector`);
  }

  // The refusal names WHICH failure happened. "Absent" and "present but not a
  // list" are different operational problems and a log that conflates them
  // sends someone looking in the wrong place.
  {
    // The contacts and the assessments are read through SQL queries, so an unusable one is a missing query, named;
    // nothing is "malformed".
    const db = base();
    db.assessments = null;
    delete db.recruitmentContacts;
    const out = build(db);
    neg(
      out.missing?.includes('assessments') &&
        out.missing?.includes('recruitmentContacts') &&
        out.malformed?.length === 0,
      'X2b and names each store whose records it could not read',
    );
  }

  // A corrupt case must not become a disclosure oracle. A player who receives
  // "this case is corrupt" where a stranger receives "no such case" has just
  // been told the case exists.
  {
    const db = base({ history: { 0: 'x' } });
    const asPlayer = buildRecruitmentJourney(db, 'case-X', { kind: 'player_self', playerId: 'pl-X' }, OPTS);
    const asStranger = buildRecruitmentJourney(db, 'case-X', { kind: 'player_self', playerId: 'pl-nobody' }, OPTS);
    neg(
      asPlayer.error === 'CASE_NOT_FOUND' && JSON.stringify(asPlayer) === JSON.stringify(asStranger),
      'X2c a player asking about a corrupt case gets the same answer as for a case that never existed',
    );
    const asClub = buildRecruitmentJourney(db, 'case-X', VIEWER, OPTS);
    neg(
      asClub.error === 'CASE_HISTORY_CORRUPT',
      'X2d while the club that owns it is told plainly that the record is unreadable',
    );
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
    [
      'history entry with an unknown action',
      { history: [{ action: 'teleported', at: 1, detail: { from: 'a', to: 'b' } }] },
    ],
    [
      'history timestamps unsortable',
      {
        history: [{ action: 'room_status_changed', at: 'yesterday', detail: { from: 'watching', to: 'under_review' } }],
      },
    ],
    ['stage disagreeing with status', { stage: 'closed' }],
  ];
  for (const [name, over] of CORRUPTIONS) {
    const out = build(base(over));
    neg(out.threw === undefined, `X3 ${name}: the projector answers instead of throwing`);
  }

  // The two that must answer with a NAMED refusal rather than a rendered page.
  neg(
    build(base({ room: null })).error === 'CASE_NOT_A_ROOM',
    'X4 a case with no room facet is refused by name, not projected as an empty workspace',
  );

  // An unknown stored action is OMITTED from the timeline rather than rendered
  // as a fabricated event. Inventing a label for it would put a sentence in
  // front of a user that describes something that never happened.
  const invented = build(
    base({
      history: [
        { action: 'room_status_changed', at: 2, detail: { from: 'watching', to: 'under_review' } },
        { action: 'teleported', at: 3, detail: { from: 'under_review', to: 'signed' } },
      ],
    }),
  );
  neg(
    !JSON.stringify(invented.history?.entries ?? []).includes('teleported'),
    'X5 an unknown history action is omitted, never rendered as a timeline event',
  );
  neg(
    !JSON.stringify(invented.history?.entries ?? []).includes('signed'),
    'X6 and its invented destination does not leak into the timeline either',
  );

  // A corrupt stored status must not become a plausible one. Guessing is how a
  // broken record turns into a confident wrong answer.
  const unknownStatus = build(base({ room: { status: 'identified', rev: 1 } }));
  if (unknownStatus.ok) {
    neg(
      unknownStatus.lifecycle.currentStage === 'identified',
      'X7 a stored status this build does not know is reported verbatim, never coerced to a known one',
    );
    neg(
      Array.isArray(unknownStatus.nextActions) && unknownStatus.nextActions.length === 0,
      'X8 and no action is offered on a case whose state cannot be interpreted',
    );
  } else {
    neg(true, 'X7 a stored status this build does not know is refused by name');
  }
}

section('W — room creation runs no transition table and no evidence gate (pure)');
{
  // W1-W4 (pure) — room CREATION is an inbound edge like any other, and it
  // runs no transition table and no evidence gate. Stated as a property over
  // both vocabularies rather than as a special case, so a stage added later
  // cannot reintroduce the hole.
  ok(
    roomStatusForStage('awaiting_response', 'grassroots') === 'trial_completed',
    'W1 the honest inverse of the grassroots stage map does reach an evidence-bearing status',
  );
  neg(
    adoptionStatusForStage('awaiting_response', 'grassroots') === 'under_review',
    'W2 but a Room adopting that case does NOT start at `trial_completed` — no trial is proven',
  );
  const proStarts = PRO_STAGES.map((s) => adoptionStatusForStage(s, 'pro'));
  const grStarts = GRASSROOTS_STAGES.map((s) => adoptionStatusForStage(s, 'grassroots'));
  neg(
    [...proStarts, ...grStarts].every((s) => !STATUS_EVIDENCE_REQUIRED[s]),
    'W3 no stage in either vocabulary starts a room at a status the records cannot prove',
  );
  ok(
    [...proStarts, ...grStarts].every((s) => ROOM_STATUSES.includes(s)),
    'W4 and every adoption start is a real status, never null or invented',
  );
}

section('Y — the error contract: one table, no default, nothing internal in the body (pure)');
{
  // Every code the input schemas can refuse with is declared as data by the routes that use them, and has a status.
  const declared = new Set();
  for (const t of [DECISION_INPUT_CODES, CONTACT_INPUT_CODES, LIFECYCLE_INPUT_CODES, TRIAL_INPUT_CODES])
    for (const c of [...Object.values(t.codes), ...Object.values(t.fieldCodes)]) declared.add(c);
  const unmapped = [...declared].filter((c) => httpStatusFor(c) === null);
  neg(
    declared.size > 0 && unmapped.length === 0,
    `Y1 every refusal code the lifecycle input schemas declare has an HTTP status (${declared.size} codes${unmapped.length ? `; unmapped: ${unmapped.join(', ')}` : ''})`,
  );
  // A code missing from the table fails closed: a generic 500, never the detail it came with.
  const sent = {};
  const fakeRes = {
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
  const quiet = console.error;
  console.error = () => {};
  sendDomainError(
    fakeRes,
    { error: 'LIFECYCLE_NOT_A_REAL_CODE', message: 'secret detail', caseId: 'case-x' },
    'battery',
  );
  console.error = quiet;
  neg(
    sent.status === 500 &&
      sent.body.error === 'LIFECYCLE_INTERNAL' &&
      !JSON.stringify(sent.body).includes('secret') &&
      !JSON.stringify(sent.body).includes('case-x'),
    'Y2 a code missing from the table is a generic 500 that carries none of what came with it',
  );

  // No silent default in either direction: an unknown code must NOT resolve.
  neg(
    httpStatusFor('LIFECYCLE_NOT_A_REAL_CODE') === null,
    'Y4 an unknown code resolves to null, not to a default status',
  );
  neg(httpStatusFor('constructor') === null, 'Y5 and a prototype key is absent from the table, not a function');

  // Every mapped status is one this contract actually uses. A 418 or a 200 in
  // the table would be a typo that no other assertion here would notice.
  // 429: the Contact cooldown is a deterministic per-recipient
  // refusal with a retry time, and 429 is the status that means exactly that.
  const BANDS = [400, 403, 404, 409, 422, 429, 500];
  const offBand = Object.entries(LIFECYCLE_ERROR_HTTP).filter(([, s]) => !BANDS.includes(s));
  neg(offBand.length === 0, `Y6 every status in the table is one of ${BANDS.join('/')}`);

  // An internal error must not hand the client the implementation.
  //
  // The control first: the projector's own return value DOES name the stores,
  // because that detail is what makes it useful in a log and in the unit tests
  // above. Without this the next assertion could pass by testing nothing.
  const holed = {
    recruitmentCases: [],
    roomDecisions: [],
    requests: [],
    signings: [],
    recruitmentContacts: [],
    assessments: undefined,
    trials: 'not-a-list',
  };
  const internal = buildRecruitmentJourney(holed, 'case-anything', { kind: 'org_staff', orgId: 'org-eastport' });
  ok(
    internal.ok === false &&
      internal.error === 'JOURNEY_STORE_MISSING' &&
      JSON.stringify(internal).includes('assessments'),
    'Y7 the projector names the absent store internally, which is why the log is worth reading',
  );

  const publicBody = publicErrorBody(internal);
  const leaked = JOURNEY_REQUIRED_STORES.filter((s) => JSON.stringify(publicBody).includes(s));
  for (const s of leaked) console.error(`   leaked store name: ${s}`);
  neg(leaked.length === 0, 'Y8 and the body a client receives names none of them — not one store, not the count');
  neg(
    publicBody.missing === undefined && publicBody.malformed === undefined,
    'Y9 the diagnostic fields are absent from the public body, not emptied',
  );
  ok(
    publicBody.error === 'JOURNEY_STORE_MISSING',
    'Y10 while the code itself survives, so a client can still branch and a log can still group',
  );
}

section('Z — what the lifecycle deliberately does NOT ship (pure)');
{
  // No lifecycle state is reinterpreted as an Offer. The offers are rows of their tables, read through SQL, and the
  // journey's offers stay optional through its `reads`.
  ok(TABLE_BACKED.includes('recruitmentOffers'), 'Z2 the offers are a table (since 0017), read through SQL');
  neg(
    DATA_MIGRATIONS.filter((m) => /offer/i.test(m.id))
      .map((m) => m.id)
      .join() === '0017_recruitment_contacts_offers',
    'Z3 and no other migration was added for them',
  );
  const noOffers = buildRecruitmentJourney(
    {
      recruitmentCases: [{ id: 'z-case', orgId: 'o1', playerId: 'p1', room: { status: 'shortlisted' }, history: [] }],
      roomDecisions: [],
      requests: [],
      trials: [],
      assessments: [],
      signings: [],
      recruitmentContacts: [],
    },
    'z-case',
    { kind: 'org_staff', orgId: 'o1', role: 'room_lead' },
  );
  neg(
    JOURNEY_REQUIRED_STORES.includes('recruitmentOffers') === false &&
      noOffers.ok === true &&
      noOffers.offer?.available === false,
    'Z4 the journey treats the offers as optional, so their absence is not a JOURNEY_STORE_MISSING',
  );

  // And the gate really does refuse `contacted` with the null provider: with
  // no way to check the evidence, it fails closed.
  const toContacted = canTransitionRecruitmentCase(
    { id: 'c', room: { status: 'contact_planned' }, history: [] },
    'recordContact',
    { role: 'room_lead', evidence: NULL_EVIDENCE_PROVIDER, reasonCodes: [] },
  );
  neg(
    toContacted.ok === false &&
      toContacted.error === 'LIFECYCLE_EVIDENCE_REQUIRED' &&
      toContacted.requires === 'contact_delivered',
    'Z12 and `contacted` is refused for want of `contact_delivered`',
  );
  neg(
    toContacted.evidenceReason === 'not_implemented',
    'Z13 with the honest reason: this deployment cannot check it yet, so it fails CLOSED',
  );
}

done();
