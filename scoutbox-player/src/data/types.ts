import type { Availability, ContractStatus, InboxRequest, PlayerProfile } from '../domain/types';
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

// The player app's data surface. Two implementations: httpClient (live
// scoutbox-server) and mockClient (self-contained demo), selected by
// EXPO_PUBLIC_API_URL in client.ts.
export interface PlayerClient {
  mode: 'live' | 'demo';
  listDemoIdentities(): Promise<DemoIdentity[]>;
  signup(input: SignupInput): Promise<{ playerId: string }>;
  getMe(playerId: string): Promise<Me>;
  getInbox(playerId: string): Promise<InboxRequest[]>;
  respond(playerId: string, requestId: string, accept: boolean): Promise<void>;
  setAcademyPlus(playerId: string, enabled: boolean): Promise<void>;
  addMedia(playerId: string, title: string): Promise<void>;
  setMedicalShared(playerId: string, shared: boolean): Promise<void>;
  setAvailability(playerId: string, availability?: Availability, contractStatus?: ContractStatus): Promise<void>;
  addAttendance(playerId: string, input: AttendanceInput): Promise<void>;
  addTimeline(playerId: string, year: string, event: string): Promise<void>;
  onChange(cb: () => void): () => void;
}
