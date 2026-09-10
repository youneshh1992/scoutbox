// M16.1 typed client (org side): the At-Home Combine panel. A verified,
// non-agency org requests standardized Combine tests from players it can
// already see (no new access is granted), and reads their Combine Verified
// RESULTS — never raw home footage, DOB, notes or integrity internals. The
// server re-runs every standing gate on each call.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoCombine } from './combineDemo';

// The standardized Combine protocol library a club can request. Protocols are
// fixed and versioned server-side; a club selects from them but never alters
// their rules. Only Box Control 60 is Combine Verified on production web
// capture today — the others report "not yet supported on this device" until a
// detector ships, which is stated to the player, never estimated.
export interface StandardProtocol { id: string; title: string; category: string; metricUnit: string; productionSupported: boolean }
export const STANDARD_PROTOCOLS: StandardProtocol[] = [
  { id: 'combine-box-control-60', title: 'Box Control 60', category: 'close_control', metricUnit: 'seconds', productionSupported: true },
  { id: 'combine-box-touch-60', title: 'Box Touch 60', category: 'ball_mastery', metricUnit: 'touches', productionSupported: false },
  { id: 'combine-box-juggle', title: 'Box Juggle', category: 'ball_mastery', metricUnit: 'juggles', productionSupported: false },
  { id: 'combine-box-footwork', title: 'Box Footwork', category: 'footwork', metricUnit: 'intervals', productionSupported: false },
  { id: 'combine-box-strength-60', title: 'Box Strength 60', category: 'strength', metricUnit: 'reps', productionSupported: false },
];

export interface CombineResult { protocolId: string; protocolVersion: number; protocolTitle: string; metricUnit: string; measuredValue: number; display: string; combineVerified: boolean; capturedBy: string; completedAt: number }
export interface PlayerCombine { playerId: string; playerName?: string; shared: boolean; results: CombineResult[]; hasCombineVerifiedResults?: boolean; note: string }
export interface CombineRequestRow {
  id: string; orgId: string; orgName: string; title: string | null;
  requestedBy: { userId: string; name: string; role: string | null; at: number } | null;
  playerId: string;
  protocols: { protocolId: string; protocolTitle: string; completed: boolean }[];
  deadline: string | null; instructions: string | null;
  state: 'requested' | 'completed' | 'cancelled'; createdAt: number;
  completedCount: number; requiredCount: number; note: string | null;
}
export interface CompareCell { value: number; display: string; verified: boolean; at: number }
export interface CompareMatrix {
  protocols: { id: string; version: number; title: string; metricUnit: string; direction: string }[];
  rows: { playerId: string; playerName: string; cells: (CompareCell | null)[] }[];
  note: string;
}

export interface CombineApi {
  standardProtocols(): StandardProtocol[];
  createRequest(s: Session, input: { title?: string; protocolIds: string[]; playerId?: string; playerIds?: string[]; deadline?: string; instructions?: string }): Promise<{ requests: CombineRequestRow[]; skipped: { playerId: string; reason: string }[] }>;
  requests(s: Session, playerId?: string): Promise<CombineRequestRow[]>;
  cancelRequest(s: Session, id: string): Promise<{ request: CombineRequestRow }>;
  player(s: Session, playerId: string): Promise<PlayerCombine>;
  compare(s: Session, playerIds: string[], protocols?: string[]): Promise<CompareMatrix>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

export const httpCombine: CombineApi = {
  standardProtocols: () => STANDARD_PROTOCOLS,
  createRequest: (s, input) => req('/org/combine/requests', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  requests: async (s, playerId) => (await req<{ items: CombineRequestRow[] }>(`/org/combine/requests${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ''}`, { headers: H(s) })).items,
  cancelRequest: (s, id) => req(`/org/combine/requests/${id}/cancel`, { method: 'POST', headers: H(s), body: '{}' }),
  player: (s, playerId) => req(`/org/combine/players/${playerId}`, { headers: H(s) }),
  compare: (s, playerIds, protocols) => req(`/org/combine/compare?playerIds=${encodeURIComponent(playerIds.join(','))}${protocols && protocols.length ? `&protocols=${encodeURIComponent(protocols.join(','))}` : ''}`, { headers: H(s) }),
};

export const combine: CombineApi = DEMO_MODE ? demoCombine : httpCombine;
