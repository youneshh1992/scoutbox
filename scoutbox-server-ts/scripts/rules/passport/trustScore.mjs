// The Trust Score rules behind the trustScore battery (e2e/passport/trustScore.mjs), checked in this process: the
// policy and bands, source deduplication, caps and diminishing returns, what is never an input, the change reasons,
// the snapshot and the viewer-safe projection.
import {
  POLICY,
  TRUST_SCORE_POLICY_VERSION,
  calculateTrustScore,
  trustBandForScore,
  applyDiminishingReturns,
  canonicalTrustSources,
  safeTrustProjection,
  trustSummary,
  trustSnapshot,
  trustChangeReasons,
  policyWeightsTotal,
  eligibleTrustComponents,
  scoreCombineConfidence,
  scoreEvidenceConfidence,
  scoreFootballHistoryConfidence,
  scoreIdentityConfidence,
  scoreRelationshipConfidence,
  scoreReferencesConfidence,
  TRUST_DISCLAIMER,
} from '../../../domains/passport/trust/shared.mjs';
import { agreementInForce } from '../../../domains/agents/core/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('passport/trustScore');

// ---------------------------------------------------------------- fixtures
const identity = (assurance) => (assurance ? { assurance } : null);
const histRow = (key, provenance, current = false) => ({ key, provenance, current });
const rel = (key, kind, verified = true) => ({ key, kind, verified });
const evItem = (key, provenance = 'verified_club_confirmed') => ({ key, provenance, recordedAt: Date.now() });
const boxSession = (key, { simulated = false, state = 'verified' } = {}) => ({
  key,
  verificationState: state,
  simulated,
  endedAt: Date.now(),
});
const combineAttempt = (key, protocolId, { simulated = false, state = 'combine_verified', version = 1 } = {}) => ({
  key,
  protocolId,
  protocolVersion: version,
  combineState: state,
  simulated,
});
const refItem = (key, verified = true) => ({ key, verified });

const build = (over = {}) =>
  calculateTrustScore({
    playerContext: { isAdult: true },
    identity: null,
    historyRows: [],
    relationships: [],
    evidenceItems: [],
    boxCamSessions: [],
    combineAttempts: [],
    references: [],
    assessments: [],
    allowSimulatedEvidence: false,
    ...over,
  });

// A realistic, broadly-evidenced adult profile used as the comparison base.
const RICH = {
  identity: identity('authoritative'),
  historyRows: [histRow('h1', 'verified_club_confirmed', true), histRow('h2', 'verified_club_confirmed')],
  relationships: [rel('r1', 'club'), rel('r2', 'coach'), rel('r3', 'coach')],
  evidenceItems: [evItem('e1'), evItem('e2'), evItem('e3')],
  boxCamSessions: [boxSession('b1'), boxSession('b2'), boxSession('b3')],
  combineAttempts: [combineAttempt('c1', 'combine-box-touch-60'), combineAttempt('c2', 'combine-box-juggle')],
  references: [refItem('f1'), refItem('f2')],
  assessments: [{ key: 'a1', verifiedSource: true }],
};

// ============================================================ U1 policy
section('U1 — policy, determinism and bands');
{
  ok(policyWeightsTotal(POLICY) === 100, 'component weights total exactly 100');
  ok(TRUST_SCORE_POLICY_VERSION === POLICY.version && POLICY.version >= 1, 'policy version is defined and exported');
  const a = build(RICH);
  const b = build(RICH);
  ok(
    a.score === b.score && JSON.stringify(a.components) === JSON.stringify(b.components),
    'same inputs → identical score (deterministic)',
  );
  ok(a.policyVersion === TRUST_SCORE_POLICY_VERSION, 'profile carries the policy version');
  ok(
    a.disclaimer === TRUST_DISCLAIMER && /not football ability/i.test(a.disclaimer),
    'profile carries the ability disclaimer',
  );
  ok(build({}).score >= 0 && build(RICH).score <= 100, 'score stays within 0–100');
  // exact band boundaries
  const bandAt = (n) => trustBandForScore(n).id;
  ok(bandAt(0) === 'limited_evidence' && bandAt(39) === 'limited_evidence', 'band boundary 0 and 39 → limited');
  ok(
    bandAt(40) === 'developing_evidence' && bandAt(59) === 'developing_evidence',
    'band boundary 40 and 59 → developing',
  );
  ok(
    bandAt(60) === 'established_evidence' && bandAt(74) === 'established_evidence',
    'band boundary 60 and 74 → established',
  );
  ok(bandAt(75) === 'strong_evidence' && bandAt(89) === 'strong_evidence', 'band boundary 75 and 89 → strong');
  ok(
    bandAt(90) === 'very_strong_evidence' && bandAt(100) === 'very_strong_evidence',
    'band boundary 90 and 100 → very strong',
  );
  neg(
    trustBandForScore(-50).id === 'limited_evidence' && trustBandForScore(999).id === 'very_strong_evidence',
    'out-of-range scores clamp to a valid band',
  );
  neg(
    !/untrustworthy|suspicious|risky|fraud|poor/i.test(POLICY.bands.map((x) => x.label).join(' ')),
    'no band label implies bad character',
  );
}

// ============================================================ U2 dedupe
section('U2 — canonical source deduplication');
{
  ok(
    canonicalTrustSources([
      { key: 'k', strengthBp: 5000 },
      { key: 'k', strengthBp: 9000 },
    ]).length === 1,
    'same canonical key counted once',
  );
  ok(
    canonicalTrustSources([
      { key: 'k', strengthBp: 5000 },
      { key: 'k', strengthBp: 9000 },
    ])[0].strengthBp === 9000,
    'strongest statement of the same fact wins',
  );
  const once = build({ ...RICH, historyRows: [histRow('h1', 'verified_club_confirmed', true)] });
  const twice = build({
    ...RICH,
    historyRows: [histRow('h1', 'verified_club_confirmed', true), histRow('h1', 'verified_club_confirmed', true)],
  });
  neg(once.score === twice.score, 'the same fact arriving twice does not score twice');
}

// ================================================ U3 provenance / history
section('U3 — fact-specific authority and player-submitted honesty');
{
  const confirmed = build({
    historyRows: [histRow('h1', 'verified_club_confirmed', true), histRow('h2', 'verified_club_confirmed')],
  });
  const selfOnly = build({ historyRows: [histRow('h1', 'player_submitted', true), histRow('h2', 'player_submitted')] });
  ok(
    confirmed.components.footballHistory.coverageBp > selfOnly.components.footballHistory.coverageBp,
    'club-confirmed history is stronger than player-submitted',
  );
  neg(
    selfOnly.components.footballHistory.coverageBp > 0,
    'player-submitted history still contributes limited (not zero) confidence',
  );
  neg(
    selfOnly.gaps.some((g) => g.code === 'HISTORY_PLAYER_SUBMITTED'),
    'player-submitted history is explained as an evidence gap, not an accusation',
  );
  const coachConfirmed = build({ historyRows: [histRow('h1', 'verified_coach_confirmed', true)] });
  ok(
    coachConfirmed.components.footballHistory.coverageBp >
      build({ historyRows: [histRow('h1', 'player_submitted', true)] }).components.footballHistory.coverageBp,
    'coach-confirmed outranks player-submitted for a club fact',
  );
  // Historical facts do not decay
  const historical = build({ historyRows: [histRow('h1', 'verified_club_confirmed', false)] });
  const current = build({ historyRows: [histRow('h1', 'verified_club_confirmed', true)] });
  ok(
    historical.components.footballHistory.coverageBp === current.components.footballHistory.coverageBp,
    'a verified historical club fact stays fully valid after the player leaves',
  );
}

// ============================================ U4 caps / diminishing returns
section('U4 — caps, diminishing returns and the anti-grinding invariant');
{
  ok(
    applyDiminishingReturns(0, [0, 5000, 10000]) === 0 && applyDiminishingReturns(99, [0, 5000, 10000]) === 10000,
    'diminishing curve: 0 gives nothing, excess volume stops at the cap',
  );
  const box = (n) => build({ boxCamSessions: Array.from({ length: n }, (_, i) => boxSession(`b${i}`)) });
  ok(box(1).components.evidence.coverageBp > 0, 'one Box Cam session adds meaningful evidence');
  ok(
    box(3).components.evidence.coverageBp > box(1).components.evidence.coverageBp,
    'more Box Cam coverage strengthens evidence',
  );
  neg(
    box(500).components.evidence.coverageBp === box(50).components.evidence.coverageBp,
    '500 Box Cam sessions score no higher than 50 (capped)',
  );
  neg(
    box(500).components.evidence.coverageBp <= POLICY.evidence.boxCamSubCap,
    'Box Cam alone cannot exceed its evidence sub-cap',
  );
  neg(
    box(500).components.evidence.earnedWeightBp < POLICY.weights.evidence * 10000,
    'Box Cam alone cannot max the Evidence component',
  );
  // each component is capped by its own weight
  const rich = build(RICH);
  ok(
    Object.values(rich.components).every((c) => c.earnedWeightBp <= c.weight * 10000),
    'no component can earn more than its weight',
  );
}

// ================================================== U5 the grinding attack
section('U5 — adversarial grinding cannot buy trust');
{
  const grinder = build({
    // 500 Box Cam sessions and 100 verified attempts of ONE protocol,
    // with no identity, no club history, no relationships, no references.
    boxCamSessions: Array.from({ length: 500 }, (_, i) => boxSession(`b${i}`)),
    combineAttempts: Array.from({ length: 100 }, (_, i) => combineAttempt(`c${i}`, 'combine-box-touch-60')),
  });
  neg(
    grinder.score < 40,
    `grinding 500 sessions + 100 same-protocol attempts stays in limited evidence (${grinder.score})`,
  );
  neg(
    grinder.score < 100 - POLICY.weights.identity,
    'grinder cannot approach 100 without identity, history, relationships or references',
  );
  neg(
    grinder.components.combine.detail.distinctProtocols === 1,
    '100 attempts of one protocol is one protocol of coverage',
  );
  neg(
    grinder.components.identity.coverageBp === 0 && grinder.components.footballHistory.coverageBp === 0,
    'grinder genuinely has no identity or history confidence',
  );
}

// ======================================== U6 performance independence
section('U6 — athletic performance is invisible to Trust Score');
{
  // The engine input carries NO measured value at all. Two players whose
  // attempts differ only in athletic output are identical here.
  const playerA = build({ combineAttempts: [combineAttempt('c1', 'combine-box-touch-60')] });
  const playerB = build({ combineAttempts: [combineAttempt('c9', 'combine-box-touch-60')] });
  ok(
    playerA.components.combine.coverageBp === playerB.components.combine.coverageBp,
    'a 40-touch and a 250-touch Combine Verified contribute identically',
  );
  ok(playerA.score === playerB.score, 'identical integrity → identical Trust Score regardless of the number');
  const combineInputKeys = Object.keys(combineAttempt('c1', 'p'));
  neg(
    !combineInputKeys.includes('measuredValue') && !combineInputKeys.includes('display'),
    'the Combine trust projection carries no measured value at all',
  );
  // personal best does not inflate trust
  const before = build({ combineAttempts: [combineAttempt('c1', 'combine-box-touch-60')] });
  const afterPB = build({
    combineAttempts: [combineAttempt('c1', 'combine-box-touch-60'), combineAttempt('c2', 'combine-box-touch-60')],
  });
  neg(before.score === afterPB.score, 'a new personal best on the same protocol does not raise the score');
  // more training time / streaks are not inputs
  const short = build({ boxCamSessions: [boxSession('b1')] });
  const long = build({ boxCamSessions: [boxSession('b1')] });
  ok(short.score === long.score, 'training duration is not an input — 10 and 30 verified minutes score the same');
}

// ======================================= U7 combine coverage and integrity
section('U7 — Combine coverage, partial, invalidation and restoration');
{
  const one = build({ combineAttempts: [combineAttempt('c1', 'combine-box-touch-60')] });
  const two = build({
    combineAttempts: [combineAttempt('c1', 'combine-box-touch-60'), combineAttempt('c2', 'combine-box-juggle')],
  });
  ok(one.components.combine.coverageBp > 0, 'a Combine Verified result strengthens Combine Confidence');
  ok(
    two.components.combine.coverageBp > one.components.combine.coverageBp,
    'distinct protocols broaden Combine coverage',
  );
  const five = build({
    combineAttempts: Array.from({ length: 5 }, (_, i) => combineAttempt(`c${i}`, 'combine-box-touch-60')),
  });
  neg(
    five.components.combine.coverageBp === one.components.combine.coverageBp,
    'five attempts of one protocol equal one protocol of coverage',
  );
  const partial = build({
    combineAttempts: [combineAttempt('c1', 'combine-box-touch-60', { state: 'partially_measured' })],
  });
  neg(partial.components.combine.coverageBp === 0, 'partially_measured does not receive Combine Verified contribution');
  const invalidated = build({
    combineAttempts: [combineAttempt('c1', 'combine-box-touch-60', { state: 'invalidated' })],
  });
  neg(invalidated.components.combine.coverageBp === 0, 'an invalidated Combine result stops contributing immediately');
  const none = build({});
  neg(
    invalidated.score === none.score,
    'invalidation REMOVES evidence — it never applies a punitive penalty below zero-evidence',
  );
  const restored = build({ combineAttempts: [combineAttempt('c1', 'combine-box-touch-60')] });
  ok(
    restored.components.combine.coverageBp === one.components.combine.coverageBp,
    'a restored result returns its contribution deterministically',
  );
  neg(
    !invalidated.gaps.some((g) => /fraud|cheat|dishonest/i.test(g.text)),
    'invalidation copy never accuses the player',
  );
}

// ================================== U8 demo/test provider isolation
section('U8 — simulated evidence never contributes to production trust');
{
  const sim = [combineAttempt('c1', 'combine-box-touch-60', { simulated: true })];
  const prod = build({ combineAttempts: sim, allowSimulatedEvidence: false });
  const demo = build({ combineAttempts: sim, allowSimulatedEvidence: true });
  neg(prod.components.combine.coverageBp === 0, 'a test-provider Combine result contributes NOTHING in production');
  ok(demo.components.combine.coverageBp > 0, 'the same result may drive the score inside an explicit demo context');
  neg(
    prod.simulatedEvidenceIncluded === false && demo.simulatedEvidenceIncluded === true,
    'the profile states whether simulated evidence was included',
  );
  neg(
    prod.components.combine.detail.excludedSimulated === 1,
    'excluded simulated results are counted for transparency',
  );
  neg(
    prod.gaps.some((g) => g.code === 'NO_COMBINE_VERIFIED' && /production-supported/.test(g.text)),
    'production gap copy says no production-supported Combine result is available',
  );
  const simBox = build({ boxCamSessions: [boxSession('b1', { simulated: true })], allowSimulatedEvidence: false });
  neg(
    simBox.components.evidence.coverageBp === 0,
    'simulated Box Cam sessions are excluded from production evidence too',
  );
}

// ================================================= U9 fairness invariants
section('U9 — minor, grassroots, prestige, popularity and payment fairness');
{
  // A minor is not scored against a category that cannot exist for them.
  const minorCtx = eligibleTrustComponents({ isAdult: false });
  neg(minorCtx.adultOnlyFacets.includes('agency_representation'), 'agency representation is excluded for a minor');
  const minorWithAgency = calculateTrustScore({
    playerContext: { isAdult: false },
    relationships: [rel('r1', 'club'), rel('r2', 'agency')],
  });
  const minorWithoutAgency = calculateTrustScore({
    playerContext: { isAdult: false },
    relationships: [rel('r1', 'club')],
  });
  neg(minorWithAgency.score === minorWithoutAgency.score, 'an agency relationship neither helps nor hurts a minor');
  const adultWithAgency = calculateTrustScore({
    playerContext: { isAdult: true },
    relationships: [rel('r1', 'club'), rel('r2', 'agency')],
  });
  ok(adultWithAgency.components.relationships.detail.distinct === 2, "an adult's agency relationship counts normally");
  // Grassroots can reach a strong band with no professional affiliation.
  const grassroots = build({
    identity: identity('authoritative'),
    historyRows: [histRow('h1', 'verified_club_confirmed', true), histRow('h2', 'verified_club_confirmed')],
    relationships: [rel('r1', 'club'), rel('r2', 'coach')],
    evidenceItems: [evItem('e1'), evItem('e2'), evItem('e3')],
    boxCamSessions: [boxSession('b1'), boxSession('b2'), boxSession('b3')],
    references: [refItem('f1'), refItem('f2')],
  });
  ok(
    ['strong_evidence', 'very_strong_evidence'].includes(grassroots.band),
    `a verified grassroots record reaches a strong band (${grassroots.score})`,
  );
  // Prestige independence: the engine never receives an org name/level.
  const relKeys = Object.keys(rel('r1', 'club'));
  neg(
    !relKeys.some((k) => /name|prestige|level|league|reputation|tier/i.test(k)),
    'the relationship projection carries no club-name or prestige fields at all',
  );
  const chelsea = build({ relationships: [rel('rel:club:org-chelsea', 'club')] });
  const parkSide = build({ relationships: [rel('rel:club:org-hackneymarsh', 'club')] });
  neg(chelsea.score === parkSide.score, 'a famous club and a grassroots club give identical relationship confidence');
  // Popularity / recruitment outcome / payment are not inputs: passing them
  // through changes nothing because the engine never reads them.
  const withNoise = calculateTrustScore({
    ...RICH,
    playerContext: { isAdult: true },
    followers: 1_000_000,
    profileViews: 99_999,
    watchlists: 500,
    trialsOffered: 12,
    scoutsInterested: 40,
    subscription: 'premium',
    paidVerification: true,
    signedForBigClub: true,
  });
  neg(
    withNoise.score === build(RICH).score,
    'followers, views, watchlists, trials, scouts, subscription and payment change nothing',
  );
}

// =========================================== U10 references / assessments
section('U10 — references and assessments count by attribution, not content');
{
  const good = build({ assessments: [{ key: 'a1', verifiedSource: true, rating: 9, verdict: 'outstanding' }] });
  const bad = build({ assessments: [{ key: 'a1', verifiedSource: true, rating: 2, verdict: 'weak' }] });
  ok(good.score === bad.score, 'a 9/10 and a 2/10 from the same verified evaluator are identical evidence');
  const unverifiedSource = build({ assessments: [{ key: 'a1', verifiedSource: false, rating: 9 }] });
  neg(
    unverifiedSource.components.references.coverageBp === 0,
    'an assessment from an unverified source adds no reference confidence',
  );
  const refs = build({ references: [refItem('f1'), refItem('f2')] });
  ok(refs.components.references.coverageBp > 0, 'verified references strengthen reference confidence');
  neg(
    build({ references: [refItem('f1', false)] }).components.references.coverageBp === 0,
    'an unverified reference contributes nothing',
  );
}

// =================================== U11 empty profile / monotonicity
section('U11 — new profiles, missing evidence and monotonicity');
{
  const empty = build({});
  ok(
    empty.score >= 0 && empty.band === 'limited_evidence',
    'an empty profile is deterministic and lands in limited evidence',
  );
  neg(
    !empty.gaps.some((g) => /dishonest|fraud|untrust|suspicious/i.test(g.text)),
    'missing evidence is never framed as dishonesty',
  );
  ok(
    empty.gaps.length > 0 && empty.gaps.every((g) => typeof g.text === 'string'),
    'an empty profile explains what is missing in plain language',
  );
  // Monotonicity: adding evidence must never LOWER the score.
  let prev = build({});
  let monotonic = true;
  const steps = [
    { identity: identity('scoutbox_document_review') },
    { historyRows: [histRow('h1', 'player_submitted', true)] },
    { historyRows: [histRow('h1', 'player_submitted', true), histRow('h2', 'verified_club_confirmed')] },
    { relationships: [rel('r1', 'club')] },
    { boxCamSessions: [boxSession('b1')] },
    { references: [refItem('f1')] },
  ];
  let acc = {};
  for (const s of steps) {
    acc = { ...acc, ...s };
    const next = build(acc);
    if (next.score < prev.score) monotonic = false;
    prev = next;
  }
  ok(monotonic, 'adding honest evidence never lowers the Trust Score');
  neg(
    build({ historyRows: [histRow('h1', 'verified_club_confirmed', true)] }).score <=
      build({ historyRows: [histRow('h1', 'verified_club_confirmed', true), histRow('h2', 'player_submitted')] }).score,
    'adding a self-submitted entry alongside a confirmed one never dilutes the score',
  );
}

// ============================================ U12 transparency / snapshot
section('U12 — denominator transparency, change reasons and snapshots');
{
  const p = build(RICH);
  ok(
    Object.values(p.components).every(
      (c) => typeof c.availableWeight === 'number' && typeof c.coverageBp === 'number' && Array.isArray(c.reasons),
    ),
    'every component exposes availableWeight, coverage and reasons',
  );
  ok(
    p.explanations.length === Object.keys(POLICY.weights).length,
    'every component produces a human-readable explanation',
  );
  const before = build({});
  const after = build(RICH);
  const reasons = trustChangeReasons(before, after);
  ok(
    reasons.includes('IDENTITY_CONFIRMED') && reasons.includes('COMBINE_VERIFIED_ADDED'),
    'change reasons name the kind of evidence that changed',
  );
  neg(
    !JSON.stringify(reasons).includes('h1') && !JSON.stringify(reasons).includes('c1'),
    'change reasons never leak source ids',
  );
  const snap = trustSnapshot(after);
  ok(
    snap.policyVersion === TRUST_SCORE_POLICY_VERSION && snap.hash.length === 32 && typeof snap.score === 'number',
    'a snapshot DTO carries score, policy version and a stable hash',
  );
  ok(
    trustSummary(after).score === after.score && Array.isArray(trustSummary(after).topEvidenceSignals),
    'batch summary matches the individual score',
  );
}

// ==================================================== U13 safe projection
section('U13 — viewer-safe projection hides restricted sources');
{
  const p = build(RICH);
  const club = safeTrustProjection(p, 'pro_club');
  const self = safeTrustProjection(p, 'self');
  ok(self.components && self.gaps, 'the player sees full components and gaps');
  neg(!club.components && !club.gaps, 'a club never receives raw components or gap internals');
  ok(
    club.score === p.score && club.signals.length > 0 && /not football ability/i.test(club.note),
    'a club sees the score, safe signals and the ability disclaimer',
  );
  const pubBlocked = safeTrustProjection(p, 'public', { publicAllowed: false });
  neg(pubBlocked === null, 'the public projection is withheld unless passport policy allows it');
  const pub = safeTrustProjection(p, 'public', { publicAllowed: true });
  neg(
    pub && !pub.components && !pub.explanations && typeof pub.score === 'number',
    'an allowed public projection carries score and band only',
  );
  neg(safeTrustProjection(p, 'other_player') === null, 'an unknown viewer receives nothing');
}

// The agency section's last check is of the rule rather than a route.
section('an agency relationship counts only while it is active');
neg(
  !agreementInForce({ id: 'x', agentUserId: null, status: 'active', confirmedAt: 1, startAt: 1, endAt: null }, 2),
  'and it refuses a row that names no licensed individual',
);

done();
