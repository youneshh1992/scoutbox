// Expiry is decided in the sessions repository and applied wherever a session is resolved: the bearer lookup, the
// event-stream connect and a signed media link. The table holds only the token's hash; `createSession` is the only
// place a token exists server side.
import { makeRateLimiter } from '../../adapters.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';

export function createSessionAccess({ sessions }) {
  if (typeof sessions?.create !== 'function' || typeof sessions?.byToken !== 'function')
    throw new TypeError('createSessionAccess needs the sessions repository');
  // The session's sid is a non-secret identifier that media URLs are bound to: the URL dies with the session.
  const createSession = (kind, refId, extra = {}) => sessions.create(kind, refId, extra).token;
  const sessionFor = (req) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    return sessions.byToken(header.slice(7));
  };
  return { createSession, sessionFor };
}

/** Logout is registered before the per-IP /auth limiter, so it is never limited. */
export function registerSessionRoutes({ app, sessions, sessionFor }) {
  app.post('/auth/logout', (req, res) => {
    const session = sessionFor(req);
    if (session) sessions.revokeSid(session.sid);
    res.json({ ok: true });
  });
  app.use('/auth', makeRateLimiter({ windowMs: 60_000, max: 40, bucket: 'auth' }));
}

/**
 * The failed-login budget is per identifier and counts only wrong guesses (the /auth limiter is per IP and counts
 * every request). A success costs nothing; the lockout is tested before the credential, so a correct guess after the
 * budget is gone is refused; an unknown identifier is charged and refused like a real one, so the 429 is not an
 * account-existence oracle.
 */
export function createLoginBudget({ rateLimit }) {
  if (typeof rateLimit?.peek !== 'function') throw new TypeError('createLoginBudget needs the rate limiter');
  const loginKey = (identifier) =>
    String(identifier ?? '')
      .trim()
      .toLowerCase() || 'unknown';
  /** True (and the response already sent) when locked out. */
  const loginLockedOut = (res, identifier) => {
    if (!rateLimit.peek('login_failure', loginKey(identifier)).limited) return false;
    res.status(429).json(rateLimitedBody('login_failure'));
    return true;
  };
  const noteLoginFailure = (identifier) => {
    rateLimit.limited('login_failure', loginKey(identifier));
  };
  return { loginKey, loginLockedOut, noteLoginFailure };
}

/** Sends the response and returns true. */
export function devLoginRefused(res) {
  res.status(403).json({
    error: 'DEV_LOGIN_DISABLED',
    message: 'Passwordless demo logins are disabled outside development. Use a credentialed account.',
  });
  return true;
}
