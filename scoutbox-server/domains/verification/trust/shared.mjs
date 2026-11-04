// M16.2 — ScoutBox Trust Score: policy + pure deterministic engine.
//
// The Trust Score answers ONE question: how strongly is this player's
// football record supported by trustworthy, current and attributable
// evidence? It is NOT a talent score, not a recruitment recommendation, not
// a judgement of character, and it NEVER grants a single permission.
//
// Design rules encoded here:
//   • Derived, never persisted as mutable truth — every read recomputes.
//   • Every weight/cap/threshold/band lives in POLICY (versioned). No magic
//     numbers in handlers or components.
//   • Fact-specific authority: a provenance is scored for the KIND of fact it
//     actually supports, not through one universal rank.
//   • Performance value is invisible to this engine. A Combine measurement's
//     NUMBER is never read — only that a valid standardized measurement
//     exists. 40 touches and 250 touches contribute identically.
//   • Volume cannot buy trust: every category is capped and uses diminishing
//     returns, and no single category can reach 100 alone.
//   • Prestige, popularity, recruitment outcomes and payment are not inputs.
//     They are simply never read.
//   • Missing evidence is limited evidence, never dishonesty.
//   • Adding evidence must never LOWER a score (monotonicity).
import crypto from 'node:crypto';

export const TRUST_SCORE_POLICY_VERSION = 1;

// ---------------------------------------------------------------- policy
// Curves are tables of basis points (0–10000) of the component cap, indexed
// by the count of DISTINCT canonical evidence items. The last entry is the
// cap: any further volume adds nothing.
export const POLICY = {
  version: TRUST_SCORE_POLICY_VERSION,

  // Component weights — must total 100.
  weights: {
    identity: 15,
    footballHistory: 20,
    relationships: 20,
    evidence: 20,
    combine: 15,
    references: 10,
  },

  bands: [
    { id: 'limited_evidence', label: 'Limited evidence', min: 0, max: 39 },
    { id: 'developing_evidence', label: 'Developing evidence', min: 40, max: 59 },
    { id: 'established_evidence', label: 'Established evidence', min: 60, max: 74 },
    { id: 'strong_evidence', label: 'Strong evidence', min: 75, max: 89 },
    { id: 'very_strong_evidence', label: 'Very strong evidence', min: 90, max: 100 },
  ],

  // Identity confidence from the M14.1 structured assurance level (never a
  // legacy boolean). A ScoutBox document review is honestly worth less than
  // an authoritative source.
  identity: {
    authoritative: 10000,
    organisation_attested: 8500,
    scoutbox_document_review: 7000,
    none: 0,
  },

  // Fact-specific authority for a CLUB-AFFILIATION fact. (Box Cam is
  // deliberately absent: it is strong authority for observed activity and no
  // authority at all for club affiliation.)
  historyProvenance: {
    authoritative_registry: 10000,
    verified_club_confirmed: 10000,
    verified_coach_confirmed: 8000,
    scoutbox_reviewed: 7000,
    historical_migration: 5000,
    system_recorded: 5000,
    guardian_submitted: 2500,
    player_submitted: 2500,
  },
  // Attributable-evidence "mass" needed for full football-history coverage.
  // Using a SUM (not a mean) keeps the score monotonic: adding an honest
  // self-submitted entry can only ever help, never dilute a confirmed one.
  history: { targetConfirmedMass: 2 },

  // Distinct verified relationships (club / coach). Prestige is never read.
  relationships: { curve: [0, 5000, 7500, 9000, 10000] },

  // Evidence confidence has TWO sub-sources with their own sub-caps, so
  // neither can max the category alone (§34).
  evidence: {
    recordsCurve: [0, 4000, 6000, 7500, 8500, 9200, 10000],
    recordsSubCap: 6000,
    boxCamCurve: [0, 4500, 6500, 8000, 8800, 9400, 10000],
    boxCamSubCap: 6000,
    recencyDays: 365, // recency applies to CURRENT evidence coverage only
    provenance: {
      authoritative_registry: 10000, verified_club_confirmed: 10000,
      verified_coach_confirmed: 8000, scoutbox_reviewed: 7000,
      box_cam_observed: 7000, system_recorded: 5000,
      historical_migration: 5000, guardian_submitted: 3000, player_submitted: 3000,
    },
  },

  // Combine confidence: coverage across DISTINCT standardized protocols.
  // Repeating one protocol 100 times is one protocol's worth of coverage.
  combine: { protocolCurve: [0, 5500, 8000, 9200, 10000] },

  // References/assessments: existence + provenance only. The CONTENT of an
  // assessment (a 4/10 or a 9/10) is never read.
  references: { curve: [0, 5500, 8000, 10000] },

  // Component confidence labels (neutral, evidence-focused).
  levels: [
    { id: 'none', label: 'Not yet established', min: 0 },
    { id: 'limited', label: 'Limited', min: 2500 },
    { id: 'established', label: 'Established', min: 5000 },
    { id: 'strong', label: 'Strong', min: 7500 },
    { id: 'very_strong', label: 'Very strong', min: 9000 },
  ],
};

export const TRUST_DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';

// Machine-readable change reasons (§45). No restricted source IDs.
export const TRUST_CHANGE_REASONS = [
  'IDENTITY_CONFIRMED', 'CURRENT_CLUB_CONFIRMED', 'CAREER_RECORD_CONFIRMED',
  'COACH_RELATIONSHIP_CONFIRMED', 'REFERENCE_CONFIRMED', 'BOX_CAM_EVIDENCE_ADDED',
  'COMBINE_VERIFIED_ADDED', 'EVIDENCE_EXPIRED', 'CLAIM_REVOKED',
  'COMBINE_INVALIDATED', 'COMBINE_RESTORED',
];

// ------------------------------------------------------------- primitives
const clampBp = (bp) => Math.max(0, Math.min(10000, Math.round(bp)));

/** Diminishing returns: a policy curve indexed by DISTINCT evidence count.
 *  Beyond the table's end the cap applies — volume stops mattering. */
export function applyDiminishingReturns(count, curve) {
  if (!Array.isArray(curve) || curve.length === 0) return 0;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return clampBp(curve[Math.min(n, curve.length - 1)]);
}

/** The neutral band for a 0–100 score. Deterministic at every boundary. */
export function trustBandForScore(score, policy = POLICY) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const band = policy.bands.find((b) => s >= b.min && s <= b.max) ?? policy.bands[0];
  return { id: band.id, label: band.label, min: band.min, max: band.max };
}

const levelFor = (coverageBp, policy = POLICY) => {
  let out = policy.levels[0];
  for (const l of policy.levels) if (coverageBp >= l.min) out = l;
  return { id: out.id, label: out.label };
};

/** Canonical de-duplication (§39). The same underlying fact reaches this
 *  engine through the Passport, the timeline, club history and Box Cam
 *  projections; we score the canonical SOURCE once, never the projection. */
export function canonicalTrustSources(items) {
  const seen = new Map();
  for (const it of items ?? []) {
    if (!it || !it.key) continue;
    const prev = seen.get(it.key);
    // Keep the strongest statement of the same canonical fact.
    if (!prev || (Number(it.strengthBp) || 0) > (Number(prev.strengthBp) || 0)) seen.set(it.key, it);
  }
  return [...seen.values()];
}

/** Which components apply to THIS player (§28/§61). A minor is never scored
 *  against evidence categories that cannot legally or architecturally exist
 *  for them — the weight leaves the DENOMINATOR instead of scoring zero. */
export function eligibleTrustComponents(playerContext = {}, policy = POLICY) {
  const eligible = { ...policy.weights };
  const excluded = [];
  // (No whole component is adult-only today: relationships handles the
  // agency facet internally by simply not counting agency relationships for
  // minors, which cannot exist under the standing rules.)
  return { eligible, excluded, adultOnlyFacets: playerContext.isAdult ? [] : ['agency_representation'] };
}

const component = (weight, coverageBp, { reasons = [], strengths = [], gaps = [], detail = {} } = {}) => ({
  weight,
  availableWeight: weight,
  coverageBp: clampBp(coverageBp),
  earnedWeightBp: Math.round(weight * clampBp(coverageBp)), // weight × bp  (max weight*10000)
  level: levelFor(clampBp(coverageBp)),
  reasons, strengths, gaps, detail,
});

// ------------------------------------------------------- component scorers
/** Identity confidence from the structured M14.1 assurance level. */
export function scoreIdentityConfidence({ assurance = null }, policy = POLICY) {
  const w = policy.weights.identity;
  const bp = policy.identity[assurance ?? 'none'] ?? 0;
  if (!assurance) {
    return component(w, 0, {
      reasons: ['IDENTITY_NOT_ESTABLISHED'],
      gaps: [{ code: 'IDENTITY_NOT_ESTABLISHED', text: 'Your identity has not yet been confirmed on ScoutBox.' }],
    });
  }
  const label = assurance === 'authoritative'
    ? 'Identity confirmed by an authoritative source.'
    : assurance === 'organisation_attested'
      ? 'Identity confirmed by an authorised organisation administrator.'
      : 'Identity confirmed by ScoutBox review.';
  return component(w, bp, {
    reasons: [`IDENTITY_${String(assurance).toUpperCase()}`],
    strengths: [{ code: 'IDENTITY_CONFIRMED', text: label }],
    gaps: assurance === 'scoutbox_document_review'
      ? [{ code: 'IDENTITY_REVIEW_ONLY', text: 'Identity was confirmed by document review rather than an authoritative source.' }] : [],
    detail: { assurance },
  });
}

/** Football-history confidence: attributable-evidence mass over the
 *  canonical club-history rows. Historical facts never decay (§36/§37). */
export function scoreFootballHistoryConfidence({ rows = [] }, policy = POLICY) {
  const w = policy.weights.footballHistory;
  const canonical = canonicalTrustSources(rows.map((r) => ({
    key: r.key, strengthBp: policy.historyProvenance[r.provenance] ?? 0, row: r,
  })));
  if (canonical.length === 0) {
    return component(w, 0, {
      reasons: ['NO_FOOTBALL_HISTORY'],
      gaps: [{ code: 'NO_FOOTBALL_HISTORY', text: 'Your Football Passport does not yet contain club history.' }],
    });
  }
  const mass = canonical.reduce((t, c) => t + c.strengthBp / 10000, 0);
  const coverage = clampBp((mass / policy.history.targetConfirmedMass) * 10000);
  const confirmedCurrent = canonical.some((c) => c.row.current && c.strengthBp >= policy.historyProvenance.scoutbox_reviewed);
  const selfOnly = canonical.filter((c) => c.strengthBp <= policy.historyProvenance.player_submitted);
  const strengths = [];
  const gaps = [];
  if (confirmedCurrent) strengths.push({ code: 'CURRENT_CLUB_CONFIRMED', text: 'Your current club is confirmed.' });
  else gaps.push({ code: 'CURRENT_CLUB_UNCONFIRMED', text: 'Your current club is not independently confirmed yet.' });
  const confirmedCount = canonical.filter((c) => c.strengthBp >= policy.historyProvenance.verified_coach_confirmed).length;
  if (confirmedCount > 0) strengths.push({ code: 'CAREER_RECORD_CONFIRMED', text: `${confirmedCount} club record${confirmedCount > 1 ? 's are' : ' is'} independently confirmed.` });
  if (selfOnly.length > 0) {
    gaps.push({ code: 'HISTORY_PLAYER_SUBMITTED', text: `${selfOnly.length} club entr${selfOnly.length > 1 ? 'ies are' : 'y is'} provided by the player and not independently confirmed.` });
  }
  return component(w, coverage, {
    reasons: ['HISTORY_COVERAGE'], strengths, gaps,
    detail: { rows: canonical.length, confirmedRows: confirmedCount, attributableMass: Math.round(mass * 100) / 100 },
  });
}

/** Verified-relationship confidence. Counts DISTINCT relationships by
 *  provenance strength. Club prestige is never an input — the organisation's
 *  name, level, size and reputation are not read here at all. */
export function scoreRelationshipConfidence({ relationships = [], isAdult = true }, policy = POLICY) {
  const w = policy.weights.relationships;
  const usable = (relationships ?? []).filter((r) => {
    if (!r || !r.verified) return false;
    // Agency representation cannot exist for a minor — excluded, never
    // counted as a missing/failed category for them.
    if (r.kind === 'agency' && !isAdult) return false;
    return true;
  });
  const canonical = canonicalTrustSources(usable.map((r) => ({ key: r.key, strengthBp: 10000, rel: r })));
  const coverage = applyDiminishingReturns(canonical.length, policy.relationships.curve);
  const coaches = canonical.filter((c) => c.rel.kind === 'coach').length;
  const clubs = canonical.filter((c) => c.rel.kind === 'club').length;
  const strengths = [];
  if (clubs > 0) strengths.push({ code: 'CLUB_RELATIONSHIP_CONFIRMED', text: `${clubs} verified club relationship${clubs > 1 ? 's' : ''}.` });
  if (coaches > 0) strengths.push({ code: 'COACH_RELATIONSHIP_CONFIRMED', text: `${coaches} verified coach relationship${coaches > 1 ? 's' : ''}.` });
  return component(w, coverage, {
    reasons: ['RELATIONSHIP_COVERAGE'], strengths,
    gaps: canonical.length === 0 ? [{ code: 'NO_VERIFIED_RELATIONSHIPS', text: 'No verified club or coach relationship is recorded yet.' }] : [],
    detail: { distinct: canonical.length, clubs, coaches },
  });
}

/** Evidence confidence: provenance-bearing football evidence plus Box Cam
 *  observed evidence, each with its own sub-cap so neither alone can max the
 *  category. Quantity is explicitly NOT truth — both use diminishing returns. */
export function scoreEvidenceConfidence({ evidenceItems = [], boxCamSessions = [], now = Date.now(), allowSimulatedEvidence = false }, policy = POLICY) {
  const w = policy.weights.evidence;
  const p = policy.evidence;
  const recs = canonicalTrustSources((evidenceItems ?? []).map((e) => ({
    key: e.key, strengthBp: p.provenance[e.provenance] ?? 0, item: e,
  }))).filter((c) => c.strengthBp > 0);
  // Box Cam: only genuine, non-simulated observed sessions count toward
  // production trust. Simulated (test-provider) sessions are excluded unless
  // this is an explicitly simulated demo context.
  const box = canonicalTrustSources((boxCamSessions ?? [])
    .filter((s) => (allowSimulatedEvidence || !s.simulated))
    .filter((s) => ['verified', 'partially_verified'].includes(s.verificationState))
    .map((s) => ({ key: s.key, strengthBp: 10000, s })));

  const recBp = Math.min(applyDiminishingReturns(recs.length, p.recordsCurve), p.recordsSubCap);
  const boxBp = Math.min(applyDiminishingReturns(box.length, p.boxCamCurve), p.boxCamSubCap);
  const coverage = clampBp(recBp + boxBp);

  const strengths = [];
  const gaps = [];
  if (recs.length > 0) strengths.push({ code: 'EVIDENCE_RECORDED', text: `${recs.length} provenance-bearing evidence item${recs.length > 1 ? 's' : ''} on record.` });
  else gaps.push({ code: 'NO_EVIDENCE', text: 'No provenance-bearing football evidence is recorded yet.' });
  if (box.length > 0) strengths.push({ code: 'BOX_CAM_EVIDENCE', text: `${box.length} Box Cam observed training session${box.length > 1 ? 's' : ''}.` });
  return component(w, coverage, {
    reasons: ['EVIDENCE_COVERAGE'], strengths, gaps,
    detail: { evidenceItems: recs.length, boxCamSessions: box.length, recordsBp: recBp, boxCamBp: boxBp, subCaps: { records: p.recordsSubCap, boxCam: p.boxCamSubCap } },
  });
}

/** Combine confidence: coverage across DISTINCT standardized protocols with
 *  a currently-valid Combine Verified result.
 *
 *  THE INVARIANT: the measured VALUE is never read. A 40-touch and a
 *  250-touch Box Touch 60, both Combine Verified with the same integrity,
 *  contribute exactly the same. Repeating one protocol is one protocol's
 *  coverage; a personal best adds no trust. `partially_measured` does not
 *  count here (it may still count as Box Cam evidence). Simulated
 *  (test-provider) results never contribute to production trust. */
export function scoreCombineConfidence({ attempts = [], allowSimulatedEvidence = false }, policy = POLICY) {
  const w = policy.weights.combine;
  const valid = (attempts ?? []).filter((a) => a
    && a.combineState === 'combine_verified'
    && (allowSimulatedEvidence || !a.simulated));
  // Distinct canonical protocol coverage (protocolId@version) — NOT attempt
  // count, and never the measured value.
  const protocols = canonicalTrustSources(valid.map((a) => ({
    key: `protocol:${a.protocolId}@${a.protocolVersion}`, strengthBp: 10000, a,
  })));
  const coverage = applyDiminishingReturns(protocols.length, policy.combine.protocolCurve);
  const excludedSimulated = (attempts ?? []).filter((a) => a && a.simulated && a.combineState === 'combine_verified').length;
  const strengths = [];
  const gaps = [];
  if (protocols.length > 0) {
    strengths.push({ code: 'COMBINE_VERIFIED', text: `${protocols.length} standardized Combine Verified measurement${protocols.length > 1 ? 's' : ''}.` });
  } else {
    gaps.push({
      code: 'NO_COMBINE_VERIFIED',
      text: 'No production-supported Combine Verified result is currently available.',
    });
  }
  return component(w, coverage, {
    reasons: ['COMBINE_COVERAGE'], strengths, gaps,
    detail: { distinctProtocols: protocols.length, validAttempts: valid.length, excludedSimulated },
  });
}

/** References / assessments confidence — provenance and existence only. The
 *  CONTENT of an assessment never affects the score: a 4/10 and a 9/10 from
 *  the same verified evaluator are identical evidence. */
export function scoreReferencesConfidence({ references = [], assessments = [] }, policy = POLICY) {
  const w = policy.weights.references;
  const items = canonicalTrustSources([
    ...(references ?? []).filter((r) => r.verified).map((r) => ({ key: r.key, strengthBp: 10000, kind: 'reference' })),
    ...(assessments ?? []).filter((a) => a.verifiedSource).map((a) => ({ key: a.key, strengthBp: 8000, kind: 'assessment' })),
  ]);
  const coverage = applyDiminishingReturns(items.length, policy.references.curve);
  const refs = items.filter((i) => i.kind === 'reference').length;
  const asmts = items.filter((i) => i.kind === 'assessment').length;
  const strengths = [];
  if (refs > 0) strengths.push({ code: 'REFERENCE_CONFIRMED', text: `${refs} reference${refs > 1 ? 's' : ''} with verified provenance.` });
  if (asmts > 0) strengths.push({ code: 'ASSESSMENT_ATTRIBUTED', text: `${asmts} assessment${asmts > 1 ? 's' : ''} from a verified evaluator.` });
  return component(w, coverage, {
    reasons: ['REFERENCE_COVERAGE'], strengths,
    gaps: items.length === 0 ? [{ code: 'NO_REFERENCES', text: 'No verified coach reference is currently present.' }] : [],
    detail: { references: refs, assessments: asmts },
  });
}

// ------------------------------------------------------------ the engine
/** Deterministic Trust Score. Integer/basis-point math throughout with a
 *  single documented rounding at the end (round-half-up to a whole number),
 *  so the same inputs always produce the same score. */
export function calculateTrustScore(input, policy = POLICY) {
  const {
    playerContext = { isAdult: true },
    identity = null,
    historyRows = [],
    relationships = [],
    evidenceItems = [],
    boxCamSessions = [],
    combineAttempts = [],
    references = [],
    assessments = [],
    now = Date.now(),
    allowSimulatedEvidence = false,
  } = input ?? {};

  const isAdult = playerContext.isAdult !== false;
  const { excluded, adultOnlyFacets } = eligibleTrustComponents({ isAdult }, policy);

  const components = {
    identity: scoreIdentityConfidence({ assurance: identity?.assurance ?? null }, policy),
    footballHistory: scoreFootballHistoryConfidence({ rows: historyRows }, policy),
    relationships: scoreRelationshipConfidence({ relationships, isAdult }, policy),
    evidence: scoreEvidenceConfidence({ evidenceItems, boxCamSessions, now, allowSimulatedEvidence }, policy),
    combine: scoreCombineConfidence({ attempts: combineAttempts, allowSimulatedEvidence }, policy),
    references: scoreReferencesConfidence({ references, assessments }, policy),
  };

  // Denominator = the components that apply to THIS player. Ineligible
  // categories leave the denominator rather than scoring zero.
  const availableWeight = Object.values(components).reduce((t, c) => t + c.availableWeight, 0);
  const earnedBp = Object.values(components).reduce((t, c) => t + c.earnedWeightBp, 0);
  // earnedBp is Σ(weight × coverageBp); normalise against availableWeight×10000.
  const score = availableWeight === 0 ? 0
    : Math.max(0, Math.min(100, Math.round((earnedBp / (availableWeight * 10000)) * 100)));

  const band = trustBandForScore(score, policy);
  const strengths = Object.values(components).flatMap((c) => c.strengths);
  const gaps = Object.values(components).flatMap((c) => c.gaps);

  return {
    score,
    band: band.id,
    bandLabel: band.label,
    policyVersion: policy.version,
    disclaimer: TRUST_DISCLAIMER,
    components,
    strengths,
    gaps,
    explanations: Object.entries(components).map(([id, c]) => ({
      component: id,
      level: c.level.id,
      levelLabel: c.level.label,
      weight: c.weight,
      coverage: Math.round(c.coverageBp / 100),
      reasons: [...c.strengths, ...c.gaps].map((r) => r.text),
    })),
    context: { isAdult, excludedComponents: Object.keys(excluded ?? {}).length ? [] : [], adultOnlyFacetsExcluded: adultOnlyFacets },
    simulatedEvidenceIncluded: !!allowSimulatedEvidence,
  };
}

/** Alias matching the milestone's conceptual name. */
export const buildTrustProfile = calculateTrustScore;

/** Viewer-safe projection (§54/§74–§76). Restricted source data never leaves
 *  through this projection: no source IDs, no guardian identities, no
 *  assessment content, no T&S reasons, no verification evidence. */
export function safeTrustProjection(profile, viewer, { publicAllowed = false } = {}) {
  const base = {
    score: profile.score, band: profile.band, bandLabel: profile.bandLabel,
    policyVersion: profile.policyVersion, disclaimer: profile.disclaimer,
    simulatedEvidenceIncluded: profile.simulatedEvidenceIncluded,
  };
  switch (viewer) {
    case 'self':
    case 'guardian':
    case 'trust_safety':
      return { ...base, viewer, components: profile.components, strengths: profile.strengths, gaps: profile.gaps, explanations: profile.explanations, context: profile.context };
    case 'pro_club':
    case 'grassroots_club':
      // Safe, high-level reasons only — the component levels and the public
      // wording of each signal, never the underlying records.
      return {
        ...base, viewer,
        explanations: profile.explanations.map((e) => ({ component: e.component, level: e.level, levelLabel: e.levelLabel, weight: e.weight })),
        signals: profile.strengths.map((s) => ({ code: s.code, text: s.text })),
        note: 'Evidence confidence — not football ability.',
      };
    case 'public':
      return publicAllowed ? { ...base, viewer } : null;
    default:
      return null;
  }
}

/** Compact batch summary for player lists (§53) — no N+1 passport builds. */
export function trustSummary(profile) {
  return {
    score: profile.score, band: profile.band, bandLabel: profile.bandLabel,
    policyVersion: profile.policyVersion,
    topEvidenceSignals: profile.strengths.slice(0, 3).map((s) => s.code),
  };
}

/** Deterministic reason codes for a score change (§45/§68). Never exposes a
 *  restricted source ID — only what kind of evidence changed. */
export function trustChangeReasons(before, after) {
  const out = [];
  if (!before || !after) return out;
  const b = before.components ?? {};
  const a = after.components ?? {};
  const grew = (k) => (a[k]?.coverageBp ?? 0) > (b[k]?.coverageBp ?? 0);
  const shrank = (k) => (a[k]?.coverageBp ?? 0) < (b[k]?.coverageBp ?? 0);
  if (grew('identity')) out.push('IDENTITY_CONFIRMED');
  if (grew('footballHistory')) out.push('CAREER_RECORD_CONFIRMED');
  if (grew('relationships')) out.push('COACH_RELATIONSHIP_CONFIRMED');
  if (grew('references')) out.push('REFERENCE_CONFIRMED');
  if (grew('evidence')) out.push('BOX_CAM_EVIDENCE_ADDED');
  if (grew('combine')) out.push('COMBINE_VERIFIED_ADDED');
  if (shrank('combine')) out.push('COMBINE_INVALIDATED');
  if (shrank('identity') || shrank('relationships')) out.push('CLAIM_REVOKED');
  if (shrank('evidence')) out.push('EVIDENCE_EXPIRED');
  return out;
}

/** Snapshot DTO for future Recruitment Rooms (§67) — score AT decision time
 *  with the policy version and component summary that produced it. */
export function trustSnapshot(profile, { at = Date.now() } = {}) {
  return {
    at, score: profile.score, band: profile.band, policyVersion: profile.policyVersion,
    components: Object.fromEntries(Object.entries(profile.components).map(([k, c]) => [k, { weight: c.weight, coverage: Math.round(c.coverageBp / 100), level: c.level.id }])),
    hash: crypto.createHash('sha256').update(JSON.stringify({
      score: profile.score, policyVersion: profile.policyVersion,
      cov: Object.fromEntries(Object.entries(profile.components).map(([k, c]) => [k, c.coverageBp])),
    })).digest('hex').slice(0, 32),
  };
}

/** Policy self-check: weights must total 100. Exported so tests and boot can
 *  both assert it rather than trusting the table by eye. */
export function policyWeightsTotal(policy = POLICY) {
  return Object.values(policy.weights).reduce((t, n) => t + n, 0);
}
