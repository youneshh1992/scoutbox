// M15 typed client (org side): the recruitment Football Passport — the
// server-built, viewer-filtered projection for this organisation, batch
// summaries for list surfaces, achievement confirmation and share-link
// resolution. The server re-runs every standing gate on each call; the
// client only renders honest errors when a wall applies.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM15 } from './m15demo';

export interface FpEvent {
  id: string; type: string; when: { display: string; precision: string };
  title: Record<string, unknown>; org: { id: string | null; name: string | null } | null;
  provenance: string; provenanceCopy: string | null; current?: boolean | null;
}
export interface FpHistoryRow {
  orgName: string | null; role: string | null; from: string | null; to: string | null;
  current: boolean; provenance: string; provenanceCopy: string | null;
}
export interface FpReference {
  id: string; coachName: string; roleAtTime: string | null; orgName: string;
  relationship: string; fromYear: number | null; toYear: number | null; at: string | null;
  provenance: string; provenanceCopy: string;
  structured?: { strengths: string; development: string; summary: string };
}
export interface FpAchievement { id: string; title: string; orgName: string | null; when: string | null; provenance: string; confirmedBy: string | null; provenanceCopy: string | null }
export interface RecruitmentPassport {
  viewer: string; shareMode?: string | null;
  player: { id: string; name: string; age: number; position: string | null; location: string | null; level: string | null };
  identity: { confirmed: boolean; assurance: string; label: string } | null;
  status: { currentClub: { orgName: string | null; role: string | null; since: string | null; provenance: string } | null; availability: string | null; representation: { agencyName: string; scope: string } | null };
  note: string;
  timeline: FpEvent[];
  clubHistory: FpHistoryRow[];
  evidence: { fullMatches: number; clips: number; assessments: number; references: number; lastEvidenceDays: number | null; note: string };
  references: FpReference[];
  achievements: FpAchievement[];
  assessments: { id: string; org: string | null; at: string | null; state: string }[];
  trials: { id: string; org: string; date: string | null; hasReport: boolean }[];
  availability: string | null;
  representation: { agencyName: string; scope: string } | null;
}
export interface FpSummary {
  playerId: string; position: string | null; age: number;
  currentClub: { name: string | null; provenance: string } | null;
  evidenceCoverage: 'strong' | 'moderate' | 'limited';
  lastEvidenceDays: number | null; references: number;
  availability: string | null; identityConfirmed: boolean;
}

export interface M15Api {
  passport(s: Session, playerId: string): Promise<RecruitmentPassport>;
  summaries(s: Session, ids: string[]): Promise<FpSummary[]>;
  confirmAchievement(s: Session, playerId: string, achievementId: string): Promise<void>;
  openShared(s: Session, token: string): Promise<RecruitmentPassport>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

export const httpM15: M15Api = {
  passport: (s, playerId) => req(`/org/players/${playerId}/football-passport`, { headers: H(s) }),
  summaries: async (s, ids) => {
    if (!ids.length) return [];
    const r = await req<{ items: FpSummary[] }>(`/org/football-passports?ids=${ids.slice(0, 100).join(',')}`, { headers: H(s) });
    return r.items;
  },
  confirmAchievement: (s, playerId, achievementId) =>
    req(`/org/players/${playerId}/football-passport/achievements/${achievementId}/confirm`, { method: 'POST', headers: H(s) }),
  openShared: (s, token) => req(`/org/passport/shared/${encodeURIComponent(token)}`, { headers: H(s) }),
};

export const m15: M15Api = DEMO_MODE ? demoM15 : httpM15;

/** Accepts a pasted share URL or a bare token and returns the token. */
export function shareTokenFrom(input: string): string {
  const trimmed = input.trim();
  const m = /passport\/shared\/([A-Za-z0-9_-]+)/.exec(trimmed);
  return m ? m[1] : trimmed;
}
