// The Football Passport rules behind the passport battery (e2e/passport/passport.mjs), checked in this process: the
// timeline engine, provenance and precedence, visibility, gaps and the share primitives.
import {
  buildTimeline,
  clubHistory,
  currentStatus,
  temporalConflicts,
  evaluateGaps,
  completeness,
  GAP_RULES,
  GAP_RULES_VERSION,
  PROVENANCE,
  provRank,
  provenanceFromMethod,
  PROVENANCE_COPY,
  viewerSees,
  normWhen,
  whenDisplay,
  evId,
  projectPassport,
  sha256,
  mintShareSecret,
  shareProblem,
  SHARE_MODES,
} from '../../../domains/passport/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('passport/passport');

// ===================================================================== U1
section('U1 — timeline engine: deterministic, deduplicated, honest dates');
{
  const src = {
    careerEntries: [
      { id: 'c1', orgName: 'Riverside Youth', role: 'RW', from: '2019', to: '2021-06', submittedBy: 'player' },
      { id: 'c2', orgName: 'Old Boys', from: '2022-03-15', to: null, submittedBy: 'guardian' },
      { id: 'c3', orgName: 'Gone FC', from: '2015', to: null, submittedBy: 'player', withdrawnAt: 123 },
    ],
    squads: [{ orgId: 'o9', orgName: 'Marsh Lane', rowId: 'sq1', addedAt: Date.UTC(2024, 4, 2), orgVerified: true }],
    trials: [
      {
        id: 't1',
        orgId: 'o2',
        orgName: 'City Academy',
        acceptedAt: Date.UTC(2023, 2, 1),
        proposedDate: '2023-03-10',
        report: { at: Date.UTC(2023, 2, 12) },
      },
    ],
    assessments: [{ id: 'a1', orgId: 'o2', orgName: 'City Academy', submittedAt: Date.UTC(2023, 2, 20) }],
    references: [
      { id: 'r1', coachName: 'Coach K', orgId: 'o2', orgName: 'City Academy', createdAt: Date.UTC(2023, 3, 1) },
    ],
    evidence: [
      {
        id: 'e1',
        claimType: 'footage',
        label: 'Full match',
        recordedAt: Date.UTC(2024, 1, 1),
        tier: 'self_reported',
        sourceKind: 'player',
      },
      {
        id: 'e2',
        claimType: 'statistic',
        label: 'Goals',
        recordedAt: Date.UTC(2024, 1, 2),
        tier: 'self_reported',
        sourceKind: 'player',
      },
      { id: 'e3', claimType: 'footage', label: 'Old cut', recordedAt: Date.UTC(2023, 1, 1), superseded: true },
    ],
    signings: [{ id: 's1', orgId: 'o9', orgName: 'Marsh Lane', ts: Date.UTC(2024, 4, 2) }],
    achievements: [
      { id: 'ach1', title: 'Top scorer', when: '2024', submittedBy: 'player', confirmation: null },
      { id: 'ach2', title: 'Withdrawn one', when: '2024', submittedBy: 'player', withdrawnAt: 1 },
    ],
    positionHistory: [{ id: 'p1', from: '2020', primary: 'RW' }],
  };
  const tl = buildTimeline(src);
  ok(
    JSON.stringify(tl) === JSON.stringify(buildTimeline(src)),
    'projection is deterministic — same sources, byte-identical timeline',
  );
  const dup = buildTimeline({ ...src, trials: [src.trials[0], { ...src.trials[0] }] });
  neg(dup.length === tl.length, 'duplicated source row cannot create a duplicate event (canonical ids dedupe)');
  ok(
    tl.every((e, i) => i === 0 || tl[i - 1].when.t >= e.when.t),
    'strictly reverse-chronological',
  );
  ok(
    tl.every((e) => e.id.startsWith('pev:') && e.source?.type),
    'every event carries a canonical id and a source reference',
  );
  const c1join = tl.find((e) => e.id === evId('career', 'c1', 'club_joined'));
  ok(
    c1join?.when.precision === 'year' && whenDisplay(c1join.when) === '2019',
    'year-only input STAYS year precision — no invented month/day',
  );
  const c1left = tl.find((e) => e.id === evId('career', 'c1', 'club_left'));
  ok(c1left?.when.precision === 'month' && whenDisplay(c1left.when) === '2021-06', 'month input stays month precision');
  ok(
    tl.find((e) => e.id === evId('career', 'c2', 'club_joined'))?.provenance === 'guardian_submitted',
    'guardian-submitted entry carries guardian provenance',
  );
  neg(!tl.some((e) => e.source.id === 'c3'), 'withdrawn career entry emits nothing');
  ok(
    tl.some((e) => e.type === 'trial_attended') && tl.some((e) => e.type === 'trial_outcome'),
    'trial produces trial_* events',
  );
  neg(
    !tl.some((e) => e.type === 'club_joined' && e.source.type === 'trial'),
    'a trial NEVER becomes a club_joined event (trial ≠ employment)',
  );
  neg(!tl.some((e) => e.source.id === 'e3'), 'superseded evidence emits no event (supersession honoured)');
  neg(!tl.some((e) => e.source.id === 'e2'), 'non-footage evidence stays in the summary, not the timeline');
  ok(
    tl.some((e) => e.type === 'signed' && e.provenance === 'verified_club_confirmed'),
    'signing event is club-confirmed',
  );
  neg(!tl.some((e) => e.source.id === 'ach2'), 'withdrawn achievement emits nothing');
  ok(
    tl.find((e) => e.type === 'position_change')?.when.precision === 'year',
    'position history keeps source precision',
  );
  // Date normalisation honesty:
  ok(
    normWhen('sometime in 2019') === null && normWhen('') === null && normWhen(null) === null,
    'unparseable dates become null, never a guessed timestamp',
  );
  ok(
    normWhen({ year: 2019 }).precision === 'year' &&
      normWhen('2019-03').precision === 'month' &&
      normWhen(Date.UTC(2019, 2, 5)).precision === 'day',
    'three precision levels normalise as given',
  );
}

// ===================================================================== U2
section('U2 — provenance & precedence');
{
  ok(
    provRank('player_submitted') < provRank('scoutbox_reviewed') &&
      provRank('scoutbox_reviewed') < provRank('verified_club_confirmed') &&
      provRank('verified_club_confirmed') < provRank('authoritative_registry'),
    'provenance vocabulary is rank-ordered for precedence only',
  );
  ok(
    PROVENANCE.length === 9 &&
      [
        'player_submitted',
        'guardian_submitted',
        'system_recorded',
        'historical_migration',
        'scoutbox_reviewed',
        'verified_coach_confirmed',
        'verified_club_confirmed',
        'authoritative_registry',
      ].every((p) => PROVENANCE.includes(p)),
    'the eight provenance values plus box_cam_observed',
  );
  ok(
    provRank('box_cam_observed') > provRank('player_submitted') &&
      provRank('box_cam_observed') > provRank('guardian_submitted') &&
      provRank('box_cam_observed') < provRank('scoutbox_reviewed') &&
      provRank('box_cam_observed') < provRank('verified_club_confirmed'),
    'box_cam_observed outranks self-submission but NEVER organisation confirmation or review',
  );
  ok(
    provenanceFromMethod('organisation_admin_confirmation') === 'verified_club_confirmed' &&
      provenanceFromMethod('scoutbox_manual_review') === 'scoutbox_reviewed' &&
      provenanceFromMethod('authoritative_registry') === 'authoritative_registry' &&
      provenanceFromMethod('migration') === 'historical_migration' &&
      provenanceFromMethod('unknown_thing') === 'system_recorded',
    'verification methods map onto Passport provenance',
  );
  ok(
    PROVENANCE_COPY.player_submitted.includes('has not independently confirmed'),
    'player-submitted copy is honest about non-verification',
  );
  ok(
    PROVENANCE_COPY.scoutbox_reviewed.includes('not an independent register check'),
    'ScoutBox review copy names its own limitation',
  );

  const mk = (extra = {}) => ({
    id: 's1',
    orgId: 'o9',
    orgName: 'Marsh Lane',
    ts: Date.UTC(2024, 4, 2),
    endedAt: null,
    ...extra,
  });
  let h = clubHistory({
    signingRows: [mk()],
    squads: [{ orgId: 'o9', orgName: 'Marsh Lane', rowId: 'sq', addedAt: Date.UTC(2024, 4, 3), orgVerified: true }],
  });
  ok(
    h.rows.length === 1 && h.rows[0].current && h.rows[0].provenance === 'verified_club_confirmed',
    'signing yields ONE current club-confirmed row (squad row folded away)',
  );
  h = clubHistory({ signingRows: [mk({ endedAt: Date.UTC(2025, 0, 10) })] });
  ok(!h.rows[0].current && whenDisplay(h.rows[0].to) === '2025-01-10', 'outcome-report end date closes the period');
  h = clubHistory({ signingRows: [mk({ orgSuspended: true })] });
  neg(!h.rows[0].current, 'a suspended organisation lends no CURRENT relationship — history preserved');
  h = clubHistory({
    signingRows: [mk()],
    careerEntries: [{ id: 'c9', orgName: '  marsh LANE ', from: '2024', to: null, submittedBy: 'player' }],
  });
  ok(
    h.rows.length === 1 && h.foldedConflicts.length === 1 && h.foldedConflicts[0].entryId === 'c9',
    'self entry duplicating an authoritative row folds into it (flagged, not duplicated)',
  );

  const authRow = {
    key: 'k1',
    orgName: 'Marsh Lane',
    orgId: 'o9',
    role: null,
    from: normWhen('2024'),
    to: null,
    current: true,
    provenance: 'verified_club_confirmed',
    source: { type: 'signing', id: 's1' },
  };
  const selfRow = {
    key: 'k2',
    orgName: 'Sunday Kings',
    orgId: null,
    role: null,
    from: normWhen('2018'),
    to: null,
    current: true,
    provenance: 'player_submitted',
    source: { type: 'career_entry', id: 'c1' },
  };
  let st = currentStatus({ history: { rows: [authRow, selfRow], foldedConflicts: [] }, prefs: null });
  ok(
    st.currentClub.orgName === 'Marsh Lane' && st.conflicts[0]?.code === 'CURRENT_CLUB_CONFLICT',
    'authoritative current wins display; player input becomes a FLAGGED conflict, never silently discarded',
  );
  st = currentStatus({ history: { rows: [selfRow], foldedConflicts: [] }, prefs: null });
  ok(
    st.currentClub.orgName === 'Sunday Kings' &&
      st.currentClub.provenance === 'player_submitted' &&
      st.conflicts.length === 0,
    'with no authoritative record, self entry displays under its own honest provenance',
  );

  const flags = temporalConflicts({
    events: [
      { id: 'ev1', when: normWhen('2001') },
      { id: 'ev2', when: normWhen('2031') },
    ],
    history: [
      {
        key: 'h1',
        from: normWhen('2020'),
        to: normWhen('2018'),
        current: false,
        role: null,
        provenance: 'verified_club_confirmed',
      },
      { ...authRow, key: 'h2' },
      { ...authRow, key: 'h3', orgName: 'Other FC' },
    ],
    dob: '2010-02-01',
  });
  ok(
    flags.some((f) => f.kind === 'before_dob' && f.eventId === 'ev1'),
    'event before date of birth → TEMPORAL_CONFLICT flag',
  );
  ok(
    flags.some((f) => f.kind === 'far_future' && f.eventId === 'ev2'),
    'far-future event → TEMPORAL_CONFLICT flag',
  );
  ok(
    flags.some((f) => f.kind === 'left_before_joined'),
    'left-before-joined period flagged',
  );
  ok(
    flags.some((f) => f.kind === 'overlapping_current_authoritative'),
    'two authoritative current clubs flagged for review',
  );
  neg(
    flags.every((f) => f.code === 'TEMPORAL_CONFLICT'),
    'impossible chronology is a correction flag — NEVER an automatic fraud accusation',
  );
}

// ===================================================================== U3
section('U3 — visibility, gaps and share primitives');
{
  neg(
    !viewerSees('public', 'recruitment') &&
      !viewerSees('public', 'private') &&
      !viewerSees('other_player', 'recruitment'),
    'public/other-player viewers see ONLY public items',
  );
  ok(
    viewerSees('pro_club', 'recruitment') &&
      !viewerSees('pro_club', 'private') &&
      !viewerSees('pro_club', 'guardian_only'),
    'clubs see public+recruitment, never private/guardian layers',
  );
  ok(
    viewerSees('guardian', 'guardian_only') && !viewerSees('self', 'guardian_only'),
    'guardian-only layer reaches the guardian, not the player',
  );
  neg(
    !viewerSees('guardian', 'trust_and_safety') && viewerSees('trust_safety', 'trust_and_safety'),
    'trust_and_safety layer is T&S-only',
  );

  const bad = {
    hasRecentFullMatch: false,
    fullMatchCount: 0,
    clipCount: 0,
    referenceCount: 0,
    hasConfirmedCurrentClub: false,
    hasRecentAssessment: false,
    hasPosition: false,
    hasAvailability: false,
    identityConfirmed: false,
    historyRows: 0,
  };
  const good = {
    hasRecentFullMatch: true,
    fullMatchCount: 2,
    clipCount: 3,
    referenceCount: 1,
    hasConfirmedCurrentClub: true,
    hasRecentAssessment: true,
    hasPosition: true,
    hasAvailability: true,
    identityConfirmed: true,
    historyRows: 3,
    hasRecentTrainingEvidence: true,
  };
  const cBad = completeness(bad);
  const cGood = completeness(good);
  ok(
    cBad.evidenceCoverage === 'limited' && cGood.evidenceCoverage === 'strong',
    'coverage descriptors are words about evidence, never ability',
  );
  ok(
    cBad.eligibility.total === GAP_RULES.length &&
      cBad.eligibility.rulesVersion === GAP_RULES_VERSION &&
      cBad.eligibility.satisfied === 0,
    'eligibility preview counts EXACTLY the versioned generic rules — never club criteria',
  );
  ok(
    cGood.gaps.length === 0 && evaluateGaps(bad).length === GAP_RULES.length,
    'gap engine is deterministic over facts',
  );
  neg(!JSON.stringify(cBad).match(/"score"|rating/i), 'completeness output contains no score and no rating');
  ok(
    JSON.stringify(evaluateGaps(bad)) === JSON.stringify(evaluateGaps({ ...bad })),
    'same facts → same gaps (versioned, no AI)',
  );

  // Projection units on a small assembled fixture.
  const mini = {
    player: { id: 'px', name: 'P X', age: 22, minor: false, position: 'ST', city: 'Testville', level: 'amateur' },
    identity: null,
    prefs: {
      bio: null,
      positions: null,
      availability: null,
      availableFrom: null,
      publicSelections: [],
      positionHistory: [],
    },
    history: {
      rows: [
        {
          key: 'k1',
          orgId: 'o2',
          orgName: 'City Academy',
          role: null,
          from: normWhen('2023'),
          to: null,
          current: true,
          provenance: 'verified_club_confirmed',
          source: { type: 'signing', id: 's' },
        },
      ],
      foldedConflicts: [],
    },
    status: {
      currentClub: {
        orgId: 'o2',
        orgName: 'City Academy',
        role: null,
        since: '2023',
        provenance: 'verified_club_confirmed',
        assurance: null,
      },
      positions: null,
      availability: null,
      availableFrom: null,
      representation: null,
      identity: null,
      conflicts: [],
    },
    timeline: buildTimeline({
      trials: [
        {
          id: 't1',
          orgId: 'o2',
          orgName: 'City Academy',
          acceptedAt: Date.UTC(2023, 2, 1),
          proposedDate: '2023-03-10',
        },
      ],
      assessments: [{ id: 'a1', orgId: 'o2', orgName: 'City Academy', submittedAt: Date.UTC(2023, 2, 20) }],
      references: [
        { id: 'r1', coachName: 'Coach K', orgId: 'o2', orgName: 'City Academy', createdAt: Date.UTC(2023, 3, 1) },
      ],
    }),
    temporalConflicts: [],
    evidenceSummary: { fullMatches: 1, clips: 0, assessments: 1, references: 1, lastEvidenceDays: 4, note: 'n' },
    references: [],
    achievements: [],
    developmentSummary: { active: 0, completed: 0 },
    trialsSummary: { total: 1, withReport: 0 },
    completeness: cBad,
    sharingSummary: { active: 0 },
    assessmentsForOrg: [],
    trialsForOrg: [],
  };
  const trialId = evId('trial', 't1', 'trial_attended');
  let pub = projectPassport(mini, 'public');
  neg(!pub.timeline.some((e) => e.id === trialId), 'trial participation is NOT public by default');
  pub = projectPassport(
    {
      ...mini,
      prefs: {
        ...mini.prefs,
        publicSelections: [
          trialId,
          evId('assessment', 'a1', 'assessment_completed'),
          evId('reference', 'r1', 'reference_received'),
        ],
      },
    },
    'public',
  );
  ok(
    pub.timeline.some((e) => e.id === trialId),
    'explicit selection makes a public-ELIGIBLE item public (opt-in)',
  );
  neg(
    !pub.timeline.some((e) => e.type === 'assessment_completed') &&
      !pub.timeline.some((e) => e.type === 'reference_received'),
    'selecting a non-eligible item id surfaces NOTHING — selections narrow, never widen',
  );
  const own = projectPassport(mini, 'pro_club', { orgId: 'o2' });
  const other = projectPassport(mini, 'pro_club', { orgId: 'oZ' });
  ok(
    own.timeline.some((e) => e.type === 'assessment_completed') &&
      own.timeline.some((e) => e.type === 'trial_attended'),
    'assessing org sees its own assessment/trial events',
  );
  neg(
    !other.timeline.some((e) => e.type === 'assessment_completed') &&
      !other.timeline.some((e) => e.type === 'trial_attended'),
    'another org NEVER sees them (own-org visibility)',
  );
  ok(
    projectPassport(mini, 'self').timeline.every((e) => e.source.id) &&
      own.timeline.every((e) => e.source.id === undefined),
    'raw source ids stay with self/guardian/T&S; org viewers get the source TYPE only',
  );
  const minorMini = { ...mini, player: { ...mini.player, age: 14, minor: true } };
  neg(
    projectPassport(minorMini, 'pro_club', { orgId: 'o2' }).player.location === null &&
      projectPassport(minorMini, 'public').player.location === null,
    "a minor's location is stripped from org and public projections (existing redaction policy)",
  );

  const s1 = mintShareSecret();
  const s2 = mintShareSecret();
  ok(
    s1.length >= 32 && s1 !== s2 && /^[A-Za-z0-9_-]+$/.test(s1),
    'share secrets are high-entropy url-safe strings (24 random bytes)',
  );
  ok(sha256(s1) === sha256(s1) && sha256(s1) !== sha256(s2), 'hash-at-rest is deterministic per secret');
  ok(JSON.stringify(SHARE_MODES) === JSON.stringify(['public', 'recruitment']), 'exactly two share modes');
  ok(
    shareProblem(null) === 'SHARE_UNKNOWN' &&
      shareProblem({ revokedAt: 1 }) === 'SHARE_REVOKED' &&
      shareProblem({ revokedAt: null, expiresAt: 5 }, { now: 10 }) === 'SHARE_EXPIRED' &&
      shareProblem({ revokedAt: null, expiresAt: null }, { playerRemoved: true }) === 'SUBJECT_REMOVED' &&
      shareProblem({ revokedAt: null, expiresAt: Date.now() + 1000 }) === null,
    'share validation codes are exact (all collapse to 404 at the route)',
  );
}

done();
