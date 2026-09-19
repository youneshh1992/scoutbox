// M23 P5.6D — the individual's side of a transaction workspace.
//
// A transaction is a permissioned multi-party record: the player sees the
// transactions they are actually party to, who represents whom, what the
// compliance layer currently says, the documents shared with them, and the
// timeline of what happened in their view of it. What the server withholds —
// a club's private note, a club-private document, the agent's agreement
// reference, the other side's papers, any fee — has no field here to arrive in.
//
// The only thing the player DOES here is confirm their own participation, and
// the card says plainly that confirming agrees to nothing.
import { m12Request as req } from './httpClient';
import { m26mock } from './m26mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface TxParty {
  id: string;
  partyRole: string;
  subjectKind: string;
  subjectId: string;
  name: string | null;
  removed: boolean;
  confirmedAt: number | null;
  confirmedByKind: string | null;
}
export interface TxRepresentation { id: string; partyRole: string; status: string; basis: string; scope: string[] }
export interface TxCompliance {
  outcome: string | null;
  pendingReason: string | null;
  blocked: boolean;
  clear: boolean;
  reasonCodes: string[];
  evaluatedAt: number | null;
  staleness: string | null;
  honest: string;
}
export interface TxConsent { id: string | null; kind: string; partyRole: string | null; status: string; mine: boolean; requestedAt: number | null; grantedAt: number | null; revokedAt: number | null }
export interface TxDocument { id: string; documentType: string; visibility: string; version: number; label: string; uploadedAt: number; actor: { kind: string; label: string } | null; downloadable: boolean }
export interface TxTimelineEntry { id: string; at: number; action: string; audience: string; actor: { kind: string; label: string } | null; detail: Record<string, unknown> | null }

export interface PlayerTransaction {
  id: string;
  type: string;
  status: string;
  jurisdictions: string[];
  viewerRoles: string[];
  agency: { id: string; name: string | null } | null;
  parties: TxParty[];
  awaitingConfirmation: string[];
  partiesConfirmed: boolean;
  representations: TxRepresentation[];
  compliance: TxCompliance;
  consents: TxConsent[];
  documents: TxDocument[];
  notes: { id: string; visibility: string; text: string; at: number }[];
  offerBoundary: { canStartOfferWorkflow: boolean; blockers: string[]; honest: string };
  updatedAt: number;
  rev: number;
  honest: string;
}

export interface PlayerM26 {
  list(playerId: string): Promise<{ items: PlayerTransaction[]; minor?: boolean; note?: string }>;
  confirm(playerId: string, id: string, input: { expectedRev: number }): Promise<PlayerTransaction>;
  timeline(playerId: string, id: string): Promise<{ items: TxTimelineEntry[]; note: string }>;
}

const live: PlayerM26 = {
  list: (pid) => req('/player/transactions', pid),
  confirm: async (pid, id, input) =>
    (await req<{ transaction: PlayerTransaction }>(`/player/transactions/${encodeURIComponent(id)}/confirm`, pid, { method: 'POST', body: JSON.stringify(input) })).transaction,
  timeline: (pid, id) => req(`/player/transactions/${encodeURIComponent(id)}/timeline`, pid),
};

export const m26: PlayerM26 = DEMO ? m26mock : live;
