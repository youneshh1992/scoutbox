// M23 P5.6C — the party's side of a multiple-representation consent.
//
// An agent who would act for more than one party in the same transaction needs
// each party's prior written consent. This is the player's copy of that ask:
// who is asking, for which transaction, which other party is involved, and the
// plain fact that they may decline. What the server withholds — the fee, the
// other side's private data, the agent's licence number, another party's
// answer — has no field here to arrive in.
import { m12Request as req } from './httpClient';
import { m25mock } from './m25mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export type ConsentStatus = 'requested' | 'granted' | 'declined' | 'revoked';
export type ConsentAction = 'grant' | 'decline' | 'revoke';

export interface ConsentAgent {
  userId: string | null;
  displayName: string | null;
  agency: string | null;
  /** The licence STATE in ScoutBox, never a number. */
  licence: string;
}
export interface ConsentContext {
  id: string;
  type: string;
  jurisdictions: string[];
  /** "You" for the reader's own row; a club by name; anything else is withheld. */
  parties: { partyRole: string; subjectKind: string; name: string | null }[];
}
export interface AgentConsentRequest {
  id: string;
  kind: string;
  status: ConsentStatus;
  partyRole: string;
  agent: ConsentAgent;
  context: ConsentContext | null;
  otherPartyRoles: string[];
  particulars: { fullParticularsProvided: boolean; legalAdviceOffered: boolean; proposedFeeDisclosed: boolean; acknowledged: unknown } | null;
  policyVersions: string[];
  ruleIds: string[];
  requestedAt: number;
  grantedAt: number | null;
  declinedAt: number | null;
  revokedAt: number | null;
  rev: number;
  honest: string;
}

export interface PlayerM25 {
  list(playerId: string): Promise<{ items: AgentConsentRequest[]; minor?: boolean; note?: string }>;
  answer(playerId: string, id: string, action: ConsentAction, input: { acknowledgedParticulars?: boolean; acknowledgedLegalAdvice?: boolean; expectedRev: number; clientKey: string }): Promise<AgentConsentRequest>;
}

const live: PlayerM25 = {
  list: (pid) => req('/player/agent/consents', pid),
  answer: async (pid, id, action, input) =>
    (await req<{ consent: AgentConsentRequest }>(`/player/agent/consents/${encodeURIComponent(id)}/${action}`, pid, { method: 'POST', body: JSON.stringify(input) })).consent,
};

export const m25: PlayerM25 = DEMO ? m25mock : live;

/** A fresh idempotency key for one intended answer. */
export const m25ClientKey = () => `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
