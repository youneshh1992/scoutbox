// M16.2 demo mirror (org side) — a SELF-CONTAINED Trust Profile fixture.
//
// ⚠ Circular-import discipline (the exact bug that crashed the M16.1 bundle):
// trustApi imports this module, so this module takes only TYPES from trustApi
// (`import type`, erased at build time). It never reads a runtime binding from
// trustApi, and it never calls an imported value at module-load time. Every
// constant used to build these fixtures is declared right here.
//
// Same honesty rules as live: evidence confidence only, the mandatory
// disclaimer travels with the score, a low score is limited evidence, and
// nothing here is ranked.
import type { TrustApi, TrustClub, TrustSummaryRow } from './trustApi';

const DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';
const NOTE = 'Evidence confidence — not football ability.';

interface Fixture { score: number; band: string; bandLabel: string; levels: Record<string, [string, string]>; signals: { code: string; text: string }[] }

const WEIGHTS: Record<string, number> = {
  identity: 15, footballHistory: 20, relationships: 20, evidence: 20, combine: 15, references: 10,
};
const ORDER = ['identity', 'footballHistory', 'relationships', 'evidence', 'combine', 'references'];

// Two demo players. Elias has less evidence on record — which the UI must
// present as LIMITED EVIDENCE, never as a lesser or riskier player.
const FIXTURES: Record<string, Fixture> = {
  'pl-adeyemi': {
    score: 79, band: 'strong_evidence', bandLabel: 'Strong evidence',
    levels: {
      identity: ['established', 'Established'],
      footballHistory: ['strong', 'Strong'],
      relationships: ['strong', 'Strong'],
      evidence: ['strong', 'Strong'],
      combine: ['very_strong', 'Very strong'],
      references: ['established', 'Established'],
    },
    signals: [
      { code: 'IDENTITY_CONFIRMED', text: 'Identity confirmed by ScoutBox review.' },
      { code: 'CURRENT_CLUB_CONFIRMED', text: 'Your current club is confirmed.' },
      { code: 'CAREER_RECORD_CONFIRMED', text: '2 club records are independently confirmed.' },
      { code: 'CLUB_RELATIONSHIP_CONFIRMED', text: '1 verified club relationship.' },
      { code: 'COACH_RELATIONSHIP_CONFIRMED', text: '1 verified coach relationship.' },
      { code: 'BOX_CAM_EVIDENCE', text: '1 Box Cam observed training session.' },
      { code: 'COMBINE_VERIFIED', text: '3 standardized Combine Verified measurements.' },
      { code: 'REFERENCE_CONFIRMED', text: '1 reference with verified provenance.' },
    ],
  },
  'pl-svensson': {
    score: 46, band: 'developing_evidence', bandLabel: 'Developing evidence',
    levels: {
      identity: ['established', 'Established'],
      footballHistory: ['limited', 'Limited'],
      relationships: ['established', 'Established'],
      evidence: ['limited', 'Limited'],
      combine: ['established', 'Established'],
      references: ['none', 'Not yet established'],
    },
    signals: [
      { code: 'IDENTITY_CONFIRMED', text: 'Identity confirmed by ScoutBox review.' },
      { code: 'CLUB_RELATIONSHIP_CONFIRMED', text: '1 verified club relationship.' },
      { code: 'COMBINE_VERIFIED', text: '1 standardized Combine Verified measurement.' },
    ],
  },
};

const FALLBACK: Fixture = {
  score: 31, band: 'limited_evidence', bandLabel: 'Limited evidence',
  levels: {
    identity: ['limited', 'Limited'],
    footballHistory: ['limited', 'Limited'],
    relationships: ['none', 'Not yet established'],
    evidence: ['limited', 'Limited'],
    combine: ['none', 'Not yet established'],
    references: ['none', 'Not yet established'],
  },
  signals: [{ code: 'CLUB_RELATIONSHIP_CONFIRMED', text: '1 verified club relationship.' }],
};

const fixture = (playerId: string): Fixture => FIXTURES[playerId] ?? FALLBACK;

const project = (playerId: string): TrustClub => {
  const f = fixture(playerId);
  return {
    score: f.score, band: f.band, bandLabel: f.bandLabel, policyVersion: 1,
    disclaimer: DISCLAIMER,
    simulatedEvidenceIncluded: true,
    viewer: 'pro_club',
    explanations: ORDER.map((component) => ({
      component,
      level: f.levels[component][0],
      levelLabel: f.levels[component][1],
      weight: WEIGHTS[component],
    })),
    signals: f.signals,
    note: NOTE,
  };
};

export const demoTrust: TrustApi = {
  player: async (_s, playerId) => project(playerId),
  // Returned in the order requested — never ranked by score.
  summaries: async (_s, playerIds) => ({
    items: playerIds.map((playerId): TrustSummaryRow => {
      const f = fixture(playerId);
      return {
        playerId, score: f.score, band: f.band, bandLabel: f.bandLabel, policyVersion: 1,
        topEvidenceSignals: f.signals.slice(0, 3).map((s) => s.code),
      };
    }),
    note: 'Evidence confidence — not football ability. Results are returned in the order requested and are never ranked by Trust Score.',
  }),
};
