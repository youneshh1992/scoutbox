// Live data client — talks to scoutbox-server (EXPO_PUBLIC_API_URL).

import type {
  PlayerClient, SignupInput, Me, AttendanceInput, DemoIdentity, ReportInput, ChildInput,
  Channel, AppNotification, Insights, FiledReport, PlayerFeedItem, PlayerCV, GuardianDigest,
  NotificationPrefs, DirectoryClub,
} from './types';
import { ClientError } from './types';
import type { Availability, ContractStatus, InboxRequest, ChildInboxItem, Guardian, GuardianInboxRequest, Drill } from '../domain/types';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

// Bearer-token session store, keyed by the account id the UI works with.
// Persisted so a reloaded tab keeps its sessions; the server can revoke any
// token at will (logout, deletion) — this is just the client's copy.
const TOKENS_KEY = 'scoutbox-player-tokens-v1';
const tokens = new Map<string, string>();
try {
  if (typeof localStorage !== 'undefined') {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}'))) tokens.set(k, String(v));
  }
} catch { /* fresh start */ }
function rememberToken(id: string, token: string | undefined) {
  if (!token) return;
  tokens.set(id, token);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(tokens)));
  } catch { /* memory copy still works */ }
}
const authHeader = (id?: string): Record<string, string> =>
  id && tokens.has(id) ? { authorization: `Bearer ${tokens.get(id)}` } : {};

async function request<T>(path: string, accountId?: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeader(accountId),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ClientError(body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

function guardianRequest<T>(path: string, guardianId: string, init?: RequestInit): Promise<T> {
  return request<T>(path, guardianId, init);
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

  signup: async (input: SignupInput) => {
    const r = await request<{ playerId: string; token?: string }>('/auth/player/signup', undefined, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    rememberToken(r.playerId, r.token);
    return r;
  },

  login: async (playerId, password) => {
    const r = await request<{ playerId: string; name: string; token?: string }>('/auth/player/login', undefined, {
      method: 'POST',
      body: JSON.stringify({ playerId, password }),
    });
    rememberToken(r.playerId, r.token);
    return r;
  },

  getMe: (playerId) => request<Me>('/player/me', playerId),

  getInbox: (playerId) => request<(InboxRequest | ChildInboxItem)[]>('/player/inbox', playerId),

  pair: async (code) => {
    const r = await request<{ playerId: string; name: string; token?: string }>('/auth/player/pair', undefined, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    rememberToken(r.playerId, r.token);
    return r;
  },

  respond: (playerId, requestId, accept, chosenSlot) =>
    request<void>(`/player/requests/${requestId}/respond`, playerId, {
      method: 'POST',
      body: JSON.stringify({ accept, chosenSlot }),
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

  updateStats: (playerId, stats, season) =>
    request<void>('/player/stats', playerId, { method: 'POST', body: JSON.stringify({ ...stats, season }) }),

  getDrills: (playerId) => request<Drill[]>('/player/drills', playerId),

  completeDrill: (playerId, drillId, value, videoDataUrl) =>
    request<void>(`/player/drills/${drillId}/complete`, playerId, { method: 'POST', body: JSON.stringify({ value, videoDataUrl }) }),

  agingUpComplete: (playerId) =>
    request<void>('/player/aging-up/complete', playerId, { method: 'POST' }),

  getPrefs: (playerId) =>
    request<{ prefs: NotificationPrefs | null }>('/player/prefs', playerId).then((r) => r.prefs),

  setPrefs: (playerId, prefs) =>
    request<void>('/player/prefs', playerId, { method: 'POST', body: JSON.stringify(prefs) }),

  getExport: (playerId) => request<Record<string, unknown>>('/player/export', playerId),

  deleteAccount: (playerId) =>
    request<void>('/player/account', playerId, { method: 'DELETE' }),

  getDirectory: () => request<DirectoryClub[]>('/orgs/directory'),

  report: (playerId, input: ReportInput) =>
    request<void>('/player/report', playerId, { method: 'POST', body: JSON.stringify(input) }),

  block: (playerId, orgId, reason) =>
    request<void>('/player/block', playerId, { method: 'POST', body: JSON.stringify({ orgId, reason }) }),

  // ---- guardian surface ----
  guardianSignup: async (name, email, password) => {
    const r = await request<{ guardianId: string; token?: string; devEmailCode?: string }>('/auth/guardian/signup', undefined, {
      method: 'POST', body: JSON.stringify({ name, email, password }),
    });
    rememberToken(r.guardianId, r.token);
    return r;
  },

  guardianVerifyEmail: (guardianId, code) =>
    request<void>('/auth/guardian/verify-email', undefined, { method: 'POST', body: JSON.stringify({ guardianId, code }) }),

  guardianLogin: async (idOrEmail, password) => {
    const body = idOrEmail.includes('@') ? { email: idOrEmail, password } : { guardianId: idOrEmail, password };
    const r = await request<{ guardianId: string; guardian: Guardian; token?: string }>('/auth/guardian/login', undefined, { method: 'POST', body: JSON.stringify(body) });
    rememberToken(r.guardianId, r.token);
    return r;
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

  guardianRespond: (guardianId, requestId, accept, chosenSlot) =>
    guardianRequest<void>(`/guardian/requests/${requestId}/respond`, guardianId, { method: 'POST', body: JSON.stringify({ accept, chosenSlot }) }),

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

  guardianPairingCode: (guardianId, childId) =>
    guardianRequest<{ code: string; expiresAt: number }>(`/guardian/children/${childId}/pairing-code`, guardianId, { method: 'POST' }),

  guardianPrefs: (guardianId) =>
    guardianRequest<{ prefs: NotificationPrefs | null }>('/guardian/prefs', guardianId).then((r) => r.prefs),

  guardianSetPrefs: (guardianId, prefs) =>
    guardianRequest<void>('/guardian/prefs', guardianId, { method: 'POST', body: JSON.stringify(prefs) }),

  guardianExport: (guardianId) => guardianRequest<Record<string, unknown>>('/guardian/export', guardianId),

  guardianDeleteChild: (guardianId, childId) =>
    guardianRequest<void>(`/guardian/children/${childId}`, guardianId, { method: 'DELETE' }),

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
