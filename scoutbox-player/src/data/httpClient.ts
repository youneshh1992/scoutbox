// Live data client — talks to scoutbox-server (EXPO_PUBLIC_API_URL).

import type {
  PlayerClient, SignupInput, Me, AttendanceInput, DemoIdentity, ReportInput, ChildInput,
  Channel, AppNotification, Insights, FiledReport, PlayerFeedItem, PlayerCV, GuardianDigest,
} from './types';
import { ClientError } from './types';
import type { Availability, ContractStatus, InboxRequest, ChildInboxItem, Guardian, GuardianInboxRequest, Drill } from '../domain/types';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, playerId?: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(playerId ? { 'x-player-id': playerId } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ClientError(body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

function guardianRequest<T>(path: string, guardianId: string, init?: RequestInit): Promise<T> {
  return request<T>(path, undefined, { ...init, headers: { 'x-guardian-id': guardianId, ...init?.headers } });
}

// The server's seed identities, offered as demo logins. Child identities are
// entered from the guardian's account in the real flow; the child login here
// models the child's own device session.
const SEED_IDENTITIES: DemoIdentity[] = [
  { id: 'pl-adeyemi', name: 'Kola Adeyemi', position: 'ST' },
  { id: 'pl-svensson', name: 'Elias Svensson', position: 'RW' },
  { id: 'pl-guni', name: 'Guni Adebayo (14, child account)', position: 'RW' },
  { id: 'pl-carvalho', name: 'Mateus Carvalho', position: 'CM' },
];

export const httpClient: PlayerClient = {
  mode: 'live',

  listDemoIdentities: async () => SEED_IDENTITIES,

  signup: (input: SignupInput) =>
    request<{ playerId: string }>('/auth/player/signup', undefined, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getMe: (playerId) => request<Me>('/player/me', playerId),

  getInbox: (playerId) => request<(InboxRequest | ChildInboxItem)[]>('/player/inbox', playerId),

  respond: (playerId, requestId, accept) =>
    request<void>(`/player/requests/${requestId}/respond`, playerId, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    }),

  setAcademyPlus: (playerId, enabled) =>
    request<void>('/player/academyplus', playerId, { method: 'POST', body: JSON.stringify({ enabled }) }),

  addMedia: (playerId, title, dataUrl, attendanceId) =>
    request<void>('/player/media', playerId, { method: 'POST', body: JSON.stringify({ title, kind: 'video', dataUrl, attendanceId }) }),

  mediaUrl: (path) => (path ? (path.startsWith('data:') ? path : `${API_URL}${path}`) : null),

  getChannels: (playerId) => request<Channel[]>('/player/channels', playerId),

  sendMessage: (playerId, channelId, text, attachMediaId) =>
    request<void>(`/player/channels/${channelId}/messages`, playerId, { method: 'POST', body: JSON.stringify({ text, attachMediaId }) }),

  markChannelRead: (playerId, channelId) =>
    request<void>(`/player/channels/${channelId}/read`, playerId, { method: 'POST' }),

  sendTyping: (playerId, channelId) =>
    request<void>(`/player/channels/${channelId}/typing`, playerId, { method: 'POST' }),

  getFeed: (playerId) => request<PlayerFeedItem[]>('/player/feed', playerId),

  getCv: (playerId) => request<PlayerCV>('/player/cv', playerId),

  getNotifications: (playerId) => request<AppNotification[]>('/player/notifications', playerId),

  markNotificationsRead: (playerId) =>
    request<void>('/player/notifications/read', playerId, { method: 'POST' }),

  getInsights: (playerId) => request<Insights>('/player/insights', playerId),

  getMyReports: (playerId) => request<FiledReport[]>('/player/reports', playerId),

  setMedicalShared: (playerId, shared) =>
    request<void>('/player/medical/share', playerId, { method: 'POST', body: JSON.stringify({ shared }) }),

  setAvailability: (playerId, availability?: Availability, contractStatus?: ContractStatus) =>
    request<void>('/player/availability', playerId, {
      method: 'POST',
      body: JSON.stringify({ availability, contractStatus }),
    }),

  addAttendance: (playerId, input: AttendanceInput) =>
    request<void>('/player/attendance', playerId, { method: 'POST', body: JSON.stringify(input) }),

  addTimeline: (playerId, year, event) =>
    request<void>('/player/timeline', playerId, { method: 'POST', body: JSON.stringify({ year, event }) }),

  updateStats: (playerId, stats) =>
    request<void>('/player/stats', playerId, { method: 'POST', body: JSON.stringify(stats) }),

  getDrills: (playerId) => request<Drill[]>('/player/drills', playerId),

  completeDrill: (playerId, drillId, value, videoDataUrl) =>
    request<void>(`/player/drills/${drillId}/complete`, playerId, { method: 'POST', body: JSON.stringify({ value, videoDataUrl }) }),

  report: (playerId, input: ReportInput) =>
    request<void>('/player/report', playerId, { method: 'POST', body: JSON.stringify(input) }),

  block: (playerId, orgId, reason) =>
    request<void>('/player/block', playerId, { method: 'POST', body: JSON.stringify({ orgId, reason }) }),

  // ---- guardian surface ----
  guardianSignup: (name, email) =>
    request<{ guardianId: string }>('/auth/guardian/signup', undefined, { method: 'POST', body: JSON.stringify({ name, email }) }),

  guardianLogin: async (idOrEmail) => {
    const body = idOrEmail.includes('@') ? { email: idOrEmail } : { guardianId: idOrEmail };
    return request<{ guardianId: string; guardian: Guardian }>('/auth/guardian/login', undefined, { method: 'POST', body: JSON.stringify(body) });
  },

  guardianMe: (guardianId) => guardianRequest<Guardian>('/guardian/me', guardianId),

  guardianVerifyId: (guardianId, documentType, documentRef) =>
    guardianRequest<void>('/guardian/verify-id', guardianId, { method: 'POST', body: JSON.stringify({ documentType, documentRef }) }),

  guardianAcceptDisclaimer: (guardianId) =>
    guardianRequest<void>('/guardian/disclaimer', guardianId, { method: 'POST', body: JSON.stringify({ accepted: true }) }),

  guardianChildren: (guardianId) => guardianRequest<Me[]>('/guardian/children', guardianId),

  guardianAddChild: (guardianId, input: ChildInput) =>
    guardianRequest<{ playerId: string }>('/guardian/children', guardianId, { method: 'POST', body: JSON.stringify(input) }),

  guardianInbox: (guardianId) => guardianRequest<GuardianInboxRequest[]>('/guardian/inbox', guardianId),

  guardianRespond: (guardianId, requestId, accept) =>
    guardianRequest<void>(`/guardian/requests/${requestId}/respond`, guardianId, { method: 'POST', body: JSON.stringify({ accept }) }),

  guardianLog: (guardianId) => guardianRequest<{ id: string; ts: number; type: string; orgName: string; scoutName: string; playerId: string }[]>('/guardian/log', guardianId),

  guardianSetMedicalShared: (guardianId, childId, shared) =>
    guardianRequest<void>(`/guardian/children/${childId}/medical/share`, guardianId, { method: 'POST', body: JSON.stringify({ shared }) }),

  guardianReport: (guardianId, input: ReportInput) =>
    guardianRequest<void>('/guardian/report', guardianId, { method: 'POST', body: JSON.stringify(input) }),

  guardianBlock: (guardianId, orgId, childId, reason) =>
    guardianRequest<void>('/guardian/block', guardianId, { method: 'POST', body: JSON.stringify({ orgId, playerId: childId, reason }) }),

  guardianChannels: (guardianId) => guardianRequest<Channel[]>('/guardian/channels', guardianId),

  guardianSendMessage: (guardianId, channelId, text, attachMediaId) =>
    guardianRequest<void>(`/guardian/channels/${channelId}/messages`, guardianId, { method: 'POST', body: JSON.stringify({ text, attachMediaId }) }),

  guardianMarkChannelRead: (guardianId, channelId) =>
    guardianRequest<void>(`/guardian/channels/${channelId}/read`, guardianId, { method: 'POST' }),

  guardianSendTyping: (guardianId, channelId) =>
    guardianRequest<void>(`/guardian/channels/${channelId}/typing`, guardianId, { method: 'POST' }),

  guardianDigest: (guardianId) => guardianRequest<GuardianDigest>('/guardian/digest', guardianId),

  guardianNotifications: (guardianId) => guardianRequest<AppNotification[]>('/guardian/notifications', guardianId),

  guardianMarkNotificationsRead: (guardianId) =>
    guardianRequest<void>('/guardian/notifications/read', guardianId, { method: 'POST' }),

  guardianChildInsights: (guardianId, childId) =>
    guardianRequest<Insights>(`/guardian/children/${childId}/insights`, guardianId),

  guardianSetChildAvailability: (guardianId, childId, availability) =>
    guardianRequest<void>(`/guardian/children/${childId}/availability`, guardianId, { method: 'POST', body: JSON.stringify({ availability }) }),

  guardianAddCoGuardian: (guardianId, name, email) =>
    guardianRequest<void>('/guardian/coguardian', guardianId, { method: 'POST', body: JSON.stringify({ name, email }) }),

  guardianReports: (guardianId) => guardianRequest<FiledReport[]>('/guardian/reports', guardianId),

  onChange: (cb) => {
    // SSE on web; polling elsewhere (native has no EventSource).
    if (typeof EventSource !== 'undefined') {
      const source = new EventSource(`${API_URL}/events`);
      source.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          cb(data.event, data);
        } catch {
          cb();
        }
      };
      return () => source.close();
    }
    const timer = setInterval(() => cb(), 3000);
    return () => clearInterval(timer);
  },
};
