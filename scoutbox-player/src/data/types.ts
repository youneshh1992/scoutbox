import type {
  Availability, ContractStatus, InboxRequest, ChildInboxItem, GuardianInboxRequest,
  Guardian, Drill, PlayerProfile,
} from '../domain/types';

export interface NotificationPrefs {
  quietStart: string | null;
  quietEnd: string | null;
  schoolHoursMute: boolean | null;
}

// ---- The Grassroots journey (exclusive to amateur/semi-pro players) ----
export interface PathwayStep { key: string; label: string; reached: boolean; note: string }
export interface Pathway {
  level: string;
  steps: PathwayStep[];
  signals: { verifiedAttendances: number; verifiedClips: number; combineVerified: number; coachVouches: number };
  nextStep: string;
}

export interface ProgrammeSession { id: string; day: string; title: string; drillId: string | null; done: boolean }
export interface ProgrammeProgress {
  track: string; label: string; startedAt: number;
  sessions: ProgrammeSession[]; doneThisWeek: number; totalPerWeek: number;
}
export interface ProgrammeInfo {
  current: ProgrammeProgress | null;
  tracks: { key: string; label: string; positions: string[]; sessionsPerWeek: number }[];
  suggested: string;
}

export interface Benchmarks {
  cohortSize: number;
  note: string;
  drills: { drillId: string; name: string; metric: string; unit: string; value: number; percentile: number | null }[];
  stats: { stat: string; value: number; percentile: number | null }[];
}

export interface OpportunityOpenTrial {
  id: string; title: string; date: string; venue: string; ageGroup: string;
  positions: string[]; registered: boolean; orgName?: string;
}
export interface OpportunityClub {
  id: string; name: string; city: string; distanceKm: number; verified: boolean;
  safeguardingCertified: boolean; lookingFor: string[]; openTrials: OpportunityOpenTrial[];
  /** Development record: players this club signed or hosted who moved up. */
  progressed?: number; pathwayClub?: boolean;
}
export interface Opportunities { radiusKm?: number; clubs: OpportunityClub[]; lookingForYou?: number; note?: string }

export interface GuardianOpenTrial {
  id: string; title: string; date: string; venue: string; ageGroup: string; positions: string[];
  orgName: string; verified: boolean; safeguardingCertified: boolean; distanceKm: number; registered: boolean;
}

export interface Vouch {
  id: string; coachName: string; role: string; seasons: string | null;
  text: string | null; status: 'pending' | 'published' | 'revoked'; ts: number;
}

export interface SeasonWrap {
  generatedAt: string;
  player: { name: string; position: string | null; level: string };
  season: PlayerProfile['stats'];
  verifiedAttendances: number;
  verifiedClips: number;
  bestStreak: number;
  combineBests: { drillName: string; metric: string; value: number; unit: string }[];
  badges: string[];
  coachVouches: number;
  scoutViews: number;
  note: string;
}

export interface DirectoryClub {
  id: string;
  name: string;
  plan: string;
  verified: boolean;
  trustedPartner: boolean;
  safeguardingCertified: boolean;
  trialsRun: number;
  reportsFiled: number;
  avgReportDays: number | null;
  /** Grassroots clubs only: their development record. */
  progressed?: number;
  pathwayClub?: boolean;
}
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
  tier?: string;
  streak?: number;
  weeklyGoal?: { done: number; target: number; met: boolean };
  nextActions?: { id: string; label: string; gain: number }[];
  agingUp?: { eligible: boolean } | null;
  pathway?: Pathway | null;
  programme?: ProgrammeProgress | null;
  vouches?: Vouch[];
  firstTeamSeeker?: boolean;
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
  orgVerified?: boolean;
  scoutName: string;
  scoutRole: string;
  counterparty: 'player' | 'guardian';
  createdAt: number;
  messages: Message[];
  readBy?: { org: number | null; counterparty: number | null };
}

export type PlayerFeedItem =
  | {
      type: 'weekly_report';
      ts: number;
      report: {
        views: number;
        shortlists: number;
        streak: number;
        weeklyGoal: { done: number; target: number; met: boolean };
        topClip: { title: string; views: number; verified: boolean } | null;
        suggestion: { id: string; label: string; gain: number } | null;
      };
    }
  | { type: 'scouting_event'; ts: number; orgName: string; eventType: string }
  | { type: 'scouts_noticed'; ts: number; tags: Record<string, number> };

export interface PlayerCV {
  generatedAt: string;
  player: { name: string; age: number; country: string; position: string | null; foot: string | null; heightCm: number | null; weightKg: number | null; identityVerified: boolean };
  trust: { score: number; tier: string; breakdown: TrustBreakdown };
  seasonStats: PlayerProfile['stats'];
  verifiedAttendance: { fixture: string; venue: string; date: string }[];
  verifiedClips: { title: string; uploadedAt: string }[];
  trialReports: { orgName: string; filedAt: number; acceleration: number; sprintSpeedKmh: number; distanceKm: number; passCompletionPct: number; duelSuccessPct: number; coachRating: number }[];
  combine: import('../domain/types').CombineResult[];
  timeline: { year: string; event: string }[];
  note: string;
}

export interface GuardianDigest {
  generatedAt: string;
  children: {
    id: string;
    name: string;
    views: number;
    shortlists: number;
    streak: number;
    weeklyGoal: { done: number; target: number; met: boolean };
    newRequests: number;
    activityThisWeek: number;
  }[];
  note: string;
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
  /** 8-week view trend, oldest first. */
  weeklySeries?: number[];
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
  /** Real sessions: login mints a bearer token the client holds internally.
   *  Passwordless demo seeds log in without one; new accounts require theirs. */
  login(playerId: string, password?: string): Promise<{ playerId: string; name: string }>;
  /** Child device pairing: exchange the guardian's code for the child login. */
  pair(code: string): Promise<{ playerId: string; name: string }>;
  getMe(playerId: string): Promise<Me>;
  getInbox(playerId: string): Promise<(InboxRequest | ChildInboxItem)[]>;
  respond(playerId: string, requestId: string, accept: boolean, chosenSlot?: string): Promise<void>;
  setAcademyPlus(playerId: string, enabled: boolean): Promise<void>;
  /** dataUrl carries the actual video file when provided (web picker);
   *  attendanceId links footage to a verified attendance → Verified Clip seal. */
  addMedia(playerId: string, title: string, dataUrl?: string, attendanceId?: string): Promise<void>;
  /** Resolve a media path to a playable URL (absolute in live mode). */
  mediaUrl(path: string | null | undefined): string | null;
  getChannels(playerId: string): Promise<Channel[]>;
  sendMessage(playerId: string, channelId: string, text: string, attachMediaId?: string): Promise<void>;
  markChannelRead(playerId: string, channelId: string): Promise<void>;
  sendTyping(playerId: string, channelId: string): Promise<void>;
  getFeed(playerId: string): Promise<PlayerFeedItem[]>;
  getCv(playerId: string): Promise<PlayerCV>;
  getNotifications(playerId: string): Promise<AppNotification[]>;
  markNotificationsRead(playerId: string): Promise<void>;
  getInsights(playerId: string): Promise<Insights>;
  getMyReports(playerId: string): Promise<FiledReport[]>;
  setMedicalShared(playerId: string, shared: boolean): Promise<void>;
  setAvailability(playerId: string, availability?: Availability, contractStatus?: ContractStatus): Promise<void>;
  addAttendance(playerId: string, input: AttendanceInput): Promise<void>;
  addTimeline(playerId: string, year: string, event: string): Promise<void>;
  updateStats(playerId: string, stats: Record<string, number>, season?: string): Promise<void>;
  getDrills(playerId: string): Promise<Drill[]>;
  /** value = the drill's measured metric; videoDataUrl marks it combine-VERIFIED. */
  completeDrill(playerId: string, drillId: string, value?: number, videoDataUrl?: string): Promise<void>;
  agingUpComplete(playerId: string): Promise<void>;
  getPrefs(playerId: string): Promise<NotificationPrefs | null>;
  setPrefs(playerId: string, prefs: Partial<NotificationPrefs>): Promise<void>;
  getExport(playerId: string): Promise<Record<string, unknown>>;
  deleteAccount(playerId: string): Promise<void>;
  getDirectory(): Promise<DirectoryClub[]>;
  // The Grassroots journey (amateur/semi-pro only — the server refuses pros).
  getProgramme(playerId: string): Promise<ProgrammeInfo>;
  selectProgramme(playerId: string, track: string): Promise<void>;
  completeProgrammeSession(playerId: string, sessionId: string): Promise<void>;
  getBenchmarks(playerId: string): Promise<Benchmarks>;
  getOpportunities(playerId: string): Promise<Opportunities>;
  registerOpenTrial(playerId: string, openTrialId: string): Promise<void>;
  setFirstTeamSeeker(playerId: string, enabled: boolean): Promise<void>;
  requestVouch(playerId: string, coachName: string, coachEmail: string, role: string): Promise<void>;
  getSeasonWrap(playerId: string): Promise<SeasonWrap>;
  report(playerId: string, input: ReportInput): Promise<void>;
  block(playerId: string, orgId: string, reason?: string): Promise<void>;

  // Guardian surface — parents own every under-18 account.
  guardianSignup(name: string, email: string, password: string): Promise<{ guardianId: string; devEmailCode?: string }>;
  guardianVerifyEmail(guardianId: string, code: string): Promise<void>;
  guardianLogin(idOrEmail: string, password?: string): Promise<{ guardianId: string; guardian: Guardian }>;
  guardianMe(guardianId: string): Promise<Guardian>;
  guardianVerifyId(guardianId: string, documentType: string, documentRef: string): Promise<void>;
  guardianAcceptDisclaimer(guardianId: string): Promise<void>;
  guardianChildren(guardianId: string): Promise<Me[]>;
  guardianAddChild(guardianId: string, input: ChildInput): Promise<{ playerId: string }>;
  guardianInbox(guardianId: string): Promise<GuardianInboxRequest[]>;
  guardianRespond(guardianId: string, requestId: string, accept: boolean, chosenSlot?: string): Promise<void>;
  guardianLog(guardianId: string): Promise<{ id: string; ts: number; type: string; orgName: string; scoutName: string; playerId: string }[]>;
  guardianSetMedicalShared(guardianId: string, childId: string, shared: boolean): Promise<void>;
  guardianReport(guardianId: string, input: ReportInput): Promise<void>;
  guardianBlock(guardianId: string, orgId: string, childId?: string, reason?: string): Promise<void>;
  guardianChannels(guardianId: string): Promise<Channel[]>;
  guardianSendMessage(guardianId: string, channelId: string, text: string, attachMediaId?: string): Promise<void>;
  guardianMarkChannelRead(guardianId: string, channelId: string): Promise<void>;
  guardianSendTyping(guardianId: string, channelId: string): Promise<void>;
  guardianDigest(guardianId: string): Promise<GuardianDigest>;
  guardianNotifications(guardianId: string): Promise<AppNotification[]>;
  guardianMarkNotificationsRead(guardianId: string): Promise<void>;
  guardianChildInsights(guardianId: string, childId: string): Promise<Insights>;
  guardianSetChildAvailability(guardianId: string, childId: string, availability: 'available_now' | 'end_of_season' | 'not_seeking'): Promise<void>;
  guardianAddCoGuardian(guardianId: string, name: string, email: string): Promise<void>;
  guardianReports(guardianId: string): Promise<FiledReport[]>;
  guardianPairingCode(guardianId: string, childId: string): Promise<{ code: string; expiresAt: number }>;
  guardianPrefs(guardianId: string): Promise<NotificationPrefs | null>;
  guardianSetPrefs(guardianId: string, prefs: Partial<NotificationPrefs>): Promise<void>;
  guardianExport(guardianId: string): Promise<Record<string, unknown>>;
  guardianDeleteChild(guardianId: string, childId: string): Promise<void>;
  guardianChildOpenTrials(guardianId: string, childId: string): Promise<GuardianOpenTrial[]>;
  guardianRegisterOpenTrial(guardianId: string, openTrialId: string, childId: string): Promise<void>;
  guardianSetFirstTeamSeeker(guardianId: string, childId: string, enabled: boolean): Promise<void>;
  guardianRequestVouch(guardianId: string, childId: string, coachName: string, coachEmail: string, role: string): Promise<void>;

  onChange(cb: (event?: string, payload?: Record<string, unknown>) => void): () => void;
}
