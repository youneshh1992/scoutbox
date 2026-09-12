// M16.2 typed client (org side): the ScoutBox Trust Score.
//
// What the score IS: how strongly a player's football record is supported by
// trustworthy, current, attributable evidence. What it is NOT: ability,
// talent, potential, character, popularity, effort or recruitment suitability.
// A low score means LIMITED EVIDENCE — never a judgement of the player.
//
// The org projection is deliberately narrow: score, band, the safe component
// LEVELS and the safe evidence signals. Component internals, gaps, detail and
// source records never reach a club, so this module has no type for them.
//
// The Trust Score grants no access whatsoever: every standing gate (agency
// wall, verification, distance, blocks) runs server-side before the payload is
// built, and a score of 100 opens no door that a score of 0 would not.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoTrust } from './trustDemo';

export interface TrustSignal { code: string; text: string }

/** Safe per-component projection: the level, never the underlying records. */
export interface TrustComponentLevel {
  component: string;
  level: string;
  levelLabel: string;
  weight: number;
}

export interface TrustClub {
  score: number;
  band: string;
  bandLabel: string;
  policyVersion: number;
  disclaimer: string;
  simulatedEvidenceIncluded: boolean;
  viewer: string;
  explanations: TrustComponentLevel[];
  signals: TrustSignal[];
  note: string;
}

/** Batch summary row for player lists. Lists are NEVER sorted or ranked by
 *  Trust Score — the server returns them in the order requested. */
export interface TrustSummaryRow {
  playerId: string;
  score: number;
  band: string;
  bandLabel: string;
  policyVersion: number;
  topEvidenceSignals: string[];
}

export interface TrustApi {
  player(s: Session, playerId: string): Promise<TrustClub>;
  summaries(s: Session, playerIds: string[]): Promise<{ items: TrustSummaryRow[]; note: string }>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

export const httpTrust: TrustApi = {
  player: async (s, playerId) => (await req<{ playerId: string; trust: TrustClub }>(`/org/players/${playerId}/trust-profile`, { headers: H(s) })).trust,
  summaries: (s, playerIds) => req(`/org/trust-summaries?playerIds=${encodeURIComponent(playerIds.join(','))}`, { headers: H(s) }),
};

export const trust: TrustApi = DEMO_MODE ? demoTrust : httpTrust;
