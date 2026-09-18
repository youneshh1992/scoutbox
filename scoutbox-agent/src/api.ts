// ScoutBox Agent — the core client (session, organisation list, notifications,
// live changes, safety reports). Auto-connects to localhost:4000; override
// with VITE_API_URL. VITE_DEMO=1 swaps in the self-contained in-browser demo
// (src/agentDemo.ts) used for static builds — the real product always talks
// to the server, which is where every rule is enforced.
//
// This file is the Agent counterpart of scoutbox-club/src/api.ts: same
// ApiError, same request contract, same session shape, a fraction of the
// surface. The Agent domain itself lives in agentApi.ts.

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
export const DEMO_MODE = import.meta.env.VITE_DEMO === '1';

export type OrgType = 'club' | 'agency';

export interface Org {
  id: string;
  name: string;
  type: OrgType;
  plan: 'Academy' | 'Pro' | 'Agency';
  trustedPartner: boolean;
  verified: boolean;
  safeguardingCertified?: boolean;
}

export interface Session {
  org: Org;
  userId: string;
  scoutName: string;
  role: string;
  /** Bearer session token minted at login — the server trusts nothing else. */
  token: string;
}

export interface Notification {
  id: string;
  ts: number;
  type: string;
  text: string;
  refId: string | null;
  read: boolean;
  repeatCount?: number;
}

export interface ReportInput {
  targetKind: 'player' | 'scout' | 'club';
  targetPlayerId?: string;
  targetScoutName?: string;
  targetOrgId?: string;
  reason: string;
  urgent: boolean;
}

export class ApiError extends Error {
  details: Record<string, unknown> | null = null;
  retryAfterS: number | null = null;
  retryable: boolean | null = null;
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
  static fromResponse(res: Response, body: Record<string, unknown> | null | undefined): ApiError {
    const b = (body ?? {}) as Record<string, unknown>;
    const e = new ApiError(res.status, String(b.error ?? 'UNKNOWN'), String(b.message ?? b.error ?? res.statusText));
    e.details = b;
    const ra = res.headers.get('retry-after');
    e.retryAfterS = ra && /^\d+$/.test(ra) ? Number(ra) : null;
    const rv = res.headers.get('x-scoutbox-retry');
    e.retryable = rv === 'retryable' ? true : rv === 'not-retryable' ? false : null;
    return e;
  }
}

export interface CoreApi {
  listOrgs(): Promise<Org[]>;
  login(orgId: string, scoutName: string, role: string, password?: string): Promise<Session>;
  getNotifications(s: Session): Promise<Notification[]>;
  markNotificationsRead(s: Session): Promise<void>;
  report(s: Session, input: ReportInput): Promise<void>;
  /** Subscribe to live changes; returns an unsubscribe fn. */
  onChange(s: Session | null, cb: (event: string, payload?: Record<string, unknown>) => void): () => void;
}

// ------------------------------------------------------------- http client

export function headers(s: Session): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${s.token}` };
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

export const httpCore: CoreApi = {
  // Agency organisations only: the server filters, the login refuses a club.
  listOrgs: () => request<Org[]>('/orgs?platform=agent'),

  async login(orgId, scoutName, role, password) {
    const r = await request<{ userId: string; role: string; org: Org; token: string }>('/auth/org/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, scoutName, role, password, platform: 'agent' }),
    });
    return { org: r.org, userId: r.userId, scoutName, role: r.role, token: r.token };
  },

  getNotifications: (s) => request<Notification[]>('/org/notifications', { headers: headers(s) }),
  markNotificationsRead: (s) => request<void>('/org/notifications/read', { method: 'POST', headers: headers(s) }),
  report: (s, input) => request<void>('/org/report', { method: 'POST', headers: headers(s), body: JSON.stringify(input) }),

  onChange(s, cb) {
    if (!s) return () => {};
    let source: EventSource | null = null;
    let closed = false;
    let dropped = false;
    let retry = 0;
    let lastEventId = 0;
    const connect = async () => {
      if (closed) return;
      try {
        const { ticket } = await request<{ ticket: string }>('/events/ticket', { method: 'POST', headers: headers(s) });
        if (closed) return;
        source = new EventSource(`${API_URL}/events?ticket=${encodeURIComponent(ticket)}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`);
        source.onopen = () => {
          retry = 0;
          if (dropped) { dropped = false; cb('reconnected', {}); }
          cb('sse_status', { connected: true });
        };
        source.onmessage = (e) => {
          if (e.lastEventId) lastEventId = Number(e.lastEventId) || lastEventId;
          try {
            const data = JSON.parse(e.data);
            cb(data.event, data);
          } catch { /* ignore malformed frames */ }
        };
        source.onerror = () => {
          source?.close();
          if (closed) return;
          dropped = true;
          cb('sse_status', { connected: false });
          window.setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(retry++, 4)));
        };
      } catch {
        if (closed) return;
        dropped = true;
        cb('sse_status', { connected: false });
        window.setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(retry++, 4)));
      }
    };
    void connect();
    return () => { closed = true; source?.close(); };
  },
};

import { demoCore } from './agentDemo';
export const api: CoreApi = DEMO_MODE ? demoCore : httpCore;
