// The HTTP envelope around every route: proxy trust, the CORS allowlist, baseline response headers, the HTTP contract
// and the body parser; the static app hosting; and the error contract, which answers last.
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { httpContractMiddleware } from './httpContract.mjs';
import { RATE_LIMIT_POLICY } from './rateLimit.mjs';

// Headers a browser client may READ cross-origin: Retry-After lets it honour a 429 instead of guessing, the request id
// lets a person quote one when something goes wrong, the ordering header states how a list was sorted.
const EXPOSED_HEADERS = ['Retry-After', 'X-Request-Id', 'X-ScoutBox-Ordering', 'X-ScoutBox-Schema'];

/** Installed before every route. `trustProxy` is the parsed SCOUTBOX_TRUST_PROXY (httpTrust.mjs). */
export function installHttpBaseline({ app, trustProxy, schemaVersion }) {
  if (typeof schemaVersion !== 'function' || !trustProxy) throw new TypeError('installHttpBaseline needs the parsed proxy setting and schemaVersion');
  // Without proxy trust a server behind a platform proxy keys every per-IP limit on the proxy's address; set carelessly
  // a direct client could pick its own. An invalid value refuses to boot in production.
  app.set('trust proxy', trustProxy.setting);

  // ScoutBox authenticates with bearer tokens, not cookies, so a wildcard would not be an open door on its own; but no
  // origin policy at all is not something a deployment should discover by reading the source. With
  // SCOUTBOX_ALLOWED_ORIGINS unset, development stays permissive and the capability report says so.
  const allowed = String(process.env.SCOUTBOX_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors(allowed.length
    ? {
        exposedHeaders: EXPOSED_HEADERS,
        // A same-origin or non-browser caller sends no Origin header at all.
        origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
      }
    : { exposedHeaders: EXPOSED_HEADERS }));

  // These replace no authorisation check; they only stop a browser doing something helpful with our responses.
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cross-Origin-Resource-Policy', 'same-site');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
    next();
  });

  // The contract wraps res.json BEFORE the body parser, so a malformed-body 400 carries the same retry and schema
  // headers as every other error. 20 MB because media still travels as data URLs on the upload path.
  app.use(httpContractMiddleware({ ratePolicy: RATE_LIMIT_POLICY, schemaVersion }));
  app.use(express.json({ limit: '20mb' }));
}

/** Single-container deploys: the Docker build drops the built web apps under public/, served beside the API. */
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

/**
 * The error contract, installed after every route. Known request faults (a 25 MB body, malformed JSON) answer with
 * their own code, so a client can tell them from a crash; anything unexpected is a 500 with fixed text, and the detail
 * goes to the log, not the caller.
 */
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
