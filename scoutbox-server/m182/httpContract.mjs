/**
 * M18.2 — the HTTP error contract, in one place.
 *
 * M18.1 gave the known request faults their own codes (413, 400, 415). What
 * was still missing: a 429 said "too many" without saying how long; nothing
 * told a client whether an error was worth retrying; and the schema version
 * was not on the wire. This middleware adds all three as HEADERS, so no
 * response body anywhere has to change shape.
 *
 *   Retry-After         on every 429, from the named policy's window
 *   X-ScoutBox-Retry    retryable | not-retryable, on every 4xx/5xx
 *   X-ScoutBox-Schema   the snapshot schema version, on every response
 *
 * "Retryable" is a statement about the CLIENT'S next move, never about the
 * server's internals: 429, 503 and 504 are worth a retry; 401, 403, 404, 409
 * and 4xx validation are not — retrying them repeats the same answer.
 */

const RETRYABLE = new Set([429, 502, 503, 504]);

export function httpContractMiddleware({ ratePolicy = {}, schemaVersion = () => 0 } = {}) {
  return (_req, res, next) => {
    res.set('X-ScoutBox-Schema', String(schemaVersion()));
    const json = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 400) {
        // A body may say `retryable` explicitly (the fault layer does); the
        // status class decides otherwise.
        const retryable = typeof body?.retryable === 'boolean' ? body.retryable : RETRYABLE.has(status);
        res.set('X-ScoutBox-Retry', retryable ? 'retryable' : 'not-retryable');
        if (status === 429 && !res.get('Retry-After')) {
          const windowMs = ratePolicy[body?.action]?.windowMs ?? 60_000;
          res.set('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
        }
      }
      return json(body);
    };
    next();
  };
}
