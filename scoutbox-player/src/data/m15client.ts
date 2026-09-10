// M15 player/guardian data surface — the Football Passport.
// The passport arrives as ONE server-built, viewer-filtered projection;
// the app renders it and never reconstructs history from raw endpoints.
// Adults manage their own sharing; a minor's sharing is guardian-managed
// (the server enforces both — this client only mirrors the shape).
import { m12Request as req } from './httpClient';
import { m15mock } from './m15mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface PassportWhen { display: string; precision: 'day' | 'month' | 'year' }
export interface PassportEvent {
  id: string; type: string; when: PassportWhen;
  title: Record<string, unknown>; org: { id: string | null; name: string | null } | null;
  provenance: string; provenanceCopy: string | null; current?: boolean | null;
}
export interface PassportHistoryRow {
  orgName: string | null; role: string | null; from: string | null; to: string | null;
  current: boolean; provenance: string; provenanceCopy: string | null;
}
export interface PassportAchievement {
  id: string; title: string; orgName: string | null; when: string | null;
  provenance: string; confirmedBy: string | null; provenanceCopy: string | null; withdrawable?: boolean;
}
export interface PassportReference {
  id: string; coachName: string; roleAtTime: string | null; orgName: string;
  relationship: string; fromYear: number | null; toYear: number | null;
  at: string | null; provenance: string; provenanceCopy: string;
  structured?: { strengths: string; development: string; summary: string };
}
export interface FootballPassport {
  viewer: string;
  player: { id: string; name: string; age: number; position: string | null; location: string | null; level: string | null };
  identity: { confirmed: boolean; assurance: string; label: string } | null;
  status: {
    currentClub: { orgName: string | null; role: string | null; since: string | null; provenance: string } | null;
    positions: { primary: string | null; secondary: string[] } | null;
    availability: string | null; availableFrom: string | null;
    representation: { agencyName: string; scope: string; since: string | null } | null;
  };
  note: string;
  timeline: PassportEvent[];
  clubHistory: PassportHistoryRow[];
  foldedConflicts: { entryId: string; into: string }[];
  conflicts: { code: string; authoritative: { orgName: string | null }; submitted: { orgName: string | null } }[];
  temporalConflicts: { code: string; kind: string; eventId?: string; key?: string }[];
  evidence: { fullMatches: number; clips: number; assessments: number; references: number; lastEvidenceDays: number | null; note: string };
  references: PassportReference[];
  achievements: PassportAchievement[];
  development: { active: number; completed: number };
  trials: { total: number; withReport: number };
  completeness: {
    evidenceCoverage: 'strong' | 'moderate' | 'limited';
    gaps: { id: string; version: number; category: string }[];
    eligibility: { satisfied: number; total: number; rulesVersion: number; missing: string[] };
  };
  sharing: { active: number };
  prefs: { bio: string | null; positions: { primary: string | null; secondary: string[] } | null; availability: string | null; availableFrom: string | null; publicSelections: string[] } | null;
}
export interface PassportShare { id: string; mode: 'public' | 'recruitment'; createdAt: number; expiresAt: number; revokedAt: number | null; views: number; createdBy: string }
export interface ShareCreated { share: PassportShare; url: string; note: string }

export type PassportActor =
  | { kind: 'player'; id: string }
  | { kind: 'guardian'; id: string; childId: string };

const base = (a: PassportActor) =>
  a.kind === 'player' ? '/player/football-passport' : `/guardian/children/${a.childId}/football-passport`;
const acct = (a: PassportActor) => a.id;

export interface PlayerM15 {
  passport(a: PassportActor): Promise<FootballPassport>;
  patchPrefs(a: PassportActor, body: Record<string, unknown>): Promise<void>;
  addCareer(a: PassportActor, body: { orgName: string; role?: string; from: string; to?: string }): Promise<{ provenance: string; note?: string }>;
  withdrawCareer(playerId: string, entryId: string): Promise<void>;
  addAchievement(a: PassportActor, body: { title: string; orgName?: string; when?: string }): Promise<void>;
  withdrawAchievement(playerId: string, achievementId: string): Promise<void>;
  fileCorrection(a: PassportActor, body: { targetType: string; targetId?: string; reason: string }): Promise<{ note: string }>;
  shares(a: PassportActor): Promise<PassportShare[]>;
  createShare(a: PassportActor, mode: 'public' | 'recruitment', expiresDays?: number): Promise<ShareCreated>;
  revokeShare(a: PassportActor, shareId: string): Promise<void>;
}

const live: PlayerM15 = {
  passport: (a) => req(base(a), acct(a)),
  patchPrefs: (a, body) => req(`${base(a)}/prefs`, acct(a), { method: 'PATCH', body: JSON.stringify(body) }),
  addCareer: (a, body) => req(`${base(a)}/career`, acct(a), { method: 'POST', body: JSON.stringify(body) }),
  withdrawCareer: (playerId, entryId) => req(`/player/football-passport/career/${entryId}/withdraw`, playerId, { method: 'POST' }),
  addAchievement: (a, body) => req(`${base(a)}/achievements`, acct(a), { method: 'POST', body: JSON.stringify(body) }),
  withdrawAchievement: (playerId, achievementId) => req(`/player/football-passport/achievements/${achievementId}/withdraw`, playerId, { method: 'POST' }),
  fileCorrection: (a, body) => req(`${base(a)}/corrections`, acct(a), { method: 'POST', body: JSON.stringify(body) }),
  shares: async (a) => (await req<{ items: PassportShare[] }>(`${base(a)}/shares`, acct(a))).items,
  createShare: (a, mode, expiresDays) => req(`${base(a)}/shares`, acct(a), { method: 'POST', body: JSON.stringify({ mode, expiresDays }) }),
  revokeShare: (a, shareId) => req(`${base(a)}/shares/${shareId}/revoke`, acct(a), { method: 'POST' }),
};

export const m15: PlayerM15 = DEMO ? m15mock : live;
