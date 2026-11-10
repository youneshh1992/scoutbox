// Trust Score: how strongly is this player's football record supported by trustworthy, current and attributable
// evidence? Not a talent score or a recommendation, and it grants no permission.
//
//   • A provenance is scored for the kind of fact it supports, not through one universal rank.
//   • A Combine measurement's value is never read, only that a valid standardised measurement exists.
//   • Every category is capped with diminishing returns, so volume cannot buy trust.
//   • Prestige, popularity, recruitment outcomes and payment are not inputs.
//   • Missing evidence is limited evidence, not dishonesty.
//   • Adding evidence must not lower a score.
import crypto from 'node:crypto';

export const TRUST_SCORE_POLICY_VERSION = 1;

// ---------------------------------------------------------------- policy
// Curves are basis points (0–10000) of the component cap, indexed by the count of distinct evidence items; the last
// entry is the cap.
export const POLICY = {
  version: TRUST_SCORE_POLICY_VERSION,

  // Must total 100.
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

  // A ScoutBox document review is worth less than an authoritative source.
  identity: {
    authoritative: 10000,
    organisation_attested: 8500,
    scoutbox_document_review: 7000,
    none: 0,
  },

  // Authority for a club-affiliation fact. Box Cam is absent: it is authority for observed activity, not affiliation.
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
  // A sum, not a mean, keeps the score monotonic: a self-submitted entry cannot dilute a confirmed one.
  history: { targetConfirmedMass: 2 },

  relationships: { curve: [0, 5000, 7500, 9000, 10000] },

  // Two sub-sources with their own sub-caps, so neither can max the category alone.
  evidence: {
    recordsCurve: [0, 4000, 6000, 7500, 8500, 9200, 10000],
    recordsSubCap: 6000,
    boxCamCurve: [0, 4500, 6500, 8000, 8800, 9400, 10000],
    boxCamSubCap: 6000,
    recencyDays: 365, // applies to current evidence coverage only
    provenance: {
      authoritative_registry: 10000, verified_club_confirmed: 10000,
      verified_coach_confirmed: 8000, scoutbox_reviewed: 7000,
      box_cam_observed: 7000, system_recorded: 5000,
      historical_migration: 5000, guardian_submitted: 3000, player_submitted: 3000,
    },
  },

  // Coverage across distinct protocols: repeating one protocol is one protocol's worth.
  combine: { protocolCurve: [0, 5500, 8000, 9200, 10000] },

  // Existence and provenance only; the content of an assessment is never read.
  references: { curve: [0, 5500, 8000, 10000] },

  levels: [
    { id: 'none', label: 'Not yet established', min: 0 },
    { id: 'limited', label: 'Limited', min: 2500 },
    { id: 'established', label: 'Established', min: 5000 },
    { id: 'strong', label: 'Strong', min: 7500 },
    { id: 'very_strong', label: 'Very strong', min: 9000 },
  ],
};

export const TRUST_DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';

export const TRUST_CHANGE_REASONS = [
  'IDENTITY_CONFIRMED', 'CURRENT_CLUB_CONFIRMED', 'CAREER_RECORD_CONFIRMED',
  'COACH_RELATIONSHIP_CONFIRMED', 'REFERENCE_CONFIRMED', 'BOX_CAM_EVIDENCE_ADDED',
  'COMBINE_VERIFIED_ADDED', 'EVIDENCE_EXPIRED', 'CLAIM_REVOKED',
  'COMBINE_INVALIDATED', 'COMBINE_RESTORED',
];

// ------------------------------------------------------------- primitives
const clampBp = (bp) => Math.max(0, Math.min(10000, Math.round(bp)));

export function applyDiminishingReturns(count, curve) {
  if (!Array.isArray(curve) || curve.length === 0) return 0;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return clampBp(curve[Math.min(n, curve.length - 1)]);
}

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

/** The same fact arrives through several projections (Passport, timeline, club history, Box Cam); the source is
 *  scored once. */
export function canonicalTrustSources(items) {
  const seen = new Map();
  for (const it of items ?? []) {
    if (!it || !it.key) continue;
    const prev = seen.get(it.key);
    if (!prev || (Number(it.strengthBp) || 0) > (Number(prev.strengthBp) || 0)) seen.set(it.key, it);
  }
  return [...seen.values()];
}

/** A component that cannot exist for a player leaves the denominator rather than scoring zero. */
export function eligibleTrustComponents(playerContext = {}, policy = POLICY) {
  const eligible = { ...policy.weights };
  const excluded = [];
  // No whole component is adult-only today: relationships drops agency relationships for minors itself.
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

/** Historical facts never decay. */
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

export function scoreRelationshipConfidence({ relationships = [], isAdult = true }, policy = POLICY) {
  const w = policy.weights.relationships;
  const usable = (relationships ?? []).filter((r) => {
    if (!r || !r.verified) return false;
    // Agency representation cannot exist for a minor, so it is not counted as missing.
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

export function scoreEvidenceConfidence({ evidenceItems = [], boxCamSessions = [], now = Date.now(), allowSimulatedEvidence = false }, policy = POLICY) {
  const w = policy.weights.evidence;
  const p = policy.evidence;
  const recs = canonicalTrustSources((evidenceItems ?? []).map((e) => ({
    key: e.key, strengthBp: p.provenance[e.provenance] ?? 0, item: e,
  }))).filter((c) => c.strengthBp > 0);
  // Simulated (test-provider) sessions count only in an explicitly simulated context.
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

/** The measured value is never read: a personal best adds no trust. `partially_measured` does not count here (it may
 *  still count as Box Cam evidence). */
export function scoreCombineConfidence({ attempts = [], allowSimulatedEvidence = false }, policy = POLICY) {
  const w = policy.weights.combine;
  const valid = (attempts ?? []).filter((a) => a
    && a.combineState === 'combine_verified'
    && (allowSimulatedEvidence || !a.simulated));
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

/** A 4/10 and a 9/10 from the same verified evaluator are identical evidence. */
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
/** Basis-point arithmetic with a single rounding at the end, so the same inputs always produce the same score. */
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

  const availableWeight = Object.values(components).reduce((t, c) => t + c.availableWeight, 0);
  const earnedBp = Object.values(components).reduce((t, c) => t + c.earnedWeightBp, 0);
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

export const buildTrustProfile = calculateTrustScore;

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
      // Component levels and the public wording of each signal, never the underlying records.
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

export function trustSummary(profile) {
  return {
    score: profile.score, band: profile.band, bandLabel: profile.bandLabel,
    policyVersion: profile.policyVersion,
    topEvidenceSignals: profile.strengths.slice(0, 3).map((s) => s.code),
  };
}

/** Only what kind of evidence changed, never a source id. */
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

/** The score at a Recruitment Room decision, with the policy version that produced it. */
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

export function policyWeightsTotal(policy = POLICY) {
  return Object.values(policy.weights).reduce((t, n) => t + n, 0);
}
