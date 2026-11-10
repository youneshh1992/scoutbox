import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { httpContractMiddleware } from './httpContract.mjs';
import { RATE_LIMIT_POLICY } from './rateLimit.mjs';

// Headers a browser client may read cross-origin.
const EXPOSED_HEADERS = ['Retry-After', 'X-Request-Id', 'X-ScoutBox-Ordering', 'X-ScoutBox-Schema'];

/** `trustProxy` is the parsed SCOUTBOX_TRUST_PROXY (httpTrust.mjs). */
export function installHttpBaseline({ app, trustProxy, schemaVersion }) {
  if (typeof schemaVersion !== 'function' || !trustProxy) throw new TypeError('installHttpBaseline needs the parsed proxy setting and schemaVersion');
  // Unset behind a proxy, every per-IP limit keys on the proxy; set carelessly, a direct client could pick its own address.
  app.set('trust proxy', trustProxy.setting);

  // Bearer tokens, not cookies, so a wildcard is not an open door on its own. Unset, this stays permissive.
  const allowed = String(process.env.SCOUTBOX_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors(allowed.length
    ? {
        exposedHeaders: EXPOSED_HEADERS,
        // A same-origin or non-browser caller sends no Origin header at all.
        origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
      }
    : { exposedHeaders: EXPOSED_HEADERS }));

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cross-Origin-Resource-Policy', 'same-site');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
    next();
  });

  // Before the body parser, so a malformed-body 400 carries the same headers. 20 MB because uploads are data URLs.
  app.use(httpContractMiddleware({ ratePolicy: RATE_LIMIT_POLICY, schemaVersion }));
  app.use(express.json({ limit: '20mb' }));
}

/** Single-container deploys: the Docker build puts the web apps under public/. */
export function registerAppHosting({ app, publicDir }) {
  for (const [route, dir] of [['/app', 'club'], ['/console', 'admin'], ['/grassroots', 'grassroots'], ['/agent', 'agent']]) {
    const full = path.join(publicDir, dir);
    if (fs.existsSync(path.join(full, 'index.html'))) {
      app.use(route, express.static(full));
      app.get(`${route}/*`, (_req, res) => res.sendFile(path.join(full, 'index.html')));
      console.log(`serving ${dir} app at ${route}`);
    }
  }
}

/** Installed after every route. Anything unexpected is a 500 with fixed text; the detail goes to the log. */
export function installErrorContract(app) {
  app.use((err, req, res, _next) => {
    const known = (() => {
      if (err?.type === 'entity.too.large' || err?.status === 413) return [413, 'REQUEST_TOO_LARGE', 'That request body is larger than this endpoint accepts.'];
      if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return [400, 'MALFORMED_JSON', 'The request body is not valid JSON.'];
      if (err?.type === 'encoding.unsupported') return [415, 'UNSUPPORTED_ENCODING', 'That content encoding is not supported.'];
      return null;
    })();
    if (known) {
      const [status, error, message] = known;
      return res.status(status).json({ error, message, requestId: req.correlationId ?? null });
    }
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong handling that request.', requestId: req.correlationId ?? null });
  });
}
