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

// A scouting request as the PLAYER sees it: org identity summarised,
// internal org/user ids stripped by the server.
export interface InboxRequest {
  id: string;
  type: 'contact' | 'trial';
  orgName: string;
  orgType: 'club' | 'agency';
  trustedPartner: boolean;
  scoutName: string;
  message: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
  contactChannel: string | null;
}

export const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'] as const;
