// ScoutBox Agent — the self-contained in-browser demo (VITE_DEMO=1).
//
// Synthetic examples on a synthetic agency. State lives in this tab's memory
// and resets on reload. The demo mirrors the SERVER'S rules where a screen
// depends on them (verification gate, access predicate, self-promotion,
// last admin, uniform 404) so what the demo shows is what the product does;
// nothing here is a second source of truth for a real deployment.
import type { CoreApi, Notification, Org, Session } from './api';
import type {
  AgentApi, AgencyOverview, AgentConsent, AuditRow, Clearance, ClientRow, ClubHit, ComplianceContext, ComplianceOverview, ComplianceRow,
  FacetView, Home, Me, Member, MinorReadiness, Opportunity, PartyRole, PolicyVersionPublic, Profile, Reason, Relationship, ReviewPublic, Tier, VerificationState,
  Transaction, TransactionList, TransactionStatus, TransactionType, TxDocument, TxNote, TxTimelineEntry, DocumentVisibility, DocumentType,
  RoutedContact, ClientTrial, OpportunityShare, TransactionHandoff,
} from './agentApi';

const NOW = Date.now();
const DAY = 86_400_000;
let seq = 900;
const id = (p: string) => `${p}-d${++seq}`;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));
class DemoError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } details: Record<string, unknown> | null = null; retryAfterS: number | null = null; retryable: boolean | null = null; }
const refuse = (status: number, code: string, message: string) => { const e = new DemoError(status, code, message); e.details = { error: code }; throw e; };

// ------------------------------------------------------------- the agency
const ORG: Org = { id: 'org-northstar', name: 'North Star Sports Agency', type: 'agency', plan: 'Agency', trustedPartner: false, verified: false };

interface DemoUser { id: string; name: string; role: string }
const USERS: DemoUser[] = [
  { id: 'usr-ana', name: 'Ana Costa', role: 'Agent' },
  { id: 'usr-tomas', name: 'Tomás Rivera', role: 'Director' },
  { id: 'usr-ben', name: 'Ben Okoro', role: 'Analyst' },
];
interface Aff { id: string; userId: string; tiers: Tier[]; startedAt: number; endedAt: number | null; endedReason: string | null; rev: number; revAt: number }
const AFFS: Aff[] = [
  { id: 'aff-1', userId: 'usr-tomas', tiers: ['agency_admin'], startedAt: NOW - 400 * DAY, endedAt: null, endedReason: null, rev: 1, revAt: NOW - 400 * DAY },
  { id: 'aff-2', userId: 'usr-ana', tiers: ['licensed_agent'], startedAt: NOW - 300 * DAY, endedAt: null, endedReason: null, rev: 1, revAt: NOW - 300 * DAY },
  { id: 'aff-3', userId: 'usr-ben', tiers: ['analyst'], startedAt: NOW - 120 * DAY, endedAt: null, endedReason: null, rev: 1, revAt: NOW - 120 * DAY },
];
/**
 * The identities this demo actually has an agency affiliation for.
 *
 * Why this is exported: the login screen takes a free-text name, exactly as the
 * real app does, and the demo's `login` invents a user for any name it does not
 * recognise — but it does NOT invent an affiliation, because the real server does
 * not either. A brand-new name at an agency is correctly refused
 * AGENCY_MEMBERSHIP_REQUIRED ("your agency's administrator sets your roles", as
 * the login screen itself says).
 *
 * That refusal is right, so it is not what gets changed. What was wrong is that
 * nothing told you who you CAN be, so any other name led to a workspace that
 * refused every request with no administrator anywhere to ask. The login screen
 * now offers these, derived from the fixtures rather than retyped, so the list
 * cannot drift out of step with AFFS.
 */
export const DEMO_IDENTITIES: { name: string; role: string; tier: Tier }[] = AFFS
  .filter((a) => a.endedAt === null)
  .map((a) => {
    const u = USERS.find((x) => x.id === a.userId);
    return { name: u?.name ?? a.userId, role: u?.role ?? 'Agent', tier: a.tiers[0] };
  });

const PERMISSIONS: Record<string, Tier[]> = {
  'me.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'],
  'profile.write.own': ['licensed_agent'], 'verification.submit': ['licensed_agent'], 'clients.read.own': ['licensed_agent'],
  'clients.read.shared_summary': ['agency_admin', 'analyst', 'assistant', 'finance'], 'clients.request': ['licensed_agent'],
  'clients.terminate': ['licensed_agent'], 'clients.opportunities.read': ['licensed_agent'], 'players.lookup': ['licensed_agent'],
  'inbox.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'], 'agency.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'],
  'agency.team.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'], 'agency.team.write': ['agency_admin'],
  'agency.settings.write': ['agency_admin'], 'agency.audit.read': ['agency_admin'], 'agency.compliance.read': ['agency_admin', 'licensed_agent'],
  // M23 P5.6C
  'compliance.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'], 'compliance.contexts.write': ['licensed_agent'],
  // M23 P5.6D. Mirrors the server matrix in m24/shared.mjs exactly: reading the
  // agency's transactions is every member's, and every WRITE is the licensed
  // individual's. Omitting them made the demo refuse its own screen (D15).
  'transactions.read': ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'], 'transactions.write': ['licensed_agent'],
};
/** The public club directory the demo picks an engaging or releasing entity from. */
const DEMO_CLUBS: ClubHit[] = [
  { id: 'org-eastport', name: 'Eastport FC', type: 'club', verified: true },
  { id: 'org-harbour', name: 'Harbour City FC', type: 'club', verified: false },
];
const can = (tiers: Tier[], cap: string) => (PERMISSIONS[cap] ?? []).some((t) => tiers.includes(t));

// ------------------------------------------------------------- players
interface DemoPlayer { id: string; name: string; position: string; age: number; club: string | null; country: string; blocked?: boolean }
const PLAYERS: DemoPlayer[] = [
  { id: 'pl-adeyemi', name: 'Kola Adeyemi', position: 'ST', age: 22, club: null, country: 'GB' },
  { id: 'pl-carvalho', name: 'Mateus Carvalho', position: 'CM', age: 24, club: 'Riverline FC', country: 'PT' },
  { id: 'pl-okafor', name: 'Chinedu Okafor', position: 'CB', age: 22, club: null, country: 'NG' },
  { id: 'pl-nowak', name: 'Filip Nowak', position: 'GK', age: 25, club: 'Harbour City FC', country: 'PL' },
  { id: 'pl-martin', name: 'Théo Martin', position: 'LB', age: 25, club: null, country: 'FR' },
  { id: 'pl-tanaka', name: 'Riku Tanaka', position: 'RW', age: 21, club: null, country: 'JP' },
  { id: 'pl-osei', name: 'Kwame Osei', position: 'AM', age: 24, club: null, country: 'GH' },
];
const BOARD: Record<string, Opportunity[]> = {
  'pl-adeyemi': [
    { id: 'opp-d1', via: 'open_trial', type: 'open_trial', orgId: 'org-eastport', orgName: 'Eastport Academy', title: 'Open trial — forwards (U23)', deadline: new Date(NOW + 12 * DAY).toISOString().slice(0, 10), category: 'U23', distance: '18 km', applied: false },
    { id: 'opp-d2', via: 'campaign', type: 'campaign', orgId: 'org-harbour', orgName: 'Harbour City FC', title: 'Finishing assessment campaign', deadline: new Date(NOW + 30 * DAY).toISOString().slice(0, 10), category: 'senior', distance: '41 km', applied: true },
  ],
  'pl-carvalho': [
    { id: 'opp-d3', via: 'open_trial', type: 'open_trial', orgId: 'org-eastport', orgName: 'Eastport Academy', title: 'Midfield trial day', deadline: new Date(NOW + 20 * DAY).toISOString().slice(0, 10), category: 'senior', distance: '22 km', applied: false },
  ],
};

// ------------------------------------------------------------- profiles
const facet = (state: VerificationState, over: Partial<FacetView> = {}): FacetView => ({
  state, storedState: state, reference: null, memberAssociation: null, provenance: null, submittedAt: null, verifiedAt: null, recheckAt: null, note: null, ...over,
});
interface DemoProfile { userId: string; displayName: string; declared: { fifaLicenceNumber: string | null; jurisdictions: string[] }; facets: Profile['facets']; rev: number; revAt: number; createdAt: number; history: Profile['history'] }
const PROFILES: DemoProfile[] = [{
  userId: 'usr-ana', displayName: 'Ana Costa', declared: { fifaLicenceNumber: 'FIFA-2024-777', jurisdictions: ['ENG'] },
  facets: {
    fifa_licence: facet('VERIFIED', { reference: 'TEST-VERIFIED-777', provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: NOW - 10 * DAY }, submittedAt: NOW - 10 * DAY, verifiedAt: NOW - 10 * DAY, recheckAt: NOW + 20 * DAY, note: 'Verified by the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.' }),
    national_registration: { ENG: facet('VERIFIED', { reference: 'TEST-VERIFIED-FA', memberAssociation: 'ENG', provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: NOW - 9 * DAY }, submittedAt: NOW - 9 * DAY, verifiedAt: NOW - 9 * DAY, recheckAt: NOW + 21 * DAY, note: 'Verified by the LOCAL SYNTHETIC test provider.' }) },
    // P5.6C: a fourth facet, empty. A licence is not a national registration and neither is a domestic authorisation.
    domestic_authorisation: {},
    minors_authorisation: {},
  },
  rev: 3, revAt: NOW - 9 * DAY, createdAt: NOW - 12 * DAY,
  history: [
    { id: 'h-1', at: NOW - 12 * DAY, action: 'agent_profile_created', detail: null },
    { id: 'h-2', at: NOW - 10 * DAY, action: 'agent_verification_state_changed', detail: { facet: 'fifa_licence', from: 'UNVERIFIED', to: 'VERIFIED' } },
    { id: 'h-3', at: NOW - 9 * DAY, action: 'agent_verification_state_changed', detail: { facet: 'national_registration', memberAssociation: 'ENG', from: 'UNVERIFIED', to: 'VERIFIED' } },
  ],
}];
const effState = (f: FacetView | null | undefined): VerificationState => (!f ? 'UNVERIFIED' : f.state === 'VERIFIED' && f.recheckAt !== null && f.recheckAt <= Date.now() ? 'STALE' : f.state);
const gap = (p: DemoProfile | undefined, jurisdiction: string) => {
  if (!p) return { error: 'AGENT_PROFILE_REQUIRED', message: 'Create your agent profile first.' };
  if (effState(p.facets.fifa_licence) !== 'VERIFIED') return { error: 'AGENT_VERIFICATION_REQUIRED', message: `A regulated action needs a VERIFIED fifa_licence; it is ${effState(p.facets.fifa_licence)}.` };
  if (jurisdiction === 'ENG' && effState(p.facets.national_registration.ENG) !== 'VERIFIED') return { error: 'AGENT_VERIFICATION_REQUIRED', message: `A regulated action needs a VERIFIED national_registration (ENG); it is ${effState(p.facets.national_registration.ENG)}.` };
  return null;
};
const profileView = (p: DemoProfile | undefined): Profile | null => {
  if (!p) return null;
  const fifa = p.facets.fifa_licence ? { ...p.facets.fifa_licence, state: effState(p.facets.fifa_licence) } : null;
  return {
    id: `agp-${p.userId}`, userId: p.userId, agencyOrgId: ORG.id, displayName: p.displayName, declared: p.declared,
    facets: {
      fifa_licence: fifa,
      national_registration: Object.fromEntries(Object.entries(p.facets.national_registration).map(([k, f]) => [k, { ...f, state: effState(f) }])),
      domestic_authorisation: Object.fromEntries(Object.entries(p.facets.domestic_authorisation).map(([k, f]) => [k, { ...f, state: effState(f) }])),
      minors_authorisation: Object.fromEntries(Object.entries(p.facets.minors_authorisation).map(([k, f]) => [k, { ...f, state: effState(f) }])),
    },
    regulatoryState: {
      fifaLicence: effState(p.facets.fifa_licence),
      jurisdictions: p.declared.jurisdictions.map((ma) => ({ memberAssociation: ma, nationalRegistration: effState(p.facets.national_registration[ma]), domesticAuthorisation: effState(p.facets.domestic_authorisation[ma]), minorsAuthorisation: effState(p.facets.minors_authorisation[ma]), regulatedActionsPermitted: !gap(p, ma) })),
    },
    policyVersion: 1, createdAt: p.createdAt, updatedAt: p.revAt, rev: p.rev, revAt: p.revAt, history: p.history,
    honest: 'Verification states are derived from recorded provenance. A licence number you typed is a declaration, not a verified licence. No FIFA, FA or U.S. Soccer register integration exists in this build.',
  };
};

// ------------------------------------------------------------- relationships
interface DemoRel extends Omit<Relationship, 'client' | 'mode' | 'status'> { status: Relationship['storedStatus'] extends string ? Relationship['status'] : never; disputeReasonHidden?: string }
const rel = (over: Partial<DemoRel> & Pick<DemoRel, 'id' | 'clientId' | 'status'>): DemoRel => ({
  agentUserId: 'usr-ana', agencyOrgId: ORG.id, clientKind: 'player', storedStatus: over.status, scope: ['employment'], exclusive: false, jurisdiction: 'INT',
  termMonths: 12, startAt: null, endAt: null, proposedAt: NOW - 5 * DAY, confirmedAt: null, declinedAt: null, terminatedAt: null, terminatedBy: null,
  terminationReasonCode: null, disputedAt: null, shareWithAgencyStaff: false, documents: [], legacy: null, subjectRemovedAt: null, policyVersion: 1,
  rev: 1, revAt: NOW - 5 * DAY, history: [{ id: id('h'), at: NOW - 5 * DAY, action: 'representation_requested', byKind: 'org', byName: 'Ana Costa', detail: { scope: ['employment'], termMonths: 12 } }],
  honest: 'A ScoutBox relationship record. It is not a representation contract and ScoutBox has not assessed its legal validity; the client confirmed it in ScoutBox.',
  ...over,
});
const RELS: DemoRel[] = [
  rel({ id: 'rep-d1', clientId: 'pl-adeyemi', status: 'active', scope: ['employment', 'transfer'], jurisdiction: 'ENG', termMonths: 18, proposedAt: NOW - 40 * DAY, confirmedAt: NOW - 38 * DAY, startAt: NOW - 38 * DAY, endAt: NOW - 38 * DAY + 18 * 30 * DAY, rev: 2, revAt: NOW - 38 * DAY, shareWithAgencyStaff: true,
    history: [{ id: 'h-r1', at: NOW - 40 * DAY, action: 'representation_requested', byKind: 'org', byName: 'Ana Costa', detail: { scope: ['employment', 'transfer'], termMonths: 18 } }, { id: 'h-r2', at: NOW - 38 * DAY, action: 'representation_confirmed', byKind: 'player', byName: 'Kola Adeyemi', detail: { from: 'proposed', to: 'active' } }, { id: 'h-r3', at: NOW - 30 * DAY, action: 'representation_sharing_changed', byKind: 'player', byName: 'Kola Adeyemi', detail: { shareWithAgencyStaff: true } }] }),
  rel({ id: 'rep-d2', clientId: 'pl-carvalho', status: 'active', proposedAt: NOW - 350 * DAY, confirmedAt: NOW - 348 * DAY, startAt: NOW - 348 * DAY, endAt: NOW + 12 * DAY, rev: 2, revAt: NOW - 348 * DAY,
    history: [{ id: 'h-r4', at: NOW - 350 * DAY, action: 'representation_requested', byKind: 'org', byName: 'Ana Costa', detail: null }, { id: 'h-r5', at: NOW - 348 * DAY, action: 'representation_confirmed', byKind: 'player', byName: 'Mateus Carvalho', detail: { from: 'proposed', to: 'active' } }] }),
  rel({ id: 'rep-d3', clientId: 'pl-okafor', status: 'proposed', proposedAt: NOW - 2 * DAY, revAt: NOW - 2 * DAY }),
  rel({ id: 'rep-d4', clientId: 'pl-nowak', status: 'disputed', proposedAt: NOW - 60 * DAY, confirmedAt: NOW - 58 * DAY, startAt: NOW - 58 * DAY, endAt: NOW + 300 * DAY, disputedAt: NOW - 3 * DAY, rev: 3, revAt: NOW - 3 * DAY,
    history: [{ id: 'h-r6', at: NOW - 60 * DAY, action: 'representation_requested', byKind: 'org', byName: 'Ana Costa', detail: null }, { id: 'h-r7', at: NOW - 58 * DAY, action: 'representation_confirmed', byKind: 'player', byName: 'Filip Nowak', detail: { from: 'proposed', to: 'active' } }, { id: 'h-r8', at: NOW - 3 * DAY, action: 'representation_disputed', byKind: 'player', byName: 'Filip Nowak', detail: { from: 'active', to: 'disputed', hadReason: true } }] }),
  rel({ id: 'rep-d5', clientId: 'pl-tanaka', status: 'declined', proposedAt: NOW - 20 * DAY, declinedAt: NOW - 18 * DAY, rev: 2, revAt: NOW - 18 * DAY,
    history: [{ id: 'h-r9', at: NOW - 20 * DAY, action: 'representation_requested', byKind: 'org', byName: 'Ana Costa', detail: null }, { id: 'h-r10', at: NOW - 18 * DAY, action: 'representation_rejected', byKind: 'player', byName: 'Riku Tanaka', detail: { from: 'proposed', to: 'declined' } }] }),
];
const eff = (r: DemoRel): Relationship['status'] => (r.status === 'active' && r.endAt !== null && r.endAt <= Date.now() ? 'expired' : r.status);
const grants = (r: DemoRel, userId: string) => r.agentUserId === userId && r.confirmedAt !== null && eff(r) === 'active';
const identity = (r: DemoRel, userId: string) => {
  const p = PLAYERS.find((x) => x.id === r.clientId);
  if (!p) return { id: r.clientId, name: null, removed: true };
  if (p.blocked) return { id: p.id, name: null, unavailable: true };
  const minimal = { id: p.id, name: p.name, position: p.position, age: p.age, club: p.club, country: p.country };
  if (grants(r, userId)) return { ...minimal, accessBasis: 'active_confirmed_relationship' as const, level: 'academy', city: 'London', trustScore: 71 };
  return { ...minimal, accessBasis: eff(r) === 'proposed' ? ('pending_request' as const) : ('none' as const) };
};
const forAgent = (r: DemoRel, userId: string): Relationship => ({ ...(structuredClone(r) as unknown as Relationship), status: eff(r), client: identity(r, userId), mode: 'own' });
const summary = (r: DemoRel) => ({ id: r.id, agentUserId: r.agentUserId, clientId: r.clientId, status: eff(r), startAt: r.startAt, endAt: r.endAt, summaryOnly: true as const, client: { id: r.clientId, name: PLAYERS.find((p) => p.id === r.clientId)?.name ?? null }, legacy: r.legacy, mode: 'summary' as const });

// ------------------------------------------------------------- notifications
const NOTES: Record<string, Notification[]> = {
  'usr-ana': [
    { id: 'n-1', ts: NOW - 3 * DAY, type: 'representation_disputed', text: 'A client disputed the representation relationship. Private access is suspended pending attributed Trust & Safety review, which is not yet available in this build.', refId: 'rep-d4', read: false },
    { id: 'n-2', ts: NOW - 18 * DAY, type: 'representation_rejected', text: 'A player declined your representation request. You cannot ask again for 30 days.', refId: 'rep-d5', read: true },
    { id: 'n-3', ts: NOW - 38 * DAY, type: 'representation_confirmed', text: 'A client confirmed your representation relationship. It is active from now until its end date.', refId: 'rep-d1', read: true },
  ],
  'usr-tomas': [], 'usr-ben': [],
};
const AUDIT: AuditRow[] = [
  { id: 'a-1', at: NOW - 3 * DAY, action: 'representation_disputed', domain: 'representation', actor: { userId: null, name: 'Player' }, target: { type: 'representation', id: 'rep-d4', agentUserId: 'usr-ana', playerId: 'pl-nowak', playerName: 'Filip Nowak' }, detail: { from: 'active', to: 'disputed', hadReason: true } },
  { id: 'a-2', at: NOW - 9 * DAY, action: 'agent_verification_state_changed', domain: 'agent', actor: { userId: 'usr-ana', name: 'Ana Costa' }, target: { type: 'agent_profile', id: 'agp-usr-ana', userId: 'usr-ana' }, detail: { facet: 'national_registration', memberAssociation: 'ENG', from: 'UNVERIFIED', to: 'VERIFIED' } },
  { id: 'a-3', at: NOW - 38 * DAY, action: 'representation_confirmed', domain: 'representation', actor: { userId: null, name: 'Player' }, target: { type: 'representation', id: 'rep-d1', agentUserId: 'usr-ana', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi' }, detail: { from: 'proposed', to: 'active' } },
  { id: 'a-4', at: NOW - 120 * DAY, action: 'agency_affiliation_created', domain: 'agency', actor: { userId: 'usr-tomas', name: 'Tomás Rivera' }, target: { type: 'agency_affiliation', id: 'aff-3', userId: 'usr-ben' }, detail: { tiers: ['analyst'] } },
];
let SETTINGS = { jurisdictions: ['ENG', 'INT'], description: 'Player representation, England and international.' };

// ------------------------------------------------------------- session helpers
const userOf = (s: Session) => USERS.find((u) => u.id === s.userId) ?? refuse(401, 'ORG_AUTH_REQUIRED', 'Log in again.');
const affOf = (s: Session) => {
  const a = AFFS.find((x) => x.userId === s.userId && x.endedAt === null);
  if (!a) refuse(403, 'AGENCY_MEMBERSHIP_REQUIRED', 'You are not an active member of this agency. Ask an agency administrator to add you.');
  return a as Aff;
};
const need = (s: Session, cap: string) => { const a = affOf(s); if (!can(a.tiers, cap)) refuse(403, 'AGENT_ACTION_NOT_PERMITTED', `Your agency role does not include "${cap}".`); return a; };
const memberRow = (a: Aff): Member => {
  const u = USERS.find((x) => x.id === a.userId);
  const p = PROFILES.find((x) => x.userId === a.userId);
  return { affiliationId: a.id, userId: a.userId, name: u?.name ?? null, role: u?.role ?? null, tiers: a.tiers, active: a.endedAt === null, startedAt: a.startedAt, endedAt: a.endedAt, endedReason: a.endedReason, licensed: !!p, fifaLicence: p ? effState(p.facets.fifa_licence) : null, rev: a.rev, revAt: a.revAt };
};


// ============================================================ M23 P5.6C compliance (demo)
// The demo mirrors the SERVER's verdicts for the journey it shows: a single
// represented party is CLEAR, a second party needs prior written consent, an
// entity with no ScoutBox agreement is only "declared" and waits for an
// attributed review, and a rule whose status is UNDER_LEGAL_REVIEW never
// resolves itself here. Nothing in this file is a second source of truth.
const PROVIDER_STATUS = {
  provider: 'local-synthetic-test-provider', live: false,
  registers: { fifa: 'not_connected', fa: 'not_connected', ussf: 'not_connected' },
  note: 'LOCAL SYNTHETIC test provider active. Verifies only TEST-* references. Never exists in production.',
};
const DEMO_POLICIES: PolicyVersionPublic[] = [
  { id: 'jp-fifa-2025-1', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 1, supersedes: null, effectiveFrom: '2025-10-01', effectiveTo: null, status: 'published', publishedAt: NOW - 300 * DAY },
  { id: 'jp-eng-2026-27-1', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 1, supersedes: null, effectiveFrom: '2026-07-01', effectiveTo: null, status: 'published', publishedAt: NOW - 80 * DAY },
];
const reason = (code: string, over: Partial<Reason> = {}): Reason => ({ code, ruleId: null, ruleStatus: null, regulator: null, jurisdiction: null, policyVersion: null, ...over });
const ENG_MULTI = { ruleId: 'ENG-6.3', ruleStatus: 'ACTIVE' as const, regulator: 'FA', jurisdiction: 'ENG', policyVersion: 'jp-eng-2026-27-1' };
const FIFA_OVERRIDDEN = { ruleId: 'FIFA-12.8', ruleStatus: 'JURISDICTION_OVERRIDE' as const, regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 'jp-fifa-2025-1', overrideRuleId: 'ENG-6.3' };

interface DemoCtx {
  id: string; type: ComplianceContext['type']; status: 'open' | 'closed'; jurisdictions: string[];
  parties: ComplianceContext['parties']; representations: ComplianceContext['representations'];
  clearance: Clearance | null; reEvaluationPending: boolean; evaluations: number; openedAt: number; closedAt: number | null;
  rev: number; revAt: number; history: ComplianceContext['history'];
}
const CTX_HONEST = 'A compliance context is a minimal record for conflict evaluation. It is not a Transaction Room: no negotiation, no terms, no offer and no signing happen here.';
const CONSENTS: AgentConsent[] = [];
const REVIEWS: ReviewPublic[] = [];
const CTXS: DemoCtx[] = [];

const cxHist = (c: DemoCtx, action: string, detail: Record<string, unknown> | null = null, byKind = 'org') => {
  c.history.push({ id: id('aud'), at: Date.now(), action, byKind, detail });
};
const clearanceOf = (c: DemoCtx): Clearance => {
  const at = Date.now();
  const roles = c.representations.filter((r) => r.status === 'verified').map((r) => r.partyRole);
  const declared = c.representations.filter((r) => r.status === 'pending_review');
  const base = { policyVersions: DEMO_POLICIES.map((p) => p.id), evaluatedAt: at, inputHash: `demo-${c.id}-${c.representations.length}-${CONSENTS.filter((k) => k.contextId === c.id).map((k) => k.status).join('')}`, current: true, requiredActions: [] as Clearance['requiredActions'] };
  const national = [reason('NATIONAL_RULE_APPLIES', FIFA_OVERRIDDEN)];
  if (declared.length) {
    return { ...base, outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', alias: null, reasons: [...national, reason('REPRESENTATION_UNVERIFIED', { partyRole: declared[0].partyRole })], consentsOutstanding: [], requiredActions: [{ action: 'await_attributed_review', partyRoles: declared.map((r) => r.partyRole) }] };
  }
  if (roles.length === 0) return { ...base, outcome: 'CLEAR', alias: null, reasons: [...national, reason('NO_REPRESENTATION')], consentsOutstanding: [] };
  if (roles.length === 1) return { ...base, outcome: 'CLEAR', alias: null, reasons: [...national, reason('SINGLE_PARTY', { ...ENG_MULTI, partyRoles: roles })], consentsOutstanding: [] };
  if (roles.includes('releasing_entity') && roles.includes('individual')) {
    return { ...base, outcome: 'PROHIBITED_CONFLICT', alias: null, reasons: [...national, reason('PROHIBITED_COMBINATION', { ruleId: 'ENG-6.4', ruleStatus: 'ACTIVE', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 'jp-eng-2026-27-1', partyRoles: roles })], consentsOutstanding: [] };
  }
  const outstanding = roles
    .map((role) => {
      const k = CONSENTS.find((x) => x.contextId === c.id && x.partyRole === role);
      if (k?.status === 'granted') return null;
      const reasonCode = k?.status === 'revoked' ? 'CONSENT_REVOKED' : k?.status === 'declined' ? 'CONSENT_DECLINED' : 'CONSENT_MISSING';
      return { partyRole: role, consentKind: 'dual_representation', reasonCode };
    })
    .filter((x): x is { partyRole: PartyRole; consentKind: string; reasonCode: string } => x !== null);
  if (outstanding.length === 0) {
    return { ...base, outcome: 'CLEAR', alias: null, reasons: [...national, reason('DUAL_CONSENTED', { ...ENG_MULTI, partyRoles: roles })], consentsOutstanding: [] };
  }
  return {
    ...base, outcome: 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', alias: 'PERMITTED_WITH_CONSENT',
    reasons: [...national, reason('CONSENT_REQUIRED', { ...ENG_MULTI, partyRoles: roles })], consentsOutstanding: outstanding,
    requiredActions: [{ action: 'obtain_written_consent', partyRoles: outstanding.map((o) => o.partyRole) }],
  };
};
const reEvaluate = (c: DemoCtx, byKind = 'org') => { c.clearance = clearanceOf(c); c.evaluations += 1; c.reEvaluationPending = false; cxHist(c, 'compliance_context_evaluated', { outcome: c.clearance.outcome }, byKind); return c.clearance; };
const ctxView = (c: DemoCtx): ComplianceContext => ({
  id: c.id, type: c.type, status: c.status, jurisdictions: c.jurisdictions,
  scope: c.jurisdictions.some((j) => j !== 'INT') && !c.jurisdictions.includes('INT') ? 'national' : 'international',
  parties: structuredClone(c.parties), representations: structuredClone(c.representations),
  clearance: c.clearance ? structuredClone(c.clearance) : null, reEvaluationPending: c.reEvaluationPending,
  evaluationCount: c.evaluations, openedAt: c.openedAt, closedAt: c.closedAt, rev: c.rev, revAt: c.revAt,
  history: structuredClone(c.history), honest: CTX_HONEST,
});
const freshnessOf = (p: DemoProfile | undefined): ComplianceOverview['freshness'] => {
  if (!p) return [];
  const rows: ComplianceOverview['freshness'] = [];
  const push = (facet: ComplianceOverview['freshness'][number]['facet'], ma: string | null, f: FacetView | undefined | null) => {
    if (!f) return;
    rows.push({ facet, memberAssociation: ma, state: effState(f), storedState: f.state, recheckAt: f.recheckAt, daysUntilRecheck: f.recheckAt === null ? null : Math.ceil((f.recheckAt - Date.now()) / DAY), provenance: f.provenance, verifiedAt: f.verifiedAt });
  };
  push('fifa_licence', null, p.facets.fifa_licence);
  for (const [ma, f] of Object.entries(p.facets.national_registration)) push('national_registration', ma, f);
  for (const [ma, f] of Object.entries(p.facets.domestic_authorisation)) push('domestic_authorisation', ma, f);
  for (const [ma, f] of Object.entries(p.facets.minors_authorisation)) push('minors_authorisation', ma, f);
  return rows;
};
const MINOR_READINESS: MinorReadiness[] = [{
  memberAssociation: 'ENG', pathwayEnabledInProduction: false,
  timingRule: { ruleId: 'ENG-5.1', ruleStatus: 'ACTIVE', formula: 'academic_year_16' }, timingEncoded: true,
  agentReady: false, gaps: [{ facet: 'minors_authorisation', memberAssociation: 'ENG', state: 'UNVERIFIED', code: 'AGENT_MINOR_AUTHORISATION_REQUIRED' }],
  reasons: [reason('AGENT_STATE_INVALID')],
  honest: 'General discovery of minors by agencies is prohibited and no minor representation workflow is live in any jurisdiction. This is the agent\u2019s own readiness under the encoded rules, evaluated against no subject.',
}];
const COMPLIANCE_HONEST = 'ScoutBox policy results say whether this workflow may proceed under the currently encoded rules. They are not statements of legal validity and no governing body has approved anything here.';

// ============================================================ core
export const demoCore: CoreApi = {
  listOrgs: () => delay([ORG]),
  async login(orgId, scoutName, role) {
    if (orgId !== ORG.id) refuse(404, 'ORG_NOT_FOUND', 'Unknown organisation.');
    if (!scoutName.trim()) refuse(400, 'SCOUT_NAME_REQUIRED', 'Every session is attributed to a named individual.');
    let u = USERS.find((x) => x.name.toLowerCase() === scoutName.trim().toLowerCase());
    if (!u) { u = { id: id('usr'), name: scoutName.trim(), role }; USERS.push(u); NOTES[u.id] = []; }
    return delay({ org: ORG, userId: u.id, scoutName: u.name, role: u.role, token: `demo-${u.id}` });
  },
  getNotifications: (s) => delay(NOTES[s.userId] ?? []),
  async markNotificationsRead(s) { for (const n of NOTES[s.userId] ?? []) n.read = true; return delay(undefined); },
  async report() { return delay(undefined); },
  onChange: () => () => {},
};

// ============================================================ agent
// ------------------------------------------- M23 P5.6D transaction workspace
// Six synthetic transactions, one per state the mandate asks the demo to show
// (§86): compliance clear, consent required, attributed review, blocked by an
// active rule, on hold and cancelled. No minor appears in any of them and none
// implies a minor pathway exists; nothing here is an offer or a signing.
const HONEST_TX = 'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';
const HONEST_OFFER = 'Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.';
const ROLE_AGENT = { kind: 'agent', label: 'Representing agent' };
const ROLE_CLUB = { kind: 'club', label: 'Club signatory' };
const ROLE_PLAYER = { kind: 'player', label: 'Player' };

let txSeq = 0;
function demoTx(input: {
  type: TransactionType; status: TransactionStatus; playerId: string; engaging: string; releasing?: string;
  confirmed?: boolean; clear?: boolean; blocked?: boolean; pendingReason?: string | null; stale?: string | null;
  consents?: { partyRole: PartyRole; status: string }[]; hold?: string; cancelReason?: string; documents?: TxDocument[]; notes?: TxNote[];
}): Transaction {
  txSeq += 1;
  const at = NOW - txSeq * 3 * DAY;
  const party = (partyRole: PartyRole, subjectKind: 'player' | 'club', subjectId: string): Transaction['parties'][number] => ({
    id: `txp-d${txSeq}-${partyRole}`, partyRole, subjectKind, subjectId,
    name: subjectKind === 'player' ? (PLAYERS.find((x) => x.id === subjectId)?.name ?? null) : (DEMO_CLUBS.find((x) => x.id === subjectId)?.name ?? null),
    removed: false, removedAt: null, confirmedAt: input.confirmed === false ? null : at + DAY,
    confirmedByKind: subjectKind === 'player' ? 'player' : 'club_user', addedAt: at, subjectRemovedAt: null,
  });
  const parties = [party('individual', 'player', input.playerId), party('engaging_entity', 'club', input.engaging)];
  if (input.releasing) parties.push(party('releasing_entity', 'club', input.releasing));
  const required: PartyRole[] = input.releasing ? ['individual', 'engaging_entity', 'releasing_entity'] : ['individual', 'engaging_entity'];
  const clear = !!input.clear;
  const allowed: TransactionStatus[] = input.status === 'READY' ? ['ACTIVE', 'ON_HOLD', 'CANCELLED']
    : input.status === 'ACTIVE' ? ['ON_HOLD', 'CLOSED', 'CANCELLED']
      : input.status === 'ON_HOLD' ? ['ACTIVE', 'CLOSED', 'CANCELLED']
        : input.status === 'CANCELLED' ? ['ARCHIVED']
          : input.status === 'DRAFT' ? ['PARTIES_CONFIRMED', 'CANCELLED'] : ['ACTIVE', 'CANCELLED'];
  const blockers: string[] = [];
  if (!['READY', 'ACTIVE'].includes(input.status)) blockers.push('TRANSACTION_NOT_READY');
  if (input.stale) blockers.push('COMPLIANCE_SNAPSHOT_STALE');
  if (!clear) blockers.push('COMPLIANCE_NOT_CLEAR');
  return {
    id: `atx-d${txSeq}`, type: input.type, status: input.status, jurisdictions: ['ENG'],
    playerId: input.playerId, engagingOrgId: input.engaging, releasingOrgId: input.releasing ?? null,
    viewerRoles: ['representing_agent'], viewerPartyRole: null,
    agency: { id: ORG.id, name: ORG.name },
    parties, requiredPartyRoles: required,
    awaitingConfirmation: input.confirmed === false ? required : [],
    partiesConfirmed: input.confirmed !== false,
    representations: input.confirmed === false ? [] : [{
      id: `txr-d${txSeq}`, partyRole: 'individual', agentUserId: 'usr-ana', status: 'verified', declaredOnly: false,
      basis: 'client_confirmed_agreement', scope: ['employment', 'transfer'], jurisdictions: ['ENG'],
      verifiedAt: at + DAY, withdrawnAt: null, createdAt: at + DAY, agreementId: 'rep-d1', reviewId: null, firstActAt: at + DAY,
    }],
    compliance: {
      outcome: input.blocked ? 'PROHIBITED_CONFLICT' : clear ? 'CLEAR' : input.pendingReason === 'CONSENT_REQUIRED' ? 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED' : 'MANUAL_REGULATORY_REVIEW_REQUIRED',
      pendingReason: input.pendingReason ?? null, blocked: !!input.blocked, clear, snapshotClear: clear || !!input.stale,
      reasonCodes: input.blocked ? ['PROHIBITED_COMBINATION'] : clear ? [] : input.pendingReason === 'CONSENT_REQUIRED' ? ['CONSENT_REQUIRED'] : ['RULE_STATUS_UNCERTAIN'],
      consentRequirements: (input.consents ?? []).filter((c) => c.status === 'requested').map((c) => ({ partyRole: c.partyRole, consentKind: 'dual_representation', reasonCode: 'CONSENT_MISSING' })),
      evaluatedAt: at + 2 * DAY, stale: input.stale ?? null, staleness: input.stale ?? null,
      evaluationId: `atx-d${txSeq}#1`, contextId: `ctx-d${txSeq}`, policyVersions: DEMO_POLICIES.map((x) => x.id), verificationFreshness: 'VERIFIED',
      honest: 'ScoutBox has evaluated its own encoded rules. It has not determined anyone\u2019s legal rights and no governing body has approved anything.',
    },
    consents: (input.consents ?? []).map((c, i) => ({
      id: `rcs-d${txSeq}-${i}`, kind: 'dual_representation', partyRole: c.partyRole, status: c.status,
      requestedAt: at + 2 * DAY, grantedAt: c.status === 'granted' ? at + 2 * DAY + 3600_000 : null,
      declinedAt: null, revokedAt: c.status === 'revoked' ? at + 3 * DAY : null, mine: false,
    })),
    documents: input.documents ?? [],
    notes: input.notes ?? [],
    linkedThreads: [],
    links: { trialId: null, opportunityId: null },
    terms: { versions: [] },
    offerBoundary: { canStartOfferWorkflow: blockers.length === 0, blockers, honest: HONEST_OFFER },
    hold: input.status === 'ON_HOLD' ? { reasonCode: input.hold ?? 'awaiting_document', reason: 'Waiting on the club letter.', at: at + 4 * DAY } : null,
    cancelReasonCode: input.cancelReason ?? null, closeReasonCode: null,
    allowedTransitions: allowed,
    initiatedBy: 'org', initiatedAt: at, createdAt: at, updatedAt: at + 4 * DAY,
    rev: 4, revAt: at + 4 * DAY, revBy: 'Representing agent',
    honest: HONEST_TX,
  };
}

const demoDoc = (n: number, label: string, visibility: DocumentVisibility, documentType: DocumentType, ownerKind: string, actor: { kind: string; label: string }): TxDocument => ({
  id: `txd-d${n}`, documentType, visibility, version: 1, label, ownerKind, ownerPartyRole: null,
  uploadedAt: NOW - 2 * DAY, actor, expiresAt: null, expired: false, signedAt: null, supersedes: null,
  evidence: null, downloadable: false, rev: 1, revAt: NOW - 2 * DAY, revBy: actor.label,
});

const TXS: Transaction[] = [
  demoTx({ type: 'employment_contract', status: 'READY', playerId: 'pl-adeyemi', engaging: 'org-eastport', clear: true,
    documents: [demoDoc(1, 'Draft term sheet', 'ALL_TRANSACTION_PARTIES', 'term_sheet_draft', 'agent', ROLE_AGENT), demoDoc(2, 'Club letter of intent', 'ENGAGING_AGENT_SHARED', 'club_document', 'club', ROLE_CLUB)],
    notes: [{ id: 'txn-d1', visibility: 'AGENT_PRIVATE', text: 'Client wants the release clause discussed before anything else.', at: NOW - 2 * DAY, actor: ROLE_AGENT }] }),
  demoTx({ type: 'transfer', status: 'COMPLIANCE_PENDING', playerId: 'pl-carvalho', engaging: 'org-eastport', releasing: 'org-harbour',
    pendingReason: 'CONSENT_REQUIRED', consents: [{ partyRole: 'individual', status: 'granted' }, { partyRole: 'engaging_entity', status: 'requested' }],
    documents: [demoDoc(3, 'Mandate (working copy)', 'AGENT_PRIVATE', 'mandate', 'agent', ROLE_AGENT)] }),
  demoTx({ type: 'loan', status: 'COMPLIANCE_PENDING', playerId: 'pl-okafor', engaging: 'org-harbour', releasing: 'org-eastport', pendingReason: 'MANUAL_REVIEW' }),
  demoTx({ type: 'other_services', status: 'COMPLIANCE_BLOCKED', playerId: 'pl-adeyemi', engaging: 'org-harbour', blocked: true, pendingReason: null }),
  demoTx({ type: 'employment_contract', status: 'ON_HOLD', playerId: 'pl-carvalho', engaging: 'org-harbour', clear: true, stale: 'INPUTS_CHANGED', hold: 'awaiting_party_decision',
    notes: [{ id: 'txn-d2', visibility: 'PLAYER_AGENT_SHARED', text: 'Agreed with the client to pause until the window reopens.', at: NOW - DAY, actor: ROLE_AGENT }] }),
  demoTx({ type: 'transfer', status: 'CANCELLED', playerId: 'pl-okafor', engaging: 'org-eastport', releasing: 'org-harbour', cancelReason: 'window_closed' }),
];
const txList = (): TransactionList => ({
  items: structuredClone(TXS), statuses: [...TRANSACTION_STATUSES_DEMO], types: ['employment_contract', 'transfer', 'loan', 'other_services'],
  partyRoles: ['individual', 'engaging_entity', 'releasing_entity'],
  documentTypes: ['representation_agreement_reference', 'compliance_consent_reference', 'guardian_evidence', 'mandate', 'term_sheet_draft', 'employment_contract_draft', 'club_document', 'regulatory_evidence', 'correspondence_attachment'],
  visibilities: ['AGENT_PRIVATE', 'PLAYER_PRIVATE', 'ENGAGING_CLUB_PRIVATE', 'RELEASING_CLUB_PRIVATE', 'PLAYER_AGENT_SHARED', 'ENGAGING_AGENT_SHARED', 'RELEASING_AGENT_SHARED', 'ALL_TRANSACTION_PARTIES', 'T_AND_S_ONLY'],
  roomRoles: ['representing_agent', 'party_individual', 'party_guardian', 'party_club_signatory', 'party_club_member', 'agency_admin_observer', 'trust_safety'],
  holdReasonCodes: ['awaiting_party_decision', 'awaiting_document', 'awaiting_regulatory_answer', 'window_closed', 'party_request', 'other'],
  cancelReasonCodes: ['party_withdrew', 'terms_not_agreed', 'window_closed', 'compliance_not_cleared', 'duplicate', 'other'],
  closeReasonCodes: ['process_concluded', 'proceeded_outside_scoutbox', 'superseded', 'other'],
  transitions: TRANSACTION_STATUSES_DEMO.map((from) => ({ from, byActor: [], byCompliance: [] })),
  pendingReasons: ['CONSENT_REQUIRED', 'MANUAL_REVIEW', 'INSUFFICIENT_DATA', 'PROVIDER_UNAVAILABLE', 'JURISDICTION_UNSUPPORTED', 'FACET_NOT_VERIFIED', 'PARTIES_NOT_CONFIRMED', 'REPRESENTATION_MISSING'],
  counts: {
    live: TXS.filter((t) => !['CANCELLED', 'CLOSED', 'ARCHIVED'].includes(t.status)).length,
    blocked: TXS.filter((t) => t.status === 'COMPLIANCE_BLOCKED').length,
    pending: TXS.filter((t) => t.status === 'COMPLIANCE_PENDING').length,
    ready: TXS.filter((t) => t.status === 'READY').length,
    awaitingConfirmation: TXS.filter((t) => !t.partiesConfirmed).length,
  },
  honest: HONEST_TX,
});
const TRANSACTION_STATUSES_DEMO: TransactionStatus[] = ['DRAFT', 'PARTIES_CONFIRMED', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED', 'READY', 'ACTIVE', 'ON_HOLD', 'CANCELLED', 'CLOSED', 'ARCHIVED'];
const findTx = (id: string) => {
  const tx = TXS.find((t) => t.id === id);
  if (!tx) refuse(404, 'TRANSACTION_NOT_FOUND', 'No transaction with that reference is available to you.');
  return tx as Transaction;
};
const txHist = (tx: Transaction, action: string, detail: Record<string, unknown> | null = null, actor = ROLE_AGENT) => {
  (TX_TIMELINE[tx.id] ??= []).unshift({ id: id('aud'), at: Date.now(), action, audience: 'all_parties', actor, detail });
  tx.updatedAt = Date.now(); tx.rev += 1; tx.revAt = Date.now(); tx.revBy = actor.label;
};
const TX_TIMELINE: Record<string, TxTimelineEntry[]> = {};
for (const tx of TXS) {
  TX_TIMELINE[tx.id] = [
    { id: `aud-${tx.id}-3`, at: tx.updatedAt, action: 'transaction_compliance_evaluated', audience: 'all_parties', actor: { kind: 'system', label: 'ScoutBox' }, detail: { outcome: tx.compliance.outcome, pendingReason: tx.compliance.pendingReason } },
    { id: `aud-${tx.id}-2`, at: tx.createdAt + DAY, action: 'transaction_party_confirmed', audience: 'all_parties', actor: ROLE_PLAYER, detail: { partyRole: 'individual' } },
    { id: `aud-${tx.id}-1`, at: tx.createdAt, action: 'transaction_created', audience: 'all_parties', actor: ROLE_AGENT, detail: { count: tx.parties.length } },
  ];
}

// ============================================ M23 P5.6E cross-app integration
// Synthetic, and deliberately partial: rep-d1's client has said yes to contact
// routing and trial visibility, rep-d2's has not. A demo that showed everything
// open would teach the wrong mental model about whose choice this is.
const P56E_DISCLOSED = new Set(['rep-d1']);
const ROUTED_CONTACTS: Record<string, RoutedContact[]> = {
  'rep-d1': [{
    id: 'rct-d1', club: { id: 'org-eastport', name: 'Eastport FC' }, status: 'responded', channel: 'in_app',
    subject: 'A conversation about next season',
    body: 'We have followed your season closely and would like to talk about what next season could look like. Your representative is copied here.',
    routedAt: NOW - 5 * DAY, routedMode: 'both', deliveredAt: NOW - 5 * DAY, respondedAt: NOW - 4 * DAY, responseKind: 'accepted',
  }],
};
const CLIENT_TRIALS: Record<string, ClientTrial[]> = {
  'rep-d1': [{
    id: 'trl-d1', club: { id: 'org-eastport', name: 'Eastport FC' },
    workflowState: 'scheduled', workflowLabel: 'Scheduled', legacy: false, acceptedAt: NOW - 3 * DAY,
    schedule: {
      timezone: 'Europe/London', revision: 1, confirmedAt: NOW - 3 * DAY,
      sessions: [{ id: 'tses-d1', kind: 'training', startsAt: NOW + 4 * DAY, endsAt: NOW + 4 * DAY + 2 * 3600_000, venue: { name: 'Eastport Dome', town: 'Eastport' }, attendance: { state: 'not_recorded' } }],
    },
    awaitingClientConfirmation: false, completion: null, reportObligation: null,
  }],
};
const SHARES: Record<string, OpportunityShare[]> = { 'rep-d1': [], 'rep-d2': [] };
const HANDOFFS: TransactionHandoff[] = [{
  handoffId: 'hof-d1', recruitmentCaseId: 'case-d1', clientId: 'pl-adeyemi', agreementId: 'rep-d1',
  club: { id: 'org-eastport', name: 'Eastport FC' }, invitedAt: NOW - 2 * DAY, expiresAt: NOW + 28 * DAY,
}];

export const demoAgent: AgentApi = {
  async me(s) {
    const u = userOf(s); const a = affOf(s);
    const me: Me = { user: { id: u.id, name: u.name, role: u.role }, org: { id: ORG.id, name: ORG.name, type: 'agency', verified: false, plan: 'Agency' }, affiliation: { id: a.id, tiers: a.tiers, startedAt: a.startedAt, rev: a.rev }, capabilities: Object.keys(PERMISSIONS).filter((c) => can(a.tiers, c)), profile: profileView(PROFILES.find((p) => p.userId === u.id)), platform: { testVerificationProvider: true }, policyVersion: 1 };
    return delay(me);
  },
  async home(s) {
    const a = affOf(s);
    const p = PROFILES.find((x) => x.userId === s.userId);
    const mine = RELS.filter((r) => r.agentUserId === s.userId);
    const counts = { active: 0, pending: 0, expiringSoon: 0, disputed: 0, expired: 0 };
    const alerts: Home['alerts'] = [];
    for (const r of mine) {
      const st = eff(r);
      if (st === 'active') { counts.active += 1; if (r.endAt !== null && r.endAt - Date.now() <= 30 * DAY) { counts.expiringSoon += 1; alerts.push({ kind: 'expiring', agreementId: r.id, endAt: r.endAt }); } }
      else if (st === 'proposed') counts.pending += 1;
      else if (st === 'disputed') { counts.disputed += 1; alerts.push({ kind: 'disputed', agreementId: r.id }); }
      else if (st === 'expired') counts.expired += 1;
    }
    const fifa = p ? effState(p.facets.fifa_licence) : 'UNVERIFIED';
    if (fifa !== 'VERIFIED') alerts.push({ kind: 'verification', facet: 'fifa_licence', state: fifa });
    const home: Home = { profileState: fifa, hasProfile: !!p, tiers: a.tiers, counts, alerts, unreadNotifications: (NOTES[s.userId] ?? []).filter((n) => !n.read).length, regulatoryNotice: 'ScoutBox is infrastructure. It performs no football-agent services, adjudicates no conflicts and confirms no regulatory status. Relationship records here are confirmed by the client, not by ScoutBox.' };
    return delay(home);
  },
  async getProfile(s) { affOf(s); return delay({ profile: profileView(PROFILES.find((p) => p.userId === s.userId)), states: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'], facets: ['fifa_licence', 'national_registration', 'domestic_authorisation', 'minors_authorisation'], jurisdictions: ['INT', 'ENG', 'USA'] }); },
  async saveProfile(s, input) {
    need(s, 'profile.write.own');
    let p = PROFILES.find((x) => x.userId === s.userId);
    if (!p) {
      p = { userId: s.userId, displayName: input.displayName?.trim() || userOf(s).name, declared: { fifaLicenceNumber: input.fifaLicenceNumber?.trim() || null, jurisdictions: input.jurisdictions ?? [] }, facets: { fifa_licence: facet('UNVERIFIED'), national_registration: {}, domestic_authorisation: {}, minors_authorisation: {} }, rev: 1, revAt: Date.now(), createdAt: Date.now(), history: [{ id: id('h'), at: Date.now(), action: 'agent_profile_created', detail: null }] };
      PROFILES.push(p);
    } else {
      if (input.expectedRev !== undefined && input.expectedRev !== p.rev) refuse(409, 'REPRESENTATION_VERSION_CONFLICT', 'Someone else changed this while you were working on it.');
      if (input.displayName !== undefined && input.displayName.trim()) p.displayName = input.displayName.trim();
      if (input.jurisdictions !== undefined) p.declared.jurisdictions = input.jurisdictions.filter((j) => ['INT', 'ENG', 'USA'].includes(j));
      if (input.fifaLicenceNumber !== undefined && (input.fifaLicenceNumber.trim() || null) !== p.declared.fifaLicenceNumber) {
        p.declared.fifaLicenceNumber = input.fifaLicenceNumber.trim() || null;
        if (p.facets.fifa_licence?.state === 'VERIFIED' && p.facets.fifa_licence.reference !== p.declared.fifaLicenceNumber) {
          p.facets.fifa_licence = { ...p.facets.fifa_licence, state: 'UNVERIFIED', storedState: 'UNVERIFIED', note: 'The declared licence number changed; re-submit for verification.' };
          p.history.push({ id: id('h'), at: Date.now(), action: 'agent_verification_state_changed', detail: { facet: 'fifa_licence', state: 'UNVERIFIED' } });
        }
      }
      p.rev += 1; p.revAt = Date.now();
      p.history.push({ id: id('h'), at: Date.now(), action: 'agent_profile_updated', detail: null });
    }
    return delay({ profile: profileView(p)! });
  },
  async submitFacet(s, f, input) {
    need(s, 'verification.submit');
    const p = PROFILES.find((x) => x.userId === s.userId);
    if (!p) refuse(403, 'AGENT_PROFILE_REQUIRED', 'Create your agent profile first.');
    const ref = input.reference.trim();
    if (!ref) refuse(400, 'AGENT_INPUT_INVALID', 'A reference is required.');
    const ma = f === 'fifa_licence' ? null : String(input.memberAssociation ?? '').toUpperCase();
    if (f !== 'fifa_licence' && !['ENG', 'USA'].includes(ma ?? '')) refuse(400, 'AGENT_JURISDICTION_INVALID', 'A national facet needs a member association (ENG or USA).');
    const at = Date.now();
    const next: FacetView = /^TEST-VERIFIED-/i.test(ref)
      ? facet('VERIFIED', { reference: ref, memberAssociation: ma, provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at }, submittedAt: at, verifiedAt: at, recheckAt: at + 30 * DAY, note: 'Verified by the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.' })
      : /^TEST-INACTIVE-/i.test(ref)
        ? facet('INACTIVE', { reference: ref, memberAssociation: ma, provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at }, submittedAt: at, note: 'Reported inactive by the LOCAL SYNTHETIC test provider.' })
        : facet('MANUAL_REVIEW_REQUIRED', { reference: ref, memberAssociation: ma, provenance: { provider: 'none', kind: 'none', at }, submittedAt: at, note: `No ${f === 'fifa_licence' ? 'FIFA' : 'national'} register integration exists in this build, and attributed Trust & Safety review of agent licences is not yet available (P5.6A gate G-C0). A submitted reference is a declaration, not a verification.` });
    const bucket = f === 'national_registration' ? 'national_registration' : f === 'domestic_authorisation' ? 'domestic_authorisation' : 'minors_authorisation';
    const prev = f === 'fifa_licence' ? p!.facets.fifa_licence : p!.facets[bucket][ma!];
    if (f === 'fifa_licence') p!.facets.fifa_licence = next; else p!.facets[bucket][ma!] = next;
    if ((prev?.state ?? 'UNVERIFIED') !== next.state) p!.history.push({ id: id('h'), at, action: 'agent_verification_state_changed', detail: { facet: f, memberAssociation: ma, from: prev?.state ?? 'UNVERIFIED', to: next.state } });
    p!.rev += 1; p!.revAt = at;
    return delay({ profile: profileView(p)!, facet: next, provider: 'local-synthetic-test-provider' });
  },
  async agency(s) {
    affOf(s);
    const active = AFFS.filter((a) => a.endedAt === null);
    const o: AgencyOverview = { org: { id: ORG.id, name: ORG.name, type: 'agency', verified: false, plan: 'Agency' }, settings: SETTINGS, members: { active: active.length, admins: active.filter((a) => a.tiers.includes('agency_admin')).length, licensedAgents: active.filter((a) => a.tiers.includes('licensed_agent')).length }, relationships: { active: RELS.filter((r) => eff(r) === 'active').length, pending: RELS.filter((r) => eff(r) === 'proposed').length, legacy: RELS.filter((r) => r.legacy).length }, tiers: ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'], permissions: PERMISSIONS, honest: 'An agency organisation holds no football-agent licence. Roles here decide what a member may do in ScoutBox, never whether they may perform football-agent services.' };
    return delay(o);
  },
  async team(s) { need(s, 'agency.team.read'); return delay({ members: AFFS.map(memberRow).sort((x, y) => (x.active === y.active ? x.startedAt - y.startedAt : x.active ? -1 : 1)), tiers: ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'] as Tier[] }); },
  async addMember(s, input) {
    need(s, 'agency.team.write');
    const name = input.name.trim(); if (!name) refuse(400, 'AGENT_INPUT_INVALID', 'A name is required.');
    if (!input.tiers.length) refuse(400, 'AGENT_TIERS_INVALID', 'Pick at least one role.');
    let u = USERS.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!u) { u = { id: id('usr'), name, role: input.role?.trim() || 'Agency staff' }; USERS.push(u); NOTES[u.id] = []; }
    if (AFFS.some((a) => a.userId === u!.id && a.endedAt === null)) refuse(409, 'MEMBER_ALREADY_AFFILIATED', 'That person is already a member.');
    const a: Aff = { id: id('aff'), userId: u.id, tiers: input.tiers, startedAt: Date.now(), endedAt: null, endedReason: null, rev: 1, revAt: Date.now() };
    AFFS.push(a);
    AUDIT.unshift({ id: id('a'), at: Date.now(), action: 'agency_affiliation_created', domain: 'agency', actor: { userId: s.userId, name: userOf(s).name }, target: { type: 'agency_affiliation', id: a.id, userId: u.id }, detail: { tiers: input.tiers } });
    return delay({ member: memberRow(a) });
  },
  async setTiers(s, userId, tiers, expectedRev) {
    need(s, 'agency.team.write');
    const a = AFFS.find((x) => x.userId === userId && x.endedAt === null); if (!a) refuse(404, 'MEMBER_NOT_FOUND', 'No such member.');
    if (!tiers.length) refuse(400, 'AGENT_TIERS_INVALID', 'Pick at least one role.');
    const admins = AFFS.filter((x) => x.endedAt === null && x.tiers.includes('agency_admin'));
    if (a!.userId === s.userId && tiers.includes('agency_admin') && !a!.tiers.includes('agency_admin')) refuse(403, 'SELF_PROMOTION_BLOCKED', 'You cannot grant yourself the administrator role.');
    if (a!.tiers.includes('agency_admin') && !tiers.includes('agency_admin') && admins.length <= 1) refuse(409, 'LAST_ADMIN', 'An agency must keep at least one administrator.');
    if (expectedRev !== a!.rev) { const e = new DemoError(409, 'AFFILIATION_VERSION_CONFLICT', 'Someone else changed this while you were working on it.'); e.details = { currentRev: a!.rev, updatedBy: null, updatedAt: a!.revAt }; throw e; }
    a!.tiers = tiers; a!.rev += 1; a!.revAt = Date.now();
    return delay({ member: memberRow(a!) });
  },
  async endMember(s, userId, expectedRev, reason) {
    need(s, 'agency.team.write');
    const a = AFFS.find((x) => x.userId === userId && x.endedAt === null); if (!a) refuse(404, 'MEMBER_NOT_FOUND', 'No such member.');
    const admins = AFFS.filter((x) => x.endedAt === null && x.tiers.includes('agency_admin'));
    if (a!.tiers.includes('agency_admin') && admins.length <= 1) refuse(409, 'LAST_ADMIN', 'An agency must keep at least one administrator.');
    if (expectedRev !== a!.rev) refuse(409, 'AFFILIATION_VERSION_CONFLICT', 'Someone else changed this while you were working on it.');
    a!.endedAt = Date.now(); a!.endedReason = reason ?? 'left'; a!.rev += 1; a!.revAt = Date.now();
    AUDIT.unshift({ id: id('a'), at: Date.now(), action: 'agency_affiliation_ended', domain: 'agency', actor: { userId: s.userId, name: userOf(s).name }, target: { type: 'agency_affiliation', id: a!.id, userId }, detail: { reasonCode: a!.endedReason } });
    return delay({ member: memberRow(a!) });
  },
  async saveSettings(s, input) {
    need(s, 'agency.settings.write');
    if (input.jurisdictions !== undefined) { if (input.jurisdictions.some((j) => !['INT', 'ENG', 'USA'].includes(j))) refuse(400, 'AGENT_JURISDICTION_INVALID', 'Unknown member association.'); SETTINGS = { ...SETTINGS, jurisdictions: [...new Set(input.jurisdictions)] }; }
    if (input.description !== undefined) SETTINGS = { ...SETTINGS, description: input.description.slice(0, 300) };
    return delay({ settings: SETTINGS });
  },
  async compliance(s) {
    need(s, 'agency.compliance.read');
    const rows: ComplianceRow[] = AFFS.filter((a) => a.endedAt === null && a.tiers.includes('licensed_agent')).map((a) => { const v = profileView(PROFILES.find((p) => p.userId === a.userId)); return { userId: a.userId, name: USERS.find((u) => u.id === a.userId)?.name ?? null, hasProfile: !!v, fifaLicence: v?.regulatoryState.fifaLicence ?? 'UNVERIFIED', jurisdictions: v?.regulatoryState.jurisdictions ?? [] }; });
    return delay({ agents: rows, informational: true, honest: 'Informational only. Nothing here verifies, approves or overrides a regulatory state; attributed Trust & Safety review of agent licences is a P5.6C prerequisite (G-C0).' });
  },
  async audit(s, cursor) {
    need(s, 'agency.audit.read');
    let start = 0;
    if (cursor) { const i = AUDIT.findIndex((r) => r.id === cursor); if (i < 0) refuse(400, 'AUDIT_CURSOR_INVALID', 'That page no longer exists.'); start = i + 1; }
    const page = AUDIT.slice(start, start + 25);
    return delay({ items: page, nextCursor: start + 25 < AUDIT.length ? page[page.length - 1].id : null, total: AUDIT.length });
  },
  async lookup(s, q) {
    need(s, 'players.lookup');
    const qq = q.trim().toLowerCase();
    if (qq.length < 2) return delay({ items: [], note: 'Type at least two characters.' });
    return delay({ items: PLAYERS.filter((p) => !p.blocked && p.name.toLowerCase().includes(qq)).slice(0, 20).map(({ id: pid, name, position, age, club, country }) => ({ id: pid, name, position, age, club, country })), adultsOnly: true });
  },
  async clients(s) {
    const a = affOf(s);
    const rows: ClientRow[] = [];
    for (const r of RELS) {
      if (r.agentUserId === s.userId && can(a.tiers, 'clients.read.own')) rows.push(forAgent(r, s.userId) as ClientRow);
      else if (can(a.tiers, 'clients.read.shared_summary') && (r.shareWithAgencyStaff || r.legacy)) rows.push(summary(r));
    }
    rows.sort((x, y) => ((y as Relationship).proposedAt ?? y.startAt ?? 0) - ((x as Relationship).proposedAt ?? x.startAt ?? 0));
    return delay({ items: rows, scopes: ['employment', 'transfer', 'commercial', 'other_services'], maxTermMonths: 24, jurisdictions: ['INT', 'ENG', 'USA'] });
  },
  async requestClient(s, input) {
    need(s, 'clients.request');
    if (input.termMonths < 1 || input.termMonths > 24 || !Number.isInteger(input.termMonths)) refuse(400, 'AGENT_TERM_INVALID', 'termMonths must be a whole number from 1 to 24.');
    const g = gap(PROFILES.find((p) => p.userId === s.userId), input.jurisdiction);
    if (g) refuse(403, g.error, g.message);
    const p = PLAYERS.find((x) => x.id === input.playerId);
    if (!p || p.blocked) refuse(404, 'PLAYER_NOT_FOUND', 'Player not found.');
    const existing = RELS.find((r) => r.agentUserId === s.userId && r.clientId === input.playerId && ['proposed', 'active', 'disputed'].includes(eff(r)));
    if (existing) refuse(409, 'REPRESENTATION_ALREADY_EXISTS', 'A relationship with this player already exists or is pending.');
    const cooled = RELS.find((r) => r.agentUserId === s.userId && r.clientId === input.playerId && ['declined', 'terminated_by_client', 'terminated_by_agent', 'expired'].includes(eff(r)) && Date.now() - (r.declinedAt ?? r.terminatedAt ?? r.endAt ?? 0) < 30 * DAY);
    if (cooled) refuse(429, 'REPRESENTATION_COOLDOWN', 'A recent request to this player was declined or ended; wait before asking again.');
    const r = rel({ id: id('rep'), clientId: input.playerId, status: 'proposed', agentUserId: s.userId, scope: input.scope.length ? input.scope : ['employment'], exclusive: input.exclusive, jurisdiction: input.jurisdiction, termMonths: input.termMonths, proposedAt: Date.now(), revAt: Date.now(), history: [{ id: id('h'), at: Date.now(), action: 'representation_requested', byKind: 'org', byName: userOf(s).name, detail: { scope: input.scope, termMonths: input.termMonths, jurisdiction: input.jurisdiction } }] });
    RELS.unshift(r);
    AUDIT.unshift({ id: id('a'), at: Date.now(), action: 'representation_requested', domain: 'representation', actor: { userId: s.userId, name: userOf(s).name }, target: { type: 'representation', id: r.id, agentUserId: s.userId, playerId: p!.id, playerName: p!.name }, detail: { scope: r.scope, termMonths: r.termMonths } });
    // The demo's simulated counterparty: Kwame Osei confirms after a moment so the journey can be seen end to end; everyone else waits for the player app.
    if (p!.id === 'pl-osei') window.setTimeout(() => { r.status = 'active'; r.storedStatus = 'active'; r.confirmedAt = Date.now(); r.startAt = Date.now(); r.endAt = Date.now() + r.termMonths! * 30 * DAY; r.rev += 1; r.revAt = Date.now(); r.history.push({ id: id('h'), at: Date.now(), action: 'representation_confirmed', byKind: 'player', byName: p!.name, detail: { from: 'proposed', to: 'active' } }); (NOTES[s.userId] ??= []).unshift({ id: id('n'), ts: Date.now(), type: 'representation_confirmed', text: 'A client confirmed your representation relationship. It is active from now until its end date.', refId: r.id, read: false }); }, 4000);
    return delay({ relationship: forAgent(r, s.userId) });
  },
  async client(s, cid) {
    const a = affOf(s);
    const r = RELS.find((x) => x.id === cid);
    if (!r) refuse(404, 'REPRESENTATION_NOT_FOUND', 'Not found.');
    if (r!.agentUserId === s.userId && can(a.tiers, 'clients.read.own')) return delay({ relationship: forAgent(r!, s.userId), client: identity(r!, s.userId), access: grants(r!, s.userId), mode: 'own' as const });
    if (can(a.tiers, 'clients.read.shared_summary') && (r!.shareWithAgencyStaff || r!.legacy)) return delay({ relationship: summary(r!), mode: 'summary' as const });
    return refuse(404, 'REPRESENTATION_NOT_FOUND', 'Not found.');
  },
  async terminate(s, cid, input) {
    need(s, 'clients.terminate');
    const r = RELS.find((x) => x.id === cid && x.agentUserId === s.userId);
    if (!r) refuse(404, 'REPRESENTATION_NOT_FOUND', 'Not found.');
    const st = eff(r!);
    if (st !== 'proposed' && st !== 'active') refuse(409, 'REPRESENTATION_NOT_ACTIVE', 'This relationship is not in a state that allows that.');
    if (input.expectedRev !== r!.rev) refuse(409, 'REPRESENTATION_VERSION_CONFLICT', 'Someone else changed this while you were working on it.');
    r!.status = 'terminated_by_agent'; r!.storedStatus = 'terminated_by_agent'; r!.terminatedAt = Date.now(); r!.terminatedBy = 'agent'; r!.terminationReasonCode = input.reasonCode ?? 'agent_ended'; r!.rev += 1; r!.revAt = Date.now();
    r!.history.push({ id: id('h'), at: Date.now(), action: 'representation_terminated', byKind: 'org', byName: userOf(s).name, detail: { by: 'agent', phase: st, reasonCode: r!.terminationReasonCode } });
    return delay({ relationship: forAgent(r!, s.userId) });
  },
  async clientOpportunities(s, cid) {
    need(s, 'clients.opportunities.read');
    const r = RELS.find((x) => x.id === cid && x.agentUserId === s.userId);
    if (!r) refuse(404, 'REPRESENTATION_NOT_FOUND', 'Not found.');
    if (!grants(r!, s.userId)) refuse(409, 'REPRESENTATION_NOT_ACTIVE', 'Opportunities open only through an active, client-confirmed relationship.');
    return delay({ items: BOARD[r!.clientId] ?? [], clientId: r!.clientId, note: 'The client\'s own board, read through the same mutual-visibility and eligibility rules the player sees. Applying is the player\'s act.' });
  },
  async opportunities(s) {
    need(s, 'clients.opportunities.read');
    const items: Opportunity[] = [];
    for (const r of RELS) if (grants(r, s.userId)) for (const o of BOARD[r.clientId] ?? []) items.push({ ...o, clientId: r.clientId, clientName: PLAYERS.find((p) => p.id === r.clientId)?.name, agreementId: r.id });
    items.sort((x, y) => String(x.deadline).localeCompare(String(y.deadline)));
    return delay({ items, note: 'Only opportunities legitimately visible to a confirmed client appear here. Club-private recruitment cases never do.' });
  },
  // ---- M23 P5.6C compliance
  async complianceOverview(s) {
    need(s, 'compliance.read');
    const p = PROFILES.find((x) => x.userId === s.userId);
    const mine = CTXS.filter(() => true).map(ctxView);
    const overview: ComplianceOverview = {
      provider: PROVIDER_STATUS,
      facets: p ? {
        fifa_licence: effState(p.facets.fifa_licence),
        national_registration: Object.fromEntries(Object.entries(p.facets.national_registration).map(([k, f]) => [k, effState(f)])),
        domestic_authorisation: Object.fromEntries(Object.entries(p.facets.domestic_authorisation).map(([k, f]) => [k, effState(f)])),
        minors_authorisation: Object.fromEntries(Object.entries(p.facets.minors_authorisation).map(([k, f]) => [k, effState(f)])),
      } : null,
      freshness: freshnessOf(p),
      policies: { inEffect: DEMO_POLICIES.map(({ id: pid, regulator, jurisdiction, effectiveFrom }) => ({ id: pid, regulator, jurisdiction, effectiveFrom })), missing: [] },
      reviews: structuredClone(REVIEWS), contexts: mine, consents: structuredClone(CONSENTS),
      minorReadiness: MINOR_READINESS,
      counts: {
        reviewsPending: REVIEWS.filter((r) => r.status === 'PENDING' || r.status === 'IN_REVIEW').length,
        contextsOpen: CTXS.filter((c) => c.status === 'open').length,
        consentsOutstanding: CONSENTS.filter((k) => k.status === 'requested').length,
        staleFacets: freshnessOf(p).filter((f) => f.state === 'STALE').length,
      },
      honest: COMPLIANCE_HONEST,
    };
    return delay(overview);
  },
  async compliancePolicies(s) {
    affOf(s);
    return delay({ inEffect: structuredClone(DEMO_POLICIES), missing: [], ruleStatuses: ['ACTIVE', 'SUSPENDED', 'PARTIALLY_SUSPENDED', 'JURISDICTION_OVERRIDE', 'PENDING_IMPLEMENTATION', 'UNDER_LEGAL_REVIEW', 'UNKNOWN'], honest: 'These are ScoutBox\u2019s encoded platform rules with their operative status as recorded on the retrieval date. They are not legal advice and a status can change without a deploy.' });
  },
  async recheckFacet(s, facet, memberAssociation) {
    need(s, 'compliance.contexts.write');
    const p = PROFILES.find((x) => x.userId === s.userId);
    if (!p) refuse(403, 'AGENT_VERIFICATION_REQUIRED', 'Create your agent profile first.');
    const bucket = facet === 'national_registration' ? 'national_registration' : facet === 'domestic_authorisation' ? 'domestic_authorisation' : 'minors_authorisation';
    const cur = facet === 'fifa_licence' ? p!.facets.fifa_licence : p!.facets[bucket][memberAssociation ?? 'ENG'];
    if (!cur) refuse(404, 'AGENT_FACET_NOT_FOUND', 'Nothing has been submitted for that facet.');
    const at = Date.now();
    const next: FacetView = { ...cur!, state: cur!.state, recheckAt: at + 30 * DAY, provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at }, note: 'Re-checked against the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.' };
    if (facet === 'fifa_licence') p!.facets.fifa_licence = next; else p!.facets[bucket][memberAssociation ?? 'ENG'] = next;
    p!.rev += 1; p!.revAt = at;
    return delay({ facet: next, provider: PROVIDER_STATUS });
  },
  async contexts(s) {
    need(s, 'compliance.read');
    return delay({ items: CTXS.map(ctxView), types: ['employment_contract', 'transfer', 'loan', 'other_services'], partyRoles: ['individual', 'engaging_entity', 'releasing_entity'] });
  },
  async createContext(s, input) {
    need(s, 'compliance.contexts.write');
    const g = gap(PROFILES.find((x) => x.userId === s.userId), input.jurisdictions.find((j) => j !== 'INT') ?? 'INT');
    if (g) refuse(403, g.error, g.message);
    const hit = CTXS.find((c) => c.history.some((h) => h.detail?.clientKey === input.clientKey));
    if (hit) return delay({ context: ctxView(hit), idempotent: true });
    const parties: ComplianceContext['parties'] = [];
    for (const raw of input.parties) {
      if (raw.subjectKind === 'player') {
        const pl = PLAYERS.find((x) => x.id === raw.subjectId);
        const rel = RELS.find((r) => r.clientId === raw.subjectId && r.agentUserId === s.userId && eff(r) === 'active');
        if (!pl || pl.blocked || !rel) refuse(404, 'PARTY_NOT_FOUND', 'That party is not available to you.');
        parties.push({ id: id('cpt'), partyRole: raw.partyRole, subjectKind: 'player', subjectId: pl!.id, name: pl!.name, removed: false });
      } else {
        const club = DEMO_CLUBS.find((c) => c.id === raw.subjectId);
        if (!club) refuse(404, 'PARTY_NOT_FOUND', 'That party is not available to you.');
        parties.push({ id: id('cpt'), partyRole: raw.partyRole, subjectKind: 'club', subjectId: club!.id, name: club!.name, removed: false });
      }
    }
    const c: DemoCtx = { id: id('ctx'), type: input.type, status: 'open', jurisdictions: input.jurisdictions, parties, representations: [], clearance: null, reEvaluationPending: false, evaluations: 0, openedAt: Date.now(), closedAt: null, rev: 1, revAt: Date.now(), history: [] };
    cxHist(c, 'compliance_context_opened', { type: input.type, clientKey: input.clientKey });
    CTXS.unshift(c);
    const evaluation = reEvaluate(c);
    return delay({ context: ctxView(c), evaluation });
  },
  async context(s, cid) {
    need(s, 'compliance.read');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    return delay({ context: ctxView(c!) });
  },
  async evaluateContext(s, cid) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    const evaluation = reEvaluate(c!);
    c!.rev += 1; c!.revAt = Date.now();
    return delay({ context: ctxView(c!), evaluation });
  },
  async addParty(s, cid, input) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    if (c!.status !== 'open') refuse(409, 'CONTEXT_CLOSED', 'This context is closed.');
    if (c!.parties.some((p) => p.partyRole === input.partyRole && !p.removed)) refuse(409, 'CONTEXT_PARTY_EXISTS', `A ${input.partyRole} party is already named.`);
    const club = input.subjectKind === 'club' ? DEMO_CLUBS.find((x) => x.id === input.subjectId) : null;
    const pl = input.subjectKind === 'player' ? PLAYERS.find((x) => x.id === input.subjectId) : null;
    if (!club && !pl) refuse(404, 'PARTY_NOT_FOUND', 'That party is not available to you.');
    c!.parties.push({ id: id('cpt'), partyRole: input.partyRole, subjectKind: input.subjectKind, subjectId: input.subjectId, name: club?.name ?? pl!.name, removed: false });
    cxHist(c!, 'compliance_context_party_added', { partyRole: input.partyRole });
    const evaluation = reEvaluate(c!);
    c!.rev += 1; c!.revAt = Date.now();
    return delay({ context: ctxView(c!), evaluation });
  },
  async declare(s, cid, input) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    if (c!.status !== 'open') refuse(409, 'CONTEXT_CLOSED', 'This context is closed.');
    const party = c!.parties.find((p) => p.partyRole === input.partyRole && !p.removed);
    if (!party) refuse(404, 'PARTY_NOT_FOUND', 'That party is not available to you.');
    if (c!.representations.some((r) => r.partyRole === input.partyRole && r.status !== 'withdrawn')) refuse(409, 'CONTEXT_PARTY_EXISTS', 'You already represent this party in this context.');
    const declaredOnly = party!.subjectKind === 'club';
    if (!declaredOnly) {
      const rel = RELS.find((r) => r.id === input.agreementId && r.agentUserId === s.userId && r.clientId === party!.subjectId);
      if (!rel) refuse(403, 'REPRESENTATION_REQUIRED', 'A client-confirmed, active relationship with this party is required.');
      if (eff(rel!) !== 'active') refuse(403, 'REPRESENTATION_EXPIRED', 'That relationship is not active.');
    }
    // The verdict is computed with the proposal included; a refusal records nothing.
    const proposed = { id: id('crp'), agentUserId: s.userId, partyRole: input.partyRole, agreementId: declaredOnly ? null : input.agreementId ?? null, status: declaredOnly ? 'pending_review' : 'verified', declaredOnly, reviewId: null as string | null, firstActAt: declaredOnly ? null : Date.now() };
    c!.representations.push(proposed);
    const result = clearanceOf(c!);
    if (result.outcome === 'PROHIBITED_CONFLICT') {
      c!.representations.pop();
      c!.clearance = clearanceOf(c!);
      const e = new DemoError(403, 'REPRESENTATION_CONFLICT', 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.');
      e.details = { error: 'REPRESENTATION_CONFLICT', reasons: result.reasons.filter((r) => r.code === 'PROHIBITED_COMBINATION'), policyVersions: result.policyVersions, outcome: result.outcome };
      throw e;
    }
    if (result.outcome === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED') {
      c!.representations.pop();
      c!.clearance = clearanceOf(c!);
      const e = new DemoError(422, 'CONSENT_REQUIRED', 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.');
      e.details = { error: 'CONSENT_REQUIRED', consentsOutstanding: result.consentsOutstanding, reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: c!.id };
      throw e;
    }
    cxHist(c!, 'compliance_representation_declared', { partyRole: input.partyRole, status: proposed.status });
    if (declaredOnly) {
      const review: ReviewPublic = {
        id: id('rrv'), kind: 'representation_declared', status: 'PENDING', agencyOrgId: ORG.id, agentUserId: s.userId,
        subject: { contextId: c!.id, representationId: proposed.id, partyRole: input.partyRole },
        reasons: [reason('REPRESENTATION_UNVERIFIED', { partyRole: input.partyRole })], policyVersions: DEMO_POLICIES.map((x) => x.id),
        requestedAt: Date.now(), startedAt: null, decidedAt: null, decision: null, startedBy: null, supersedes: null, supersededBy: null,
        snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', evaluatedAt: Date.now(), policyVersions: DEMO_POLICIES.map((x) => x.id) }, rev: 1, revAt: Date.now(),
      };
      proposed.reviewId = review.id;
      REVIEWS.unshift(review);
      cxHist(c!, 'regulatory_review_requested', { kind: 'representation_declared' });
      reEvaluate(c!);
      c!.rev += 1; c!.revAt = Date.now();
      const e = new DemoError(422, 'REGULATORY_REVIEW_REQUIRED', 'Representation of an entity without a ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.');
      e.details = { error: 'REGULATORY_REVIEW_REQUIRED', reviewId: review.id, contextId: c!.id, reasons: review.reasons, policyVersions: review.policyVersions, outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED' };
      throw e;
    }
    const evaluation = reEvaluate(c!);
    c!.rev += 1; c!.revAt = Date.now();
    return delay({ context: ctxView(c!), representation: { id: proposed.id, partyRole: input.partyRole, status: proposed.status }, evaluation });
  },
  async withdraw(s, cid, repId) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    const rep = c!.representations.find((r) => r.id === repId);
    if (!rep) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    rep!.status = 'withdrawn';
    cxHist(c!, 'compliance_representation_withdrawn', { partyRole: rep!.partyRole });
    const evaluation = reEvaluate(c!);
    c!.rev += 1; c!.revAt = Date.now();
    return delay({ context: ctxView(c!), evaluation });
  },
  async closeContext(s, cid) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    if (c!.status === 'closed') return delay({ context: ctxView(c!), idempotent: true });
    c!.status = 'closed'; c!.closedAt = Date.now();
    for (const r of REVIEWS) if (r.subject?.contextId === c!.id && (r.status === 'PENDING' || r.status === 'IN_REVIEW')) { r.status = 'CANCELLED'; r.decidedAt = Date.now(); }
    cxHist(c!, 'compliance_context_closed');
    c!.rev += 1; c!.revAt = Date.now();
    return delay({ context: ctxView(c!) });
  },
  async requestConsent(s, cid, input) {
    need(s, 'compliance.contexts.write');
    const c = CTXS.find((x) => x.id === cid);
    if (!c) refuse(404, 'CONTEXT_NOT_FOUND', 'Not found.');
    const party = c!.parties.find((p) => p.partyRole === input.partyRole && !p.removed);
    if (!party) refuse(404, 'PARTY_NOT_FOUND', 'That party is not available to you.');
    const open = CONSENTS.find((k) => k.contextId === c!.id && k.partyRole === input.partyRole && k.status === 'requested');
    if (open) refuse(409, 'CONSENT_ALREADY_REQUESTED', 'A consent request is already open for that party.');
    const k: AgentConsent = {
      id: id('rcs'), kind: 'dual_representation', status: 'requested', contextId: c!.id, partyRole: input.partyRole, subjectKind: party!.subjectKind,
      requestedAt: Date.now(), grantedAt: null, declinedAt: null, revokedAt: null, policyVersions: DEMO_POLICIES.map((x) => x.id), ruleIds: ['ENG-6.3'],
      particulars: { fullParticularsProvided: input.fullParticularsProvided, legalAdviceOffered: input.legalAdviceOffered, proposedFeeDisclosed: input.proposedFeeDisclosed, acknowledged: null }, rev: 1, revAt: Date.now(),
    };
    CONSENTS.unshift(k);
    cxHist(c!, 'regulatory_consent_requested', { partyRole: input.partyRole });
    // The demo's simulated counterparty answers after a moment so the journey
    // can be seen end to end; in the product the party answers in their own app.
    window.setTimeout(() => {
      if (k.status !== 'requested') return;
      k.status = 'granted'; k.grantedAt = Date.now(); k.rev += 1; k.revAt = Date.now();
      cxHist(c!, 'regulatory_consent_granted', { partyRole: input.partyRole }, party!.subjectKind === 'player' ? 'player' : 'club_user');
      reEvaluate(c!, party!.subjectKind === 'player' ? 'player' : 'club_user');
      (NOTES[s.userId] ??= []).unshift({ id: id('n'), ts: Date.now(), type: 'regulatory_consent_granted', text: 'A party granted written consent to multiple representation for one transaction context. It is specific to that context and can be revoked.', refId: c!.id, read: false });
    }, 5000);
    return delay({ consent: structuredClone(k) });
  },
  async transactions(s, status) {
    need(s, 'transactions.read');
    const l = txList();
    if (status) l.items = l.items.filter((t) => t.status === status);
    return delay(l);
  },
  async createTransaction(s, input) {
    need(s, 'transactions.write');
    const playerName = PLAYERS.find((p) => p.id === input.parties.find((x) => x.partyRole === 'individual')?.subjectId)?.name;
    if (!playerName) refuse(404, 'TRANSACTION_PARTY_NOT_FOUND', 'No such party is available to you.');
    const tx = demoTx({
      type: input.type, status: 'DRAFT', confirmed: false,
      playerId: input.parties.find((x) => x.partyRole === 'individual')!.subjectId,
      engaging: input.parties.find((x) => x.partyRole === 'engaging_entity')?.subjectId ?? 'org-eastport',
      releasing: input.parties.find((x) => x.partyRole === 'releasing_entity')?.subjectId,
      pendingReason: 'PARTIES_NOT_CONFIRMED',
    });
    TXS.unshift(tx);
    TX_TIMELINE[tx.id] = [{ id: id('aud'), at: Date.now(), action: 'transaction_created', audience: 'all_parties', actor: ROLE_AGENT, detail: { count: tx.parties.length } }];
    // The demo's simulated counterparties confirm after a moment so the journey
    // can be seen end to end; in the product each party confirms in its own app.
    window.setTimeout(() => {
      for (const p of tx.parties) p.confirmedAt = Date.now();
      tx.partiesConfirmed = true; tx.awaitingConfirmation = []; tx.status = 'PARTIES_CONFIRMED';
      tx.allowedTransitions = ['CANCELLED'];
      tx.compliance.pendingReason = 'REPRESENTATION_MISSING';
      txHist(tx, 'transaction_party_confirmed', { partyRole: 'engaging_entity' }, ROLE_CLUB);
    }, 4000);
    return delay({ transaction: structuredClone(tx) });
  },
  async transaction(s, tid) { need(s, 'transactions.read'); return delay({ transaction: structuredClone(findTx(tid)) }); },
  async addTxParty(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    if (tx.parties.some((p) => !p.removed && p.partyRole === input.partyRole)) refuse(409, 'TRANSACTION_PARTY_EXISTS', 'A party already holds that role.');
    tx.parties.push({ id: id('txp'), partyRole: input.partyRole, subjectKind: input.subjectKind, subjectId: input.subjectId, name: DEMO_CLUBS.find((c) => c.id === input.subjectId)?.name ?? null, removed: false, removedAt: null, confirmedAt: null, confirmedByKind: null, addedAt: Date.now(), subjectRemovedAt: null });
    tx.partiesConfirmed = false; tx.awaitingConfirmation = [input.partyRole];
    txHist(tx, 'transaction_party_added', { partyRole: input.partyRole });
    return delay({ transaction: structuredClone(tx) });
  },
  async removeTxParty(s, tid, partyId) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    const p = tx.parties.find((x) => x.id === partyId);
    if (!p) refuse(404, 'TRANSACTION_PARTY_NOT_FOUND', 'No such party.');
    p!.removed = true; p!.removedAt = Date.now();
    for (const r of tx.representations) if (r.partyRole === p!.partyRole) { r.status = 'withdrawn'; r.withdrawnAt = Date.now(); }
    tx.partiesConfirmed = false; tx.awaitingConfirmation = [p!.partyRole]; tx.status = 'PARTIES_CONFIRMED';
    tx.compliance.clear = false; tx.compliance.pendingReason = 'PARTIES_NOT_CONFIRMED'; tx.compliance.staleness = 'INPUTS_CHANGED'; tx.compliance.stale = 'INPUTS_CHANGED';
    txHist(tx, 'transaction_party_removed', { partyRole: p!.partyRole });
    return delay({ transaction: structuredClone(tx) });
  },
  async bindRepresentation(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    if (!input.agreementId) refuse(403, 'REPRESENTATION_REQUIRED', 'A client-confirmed, active relationship with this party is required.');
    if (tx.representations.some((r) => r.partyRole === input.partyRole && r.status !== 'withdrawn')) refuse(409, 'TRANSACTION_PARTY_EXISTS', 'You already represent this party in this transaction.');
    tx.representations.push({ id: id('txr'), partyRole: input.partyRole, agentUserId: s.userId, status: 'verified', declaredOnly: false, basis: 'client_confirmed_agreement', scope: ['employment', 'transfer'], jurisdictions: ['ENG'], verifiedAt: Date.now(), withdrawnAt: null, createdAt: Date.now(), agreementId: input.agreementId, reviewId: null, firstActAt: Date.now() });
    tx.compliance.clear = true; tx.compliance.pendingReason = null; tx.compliance.outcome = 'CLEAR'; tx.compliance.staleness = null; tx.compliance.stale = null; tx.compliance.snapshotClear = true;
    tx.status = 'READY'; tx.allowedTransitions = ['ACTIVE', 'ON_HOLD', 'CANCELLED'];
    tx.offerBoundary = { canStartOfferWorkflow: true, blockers: [], honest: HONEST_OFFER };
    txHist(tx, 'transaction_representation_attached', { partyRole: input.partyRole, status: 'verified' });
    return delay({ transaction: structuredClone(tx), representation: { id: tx.representations.at(-1)!.id, partyRole: input.partyRole, status: 'verified' } });
  },
  async unbindRepresentation(s, tid, repId) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    const r = tx.representations.find((x) => x.id === repId);
    if (!r) refuse(404, 'TRANSACTION_NOT_FOUND', 'Not found.');
    r!.status = 'withdrawn'; r!.withdrawnAt = Date.now();
    tx.compliance.clear = false; tx.compliance.pendingReason = 'REPRESENTATION_MISSING';
    tx.status = 'PARTIES_CONFIRMED'; tx.allowedTransitions = ['CANCELLED'];
    txHist(tx, 'transaction_representation_withdrawn', { partyRole: r!.partyRole });
    return delay({ transaction: structuredClone(tx) });
  },
  async evaluateTransaction(s, tid) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    tx.compliance.evaluatedAt = Date.now();
    tx.compliance.staleness = null; tx.compliance.stale = null;
    if (tx.compliance.clear) { tx.status = 'READY'; tx.allowedTransitions = ['ACTIVE', 'ON_HOLD', 'CANCELLED']; tx.offerBoundary = { canStartOfferWorkflow: true, blockers: [], honest: HONEST_OFFER }; }
    txHist(tx, 'transaction_compliance_evaluated', { outcome: tx.compliance.outcome, pendingReason: tx.compliance.pendingReason }, { kind: 'system', label: 'ScoutBox' });
    return delay({ transaction: structuredClone(tx) });
  },
  async setTransactionStatus(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    if (!tx.allowedTransitions.includes(input.to)) refuse(409, 'TRANSACTION_TRANSITION_NOT_ALLOWED', 'That is not a transition this transaction can make from its current state.');
    if (input.to === 'ACTIVE' && tx.compliance.staleness) refuse(422, 'TRANSACTION_COMPLIANCE_STALE', 'The recorded compliance evaluation no longer matches the current facts. Re-evaluate and read the new answer before progressing.');
    if (input.to === 'ACTIVE' && !tx.compliance.clear) refuse(422, 'TRANSACTION_COMPLIANCE_PENDING', 'This transaction cannot progress while compliance is outstanding.');
    const from = tx.status;
    tx.status = input.to;
    tx.allowedTransitions = input.to === 'ACTIVE' ? ['ON_HOLD', 'CLOSED', 'CANCELLED'] : input.to === 'ON_HOLD' ? ['ACTIVE', 'CLOSED', 'CANCELLED'] : input.to === 'CANCELLED' || input.to === 'CLOSED' ? ['ARCHIVED'] : [];
    tx.hold = input.to === 'ON_HOLD' ? { reasonCode: input.reasonCode ?? null, reason: input.reason ?? null, at: Date.now() } : null;
    if (input.to === 'CANCELLED') tx.cancelReasonCode = input.reasonCode ?? null;
    if (input.to === 'CLOSED') tx.closeReasonCode = input.reasonCode ?? null;
    txHist(tx, input.to === 'ON_HOLD' ? 'transaction_held' : input.to === 'CANCELLED' ? 'transaction_cancelled' : input.to === 'CLOSED' ? 'transaction_closed' : input.to === 'ARCHIVED' ? 'transaction_archived' : 'transaction_status_changed', { from, to: input.to });
    return delay({ transaction: structuredClone(tx) });
  },
  async requestTxConsent(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    const k: AgentConsent = {
      id: id('rcs'), kind: 'dual_representation', status: 'requested', contextId: tx.compliance.contextId ?? null, partyRole: input.partyRole,
      subjectKind: input.partyRole === 'individual' ? 'player' : 'club', requestedAt: Date.now(), grantedAt: null, declinedAt: null, revokedAt: null,
      policyVersions: DEMO_POLICIES.map((x) => x.id), ruleIds: ['ENG-6.3'],
      particulars: { fullParticularsProvided: input.fullParticularsProvided, legalAdviceOffered: input.legalAdviceOffered, proposedFeeDisclosed: input.proposedFeeDisclosed, acknowledged: null }, rev: 1, revAt: Date.now(),
    };
    tx.consents.push({ id: k.id, kind: k.kind, partyRole: input.partyRole, status: 'requested', requestedAt: Date.now(), grantedAt: null, declinedAt: null, revokedAt: null, mine: false });
    txHist(tx, 'transaction_consent_requested', { partyRole: input.partyRole });
    return delay({ consent: structuredClone(k) });
  },
  async recordTerms(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    tx.terms.versions.push({ id: id('txt'), at: Date.now(), summary: input.summary, visibility: input.visibility, recordedFor: input.recordedFor, actor: ROLE_AGENT });
    txHist(tx, 'transaction_terms_recorded', { partyRole: input.recordedFor, visibility: input.visibility });
    return delay({ transaction: structuredClone(tx) });
  },
  async txDocuments(s, tid) {
    need(s, 'transactions.read');
    const tx = findTx(tid);
    return delay({ items: structuredClone(tx.documents), documentTypes: txList().documentTypes, uploadable: ['AGENT_PRIVATE', 'PLAYER_AGENT_SHARED', 'ENGAGING_AGENT_SHARED', 'RELEASING_AGENT_SHARED', 'ALL_TRANSACTION_PARTIES'] });
  },
  async addTxDocument(s, tid, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    const d: TxDocument = { id: id('txd'), documentType: input.documentType, visibility: input.visibility, version: 1, label: input.label, ownerKind: 'agent', ownerPartyRole: null, uploadedAt: Date.now(), actor: ROLE_AGENT, expiresAt: input.expiresAt ?? null, expired: false, signedAt: null, supersedes: null, evidence: null, downloadable: false, rev: 1, revAt: Date.now(), revBy: 'Representing agent' };
    tx.documents.unshift(d);
    txHist(tx, 'transaction_document_added', { documentType: input.documentType, visibility: input.visibility });
    return delay({ document: structuredClone(d) });
  },
  async supersedeTxDocument(s, tid, docId, input) {
    need(s, 'transactions.write');
    const tx = findTx(tid);
    const old = tx.documents.find((d) => d.id === docId);
    if (!old) refuse(404, 'DOCUMENT_NOT_FOUND', 'No document with that reference is available to you.');
    const next: TxDocument = { ...structuredClone(old!), id: id('txd'), version: old!.version + 1, label: input.label ?? old!.label, supersedes: old!.id, uploadedAt: Date.now(), rev: 1 };
    tx.documents = tx.documents.filter((d) => d.id !== old!.id);
    tx.documents.unshift(next);
    txHist(tx, 'transaction_document_superseded', { documentType: next.documentType, version: next.version });
    return delay({ document: structuredClone(next) });
  },
  async txDocumentReference(s, tid, docId) {
    need(s, 'transactions.read');
    const tx = findTx(tid);
    const d = tx.documents.find((x) => x.id === docId);
    if (!d) refuse(404, 'DOCUMENT_NOT_FOUND', 'No document with that reference is available to you.');
    return delay({ document: structuredClone(d!), reference: null, note: 'This document is a placeholder: no file has been attached to it in the evidence vault.' });
  },
  async addTxNote(s, tid, input) {
    need(s, 'transactions.read');
    const tx = findTx(tid);
    const n: TxNote = { id: id('txn'), visibility: input.visibility, text: input.text, at: Date.now(), actor: ROLE_AGENT };
    tx.notes.unshift(n);
    txHist(tx, 'transaction_note_added', { visibility: input.visibility });
    return delay({ note: structuredClone(n) });
  },
  async txTimeline(s, tid) {
    need(s, 'transactions.read');
    const tx = findTx(tid);
    return delay({ items: structuredClone(TX_TIMELINE[tx.id] ?? []), note: 'The timeline is what YOU may see of what happened. The platform audit holds more operational detail and is not this.' });
  },
  async txMessages(s, tid) {
    need(s, 'transactions.read');
    const tx = findTx(tid);
    return delay({ items: structuredClone(tx.linkedThreads), note: 'Correspondence lives in the canonical ScoutBox Inbox. A link records that a conversation exists and who shared it; reading it still needs the Inbox\u2019s own authorisation, which transaction membership alone does not give. ScoutBox never negotiates and never replies for anyone.' });
  },
  async clubs(s) {
    affOf(s);
    return delay(structuredClone(DEMO_CLUBS));
  },
  async inbox(s) {
    need(s, 'inbox.read');
    return delay({ notifications: NOTES[s.userId] ?? [], pending: RELS.filter((r) => r.agentUserId === s.userId && eff(r) === 'proposed').map((r) => forAgent(r, s.userId)), note: 'Operational messages only. Negotiation and offers are not part of this workspace.' });
  },

  // ---- M23 P5.6E. Each refuses exactly as the server does when the client has
  // not chosen to share — the refusal is the honest answer, not a gap.
  async clientContacts(s, id) {
    if (!P56E_DISCLOSED.has(id)) refuse(403, 'DISCLOSURE_WITHHELD', 'Your client has not chosen to route you their club messages. That choice is theirs and they can change it at any time in My Agent.');
    return delay({ items: ROUTED_CONTACTS[id] ?? [], clientId: RELS.find((x) => x.id === id)?.clientId ?? id, note: 'Contacts a club routed to you as well as to your client. The club\u2019s own recruitment case, its internal notes and its assessment of your client are not here and never will be. Answering is your client\u2019s act, not yours.' });
  },
  // M23 P6 — only what the client shared; the demo client has shared nothing yet.
  async clientOffers(s, id) {
    void s;
    return delay({
      items: [], clientId: RELS.find((x) => x.id === id)?.clientId ?? id, clientName: null,
      note: 'Only the Offers your client chose to share with you, as the club issued them. Accepting or declining is your client\u2019s own act; ScoutBox does not let you do it on their behalf.',
      honest: 'Nothing here is a negotiation, a fee or a signing. An accepted Offer is not a signed contract.',
    });
  },
  // M23 P8 — the demo client shared nothing, so no club's stage is open to the agent.
  async clientJourney(s, id) {
    void s;
    return delay({ relationshipId: id, clientId: RELS.find((x) => x.id === id)?.clientId ?? id, grants: [] as string[], items: [], generatedAt: Date.now() });
  },
  // M23 P7 — the signing rides on the shared Offer; the demo client has shared nothing, so there is nothing to show.
  async clientSignings(s, id) {
    void s;
    return delay({ items: [], clientId: RELS.find((x) => x.id === id)?.clientId ?? id, clientName: null, honest: 'Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client.' });
  },
  async clientTrials(s, id) {
    if (!P56E_DISCLOSED.has(id)) refuse(403, 'DISCLOSURE_WITHHELD', 'Your client has not chosen to share their trial schedule with you. That choice is theirs and they can change it at any time in My Agent.');
    return delay({
      items: CLIENT_TRIALS[id] ?? [], clientId: RELS.find((x) => x.id === id)?.clientId ?? id, clientName: null,
      note: 'Your client\u2019s trials as the club and your client have recorded them.',
      honest: 'Nothing here is an offer, a negotiation or a fee. A trial is an assessment opportunity.',
    });
  },
  async clientShares(s, id) { return delay({ items: (SHARES[id] ?? []).slice().sort((a, b) => b.sharedAt - a.sharedAt) }); },
  async shareOpportunity(s, id, oppId, input) {
    SHARES[id] ??= [];
    const existing = SHARES[id].find((x) => x.opportunityId === oppId && !x.withdrawnAt);
    if (existing) refuse(409, 'OPPORTUNITY_ALREADY_SHARED', 'You have already shared this opportunity with this client.');
    const share: OpportunityShare = {
      id: `aos-${Date.now().toString(36)}`, opportunityId: oppId, via: 'opportunity',
      title: null, orgName: null, deadline: null, note: input.note?.trim() ? input.note.trim() : null,
      sharedAt: Date.now(), sharedByName: userOf(s).name, withdrawnAt: null, rev: 1,
      honest: 'Your agent brought this to your attention. Applying is your own action \u2014 nobody can apply for you.',
    };
    SHARES[id].push(share);
    return delay({ share, note: 'Shared. Your client decides whether to apply, on their own screen, in their own name.' });
  },
  async withdrawShare(s, id, shareId) {
    const share = (SHARES[id] ?? []).find((x) => x.id === shareId);
    // `refuse` always throws, but its return type does not say so; the guard
    // keeps that promise to the type system rather than asserting past it.
    if (!share) { refuse(404, 'OPPORTUNITY_SHARE_NOT_FOUND', 'Not found.'); throw new Error('unreachable'); }
    if (!share.withdrawnAt) { share.withdrawnAt = Date.now(); share.rev += 1; }
    return delay({ share });
  },
  async handoffs() {
    return delay({ items: HANDOFFS.slice(), note: 'Clubs that have invited a transaction workspace for one of your clients. Their recruitment case, their assessment and their reasons are not here. Opening a workspace is your action and commits nobody to anything.' });
  },
};
