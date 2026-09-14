// M22 — the frame transport (§8–§23, §39, §40, §47).
//
// TRANSPORT CHOICE, AND WHY (§8)
//
// A bounded, sampled-frame HTTP endpoint on the EXISTING authenticated player
// router. Not a WebSocket.
//
// The reasoning, in the order it actually mattered:
//
//   1. Every standing gate already runs on this router — authentication,
//      moderation, rate limiting, CORS, origin. A WebSocket would need each of
//      those re-established at a new boundary, and the failure mode of getting
//      one wrong is an unauthenticated pixel endpoint. §8 says not to build
//      transport for novelty; this is the version of that advice with teeth.
//
//   2. The workload does not need a socket. m22Perf measured ingest at about
//      0.57 ms per frame and a whole attempt at 0.01-0.02x of realtime. A
//      batch of up to 12 frames every few hundred milliseconds is comfortably
//      within request/response, and backpressure is expressed as an HTTP
//      status rather than an application-level protocol nobody else speaks.
//
//   3. Sampling is honest about what the engine needs. The engine is
//      frame-rate invariant in ball diameters per second and needs 12 fps
//      sustained, not 60. A socket would invite streaming everything.
//
// The cost, stated: per-batch HTTP overhead, and no server-initiated push. The
// first is small at this cadence; the second is not needed, because the client
// has nothing to wait for mid-attempt.
//
// WHAT THIS ENDPOINT IS NOT (§10)
//
// It is not a file upload. There is no multipart handling, no image parser, no
// content sniffing and no video. It accepts exactly one documented
// representation — gray8, described in m22/policy.mjs — and refuses everything
// else by name. A JPEG posted here is `unsupported_frame_format`, not a
// decode attempt.

import {
  FRAME_LIMITS, FRAME_ENCODING, CANDIDATE_PROTOCOLS,
} from './policy.mjs';
import { decodeFrame, FRAME_ERRORS } from './frames.mjs';
import { productionCvProvider, PROVIDER_ERRORS } from './provider.mjs';
import { combineEligibility, boxCamObservedEligible, COMBINE_DISABLED_REASON } from './eligibility.mjs';

/** §39 — canonical typed errors, mapped to HTTP once, here. */
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

/**
 * §88 — error sanitization. The client learns the typed code and nothing
 * about the server's internals. No stack, no file path, no engine message.
 */
function fail(res, code, extra = {}) {
  const status = HTTP_FOR[code] ?? 400;
  return res.status(status).json({ error: code, ...extra });
}

export function registerM22Routes(ctx) {
  const {
    db, playerRouter, adminRouter, persistNow, vmetric, broadcast,
  } = ctx;
  const provider = ctx.productionCv ?? productionCvProvider();
  ctx.productionCv = provider;

  db.boxCamCvResults ??= [];

  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);

  const ownSession = (playerId, id) =>
    db.boxSessions.find((s) => s.id === id && s.playerId === playerId) ?? null;

  // ====================================================================
  // Provider session lifecycle
  // ====================================================================

  /**
   * Open a provider session bound to an existing, authenticated, live Box Cam
   * session. §12/§13: every element of the binding is established here, on the
   * server, from the server's own record — the client supplies only the nonce
   * it was given, and that is compared, never adopted.
   */
  playerRouter.post('/box-cam/sessions/:id/cv/begin', (req, res) => {
    if (limited('box_cv_session_create', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 30 });
    }
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    if ((req.body ?? {}).nonce !== s.nonce) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);
    if (s.status !== 'recording') {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, { status: s.status });
    }
    if (Date.now() > s.expiresAt) return fail(res, PROVIDER_ERRORS.SESSION_EXPIRED);
    // §42 — no accepted Box Cam observed result without liveness. Checked at
    // the start too, so an attempt cannot be recorded and then rejected.
    if (!s.livenessPassedAt) {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, { detail: 'liveness has not been established for this session' });
    }
    if (s.provider !== 'production_cv') {
      return fail(res, PROVIDER_ERRORS.INVALID_STATE, { detail: 'this Box Cam session is not bound to the production CV provider' });
    }

    const protocolId = String((req.body ?? {}).protocolId ?? '');
    const begun = provider.beginSession({
      boxCamSessionId: s.id,
      playerId: req.player.id,
      protocolId,
      nonce: s.nonce,
    });
    if (!begun.ok) return fail(res, begun.error, { protocolId: begun.protocolId, activeSessions: begun.activeSessions });

    s.cvProviderSessionId = begun.providerSessionId;
    persistNow();
    vmetric('box_cam_cv_sessions_started');
    broadcast('box_cam_cv_session_started', { playerId: req.player.id, sessionId: s.id });

    res.status(201).json({
      providerSessionId: begun.providerSessionId,
      state: begun.state,
      protocolId: begun.protocolId,
      frameLimits: begun.frameLimits,
      encoding: FRAME_ENCODING,
      // §2/§48 — said at the beginning of the attempt, not discovered at the end.
      combineVerifiedEligible: false,
      combineDisabledReason: COMBINE_DISABLED_REASON,
    });
  });

  /**
   * §9/§11 — frame ingest. One documented representation, hard bounds, typed
   * rejections, and nothing retained.
   */
  playerRouter.post('/box-cam/sessions/:id/cv/frames', (req, res) => {
    if (limited('box_cv_frames', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 5 });
    }
    // §10 — a content type that is not JSON is refused before anything is read.
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.includes('application/json')) {
      return fail(res, PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT, {
        detail: 'frames are submitted as JSON envelopes; this endpoint is not a file upload',
      });
    }
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);

    const body = req.body ?? {};
    if (body.nonce !== s.nonce) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);

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
      // Decode at the boundary. The decoded buffer never leaves this loop.
      const d = decodeFrame(raw);
      if (!d.ok) {
        return fail(res, FRAME_ERROR_TO_PROVIDER[d.error] ?? PROVIDER_ERRORS.UNSUPPORTED_FRAME_FORMAT, {
          detail: d.detail ?? null,
        });
      }
      const r = provider.ingestFrame({
        providerSessionId,
        boxCamSessionId: s.id,
        nonce: s.nonce,
        seq: raw.seq,
        frame: d.frame,
        clientCapturedAtMs: raw.capturedAtMs ?? null,
      });
      if (!r.ok) return fail(res, r.error, { seq: raw.seq ?? null, lastSeq: r.lastSeq ?? null, state: r.state });
      accepted.push(r.seq);
    }

    const after = provider.get(providerSessionId);
    // §41 — no per-frame notification, ever. This response is the only thing
    // the client learns, and it is a receipt, not an event.
    res.json({
      accepted: accepted.length,
      lastSeq: after?.lastSeq ?? null,
      framesAccepted: after?.framesAccepted ?? null,
      droppedByServer: after?.framesDroppedByServer ?? 0,
      queueDepth: after?.queue?.size ?? 0,
    });
  });

  /**
   * §7/§34 — finalize once, into the canonical result.
   *
   * The result is persisted as derived metadata only. §35/§37: no frame bytes,
   * no base64, no buffers.
   */
  playerRouter.post('/box-cam/sessions/:id/cv/finalize', (req, res) => {
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    const body = req.body ?? {};
    if (body.nonce !== s.nonce) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);

    const providerSessionId = String(body.providerSessionId ?? s.cvProviderSessionId ?? '');

    // A session already finalized in a previous call returns its stored
    // result rather than running anything again (§7).
    const existing = db.boxCamCvResults.find((r) => r.providerSessionId === providerSessionId);
    if (existing) {
      return res.json({ result: existing, alreadyFinalized: true, ...observedView(s, existing) });
    }

    const fin = provider.finalize({
      providerSessionId,
      boxCamSessionId: s.id,
      nonce: s.nonce,
      protocolWindowMs: Number(body.protocolWindowMs) || null,
    });
    if (!fin.ok) return fail(res, fin.error, { state: fin.state });

    const result = fin.result;
    db.boxCamCvResults.push(result);
    s.cvResultId = result.providerSessionId;
    persistNow();

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
    const s = ownSession(req.player.id, req.params.id);
    if (!s) return fail(res, PROVIDER_ERRORS.SESSION_NOT_FOUND);
    if ((req.body ?? {}).nonce !== s.nonce) return fail(res, PROVIDER_ERRORS.NONCE_INVALID);
    const providerSessionId = String((req.body ?? {}).providerSessionId ?? s.cvProviderSessionId ?? '');
    const r = provider.cancel({ providerSessionId, boxCamSessionId: s.id });
    if (!r.ok) return fail(res, r.error);
    persistNow();
    // A cancelled attempt mints no result. Stated in the response so a client
    // cannot interpret silence as success.
    res.json({ cancelled: true, result: null, state: r.state ?? 'cancelled' });
  });

  /**
   * §30/§31 — the Box Cam observed view, evaluated independently of Combine
   * and reported with both answers side by side so neither can be mistaken
   * for the other.
   */
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
  // §47 — Ready Check
  // ====================================================================

  /**
   * Structured checks (§49). The client maps copy; the server never sends a
   * sentence it expects to be rendered verbatim.
   *
   * §48 is the important part of the shape: a Ready Check can legitimately say
   * observation is ready AND that Combine verification is unavailable, because
   * those are different questions. Both appear, always, so the distinction is
   * visible rather than inferred.
   */
  playerRouter.post('/box-cam/cv/ready-check', (req, res) => {
    if (limited('box_cv_ready_check', req.player.id)) {
      return fail(res, PROVIDER_ERRORS.RATE_LIMITED, { retryAfterSeconds: 10 });
    }
    const b = req.body ?? {};
    const checks = [];
    const add = (id, state, reasonCode = null, detail = null) => checks.push({ id, state, reasonCode, detail });

    // Client-reported environment facts. They are used ONLY to advise the
    // player during setup; nothing here contributes to a measurement, so a
    // client that lies about them gains nothing but bad advice.
    const cam = String(b.cameraPermission ?? 'unknown');
    add('camera_permission',
      cam === 'granted' ? 'pass' : 'fail',
      cam === 'granted' ? null : ({
        denied: 'CAMERA_DENIED', unavailable: 'CAMERA_UNAVAILABLE',
        in_use: 'CAMERA_IN_USE', insecure_context: 'INSECURE_CONTEXT',
      }[cam] ?? 'CAMERA_UNKNOWN'));

    add('secure_context', b.secureContext === true ? 'pass' : 'fail', b.secureContext === true ? null : 'INSECURE_CONTEXT');

    const w = Number(b.frameWidth), h = Number(b.frameHeight);
    const dimsOk = Number.isInteger(w) && Number.isInteger(h)
      && w >= FRAME_LIMITS.minWidth && h >= FRAME_LIMITS.minHeight
      && w <= FRAME_LIMITS.maxWidth && h <= FRAME_LIMITS.maxHeight;
    add('frame_dimensions', dimsOk ? 'pass' : 'fail', dimsOk ? null : 'FRAME_DIMENSIONS_UNSUPPORTED',
      { min: [FRAME_LIMITS.minWidth, FRAME_LIMITS.minHeight], max: [FRAME_LIMITS.maxWidth, FRAME_LIMITS.maxHeight] });

    const fps = Number(b.fps);
    const fpsOk = Number.isFinite(fps) && fps >= 12;
    add('capture_cadence', fpsOk ? 'pass' : 'fail', fpsOk ? null : 'FRAME_RATE_TOO_LOW', { minSustainedFps: 12 });

    const health = provider.health();
    add('provider_health', ['ready', 'degraded'].includes(health.state) ? 'pass' : 'fail',
      ['ready', 'degraded'].includes(health.state) ? null : 'PROVIDER_UNAVAILABLE', { state: health.state });

    // Observation checks the client cannot self-assess are reported as
    // "unknown" rather than assumed to pass — the same honesty M16's Ready
    // Check already applied to lighting and framing.
    add('person_region', b.personDetected === true ? 'pass' : (b.personDetected === false ? 'fail' : 'unknown'),
      b.personDetected === false ? 'PERSON_NOT_DETECTED' : null);
    add('ball_detection', b.ballDetected === true ? 'pass' : (b.ballDetected === false ? 'fail' : 'unknown'),
      b.ballDetected === false ? 'BALL_NOT_DETECTED' : null);
    add('lighting', b.lightingOk === true ? 'pass' : (b.lightingOk === false ? 'fail' : 'unknown'),
      b.lightingOk === false ? 'INSUFFICIENT_LIGHT' : null);

    const protocolId = String(b.protocolId ?? '');
    const supported = !!CANDIDATE_PROTOCOLS[protocolId];
    add('protocol_observation_support', supported ? 'pass' : 'fail', supported ? null : 'UNSUPPORTED_PROTOCOL');

    const blocking = checks.filter((c) => c.state === 'fail');
    const observationReady = blocking.length === 0;
    const combine = combineEligibility(protocolId);

    res.json({
      checks,
      // §48 — two answers, always both present.
      observationReady,
      combineVerificationAvailable: combine.eligible,
      combineDisabledReason: combine.eligible ? null : COMBINE_DISABLED_REASON,
      providerHealth: health,
    });
  });

  // ====================================================================
  // §74 — T&S diagnostics (structured, no raw frame viewer)
  // ====================================================================

  adminRouter.get('/box-cam/cv/results/:providerSessionId', (req, res) => {
    const r = db.boxCamCvResults.find((x) => x.providerSessionId === req.params.providerSessionId);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    // Deliberately a projection rather than the whole record: there is no raw
    // frame viewer, and §75 keeps the count uneditable by construction —
    // there is no write route for it anywhere in this file.
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

  ctx.m22Provider = provider;
}
