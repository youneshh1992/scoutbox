import type {
  Availability, ContractStatus, InboxRequest, ChildInboxItem, GuardianInboxRequest,
  Guardian, Drill, PlayerProfile,
} from '../domain/types';
import type { TrustBreakdown } from '../domain/trustScore';

export interface SignupInput {
  name: string;
  dob: string;
  country: string;
  city?: string;
  position?: string;
  foot?: string;
  heightCm?: number;
  weightKg?: number;
}

export interface Me extends PlayerProfile {
  age: number;
  trustScore: number;
  trust: TrustBreakdown;
}

export class ClientError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface AttendanceInput {
  fixture: string;
  venue: string;
  date: string;
  gps: { lat: number; lng: number };
  deviceId: string;
}

export interface DemoIdentity {
  id: string;
  name: string;
  position: string;
}

export interface ReportInput {
  targetKind: 'club' | 'scout' | 'player';
  targetOrgId?: string;
  targetScoutName?: string;
  reason: string;
  urgent?: boolean;
}

export interface ChildInput {
  name: string;
  dob: string;
  country: string;
  position?: string;
  foot?: string;
}

// The player app's data surface. Two implementations: httpClient (live
// scoutbox-server) and mockClient (self-contained demo), selected by
// EXPO_PUBLIC_API_URL in client.ts.
export interface PlayerClient {
  mode: 'live' | 'demo';
  listDemoIdentities(): Promise<DemoIdentity[]>;
  signup(input: SignupInput): Promise<{ playerId: string }>;
  getMe(playerId: string): Promise<Me>;
  getInbox(playerId: string): Promise<(InboxRequest | ChildInboxItem)[]>;
  respond(playerId: string, requestId: string, accept: boolean): Promise<void>;
  setAcademyPlus(playerId: string, enabled: boolean): Promise<void>;
  addMedia(playerId: string, title: string): Promise<void>;
  setMedicalShared(playerId: string, shared: boolean): Promise<void>;
  setAvailability(playerId: string, availability?: Availability, contractStatus?: ContractStatus): Promise<void>;
  addAttendance(playerId: string, input: AttendanceInput): Promise<void>;
  addTimeline(playerId: string, year: string, event: string): Promise<void>;
  updateStats(playerId: string, stats: Record<string, number>): Promise<void>;
  getDrills(playerId: string): Promise<Drill[]>;
  completeDrill(playerId: string, drillId: string): Promise<void>;
  report(playerId: string, input: ReportInput): Promise<void>;
  block(playerId: string, orgId: string, reason?: string): Promise<void>;

  // Guardian surface — parents own every under-18 account.
  guardianSignup(name: string, email: string): Promise<{ guardianId: string }>;
  guardianLogin(idOrEmail: string): Promise<{ guardianId: string; guardian: Guardian }>;
  guardianMe(guardianId: string): Promise<Guardian>;
  guardianVerifyId(guardianId: string, documentType: string, documentRef: string): Promise<void>;
  guardianAcceptDisclaimer(guardianId: string): Promise<void>;
  guardianChildren(guardianId: string): Promise<Me[]>;
  guardianAddChild(guardianId: string, input: ChildInput): Promise<{ playerId: string }>;
  guardianInbox(guardianId: string): Promise<GuardianInboxRequest[]>;
  guardianRespond(guardianId: string, requestId: string, accept: boolean): Promise<void>;
  guardianLog(guardianId: string): Promise<{ id: string; ts: number; type: string; orgName: string; scoutName: string; playerId: string }[]>;
  guardianSetMedicalShared(guardianId: string, childId: string, shared: boolean): Promise<void>;
  guardianReport(guardianId: string, input: ReportInput): Promise<void>;
  guardianBlock(guardianId: string, orgId: string, childId?: string, reason?: string): Promise<void>;

  onChange(cb: () => void): () => void;
}
