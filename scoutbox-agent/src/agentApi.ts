// ScoutBox Agent — the Agent domain client (M23 P5.6B).
//
// Every method maps to one server route under /org/agent/*. The types below
// are the server's projections, copied faithfully: what the server withholds
// (a client's private data before confirmation, a colleague's relationship, a
// dispute reason) has no field here to arrive in.
import { DEMO_MODE, headers, request, type Session } from './api';
import { demoAgent, DEMO_IDENTITIES } from './agentDemo';

export const VERIFICATION_STATES = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export const FACETS = ['fifa_licence', 'national_registration', 'domestic_authorisation', 'minors_authorisation'] as const;
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
  facets: { fifa_licence: FacetView | null; national_registration: Record<string, FacetView>; domestic_authorisation: Record<string, FacetView>; minors_authorisation: Record<string, FacetView> };
  regulatoryState: {
    fifaLicence: VerificationState;
    jurisdictions: { memberAssociation: string; nationalRegistration: VerificationState; domesticAuthorisation: VerificationState; minorsAuthorisation: VerificationState; regulatedActionsPermitted: boolean }[];
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

// ============================================ M23 P5.6E cross-app integration

/** A club contact that was routed to this agent as well as to the client (§24). */
export interface RoutedContact {
  id: string;
  club: { id: string; name: string | null };
  status: string;
  channel: string;
  subject: string | null;
  body: string | null;
  routedAt: number;
  routedMode: string;
  deliveredAt: number | null;
  respondedAt: number | null;
  responseKind: string | null;
}

/** A client's trial as an authorised agent may see it (§26–§29). */
// M23 P6 — a client's Offer, read-only, only when the client shared it. Terms
// and state; never the club's note, never documents, never an accept control.
export interface ClientOfferRevision {
  id: string; revisionNumber: number; status: string; storedStatus: string; statusLabel: string | null;
  terms: { offerType: string; role: string | null; squad: string | null; startDate: string | null; endDate: string | null; conditions: string | null };
  recipientMessage: string | null; documents: never[]; expiresAt: number | null; issuedAt: number | null; createdAt: number | null;
  supersedesRevisionId: string | null; supersededByRevisionId: string | null; withdrawnAt: number | null; respondedAt: number | null; rev: number;
}
export interface ClientOffer {
  id: string; clientId: string; club: { id: string; name: string | null }; type: string; status: string | null; statusLabel: string | null;
  currentRevision: ClientOfferRevision | null; revisions: ClientOfferRevision[]; awaitingClientResponse: boolean;
  responses: { id: string; revisionId: string; responseType: 'accepted' | 'declined'; actorType: 'player' | 'guardian'; occurredAt: number }[];
  sharedAt: number | null; honest: string;
}
export interface ClientTrial {
  id: string;
  club: { id: string; name: string | null };
  workflowState: string;
  workflowLabel: string;
  legacy: boolean;
  acceptedAt: number | null;
  schedule: {
    legacy?: boolean; timezone: string | null; revision: number; confirmedAt: number | null;
    date?: string;
    sessions: { id: string; kind: string; startsAt: number; endsAt: number; venue: { name: string; town: string | null } | null; attendance: { state: string } }[];
  } | null;
  awaitingClientConfirmation: boolean;
  completion: { state: string; at: number } | null;
  reportObligation: 'outstanding' | 'filed' | null;
}

/** An opportunity this agent put in front of this client (§18). */
export interface OpportunityShare {
  id: string;
  opportunityId: string;
  via: string | null;
  title: string | null;
  orgName: string | null;
  deadline: string | null;
  note: string | null;
  sharedAt: number;
  sharedByName: string | null;
  withdrawnAt: number | null;
  rev: number;
  honest: string;
}

/** A club's invitation to open a transaction workspace (§32/§39). */
export interface TransactionHandoff {
  handoffId: string;
  recruitmentCaseId: string;
  clientId: string;
  agreementId: string;
  club: { id: string; name: string | null };
  invitedAt: number;
  expiresAt: number;
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


// ------------------------------------------------------------ M23 P5.6C — compliance
// The server's projections, copied faithfully. A reason carries a code, a
// rule id, that rule's OPERATIVE status and the policy version it came from —
// never prose, never a reviewer's note, never another agent's id.
export const CONFLICT_OUTCOMES = ['CLEAR', 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', 'PROHIBITED_CONFLICT', 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'INSUFFICIENT_DATA'] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];
export const CONTEXT_TYPES = ['employment_contract', 'transfer', 'loan', 'other_services'] as const;
export type ContextType = (typeof CONTEXT_TYPES)[number];
export const PARTY_ROLES = ['individual', 'engaging_entity', 'releasing_entity'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export type RuleStatus = 'ACTIVE' | 'SUSPENDED' | 'PARTIALLY_SUSPENDED' | 'JURISDICTION_OVERRIDE' | 'PENDING_IMPLEMENTATION' | 'UNDER_LEGAL_REVIEW' | 'UNKNOWN';

export interface Reason { code: string; ruleId: string | null; ruleStatus: RuleStatus | null; regulator?: string | null; jurisdiction?: string | null; policyVersion: string | null; partyRoles?: string[]; partyRole?: string | null; overrideRuleId?: string | null }
export interface ConsentOutstanding { partyRole: PartyRole; consentKind: string; reasonCode: string }
export interface Clearance {
  outcome: ConflictOutcome;
  alias: string | null;
  reasons: Reason[];
  consentsOutstanding: ConsentOutstanding[];
  requiredActions: { action: string; partyRoles?: string[]; reasonCodes?: string[] }[];
  policyVersions: string[];
  evaluatedAt: number;
  inputHash: string;
  /** False after a policy publication until the agent re-evaluates (never silently re-verdicted). */
  current: boolean;
}
export interface ContextParty { id: string; partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string; name: string | null; removed: boolean }
export interface ContextRepresentation { id: string; agentUserId: string; partyRole: PartyRole; agreementId: string | null; status: 'verified' | 'pending_review' | 'withdrawn' | string; declaredOnly: boolean; reviewId: string | null; firstActAt: number | null }
export interface ComplianceContext {
  id: string;
  type: ContextType;
  status: 'open' | 'closed';
  jurisdictions: string[];
  scope: 'national' | 'international' | 'unknown';
  parties: ContextParty[];
  representations: ContextRepresentation[];
  clearance: Clearance | null;
  reEvaluationPending: boolean;
  evaluationCount: number;
  openedAt: number;
  closedAt: number | null;
  rev: number;
  revAt: number | null;
  history: { id: string; at: number; action: string; byKind: string | null; detail: Record<string, unknown> | null }[];
  honest: string;
}
export interface AgentConsent {
  id: string; kind: string; status: 'requested' | 'granted' | 'declined' | 'revoked' | string; contextId: string | null; partyRole: PartyRole | null; subjectKind: 'player' | 'club' | null;
  requestedAt: number | null; grantedAt: number | null; declinedAt: number | null; revokedAt: number | null; policyVersions: string[]; ruleIds: string[];
  particulars: { fullParticularsProvided: boolean; legalAdviceOffered: boolean; proposedFeeDisclosed: boolean; acknowledged: unknown } | null; rev: number; revAt: number | null;
}
export interface ReviewPublic {
  id: string; kind: 'verification_facet' | 'representation_dispute' | 'representation_declared' | 'conflict_evaluation' | string;
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED' | string;
  agencyOrgId: string; agentUserId: string | null; subject: Record<string, unknown>; reasons: Reason[]; policyVersions: string[];
  requestedAt: number; startedAt: number | null; decidedAt: number | null;
  decision: { outcome: string; reasonCode: string; reviewer: { id: string; name: string; role: string }; evidenceCount: number } | null;
  startedBy: { id: string; name: string } | null; supersedes: string | null; supersededBy: string | null;
  snapshot: { outcome: string | null; evaluatedAt: number | null; policyVersions: string[] } | null; rev: number; revAt: number | null;
}
export interface FacetFreshness { facet: Facet; memberAssociation: string | null; state: VerificationState; storedState: string; recheckAt: number | null; daysUntilRecheck: number | null; provenance: { provider: string; kind?: string } | null; verifiedAt: number | null }
export interface ProviderStatus { provider: string; live: boolean; registers: Record<string, string>; note: string }
export interface PolicyInEffect { id: string; regulator: string; jurisdiction: string; effectiveFrom: string }
export interface MinorReadiness { memberAssociation: string; pathwayEnabledInProduction: boolean; timingRule: { ruleId: string; ruleStatus: RuleStatus; formula: string | null } | null; timingEncoded: boolean; agentReady: boolean; gaps: { facet: string; memberAssociation: string | null; state: string; code: string }[]; reasons: Reason[]; honest: string }
export interface ComplianceOverview {
  provider: ProviderStatus;
  facets: { fifa_licence: VerificationState; national_registration: Record<string, VerificationState>; domestic_authorisation: Record<string, VerificationState>; minors_authorisation: Record<string, VerificationState> } | null;
  freshness: FacetFreshness[];
  policies: { inEffect: PolicyInEffect[]; missing: string[] };
  reviews: ReviewPublic[];
  contexts: ComplianceContext[];
  consents: AgentConsent[];
  minorReadiness: MinorReadiness[];
  counts: { reviewsPending: number; contextsOpen: number; consentsOutstanding: number; staleFacets: number };
  honest: string;
}
export interface PolicyVersionPublic { id: string; regulator: string; jurisdiction: string; policyVersion: number; supersedes: string | null; effectiveFrom: string; effectiveTo: string | null; status: string; publishedAt: number | null; rules?: Record<string, { ruleStatus: RuleStatus; textStatus?: string; sourceRef?: string | null; note?: string | null }> }
export interface ClubHit { id: string; name: string; type: string; verified?: boolean }
export interface ContextCreateInput { type: ContextType; jurisdictions: string[]; parties: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string }[]; clientKey: string }
export interface ContextMutation { context: ComplianceContext; evaluation?: Clearance; representation?: { id: string; partyRole: PartyRole; status: string }; idempotent?: boolean }

// ------------------------------------------------------------ M23 P5.6D — transactions
// The multi-party transaction workspace, projected for ONE viewer by the
// server. What a party may not see has no field here to arrive in: the agent's
// agreement reference and the policy versions appear only in the agent's own
// projection, a counterparty's consent carries a state and no particulars, and
// a document the viewer's lane excludes is absent rather than redacted.
export const TRANSACTION_STATUSES = ['DRAFT', 'PARTIES_CONFIRMED', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED', 'READY', 'ACTIVE', 'ON_HOLD', 'CANCELLED', 'CLOSED', 'ARCHIVED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const TRANSACTION_TYPES = CONTEXT_TYPES;
export type TransactionType = ContextType;
export const DOCUMENT_TYPES = ['representation_agreement_reference', 'compliance_consent_reference', 'guardian_evidence', 'mandate', 'term_sheet_draft', 'employment_contract_draft', 'club_document', 'regulatory_evidence', 'correspondence_attachment'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_VISIBILITY = ['AGENT_PRIVATE', 'PLAYER_PRIVATE', 'ENGAGING_CLUB_PRIVATE', 'RELEASING_CLUB_PRIVATE', 'PLAYER_AGENT_SHARED', 'ENGAGING_AGENT_SHARED', 'RELEASING_AGENT_SHARED', 'ALL_TRANSACTION_PARTIES', 'T_AND_S_ONLY'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITY)[number];
export type RoomRole = 'representing_agent' | 'party_individual' | 'party_guardian' | 'party_club_signatory' | 'party_club_member' | 'agency_admin_observer' | 'trust_safety';

export interface TxParty {
  id: string; partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string;
  name: string | null; removed: boolean; removedAt: number | null;
  confirmedAt: number | null; confirmedByKind: string | null; addedAt: number; subjectRemovedAt: number | null;
}
export interface TxRepresentation {
  id: string; partyRole: PartyRole; agentUserId: string; status: string; declaredOnly: boolean;
  basis: 'client_confirmed_agreement' | 'declared'; scope: string[]; jurisdictions: string[];
  verifiedAt: number | null; withdrawnAt: number | null; createdAt: number;
  /** Agent-only: the relationship this binding rests on, and the review it raised. */
  agreementId?: string | null; reviewId?: string | null; firstActAt?: number | null;
}
export interface TxCompliance {
  outcome: string | null; pendingReason: string | null; blocked: boolean; clear: boolean;
  /** What the RECORDED evaluation said. `clear` is the current answer; these differ when the snapshot is stale. */
  snapshotClear?: boolean;
  reasonCodes: string[]; consentRequirements: { partyRole: PartyRole; consentKind: string; reasonCode: string }[];
  evaluatedAt: number | null; stale: string | null; staleness: string | null;
  evaluationId?: string; contextId?: string | null; policyVersions?: string[]; verificationFreshness?: string | null;
  honest: string;
}
export interface TxConsentView {
  id: string | null; kind: string; partyRole: PartyRole | null; status: string;
  requestedAt: number | null; grantedAt: number | null; declinedAt: number | null; revokedAt: number | null;
  mine: boolean; particulars?: unknown; policyVersions?: string[];
}
export interface TxDocument {
  id: string; documentType: DocumentType; visibility: DocumentVisibility; version: number; label: string;
  ownerKind: string | null; ownerPartyRole: PartyRole | null; uploadedAt: number; actor: { kind: string; label: string } | null;
  expiresAt: number | null; expired: boolean; signedAt: number | null; supersedes: string | null;
  evidence: { kind: string; present: boolean } | null; downloadable: boolean;
  rev: number; revAt: number | null; revBy: string | null;
}
export interface TxNote { id: string; visibility: DocumentVisibility; text: string; at: number; actor: { kind: string; label: string } | null }
export interface TxThread { id: string; channelId: string; linkedAt: number; actor: { kind: string; label: string } | null; readable: boolean }
export interface TxTermsVersion { id: string; at: number; summary: string; visibility: DocumentVisibility; recordedFor: PartyRole; actor: { kind: string; label: string } | null }
export interface TxTimelineEntry { id: string; at: number; action: string; audience: string; actor: { kind: string; label: string } | null; detail: Record<string, unknown> | null }
export interface OfferBoundary { canStartOfferWorkflow: boolean; blockers: string[]; honest: string }

export interface Transaction {
  id: string; type: TransactionType; status: TransactionStatus; jurisdictions: string[];
  playerId: string | null; engagingOrgId: string | null; releasingOrgId: string | null;
  viewerRoles: RoomRole[]; viewerPartyRole: PartyRole | null;
  agency: { id: string; name: string | null } | null;
  parties: TxParty[]; requiredPartyRoles: PartyRole[]; awaitingConfirmation: PartyRole[]; partiesConfirmed: boolean;
  representations: TxRepresentation[]; compliance: TxCompliance; consents: TxConsentView[];
  documents: TxDocument[]; notes: TxNote[]; linkedThreads: TxThread[];
  links: { trialId: string | null; opportunityId: string | null };
  terms: { versions: TxTermsVersion[] };
  offerBoundary: OfferBoundary;
  hold: { reasonCode: string | null; reason: string | null; at: number | null } | null;
  cancelReasonCode: string | null; closeReasonCode: string | null;
  allowedTransitions: TransactionStatus[];
  initiatedBy: string | null; initiatedAt: number; createdAt: number; updatedAt: number;
  rev: number; revAt: number | null; revBy: string | null;
  honest: string;
}
export interface TransactionList {
  items: Transaction[]; statuses: string[]; types: string[]; partyRoles: string[];
  documentTypes: string[]; visibilities: string[]; roomRoles: string[];
  holdReasonCodes: string[]; cancelReasonCodes: string[]; closeReasonCodes: string[];
  transitions: { from: string; byActor: string[]; byCompliance: string[] }[];
  pendingReasons: string[];
  counts: { live: number; blocked: number; pending: number; ready: number; awaitingConfirmation: number };
  honest: string;
}
export interface TransactionMutation { transaction: Transaction; representation?: { id: string; partyRole: PartyRole; status: string }; idempotent?: boolean }
export interface TransactionCreateInput {
  type: TransactionType; jurisdictions: string[];
  parties: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string }[];
  clientKey: string;
}

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
  // ---- M23 P5.6E cross-app integration
  clientContacts(s: Session, id: string): Promise<{ items: RoutedContact[]; clientId: string; note: string }>;
  clientTrials(s: Session, id: string): Promise<{ items: ClientTrial[]; clientId: string; clientName: string | null; note: string; honest: string }>;
  // M23 P6 — read-only projection of the Offers this client chose to share.
  clientOffers(s: Session, id: string): Promise<{ items: ClientOffer[]; clientId: string; clientName: string | null; note: string; honest: string }>;
  clientShares(s: Session, id: string): Promise<{ items: OpportunityShare[] }>;
  shareOpportunity(s: Session, id: string, oppId: string, input: { note?: string; clientKey: string }): Promise<{ share: OpportunityShare; idempotent?: boolean; note?: string }>;
  withdrawShare(s: Session, id: string, shareId: string): Promise<{ share: OpportunityShare; idempotent?: boolean }>;
  handoffs(s: Session): Promise<{ items: TransactionHandoff[]; note: string }>;
  opportunities(s: Session): Promise<{ items: Opportunity[]; note: string }>;
  inbox(s: Session): Promise<{ notifications: import('./api').Notification[]; pending: Relationship[]; note: string }>;
  // ---- M23 P5.6C compliance
  complianceOverview(s: Session): Promise<ComplianceOverview>;
  compliancePolicies(s: Session): Promise<{ inEffect: PolicyVersionPublic[]; missing: string[]; ruleStatuses: string[]; honest: string }>;
  recheckFacet(s: Session, facet: Facet, memberAssociation?: string): Promise<{ facet: FacetView; provider: ProviderStatus }>;
  contexts(s: Session): Promise<{ items: ComplianceContext[]; types: string[]; partyRoles: string[] }>;
  createContext(s: Session, input: ContextCreateInput): Promise<ContextMutation>;
  context(s: Session, id: string): Promise<{ context: ComplianceContext }>;
  evaluateContext(s: Session, id: string): Promise<{ context: ComplianceContext; evaluation: Clearance }>;
  addParty(s: Session, id: string, input: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string; expectedRev?: number }): Promise<ContextMutation>;
  declare(s: Session, id: string, input: { partyRole: PartyRole; agreementId?: string; clientKey: string; expectedRev?: number }): Promise<ContextMutation>;
  withdraw(s: Session, id: string, repId: string, expectedRev?: number): Promise<ContextMutation>;
  closeContext(s: Session, id: string, expectedRev?: number): Promise<ContextMutation>;
  requestConsent(s: Session, id: string, input: { partyRole: PartyRole; fullParticularsProvided: boolean; legalAdviceOffered: boolean; proposedFeeDisclosed: boolean; clientKey: string }): Promise<{ consent: AgentConsent; idempotent?: boolean }>;
  /** Public club directory (names only) — the pool an engaging or releasing entity is picked from. */
  clubs(s: Session): Promise<ClubHit[]>;
  // ---- M23 P5.6D transactions
  transactions(s: Session, status?: string): Promise<TransactionList>;
  createTransaction(s: Session, input: TransactionCreateInput): Promise<TransactionMutation>;
  transaction(s: Session, id: string): Promise<{ transaction: Transaction }>;
  addTxParty(s: Session, id: string, input: { partyRole: PartyRole; subjectKind: 'player' | 'club'; subjectId: string; clientKey: string; expectedRev?: number }): Promise<TransactionMutation>;
  removeTxParty(s: Session, id: string, partyId: string, expectedRev?: number): Promise<TransactionMutation>;
  bindRepresentation(s: Session, id: string, input: { partyRole: PartyRole; agreementId?: string | null; clientKey: string; expectedRev?: number }): Promise<TransactionMutation>;
  unbindRepresentation(s: Session, id: string, repId: string, expectedRev?: number): Promise<TransactionMutation>;
  evaluateTransaction(s: Session, id: string): Promise<TransactionMutation>;
  setTransactionStatus(s: Session, id: string, input: { to: TransactionStatus; reasonCode?: string; reason?: string; clientKey: string; expectedRev?: number }): Promise<TransactionMutation>;
  requestTxConsent(s: Session, id: string, input: { partyRole: PartyRole; fullParticularsProvided: boolean; legalAdviceOffered: boolean; proposedFeeDisclosed: boolean; clientKey: string }): Promise<{ consent: AgentConsent; idempotent?: boolean }>;
  recordTerms(s: Session, id: string, input: { summary: string; recordedFor: PartyRole; visibility: DocumentVisibility; expectedRev?: number }): Promise<TransactionMutation>;
  txDocuments(s: Session, id: string): Promise<{ items: TxDocument[]; documentTypes: string[]; uploadable: string[] }>;
  addTxDocument(s: Session, id: string, input: { documentType: DocumentType; visibility: DocumentVisibility; label: string; expiresAt?: number | null; clientKey: string }): Promise<{ document: TxDocument; idempotent?: boolean }>;
  supersedeTxDocument(s: Session, id: string, docId: string, input: { label?: string; expectedRev?: number }): Promise<{ document: TxDocument }>;
  txDocumentReference(s: Session, id: string, docId: string): Promise<{ document: TxDocument; reference: { kind: string; id: string } | null; note: string }>;
  addTxNote(s: Session, id: string, input: { text: string; visibility: DocumentVisibility; expectedRev?: number }): Promise<{ note: TxNote }>;
  txTimeline(s: Session, id: string): Promise<{ items: TxTimelineEntry[]; note: string }>;
  txMessages(s: Session, id: string): Promise<{ items: TxThread[]; note: string }>;
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
  // ---- M23 P5.6E
  clientContacts: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}/contacts`),
  clientTrials: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}/trials`),
  clientOffers: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}/offers`),
  clientShares: (s, id) => get(s, `/org/agent/clients/${encodeURIComponent(id)}/opportunities/shares`),
  shareOpportunity: (s, id, oppId, input) => post(s, `/org/agent/clients/${encodeURIComponent(id)}/opportunities/${encodeURIComponent(oppId)}/share`, input),
  withdrawShare: (s, id, shareId) => post(s, `/org/agent/clients/${encodeURIComponent(id)}/opportunities/shares/${encodeURIComponent(shareId)}/withdraw`, {}),
  handoffs: (s) => get(s, '/org/agent/handoffs'),
  opportunities: (s) => get(s, '/org/agent/opportunities'),
  inbox: (s) => get(s, '/org/agent/inbox'),
  complianceOverview: (s) => get(s, '/org/agent/compliance/overview'),
  compliancePolicies: (s) => get(s, '/org/agent/compliance/policies'),
  recheckFacet: (s, facet, memberAssociation) => post(s, `/org/agent/compliance/facets/${facet}/recheck`, memberAssociation ? { memberAssociation } : {}),
  contexts: (s) => get(s, '/org/agent/compliance/contexts'),
  createContext: (s, input) => post(s, '/org/agent/compliance/contexts', input),
  context: (s, id) => get(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}`),
  evaluateContext: (s, id) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/evaluate`, {}),
  addParty: (s, id, input) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/parties`, input),
  declare: (s, id, input) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/representations`, input),
  withdraw: (s, id, repId, expectedRev) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/representations/${encodeURIComponent(repId)}/withdraw`, expectedRev === undefined ? {} : { expectedRev }),
  closeContext: (s, id, expectedRev) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/close`, expectedRev === undefined ? {} : { expectedRev }),
  requestConsent: (s, id, input) => post(s, `/org/agent/compliance/contexts/${encodeURIComponent(id)}/consents/request`, input),
  clubs: async () => (await request<ClubHit[]>('/orgs?platform=main')).filter((o) => o.type === 'club'),
  transactions: (s, status) => get(s, `/org/agent/transactions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  createTransaction: (s, input) => post(s, '/org/agent/transactions', input),
  transaction: (s, id) => get(s, `/org/agent/transactions/${encodeURIComponent(id)}`),
  addTxParty: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/parties`, input),
  removeTxParty: (s, id, partyId, expectedRev) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/parties/${encodeURIComponent(partyId)}/remove`, expectedRev === undefined ? {} : { expectedRev }),
  bindRepresentation: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/representations`, input),
  unbindRepresentation: (s, id, repId, expectedRev) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/representations/${encodeURIComponent(repId)}/withdraw`, expectedRev === undefined ? {} : { expectedRev }),
  evaluateTransaction: (s, id) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/evaluate`, {}),
  setTransactionStatus: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/status`, input),
  requestTxConsent: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/consents/request`, input),
  recordTerms: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/terms`, input),
  txDocuments: (s, id) => get(s, `/org/agent/transactions/${encodeURIComponent(id)}/documents`),
  addTxDocument: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/documents`, input),
  supersedeTxDocument: (s, id, docId, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}/supersede`, input),
  txDocumentReference: (s, id, docId) => get(s, `/org/agent/transactions/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}/reference`),
  addTxNote: (s, id, input) => post(s, `/org/agent/transactions/${encodeURIComponent(id)}/notes`, input),
  txTimeline: (s, id) => get(s, `/org/agent/transactions/${encodeURIComponent(id)}/timeline`),
  txMessages: (s, id) => get(s, `/org/agent/transactions/${encodeURIComponent(id)}/messages`),
};

export const agent: AgentApi = DEMO_MODE ? demoAgent : httpAgent;
/** The demo's agency roster, surfaced so the login screen can offer it (empty outside demo mode). */
export const demoIdentities = DEMO_MODE ? DEMO_IDENTITIES : [];

/** A fresh idempotency key for one intended action. */
export const clientKey = () => `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
