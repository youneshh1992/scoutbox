// M16.2 — ScoutBox Trust Score, the player/guardian typed client.
//
// The Trust Score answers ONE question: how strongly is this player's football
// record supported by trustworthy, current, attributable evidence? It is NOT
// ability, talent, potential, character, popularity or recruitment
// suitability, and a LOW score means LIMITED EVIDENCE — never bad character.
//
// The score is DERIVED SERVER-SIDE on every read from canonical evidence: this
// client never computes, adjusts, caches or asserts a score, and there is no
// write route at all. The Football Passport payload deliberately carries no
// numeric score (M15), so the Trust Profile is fetched from its own endpoint
// and composed into the UI next to the Passport.
import { m12Request as req } from './httpClient';
import { trustMock } from './trustMock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export type TrustComponentId =
  | 'identity' | 'footballHistory' | 'relationships' | 'evidence' | 'combine' | 'references';

/** A single evidence signal. `text` is server-authored, neutral copy: a gap is
 *  always an EVIDENCE GAP, never a player weakness or a suggestion of
 *  dishonesty. Clients render it verbatim. */
export interface TrustSignal { code: string; text: string }

export interface TrustLevel { id: string; label: string }

export interface TrustComponent {
  weight: number;
  availableWeight: number;
  coverageBp: number;
  earnedWeightBp: number;
  level: TrustLevel;
  reasons: string[];
  strengths: TrustSignal[];
  gaps: TrustSignal[];
  detail: Record<string, unknown>;
}

/** Per-component derivation as the server explains it ("Why this score?"). */
export interface TrustExplanation {
  component: string;
  level: string;
  levelLabel: string;
  weight: number;
  coverage: number;
  reasons: string[];
}

export interface TrustBand { id: string; label: string; min: number; max: number }

/** The self/guardian projection returned by the server. */
export interface TrustSelf {
  score: number;
  band: string;
  bandLabel: string;
  policyVersion: number;
  disclaimer: string;
  simulatedEvidenceIncluded: boolean;
  viewer: string;
  components: Record<TrustComponentId, TrustComponent>;
  strengths: TrustSignal[];
  gaps: TrustSignal[];
  explanations: TrustExplanation[];
  context: { isAdult: boolean; adultOnlyFacetsExcluded: string[] };
}

export interface TrustPolicy {
  version: number;
  weights: Record<string, number>;
  bands: TrustBand[];
}

export interface TrustExplained {
  trust: TrustSelf;
  policy: TrustPolicy;
  disclaimer: string;
}

export type TrustActor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

export interface TrustClient {
  /** The viewer's own (or their child's) Trust Profile. */
  profile(a: TrustActor): Promise<TrustSelf>;
  /** The same derivation plus the policy that produced it — "Why this score?". */
  explain(playerId: string): Promise<TrustExplained>;
}

const live: TrustClient = {
  profile: async (a) => (
    a.kind === 'player'
      ? (await req<{ trust: TrustSelf }>('/player/trust-profile', a.id)).trust
      : (await req<{ trust: TrustSelf }>(`/guardian/children/${a.childId}/trust-profile`, a.id)).trust
  ),
  explain: (playerId) => req<TrustExplained>('/player/trust-profile/explain', playerId),
};

export const trust: TrustClient = DEMO ? trustMock : live;
