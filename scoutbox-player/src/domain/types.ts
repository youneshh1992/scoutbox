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
}

export interface Attendance {
  id: string;
  fixture: string;
  venue: string;
  date: string;
  gps: { lat: number; lng: number };
  verified: boolean;
}

export interface MediaItem {
  id: string;
  title: string;
  kind: string;
  uploadedAt: string;
  /** Playable source when a real file was uploaded (path in live mode, data URL in demo). */
  url?: string | null;
  /** Club view count — honest scouting signal back to the player. */
  views?: number;
  /** "What scouts noticed": tag → count, aggregated anonymously. */
  tags?: Record<string, number>;
  /** Attendance id when footage is provably from a confirmed fixture. */
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

export interface TrialReportOnProfile {
  id: string;
  orgName: string;
  scoutName: string;
  filedAt: number;
  acceleration: number;
  sprintSpeedKmh: number;
  distanceKm: number;
  passCompletionPct: number;
  duelSuccessPct: number;
  coachRating: number;
}

export interface PlayerProfile {
  id: string;
  name: string;
  dob: string;
  country: string;
  city: string;
  /** Set on under-18 profiles: the guardian owns the account. */
  guardianId?: string | null;
  squadNumber?: number | null;
  contractUntil?: string | null;
  marketValueRange?: string | null;
  agentName?: string | null;
  drills?: string[];
  drillResults?: CombineResult[];
  activityLog?: number[];
  position: string | null;
  foot: string | null;
  heightCm: number | null;
  weightKg: number | null;
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
  availability: Availability;
  contractStatus: ContractStatus;
  identityVerified: boolean;
  attendance: Attendance[];
  timeline: { year: string; event: string }[];
  media: MediaItem[];
  trialReports: TrialReportOnProfile[];
  medical: Medical;
}

export type Availability =
  | 'available_now'
  | 'end_of_season'
  | 'loan_open'
  | 'overseas_open'
  | 'not_seeking';

export type ContractStatus =
  | 'under_contract'
  | 'expiring_summer'
  | 'scholarship_ending'
  | 'release_approaching'
  | 'free_agent'
  | 'unknown';

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  available_now: 'Available now',
  end_of_season: 'End of season',
  loan_open: 'Open to loan',
  overseas_open: 'Open to overseas',
  not_seeking: 'Not seeking',
};

export const CONTRACT_LABELS: Record<ContractStatus, string> = {
  under_contract: 'Under contract',
  expiring_summer: 'Contract expiring this summer',
  scholarship_ending: 'Scholarship ending',
  release_approaching: 'Release approaching',
  free_agent: 'Free agent',
  unknown: 'Not set',
};

// A scouting request as an ADULT player sees it: org identity summarised,
// internal org/user ids stripped by the server. A CHILD never sees requests —
// they get sanitized status notes (ChildInboxItem); the guardian gets the
// full club-first view (GuardianInboxRequest).
export interface InboxRequest {
  id: string;
  type: 'contact' | 'trial';
  orgName: string;
  orgType: 'club' | 'agency';
  orgVerified?: boolean;
  trustedPartner: boolean;
  scoutName: string;
  scoutRole?: string;
  message: string;
  status: 'pending' | 'accepted' | 'declined' | 'suspended';
  createdAt: number;
  contactChannel: string | null;
}

export interface ChildInboxItem {
  id: string;
  type: 'contact' | 'trial';
  orgName: string;
  orgVerified?: boolean;
  status: 'pending' | 'accepted' | 'declined' | 'suspended';
  guardianManaged: true;
  note: string;
}

export interface GuardianInboxRequest extends InboxRequest {
  playerId: string;
  playerName?: string;
  routedTo: 'guardian';
}

export interface Guardian {
  id: string;
  name: string;
  email: string;
  idVerified: boolean;
  disclaimerAccepted: boolean;
  childIds: string[];
}

export interface Drill {
  id: string;
  name: string;
  completed: boolean;
  metric: string;
  unit: string;
  benchmark: number;
  lowerIsBetter: boolean;
  best: CombineResult | null;
}

export const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'] as const;
