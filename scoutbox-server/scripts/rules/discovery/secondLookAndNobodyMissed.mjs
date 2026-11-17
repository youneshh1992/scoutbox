// The Second Look and Nobody Missed engine behind the discovery battery (e2e/discovery/secondLookAndNobodyMissed.mjs),
// checked in this process: the policy and its change types, reason-aware matching, fingerprints and the change window,
// candidate assembly (S1–S8), the item lifecycle, snapshot comparison, brief validation and deterministic matching
// (the N scenarios).
import { playerMatchesBrief } from '../../../domains/discovery/matching/match.mjs';
import {
  SECOND_LOOK_POLICY_VERSION,
  EVALUATION_COVERAGE_POLICY_VERSION,
  CHANGE_TYPES,
  NEGATIVE_CHANGE_TYPES,
  CHANGE_COPY,
  REASON_CHANGE_MAP,
  CLUB_SIDE_REASONS,
  POLICY,
  SECOND_LOOK_STATUSES,
  canSecondLookTransition,
  SECOND_LOOK_KIND_COPY,
  DISMISSAL_REASONS,
  FORBIDDEN_COPY,
  normalizeMaterialChange,
  changeFingerprint,
  dedupeMaterialChanges,
  changesSinceDecision,
  secondLookReasonMatch,
  meetsGeneralThreshold,
  compareToSnapshot,
  trustLevelChanges,
  buildSecondLookCandidate,
  secondLookStatus,
  secondLookExpired,
  orderSecondLook,
  EVALUATION_SIGNALS,
  NON_EVALUATION_SIGNALS,
  COVERAGE_POLICY,
  isMeaningfullyEvaluated,
  BRIEF_STATUSES,
  canBriefTransition,
  validateRecruitmentBrief,
  explainBriefCriteria,
  buildNobodyMissedCandidate,
  evaluationCoverageState,
  orderNobodyMissed,
  PROHIBITED_BRIEF_FIELDS,
  POSITIONS,
  POSITION_GROUP_OF,
  TRUST_BANDS,
  NM_DISMISSAL_REASONS,
  NM_SORTS,
  LIMITS,
  clampPage,
  safeM18Projection,
} from '../../../domains/discovery/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('discovery/secondLookAndNobodyMissed');

const NOW = Date.now();
const DAY = 86_400_000;
const mk = (type, sourceId, agoDays, sys = 'evidence') =>
  normalizeMaterialChange({ type, subjectId: 'pl-1', sourceSystem: sys, sourceId, occurredAt: NOW - agoDays * DAY });
const archivedRoom = { id: 'case-1', orgId: 'o1', playerId: 'pl-1', room: { status: 'archived' } };
const dec = (reasonCodes, agoDays = 10) => ({ id: 'd1', createdAt: NOW - agoDays * DAY, reasonCodes });

// ============================================ U1 policy and change types
section('U1 — the policy is total, versioned and internally consistent');
{
  ok(SECOND_LOOK_POLICY_VERSION === 1 && EVALUATION_COVERAGE_POLICY_VERSION === 1, 'both policies are versioned');
  ok(CHANGE_TYPES.length === 17, 'seventeen normalized change types (including combine_verified_restored)');
  ok(
    CHANGE_TYPES.every((t) => CHANGE_COPY[t]),
    'every change type has human copy',
  );
  ok(
    NEGATIVE_CHANGE_TYPES.every((t) => CHANGE_TYPES.includes(t)),
    'every negative type is a real type',
  );
  for (const [reason, types] of Object.entries(REASON_CHANGE_MAP)) {
    ok(
      types.every((t) => CHANGE_TYPES.includes(t)),
      `reason "${reason}" maps only to real change types`,
    );
  }
  // The copy sweep: Second Look may never tell a club it was wrong.
  const allCopy = [...Object.values(CHANGE_COPY), ...Object.values(SECOND_LOOK_KIND_COPY), COVERAGE_POLICY.note]
    .join(' ')
    .toLowerCase();
  for (const banned of FORBIDDEN_COPY) neg(!allCopy.includes(banned), `product copy never says "${banned}"`);
  neg(
    !/scout quality|recruitment quality|scouting score|fairness score/i.test(COVERAGE_POLICY.note),
    'coverage is never renamed as a quality or fairness score',
  );
  ok(/not a measure of scouting quality/i.test(COVERAGE_POLICY.note), 'the coverage note says outright what it is not');
}

// ================================================ U2 reason-aware matching
section('U2 — reason-aware matching, strict in both directions');
{
  const fullMatch = mk('full_match_added', 'evd-1', 1);
  ok(
    secondLookReasonMatch(fullMatch, ['insufficient_recent_evidence']).length === 1,
    'a full match resolves "insufficient recent evidence"',
  );
  ok(
    secondLookReasonMatch(mk('verified_reference_added', 'vr-1', 1, 'reference'), ['reference_missing']).length === 1,
    'a verified reference resolves "reference missing"',
  );
  ok(
    secondLookReasonMatch(mk('combine_verified_added', 'p@1', 1, 'combine'), ['combine_missing']).length === 1,
    'a Combine Verified result resolves "combine missing"',
  );
  ok(
    secondLookReasonMatch(mk('trial_completed', 't-1', 1, 'trial'), ['trial_needed']).length === 1,
    'a completed trial resolves "trial needed"',
  );

  // The whole point: club-side reasons are never resolved by player evidence.
  for (const reason of ['squad_space', 'budget', 'timing', 'registration', 'travel_logistics', 'eligibility']) {
    neg(secondLookReasonMatch(fullMatch, [reason]).length === 0, `a new full match does NOT resolve "${reason}"`);
    neg(
      secondLookReasonMatch(mk('verified_reference_added', 'vr-2', 1, 'reference'), [reason]).length === 0,
      `a new reference does NOT resolve "${reason}"`,
    );
    neg(CLUB_SIDE_REASONS.includes(reason), `"${reason}" is recorded as a club-side reason`);
  }
  neg(
    secondLookReasonMatch(mk('verified_reference_added', 'vr-3', 1, 'reference'), ['tactical_fit']).length === 0,
    'an unrelated reference does not resolve a tactical-fit judgement',
  );
  neg(
    secondLookReasonMatch(mk('evidence_added', 'evd-2', 1), ['tactical_fit']).length === 0,
    'unrelated evidence does not resolve a tactical-fit judgement',
  );
  ok(
    secondLookReasonMatch(mk('full_match_added', 'evd-3', 1), ['tactical_fit']).length === 1,
    'a full match CAN revisit a tactical-fit judgement',
  );
  neg(
    secondLookReasonMatch(mk('evidence_added', 'evd-4', 1), ['not_current_priority']).length === 0,
    'a minor update does not revisit "not a current priority"',
  );
  ok(
    secondLookReasonMatch(mk('full_match_added', 'evd-5', 1), ['not_current_priority']).length === 1,
    'substantial evidence does revisit "not a current priority"',
  );
}

// ====================================== U3 fingerprints, dedupe, windows
section('U3 — fingerprints, deduplication and the change window');
{
  const a = mk('combine_verified_added', 'box_touch_60@1', 2, 'combine');
  const b = mk('combine_verified_added', 'box_touch_60@1', 1, 'combine');
  ok(a.fingerprint === b.fingerprint, 'the same source fact has the same fingerprint whenever it is observed');
  neg(
    a.fingerprint !== mk('combine_verified_added', 'box_juggle@1', 1, 'combine').fingerprint,
    'a different protocol is a different fingerprint',
  );
  ok(
    changeFingerprint({ type: 'x', sourceSystem: 'y', sourceId: null }) === 'x:y:none',
    'a missing source id still yields a stable fingerprint',
  );

  // One real change reaching Second Look through several
  // projections must produce ONE change, not three alerts.
  const viaThree = dedupeMaterialChanges([a, b, mk('combine_verified_added', 'box_touch_60@1', 3, 'combine')]);
  neg(viaThree.length === 1, 'the same Combine result seen through three projections deduplicates to one change');
  ok(
    viaThree[0].occurredAt === NOW - 3 * DAY,
    'deduplication keeps the earliest observation, so the timeline stays honest',
  );

  const d = dec(['insufficient_recent_evidence'], 10);
  neg(
    changesSinceDecision([mk('full_match_added', 'evd-old', 20)], d.createdAt).length === 0,
    'evidence that predates the decision is not news',
  );
  ok(
    changesSinceDecision([mk('full_match_added', 'evd-new', 5)], d.createdAt).length === 1,
    'evidence after the decision counts',
  );
  const future = normalizeMaterialChange({
    type: 'full_match_added',
    subjectId: 'pl-1',
    sourceSystem: 'evidence',
    sourceId: 'evd-f',
    occurredAt: NOW + 10 * DAY,
  });
  neg(
    changesSinceDecision([future], d.createdAt).length === 0,
    'a future timestamp is a forged or broken event and is discarded',
  );
  neg(
    normalizeMaterialChange({
      type: 'not_a_type',
      subjectId: 'p',
      sourceSystem: 's',
      sourceId: 'i',
      occurredAt: NOW,
    }) === null,
    'an unknown change type is refused',
  );
  neg(
    normalizeMaterialChange({
      type: 'full_match_added',
      subjectId: 'p',
      sourceSystem: 's',
      sourceId: 'i',
      occurredAt: null,
    }) === null,
    'a change with no clock is refused',
  );
}

// ======================================== U4 candidate assembly, S1–S8
section('U4 — candidate assembly, the scenarios S1–S8');
{
  // S1
  const s1 = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['insufficient_recent_evidence']),
    changes: [mk('full_match_added', 'evd-9', 5)],
  });
  ok(
    s1 && s1.kind === 'direct_reason_resolved' && s1.strength === 'direct',
    'S1: a full match after an insufficient-evidence archive is a direct Second Look',
  );
  ok(s1.directReasonCodes.includes('insufficient_recent_evidence'), 'S1: the item names the reason it relates to');
  ok(
    /relates to the reason recorded/i.test(s1.summary),
    'S1: the summary says how it relates — it does not judge the decision',
  );
  neg(
    !FORBIDDEN_COPY.some((f) => s1.summary.toLowerCase().includes(f)),
    'S1: the summary never says the decision was wrong',
  );

  // S2
  const s2 = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['squad_space']),
    changes: [mk('full_match_added', 'evd-9', 5)],
  });
  neg(
    s2.strength === 'general' && s2.directReasonCodes.length === 0,
    'S2: a full match after a squad-space archive resolves nothing directly',
  );
  ok(s2.unresolvedReasonCodes.includes('squad_space'), 'S2: the squad-space reason is reported as still standing');
  neg(
    buildSecondLookCandidate({
      room: archivedRoom,
      decision: dec(['squad_space']),
      changes: [mk('evidence_added', 'evd-3', 5)],
    }) === null,
    'S2: one minor change against a club-side reason surfaces nothing at all',
  );

  // S3
  const s3 = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['reference_missing']),
    changes: [mk('verified_reference_added', 'vref-1', 3, 'reference')],
  });
  ok(s3.kind === 'direct_reason_resolved', 'S3: a verified reference after a reference-missing archive is direct');

  // S5
  const s5 = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['squad_space']),
    changes: [mk('verified_reference_revoked', 'vref-2', 2, 'reference')],
  });
  ok(
    s5.kind === 'evidence_removed' && SECOND_LOOK_KIND_COPY[s5.kind] === 'Evidence Changed',
    'S5: a revoked reference reads as "Evidence Changed"',
  );
  neg(!/no longer/i.test(s5.summary) === false, 'S5: the copy says a source is no longer current');
  neg(!/dishonest|false|lied|fraud|misled/i.test(JSON.stringify(s5)), 'S5: nothing accuses the player of anything');

  // S6 — grouping
  const s6 = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['insufficient_recent_evidence']),
    changes: [
      mk('full_match_added', 'evd-a', 5),
      mk('verified_reference_added', 'vref-3', 4, 'reference'),
      mk('current_club_confirmed', 'sq-1', 3, 'club'),
    ],
    trustMovement: [{ component: 'references', code: 'REFERENCE_CONFIRMED', direction: 'up' }],
  });
  ok(s6.changeCount === 3, 'S6: three underlying changes become ONE grouped item, not three alerts');
  ok(s6.trustMovement.length === 1, 'S6: Trust movement rides along as supporting context');
  neg(
    !/trust|score|\d+ points/i.test(s6.summary),
    'S6: the summary is about the underlying facts, never "the score went up"',
  );

  // A Trust movement with no underlying change is not a trigger at all.
  neg(
    buildSecondLookCandidate({
      room: archivedRoom,
      decision: dec(['insufficient_recent_evidence']),
      changes: [],
      trustMovement: [{ component: 'evidence', code: 'X', direction: 'up' }],
    }) === null,
    'a Trust Score movement on its own never creates a Second Look',
  );

  // Preconditions
  neg(
    buildSecondLookCandidate({
      room: archivedRoom,
      decision: dec(['insufficient_recent_evidence']),
      changes: [mk('full_match_added', 'e', 5)],
      playerVisible: false,
    }) === null,
    'an invisible player never becomes a candidate',
  );
  neg(
    buildSecondLookCandidate({
      room: { ...archivedRoom, room: { status: 'under_review' } },
      decision: dec(['x']),
      changes: [mk('full_match_added', 'e', 5)],
    }) === null,
    'an open room is active work, not a Second Look',
  );
  neg(
    buildSecondLookCandidate({ room: archivedRoom, decision: null, changes: [mk('full_match_added', 'e', 5)] }) ===
      null,
    'no prior decision means no Second Look',
  );
}

// ============================================ U5 lifecycle and cooldown
section('U5 — lifecycle, cooldown and the fingerprint rule');
{
  ok(SECOND_LOOK_STATUSES.length === 5, 'five lifecycle states');
  ok(
    canSecondLookTransition('open', 'dismissed') && canSecondLookTransition('open', 'reopened_room'),
    'the ordinary paths work',
  );
  neg(!canSecondLookTransition('reopened_room', 'open'), 'once the club acted, the item is terminal');
  neg(!canSecondLookTransition('dismissed', 'reviewed'), 'a dismissed item cannot be marked reviewed');

  const cand = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['insufficient_recent_evidence']),
    changes: [mk('full_match_added', 'evd-1', 5)],
  });
  ok(secondLookStatus({ existing: null, candidate: cand }).action === 'create', 'a new candidate creates an item');

  // The same evidence must never regenerate a handled item, no matter
  // which projection it arrives through.
  const dismissed = { status: 'dismissed', changeFingerprints: cand.changeFingerprints, dismissedAt: NOW };
  neg(
    secondLookStatus({ existing: dismissed, candidate: cand }).action === 'suppress',
    'the SAME evidence does not resurface a dismissed item',
  );
  neg(
    secondLookStatus({ existing: dismissed, candidate: cand }).reason === 'same_evidence_already_handled',
    'the suppression names the fingerprint rule',
  );

  // Genuinely different later evidence may resurface it immediately.
  const later = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['insufficient_recent_evidence']),
    changes: [mk('full_match_added', 'evd-1', 5), mk('full_match_added', 'evd-2', 1)],
  });
  ok(
    secondLookStatus({ existing: dismissed, candidate: later }).action === 'reopen',
    'a genuinely different later full match may resurface it',
  );
  // A trivial new change inside the cooldown does not.
  const trivial = buildSecondLookCandidate({
    room: archivedRoom,
    decision: dec(['insufficient_recent_evidence']),
    changes: [mk('full_match_added', 'evd-1', 5), mk('evidence_added', 'evd-3', 1)],
  });
  neg(
    secondLookStatus({ existing: dismissed, candidate: trivial }).action === 'suppress',
    'a trivial new change inside the cooldown does not resurface it',
  );
  neg(
    secondLookStatus({ existing: { status: 'reopened_room', changeFingerprints: [] }, candidate: later }).action ===
      'suppress',
    'nothing resurfaces after the club reopened the room',
  );
  ok(POLICY.cooldownDays === 30 && POLICY.expiryDays === 120, 'the cooldown and expiry windows are centralized');
  ok(secondLookExpired({ status: 'open', latestChangeAt: NOW - 200 * DAY }), 'a stale open item expires');
  neg(
    !secondLookExpired({ status: 'dismissed', latestChangeAt: NOW - 200 * DAY }),
    'expiry only applies to open items',
  );

  const ordered = orderSecondLook([
    { id: 'b', kind: 'general_update', latestChangeAt: NOW },
    { id: 'a', kind: 'direct_reason_resolved', latestChangeAt: NOW - DAY },
  ]);
  ok(ordered[0].id === 'a', 'direct relevance is ordered before a newer general update');
  neg(!('priority' in ordered[0]) && !('score' in ordered[0]), 'ordering uses categories, never a priority score');
}

// ======================================== U6 snapshot comparison honesty
section('U6 — snapshot comparison never invents a previous value');
{
  const none = compareToSnapshot(null, {
    evidenceIds: ['a'],
    combineResults: [],
    assessmentIds: [],
    trialIds: [],
    references: 1,
    trust: { score: 80, band: 'strong_evidence' },
  });
  neg(
    none.available === false && /Previous detail unavailable/i.test(none.note),
    'with no snapshot the comparison says so rather than guessing',
  );
  neg(
    none.rows.every((r) => r.was === null),
    'no row invents a previous value',
  );
  neg(
    none.rows.every((r) => r.available === false),
    'every row is explicitly marked unavailable',
  );

  const snap = {
    at: NOW - 10 * DAY,
    trust: { score: 68, band: 'established_evidence', componentLevels: { references: 'none' } },
    sourceRefs: { evidenceIds: ['e1'], assessmentIds: [], combineResults: [], trialIds: [] },
  };
  const cmp = compareToSnapshot(snap, {
    evidenceIds: ['e1', 'e2'],
    combineResults: [],
    assessmentIds: [],
    trialIds: [],
    references: 1,
    trust: { score: 82, band: 'strong_evidence' },
  });
  ok(cmp.available === true, 'a recorded snapshot is used');
  const ev = cmp.rows.find((r) => r.key === 'evidence');
  ok(ev.was === 1 && ev.now === 2 && ev.changed === true, 'the evidence row shows the real before and after');
  const refs = cmp.rows.find((r) => r.key === 'references');
  neg(refs.available === false && refs.was === null, 'a field the snapshot never recorded is unavailable, NOT zero');

  const moved = trustLevelChanges(snap.trust, { components: { references: { level: { id: 'established' } } } });
  ok(
    moved[0]?.code === 'REFERENCE_CONFIRMED' && moved[0].direction === 'up',
    'Trust movement is derived from component levels, keeping the existing vocabulary',
  );
  neg(trustLevelChanges(null, {}).length === 0, 'no snapshot means no claimed Trust movement');
}

// ================================== U7 evaluation policy and briefs
section('U7 — evaluation policy, brief validation and matching');
{
  ok(EVALUATION_SIGNALS.length === 9, 'nine signals count as meaningful evaluation');
  ok(NON_EVALUATION_SIGNALS.length === 3, 'three signals are explicitly recorded as NOT evaluation');
  for (const s of NON_EVALUATION_SIGNALS)
    neg(!EVALUATION_SIGNALS.some((e) => e.key === s.key), `"${s.key}" is not treated as evaluation`);
  neg(
    isMeaningfullyEvaluated({ profile_view: true, search_impression: true, passport_view: true }).evaluated === false,
    'viewing a profile, a search result and a Passport is still NOT an evaluation',
  );
  ok(isMeaningfullyEvaluated({ assessment_submitted: true }).evaluated, 'a submitted assessment is an evaluation');
  ok(
    isMeaningfullyEvaluated({ room_decided: true, lastDecisionAt: NOW - DAY }).recentlyDecided,
    'a decision yesterday is flagged as recent',
  );
  neg(
    isMeaningfullyEvaluated({ room_decided: true, lastDecisionAt: NOW - 200 * DAY }).recentlyDecided === false,
    'a decision 200 days ago is not recent',
  );

  ok(BRIEF_STATUSES.length === 5 && canBriefTransition('draft', 'active'), 'five brief states with a transition table');
  neg(!canBriefTransition('archived', 'active'), 'an archived brief cannot be reactivated');
  neg(!canBriefTransition('draft', 'paused'), 'a draft cannot be paused');

  // Protected characteristics and their proxies.
  for (const bad of [
    'race',
    'ethnicity',
    'religion',
    'sexual_orientation',
    'disability',
    'family_income',
    'school_type',
    'postcode_deprivation',
    'physical_maturity',
    'national_origin',
  ]) {
    const r = validateRecruitmentBrief({ title: 'x', [bad]: 'y' });
    neg(!r.ok && r.error === 'BRIEF_CRITERION_PROHIBITED', `a brief can never filter by "${bad}"`);
  }
  neg(
    PROHIBITED_BRIEF_FIELDS.length >= 20,
    'the prohibited list covers the protected characteristics and their proxies',
  );

  // Invalid briefs are refused, never silently repaired.
  const bad = (input, code) => {
    const r = validateRecruitmentBrief({ title: 'Brief', ...input });
    neg(!r.ok && (r.error === code || r.details?.some((d) => d.error === code)), `refused: ${code}`);
  };
  bad({ minAge: 20, maxAge: 16 }, 'BRIEF_AGE_RANGE_INVALID');
  bad({ minAge: 2 }, 'BRIEF_AGE_INVALID');
  bad({ radiusKm: -5 }, 'BRIEF_RADIUS_INVALID');
  bad({ positions: ['SWEEPER'] }, 'BRIEF_POSITION_UNKNOWN');
  bad({ evidenceRequirements: ['is_good'] }, 'BRIEF_EVIDENCE_REQUIREMENT_UNKNOWN');
  bad({ minTrustBand: 'excellent' }, 'BRIEF_TRUST_BAND_UNKNOWN');
  bad({ maxLevel: 'galactico' }, 'BRIEF_LEVEL_UNKNOWN');
  bad({ activeFrom: '2027-06-01', activeUntil: '2027-01-01' }, 'BRIEF_WINDOW_INVALID');
  neg(!validateRecruitmentBrief({}).ok, 'a brief with no title is refused');

  const good = validateRecruitmentBrief({
    title: '2027 DM',
    positions: ['CDM', 'CM'],
    minAge: 16,
    maxAge: 18,
    evidenceRequirements: ['recent_full_match'],
    minTrustBand: 'established_evidence',
  });
  ok(
    good.ok && good.criteria.positionGroups.join() === 'MID',
    'a valid brief derives its position groups from the canonical taxonomy',
  );
  ok(
    POSITIONS.every((p) => POSITION_GROUP_OF[p]),
    'every canonical position has a group — no fifth taxonomy was invented',
  );
  // Grassroots ceilings are structural, not optional.
  const gr = validateRecruitmentBrief({ title: 'g', radiusKm: 500, maxLevel: 'pro' }, { orgLevel: 'grassroots' });
  neg(
    gr.criteria.radiusKm === 50 && gr.criteria.maxLevel === 'semi_pro',
    'a grassroots brief cannot exceed the 50 km radius or reach pro level',
  );
  ok(
    explainBriefCriteria(good.criteria).length >= 4,
    'every criterion is explainable in plain language — there are no hidden criteria',
  );
}

// ================================================ U8 matching, N-scenarios
section('U8 — deterministic matching and Evaluation Coverage');
{
  const facts = {
    playerId: 'pl-1',
    name: 'A Player',
    age: 17,
    position: 'CDM',
    secondaryPositions: ['CM'],
    level: 'amateur',
    foot: 'Right',
    availability: 'seeking',
    distanceKm: 10,
    trustBand: 'established_evidence',
    combineProtocols: ['box_touch_60'],
    evidenceFlags: {
      recent_full_match: true,
      coach_reference: false,
      confirmed_current_club: false,
      combine_verified: true,
    },
  };
  const crit = validateRecruitmentBrief({
    title: 'b',
    positions: ['CDM'],
    minAge: 16,
    maxAge: 18,
    evidenceRequirements: ['recent_full_match'],
  }).criteria;
  const m = playerMatchesBrief(facts, crit);
  ok(m.matched, 'a matching player matches');
  ok(
    m.reasons.every((r) => r.text && typeof r.met === 'boolean'),
    'every criterion produces an explicit reason — "why is this player here?" is always answerable',
  );
  neg(
    !JSON.stringify(m).match(/score|weight|rank|probability/i),
    'matching produces no score, weight, rank or probability',
  );

  neg(!playerMatchesBrief({ ...facts, age: null }, crit).matched, 'an unknown age fails an age criterion closed');
  neg(
    !playerMatchesBrief({ ...facts, distanceKm: null }, { ...crit, radiusKm: 50 }).matched,
    'an unknown distance fails a radius criterion closed',
  );
  neg(
    !playerMatchesBrief({ ...facts, position: 'ST', secondaryPositions: [] }, crit).matched,
    'a striker does not match a defensive-midfield brief',
  );
  neg(
    !playerMatchesBrief({ ...facts, evidenceFlags: { ...facts.evidenceFlags, recent_full_match: false } }, crit)
      .matched,
    'a missing evidence requirement fails the match',
  );
  neg(
    !playerMatchesBrief({ ...facts, level: 'pro' }, { ...crit, maxLevel: 'semi_pro' }).matched,
    'a pro player fails a semi-pro ceiling',
  );
  neg(
    !playerMatchesBrief({ ...facts, trustBand: 'limited_evidence' }, { ...crit, minTrustBand: 'strong_evidence' })
      .matched,
    'evidence confidence below the criteria fails the match',
  );
  ok(
    playerMatchesBrief(
      { ...facts, trustBand: 'very_strong_evidence' },
      { ...crit, minTrustBand: 'established_evidence' },
    ).matched,
    'evidence confidence above the criteria passes',
  );
  neg(
    TRUST_BANDS.length === 5 && !TRUST_BANDS.some((b) => /good|great|elite|talent/i.test(b)),
    'trust bands describe evidence, never ability',
  );

  // Previously evaluated and active-room players are not "missed".
  const brief = { id: 'brf-1', version: 1 };
  neg(
    buildNobodyMissedCandidate({ facts, brief, match: m, evaluation: { evaluated: true }, roomOpen: false }) === null,
    'an already-evaluated player is never a Nobody Missed candidate',
  );
  neg(
    buildNobodyMissedCandidate({ facts, brief, match: m, evaluation: { evaluated: false }, roomOpen: true }) === null,
    'a player with an open room is never a Nobody Missed candidate',
  );
  const cand = buildNobodyMissedCandidate({
    facts,
    brief,
    match: m,
    evaluation: { evaluated: false },
    roomOpen: false,
  });
  ok(
    cand.reasons.some((r) => r.key === 'no_room'),
    'the candidate explanation includes the workflow fact',
  );
  neg(/not football ability/i.test(cand.trustNote), 'the candidate carries the Trust disclaimer');
  neg(
    !JSON.stringify(cand).match(/dob|guardian|medical|email|phone/i),
    'the candidate explanation exposes no private field',
  );

  // N1 arithmetic, worked exactly.
  const cov = evaluationCoverageState({ eligible: 42, evaluated: 30 });
  ok(
    cov.eligible === 42 && cov.evaluated === 30 && cov.notYetEvaluated === 12 && cov.coveragePercent === 71,
    'N1: 42 eligible, 30 evaluated gives 12 not yet evaluated and 71% coverage',
  );
  ok(
    evaluationCoverageState({ eligible: 8, evaluated: 5 }).coveragePercent === 63,
    'the demo brief arithmetic gives 63%',
  );
  ok(evaluationCoverageState({ eligible: 5, evaluated: 5 }).complete === true, '100% coverage is reported as complete');
  neg(
    evaluationCoverageState({ eligible: 2, evaluated: 1 }).suppressed === true,
    'a group below the small-n threshold is suppressed',
  );
  neg(
    evaluationCoverageState({ eligible: 2, evaluated: 1 }).evaluated === null,
    'a suppressed breakdown reports null, not a misleading zero',
  );
  ok(
    evaluationCoverageState({ eligible: 0, evaluated: 0 }).coveragePercent === null,
    'no eligible players yields no percentage rather than 0%',
  );

  ok(
    NM_SORTS.length === 5 && !NM_SORTS.some((s) => /quality|best|rank|score/i.test(s)),
    'no sort option is a quality ranking',
  );
  ok(
    orderNobodyMissed(
      [
        { playerId: 'b', name: 'B' },
        { playerId: 'a', name: 'A' },
      ],
      'name',
    )[0].name === 'A',
    'name ordering works',
  );
  ok(
    orderNobodyMissed(
      [
        { playerId: 'a', trustBand: 'limited_evidence' },
        { playerId: 'c', trustBand: null },
        { playerId: 'b', trustBand: 'strong_evidence' },
      ],
      'evidence_confidence',
    )
      .map((x) => x.playerId)
      .join() === 'b,a,c',
    'evidence-confidence ordering ranks the stronger band first and an unknown band last',
  );
  ok(clampPage(1000) === LIMITS.maxPageSize, 'page sizes are clamped');
  neg(
    !('orgId' in (safeM18Projection({ orgId: 'o1', id: 'x' }) ?? {})),
    'the safe projection strips the organisation id',
  );
}

section('Abuse — forged changes');
{
  // #29: there is no route that takes a change, so a future-dated one is checked against the engine.
  neg(
    changesSinceDecision(
      [{ type: 'full_match_added', occurredAt: NOW + DAY, fingerprint: 'f', negative: false }],
      NOW - DAY,
    ).length === 0,
    '[29] a future-dated change is discarded',
  );
}

done();
