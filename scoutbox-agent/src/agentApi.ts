// ScoutBox Agent — the Agent domain client (M23 P5.6B).
//
// Every method maps to one server route under /org/agent/*. The types below
// are the server's projections, copied faithfully: what the server withholds
// (a client's private data before confirmation, a colleague's relationship, a
// dispute reason) has no field here to arrive in.
import { DEMO_MODE, headers, request, type Session } from './api';
import { demoAgent } from './agentDemo';

export const VERIFICATION_STATES = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export const FACETS = ['fifa_licence', 'national_registration', 'minors_authorisation'] as const;
export type Facet = (typeof FACETS)[number];
export const TIERS = ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'] as const;
export type Tier = (typeof TIERS)[number];
export const SCOPES = ['employment', 'transfer', 'commercial', 'other_services'] as const;
export type Scope = (typeof SCOPES)[number];
export const JURISDICTIONS = ['INT', 'ENG', 'USA'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];
export type AgreementStatus = 'proposed' | 'active' | 'declined' | 'expired' | 'terminated_by_client' | 'terminated_by_agent' | 'disputed';

export interface FacetView {
  state: VerificationState;
  storedState: string;
  reference: string | null;
  memberAssociation: string | null;
  provenance: { provider: string; kind: string; at: number } | null;
  submittedAt: number | null;
  verifiedAt: number | null;
  recheckAt: number | null;
  note: string | null;
}

export interface Profile {
  id: string;
  userId: string;
  agencyOrgId: string;
  displayName: string;
  declared: { fifaLicenceNumber: string | null; jurisdictions: string[] };
  facets: { fifa_licence: FacetView | null; national_registration: Record<string, FacetView>; minors_authorisation: Record<string, FacetView> };
  regulatoryState: {
    fifaLicence: VerificationState;
    jurisdictions: { memberAssociation: string; nationalRegistration: VerificationState; minorsAuthorisation: VerificationState; regulatedActionsPermitted: boolean }[];
  };
  policyVersion: number;
  createdAt: number;
  updatedAt: number;
  rev: number;
  revAt: number | null;
  history: { id: string; at: number; action: string; detail: Record<string, unknown> | null }[];
  honest: string;
}

export interface Me {
  user: { id: string; name: string; role: string };
  org: { id: string; name: string; type: string; verified?: boolean; plan?: string };
  affiliation: { id: string; tiers: Tier[]; startedAt: number; rev: number };
  capabilities: string[];
  profile: Profile | null;
  platform: { testVerificationProvider: boolean };
  policyVersion: number;
}

export interface HomeAlert { kind: 'expiring' | 'disputed' | 'verification' | 'jurisdiction'; agreementId?: string; endAt?: number; facet?: string; state?: string; memberAssociation?: string }
export interface Home {
  profileState: VerificationState;
  hasProfile: boolean;
  tiers: Tier[];
  counts: { active: number; pending: number; expiringSoon: number; disputed: number; expired: number };
  alerts: HomeAlert[];
  unreadNotifications: number;
  regulatoryNotice: string;
}

export interface ClientIdentity {
  id: string;
  name: string | null;
  position?: string | null;
  age?: number | null;
  club?: string | null;
  country?: string | null;
  accessBasis?: 'active_confirmed_relationship' | 'pending_request' | 'none';
  removed?: boolean;
  unavailable?: boolean;
  [k: string]: unknown;
}

export interface HistoryRow { id: string; at: number; action: string; byKind: string | null; byName: string | null; detail: Record<string, unknown> | null }

export interface Relationship {
  id: string;
  agentUserId: string | null;
  agencyOrgId: string;
  clientKind: 'player';
  clientId: string;
  status: AgreementStatus;
  storedStatus: string;
  scope: Scope[];
  exclusive: boolean;
  jurisdiction: string | null;
  termMonths: number | null;
  startAt: number | null;
  endAt: number | null;
  proposedAt: number | null;
  confirmedAt: number | null;
  declinedAt: number | null;
  terminatedAt: number | null;
  terminatedBy: 'agent' | 'client' | null;
  terminationReasonCode: string | null;
  disputedAt: number | null;
  shareWithAgencyStaff: boolean;
  documents: { id: string; label: string | null; addedAt: number | null }[];
  legacy: { fromRepresentationId: string; regulatoryStatus: string; representativeName: string | null } | null;
  subjectRemovedAt: number | null;
  policyVersion: number;
  rev: number;
  revAt: number | null;
  history: HistoryRow[];
  honest: string;
  /** Present on list rows and detail: what the agent may see of the client. */
  client?: ClientIdentity;
  mode?: 'own' | 'summary';
}

/** What a same-agency colleague sees when the client allows it. */
export interface RelationshipSummary {
  id: string;
  agentUserId: string | null;
  clientId: string;
  status: AgreementStatus;
  startAt: number | null;
  endAt: number | null;
  summaryOnly: true;
  client: { id: string; name: string | null };
  legacy: Relationship['legacy'];
  mode?: 'summary';
}

export type ClientRow = (Relationship & { mode: 'own' }) | (RelationshipSummary & { mode?: 'summary' });
export const isSummary = (r: ClientRow): r is RelationshipSummary & { mode?: 'summary' } => (r as RelationshipSummary).summaryOnly === true;

export interface ClientDetail {
  relationship: Relationship | RelationshipSummary;
  client?: ClientIdentity;
  access?: boolean;
  mode: 'own' | 'summary';
}

export interface Opportunity {
  id: string;
  via: string;
  type: string;
  orgId: string;
  orgName: string;
  title: string;
  deadline: string;
  schedule?: unknown;
  category?: string | null;
  distance?: string | number | null;
  applied?: boolean | null;
  clientId?: string;
  clientName?: string;
  agreementId?: string;
}

export interface Member {
  affiliationId: string;
  userId: string;
  name: string | null;
  role: string | null;
  tiers: Tier[];
  active: boolean;
  startedAt: number;
  endedAt: number | null;
  endedReason: string | null;
  licensed: boolean;
  fifaLicence: VerificationState | null;
  rev: number;
  revAt: number | null;
}

export interface AgencyOverview {
  org: { id: string; name: string; type: string; verified?: boolean; plan?: string };
  settings: { jurisdictions: string[]; description: string };
  members: { active: number; admins: number; licensedAgents: number };
  relationships: { active: number; pending: number; legacy: number };
  tiers: Tier[];
  permissions: Record<string, string[]>;
  honest: string;
}

export interface ComplianceRow { userId: string; name: string | null; hasProfile: boolean; fifaLicence: VerificationState; jurisdictions: Profile['regulatoryState']['jurisdictions'] }
export interface AuditRow { id: string; at: number; action: string; domain: string; actor: { userId: string | null; name: string | null } | null; target: Record<string, unknown>; detail: Record<string, unknown> | null }
export interface PlayerHit { id: string; name: string; position: string | null; age: number | null; club: string | null; country: string | null }

export interface RequestInput { playerId: string; scope: Scope[]; termMonths: number; jurisdiction: Jurisdiction; exclusive: boolean; clientKey: string }

export interface AgentApi {
  me(s: Session): Promise<Me>;
  home(s: Session): Promise<Home>;
  getProfile(s: Session): Promise<{ profile: Profile | null; states: string[]; facets: string[]; jurisdictions: string[] }>;
  saveProfile(s: Session, input: { displayName?: string; fifaLicenceNumber?: string; jurisdictions?: string[]; expectedRev?: number }): Promise<{ profile: Profile }>;
  submitFacet(s: Session, facet: Facet, input: { reference: string; memberAssociation?: string }): Promise<{ profile: Profile; facet: FacetView; provider: string }>;
  agency(s: Session): Promise<AgencyOverview>;
  team(s: Session): Promise<{ members: Member[]; tiers: Tier[] }>;
  addMember(s: Session, input: { name: string; role?: string; tiers: Tier[]; clientKey: string }): Promise<{ member: Member; idempotent?: boolean }>;
  setTiers(s: Session, userId: string, tiers: Tier[], expectedRev: number): Promise<{ member: Member }>;
  endMember(s: Session, userId: string, expectedRev: number, reason?: string): Promise<{ member: Member }>;
  saveSettings(s: Session, input: { jurisdictions?: string[]; description?: string }): Promise<{ settings: AgencyOverview['settings'] }>;
  compliance(s: Session): Promise<{ agents: ComplianceRow[]; informational: boolean; honest: string }>;
  audit(s: Session, cursor?: string | null): Promise<{ items: AuditRow[]; nextCursor: string | null; total: number }>;
  lookup(s: Session, q: string): Promise<{ items: PlayerHit[]; adultsOnly?: boolean; note?: string }>;
  clients(s: Session): Promise<{ items: ClientRow[]; scopes: Scope[]; maxTermMonths: number; jurisdictions: string[] }>;
  requestClient(s: Session, input: RequestInput): Promise<{ relationship: Relationship; idempotent?: boolean }>;
  client(s: Session, id: string): Promise<ClientDetail>;
  terminate(s: Session, id: string, input: { reasonCode?: string; clientKey: string; expectedRev: number }): Promise<{ relationship: Relationship; idempotent?: boolean }>;
  clientOpportunities(s: Session, id: string): Promise<{ items: Opportunity[]; clientId: string; note: string }>;
  opportunities(s: Session): Promise<{ items: Opportunity[]; note: string }>;
  inbox(s: Session): Promise<{ notifications: import('./api').Notification[]; pending: Relationship[]; note: string }>;
}

const post = <T,>(s: Session, path: string, body: unknown, method = 'POST') => request<T>(path, { method, headers: headers(s), body: JSON.stringify(body) });
const get = <T,>(s: Session, path: string) => request<T>(path, { headers: headers(s) });

export const httpAgent: AgentApi = {
  me: (s) => get(s, '/org/agent/me'),
  home: (s) => get(s, '/org/agent/home'),
  getProfile: (s) => get(s, '/org/agent/profile'),
  saveProfile: (s, input) => post(s, '/org/agent/profile', input),
  submitFacet: (s, facet, input) => post(s, `/org/agent/profile/facets/${facet}/submit`, input),
  agency: (s) => get(s, '/org/agent/agency'),
  team: (s) => get(s, '/org/agent/agency/team'),
  addMember: (s, input) => post(s, '/org/agent/agency/team', input),
  setTiers: (s, userId, tiers, expectedRev) => post(s, `/org/agent/agency/team/${encodeURIComponent(userId)}`, { tiers, expectedRev }, 'PATCH'),
  endMember: (s, userId, expectedRev, reason) => post(s, `/org/agent/agency/team/${encodeURIComponent(userId)}/end`, { expectedRev, reason }),
  saveSettings: (s, input) => post(s, '/org/agent/agency/settings', input, 'PATCH'),
  compliance: (s) => get(s, '/org/agent/agency/compliance'),
  audit: (s, cursor) => get(s, `/org/agent/agency/audit?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  lookup: (s, q) => get(s, `/org/agent/players?q=${encodeURIComponent(q)}`),
  clients: (s) => get(s, '/org/agent/clients'),
  requestClient: (s, input) => post(s, '/org/agent/clients/request', input),
  client: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}`),
  terminate: (s, id, input) => post(s, `/org/agent/clients/${encodeURIComponent(id)}/terminate`, input),
  clientOpportunities: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}/opportunities`),
  opportunities: (s) => get(s, '/org/agent/opportunities'),
  inbox: (s) => get(s, '/org/agent/inbox'),
};

export const agent: AgentApi = DEMO_MODE ? demoAgent : httpAgent;

/** A fresh idempotency key for one intended action. */
export const clientKey = () => `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
