// ScoutBox Agent — the self-contained in-browser demo (VITE_DEMO=1).
//
// Synthetic examples on a synthetic agency. State lives in this tab's memory
// and resets on reload. The demo mirrors the SERVER'S rules where a screen
// depends on them (verification gate, access predicate, self-promotion,
// last admin, uniform 404) so what the demo shows is what the product does;
// nothing here is a second source of truth for a real deployment.
import type { CoreApi, Notification, Org, Session } from './api';
import type {
  AgentApi, AgencyOverview, AuditRow, ClientRow, ComplianceRow, FacetView, Home, Me, Member, Opportunity,
  Profile, Relationship, Tier, VerificationState,
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
};
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
    facets: { fifa_licence: fifa, national_registration: Object.fromEntries(Object.entries(p.facets.national_registration).map(([k, f]) => [k, { ...f, state: effState(f) }])), minors_authorisation: Object.fromEntries(Object.entries(p.facets.minors_authorisation).map(([k, f]) => [k, { ...f, state: effState(f) }])) },
    regulatoryState: {
      fifaLicence: effState(p.facets.fifa_licence),
      jurisdictions: p.declared.jurisdictions.map((ma) => ({ memberAssociation: ma, nationalRegistration: effState(p.facets.national_registration[ma]), minorsAuthorisation: effState(p.facets.minors_authorisation[ma]), regulatedActionsPermitted: !gap(p, ma) })),
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
  async getProfile(s) { affOf(s); return delay({ profile: profileView(PROFILES.find((p) => p.userId === s.userId)), states: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'], facets: ['fifa_licence', 'national_registration', 'minors_authorisation'], jurisdictions: ['INT', 'ENG', 'USA'] }); },
  async saveProfile(s, input) {
    need(s, 'profile.write.own');
    let p = PROFILES.find((x) => x.userId === s.userId);
    if (!p) {
      p = { userId: s.userId, displayName: input.displayName?.trim() || userOf(s).name, declared: { fifaLicenceNumber: input.fifaLicenceNumber?.trim() || null, jurisdictions: input.jurisdictions ?? [] }, facets: { fifa_licence: facet('UNVERIFIED'), national_registration: {}, minors_authorisation: {} }, rev: 1, revAt: Date.now(), createdAt: Date.now(), history: [{ id: id('h'), at: Date.now(), action: 'agent_profile_created', detail: null }] };
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
    const prev = f === 'fifa_licence' ? p!.facets.fifa_licence : p!.facets[f][ma!];
    if (f === 'fifa_licence') p!.facets.fifa_licence = next; else p!.facets[f][ma!] = next;
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
  async inbox(s) {
    need(s, 'inbox.read');
    return delay({ notifications: NOTES[s.userId] ?? [], pending: RELS.filter((r) => r.agentUserId === s.userId && eff(r) === 'proposed').map((r) => forAgent(r, s.userId)), note: 'Operational messages only. Negotiation and offers are not part of this workspace.' });
  },
};
