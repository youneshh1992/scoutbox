import crypto from 'node:crypto';

/** The HMAC a receiver checks: over the event id, the timestamp and the exact body. */
export const signBody = (secret, eventId, ts, body) =>
  crypto.createHmac('sha256', secret).update(`${eventId}.${ts}.${body}`).digest('hex');

// SSRF guard: outgoing webhooks never reach private infrastructure. Loopback is allowed only under
// ALLOW_LOCAL_WEBHOOKS=1 (the test receiver).
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/i;
const PRIVATE_IP = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
export function webhookUrlProblem(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return 'not a valid URL';
  }
  if (!/^https?:$/.test(u.protocol)) return 'only http(s) destinations are allowed';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (isLoopback) {
    return process.env.ALLOW_LOCAL_WEBHOOKS === '1'
      ? null
      : 'loopback destinations are blocked (set ALLOW_LOCAL_WEBHOOKS=1 only for local receiver tests)';
  }
  if (PRIVATE_HOST.test(host)) return 'internal hostnames are blocked';
  if (PRIVATE_IP.test(host)) return 'private/link-local IP ranges are blocked';
  if (u.protocol === 'http:') return 'external destinations must use https';
  return null;
}
