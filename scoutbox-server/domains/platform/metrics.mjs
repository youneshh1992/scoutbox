/**
 * Request instrumentation: correlation ids, redacted request logs and the process's request counters, installed
 * before every route. The counters are per process and reset at boot; the enterprise health route reports them.
 */
import crypto from 'node:crypto';
import { sideEffect } from '../../writeRules.mjs';

export const metrics = {
  startedAt: Date.now(),
  requests: 0,
  status2xx: 0,
  status4xx: 0,
  status5xx: 0,
  slowRequests: 0, // > 500ms
  byRoute: {}, // top-level path segment → count
  failedUploads: 0,
  deliveryFailures: 0,
  jobRuns: 0,
  sseConnects: 0,
};
// The insight domain plugs exposure capture in here, so profile and passport reads become funnel events.
export const exposureHook = { fn: null };
export function requestInstrumentation() {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    req.correlationId = /^[a-zA-Z0-9_-]{6,64}$/.test(String(req.headers['x-request-id'] ?? ''))
      ? String(req.headers['x-request-id'])
      : `req_${crypto.randomBytes(8).toString('hex')}`;
    res.set('X-Request-Id', req.correlationId);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      // originalUrl, not req.path: inside a mounted router that ended the response, req.path is prefix-stripped.
      const fullPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];
      metrics.requests++;
      if (res.statusCode >= 500) metrics.status5xx++;
      else if (res.statusCode >= 400) metrics.status4xx++;
      else metrics.status2xx++;
      if (ms > 500) metrics.slowRequests++;
      const seg = `/${fullPath.split('/')[1] ?? ''}`;
      metrics.byRoute[seg] = (metrics.byRoute[seg] ?? 0) + 1;
      if (fullPath.startsWith('/player/uploads') && res.statusCode >= 400) metrics.failedUploads++;
      if (fullPath === '/events') metrics.sseConnects++;
      try {
        // Passive measurement after the response: not the request's act.
        sideEffect(() => exposureHook.fn?.(req, res));
      } catch {
        /* exposure capture must never break a request */
      }
      // Redacted: no auth headers, tokens, bodies or emails.
      if (process.env.SCOUTBOX_QUIET_LOGS !== '1') {
        console.log(
          JSON.stringify({
            t: Date.now(),
            id: req.correlationId,
            m: req.method,
            p: fullPath.slice(0, 120),
            s: res.statusCode,
            ms: Math.round(ms),
          }),
        );
      }
    });
    next();
  };
}
