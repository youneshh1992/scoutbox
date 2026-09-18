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
  async clubs(s) {
    affOf(s);
    return delay(structuredClone(DEMO_CLUBS));
  },
  async inbox(s) {
    need(s, 'inbox.read');
    return delay({ notifications: NOTES[s.userId] ?? [], pending: RELS.filter((r) => r.agentUserId === s.userId && eff(r) === 'proposed').map((r) => forAgent(r, s.userId)), note: 'Operational messages only. Negotiation and offers are not part of this workspace.' });
  },
};
