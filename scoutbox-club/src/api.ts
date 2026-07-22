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
  plan: 'Academy' | 'Pro' | 'Agency';
  trustedPartner: boolean;
}

export interface Session {
  org: Org;
  userId: string;
  scoutName: string;
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
  dob: string;
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
  attendance: Attendance[];
  timeline: { year: string; event: string }[];
  media: { id: string; title: string; kind: string; uploadedAt: string }[];
  trialReports: TrialReport[];
  medical: Medical;
}

export interface PlayerDetail extends Player {
  similarPlayers: {
    note: string;
    players: { playerId: string; name: string; position: string; score: number }[];
    archetypes: { archetypeId: string; label: string; score: number }[];
  };
}

export interface OrgRequest {
  id: string;
  playerId: string;
  type: 'contact' | 'trial';
  message: string;
  status: 'pending' | 'accepted' | 'declined';
  scoutName: string;
  createdAt: number;
  contactChannel: string | null;
}

export interface Trial {
  id: string;
  playerId: string;
  playerName: string;
  scoutName: string;
  acceptedAt: number;
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
}

export interface ScoutboxApi {
  listOrgs(): Promise<Org[]>;
  login(orgId: string, scoutName: string): Promise<Session>;
  searchPlayers(s: Session, f: SearchFilters): Promise<Player[]>;
  getPlayer(s: Session, id: string): Promise<PlayerDetail>;
  act(s: Session, playerId: string, action: 'save' | 'shortlist' | 'signing'): Promise<void>;
  getShortlist(s: Session): Promise<Player[]>;
  sendRequest(s: Session, playerId: string, type: 'contact' | 'trial', message: string): Promise<void>;
  getRequests(s: Session): Promise<OrgRequest[]>;
  getTrials(s: Session): Promise<Trial[]>;
  fileTrialReport(s: Session, trialId: string, report: Record<string, number | string>): Promise<void>;
  getLedger(s: Session): Promise<LedgerEntry[]>;
  getProofPack(s: Session, playerId: string): Promise<ProofPack>;
  getPlan(s: Session): Promise<PlanInfo>;
  getReputation(s: Session): Promise<Reputation>;
  /** Subscribe to live changes; returns an unsubscribe fn. */
  onChange(cb: (event: string) => void): () => void;
}

// ------------------------------------------------------------- http client

function headers(s: Session): Record<string, string> {
  return { 'content-type': 'application/json', 'x-org-id': s.org.id, 'x-user-id': s.userId };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

export const httpApi: ScoutboxApi = {
  listOrgs: () => request<Org[]>('/orgs'),

  async login(orgId, scoutName) {
    const r = await request<{ userId: string; org: Org }>('/auth/org/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, scoutName }),
    });
    return { org: r.org, userId: r.userId, scoutName };
  },

  searchPlayers(s, f) {
    const params = new URLSearchParams();
    if (f.q) params.set('q', f.q);
    if (f.position) params.set('position', f.position);
    if (f.availability) params.set('availability', f.availability);
    if (f.academyPlus) params.set('academyPlus', 'true');
    return request<Player[]>(`/org/players?${params}`, { headers: headers(s) });
  },

  getPlayer: (s, id) => request<PlayerDetail>(`/org/players/${id}`, { headers: headers(s) }),

  act: (s, playerId, action) =>
    request<void>(`/org/players/${playerId}/${action}`, { method: 'POST', headers: headers(s) }),

  getShortlist: (s) => request<Player[]>('/org/shortlist', { headers: headers(s) }),

  sendRequest: (s, playerId, type, message) =>
    request<void>(`/org/players/${playerId}/request`, {
      method: 'POST',
      headers: headers(s),
      body: JSON.stringify({ type, message }),
    }),

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
        cb(JSON.parse(e.data).event);
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
