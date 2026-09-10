// M16.2 demo mirror — a SELF-CONTAINED ScoutBox Trust Profile fixture.
//
// ⚠ Circular-import discipline (this bit shipped broken in M16.1): the only
// thing this module takes from ./trustClient is TYPES (`import type`, erased at
// build time). It never imports a runtime binding from the module that imports
// it, and it never calls an imported value at module-load time. Every constant
// below is defined here.
//
// The fixture mirrors what the server would derive for the demo player: the
// numbers are the policy's own arithmetic (Σ weight × coverage ÷ available
// weight), the copy is the server's neutral wording, and the profile is always
// flagged simulatedEvidenceIncluded so the UI can label it as a demo.
import type {
  TrustClient, TrustSelf, TrustComponent, TrustComponentId, TrustExplained,
  TrustLevel, TrustPolicy, TrustSignal,
} from './trustClient';

const DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';

// The five bands. No other band exists anywhere in the product.
const BANDS = [
  { id: 'limited_evidence', label: 'Limited evidence', min: 0, max: 39 },
  { id: 'developing_evidence', label: 'Developing evidence', min: 40, max: 59 },
  { id: 'established_evidence', label: 'Established evidence', min: 60, max: 74 },
  { id: 'strong_evidence', label: 'Strong evidence', min: 75, max: 89 },
  { id: 'very_strong_evidence', label: 'Very strong evidence', min: 90, max: 100 },
];

const WEIGHTS: Record<TrustComponentId, number> = {
  identity: 15, footballHistory: 20, relationships: 20, evidence: 20, combine: 15, references: 10,
};

const LEVELS: { id: string; label: string; min: number }[] = [
  { id: 'none', label: 'Not yet established', min: 0 },
  { id: 'limited', label: 'Limited', min: 2500 },
  { id: 'established', label: 'Established', min: 5000 },
  { id: 'strong', label: 'Strong', min: 7500 },
  { id: 'very_strong', label: 'Very strong', min: 9000 },
];

function levelFor(coverageBp: number): TrustLevel {
  let out = LEVELS[0];
  for (const l of LEVELS) if (coverageBp >= l.min) out = l;
  return { id: out.id, label: out.label };
}

function component(id: TrustComponentId, coverageBp: number, parts: {
  reasons?: string[]; strengths?: TrustSignal[]; gaps?: TrustSignal[]; detail?: Record<string, unknown>;
}): TrustComponent {
  const weight = WEIGHTS[id];
  return {
    weight,
    availableWeight: weight,
    coverageBp,
    earnedWeightBp: weight * coverageBp,
    level: levelFor(coverageBp),
    reasons: parts.reasons ?? [],
    strengths: parts.strengths ?? [],
    gaps: parts.gaps ?? [],
    detail: parts.detail ?? {},
  };
}

// Coverage per component for the demo player. Missing evidence is shown as an
// evidence gap — never as a failing, a risk or a judgement of the player.
const components: Record<TrustComponentId, TrustComponent> = {
  identity: component('identity', 7000, {
    reasons: ['IDENTITY_SCOUTBOX_DOCUMENT_REVIEW'],
    strengths: [{ code: 'IDENTITY_CONFIRMED', text: 'Identity confirmed by ScoutBox review.' }],
    gaps: [{ code: 'IDENTITY_REVIEW_ONLY', text: 'Identity was confirmed by document review rather than an authoritative source.' }],
    detail: { assurance: 'scoutbox_document_review' },
  }),
  footballHistory: component('footballHistory', 8750, {
    reasons: ['HISTORY_COVERAGE'],
    strengths: [
      { code: 'CURRENT_CLUB_CONFIRMED', text: 'Your current club is confirmed.' },
      { code: 'CAREER_RECORD_CONFIRMED', text: '2 club records are independently confirmed.' },
    ],
    gaps: [{ code: 'HISTORY_PLAYER_SUBMITTED', text: '1 club entry is provided by the player and not independently confirmed.' }],
    detail: { rows: 3, confirmedRows: 2, attributableMass: 1.75 },
  }),
  relationships: component('relationships', 7500, {
    reasons: ['RELATIONSHIP_COVERAGE'],
    strengths: [
      { code: 'CLUB_RELATIONSHIP_CONFIRMED', text: '1 verified club relationship.' },
      { code: 'COACH_RELATIONSHIP_CONFIRMED', text: '1 verified coach relationship.' },
    ],
    detail: { distinct: 2, clubs: 1, coaches: 1 },
  }),
  evidence: component('evidence', 8500, {
    reasons: ['EVIDENCE_COVERAGE'],
    strengths: [
      { code: 'EVIDENCE_RECORDED', text: '1 provenance-bearing evidence item on record.' },
      { code: 'BOX_CAM_EVIDENCE', text: '1 Box Cam observed training session.' },
    ],
    detail: { evidenceItems: 1, boxCamSessions: 1, recordsBp: 4000, boxCamBp: 4500 },
  }),
  combine: component('combine', 9200, {
    reasons: ['COMBINE_COVERAGE'],
    strengths: [{ code: 'COMBINE_VERIFIED', text: '3 standardized Combine Verified measurements.' }],
    detail: { distinctProtocols: 3, validAttempts: 3, excludedSimulated: 0 },
  }),
  references: component('references', 5500, {
    reasons: ['REFERENCE_COVERAGE'],
    strengths: [{ code: 'REFERENCE_CONFIRMED', text: '1 reference with verified provenance.' }],
    detail: { references: 1, assessments: 0 },
  }),
};

const ORDER: TrustComponentId[] = ['identity', 'footballHistory', 'relationships', 'evidence', 'combine', 'references'];

const availableWeight = ORDER.reduce((t, id) => t + components[id].availableWeight, 0);
const earnedBp = ORDER.reduce((t, id) => t + components[id].earnedWeightBp, 0);
const score = Math.max(0, Math.min(100, Math.round((earnedBp / (availableWeight * 10000)) * 100)));
const band = BANDS.find((b) => score >= b.min && score <= b.max) ?? BANDS[0];

function profileFor(viewer: 'self' | 'guardian'): TrustSelf {
  return {
    score,
    band: band.id,
    bandLabel: band.label,
    policyVersion: 1,
    disclaimer: DISCLAIMER,
    // The demo runs on a simulated (test-provider) evidence context, so the
    // UI must say so wherever the score is shown.
    simulatedEvidenceIncluded: true,
    viewer,
    components,
    strengths: ORDER.flatMap((id) => components[id].strengths),
    gaps: ORDER.flatMap((id) => components[id].gaps),
    explanations: ORDER.map((id) => ({
      component: id,
      level: components[id].level.id,
      levelLabel: components[id].level.label,
      weight: components[id].weight,
      coverage: Math.round(components[id].coverageBp / 100),
      reasons: [...components[id].strengths, ...components[id].gaps].map((r) => r.text),
    })),
    context: { isAdult: false, adultOnlyFacetsExcluded: ['agency_representation'] },
  };
}

const policy: TrustPolicy = { version: 1, weights: { ...WEIGHTS }, bands: BANDS };

export const trustMock: TrustClient = {
  profile: async (a) => profileFor(a.kind === 'guardian' ? 'guardian' : 'self'),
  explain: async (): Promise<TrustExplained> => ({ trust: profileFor('self'), policy, disclaimer: DISCLAIMER }),
};
