// Live data client — talks to scoutbox-server (EXPO_PUBLIC_API_URL).

import type { PlayerClient, SignupInput, Me, AttendanceInput, DemoIdentity } from './types';
import { ClientError } from './types';
import type { Availability, ContractStatus, InboxRequest } from '../domain/types';

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

// The server's seed identities, offered as demo logins.
const SEED_IDENTITIES: DemoIdentity[] = [
  { id: 'pl-adeyemi', name: 'Kola Adeyemi', position: 'ST' },
  { id: 'pl-svensson', name: 'Elias Svensson', position: 'RW' },
  { id: 'pl-mensah', name: 'Kwame Mensah', position: 'LW' },
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

  getInbox: (playerId) => request<InboxRequest[]>('/player/inbox', playerId),

  respond: (playerId, requestId, accept) =>
    request<void>(`/player/requests/${requestId}/respond`, playerId, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    }),

  setAcademyPlus: (playerId, enabled) =>
    request<void>('/player/academyplus', playerId, { method: 'POST', body: JSON.stringify({ enabled }) }),

  addMedia: (playerId, title) =>
    request<void>('/player/media', playerId, { method: 'POST', body: JSON.stringify({ title, kind: 'video' }) }),

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

  onChange: (cb) => {
    // SSE on web; polling elsewhere (native has no EventSource).
    if (typeof EventSource !== 'undefined') {
      const source = new EventSource(`${API_URL}/events`);
      source.onmessage = () => cb();
      return () => source.close();
    }
    const timer = setInterval(cb, 3000);
    return () => clearInterval(timer);
  },
};
