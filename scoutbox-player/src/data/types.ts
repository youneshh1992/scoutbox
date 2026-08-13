import type {
  Availability, ContractStatus, InboxRequest, ChildInboxItem, GuardianInboxRequest,
  Guardian, Drill, PlayerProfile,
} from '../domain/types';
import type { TrustBreakdown } from '../domain/trustScore';

export interface SignupInput {
  password?: string;
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

export interface FiledReport extends ReportInput {
  id: string;
  ts: number;
  status: 'pending_review' | 'resolved';
  outcome: string | null;
  resolvedAt: number | null;
}

export interface Message {
  id: string;
  ts: number;
  sender: { kind: 'org_user' | 'player' | 'guardian'; id: string; name: string };
  text: string;
}

export interface Channel {
  id: string;
  requestId: string;
  playerId: string;
  playerName: string;
  orgName: string;
  orgVerified?: boolean;
  scoutName: string;
  scoutRole: string;
  counterparty: 'player' | 'guardian';
  createdAt: number;
  messages: Message[];
}

export interface AppNotification {
  id: string;
  ts: number;
  type: string;
  text: string;
  refId: string | null;
  read: boolean;
}

export interface Insights {
  thisWeek: { views: number; saves: number; shortlists: number };
  thisMonth: { views: number; saves: number; shortlists: number };
  byOrg: { orgName: string; views: number; saves: number; shortlists: number; requests: number; lastSeen: number }[];
  recent: { type: string; orgName: string; scoutName: string; ts: number }[];
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
  /** dataUrl carries the actual video file when provided (web picker). */
  addMedia(playerId: string, title: string, dataUrl?: string): Promise<void>;
  /** Resolve a media path to a playable URL (absolute in live mode). */
  mediaUrl(path: string | null | undefined): string | null;
  getChannels(playerId: string): Promise<Channel[]>;
  sendMessage(playerId: string, channelId: string, text: string): Promise<void>;
  getNotifications(playerId: string): Promise<AppNotification[]>;
  markNotificationsRead(playerId: string): Promise<void>;
  getInsights(playerId: string): Promise<Insights>;
  getMyReports(playerId: string): Promise<FiledReport[]>;
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
  guardianChannels(guardianId: string): Promise<Channel[]>;
  guardianSendMessage(guardianId: string, channelId: string, text: string): Promise<void>;
  guardianNotifications(guardianId: string): Promise<AppNotification[]>;
  guardianMarkNotificationsRead(guardianId: string): Promise<void>;
  guardianChildInsights(guardianId: string, childId: string): Promise<Insights>;
  guardianSetChildAvailability(guardianId: string, childId: string, availability: 'available_now' | 'end_of_season' | 'not_seeking'): Promise<void>;
  guardianAddCoGuardian(guardianId: string, name: string, email: string): Promise<void>;
  guardianReports(guardianId: string): Promise<FiledReport[]>;

  onChange(cb: () => void): () => void;
}
