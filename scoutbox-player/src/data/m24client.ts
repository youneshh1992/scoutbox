// M23 P5.6B — the player's side of agent representation ("My Agent").
//
// Live implementation reads the server's /player/agent/* routes through the
// shared per-account bearer tokens; the demo mirror lives in m24mock.ts
// (same EXPO_PUBLIC_DEMO flag). What the server withholds — the agent's
// licence number, a colleague's record, a club's private case — has no
// field here to arrive in.
import { m12Request as req } from './httpClient';
import { m24mock } from './m24mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export type AgentRelationshipStatus = 'proposed' | 'active' | 'declined' | 'expired' | 'terminated_by_client' | 'terminated_by_agent' | 'disputed';

export interface AgentIdentity {
  userId: string | null;
  displayName: string | null;
  agency: { id: string; name: string } | null;
  /** Null for a legacy agency-level record: nobody's licence is claimed. */
  verification: { fifaLicence: string | null; jurisdictions: { memberAssociation: string; nationalRegistration: string }[] } | null;
  honest: string;
}

export interface AgentRelationship {
  id: string;
  status: AgentRelationshipStatus;
  pending: boolean;
  scope: string[];
  exclusive: boolean;
  jurisdiction: string | null;
  termMonths: number | null;
  startAt: number | null;
  endAt: number | null;
  proposedAt: number | null;
  confirmedAt: number | null;
  terminatedBy: 'agent' | 'client' | null;
  disputeReason: string | null;
  shareWithAgencyStaff: boolean;
  legacy: { fromRepresentationId: string } | null;
  rev: number;
  honest: string;
  agent: AgentIdentity;
}

export type AgentAction = 'confirm' | 'decline' | 'terminate' | 'dispute';

export interface PlayerM24 {
  list(playerId: string): Promise<{ items: AgentRelationship[]; minor?: boolean; note?: string }>;
  act(playerId: string, id: string, action: AgentAction, input: { expectedRev: number; reason?: string; clientKey: string }): Promise<AgentRelationship>;
  setSharing(playerId: string, id: string, share: boolean, expectedRev: number): Promise<AgentRelationship>;
}

const live: PlayerM24 = {
  list: (pid) => req('/player/agent/relationships', pid),
  act: async (pid, id, action, input) => (await req<{ relationship: AgentRelationship }>(`/player/agent/relationships/${encodeURIComponent(id)}/${action}`, pid, { method: 'POST', body: JSON.stringify(input) })).relationship,
  setSharing: async (pid, id, share, expectedRev) => (await req<{ relationship: AgentRelationship }>(`/player/agent/relationships/${encodeURIComponent(id)}/sharing`, pid, { method: 'PATCH', body: JSON.stringify({ shareWithAgencyStaff: share, expectedRev }) })).relationship,
};

export const m24: PlayerM24 = DEMO ? m24mock : live;

/** A fresh idempotency key for one intended action. */
export const m24ClientKey = () => `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
