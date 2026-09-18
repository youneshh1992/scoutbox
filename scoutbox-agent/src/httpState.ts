// M18.2 — one reading of an HTTP failure for every screen.
//
// Before this, each screen mapped a handful of codes it knew about and fell
// back to the server's message for everything else, so a 429 read one way in
// Rooms and another in Briefs, a 5xx sometimes showed internal wording, and
// nothing anywhere honoured Retry-After. This module turns an ApiError into
// the one thing a screen needs: what KIND of failure it is, what to say, and
// whether "Try again" is a sensible offer.
//
// Machine codes stay available on the error for anything that needs them;
// they are never the primary message.
import { ApiError } from './api';
import { t } from './i18n';

export type HttpStateKind =
  | 'session_expired'  // 401 — back to sign-in through the normal auth flow
  | 'forbidden'        // 403 — a clear, non-technical refusal
  | 'not_found'        // 404 — identical for "never existed" and "not yours"
  | 'conflict'         // 409 — the shared conflict UX (conflict.tsx)
  | 'too_large'        // 413
  | 'rate_limited'     // 429 — with the wait, from Retry-After
  | 'unavailable'      // 5xx / network — generic, retryable
  | 'invalid'          // other 4xx — the server's own wording is the message
  | 'unknown';

export interface HttpState {
  kind: HttpStateKind;
  /** What the person should read. Never a status number, never a code. */
  message: string;
  /** Whether offering "Try again" makes sense. */
  retryable: boolean;
  /** Seconds to wait before a retry, when the server said so. */
  retryAfterS: number | null;
  /** Machine detail for callers that need it. Not for display. */
  code: string | null;
  status: number | null;
}

export function httpState(e: unknown): HttpState {
  if (e instanceof ApiError) {
    const code = e.code ?? null;
    const status = e.status;
    // The server's own retryability header wins when it spoke; the status
    // class decides otherwise.
    const retryable = e.retryable ?? (status === 429 || status >= 500);
    switch (true) {
      case status === 401:
        return { kind: 'session_expired', message: t('http.sessionExpired'), retryable: false, retryAfterS: null, code, status };
      case status === 403:
        return { kind: 'forbidden', message: t('http.forbidden'), retryable: false, retryAfterS: null, code, status };
      case status === 404:
        return { kind: 'not_found', message: t('http.notFound'), retryable: false, retryAfterS: null, code, status };
      case status === 409:
        return { kind: 'conflict', message: t('common.conflict'), retryable: false, retryAfterS: null, code, status };
      case status === 413:
        return { kind: 'too_large', message: t('http.tooLarge'), retryable: false, retryAfterS: null, code, status };
      case status === 429: {
        const s = e.retryAfterS ?? null;
        const msg = s ? t('http.rateLimitedIn').replace('{s}', String(s)) : t('http.rateLimited');
        return { kind: 'rate_limited', message: msg, retryable: true, retryAfterS: s, code, status };
      }
      case status >= 500:
        return { kind: 'unavailable', message: t('http.unavailable'), retryable, retryAfterS: null, code, status };
      default:
        // A validation-style 4xx: the server wrote a human sentence for it.
        return { kind: 'invalid', message: e.message || t('http.unknown'), retryable: false, retryAfterS: null, code, status };
    }
  }
  // A fetch that never reached the server (offline, DNS, CORS).
  if (e instanceof TypeError) {
    return { kind: 'unavailable', message: t('http.offline'), retryable: true, retryAfterS: null, code: null, status: null };
  }
  return { kind: 'unknown', message: e instanceof Error && e.message ? e.message : t('http.unknown'), retryable: false, retryAfterS: null, code: null, status: null };
}

/** The message alone, for callers that only toast. */
export const httpMessage = (e: unknown) => httpState(e).message;
