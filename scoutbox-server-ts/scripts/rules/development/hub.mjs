// The Development Hub rules behind the hub battery (e2e/development/hub.mjs), checked in this process: §1–§8 of the
// battery as it stood (the vocabulary, derived figures, objective targets, evidence links, access, the timeline and
// stores, the migration and the clean-boot proof, and what a client may not assert), and the target engine's verdict
// on a production-valid measurement from §17. The numbered cases keep the battery's numbers; the battery runs the
// others.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEVELOPMENT_POLICY_VERSION,
  DEVELOPMENT_PRINCIPLE,
  ACHIEVED_MEANING,
  PLAN_OWNER_KINDS,
  PLAN_VISIBILITY,
  VISIBILITY_BY_OWNER,
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  GOAL_CATEGORIES,
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  BLOCK_REASONS,
  ACTION_TYPES,
  ACTION_STATUSES,
  ACTION_TRANSITIONS,
  EVIDENCE_SOURCES,
  REVIEWER_KINDS,
  SHARE_SCOPES,
  DEVELOPMENT_HUB_LIMITS,
  GOAL_LIBRARY,
  PLAN_TEMPLATES,
  FORBIDDEN_DEVELOPMENT_NAMES,
  FORBIDDEN_FIELD_NAMES,
  assertDevelopmentVocabulary,
  scanCopyForForbiddenNames,
  refusedClientFields,
  scanPayloadForForbiddenFields,
  transitionAllowed,
  dueState,
  reviewDueState,
  actionCounts,
  completionPhrase,
  boundedText,
  parseDate,
  utcDay,
  daysBetween,
} from '../../../domains/development/hub/shared.mjs';
import {
  TARGET_SOURCES,
  TARGET_OPERATORS,
  TARGET_STATES,
  NO_MEASUREMENT_REASONS,
  validateTarget,
  evaluateTarget,
  compare,
  bestValidAttempt,
} from '../../../domains/development/hub/targets.mjs';
import { EVIDENCE_LINK_FIELDS, summariseEvidence } from '../../../domains/development/hub/evidence.mjs';
import {
  planAccess,
  canAssign,
  reviewView,
  VIEWER_KINDS,
  CAPABILITIES,
} from '../../../domains/development/hub/permissions.mjs';
import { buildTimeline, TIMELINE_ACTIONS, planSummary } from '../../../domains/development/hub/plan.mjs';
import { buildGoalSnapshots, pageReviews } from '../../../domains/development/hub/reviews.mjs';
import { DEVELOPMENT_HUB_STORES } from '../../../domains/development/hub/index.mjs';
import { PAGE_LIMITS } from '../../../domains/platform/paging.mjs';
import { DEVELOPMENT_COLLECTIONS, DEVELOPMENT_MIGRATION } from '../../../repositories/development.mjs';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';

const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
import { liveCombineState, isProductionValidCombine } from '../../../domains/development/boxcam/combineShared.mjs';
import { PROVIDERS } from '../../../domains/development/boxcam/drills.mjs';
import { EVENT_NAMES, EVENT_REGISTRY, assertEventRegistry } from '../../../domains/platform/eventRegistry.mjs';
import { CATEGORIES, TYPE_CATEGORY, categoryOf } from '../../../domains/platform/notificationPrefs.mjs';
import { openLayer, readRecords } from '../../../scripts/dataLayerFixture.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { resolveEvidenceLink, recordBelongsToPlayer } from '../../../scripts/recruitmentReadsFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('development/hub');
const seenNeg = new Set();
/** A numbered negative case. The number is its stable id. */
const N = (n, cond, msg) => {
  seenNeg.add(n);
  neg(cond, `N${n} — ${msg}`);
};
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);

// =========================================================================
section('§1 — the vocabulary is internally consistent, and refuses a rating');
{
  const v = assertDevelopmentVocabulary();
  ok(v.problems.length === 0, `the boot assertion passes (${JSON.stringify(v.counts)})`);
  ok(DEVELOPMENT_POLICY_VERSION === 1, 'DEVELOPMENT_POLICY_VERSION is 1');
  ok(/does not measure/i.test(DEVELOPMENT_PRINCIPLE), 'the principle is carried in the code, not only in a document');

  // ---- the seven forbidden names
  const forbidden = [
    [58, 'development score'],
    [59, 'potential score'],
  ];
  for (const [n, name] of forbidden) {
    N(
      n,
      FORBIDDEN_DEVELOPMENT_NAMES.some((x) => x.toLowerCase() === name),
      `"${name}" is on the never-built list`,
    );
  }
  for (const name of [
    'Improvement Score',
    'Readiness Score',
    'Growth Score',
    'Academy Score',
    'Player Progress Rating',
  ]) {
    neg(FORBIDDEN_DEVELOPMENT_NAMES.includes(name), `"${name}" is on the never-built list`);
  }
  N(58, !GOAL_CATEGORIES.some((c) => /score|rating|rank/i.test(c)), 'no goal category is a score or a rating');
  N(
    59,
    !ACTION_TYPES.some((c) => /score|rating|rank|potential/i.test(c)),
    'no action type is a score, a rating or a potential',
  );

  // The boot assertion must actually bite. A vocabulary that only documents its
  // refusals is a comment. The tables themselves are frozen — which is right,
  // and which is why the scanner is tested directly rather than by poisoning
  // one of them at runtime.
  N(
    58,
    scanCopyForForbiddenNames([['GOAL_LIBRARY.x', 'Development Score']]).length === 1,
    'the vocabulary scanner catches a forbidden product name in a label',
  );
  N(
    58,
    scanCopyForForbiddenNames([['x', 'Player Progress Rating for this week']]).length === 1,
    '…including one buried inside a longer sentence',
  );
  ok(
    scanCopyForForbiddenNames([['x', 'ScoutBox does not measure a player’s ceiling']]).length === 0,
    'and does NOT catch prose that denies a forbidden thing — the copy scan looks for product names, not field names',
  );
  for (const table of [
    GOAL_LIBRARY,
    PLAN_TEMPLATES,
    FORBIDDEN_DEVELOPMENT_NAMES,
    GOAL_CATEGORIES,
    GOAL_STATUSES,
    ACTION_TYPES,
  ]) {
    ok(
      Object.isFrozen(table),
      'every vocabulary table is frozen, so a runtime tamper is not possible in the first place',
    );
  }

  // ---- two health vocabularies deliberately left out, and why
  ok(
    !GOAL_CATEGORIES.includes('availability_rehabilitation'),
    'there is no availability/rehabilitation goal category — the repository has no safe health vocabulary',
  );
  ok(
    !BLOCK_REASONS.includes('injury_or_unavailable'),
    'there is no injury_or_unavailable block reason — same reason, documented rather than invented',
  );
  N(
    48,
    !BLOCK_REASONS.some((r) => /injur|medical|health|fit(ness)?$/i.test(r)),
    'no block reason invites a medical detail',
  );

  // ---- statuses, and the transitions that make them meaningful
  ok(
    PLAN_STATUSES.length === 5 && !PLAN_STATUSES.includes('closed'),
    'plan statuses avoid the ambiguous "closed" the Rooms use for a Room',
  );
  ok(
    GOAL_STATUSES.length === 5 && ACTION_STATUSES.length === 5,
    'goal and action statuses are the five the mandate names',
  );
  N(
    20,
    !transitionAllowed(GOAL_TRANSITIONS, 'not_started', 'achieved'),
    'a goal nobody started cannot go straight to achieved',
  );
  N(20, !transitionAllowed(PLAN_TRANSITIONS, 'archived', 'active'), 'an archived plan cannot be reactivated');
  N(20, !transitionAllowed(ACTION_TRANSITIONS, 'cancelled', 'done'), 'a cancelled action cannot be marked done');
  ok(
    transitionAllowed(GOAL_TRANSITIONS, 'achieved', 'in_progress'),
    'a mistaken "achieved" can be corrected — history keeps both',
  );
  ok(
    transitionAllowed(PLAN_TRANSITIONS, 'completed', 'archived') &&
      transitionAllowed(PLAN_TRANSITIONS, 'draft', 'active'),
    'the lifecycle a plan actually has is expressible',
  );

  ok(
    /plan owner or reviewer marked/i.test(ACHIEVED_MEANING) && /not a ScoutBox finding/i.test(ACHIEVED_MEANING),
    'achieved carries the sentence that says it is not a verified ability',
  );

  // ---- ownership and visibility cannot be crossed
  ok(PLAN_OWNER_KINDS.length === 2, 'a plan is owned by a player or an organisation, and by exactly one of them');
  N(39, !VISIBILITY_BY_OWNER.player.includes('org_private'), 'a player cannot mark their own plan club-private');
  N(40, !VISIBILITY_BY_OWNER.org.includes('shared_with_org'), 'a club cannot share its own plan with a second club');
  for (const v2 of [...VISIBILITY_BY_OWNER.player, ...VISIBILITY_BY_OWNER.org])
    ok(PLAN_VISIBILITY.includes(v2), `visibility "${v2}" is a known visibility`);
}

// =========================================================================
section('§2 — derived figures are counts, never a combined number');
{
  const acts = [
    { status: 'done' },
    { status: 'done' },
    { status: 'todo' },
    { status: 'cancelled' },
    { status: 'blocked' },
  ];
  const c = actionCounts(acts);
  ok(c.total === 5 && c.done === 2 && c.cancelled === 1, 'action counts are counts');
  const p = completionPhrase(c);
  // A cancelled action leaves the denominator: "2 of 5" where one was called
  // off is a worse answer than "2 of 4".
  ok(p.of === 4 && p.phrase === '2 of 4 actions completed', `completion is a sentence of counts: "${p.phrase}"`);
  N(
    16,
    !('percent' in p) && !('ratio' in p) && !('progress' in p),
    'the completion shape has no percentage, ratio or progress field for a client to render as one',
  );

  const summary = planSummary({
    plan: { nextReviewAt: NOW + 3 * DAY },
    goals: [
      {
        status: 'in_progress',
        actions: [{ status: 'todo', due: { state: 'overdue' } }],
        evidenceSummary: { available: 2 },
      },
      { status: 'achieved', actions: [], evidenceSummary: { available: 0 } },
    ],
    reviews: [{ reviewedAt: NOW - DAY }],
    now: NOW,
  });
  ok(
    summary.actionsOverdue === 1 && summary.goalsByStatus.achieved === 1,
    'the plan summary is deterministic and made of counts',
  );
  N(58, scanPayloadForForbiddenFields(summary).length === 0, 'the plan summary carries no forbidden field name');
  ok(/no overall figure/i.test(summary.note), 'the summary says out loud that there is no overall figure');

  // ---- read-time date semantics, and the absence of a scheduler
  ok(
    dueState(NOW - 2 * DAY, NOW).state === 'overdue' && dueState(NOW - 2 * DAY, NOW).days === 2,
    'overdue is a fact about a date',
  );
  ok(
    dueState(NOW, NOW).state === 'due_today' && dueState(null, NOW).state === 'no_due_date',
    'due today and no due date are distinct states',
  );
  ok(
    reviewDueState(NOW - DAY, NOW).state === 'review_overdue' &&
      reviewDueState(null, NOW).state === 'no_review_scheduled',
    'review due states are derived the same way',
  );
  ok(
    utcDay(Date.UTC(2026, 5, 15, 23, 59)) === utcDay(Date.UTC(2026, 5, 15, 0, 1)) && daysBetween(NOW, NOW + DAY) === 1,
    'dates are UTC calendar days — the shared date semantics, reused',
  );
  N(
    52,
    parseDate('not-a-date', { field: 'dueAt' }).error === 'DATE_INVALID',
    'a malformed date is refused, not repaired',
  );
  N(
    49,
    boundedText('x'.repeat(200), 120, { field: 'title' }).error === 'TEXT_TOO_LONG',
    'over-long text is refused, never silently truncated',
  );
}

// =========================================================================
section('§3 — objective targets: one comparison, three states, no formula');
{
  ok(
    TARGET_SOURCES.length === 1 && TARGET_SOURCES[0] === 'combine_attempt',
    'only a standardized Combine measurement can satisfy a target — stated, not implied',
  );
  ok(TARGET_STATES.length === 3, 'three target states and no fourth');

  const good = validateTarget({
    sourceType: 'combine_attempt',
    protocolId: 'combine-box-touch-60',
    operator: 'gte',
    value: 160,
  });
  ok(
    good.value?.protocolVersion === 1 && good.value.metricType === 'count',
    'a valid target pins its protocol version and takes the metric from the protocol',
  );

  N(
    14,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-make-believe', operator: 'gte', value: 1 })
      .error === 'TARGET_PROTOCOL_UNKNOWN',
    'an unsupported Combine protocol is refused',
  );
  N(
    14,
    validateTarget({
      sourceType: 'combine_attempt',
      protocolId: 'combine-box-touch-60',
      protocolVersion: 99,
      operator: 'gte',
      value: 1,
    }).error === 'TARGET_PROTOCOL_VERSION_UNKNOWN',
    'an unknown protocol version is refused',
  );
  N(
    54,
    validateTarget({
      sourceType: 'combine_attempt',
      protocolId: 'combine-box-touch-60',
      operator: 'approximately',
      value: 160,
    }).error === 'TARGET_OPERATOR_UNKNOWN',
    'a malformed target operator is refused',
  );
  N(
    54,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-touch-60', operator: 'lte', value: 160 })
      .error === 'TARGET_OPERATOR_INCOMPATIBLE',
    'an operator pointing the wrong way down the metric is refused — a target must not set out to get worse',
  );
  N(
    54,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-control-60', operator: 'eq', value: 30 })
      .error === 'TARGET_OPERATOR_INCOMPATIBLE',
    'exact equality on a sub-unit measurement is refused rather than stored unreachable',
  );
  N(
    55,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-touch-60', operator: 'gte', value: -5 })
      .error === 'TARGET_VALUE_INVALID',
    'a negative target value is refused',
  );
  N(
    55,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-touch-60', operator: 'gte', value: 160.5 })
      .error === 'TARGET_VALUE_INVALID',
    'a fractional value on a whole-number metric is refused',
  );
  N(
    55,
    validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-control-60', operator: 'gte', value: 80 })
      .error === 'TARGET_VALUE_OUT_OF_RANGE',
    '80 seconds of control inside a 60-second protocol is impossible, not ambitious',
  );
  N(
    55,
    validateTarget({
      sourceType: 'combine_attempt',
      protocolId: 'combine-box-touch-60',
      metricType: 'duration',
      operator: 'gte',
      value: 160,
    }).error === 'TARGET_METRIC_MISMATCH',
    'a client cannot rename the protocol’s metric',
  );
  neg(
    validateTarget({ sourceType: 'box_cam_session', protocolId: 'x', operator: 'gte', value: 1 }).error ===
      'TARGET_SOURCE_UNSUPPORTED',
    'a Box Cam session cannot satisfy a numeric target — observed training is not a measurement',
  );
  neg(validateTarget('160+').error === 'TARGET_MALFORMED', 'a target is a structure, not a string to parse');

  // ---- evaluation, and the four different absences
  const T = good.value;
  const attempt = (o) => ({
    id: o.id ?? 'catt-1',
    playerId: 'p1',
    protocolId: 'combine-box-touch-60',
    protocolVersion: 1,
    provider: o.provider ?? 'web_client',
    combineState: o.state ?? 'combine_verified',
    measuredValue: o.value ?? 165,
    boxSessionId: o.session ?? 'boxs-1',
    completedAt: o.at ?? NOW,
  });
  const sessions = [
    { id: 'boxs-1', verificationState: 'verified' },
    { id: 'boxs-bad', verificationState: 'invalidated' },
  ];

  const met = evaluateTarget({ target: T, attempts: [attempt({})], sessions });
  ok(
    met.state === 'target_met' && met.measured.value === 165,
    'a production-valid result above the threshold reads target_met',
  );
  ok(/decision for the plan owner or reviewer/i.test(met.note), '…and says the goal is still a human decision');
  N(
    56,
    !('goalStatus' in met) && !('achieved' in met),
    'the target evaluation cannot mark a goal achieved — it has no field for it',
  );

  const notMet = evaluateTarget({ target: T, attempts: [attempt({ value: 141 })], sessions });
  ok(
    notMet.state === 'target_not_met' && notMet.measured.value === 141,
    'a result below the threshold reads target_not_met',
  );
  ok(notMet.note !== met.note, 'met and not-met are different sentences, not the same one with a flag');

  const none = evaluateTarget({ target: T, attempts: [], sessions });
  ok(
    none.state === 'no_current_valid_measurement' && none.reason === 'no_attempts',
    'no attempt at all has its own reason',
  );
  N(
    13,
    evaluateTarget({ target: T, attempts: [attempt({ provider: 'local_test', value: 999 })], sessions }).state ===
      'no_current_valid_measurement',
    'a test-provider Combine result of 999 does NOT satisfy a production target',
  );
  ok(
    evaluateTarget({ target: T, attempts: [attempt({ provider: 'local_test', value: 999 })], sessions }).reason ===
      'no_production_valid_attempt',
    '…and the reason says a simulated result cannot satisfy one',
  );
  N(
    12,
    evaluateTarget({ target: T, attempts: [attempt({ session: 'boxs-bad' })], sessions }).state ===
      'no_current_valid_measurement',
    'an invalidated Combine result stops satisfying the target the moment it is invalidated',
  );
  ok(
    evaluateTarget({ target: T, attempts: [attempt({ session: 'boxs-bad' })], sessions }).reason ===
      'measurement_invalidated',
    '…and says so, rather than preserving a success the evidence withdrew',
  );
  ok(
    evaluateTarget({ target: T, attempts: [{ ...attempt({}), protocolVersion: 2 }], sessions }).reason ===
      'protocol_version_mismatch',
    'measurements are not compared across protocol versions',
  );
  for (const r of NO_MEASUREMENT_REASONS) ok(typeof r === 'string', `"${r}" is a distinct absence a coach can act on`);

  // ---- the production-validity predicate is the Combine module's, not a second copy
  ok(
    isProductionValidCombine(attempt({}), sessions[0], PROVIDERS.web_client) === true &&
      isProductionValidCombine(attempt({ provider: 'local_test' }), sessions[0], PROVIDERS.local_test) === false &&
      liveCombineState(attempt({}), sessions[1]) === 'invalidated',
    'the shared predicate answers all three cases the same way Box Cam does',
  );
  ok(compare(5, 'gte', 5) && !compare(4, 'gt', 4) && compare(3, 'lt', 4), 'the comparison itself is one pure function');
  ok(
    bestValidAttempt({
      attempts: [attempt({ id: 'a', value: 161 }), attempt({ id: 'b', value: 170 })],
      sessions,
      target: T,
    }).id === 'b',
    'best means best in the protocol’s own direction',
  );
  ok(TARGET_OPERATORS.length === 5, 'five operators, and no expression language');
}

// =========================================================================
section('§4 — evidence links hold references, and nothing else');
{
  ok(
    !EVIDENCE_LINK_FIELDS.some((f) => /label|title|value|note|summary|content|text/i.test(f)),
    `an evidence link may carry only ${EVIDENCE_LINK_FIELDS.length} id-and-provenance fields, none of them content`,
  );
  ok(EVIDENCE_SOURCES.length === 5, 'five canonical evidence sources, all of them read-only to the Development Hub');

  const player = { id: 'p1', name: 'A Player' };
  const other = { id: 'p2', name: 'Another' };
  const db = {
    evidence: [
      {
        id: 'evd-ok',
        playerId: 'p1',
        label: 'Season goals',
        verification: { status: 'coach_confirmed' },
        recordedAt: NOW - DAY,
      },
      {
        id: 'evd-sup',
        playerId: 'p1',
        label: 'Old',
        verification: { status: 'self_reported' },
        supersededBy: 'evd-ok',
      },
      {
        id: 'evd-exp',
        playerId: 'p1',
        label: 'Availability',
        verification: { status: 'self_reported' },
        expiresAt: NOW - DAY,
      },
      { id: 'evd-theirs', playerId: 'p2', label: 'Theirs', verification: { status: 'club_assessed' } },
    ],
    assessments: [
      {
        id: 'ass-pub',
        playerId: 'p1',
        orgId: 'org-a',
        state: 'submitted',
        publishedFeedback: 'Good week.',
        submittedAt: NOW - 2 * DAY,
      },
      {
        id: 'ass-priv',
        playerId: 'p1',
        orgId: 'org-a',
        state: 'submitted',
        publishedFeedback: null,
        submittedAt: NOW - 2 * DAY,
      },
    ],
    boxSessions: [{ id: 'boxs-1', playerId: 'p1', drillId: 'box-touches', provider: 'local_test', endedAt: NOW - DAY }],
    combineAttempts: [],
    trials: [{ id: 'trial-1', playerId: 'p1', orgId: 'org-a', status: 'reported', acceptedAt: NOW - 5 * DAY }],
  };
  const orgCanSee = () => true;
  const self = { kind: 'player_self', playerId: 'p1' };
  const orgA = { kind: 'org_staff', org: { id: 'org-a' } };
  const orgB = { kind: 'org_staff', org: { id: 'org-b' } };
  const R = (link, viewer) => resolveEvidenceLink(link, { db, player, viewer, orgCanSee, now: NOW });

  ok(
    R({ sourceType: 'passport_evidence', sourceId: 'evd-ok' }, self).available === true,
    'live Passport evidence resolves',
  );
  ok(
    R({ sourceType: 'passport_evidence', sourceId: 'evd-ok' }, self).provenance === 'verified_coach_confirmed',
    'provenance comes from the canonical Passport vocabulary — no new labels',
  );
  N(
    9,
    R({ sourceType: 'passport_evidence', sourceId: 'evd-theirs' }, self).reason === 'evidence_not_found',
    'evidence belonging to a different player cannot be resolved onto this plan',
  );
  N(
    10,
    recordBelongsToPlayer({ db, sourceType: 'passport_evidence', sourceId: 'evd-theirs', playerId: 'p1' }) === null,
    'the ownership check is one function, and it says no',
  );
  N(
    12,
    R({ sourceType: 'passport_evidence', sourceId: 'evd-sup' }, self).reason === 'evidence_superseded',
    'superseded evidence reads as superseded now, not as it was when linked',
  );
  N(
    12,
    R({ sourceType: 'passport_evidence', sourceId: 'evd-exp' }, self).reason === 'evidence_expired',
    'expired evidence reads as expired',
  );
  const gone = R({ sourceType: 'passport_evidence', sourceId: 'evd-sup' }, self);
  N(
    42,
    gone.title === undefined && gone.provenance === null && gone.occurredAt === null,
    'an unavailable item carries no title, no provenance and no date — an "unavailable" that leaks its subject is not unavailable',
  );
  N(
    11,
    R({ sourceType: 'assessment', sourceId: 'ass-priv' }, self).reason === 'evidence_not_visible',
    'an assessment the club never published is not readable by the player through a development link',
  );
  ok(
    R({ sourceType: 'assessment', sourceId: 'ass-pub' }, self).available === true,
    'published feedback IS readable — the sanctioned channel',
  );
  N(
    1,
    R({ sourceType: 'assessment', sourceId: 'ass-pub' }, orgB).reason === 'evidence_not_visible',
    'another organisation cannot read this club’s assessment through a development link',
  );
  ok(
    R({ sourceType: 'assessment', sourceId: 'ass-priv' }, orgA).available === true,
    'the owning club reads its own assessment',
  );
  const ass = R({ sourceType: 'assessment', sourceId: 'ass-pub' }, orgA);
  neg(
    !('ratings' in ass) && !('recommendation' in ass) && !('publishedFeedback' in ass),
    'the assessment link carries its existence, never its ratings, recommendation or feedback text',
  );
  N(
    11,
    R({ sourceType: 'trial_report', sourceId: 'trial-1' }, self).reason === 'evidence_not_visible',
    'a trial report is the club’s record — a development link never surfaces it to the player',
  );
  ok(
    R({ sourceType: 'trial_report', sourceId: 'trial-1' }, orgA).available === true,
    'the club that ran the trial can cite its own report',
  );
  ok(
    R({ sourceType: 'box_cam_session', sourceId: 'boxs-1' }, self).simulated === true,
    'a fixture-driven Box Cam session is labelled simulated wherever it appears',
  );
  N(
    57,
    !/hours|streak|volume|totalMinutes/i.test(
      JSON.stringify(R({ sourceType: 'box_cam_session', sourceId: 'boxs-1' }, self)),
    ),
    'a Box Cam link reports no hours, streak or volume that could become a progress figure',
  );
  neg(
    R({ sourceType: 'made_up', sourceId: 'x' }, self).available === false,
    'an unknown source type resolves to unavailable rather than throwing',
  );

  const s = summariseEvidence([
    { available: true, simulated: false },
    { available: false, simulated: false },
    { available: true, simulated: true },
  ]);
  ok(s.total === 3 && s.available === 2 && s.simulated === 1, 'the evidence summary is a count of items');
  N(
    61,
    !('confidence' in s) && !('score' in s) && !('strength' in s),
    'there is no evidence confidence, strength or score in the summary',
  );
}

// =========================================================================
section('§5 — access is one table, and the table refuses');
{
  ok(VIEWER_KINDS.length === 4, `four viewer contexts (${VIEWER_KINDS.join(', ')}) — no T&S and no agency`);
  N(38, !VIEWER_KINDS.includes('trust_safety'), 'Trust & Safety has no viewer context in the Development Hub');
  N(5, !VIEWER_KINDS.includes('agency'), 'an agency has no viewer context at all');
  ok(CAPABILITIES.length === 7, 'seven capabilities, each named where it is gated');

  const adult = { id: 'p1', name: 'Adult', isMinor: false };
  const minor = { id: 'p2', name: 'Minor', isMinor: true };
  const orgCanSee = () => true;
  const isLead = (u) => !!u?.lead;
  const playerPlan = (o = {}) => ({
    id: 'pl1',
    playerId: 'p1',
    owner: { kind: 'player', orgId: null },
    visibility: 'private',
    sharedWithOrgIds: [],
    ...o,
  });
  const orgPlan = (o = {}) => ({
    id: 'pl2',
    playerId: 'p1',
    owner: { kind: 'org', orgId: 'org-a' },
    visibility: 'org_private',
    ...o,
  });
  const A = (viewer, plan, player = adult) => planAccess(viewer, plan, { player, orgCanSee, isLead });

  const me = { kind: 'player_self', playerId: 'p1' };
  ok(A(me, playerPlan()).writeGoals && A(me, playerPlan()).manage, 'an adult manages their own plan');
  N(
    3,
    A({ kind: 'player_self', playerId: 'p9' }, playerPlan()).read === false,
    'a player cannot read another player’s plan',
  );
  N(
    36,
    A({ kind: 'player_self', playerId: 'p2' }, { ...playerPlan(), playerId: 'p2' }, minor).writeGoals === false,
    'a minor reads their own plan and does not write it — the existing safeguarding model, unchanged',
  );
  ok(
    A({ kind: 'player_self', playerId: 'p2' }, { ...playerPlan(), playerId: 'p2' }, minor).read === true,
    '…but they can read it, because it is about them',
  );

  const guardian = { kind: 'guardian', guardianId: 'g1', childIds: ['p2'] };
  ok(
    A(guardian, { ...playerPlan(), playerId: 'p2' }, minor).manage === true,
    'the guardian of a minor manages their plan',
  );
  N(4, A(guardian, playerPlan(), adult).read === false, 'a guardian cannot read an unrelated player’s plan');
  N(
    37,
    A({ kind: 'guardian', guardianId: 'g1', childIds: [] }, { ...playerPlan(), playerId: 'p2' }, minor).read === false,
    'a guardian who no longer owns the child gets nothing — childIds is read live',
  );
  N(
    37,
    A(guardian, { ...playerPlan(), playerId: 'p2' }, { ...minor, isMinor: false }).read === false,
    'once the player is an adult the guardian relationship confers nothing, whatever the stored list says',
  );

  const staffA = { kind: 'org_staff', org: { id: 'org-a' }, orgUser: { id: 'u1' }, isLead: false };
  const leadA = { kind: 'org_staff', org: { id: 'org-a' }, orgUser: { id: 'u2', lead: true }, isLead: true };
  const staffB = { kind: 'org_staff', org: { id: 'org-b' }, orgUser: { id: 'u3' }, isLead: true };
  ok(
    A(staffA, orgPlan()).writeGoals && A(staffA, orgPlan()).readInternal,
    'club staff work their own club’s plan and see its internal notes',
  );
  N(2, A(staffB, orgPlan()).read === false, 'a foreign organisation cannot read, let alone edit, this club’s plan');
  N(
    1,
    A(staffB, playerPlan({ visibility: 'shared_with_org', sharedWithOrgIds: ['org-a'] })).read === false,
    'a club the plan was not shared with gets nothing',
  );
  ok(
    A(staffA, playerPlan({ visibility: 'shared_with_org', sharedWithOrgIds: ['org-a'] })).read === true,
    'a club the player DID share with can read it',
  );
  N(
    2,
    A(staffA, playerPlan({ visibility: 'shared_with_org', sharedWithOrgIds: ['org-a'] })).writeGoals === false,
    '…and read is all it can do — a club never edits a plan it does not own',
  );
  N(
    41,
    A(staffA, playerPlan({ visibility: 'shared_with_org', sharedWithOrgIds: ['org-a'] })).readInternal === false,
    'a shared player plan grants no internal access',
  );
  ok(
    A(leadA, orgPlan()).manage === true && A(staffA, orgPlan()).manage === false,
    'archiving and visibility are lead decisions, as they are for a Room',
  );
  N(
    34,
    planAccess(staffA, orgPlan(), { player: adult, orgCanSee: () => false, isLead }).read === false,
    'a blocked or newly invisible player removes access here at the same instant it removes it everywhere',
  );
  N(40, A(me, orgPlan()).read === false, 'a club-private plan does not exist for the player');
  ok(
    A(me, orgPlan({ visibility: 'player_guardian' })).read === true &&
      A(me, orgPlan({ visibility: 'player_guardian' })).writeGoals === false,
    'a shared club plan is readable by the player and not editable',
  );

  // ---- assignment
  const staff = [
    { id: 'u1', orgId: 'org-a', removedAt: null },
    { id: 'u9', orgId: 'org-b', removedAt: null },
    { id: 'u-gone', orgId: 'org-a', removedAt: NOW },
  ];
  const dbUsers = { guardians: [{ id: 'g1', childIds: ['p2'] }] };
  const staffById = (id) => staff.find((u) => u.id === id) ?? null;
  N(
    31,
    canAssign({ assignee: { kind: 'org_user', id: 'u9' }, plan: orgPlan(), player: adult, db: dbUsers, staffById })
      .error === 'ASSIGNEE_INVALID',
    'a colleague in another organisation cannot be assigned an action',
  );
  N(
    32,
    canAssign({ assignee: { kind: 'org_user', id: 'u-gone' }, plan: orgPlan(), player: adult, db: dbUsers, staffById })
      .error === 'ASSIGNEE_INVALID',
    'a removed member of staff is not an assignee',
  );
  ok(
    canAssign({ assignee: { kind: 'org_user', id: 'u1' }, plan: orgPlan(), player: adult, db: dbUsers, staffById })
      .value?.id === 'u1',
    'current staff of the owning club can be assigned',
  );
  ok(
    canAssign({ assignee: { kind: 'player', id: 'p1' }, plan: orgPlan(), player: adult, db: dbUsers, staffById }).value
      ?.kind === 'player',
    'the player can be the assignee',
  );
  neg(
    canAssign({
      assignee: { kind: 'guardian', id: 'g1' },
      plan: { ...orgPlan(), playerId: 'p2' },
      player: adult,
      db: dbUsers,
      staffById,
    }).error === 'ASSIGNEE_INVALID',
    'a guardian cannot be assigned an adult player’s actions',
  );

  // ---- the review view strips by capability, once
  const review = {
    id: 'r1',
    planId: 'pl2',
    reviewerKind: 'coach_review',
    reviewedBy: { name: 'A Coach' },
    reviewedAt: NOW,
    sharedSummary: 'Good week.',
    internalNote: 'SECRET-CLUB-NOTE',
    goalSnapshots: [],
    sharedWithPlayerAt: null,
  };
  const clubView = reviewView(review, { readInternal: true });
  const playerVw = reviewView(review, { readInternal: false });
  ok(clubView.internalNote === 'SECRET-CLUB-NOTE', 'the club reads its own note');
  N(
    41,
    playerVw.internalNote === null && !JSON.stringify(playerVw).includes('SECRET-CLUB-NOTE'),
    'the internal note is absent from the player’s view of the review, not merely hidden',
  );
  N(41, playerVw.summary === null, 'and an unshared summary is not shown either');
  ok(
    playerVw.internalNoteNote != null,
    'the EXISTENCE of a club note is acknowledged — pretending nothing was written is its own dishonesty',
  );
  ok(
    reviewView({ ...review, sharedWithPlayerAt: NOW }, { readInternal: false }).summary === 'Good week.',
    'an explicitly shared summary IS shown',
  );
  ok(
    REVIEWER_KINDS.length === 3 && SHARE_SCOPES.length === 3,
    'three reviewer kinds and three share scopes — no "share everything"',
  );
}

// =========================================================================
section('§6 — the timeline is meaningful events, and the stores are workflow');
{
  const plan = {
    id: 'pl1',
    title: 'Plan',
    history: [
      { id: 'a1', at: NOW, action: 'plan_created', byKind: 'org', byName: 'Coach' },
      {
        id: 'a2',
        at: NOW + 1,
        action: 'plan_visibility_changed',
        byKind: 'org',
        byName: 'Coach',
        detail: { to: 'player_guardian' },
      },
      { id: 'a3', at: NOW + 2, action: 'plan_read', byKind: 'org', byName: 'Coach' },
    ],
  };
  const goals = [
    {
      id: 'g1',
      title: 'Goal',
      history: [{ id: 'a4', at: NOW + 3, action: 'goal_created', byKind: 'org', byName: 'Coach' }],
    },
  ];
  const openTl = buildTimeline({ plan, goals, actions: [], reviews: [], access: { readInternal: true } });
  const shutTl = buildTimeline({ plan, goals, actions: [], reviews: [], access: { readInternal: false } });
  N(
    42,
    !openTl.some((e) => e.action === 'plan_read'),
    'a read is not a timeline event — the Hub is not an activity feed',
  );
  N(
    75,
    !shutTl.some((e) => e.action === 'plan_visibility_changed'),
    'an organisation-internal timeline entry does not reach a viewer without internal access',
  );
  ok(openTl.length === 3 && openTl[0].at >= openTl[1].at, 'the timeline is newest-first and complete for the club');
  N(
    43,
    !JSON.stringify(openTl).includes('SECRET'),
    'the timeline carries no note text — `detail` is written by the server, never by a person',
  );
  for (const [name, def] of Object.entries(TIMELINE_ACTIONS))
    ok(
      typeof def.label === 'string' && typeof def.internal === 'boolean',
      `timeline action "${name}" declares a label and an audience`,
    );

  // ---- goal snapshots record the plan, never the Passport
  const snaps = buildGoalSnapshots({
    goals: [{ id: 'g1', title: 'Goal', category: 'technical', status: 'in_progress', createdAt: NOW, target: null }],
    actions: [
      { goalId: 'g1', status: 'done' },
      { goalId: 'g1', status: 'todo' },
    ],
    links: [{ goalId: 'g1', sourceType: 'assessment', sourceId: 'ass-1' }],
    attempts: [],
    sessions: [],
  });
  ok(snaps[0].completion.phrase === '1 of 2 actions completed', 'a snapshot records what the reviewer saw of the plan');
  N(
    74,
    !('passport' in snaps[0]) && !('evidence' in snaps[0]) && Array.isArray(snaps[0].evidenceRefs),
    'a review snapshot holds evidence REFERENCES, never a copy of the Passport',
  );
  N(
    74,
    snaps[0].evidenceRefs.every((r) => Object.keys(r).length === 2),
    'and each reference is a type and an id, nothing else',
  );

  const paged = pageReviews(
    [
      { id: 'r1', reviewedAt: 3 },
      { id: 'r2', reviewedAt: 2 },
      { id: 'r3', reviewedAt: 1 },
    ],
    { limit: 2 },
  );
  ok(
    paged.value.items.length === 2 && paged.value.nextCursor === 'r2',
    'reviews page newest-first with a stable cursor',
  );
  N(
    67,
    pageReviews([], { limit: 2, cursor: 'nope' }).error === 'REVIEW_CURSOR_INVALID',
    'a malformed pagination cursor is refused, not ignored',
  );
  ok(
    pageReviews(
      Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, reviewedAt: i })),
      { limit: 999 },
    ).value.items.length === DEVELOPMENT_HUB_LIMITS.reviewsPageMax,
    `a page is capped at ${DEVELOPMENT_HUB_LIMITS.reviewsPageMax} however large a limit is asked for`,
  );
}

// =========================================================================
section('§7 — migration, stores and the clean-boot proof');
{
  // The stores are tables created by data migration 0030; the checks read the table migrations recorded in a fresh
  // file.
  ok(
    DATA_MIGRATIONS.filter((m) => m.id === DEVELOPMENT_MIGRATION).length === 1,
    `the development tables come from data migration ${DEVELOPMENT_MIGRATION}, registered once`,
  );
  ok(SCHEMA_VERSION >= 30, `the schema is at or beyond 30 (${SCHEMA_VERSION})`);
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m21-fresh-'));
  const recorded = (dir) => {
    const st = openLayer(dir);
    try {
      return st.sqlite
        .prepare('SELECT id, applied_at FROM data_migrations WHERE id = ?')
        .all(DEVELOPMENT_MIGRATION)
        .map((r) => `${r.id}@${r.applied_at}`);
    } finally {
      st.close();
    }
  };
  const first = recorded(freshDir);
  const fresh = readRecords(freshDir);
  for (const s of DEVELOPMENT_HUB_STORES)
    neg(Array.isArray(fresh[s]) && fresh[s].length === 0, `a clean database holds db.${s} as an empty table`);
  ok(first.length === 1 && recorded(freshDir).join() === first.join(), 'a second open applies no migration again');
  ok(
    DEVELOPMENT_HUB_STORES.every((s) => DEVELOPMENT_COLLECTIONS.includes(s)),
    'every Development Hub store is a collection of the development repository',
  );

  // Rate limits are in the one table, and generous enough not to punish work.
  for (const a of ['development_plan_write', 'development_item_write', 'development_review_write']) {
    ok(
      !!RATE_LIMIT_POLICY[a] && RATE_LIMIT_POLICY[a].scope === 'actor',
      `${a} is named in the central policy table, actor-scoped`,
    );
  }
  ok(
    RATE_LIMIT_POLICY.development_item_write.max >= 300,
    'the item limit is generous — being told to slow down for doing the work is the wrong message from a development tool',
  );

  // Events: registered, org-private, ids only.
  const hubEvents = EVENT_NAMES.filter((n) => n.startsWith('development_'));
  ok(hubEvents.length === 8, `all eight Development Hub events are in the canonical registry (${hubEvents.length})`);
  for (const e of hubEvents) {
    const def = EVENT_REGISTRY[e];
    N(65, def.audience === 'org_private', `${e} is organisation-private`);
    N(
      66,
      def.payload.every((k) => /Id$/.test(k)),
      `${e} carries ids only, never content`,
    );
    neg(
      def.analyticsEligible === false,
      `${e} is not analytics-eligible — recruitment analytics gains no development ranking`,
    );
  }
  N(
    66,
    assertEventRegistry({ emitted: hubEvents, mode: 'production' }).length === 0,
    'the registry assertion passes for the Development Hub names',
  );
  N(
    66,
    assertEventRegistry({ emitted: ['development_made_up'], mode: 'production' }).length > 0,
    'an unregistered development event fails closed',
  );

  // Notifications: one category, and mandatory categories untouched.
  ok(
    !!CATEGORIES.development_updates && CATEGORIES.development_updates.mandatory === false,
    'one development notification category, and it can be turned off',
  );
  ok(Object.keys(CATEGORIES).filter((c) => c.startsWith('development')).length === 1, 'exactly one, not three');
  ok(
    TYPE_CATEGORY.development === 'development_updates' && categoryOf('development') === 'development_updates',
    'the development notification type maps to it',
  );
  ok(
    CATEGORIES.security_account.mandatory === true,
    'security_account is still mandatory — the Development Hub changed nothing there',
  );
}

// =========================================================================
section('§8 — the client cannot assert what the server derives');
{
  for (const f of ['targetMet', 'progress', 'evidenceConfidence', 'verified', 'developmentScore']) {
    N(15, refusedClientFields({ [f]: true }).length === 1, `a client body carrying "${f}" is refused`);
  }
  N(16, refusedClientFields({ progressPercent: 60 }).length === 1, 'a forged progress percentage is refused');
  N(17, refusedClientFields({ verifiedEvidence: true }).length === 1, 'a client cannot mark evidence verified');
  ok(refusedClientFields({ title: 'Fine', category: 'technical' }).length === 0, 'an ordinary body passes through');
  ok(
    FORBIDDEN_FIELD_NAMES.length >= 20,
    'the refused-field list is broader than the names the mandate lists, because the failure mode is a synonym',
  );
}

// =========================================================================
section('§17 — the target engine reads a production-valid measurement');
{
  ok(
    evaluateTarget({
      target: validateTarget({
        sourceType: 'combine_attempt',
        protocolId: 'combine-box-control-60',
        operator: 'gte',
        value: 30,
      }).value,
      attempts: [
        {
          id: 'a',
          playerId: 'p',
          protocolId: 'combine-box-control-60',
          protocolVersion: 1,
          provider: 'web_client',
          combineState: 'combine_verified',
          measuredValue: 41,
          boxSessionId: 's',
          completedAt: NOW,
        },
      ],
      sessions: [{ id: 's', verificationState: 'verified' }],
    }).state === 'target_met',
    'the engine DOES read target_met the moment a production-valid measurement exists — the gap is the detector, not the logic',
  );
}

// =========================================================================
section('summary');
{
  // The battery runs the other numbered cases.
  const mine = [
    1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 31, 32, 34, 36, 37, 38, 39, 40, 41, 42, 43, 48, 49, 52, 54,
    55, 56, 57, 58, 59, 61, 65, 66, 67, 74, 75,
  ];
  const missing = mine.filter((n) => !seenNeg.has(n));
  ok(
    missing.length === 0,
    `this suite's numbered negative cases ran${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
  );
}
done();
