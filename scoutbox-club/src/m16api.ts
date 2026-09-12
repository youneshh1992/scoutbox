// M16 typed client (org side): coach-assigned Box Training and Box
// Challenges. The server re-runs every standing gate on each call; the
// coach only ever receives session RESULTS, never raw home footage.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM16 } from './m16demo';

export interface BoxDrill { id: string; title: string; category: string; summary: string; targetTypes: string[]; verificationCapabilities: string[]; repSupport: string; repSupportNote: string | null }
export interface BoxTarget { type: string; value: number }
export interface BoxAssignmentRow {
  id: string; playerId: string; orgName: string; drillId: string; drillTitle: string; target: BoxTarget;
  frequencyPerWeek: number | null; dueDate: string | null; instructions: string | null; state: string;
  sessionsCompleted: number;
  lastResult: { verifiedActive: string; verifiedReps: number | null; targetCompleted: boolean | null; verificationState: string; statusLabel: string } | null;
}
export interface BoxAssignments { items: BoxAssignmentRow[]; summary: { assigned: number; completed: number; partial: number; notStarted: number }; note: string }
export interface BoxChallengeRow { id: string; title: string; drillTitle: string; metric: string; targetTotal: number; startsAt: number; endsAt: number; participants: number }

export interface M16Api {
  drills(s: Session): Promise<BoxDrill[]>;
  assignments(s: Session, playerId?: string): Promise<BoxAssignments>;
  createAssignment(s: Session, input: { playerId: string; drillId: string; target: BoxTarget; frequencyPerWeek?: number; instructions?: string; dueDate?: string }): Promise<{ assignment: BoxAssignmentRow }>;
  cancelAssignment(s: Session, id: string): Promise<{ assignment: BoxAssignmentRow }>;
  challenges(s: Session): Promise<BoxChallengeRow[]>;
  createChallenge(s: Session, input: { title: string; drillId: string; metric: string; targetTotal: number; days: number; adultOnly?: boolean }): Promise<{ challenge: BoxChallengeRow }>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

export const httpM16: M16Api = {
  drills: async (s) => (await req<{ drills: BoxDrill[] }>('/org/box-cam/drills', { headers: H(s) })).drills,
  assignments: (s, playerId) => req(`/org/box-cam/assignments${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ''}`, { headers: H(s) }),
  createAssignment: (s, input) => req('/org/box-cam/assignments', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  cancelAssignment: (s, id) => req(`/org/box-cam/assignments/${id}/cancel`, { method: 'POST', headers: H(s), body: '{}' }),
  challenges: async (s) => (await req<{ items: BoxChallengeRow[] }>('/org/box-cam/challenges', { headers: H(s) })).items,
  createChallenge: (s, input) => req('/org/box-cam/challenges', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
};

export const m16: M16Api = DEMO_MODE ? demoM16 : httpM16;
