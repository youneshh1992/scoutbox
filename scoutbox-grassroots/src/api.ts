// Typed API client for scoutbox-server.
// Auto-connects to localhost:4000; override with VITE_API_URL.
// VITE_DEMO=1 swaps in the self-contained in-browser demo client (src/demo.ts)
// used for static builds — the real product always talks to the server, which
// is where every rule is enforced.

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
export const DEMO_MODE = import.meta.env.VITE_DEMO === '1';

export type OrgType = 'club' | 'agency';

export interface Org {
  id: string;
  name: string;
  type: OrgType;
  plan: 'Grassroots' | 'Academy' | 'Pro' | 'Agency';
  trustedPartner: boolean;
  /** Club verification (company email domain + safeguarding contract).
   *  Unverified clubs never see under-18 profiles. */
  verified: boolean;
  /** Earned and losable: verified + contract + no unresolved urgent report. */
  safeguardingCertified?: boolean;
  /** Proven control of a company mailbox (email-domain challenge). */
  emailDomainVerified?: boolean;
  emailDomain?: string;
}

// Grassroots views carry distance from the club's ground; pro-market fields
// (academyPlus, marketValueRange, agentName) are absent by server rule.
export interface Session {
  org: Org;
  userId: string;
  scoutName: string;
  /** Verified role shown to players and guardians (e.g. "Head of Recruitment"). */
  role: string;
  /** Bearer session token minted at login — the server trusts nothing else. */
  token: string;
}

export interface MedicalRecord {
  id: string;
  type: string;
  title: string;
  date: string;
  layoffWeeks: number | null;
  cleared: boolean | null;
}

export interface Medical {
  shared: boolean;
  records: MedicalRecord[];
  conditionStatus: string;
  note?: string;
}

export interface Attendance {
  id: string;
  fixture: string;
  venue: string;
  date: string;
  gps: { lat: number; lng: number };
  verified: boolean;
}

export interface TrialReport {
  id: string;
  strengthNote?: string | null;
  focusNote?: string | null;
  trialId: string;
  orgName: string;
  scoutName: string;
  filedAt: number;
  acceleration: number;
  sprintSpeedKmh: number;
  distanceKm: number;
  passCompletionPct: number;
  duelSuccessPct: number;
  coachRating: number;
  notes?: string;
}

export interface Player {
  id: string;
  name: string;
  age: number;
  /** Null for minors — exact DOB is never exposed to orgs. */
  dob: string | null;
  /** True for under-18 players: all contact routes to the guardian. */
  guardianManaged?: boolean;
  contactPolicy?: 'guardian_only';
  squadNumber?: number | null;
  contractUntil?: string | null;
  marketValueRange?: string | null;
  agentName?: string | null;
  country: string;
  city: string;
  position: string;
  foot: string;
  heightCm: number;
  weightKg: number;
  stats: {
    appearances: number;
    goals: number;
    assists: number;
    paceKmh?: number;
    passCompletionPct?: number;
    duelSuccessPct?: number;
    cleanSheets?: number;
  } | null;
  academyPlus: boolean;
  badges: string[];
  availability: string;
  contractStatus: string;
  identityVerified: boolean;
  trustScore: number;
  distanceKm?: number;
  level?: string;
  attendance: Attendance[];
  timeline: { year: string; event: string }[];
  media: MediaItem[];
  trialReports: TrialReport[];
  medical: Medical;
  createdAt?: number | null;
  drillResults?: CombineResult[];
  seasonHistory?: { season: string; appearances: number; goals: number; assists: number }[];
}

export interface MediaItem {
  id: string;
  title: string;
  kind: string;
  uploadedAt: string;
  url?: string | null;
  views?: number;
  tags?: Record<string, number>;
  /** Attendance id when the footage is provably from a confirmed fixture. */
  verifiedClip?: string | null;
}

export interface CombineResult {
  id: string;
  drillId: string;
  drillName: string;
  metric: string;
  unit: string;
  value: number;
  verified: boolean;
  ts: number;
}

export interface FilmRoomItem {
  media: { id: string; title: string; url: string; views: number; verifiedClip: string | null; tags: Record<string, number> };
  player: { id: string; name: string; position: string; age: number; trustScore: number; academyPlus: boolean; guardianManaged: boolean };
}

export interface FeedItem {
  type: 'new_player' | 'new_clip' | 'shortlist_new_clip' | 'report_due';
  ts: number;
  playerId: string;
  playerName: string;
  position?: string;
  age?: number;
  guardianManaged?: boolean;
  mediaId?: string;
  title?: string;
  hasVideo?: boolean;
  verifiedClip?: boolean;
  trialId?: string;
  dueAt?: number;
}

export interface FixtureGroup {
  fixture: string;
  venue: string;
  date: string;
  players: { id: string; name: string; position: string; age: number; trustScore: number }[];
}

export interface PlayerDetail extends Player {
  /** Internal notes shared inside YOUR org only. */
  orgNotes?: OrgNote[];
  similarPlayers: {
    note: string;
    players: { playerId: string; name: string; position: string; score: number }[];
    archetypes: { archetypeId: string; label: string; score: number }[];
  };
}

export interface OrgRequest {
  id: string;
  playerId: string;
  playerName?: string;
  type: 'contact' | 'trial';
  message: string;
  status: 'pending' | 'accepted' | 'declined' | 'suspended';
  scoutName: string;
  scoutRole?: string;
  createdAt: number;
  /** 'guardian' for minors — Scout → Parent, never Scout → Child. */
  routedTo?: 'player' | 'guardian';
  contactChannel: string | null;
}

export interface ReportInput {
  targetKind: 'club' | 'scout' | 'player';
  targetOrgId?: string;
  targetScoutName?: string;
  targetPlayerId?: string;
  reason: string;
  urgent?: boolean;
}

export interface FiledReport extends ReportInput {
  id: string;
  ts: number;
  status: 'pending_review' | 'resolved';
  outcome: string | null;
  resolvedAt: number | null;
}

export interface MessageAttachment {
  kind: 'clip' | 'trial_report';
  mediaId?: string;
  title?: string;
  url?: string | null;
  verifiedClip?: boolean;
  reportId?: string;
  orgName?: string;
  summary?: string;
}

export interface Message {
  id: string;
  ts: number;
  sender: { kind: 'org_user' | 'player' | 'guardian'; id: string; name: string };
  text: string;
  attachment?: MessageAttachment | null;
}

export interface Channel {
  id: string;
  requestId: string;
  playerId: string;
  playerName: string;
  orgName: string;
  scoutName: string;
  scoutRole: string;
  /** 'guardian' means the thread is with the parent — never the child. */
  counterparty: 'player' | 'guardian';
  createdAt: number;
  messages: Message[];
  /** Read receipts: when each side last opened the thread. */
  readBy?: { org: number | null; counterparty: number | null };
}

export interface Notification {
  id: string;
  ts: number;
  type: string;
  text: string;
  refId: string | null;
  read: boolean;
}

export interface TrialDetails {
  proposedDate?: string;
  /** Up to two alternative dates the player/guardian can pick instead. */
  altSlots?: string[];
  venue?: string;
  notes?: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  scoutName: string;
  filters: SearchFilters & { foot?: string };
  createdAt: number;
}

export interface OrgNote {
  id: string;
  playerId: string;
  scoutName: string;
  text: string;
  ts: number;
}

export interface SigningRecord {
  id: string;
  playerId: string;
  playerName: string;
  scoutName: string;
  ts: number;
  attributionWindowMonths: number;
  insideAttributionWindow: boolean;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
}

export interface Funnel {
  stages: FunnelStage[];
  byScout: { scoutName: string; events: number }[];
}

export interface Invoice {
  id: string;
  ts: number;
  signingId: string;
  playerName: string;
  description: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
}

export interface Trial {
  id: string;
  playerId: string;
  playerName: string;
  scoutName: string;
  acceptedAt: number;
  proposedDate?: string | null;
  venue?: string | null;
  notes?: string;
  /** The mandatory performance report deadline. */
  reportDueAt?: number;
  guardianApproved?: boolean;
  status: 'awaiting_report' | 'reported';
  report?: TrialReport;
}

export interface LedgerEntry {
  id: string;
  ts: number;
  type: string;
  playerId: string;
  orgId: string | null;
  orgName: string;
  userId: string | null;
  scoutName: string;
}

export interface ProofPack {
  playerId: string;
  playerName: string;
  org: { id: string; name: string; plan: string };
  firstQualifyingInteraction: LedgerEntry | null;
  attributionWindowMonths: number;
  attributionWindowEnds: string | null;
  eventLog: LedgerEntry[];
  generatedAt: string;
}

export interface PlanInfo {
  org: Org;
  plan: { name: string; pricePerMonthGBP: number; seats: number; attributionWindowMonths: number; antiCircumvention: string };
  compliance: { attributionWindowMonths: number; antiCircumvention: string; feeProtection: string };
}

export interface Reputation {
  seeded: { scoutName: string; orgName: string; discoveries: number; successRatePct: number; avgResaleMultiple: number; seeded: true }[];
  live: { scoutName: string; orgName: string; views: number; contacts: number; trials: number; signings: number }[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface SearchFilters {
  q?: string;
  position?: string;
  academyPlus?: boolean;
  availability?: string;
  country?: string;
  ageGroup?: 'u16' | 'u18' | '18-21' | 'senior';
  /** Only players who joined in the last N days. */
  newDays?: number;
}

export interface ScoutboxApi {
  listOrgs(): Promise<Org[]>;
  login(orgId: string, scoutName: string, role: string): Promise<Session>;
  registerGrassroots(input: {
    name: string; federation: string; registrationId: string; city: string;
    lat: number; lng: number; scoutName: string; role: string;
  }): Promise<Session>;
  report(s: Session, input: ReportInput): Promise<void>;
  searchPlayers(s: Session, f: SearchFilters): Promise<Player[]>;
  getPlayer(s: Session, id: string): Promise<PlayerDetail>;
  act(s: Session, playerId: string, action: 'save' | 'shortlist' | 'signing'): Promise<void>;
  getShortlist(s: Session): Promise<Player[]>;
  sendRequest(s: Session, playerId: string, type: 'contact' | 'trial', message: string, details?: TrialDetails): Promise<void>;
  getChannels(s: Session): Promise<Channel[]>;
  sendMessage(s: Session, channelId: string, text: string, attachTrialReportId?: string): Promise<void>;
  markChannelRead(s: Session, channelId: string): Promise<void>;
  sendTyping(s: Session, channelId: string): Promise<void>;
  getFeed(s: Session): Promise<FeedItem[]>;
  getFilmRoom(s: Session): Promise<FilmRoomItem[]>;
  recordClipView(s: Session, playerId: string, mediaId: string): Promise<void>;
  tagClip(s: Session, playerId: string, mediaId: string, tags: string[]): Promise<void>;
  getScoutTags(s: Session): Promise<string[]>;
  getFixtures(s: Session): Promise<FixtureGroup[]>;
  getSavedSearches(s: Session): Promise<SavedSearch[]>;
  saveSearch(s: Session, name: string, filters: SearchFilters): Promise<void>;
  deleteSavedSearch(s: Session, id: string): Promise<void>;
  addNote(s: Session, playerId: string, text: string): Promise<void>;
  moreLikeThis(s: Session, playerId: string): Promise<{ base: { name: string }; players: (Player & { similarity: number })[] }>;
  recordSigning(s: Session, playerId: string): Promise<SigningRecord>;
  trialIcsUrl(s: Session, trialId: string): string | null;
  getFunnel(s: Session): Promise<Funnel>;
  getInvoices(s: Session): Promise<Invoice[]>;
  requestEmailVerification(s: Session, email: string): Promise<void>;
  confirmEmailVerification(s: Session, code: string): Promise<{ emailDomain: string }>;
  getNotifications(s: Session): Promise<Notification[]>;
  markNotificationsRead(s: Session): Promise<void>;
  getMyReports(s: Session): Promise<FiledReport[]>;
  /** Absolute URL for an uploaded media file, or null when no file exists. */
  mediaUrl(path: string | null | undefined): string | null;
  getRequests(s: Session): Promise<OrgRequest[]>;
  getTrials(s: Session): Promise<Trial[]>;
  fileTrialReport(s: Session, trialId: string, report: Record<string, number | string>): Promise<void>;
  getLedger(s: Session): Promise<LedgerEntry[]>;
  getProofPack(s: Session, playerId: string): Promise<ProofPack>;
  getPlan(s: Session): Promise<PlanInfo>;
  getReputation(s: Session): Promise<Reputation>;
  /** Subscribe to live changes; returns an unsubscribe fn. */
  onChange(cb: (event: string, payload?: Record<string, unknown>) => void): () => void;
}

// ------------------------------------------------------------- http client

function headers(s: Session): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${s.token}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

export const httpApi: ScoutboxApi = {
  listOrgs: () => request<Org[]>('/orgs?platform=grassroots'),

  async login(orgId, scoutName, role) {
    const r = await request<{ userId: string; role: string; org: Org; token: string }>('/auth/org/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, scoutName, role, platform: 'grassroots' }),
    });
    return { org: r.org, userId: r.userId, scoutName, role: r.role, token: r.token };
  },

  async registerGrassroots(input) {
    const r = await request<{ userId: string; role: string; org: Org; token: string }>('/auth/org/register-grassroots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { org: r.org, userId: r.userId, scoutName: input.scoutName, role: r.role, token: r.token };
  },

  report: (s, input) =>
    request<void>('/org/report', { method: 'POST', headers: headers(s), body: JSON.stringify(input) }),

  searchPlayers(s, f) {
    const params = new URLSearchParams();
    if (f.q) params.set('q', f.q);
    if (f.position) params.set('position', f.position);
    if (f.availability) params.set('availability', f.availability);
    if (f.academyPlus) params.set('academyPlus', 'true');
    if (f.country) params.set('country', f.country);
    if (f.ageGroup) params.set('ageGroup', f.ageGroup);
    if (f.newDays) params.set('newDays', String(f.newDays));
    return request<Player[]>(`/org/players?${params}`, { headers: headers(s) });
  },

  getPlayer: (s, id) => request<PlayerDetail>(`/org/players/${id}`, { headers: headers(s) }),

  act: (s, playerId, action) =>
    request<void>(`/org/players/${playerId}/${action}`, { method: 'POST', headers: headers(s) }),

  getShortlist: (s) => request<Player[]>('/org/shortlist', { headers: headers(s) }),

  sendRequest: (s, playerId, type, message, details) =>
    request<void>(`/org/players/${playerId}/request`, {
      method: 'POST',
      headers: headers(s),
      body: JSON.stringify({ type, message, ...details }),
    }),

  getChannels: (s) => request<Channel[]>('/org/channels', { headers: headers(s) }),

  sendMessage: (s, channelId, text, attachTrialReportId) =>
    request<void>(`/org/channels/${channelId}/messages`, { method: 'POST', headers: headers(s), body: JSON.stringify({ text, attachTrialReportId }) }),

  markChannelRead: (s, channelId) =>
    request<void>(`/org/channels/${channelId}/read`, { method: 'POST', headers: headers(s) }),

  sendTyping: (s, channelId) =>
    request<void>(`/org/channels/${channelId}/typing`, { method: 'POST', headers: headers(s) }),

  getFeed: (s) => request<FeedItem[]>('/org/feed', { headers: headers(s) }),

  getFilmRoom: (s) => request<FilmRoomItem[]>('/org/filmroom', { headers: headers(s) }),

  recordClipView: (s, playerId, mediaId) =>
    request<void>(`/org/players/${playerId}/media/${mediaId}/view`, { method: 'POST', headers: headers(s) }),

  tagClip: (s, playerId, mediaId, tags) =>
    request<void>(`/org/players/${playerId}/media/${mediaId}/tags`, { method: 'POST', headers: headers(s), body: JSON.stringify({ tags }) }),

  getScoutTags: (s) => request<string[]>('/org/tags', { headers: headers(s) }),

  getFixtures: (s) => request<FixtureGroup[]>('/org/fixtures', { headers: headers(s) }),

  getSavedSearches: (s) => request<SavedSearch[]>('/org/searches', { headers: headers(s) }),

  saveSearch: (s, name, filters) =>
    request<void>('/org/searches', { method: 'POST', headers: headers(s), body: JSON.stringify({ name, filters }) }),

  deleteSavedSearch: (s, id) =>
    request<void>(`/org/searches/${id}`, { method: 'DELETE', headers: headers(s) }),

  addNote: (s, playerId, text) =>
    request<void>(`/org/players/${playerId}/notes`, { method: 'POST', headers: headers(s), body: JSON.stringify({ text }) }),

  moreLikeThis: (s, playerId) =>
    request<{ base: { name: string }; players: (Player & { similarity: number })[] }>(`/org/players/${playerId}/morelike`, { headers: headers(s) }),

  recordSigning: async (s, playerId) => {
    const r = await request<{ signing: SigningRecord }>(`/org/players/${playerId}/signing`, { method: 'POST', headers: headers(s) });
    return r.signing;
  },

  trialIcsUrl: (s, trialId) => `${API_URL}/org/trials/${trialId}/ics`,

  getFunnel: (s) => request<Funnel>('/org/funnel', { headers: headers(s) }),

  getInvoices: (s) => request<Invoice[]>('/org/invoices', { headers: headers(s) }),

  requestEmailVerification: (s, email) =>
    request<void>('/org/verification/email', { method: 'POST', headers: headers(s), body: JSON.stringify({ email }) }),

  confirmEmailVerification: (s, code) =>
    request<{ emailDomain: string }>('/org/verification/email/confirm', { method: 'POST', headers: headers(s), body: JSON.stringify({ code }) }),

  getNotifications: (s) => request<Notification[]>('/org/notifications', { headers: headers(s) }),

  markNotificationsRead: (s) =>
    request<void>('/org/notifications/read', { method: 'POST', headers: headers(s) }),

  getMyReports: (s) => request<FiledReport[]>('/org/reports', { headers: headers(s) }),

  mediaUrl: (path) => (path ? `${API_URL}${path}` : null),

  getRequests: (s) => request<OrgRequest[]>('/org/requests', { headers: headers(s) }),
  getTrials: (s) => request<Trial[]>('/org/trials', { headers: headers(s) }),

  fileTrialReport: (s, trialId, report) =>
    request<void>(`/org/trials/${trialId}/report`, {
      method: 'POST',
      headers: headers(s),
      body: JSON.stringify(report),
    }),

  getLedger: (s) => request<LedgerEntry[]>('/org/ledger', { headers: headers(s) }),
  getProofPack: (s, playerId) => request<ProofPack>(`/org/players/${playerId}/proofpack`, { headers: headers(s) }),
  getPlan: (s) => request<PlanInfo>('/org/plan', { headers: headers(s) }),
  getReputation: (s) => request<Reputation>('/org/reputation', { headers: headers(s) }),

  onChange(cb) {
    const source = new EventSource(`${API_URL}/events`);
    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        cb(data.event, data);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => source.close();
  },
};

// The active client: live server by default, in-browser demo when VITE_DEMO=1.
import { demoApi } from './demo';
export const api: ScoutboxApi = DEMO_MODE ? demoApi : httpApi;
