// Frames arrive as bounded HTTP batches on the authenticated player router, not a WebSocket: every standing gate
// (auth, moderation, rate limiting, CORS, origin) already runs here. Ingest measured about 0.57 ms per frame, so a
// batch of 12 every few hundred ms fits request/response, and the engine needs 12 fps sustained, not 60. It is not a
// file upload: one representation (gray8, see policy.mjs), anything else refused by name.

import { FRAME_LIMITS, FRAME_ENCODING, CANDIDATE_PROTOCOLS, refusedClientFields } from './policy.mjs';
import { decodeFrame, FRAME_ERRORS } from './frames.mjs';
import { productionCvProvider, PROVIDER_ERRORS } from './provider.mjs';
import { combineEligibility, boxCamObservedEligible, COMBINE_DISABLED_REASON } from './eligibility.mjs';
import { nonceMatches } from '../../../../repositories/boxCam.mjs';
import { limitCheck } from '../../../platform/rateLimit.mjs';

const HTTP_FOR = {
  [PROVIDER_ERRORS.FRAME_TOO_LARGE]: 413,
  [PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT]: 415,
  [PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS]: 422,
  [PROVIDER_ERRORS.DUPLICATE_FRAME]: 409,
  [PROVIDER_ERRORS.OUT_OF_ORDER_FRAME]: 409,
  [PROVIDER_ERRORS.SESSION_EXPIRED]: 410,
  [PROVIDER_ERRORS.NONCE_INVALID]: 403,
  [PROVIDER_ERRORS.PROVIDER_UNAVAILABLE]: 503,
  [PROVIDER_ERRORS.QUEUE_OVERFLOW]: 429,
  [PROVIDER_ERRORS.RATE_LIMITED]: 429,
  [PROVIDER_ERRORS.SESSION_NOT_FOUND]: 404,
  [PROVIDER_ERRORS.INVALID_STATE]: 409,
  [PROVIDER_ERRORS.ALREADY_FINALIZED]: 409,
  [PROVIDER_ERRORS.UNSUPPORTED_PROTOCOL]: 422,
  [PROVIDER_ERRORS.CLIENT_FIELD_REFUSED]: 422,
  [PROVIDER_ERRORS.PROVIDER_BUSY]: 503,
  [PROVIDER_ERRORS.ENGINE_FAILURE]: 500,
};

const FRAME_ERROR_TO_PROVIDER = {
  [FRAME_ERRORS.ENCODING_UNSUPPORTED]: PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT,
  [FRAME_ERRORS.FRAME_TOO_LARGE]: PROVIDER_ERRORS.FRAME_TOO_LARGE,
  [FRAME_ERRORS.FRAME_MALFORMED]: PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT,
  [FRAME_ERRORS.FRAME_DIMENSIONS_INVALID]: PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS,
  [FRAME_ERRORS.FRAME_LENGTH_MISMATCH]: PROVIDER_ERRORS.INVALID_FRAME_DIMENSIONS,
  [FRAME_ERRORS.BATCH_TOO_LARGE]: PROVIDER_ERRORS.QUEUE_OVERFLOW,
};

/** The client learns the typed code only: no stack, path or engine message. */
function fail(res, code, extra = {}) {
  const status = HTTP_FOR[code] ?? 400;
  return res.status(status).json({ error: code, ...extra });
}

/** A body or frame envelope naming a server-derived field is refused with a 422. Returns true once refused. */
function refuseClientFields(res, ...objects) {
  const fields = [...new Set(objects.flatMap((o) => refusedClientFields(o)))];
  if (!fields.length) return false;
  fail(res, PROVIDER_ERRORS.CLIENT_FIELD_REFUSED, { fields });
  return true;
}

export function registerProductionCvRoutes(ctx) {
  // The nonce is checked against the session's stored hash, then the plain value sent binds the in-memory provider
  // session.
  const { playerRouter, adminRouter, vmetric, broadcast, boxCam, boxCamReads: reads } = ctx;
  const provider = ctx.productionCv ?? productionCvProvider();
  ctx.productionCv = provider;

  const limited = limitCheck(ctx.rateLimit);

  const ownSession = (playerId, id) => {
    const s = reads.sessions.byId(id);
    return s && s.playerId === playerId ? s : null;
  };

  // ====================================================================
  // Provider session lifecycle
  // ====================================================================

  /** The binding comes from the server's record; the client's nonce is compared, never adopted. */
  playerRouter.post('/box-cam/sessions/:id/cv/begin', (req, res) => {
    if (limited('box_cv_session_create', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 30 });
    }
    if (refuseClientFields(res, req.body)) return;
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    if (!nonceMatches(s, (req.body ?? {}).nonce)) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);
    if (s.status !== 'recording') {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, { status: s.status });
    }
    if (Date.now() > s.expiresAt) return fail(res, PROVIDER_ERRORS.SESSION_EXPIRED);
    // Liveness is checked at the start too, so an attempt cannot be recorded and then rejected.
    if (!s.livenessPassedAt) {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, { detail: 'liveness has not been established for this session' });
    }
    if (s.provider !== 'production_cv') {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, {
        detail: 'this Box Cam session is not bound to the production CV provider',
      });
    }

    const protocolId = String((req.body ?? {}).protocolId ?? '');
    const begun = provider.beginSession({
      boxCamSessionId: s.id,
      playerId: req.player.id,
      protocolId,
      nonce: req.body.nonce,
    });
    if (!begun.ok)
      return fail(res, begun.error, { protocolId: begun.protocolId, activeSessions: begun.activeSessions });

    boxCam.sessions.bindCvSession(s.id, { providerSessionId: begun.providerSessionId });
    vmetric('box_cam_cv_sessions_started');
    broadcast('box_cam_cv_session_started', { playerId: req.player.id, sessionId: s.id });

    res.status(201).json({
      providerSessionId: begun.providerSessionId,
      state: begun.state,
      protocolId: begun.protocolId,
      frameLimits: begun.frameLimits,
      encoding: FRAME_ENCODING,
      combineVerifiedEligible: false,
      combineDisabledReason: COMBINE_DISABLED_REASON,
    });
  });

  playerRouter.post('/box-cam/sessions/:id/cv/frames', (req, res) => {
    if (limited('box_cv_frames', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 5 });
    }
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.includes('application/json')) {
      return fail(res, PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT, {
        detail: 'frames are submitted as JSON envelopes; this endpoint is not a file upload',
      });
    }
    const body = req.body ?? {};
    if (refuseClientFields(res, body, ...(Array.isArray(body.frames) ? body.frames : []))) return;
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    if (!nonceMatches(s, body.nonce)) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);

    const providerSessionId = String(body.providerSessionId ?? '');
    const ps = provider.get(providerSessionId);
    if (!ps || ps.boxCamSessionId !== s.id) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);

    const frames = body.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      return fail(res, PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT, { detail: 'frames must be a non-empty array' });
    }
    if (frames.length > FRAME_LIMITS.maxFramesPerBatch) {
      return fail(res, PROVIDER_ERRORS.QUEUE_OVERFLOW, {
        detail: `at most ${FRAME_LIMITS.maxFramesPerBatch} frames per batch`,
        maxFramesPerBatch: FRAME_LIMITS.maxFramesPerBatch,
      });
    }

    const accepted = [];
    for (const raw of frames) {
      // The decoded buffer never leaves this loop.
      const d = decodeFrame(raw);
      if (!d.ok) {
        return fail(res, FRAME_ERROR_TO_PROVIDER[d.error] ?? PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT, {
          detail: d.detail ?? null,
        });
      }
      const r = provider.ingestFrame({
        providerSessionId,
        boxCamSessionId: s.id,
        nonce: body.nonce,
        seq: raw.seq,
        frame: d.frame,
        clientCapturedAtMs: raw.capturedAtMs ?? null,
      });
      if (!r.ok) return fail(res, r.error, { seq: raw.seq ?? null, lastSeq: r.lastSeq ?? null, state: r.state });
      accepted.push(r.seq);
    }

    const after = provider.get(providerSessionId);
    // No per-frame notification: this receipt is all the client learns.
    res.json({
      accepted: accepted.length,
      lastSeq: after?.lastSeq ?? null,
      framesAccepted: after?.framesAccepted ?? null,
      droppedByServer: after?.framesDroppedByServer ?? 0,
      queueDepth: after?.queue?.size ?? 0,
    });
  });

  /** Persisted as derived metadata only: no frame bytes, base64 or buffers. */
  playerRouter.post('/box-cam/sessions/:id/cv/finalize', (req, res) => {
    // Only bounds a retry loop.
    if (limited('box_cv_finalize', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 5 });
    }
    if (refuseClientFields(res, req.body)) return;
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    const body = req.body ?? {};
    if (!nonceMatches(s, body.nonce)) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);

    const providerSessionId = String(body.providerSessionId ?? s.cvProviderSessionId ?? '');

    const existing = reads.cvResults.byProviderSession(providerSessionId);
    if (existing) {
      return res.json({ result: existing, alreadyFinalized: true, ...observedView(s, existing) });
    }

    const fin = provider.finalize({
      providerSessionId,
      boxCamSessionId: s.id,
      nonce: body.nonce,
      protocolWindowMs: Number(body.protocolWindowMs) || null,
    });
    if (!fin.ok) return fail(res, fin.error, { state: fin.state });

    const result = boxCam.cvResults.record(fin.result);

    vmetric(result.outcome === 'accepted' ? 'box_cam_cv_accepted' : 'box_cam_cv_refused');
    if (result.outcome !== 'accepted') {
      broadcast('box_cam_cv_refused', { playerId: req.player.id, sessionId: s.id, reason: result.refusalReason });
    }

    const view = observedView(s, result);
    if (view.boxCamObserved.eligible) {
      broadcast('box_cam_observed', { playerId: req.player.id, sessionId: s.id });
    }
    res.json({ result, alreadyFinalized: false, ...view });
  });

  playerRouter.post('/box-cam/sessions/:id/cv/cancel', (req, res) => {
    if (refuseClientFields(res, req.body)) return;
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    if (!nonceMatches(s, (req.body ?? {}).nonce)) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);
    const providerSessionId = String((req.body ?? {}).providerSessionId ?? s.cvProviderSessionId ?? '');
    const r = provider.cancel({ providerSessionId, boxCamSessionId: s.id });
    if (!r.ok) return fail(res, r.error);
    // Stated in the response so a client can't read silence as success.
    res.json({ cancelled: true, result: null, state: r.state ?? 'cancelled' });
  });

  /** Box Cam observed and Combine answers side by side, so neither is mistaken for the other. */
  function observedView(s, result) {
    const observed = boxCamObservedEligible({
      providerHealth: provider.health().state,
      sessionLive: true,
      livenessPassed: !!s.livenessPassedAt,
      result,
      drillRequiresBall: true,
      supportedDrill: true,
    });
    return {
      boxCamObserved: observed,
      provenance: observed.eligible ? 'box_cam_observed' : null,
      combine: combineEligibility(result.protocolId),
      combineDisabledReason: COMBINE_DISABLED_REASON,
    };
  }

  // ====================================================================
  // Ready Check
  // ====================================================================

  /**
   * Structured checks; the client maps copy. Observation readiness and Combine availability are separate questions and
   * both always appear.
   */
  playerRouter.post('/box-cam/cv/ready-check', (req, res) => {
    if (limited('box_cv_ready_check', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 10 });
    }
    if (refuseClientFields(res, req.body)) return;
    const b = req.body ?? {};
    const checks = [];
    const add = (id, state, reasonCode = null, detail = null) => checks.push({ id, state, reasonCode, detail });

    // Client-reported facts only advise during setup; lying about them gains nothing but bad advice.
    const cam = String(b.cameraPermission ?? 'unknown');
    add(
      'camera_permission',
      cam === 'granted' ? 'pass' : 'fail',
      cam === 'granted'
        ? null
        : ({
            denied: 'CAMERA_DENIED',
            unavailable: 'CAMERA_UNAVAILABLE',
            in_use: 'CAMERA_IN_USE',
            insecure_context: 'INSECURE_CONTEXT',
          }[cam] ?? 'CAMERA_UNKNOWN'),
    );

    add(
      'secure_context',
      b.secureContext === true ? 'pass' : 'fail',
      b.secureContext === true ? null : 'INSECURE_CONTEXT',
    );

    const w = Number(b.frameWidth),
      h = Number(b.frameHeight);
    const dimsOk =
      Number.isInteger(w) &&
      Number.isInteger(h) &&
      w >= FRAME_LIMITS.minWidth &&
      h >= FRAME_LIMITS.minHeight &&
      w <= FRAME_LIMITS.maxWidth &&
      h <= FRAME_LIMITS.maxHeight;
    add('frame_dimensions', dimsOk ? 'pass' : 'fail', dimsOk ? null : 'FRAME_DIMENSIONS_UNSUPPORTED', {
      min: [FRAME_LIMITS.minWidth, FRAME_LIMITS.minHeight],
      max: [FRAME_LIMITS.maxWidth, FRAME_LIMITS.maxHeight],
    });

    const fps = Number(b.fps);
    const fpsOk = Number.isFinite(fps) && fps >= 12;
    add('capture_cadence', fpsOk ? 'pass' : 'fail', fpsOk ? null : 'FRAME_RATE_TOO_LOW', { minSustainedFps: 12 });

    const health = provider.health();
    add(
      'provider_health',
      ['ready', 'degraded'].includes(health.state) ? 'pass' : 'fail',
      ['ready', 'degraded'].includes(health.state) ? null : 'PROVIDER_UNAVAILABLE',
      { state: health.state },
    );

    // Checks the client cannot self-assess are "unknown", not assumed to pass.
    add(
      'person_region',
      b.personDetected === true ? 'pass' : b.personDetected === false ? 'fail' : 'unknown',
      b.personDetected === false ? 'PERSON_NOT_DETECTED' : null,
    );
    add(
      'ball_detection',
      b.ballDetected === true ? 'pass' : b.ballDetected === false ? 'fail' : 'unknown',
      b.ballDetected === false ? 'BALL_NOT_DETECTED' : null,
    );
    add(
      'lighting',
      b.lightingOk === true ? 'pass' : b.lightingOk === false ? 'fail' : 'unknown',
      b.lightingOk === false ? 'INSUFFICIENT_LIGHT' : null,
    );

    const protocolId = String(b.protocolId ?? '');
    const supported = !!CANDIDATE_PROTOCOLS[protocolId];
    add('protocol_observation_support', supported ? 'pass' : 'fail', supported ? null : 'UNSUPPORTED_PROTOCOL');

    const blocking = checks.filter((c) => c.state === 'fail');
    const observationReady = blocking.length === 0;
    const combine = combineEligibility(protocolId);

    res.json({
      checks,
      observationReady,
      combineVerificationAvailable: combine.eligible,
      combineDisabledReason: combine.eligible ? null : COMBINE_DISABLED_REASON,
      providerHealth: health,
    });
  });

  // ====================================================================
  // T&S diagnostics (structured, no raw frame viewer)
  // ====================================================================

  adminRouter.get('/box-cam/cv/results/:providerSessionId', (req, res) => {
    const r = reads.cvResults.byProviderSession(req.params.providerSessionId);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    // A projection: there is no raw frame viewer and no write route for the count.
    res.json({
      diagnostics: {
        protocolId: r.protocolId,
        providerId: r.providerId,
        providerVersion: r.providerVersion,
        engineVersion: r.engineVersion,
        cvPolicyVersion: r.cvPolicyVersion,
        outcome: r.outcome,
        refusalReason: r.refusalReason,
        qualityReasons: r.observationQuality?.reasons ?? [],
        integrity: r.integrity,
        serverStartedAt: r.serverStartedAt,
        serverEndedAt: r.serverEndedAt,
      },
      rawFrameViewer: null,
      note: 'Structured diagnostics only. ScoutBox never retains frames, so there is nothing to view. Observed counts cannot be edited.',
    });
  });
}
