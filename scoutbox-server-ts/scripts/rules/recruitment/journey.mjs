// The journey model behind the recruitment journey battery (e2e/recruitment/journey.mjs), checked in this process:
// the stages, the selectors, the next actions, the validator and the timeline's visibility.
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { ROOM_STATUSES, TERMINAL_ROOM_STATUSES } from '../../../domains/recruitment/rooms/shared.mjs';
import {
  JOURNEY_STAGES,
  PIPELINE_STAGES,
  canonicalStageFor,
  completedStagesFor,
  nextActionFor,
  NEXT_ACTION_CODES,
  NEXT_ACTIONS,
  currentContactForCase,
  currentTrialForCase,
  currentOfferForCase,
  currentSigningForOffer,
  currentDecisionForCase,
  currentAssessmentForCase,
  playerNextActionFor,
  playerStageFor,
  validateRecruitmentJourney,
  JOURNEY_CLASSIFICATIONS,
  TIMELINE_VISIBILITY,
  timelineVisibleTo,
} from '../../../domains/recruitment/lifecycle/journeyModel.mjs';
import { JOURNEY_VIEWERS } from '../../../domains/recruitment/lifecycle/journey.mjs';
import { buildRecruitmentJourney, createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/journey');
const LATEST_SCHEMA = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
); // the latest table migration's number

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.now();

section('A — the model: stages, selectors, next actions, validator, visibility (pure)');
{
  ok(
    DATA_MIGRATIONS.length === LATEST_SCHEMA && !DATA_MIGRATIONS.some((m) => /journey/i.test(m.id)),
    'A1 every table migration, none for a journey: the journey adds no store',
  );
  ok(
    JOURNEY_STAGES.length === 13 &&
      PIPELINE_STAGES.length === 10 &&
      PIPELINE_STAGES.every((s) => JOURNEY_STAGES.includes(s)),
    'A2 thirteen stage words, ten pipeline stages',
  );
  neg(
    ROOM_STATUSES.length === 18 &&
      JOURNEY_STAGES.every((s) => !ROOM_STATUSES.includes(s) || s === 'watching' || s === 'signed'),
    'A3 the frozen lifecycle still has 18 states; a stage word is not a lifecycle state (only `watching` and `signed` coincide by name)',
  );
  ok(
    canonicalStageFor('trial_completed', { assessed: false }) === 'assessment' &&
      canonicalStageFor('trial_completed', { assessed: true }) === 'decision' &&
      canonicalStageFor('offer_accepted', {}) === 'acceptance' &&
      canonicalStageFor('offer_accepted', { signingOpened: true }) === 'signing' &&
      canonicalStageFor('on_hold', {}) === 'paused' &&
      canonicalStageFor('archived', {}) === 'ended',
    'A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended',
  );
  neg(
    canonicalStageFor('SIGNED', {}) === null &&
      canonicalStageFor('', {}) === null &&
      canonicalStageFor('constructor', {}) === null,
    'A5 an unknown status has no stage (fails closed, prototype keys included)',
  );
  // Selectors: an expired package never masks a live one.
  const pk = (id, status, createdAt, expiresAt) => ({
    id,
    status,
    createdAt,
    expiresAt,
    revisions: [{ id: `${id}-r1`, revisionNumber: 1, status }],
    currentRevisionId: `${id}-r1`,
  });
  const expired = pk('spk-old', 'READY', T0 - 10 * DAY, T0 - 5 * DAY);
  const live = pk('spk-new', 'READY', T0 - DAY, T0 + 5 * DAY);
  const done = pk('spk-done', 'COMPLETED', T0 - 3 * DAY, null);
  neg(
    currentSigningForOffer([expired, live], T0)?.id === 'spk-new' &&
      currentSigningForOffer([live, expired], T0)?.id === 'spk-new',
    '#53 A6 a live package is current whatever its storage order; the expired one never masks it',
  );
  ok(
    currentSigningForOffer([expired, done], T0)?.id === 'spk-done' &&
      currentSigningForOffer([expired], T0)?.id === 'spk-old' &&
      currentSigningForOffer([], T0) === null,
    'A7 live → completed → newest terminal → null',
  );
  const cx = (id, status, t) => ({
    id,
    status,
    createdAt: t,
    deliveredAt: status === 'delivered' || status === 'responded' ? t : undefined,
    respondedAt: status === 'responded' ? t + 1 : undefined,
    updatedAt: t,
  });
  ok(
    currentContactForCase([cx('c1', 'responded', 1), cx('c2', 'delivered', 2), cx('c3', 'draft', 3)])?.id === 'c2' &&
      currentContactForCase([cx('c1', 'responded', 1), cx('c3', 'draft', 3)])?.id === 'c1' &&
      currentContactForCase([cx('c4', 'cancelled', 9)]) === null,
    'A8 the current Contact: delivered over answered over draft; cancelled never',
  );
  const tr = (id, state, t) => ({
    id,
    acceptedAt: t,
    workflowState: state,
    schedule:
      state === 'scheduled' || state === 'completed'
        ? { confirmedAt: t, sessions: [{ id: 's', startsAt: t, endsAt: t + H }] }
        : null,
    completion:
      state === 'completed'
        ? { state: 'completed', at: t + 2 }
        : state === 'cancelled'
          ? { state: 'cancelled', at: t + 2 }
          : null,
  });
  ok(
    currentTrialForCase([tr('t1', 'completed', 1), tr('t2', 'cancelled', 5), tr('t3', 'scheduled', 3)])?.id === 't3' &&
      currentTrialForCase([tr('t1', 'completed', 1), tr('t2', 'cancelled', 5)])?.id === 't1',
    'A9 the current Trial: live over completed over cancelled',
  );
  const rv = (id, n, status, issuedAt) => ({ id, revisionNumber: n, status, issuedAt, expiresAt: T0 + 10 * DAY });
  const of = (id, revs, updatedAt) => ({
    id,
    updatedAt,
    createdAt: updatedAt,
    revisions: revs,
    currentRevisionId: revs[revs.length - 1].id,
  });
  const oAcc = of('rof-a', [rv('ra1', 1, 'ACCEPTED', 1)], 1);
  const oLive = of('rof-b', [rv('rb1', 1, 'SUPERSEDED', 2), rv('rb2', 2, 'ISSUED', 3)], 3);
  const oDec = of('rof-c', [rv('rc1', 1, 'DECLINED', 9)], 9);
  const cur = currentOfferForCase([oDec, oAcc, oLive], T0);
  ok(
    cur.offer.id === 'rof-b' &&
      cur.revision.id === 'rb2' &&
      currentOfferForCase([oDec, oAcc], T0).offer.id === 'rof-a' &&
      currentOfferForCase([oDec], T0).offer.id === 'rof-c',
    'A10 the current Offer: live over accepted over the rest; the LIVE revision, never a superseded one',
  );
  const dec = (id, kind, t, sup = null) => ({ id, kind, state: 'final', createdAt: t, supersededById: sup });
  ok(
    currentDecisionForCase([dec('d1', 'formal', 1, 'd2'), dec('d2', 'formal', 2), dec('d3', 'recommendation', 3)])
      ?.id === 'd2' &&
      currentDecisionForCase([dec('d3', 'recommendation', 3)])?.id === 'd3' &&
      currentDecisionForCase([{ id: 'x', kind: 'formal', state: 'draft', createdAt: 9 }]) === null,
    'A11 the current decision: the formal head, else the advisory head, never a draft or a superseded row',
  );
  ok(
    currentAssessmentForCase([
      { id: 'a1', state: 'draft', updatedAt: 9 },
      { id: 'a2', state: 'submitted', submittedAt: 2 },
    ])?.id === 'a2',
    'A12 a submitted assessment outranks a newer draft',
  );
  // Next actions.
  const base = { role: 'recruitment_admin', now: T0 };
  const N = (status, extra = {}) => nextActionFor({ ...base, status, ...extra });
  ok(
    NEXT_ACTION_CODES.length === 24 && NEXT_ACTION_CODES.every((c) => NEXT_ACTIONS[c]),
    'A13 twenty-four next-action codes, every one in the table',
  );
  ok(
    N('watching').code === 'REVIEW_PLAYER' &&
      N('under_review').code === 'DECIDE_APPROACH' &&
      N('under_review', { assessed: true }).code === 'RECORD_DECISION' &&
      N('contact_planned').code === 'SEND_CONTACT' &&
      N('contacted', { contact: { id: 'c', status: 'delivered' } }).code === 'AWAIT_CONTACT_RESPONSE' &&
      N('contacted', { contact: { id: 'c', status: 'responded' } }).code === 'CONTINUE_EVALUATION',
    'A14 watching → review; review → approach (decision once assessed); contact planned → send; delivered → await; answered → continue',
  );
  ok(
    N('trial_requested').code === 'AWAIT_TRIAL_RESPONSE' &&
      N('trial_scheduled', { trial: { id: 't', schedule: { sessions: [{ endsAt: T0 + H }] } } }).code ===
        'CONDUCT_TRIAL' &&
      N('trial_scheduled', { trial: { id: 't', schedule: { sessions: [{ endsAt: T0 - H }] } } }).code ===
        'COMPLETE_TRIAL' &&
      N('trial_completed').code === 'COMPLETE_ASSESSMENT' &&
      N('trial_completed', { assessed: true }).code === 'RECORD_DECISION',
    'A15 trial requested → await; scheduled → conduct, then complete once the last session ended; completed → assess, then decide',
  );
  ok(
    N('offer_consideration').code === 'PREPARE_OFFER' &&
      N('offer_consideration', { offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'DRAFT' } }).code ===
        'ISSUE_OFFER' &&
      N('offer_made', { offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'ISSUED', liveStatus: 'ISSUED' } })
        .code === 'AWAIT_OFFER_RESPONSE' &&
      N('offer_made', {
        offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'EXPIRED', liveStatus: 'EXPIRED' },
      }).code === 'REVISE_OR_WITHDRAW_OFFER' &&
      N('offer_declined').code === 'REVIEW_DECLINED_OFFER',
    'A16 consideration → prepare (issue once drafted); made → await (revise once expired); declined → review',
  );
  const pkgWith = (parties) => ({
    id: 'spk',
    status: 'IN_PROGRESS',
    createdAt: T0,
    expiresAt: T0 + DAY,
    currentRevisionId: 'r',
    revisions: [{ id: 'r', status: 'IN_PROGRESS', requiredParties: parties }],
  });
  ok(
    N('offer_accepted').code === 'START_SIGNING' &&
      N('offer_accepted', { signing: { ...pkgWith([]), status: 'DRAFT' } }).code === 'PRESENT_SIGNING' &&
      N('offer_accepted', {
        signing: pkgWith([
          { partyType: 'PLAYER', status: 'PENDING' },
          { partyType: 'CLUB_SIGNATORY', status: 'PENDING' },
        ]),
      }).code === 'SIGN_FOR_CLUB' &&
      N('offer_accepted', {
        signing: pkgWith([
          { partyType: 'PLAYER', status: 'PENDING' },
          { partyType: 'CLUB_SIGNATORY', status: 'COMPLETED' },
        ]),
      }).code === 'AWAIT_RECIPIENT_SIGNATURE' &&
      N('offer_accepted', {
        signing: pkgWith([
          { partyType: 'PLAYER', status: 'COMPLETED' },
          { partyType: 'CLUB_SIGNATORY', status: 'COMPLETED' },
        ]),
      }).code === 'COMPLETE_SIGNING',
    'A17 accepted → start; draft → present; pending club → sign; pending player → await; all signed → complete',
  );
  neg(
    N('offer_accepted', { signing: { ...pkgWith([]), status: 'READY', expiresAt: T0 - 1 } }).code === 'START_SIGNING',
    '#53 A18 an EXPIRED package is not the current one to act on: the next action is a new signing',
  );
  ok(
    N('signed').code === 'RECRUITMENT_COMPLETE' &&
      N('on_hold').code === 'RESUME_CASE' &&
      N('archived').code === 'CASE_ENDED' &&
      N('withdrawn').code === 'CASE_ENDED' &&
      N('closed').code === 'CASE_ENDED' &&
      N('nonsense').code === 'STATE_UNKNOWN',
    'A19 signed → complete; hold → resume; ended → ended; unknown → unknown',
  );
  neg(
    N('watching', { role: 'viewer' }).permitted === false &&
      N('offer_accepted', { role: 'room_lead', signing: pkgWith([{ partyType: 'CLUB_SIGNATORY', status: 'PENDING' }]) })
        .permitted === false &&
      N('offer_accepted', { role: 'room_lead' }).permitted === true &&
      N('trial_requested').permitted === null,
    'A20 permission follows the role: a viewer cannot start the review, a room lead cannot sign for the club but may start the signing; an await has no permission',
  );
  neg(
    N('contact_planned', { blocked: true }).blockedBy.includes('BLOCKED') &&
      N('contact_planned', { subjectRemoved: true }).blockedBy.includes('SUBJECT_REMOVED') &&
      N('trial_requested', { blocked: true }).blockedBy.length === 0,
    'A21 a block or a removed subject is named on a club act, not invented on a wait',
  );
  // However high or low a player's Trust Score, match or Box Cam verdict, the case's next step is the same.
  const verdicts = [
    { trustScore: 100, trust: { score: 100, band: 'strong' }, matchScore: 99, match: { met: 12, preferredMet: 12 } },
    { trustScore: 0, trust: { score: 0, band: 'limited_evidence' }, onWatchlist: true, watchlists: ['wl-1'] },
    { boxCam: { verdict: 'verified', valid: true }, cv: { verdict: 'rejected' }, combine: { targetMet: true } },
  ];
  const moved = ROOM_STATUSES.filter((st) =>
    verdicts.some(
      (v) =>
        JSON.stringify(N(st, v)) !== JSON.stringify(N(st)) ||
        JSON.stringify(N(st, { player: { ...v } })) !== JSON.stringify(N(st)),
    ),
  );
  neg(
    Object.values(NEXT_ACTIONS).every((d) => !/trust|match|boxcam|\bcv\b/i.test(JSON.stringify(d))) &&
      moved.length === 0,
    `#15 #16 #17 A22 no next action names, or changes with, a Trust Score, a match or a Box Cam verdict (${ROOM_STATUSES.length} states, ${moved.join(', ') || 'none moved'})`,
  );
  // Player next action and stage.
  ok(
    playerNextActionFor({ signingPending: { id: 's' }, issuedOffer: { offer: { id: 'o' }, revision: { id: 'r' } } })
      .code === 'SIGN' &&
      playerNextActionFor({
        issuedOffer: { offer: { id: 'o' }, revision: { id: 'r' } },
        pendingContactRequest: { id: 'q' },
      }).code === 'RESPOND_TO_OFFER' &&
      playerNextActionFor({ pendingTrialRequest: { id: 'q' }, pendingContactRequest: { id: 'q2' } }).code ===
        'RESPOND_TO_TRIAL_INVITATION' &&
      playerNextActionFor({}).code === 'NONE',
    "A23 the player's action is the most consequential pending act",
  );
  ok(
    playerStageFor({ contacts: [{ id: 'q' }] }) === 'contacted' &&
      playerStageFor({ contacts: [{ id: 'q' }], trialRequests: [{ status: 'pending' }] }) === 'trial_invited' &&
      playerStageFor({ offer: { liveStatus: 'ISSUED' } }) === 'offer_received' &&
      playerStageFor({ offer: { liveStatus: 'ACCEPTED' } }) === 'offer_accepted' &&
      playerStageFor({ signingRow: { id: 's' } }) === 'signed' &&
      playerStageFor({}) === 'none',
    'A24 player stage words come only from records that reached the player',
  );
  neg(
    !['watching', 'under_review', 'shortlisted', 'priority', 'review', 'decision', 'assessment'].some((w) =>
      String(playerStageFor).includes(`'${w}'`),
    ),
    '#16 A25 no club-internal word (priority, shortlist, decision, assessment) exists in the player vocabulary',
  );
  // Validator and classification.
  const facts = (over = {}) => ({
    kase: { id: 'k', createdAt: 10 },
    status: 'contacted',
    now: T0,
    history: [
      { action: 'room_created', at: 10, detail: { status: 'watching' } },
      { action: 'room_status_changed', at: 20, detail: { from: 'watching', to: 'under_review' } },
      { action: 'room_status_changed', at: 30, detail: { from: 'under_review', to: 'contacted' } },
    ],
    contacts: [],
    trials: [],
    trialRequests: [],
    assessments: [],
    decisions: [],
    offers: [],
    packages: [],
    signingRow: null,
    foreign: [],
    domainProblems: [],
    ...over,
  });
  ok(
    JOURNEY_CLASSIFICATIONS.join() === 'canonical,legacy,partially_canonical,integrity_error',
    'A26 four classifications',
  );
  ok(
    validateRecruitmentJourney(facts()).classification === 'legacy',
    'A27 contacted with no Contact and no claim on the history: legacy (history from before the records existed)',
  );
  ok(
    validateRecruitmentJourney(facts({ contacts: [{ id: 'c', status: 'delivered', deliveredAt: 25 }] }))
      .classification === 'canonical',
    'A28 contacted with a delivered Contact: canonical',
  );
  const claimed = facts();
  claimed.history[2].detail.contactId = 'rct-gone';
  claimed.history[2].detail.trigger = 'contact:rct-gone';
  const v = validateRecruitmentJourney(claimed);
  neg(
    v.classification === 'integrity_error' &&
      v.problems.includes('STALE_POINTER') &&
      v.problems.includes('LIFECYCLE_AHEAD_OF_EVIDENCE'),
    '#14 A29 contacted with a history entry that CLAIMS a Contact which is gone: integrity_error, STALE_POINTER and LIFECYCLE_AHEAD_OF_EVIDENCE',
  );
  const mixed = facts({
    status: 'offer_made',
    history: [
      ...facts().history,
      {
        action: 'room_status_changed',
        at: 40,
        detail: { from: 'contacted', to: 'offer_made', offerId: 'rof-1', trigger: 'offer:issue:rof-1' },
      },
    ],
    offers: [
      {
        id: 'rof-1',
        revisions: [{ id: 'r', status: 'ISSUED', issuedAt: 39, revisionNumber: 1, expiresAt: T0 + DAY }],
        currentRevisionId: 'r',
      },
    ],
  });
  ok(
    validateRecruitmentJourney(mixed).classification === 'partially_canonical',
    'A30 a legacy contact and a canonical Offer: partially_canonical',
  );
  neg(
    validateRecruitmentJourney(
      facts({
        status: 'offer_accepted',
        packages: [
          {
            id: 'spk',
            status: 'COMPLETED',
            completion: { signingId: 's' },
            createdAt: 1,
            revisions: [],
            currentRevisionId: null,
          },
        ],
      }),
    ).problems.includes('LIFECYCLE_BEHIND_TERMINAL_EVIDENCE'),
    'A31 a COMPLETED package on a case that is not signed: LIFECYCLE_BEHIND_TERMINAL_EVIDENCE',
  );
  neg(
    validateRecruitmentJourney(facts({ foreign: ['PLAYER_MISMATCH'] })).problems.includes('PLAYER_MISMATCH') &&
      validateRecruitmentJourney(facts({ status: 'SIGNED' })).problems.includes('LIFECYCLE_STATE_UNKNOWN') &&
      validateRecruitmentJourney(
        facts({ history: [{ action: 'room_status_changed', at: 'yesterday', detail: { to: 'contacted' } }] }),
      ).problems.includes('TEMPORAL_ORDER'),
    'A32 a foreign reference, an unknown state and a malformed instant are each named',
  );
  ok(
    completedStagesFor(facts({ contacts: [{ id: 'c', status: 'delivered', deliveredAt: 25 }] }))
      .map((s) => `${s.stage}:${s.basis}`)
      .join() === 'watching:lifecycle,review:lifecycle,contact:canonical',
    'A33 completed stages carry their basis',
  );
  // Timeline visibility.
  const clubOnly = Object.entries(TIMELINE_VISIBILITY)
    .filter(([, a]) => a.length === 1 && a[0] === 'club')
    .map(([k]) => k);
  neg(
    [
      'decision',
      'decision_recorded',
      'decision_superseded',
      'trial_assessment_recorded',
      'offer_draft_created',
      'signing_created',
      'trial_evidence_linked',
      'transaction_handoff_invited',
    ].every((k) => clubOnly.includes(k)) &&
      !timelineVisibleTo('decision_recorded', 'player') &&
      !timelineVisibleTo('room_status_changed', 'agent') &&
      timelineVisibleTo('offer_issued', 'player') &&
      timelineVisibleTo('signing_completed', 'agent'),
    '#16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent',
  );
  ok(
    JOURNEY_VIEWERS.includes('agent') && JOURNEY_VIEWERS.length === 6,
    'A35 six viewer kinds; the agent is one of them',
  );
  neg(
    buildRecruitmentJourney(
      {
        recruitmentCases: [],
        roomDecisions: [],
        requests: [],
        trials: [],
        assessments: [],
        signings: [],
        recruitmentContacts: [],
      },
      'k',
      { kind: 'analyst' },
    ).error === 'JOURNEY_VIEWER_UNKNOWN' &&
      buildRecruitmentJourney(
        {
          recruitmentCases: [{ id: 'k', orgId: 'o', playerId: 'p', room: { status: 'watching' } }],
          roomDecisions: [],
          requests: [],
          trials: [],
          assessments: [],
          signings: [],
          recruitmentContacts: [],
        },
        'k',
        { kind: 'agent', playerId: 'p' },
      ).error === 'CASE_NOT_FOUND',
    '#46 A36 an unknown audience fails closed; an agent without a proved basis sees no case',
  );
  // Evidence: the tightened `signed` rule.
  const evDb = (rows, pkgs = []) =>
    createEvidenceProvider({
      signings: rows,
      signingPackages: pkgs,
      recruitmentContacts: [],
      requests: [],
      trials: [],
      roomDecisions: [],
      recruitmentOffers: [],
    });
  const K = { id: 'k1', orgId: 'o1', playerId: 'p1', createdAt: 1000 };
  neg(
    evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 500 }]).check('confirmed_join', { kase: K }).satisfied ===
      false &&
      evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500 }]).check('confirmed_join', { kase: K }).satisfied ===
        true,
    '#14 A37 a legacy signing row recorded BEFORE the case opened does not prove it signed; one recorded after does',
  );
  neg(
    evDb(
      [{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500, signingPackageId: 'spk' }],
      [{ id: 'spk', orgId: 'o1', playerId: 'p1', caseId: 'k2', status: 'COMPLETED', completion: { signingId: 's' } }],
    ).check('confirmed_join', { kase: K }).satisfied === false &&
      evDb(
        [{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500, signingPackageId: 'spk' }],
        [{ id: 'spk', orgId: 'o1', playerId: 'p1', caseId: 'k1', status: 'COMPLETED', completion: { signingId: 's' } }],
      ).check('confirmed_join', { kase: K }).satisfied === true,
    '#52 A38 a canonical package proves the case it was opened on, not another case of the same club and player',
  );
}

done();
