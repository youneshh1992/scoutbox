// M16 player/guardian data surface — Box Cam + Box Training.
// The Box Session lifecycle (create → start with liveness → stream observed
// events → complete) is driven server-side: the server owns identity, the
// nonce and the derived result. This client never asserts verified time,
// rep counts, verification state or provenance — those come back from the
// server. The demo mirror simulates observations honestly, always labelled.
import { m12Request as req } from './httpClient';
import { m16mock } from './m16mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface BoxDrill {
  id: string; version: number; title: string; category: string; summary: string;
  targetTypes: string[]; verificationCapabilities: string[];
  repSupport: string; repSupportNote: string | null;
  setup: { orientation: string; distanceM: number; space: string; equipment: string[]; framing: string; demo: string };
  safetyNotes: string; restGuidance: string | null; ageAppropriateness: string;
}
export interface BoxTarget { type: 'duration' | 'repetitions' | 'sets' | 'combined'; value: number; sets?: number; repsPerSet?: number }
export interface BoxSession {
  id: string; playerId: string; drillId: string; drillVersion: number; drillTitle: string;
  assignmentId: string | null; target: BoxTarget; status: string;
  sessionDurationMs: number | null; verifiedActiveMs: number | null;
  verifiedReps: number | null; setsCompleted: number | null; targetCompleted: boolean | null;
  verificationState: string | null; verificationReasons: string[]; stateCopy: string | null;
  quality: string | null; interruptions: number; provider: string; providerVersion: number;
  simulated: boolean; note: string | null;
  provenance: string | null; provenanceLabel: string | null; provenanceDetail: string | null;
  endedAt: number | null; createdAt: number;
}
export interface CreatedSession { session: BoxSession; nonce: string; livenessChallenge: string; livenessNote: string; drillSetup: BoxDrill['setup']; readyCheck: { automated: string[]; unableToCheckAutomatically: string[] } }
export interface BoxAssignment {
  id: string; orgName: string; drillId: string; drillTitle: string; target: BoxTarget;
  frequencyPerWeek: number | null; dueDate: string | null; instructions: string | null;
  state: string; sessionsCompleted: number;
  lastResult: { verifiedActive: string; verifiedReps: number | null; targetCompleted: boolean | null; verificationState: string; statusLabel: string } | null;
}
export interface BoxChallenge {
  id: string; title: string; publisher: { kind: string; orgName?: string }; drillId: string; drillTitle: string;
  metric: string; targetTotal: number; startsAt: number; endsAt: number; adultOnly: boolean;
  participants: number; disclaimer: string;
  entry: { id: string; status: string; progress: number; completedAt: number | null } | null;
}
export interface BoxDashboard {
  streakWeeks: number; streakNote: string;
  bests: { drillId: string; drillVersion: number; bestActiveMs: number; bestActive: string; bestReps: number | null }[];
  recent: BoxSession[]; assignments: BoxAssignment[];
}
export interface DevelopmentPlan {
  objectives: { id: string; orgName: string | null; status: string; objectives: string[]; assignments: BoxAssignment[] }[];
  assignments: BoxAssignment[];
  activity: { days: number; boxSessions: number; verifiedActiveMs: number; assigned: number; assignedCompleted: number; focus: { category: string; activeMs: number }[]; note: string };
  note: string;
}
export interface BoxPrefs { shareDevelopmentActivity: 'private' | 'recruitment'; retainClips: boolean }
export type BoxEvent = Record<string, unknown> & { seq: number; type: string };

export type BoxActor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };
const base = (a: BoxActor) => a.kind === 'player' ? '/player/box-cam' : `/guardian/children/${a.childId}/box-cam`;

export interface PlayerM16 {
  drills(playerId: string): Promise<{ drills: BoxDrill[]; providers: { id: string; status: string; label: string; testOnly: boolean; note: string }[] }>;
  dashboard(a: BoxActor): Promise<BoxDashboard>;
  developmentPlan(a: BoxActor): Promise<DevelopmentPlan>;
  sessions(a: BoxActor): Promise<BoxSession[]>;
  createSession(playerId: string, body: { drillId: string; target: BoxTarget; provider?: string; assignmentId?: string; challengeEntryId?: string }): Promise<CreatedSession>;
  startSession(playerId: string, id: string, nonce: string, liveness: string): Promise<{ session: BoxSession }>;
  sendEvents(playerId: string, id: string, nonce: string, batch: BoxEvent[]): Promise<{ accepted: number; lastSeq: number }>;
  complete(playerId: string, id: string, nonce: string): Promise<{ session: BoxSession }>;
  cancel(playerId: string, id: string, nonce: string): Promise<{ session: BoxSession }>;
  addNote(playerId: string, id: string, note: string): Promise<{ session: BoxSession }>;
  challenges(a: BoxActor): Promise<BoxChallenge[]>;
  joinChallenge(a: BoxActor, challengeId: string): Promise<{ challenge: BoxChallenge }>;
  assignments(a: BoxActor): Promise<BoxAssignment[]>;
  acceptAssignment(a: BoxActor, id: string): Promise<void>;
  dispute(a: BoxActor, sessionId: string, reason: string): Promise<{ note: string }>;
  prefs(a: BoxActor): Promise<BoxPrefs>;
  setPrefs(a: BoxActor, body: Partial<BoxPrefs>): Promise<{ prefs: BoxPrefs }>;
}

const live: PlayerM16 = {
  drills: (playerId) => req('/player/box-cam/drills', playerId),
  dashboard: (a) => req(`${base(a)}/dashboard`, a.id),
  developmentPlan: (a) => req(`${base(a)}/development-plan`, a.id),
  sessions: async (a) => (await req<{ items: BoxSession[] }>(`${base(a)}/sessions`, a.id)).items,
  createSession: (playerId, body) => req('/player/box-cam/sessions', playerId, { method: 'POST', body: JSON.stringify(body) }),
  startSession: (playerId, id, nonce, liveness) => req(`/player/box-cam/sessions/${id}/start`, playerId, { method: 'POST', body: JSON.stringify({ nonce, liveness }) }),
  sendEvents: (playerId, id, nonce, batch) => req(`/player/box-cam/sessions/${id}/events`, playerId, { method: 'POST', body: JSON.stringify({ nonce, batch }) }),
  complete: (playerId, id, nonce) => req(`/player/box-cam/sessions/${id}/complete`, playerId, { method: 'POST', body: JSON.stringify({ nonce }) }),
  cancel: (playerId, id, nonce) => req(`/player/box-cam/sessions/${id}/cancel`, playerId, { method: 'POST', body: JSON.stringify({ nonce }) }),
  addNote: (playerId, id, note) => req(`/player/box-cam/sessions/${id}/note`, playerId, { method: 'POST', body: JSON.stringify({ note }) }),
  challenges: async (a) => (await req<{ items: BoxChallenge[] }>(`${base(a)}/challenges`, a.id)).items,
  joinChallenge: (a, challengeId) => a.kind === 'player'
    ? req(`/player/box-cam/challenges/${challengeId}/join`, a.id, { method: 'POST', body: JSON.stringify({}) })
    : req(`/guardian/children/${a.childId}/box-cam/challenges/${challengeId}/join`, a.id, { method: 'POST', body: JSON.stringify({}) }),
  assignments: async (a) => (await req<{ items: BoxAssignment[] }>(`${base(a)}/assignments`, a.id)).items,
  acceptAssignment: (a, id) => a.kind === 'player'
    ? req(`/player/box-cam/assignments/${id}/accept`, a.id, { method: 'POST', body: JSON.stringify({}) })
    : req(`/guardian/children/${a.childId}/box-cam/assignments/${id}/accept`, a.id, { method: 'POST', body: JSON.stringify({}) }),
  dispute: (a, sessionId, reason) => a.kind === 'player'
    ? req(`/player/box-cam/sessions/${sessionId}/dispute`, a.id, { method: 'POST', body: JSON.stringify({ reason }) })
    : req(`/guardian/children/${a.childId}/box-cam/sessions/${sessionId}/dispute`, a.id, { method: 'POST', body: JSON.stringify({ reason }) }),
  prefs: async (a) => (await req<{ prefs: BoxPrefs }>(`${base(a)}/prefs`, a.id)).prefs,
  setPrefs: (a, body) => req(`${base(a)}/prefs`, a.id, { method: 'PATCH', body: JSON.stringify(body) }),
};

export const m16: PlayerM16 = DEMO ? m16mock : live;
