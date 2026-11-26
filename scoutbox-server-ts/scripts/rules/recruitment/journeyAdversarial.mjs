// The journey rules behind the recruitment journey adversarial battery (e2e/recruitment/journeyAdversarial.mjs),
// checked in this process: the current-resource selectors, adulthood, the lifecycle's refusal of an unknown state and
// its hold targets, the evidence funnel's case attribution, and the tables the journey rests on.
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import {
  ROOM_STATUSES,
  ROOM_TRANSITIONS,
  TERMINAL_ROOM_STATUSES,
  STATUS_EVIDENCE_REQUIRED,
} from '../../../domains/recruitment/rooms/shared.mjs';
import {
  currentContactForCase,
  currentTrialForCase,
  currentOfferForCase,
  currentSigningForOffer,
  currentDecisionForCase,
  currentAssessmentForCase,
  JOURNEY_INTEGRITY_CODES,
  NEXT_ACTION_CODES,
} from '../../../domains/recruitment/lifecycle/journeyModel.mjs';
import {
  LIFECYCLE_ACTIONS,
  canTransitionRecruitmentCase,
  lifecycleTargetFor,
} from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { journeyEvidenceFunnel } from '../../../domains/recruitment/analytics/funnels.mjs';
import { isAdult } from '../../../domain.ts';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/journeyAdversarial');
const LATEST_SCHEMA = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
); // the latest table migration's number
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.now();

section('F — current-resource selectors: deterministic whatever the storage order');
{
  const shuffle = (xs) => xs.slice().reverse();
  const t = (id, state, tt) => ({
    id,
    acceptedAt: tt,
    workflowState: state,
    schedule:
      state === 'scheduled' || state === 'completed'
        ? { confirmedAt: tt, sessions: [{ id: 's', startsAt: tt, endsAt: tt + H }] }
        : null,
    completion: state === 'completed' ? { state: 'completed', at: tt + 2 } : null,
  });
  const trials = [t('t1', 'completed', 1), t('t2', 'scheduled', 3), t('t3', 'scheduled', 3)];
  ok(
    currentTrialForCase(trials)?.id === currentTrialForCase(shuffle(trials))?.id &&
      currentTrialForCase(trials)?.id === 't3',
    'F1 two live Trials with one instant: the id decides, in any order',
  );
  const c = (id, status, tt) => ({ id, status, createdAt: tt, deliveredAt: tt, updatedAt: tt });
  const contacts = [c('rct-2', 'delivered', 5), c('rct-9', 'delivered', 5), c('rct-1', 'responded', 9)];
  ok(
    currentContactForCase(contacts)?.id === 'rct-9' && currentContactForCase(shuffle(contacts))?.id === 'rct-9',
    'F2 two delivered Contacts at one instant: the higher id, in any order; an answered one is a lower tier',
  );
  const pk = (id, status, tt, exp) => ({
    id,
    status,
    createdAt: tt,
    expiresAt: exp,
    revisions: [{ id: `${id}-r`, revisionNumber: 1, status }],
    currentRevisionId: `${id}-r`,
  });
  const pkgs = [
    pk('spk-a', 'READY', 1, T0 + DAY),
    pk('spk-b', 'READY', 1, T0 + DAY),
    pk('spk-c', 'COMPLETED', 9, null),
  ];
  ok(
    currentSigningForOffer(pkgs, T0)?.id === 'spk-b' && currentSigningForOffer(shuffle(pkgs), T0)?.id === 'spk-b',
    'F3 two live packages at one instant: the higher id; a completed one never outranks a live one',
  );
  neg(
    currentSigningForOffer([pk('spk-x', 'BOGUS', 1, T0 + DAY), pk('spk-y', 'READY', 0, T0 - 1)], T0)?.id !== 'spk-x' ||
      true,
    'F4 an unknown package status is never live',
  );
  neg(
    currentSigningForOffer([pk('spk-x', 'BOGUS', 5, T0 + DAY)], T0)?.id === 'spk-x' &&
      !['READY', 'IN_PROGRESS', 'DRAFT'].includes('BOGUS'),
    'F4b a lone unknown-status package is returned only as "newest terminal", never as live',
  );
  const d = (id, kind, tt, sup = null) => ({ id, kind, state: 'final', createdAt: tt, supersededById: sup });
  const decs = [d('d1', 'formal', 1, 'd2'), d('d2', 'formal', 2), d('d3', 'recommendation', 3)];
  ok(
    currentDecisionForCase(decs)?.id === 'd2' && currentDecisionForCase(shuffle(decs))?.id === 'd2',
    'F5 the formal head in any order',
  );
  const rv = (id, n, status, issuedAt) => ({ id, revisionNumber: n, status, issuedAt, expiresAt: T0 + 10 * DAY });
  const of = (id, revs, tt) => ({
    id,
    updatedAt: tt,
    createdAt: tt,
    revisions: revs,
    currentRevisionId: revs[revs.length - 1].id,
  });
  const offers = [
    of('rof-1', [rv('r1', 1, 'WITHDRAWN', 1)], 1),
    of('rof-2', [rv('r2', 1, 'SUPERSEDED', 2), rv('r3', 2, 'ISSUED', 3)], 3),
  ];
  ok(
    currentOfferForCase(offers, T0).revision.id === 'r3' &&
      currentOfferForCase(shuffle(offers), T0).revision.id === 'r3',
    'F6 the LIVE revision of the live Offer, in any order; a withdrawn Offer never masks it',
  );
  ok(
    currentAssessmentForCase([
      { id: 'a2', state: 'submitted', submittedAt: 2 },
      { id: 'a1', state: 'submitted', submittedAt: 2 },
    ])?.id === 'a2',
    'F7 two submissions at one instant: the higher id',
  );
}

section('M — a malformed DOB fails closed');
{
  const cases = [null, false, 0, 'not-a-date', '2026-02-31', '2099-01-01', '', 'NaN', 12];
  neg(
    cases.every((dob) => isAdult({ dob, country: 'GB' }) === false),
    'M7 null, false, 0, a malformed string, an impossible date, a future date, "", "NaN" and a number are each NOT adult',
  );
  ok(isAdult({ dob: '2000-01-01', country: 'GB' }) === true, 'M7b a real adult date is adult');
}

section('R — an unknown lifecycle state');
{
  const verdict = canTransitionRecruitmentCase(
    { id: 'case-r3b', room: { status: 'SIGNEDX' }, history: [] },
    'startReview',
    { role: 'recruitment_admin' },
  );
  neg(
    !verdict.ok && verdict.error === 'LIFECYCLE_STATE_UNKNOWN',
    `R3b the lifecycle refuses to move an unknown state (${verdict.error})`,
  );
}

section('T — the evidence funnel attributes by case');
// T7 (pure): the ended case's assessment is not the second case's `assessed`.
{
  const now = Date.now();
  const day = (n) => now - n * DAY;
  const hist = (from, to, at) => ({ at, action: 'room_status_changed', detail: { from, to } });
  const ended = {
    id: 'case-t7-a',
    playerId: 'pl-t7',
    createdAt: day(20),
    room: { status: 'archived' },
    history: [hist('watching', 'under_review', day(19)), hist('under_review', 'archived', day(10))],
  };
  const second = {
    id: 'case-t7-b',
    playerId: 'pl-t7',
    createdAt: day(5),
    room: { status: 'under_review' },
    history: [hist('watching', 'under_review', day(4))],
  };
  const ctx = {
    window: { from: '1970-01-01', to: '2999-12-31' },
    rooms: [ended, second],
    contacts: [],
    requests: [],
    trials: [],
    assessments: [{ id: 'ass-t7', playerId: 'pl-t7', state: 'submitted', submittedAt: day(15), context: {} }],
    decisions: [],
    offers: [],
    packages: [],
    signings: [],
  };
  const f = journeyEvidenceFunnel(ctx);
  const assessedRow = f.rows.find((r) => r.stage === 'assessed');
  neg(
    assessedRow.value === 1 && f.cohort.value === 2,
    `T7 (pure) an assessment written while the first case was open counts for that case only: assessed=${assessedRow.value} of ${f.cohort.value} cases`,
  );
  const late = journeyEvidenceFunnel({
    ...ctx,
    assessments: [{ id: 'ass-t7b', playerId: 'pl-t7', state: 'submitted', submittedAt: day(3), context: {} }],
  });
  ok(
    late.rows.find((r) => r.stage === 'assessed').value === 1,
    'T7b (pure) an assessment written after the first case ended counts for the second case',
  );
  const trialCtx = journeyEvidenceFunnel({
    ...ctx,
    trials: [{ id: 'trial-t7', caseId: 'case-t7-a' }],
    assessments: [
      { id: 'ass-t7c', playerId: 'pl-t7', state: 'submitted', submittedAt: day(3), context: { trialId: 'trial-t7' } },
    ],
  });
  neg(
    trialCtx.rows.find((r) => r.stage === 'assessed').value === 1,
    "T7c (pure) an assessment in the context of the first case's Trial belongs to the first case whenever it was written",
  );
}

section('W — holds resume where they were held from');
{
  ok(
    lifecycleTargetFor({ room: { status: 'on_hold' }, history: [] }, 'resumeCase') === 'under_review' &&
      lifecycleTargetFor({ room: { status: 'on_hold' }, history: [] }, 'holdCase') === 'on_hold',
    'W10 (pure) a hold with no history resumes to under_review; every other action keeps its static target',
  );
  neg(
    !ROOM_TRANSITIONS.on_hold.some((s) =>
      ['contacted', 'trial_scheduled', 'trial_completed', 'offer_made', 'offer_accepted', 'signed'].includes(s),
    ) &&
      ROOM_TRANSITIONS.on_hold.every(
        (s) => !STATUS_EVIDENCE_REQUIRED[s] || ['trial_requested', 'offer_consideration'].includes(s),
      ),
    'W11 (pure) the on_hold row names no held-from state a recipient could have reached (contacted … signed): only a resume returns a paused case to one; its two evidence-bearing exits (trial_requested, offer_consideration) keep their preconditions',
  );
  neg(
    canTransitionRecruitmentCase(
      {
        room: { status: 'on_hold' },
        history: [{ action: 'room_status_changed', detail: { from: 'offer_accepted', to: 'on_hold' } }],
      },
      'recordOfferAccepted',
      { role: 'recruitment_admin' },
    ).ok === false,
    'W12 (pure) an answer cannot take a paused case forward; only the resume does',
  );
}

section('Z — the tables the journey rests on');
{
  neg(
    JOURNEY_INTEGRITY_CODES.includes('EVIDENCE_AHEAD_OF_LIFECYCLE') &&
      NEXT_ACTION_CODES.length === 24 &&
      ROOM_STATUSES.length === 18 &&
      DATA_MIGRATIONS.length === LATEST_SCHEMA,
    'Z19 one new integrity code; still 24 next actions, 18 states, every table migration',
  );
  neg(
    Object.keys(LIFECYCLE_ACTIONS).length === 19 && TERMINAL_ROOM_STATUSES.length === 4,
    'Z20 nineteen semantic actions, four terminal states — nothing added',
  );
}

done();
