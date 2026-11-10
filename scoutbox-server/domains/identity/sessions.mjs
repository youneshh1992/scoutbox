// Bearer sessions, logout, the /auth limiters and the development-login refusal. A login mints a bearer token and
// every authenticated route resolves the caller from it; nothing trusts a client-sent id. Expiry is decided in one
// place (the sessions repository) and applied wherever a session is resolved: the bearer lookup, the event-stream
// connect and a signed media link. The token is never stored: the table holds its hash, and `createSession` is the only
// place a token exists server side, as the value it hands the login handler.
import { makeRateLimiter } from '../../adapters.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';

export function createSessionAccess({ sessions }) {
  if (typeof sessions?.create !== 'function' || typeof sessions?.byToken !== 'function') throw new TypeError('createSessionAccess needs the sessions repository');
  // The session's sid is a non-secret identifier that media URLs are bound to: the URL dies with the session.
  const createSession = (kind, refId, extra = {}) => sessions.create(kind, refId, extra).token;
  const sessionFor = (req) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    return sessions.byToken(header.slice(7));
  };
  return { createSession, sessionFor };
}

/** Logout, then the per-IP limiter over every other /auth route (logout is registered first, so it is never limited). */
export function registerSessionRoutes({ app, sessions, sessionFor }) {
  app.post('/auth/logout', (req, res) => {
    const session = sessionFor(req);
    if (session) sessions.revokeSid(session.sid);
    res.json({ ok: true });
  });
  app.use('/auth', makeRateLimiter({ windowMs: 60_000, max: 40, bucket: 'auth' }));
}

/**
 * The failed-login budget, per IDENTIFIER and counting only wrong guesses; the /auth limiter is per IP and counts every
 * request. Three properties each login route relies on:
 *   1. A success costs nothing: only `noteLoginFailure` charges, so ordinary sign-ins never lock anybody out.
 *   2. The lockout is tested BEFORE the credential is verified, so a correct guess after the budget is gone is refused.
 *   3. An identifier that does not exist is charged and refused identically to one that does, so the 429 is not an
 *      account-existence oracle.
 */
export function createLoginBudget({ rateLimit }) {
  if (typeof rateLimit?.peek !== 'function') throw new TypeError('createLoginBudget needs the rate limiter');
  /** One bucket per identifier: trimmed, lower-cased, never empty. */
  const loginKey = (identifier) => String(identifier ?? '').trim().toLowerCase() || 'unknown';
  /** True (and the response already sent) when this identifier is locked out. */
  const loginLockedOut = (res, identifier) => {
    if (!rateLimit.peek('login_failure', loginKey(identifier)).limited) return false;
    res.status(429).json(rateLimitedBody('login_failure'));
    return true;
  };
  const noteLoginFailure = (identifier) => { rateLimit.limited('login_failure', loginKey(identifier)); };
  return { loginKey, loginLockedOut, noteLoginFailure };
}

/** The refusal of a passwordless demo login outside development. Sends the response and returns true. */
export function devLoginRefused(res) {
  res.status(403).json({
    error: 'DEV_LOGIN_DISABLED',
    message: 'Passwordless demo logins are disabled outside development. Use a credentialed account.',
  });
  return true;
}
