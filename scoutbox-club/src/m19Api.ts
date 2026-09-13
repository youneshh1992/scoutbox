// M19 typed client (org side): Explainable Matching and Dynamic Watchlists.
//
// What these systems ARE: the club writes criteria; ScoutBox says which
// visible players satisfy them and shows, criterion by criterion, why.
// A Dynamic Watchlist saves those criteria and keeps the answer current.
//
// What they are NOT, and what nothing in this module may ever become:
//   • A score. There is no match score, no percentage fit, no rank, no tier
//     and no "best match". Preferred criteria are COUNTED ("2 of 3 met") and
//     that count is never normalised, ordered against another player, or
//     turned into a figure. If you find yourself dividing it, stop.
//   • A recommendation. ScoutBox never says a player should be signed,
//     trialled or looked at first. The club's own criteria are the only
//     opinion in the payload.
//   • Player-facing. There is no player, guardian or public route in M19.
//     A player is never told a club is watching them, which criteria matched,
//     or that they entered or left a list.
//   • A way around a gate. Every standing rule (visibility, blocks,
//     verification, the agency wall, minors, the grassroots radius) has
//     already run server-side BEFORE matching. The client cannot widen the
//     candidate set by asking differently.
//
// The server is the only authority: this module sends criteria and reads
// results. It never computes a match, a reason or a count of its own.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM19 } from './m19Demo';

export const CRITERION_CLASSES = ['required', 'preferred'] as const;
export type CriterionClass = (typeof CRITERION_CLASSES)[number];

export const WATCHLIST_MODES = ['live_linked', 'snapshot'] as const;
export type WatchlistMode = (typeof WATCHLIST_MODES)[number];
export const WATCHLIST_STATUSES = ['active', 'paused', 'archived'] as const;
export type WatchlistStatus = (typeof WATCHLIST_STATUSES)[number];

/** A criterion as the editor holds it. The server validates and normalises;
 *  this shape is deliberately permissive so a half-built row can exist. */
export interface CriterionInput {
  type: string;
  operator: string;
  value?: string | number | null;
  values?: (string | number)[];
  protocol?: string;
  primaryOnly?: boolean;
  evidenceKind?: string;
}
export interface CriteriaInput {
  required: CriterionInput[];
  preferred: CriterionInput[];
}

export interface MatchReason {
  criterionId: string;
  met: boolean;
  text: string;
}

export interface MatchCard {
  playerId: string;
  name: string;
  position: string | null;
  secondaryPositions: string[];
  age: number | null;
  trustBand: string | null;
  trustNote: string;
  distanceKm: number | null;
  required: MatchReason[];
  preferred: MatchReason[];
  /** A count of the club's own preferred criteria. Never a score. */
  preferredMet: number;
  preferredTotal: number;
  policyVersion: number;
  note: string;
}

export interface MatchResult {
  items: MatchCard[];
  total: number;
  offset: number;
  limit: number;
  sort: string;
  ordering: string;
  criteria: { required: string[]; preferred: string[] };
  criteriaVersion: string;
  policyVersion: number;
  briefId: string | null;
  evaluatedAt: number;
  truncated: boolean;
  note: string;
  scoreNote: string;
}

export interface CriterionTypeDef { type: string; label: string; operators: string[] }
export interface MatchVocabulary {
  criterionTypes: CriterionTypeDef[];
  operators: { id: string; arity: string; note: string }[];
  sorts: string[];
  defaultSort: string;
  limits: Record<string, number>;
  policyVersion: number;
  schemaVersion: number;
  combineProtocols: string[];
  /** Suggestions for the availability criterion, not a whitelist. */
  availabilityValues?: string[];
  note: string;
}

export interface Watchlist {
  id: string;
  name: string;
  mode: WatchlistMode;
  status: WatchlistStatus;
  sourceType: string;
  sourceId: string | null;
  criteria: { required: string[]; preferred: string[] };
  criteriaVersion: string;
  policyVersion: number;
  notify: boolean;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  lastReconciledAt: number | null;
  rev: number;
  revAt?: number | null;
  revBy?: string | null;
  blocked?: { blocked?: boolean; paused?: boolean; code?: string; message?: string };
}

export interface WatchlistDetail {
  watchlist: Watchlist;
  items: MatchCard[];
  total: number;
  offset: number;
  limit: number;
  sort: string;
  summary: {
    newlyMatched: number;
    noLongerMatches: number;
    unchanged: number;
    current: number;
    note: string;
  };
  evaluatedAt: number | null;
  refreshNote: string;
}

export interface WatchlistHistoryEntry {
  id: string;
  at: number;
  transition: 'entered' | 'left';
  reason: string;
  text: string;
  criterionId: string | null;
  criteriaVersion: string;
  briefVersion: number | null;
  playerId: string | null;
  playerName: string | null;
}

export interface WatchlistHistoryResult {
  items: WatchlistHistoryEntry[];
  nextCursor: string | null;
  total: number;
  note: string;
}

/** A criteria refusal is an ANSWER, not a crash: the editor re-renders with
 *  the offending row named, in the server's own words. */
export type CriteriaSaveOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'CRITERIA_INVALID'; details: { index: number; class: string; type: string | null; error: string }[]; message: string }
  | { ok: false; error: 'CRITERION_PROHIBITED'; prohibited: string[]; message: string };

export interface M19Api {
  vocabulary(s: Session): Promise<MatchVocabulary>;
  match(s: Session, input: { criteria?: CriteriaInput; briefId?: string; sort?: string; limit?: number; offset?: number }): Promise<CriteriaSaveOutcome<MatchResult>>;
  watchlists(s: Session, status?: string): Promise<{ items: Watchlist[]; total: number; note: string }>;
  createWatchlist(s: Session, input: { name: string; mode: WatchlistMode; criteria?: CriteriaInput; briefId?: string; sourceType?: string; notify?: boolean }): Promise<CriteriaSaveOutcome<Watchlist>>;
  watchlist(s: Session, id: string, params?: { sort?: string; limit?: number; offset?: number }): Promise<WatchlistDetail>;
  patchWatchlist(s: Session, id: string, input: Record<string, unknown> & { expectedRev: number }): Promise<CriteriaSaveOutcome<Watchlist>>;
  history(s: Session, id: string, params?: { cursor?: string; limit?: number }): Promise<WatchlistHistoryResult>;
  addToRoom(s: Session, id: string, playerId: string): Promise<{ roomId: string; existed: boolean; note: string }>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  const s = out.toString();
  return s ? `?${s}` : '';
};

/** Shared refusal handling for every call that carries criteria. */
async function withCriteria<T>(path: string, init: RequestInit, pick: (b: Record<string, unknown>) => T): Promise<CriteriaSaveOutcome<T>> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body?.error === 'CRITERION_PROHIBITED') {
    return { ok: false, error: 'CRITERION_PROHIBITED', prohibited: (body.prohibited ?? []) as string[], message: String(body.message ?? '') };
  }
  if (res.status === 400 && (body?.error === 'CRITERIA_INVALID' || body?.error === 'CRITERIA_TOO_MANY' || body?.error === 'CRITERIA_REQUIRED_EMPTY')) {
    return { ok: false, error: 'CRITERIA_INVALID', details: (body.details ?? []) as { index: number; class: string; type: string | null; error: string }[], message: String(body.message ?? '') };
  }
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return { ok: true, value: pick(body as Record<string, unknown>) };
}

export const httpM19: M19Api = {
  vocabulary: (s) => req('/org/matching/vocabulary', { headers: H(s) }),
  match: (s, input) => withCriteria('/org/matching', { method: 'POST', headers: H(s), body: JSON.stringify(input) }, (b) => b as unknown as MatchResult),
  watchlists: (s, status) => req(`/org/watchlists${qs({ status })}`, { headers: H(s) }),
  createWatchlist: (s, input) => withCriteria('/org/watchlists', { method: 'POST', headers: H(s), body: JSON.stringify(input) }, (b) => (b as { watchlist: Watchlist }).watchlist),
  watchlist: (s, id, params = {}) => req(`/org/watchlists/${id}${qs({ ...params })}`, { headers: H(s) }),
  patchWatchlist: (s, id, input) => withCriteria(`/org/watchlists/${id}`, { method: 'PATCH', headers: H(s), body: JSON.stringify(input) }, (b) => (b as { watchlist: Watchlist }).watchlist),
  history: (s, id, params = {}) => req(`/org/watchlists/${id}/history${qs({ ...params })}`, { headers: H(s) }),
  addToRoom: (s, id, playerId) => req(`/org/watchlists/${id}/room`, { method: 'POST', headers: H(s), body: JSON.stringify({ playerId }) }),
};

export const m19: M19Api = DEMO_MODE ? demoM19 : httpM19;

/** Serialise criteria into a URL fragment so a search survives refresh, back,
 *  forward and a shared internal link. Malformed input is REFUSED by the
 *  server, so this only has to be reversible, not trusted. */
export function encodeCriteria(c: CriteriaInput): string {
  try { return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(c))))); } catch { return ''; }
}
export function decodeCriteria(s: string): CriteriaInput | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(s))))) as CriteriaInput;
    if (!parsed || !Array.isArray(parsed.required) || !Array.isArray(parsed.preferred)) return null;
    return parsed;
  } catch { return null; }
}
