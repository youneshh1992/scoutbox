// M13 player/guardian data surface: private suitability preferences +
// opportunity fit, consent-based transitions, adult representation, coarse
// exposure, and action-required acknowledgements.
// Live implementation shares httpClient's per-account bearer tokens; the
// demo mirror lives in m13mock.ts (same EXPO_PUBLIC_DEMO flag).
import { m12Request as req } from './httpClient';
import { m13mock } from './m13mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface Slot { day: string; start: string; end: string; tz: string; label?: string | null }
export interface Preferences {
  commitments: Slot[]; availableSlots: Slot[];
  travelLimitKm: number | null; transport: string | null; relocation: string | null;
  ambitions: string | null; environment: string[]; accessibility: string[];
  compensation: { maxFeeMinor: number | null; currency: string; expensesNeeded: boolean };
  updatedAt: number | null;
}
export interface Verdict { dimension: string; verdict: 'compatible' | 'conflict' | 'unknown'; reason: string; source: string }
export interface TransitionCase {
  id: string; playerId: string; status: string; note: string | null;
  periodEndsAt: number; placement: { orgName: string; at: number } | null;
  recipients: { orgId: string; orgName: string; grantedAt: number; expiresAt: number; revokedAt: number | null; viewedAt: number | null }[];
  pack: { mediaIds: string[]; evidenceIds: string[]; feedbackIds: string[] };
  history: { at: number; byName: string; action: string }[];
}
export interface RepresentationView {
  id: string; agencyName: string; representativeName: string; scope: string; status: string;
  endAt: number | null; credential: { note: string; reviewStatus: string; honest: string } | null;
  history: { at: number; byName: string; action: string }[];
}
export interface ExposureView { windowDays: number; appearedInSearches: string; profileViews: string; clubs: string; note: string }
export interface AckNotification { id: string; ts: number; type: string; text: string; actionRequired: { deadline: number | null; ackedAt: number | null } | null }

// Every method names its acting account explicitly, like PlayerM12:
// player methods take the playerId; guardian methods take (guardianId, childId).
export interface PlayerM13 {
  getPreferences(playerId: string): Promise<{ preferences: Preferences; note?: string }>;
  savePreferences(playerId: string, patch: Partial<Preferences>): Promise<Preferences>;
  suitability(playerId: string, oppId: string): Promise<{ verdicts: Verdict[]; note?: string }>;
  shareSuitability(playerId: string, applicationId: string, share: boolean): Promise<void>;
  listTransitions(playerId: string): Promise<TransitionCase[]>;
  openTransition(playerId: string, input: { mediaIds: string[]; note?: string }): Promise<TransitionCase>;
  addRecipient(playerId: string, id: string, orgId: string): Promise<void>;
  revokeRecipient(playerId: string, id: string, orgId: string): Promise<{ honest: string }>;
  placeTransition(playerId: string, id: string, orgId: string): Promise<void>;
  listRepresentation(playerId: string): Promise<RepresentationView[]>;
  actRepresentation(playerId: string, id: string, action: 'confirm' | 'withdraw' | 'dispute', reason?: string): Promise<RepresentationView>;
  exposure(playerId: string): Promise<ExposureView>;
  ackList(playerId: string): Promise<AckNotification[]>;
  ack(playerId: string, id: string): Promise<void>;
  gGetPreferences(guardianId: string, childId: string): Promise<{ preferences: Preferences }>;
  gSavePreferences(guardianId: string, childId: string, patch: Partial<Preferences>): Promise<Preferences>;
  gSuitability(guardianId: string, childId: string, oppId: string): Promise<{ verdicts: Verdict[] }>;
  gShareSuitability(guardianId: string, childId: string, applicationId: string, share: boolean): Promise<void>;
  gListTransitions(guardianId: string): Promise<TransitionCase[]>;
  gOpenTransition(guardianId: string, childId: string, input: { mediaIds: string[]; note?: string }): Promise<TransitionCase>;
  gAddRecipient(guardianId: string, id: string, orgId: string): Promise<void>;
  gRevokeRecipient(guardianId: string, id: string, orgId: string): Promise<{ honest: string }>;
  gAckList(guardianId: string): Promise<AckNotification[]>;
  gAck(guardianId: string, id: string): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const post = (path: string, id: string, body?: unknown, method = 'POST') =>
  req<any>(path, id, { method, body: JSON.stringify(body ?? {}) });
const get = (path: string, id: string) => req<any>(path, id);

const live: PlayerM13 = {
  getPreferences: (pid) => get('/player/preferences', pid),
  savePreferences: async (pid, patch) => (await post('/player/preferences', pid, patch, 'PUT')).preferences,
  suitability: (pid, oppId) => get(`/player/suitability/${oppId}`, pid),
  shareSuitability: (pid, applicationId, share) => post('/player/suitability/share', pid, { applicationId, share }),
  listTransitions: async (pid) => (await get('/player/transitions', pid)).items,
  openTransition: async (pid, input) => (await post('/player/transitions', pid, { pack: { mediaIds: input.mediaIds }, note: input.note })).transition,
  addRecipient: (pid, id, orgId) => post(`/player/transitions/${id}/recipients`, pid, { orgId }),
  revokeRecipient: (pid, id, orgId) => post(`/player/transitions/${id}/revoke-recipient`, pid, { orgId }),
  placeTransition: (pid, id, orgId) => post(`/player/transitions/${id}/place`, pid, { orgId }),
  listRepresentation: async (pid) => (await get('/player/representation', pid)).items,
  actRepresentation: async (pid, id, action, reason) => (await post(`/player/representation/${id}/${action}`, pid, { reason })).representation,
  exposure: (pid) => get('/player/exposure', pid),
  ackList: async (pid) => ((await get('/player/notifications', pid)) as AckNotification[]).filter((n) => n.actionRequired),
  ack: (pid, id) => post(`/player/notifications/${id}/ack`, pid),
  gGetPreferences: (gid, cid) => get(`/guardian/children/${cid}/preferences`, gid),
  gSavePreferences: async (gid, cid, patch) => (await post(`/guardian/children/${cid}/preferences`, gid, patch, 'PUT')).preferences,
  gSuitability: (gid, cid, oppId) => get(`/guardian/children/${cid}/suitability/${oppId}`, gid),
  gShareSuitability: (gid, cid, applicationId, share) => post(`/guardian/children/${cid}/suitability/share`, gid, { applicationId, share }),
  gListTransitions: async (gid) => (await get('/guardian/children-transitions', gid)).items,
  gOpenTransition: async (gid, cid, input) => (await post(`/guardian/children/${cid}/transitions`, gid, { pack: { mediaIds: input.mediaIds }, note: input.note })).transition,
  gAddRecipient: (gid, id, orgId) => post(`/guardian/children-transitions/${id}/recipients`, gid, { orgId }),
  gRevokeRecipient: (gid, id, orgId) => post(`/guardian/children-transitions/${id}/revoke-recipient`, gid, { orgId }),
  gAckList: async (gid) => ((await get('/guardian/notifications', gid)) as AckNotification[]).filter((n) => n.actionRequired),
  gAck: (gid, id) => post(`/guardian/notifications/${id}/ack`, gid),
};

export const m13: PlayerM13 = DEMO ? m13mock : live;
